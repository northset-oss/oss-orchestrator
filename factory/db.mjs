import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export const FACTORY_SCHEMA_VERSION = 5;
export const TASK_STATES = Object.freeze([
  'DISCOVERED', 'QUEUED', 'WORKING', 'VERIFIED', 'READY', 'APPROVED',
  'PR_OPENED', 'RECEIPT_ATTESTED', 'SKIPPED', 'FAILED',
  'REJECTED_BY_OWNER', 'SUPERSEDED',
]);

const TASK_STATE_SET = new Set(TASK_STATES);

export function canonical(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('cannot canonicalize a non-finite number');
  return JSON.stringify(value);
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function taskIdForCandidate(candidate) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(String(candidate ?? ''))) {
    throw new Error('candidate must be owner/repo#123');
  }
  const digest = createHash('sha256')
    .update(`northset-oss-task-v1\0${candidate.toLowerCase()}`)
    .digest('hex').slice(0, 16).toUpperCase();
  return `TASK-OSS-${digest}`;
}

export function readyItemDigest(manifest) {
  const subject = {
    mission_id: manifest.mission_id,
    task_id: manifest.task_id,
    repository: manifest.repository ?? manifest.repo,
    fork_repository: manifest.fork_repository ?? manifest.fork_repo,
    issue_number: manifest.issue_number,
    issue_url: manifest.issue_url,
    base_branch: manifest.base_branch,
    base_oid: manifest.base_oid ?? manifest.base_commit,
    patch_sha256: manifest.patch_sha256,
    tested_tree_oid: manifest.tested_tree_oid,
    commit_oid: manifest.commit_oid,
    checks: manifest.checks,
    verification: manifest.verification,
    pr_title: manifest.pr_title,
    pr_body: normalizePrBody(manifest.pr_body),
    branch: manifest.branch,
    repository_path: manifest.repository_path,
    patch_path: manifest.patch_path,
    verification_path: manifest.verification_path,
    test_command: manifest.test_command,
    install_command: manifest.install_command,
    test_only_paths: manifest.test_only_paths,
    base_failure_contains: manifest.base_failure_contains,
    proof: manifest.proof,
    receipt_claim: manifest.receipt_claim,
    receipt_url: manifest.receipt_url,
    risk_tier: manifest.risk_tier,
    changed_files: manifest.changed_files,
    planned_actions: manifest.planned_actions,
  };
  return sha256(Buffer.from(`northset-factory-ready-v1\0${canonical(subject)}`, 'utf8'));
}

export function batchApprovalDigest({
  boardDigest,
  approvedMissionIds,
  rejectedMissionIds,
  approvedBy,
  approvedAt,
}) {
  return sha256(Buffer.from(canonical({
    domain: 'northset-factory-batch-approval-v1',
    board_digest: boardDigest,
    approved_mission_ids: [...approvedMissionIds].sort(),
    rejected_mission_ids: [...rejectedMissionIds].sort(),
    approved_by: approvedBy,
    approved_at: iso(approvedAt),
  }), 'utf8'));
}

export function normalizePrBody(body) {
  return `${String(body ?? '').replace(/\s+$/u, '')}\n`;
}

function json(value, fallback = null) {
  return JSON.stringify(value ?? fallback);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  return JSON.parse(value);
}

function iso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('timestamp must be valid');
  return date.toISOString();
}

function assertState(state) {
  if (!TASK_STATE_SET.has(state)) throw new Error(`unsupported task state ${state}`);
}

function mapTask(row) {
  if (!row) return null;
  return {
    task_id: row.task_id,
    candidate: row.candidate,
    repository: row.repository,
    issue_number: row.issue_number,
    profile: row.profile,
    priority: row.priority,
    state: row.state,
    base_oid: row.base_oid,
    attempt_count: row.attempt_count,
    last_error: row.last_error,
    worker_id: row.worker_id,
    live_state: parseJson(row.live_state_json, {}),
    issue_snapshot: parseJson(row.issue_snapshot_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapAttempt(row) {
  if (!row) return null;
  return {
    attempt_id: row.attempt_id,
    task_id: row.task_id,
    attempt_number: row.attempt_number,
    started_at: row.started_at,
    finished_at: row.finished_at,
    model: row.model,
    outcome: row.outcome,
    failure_class: row.failure_class,
    duration_ms: row.duration_ms,
    patch_sha256: row.patch_sha256,
    commit_oid: row.commit_oid,
    verification: parseJson(row.verification_json, null),
  };
}

function mapReady(row) {
  if (!row) return null;
  return {
    mission_id: row.mission_id,
    task_id: row.task_id,
    attempt_id: row.attempt_id,
    manifest_sha256: row.manifest_sha256,
    item_digest: row.item_digest,
    manifest: parseJson(row.manifest_json, {}),
    risk_tier: row.risk_tier,
    ready_at: row.ready_at,
    board_id: row.board_id,
    approval_state: row.approval_state,
  };
}

function mapPublication(row) {
  if (!row) return null;
  return {
    mission_id: row.mission_id,
    task_id: row.task_id,
    branch: row.branch,
    pushed_oid: row.pushed_oid,
    pr_url: row.pr_url,
    pr_number: row.pr_number,
    pr_head_oid: row.pr_head_oid,
    pr_base_branch: row.pr_base_branch,
    pr_state: row.pr_state,
    merged: Boolean(row.merged),
    ci_state: row.ci_state,
    outcome_recorded_at: row.outcome_recorded_at,
    receipt_url: row.receipt_url,
    receipt_state: row.receipt_state,
    receipt_proof_sha256: row.receipt_proof_sha256,
    receipt_batch_commit_oid: row.receipt_batch_commit_oid,
    receipt_approval_digest: row.receipt_approval_digest,
    proof_published: Boolean(row.proof_published),
    attestation_state: row.attestation_state,
    attestation_url: row.attestation_url,
    attested_at: row.attested_at,
    attestation_error: row.attestation_error,
    submitted_at: row.submitted_at,
    status_state: row.status_state,
    status_url: row.status_url,
    status_error: row.status_error,
    publication_state: row.publication_state,
    last_error: row.last_error,
    last_error_detail: row.last_error_detail,
    updated_at: row.updated_at,
  };
}

const SCHEMA = `
PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS factory_meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks(
  task_id TEXT PRIMARY KEY,
  candidate TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  profile TEXT NOT NULL,
  priority REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  base_oid TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  worker_id TEXT,
  live_state_json TEXT NOT NULL DEFAULT '{}',
  issue_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_queue_idx ON tasks(profile,state,priority DESC,created_at);
CREATE TABLE IF NOT EXISTS attempts(
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  model TEXT,
  outcome TEXT,
  failure_class TEXT,
  duration_ms INTEGER,
  patch_sha256 TEXT,
  commit_oid TEXT,
  verification_json TEXT,
  FOREIGN KEY(task_id) REFERENCES tasks(task_id),
  UNIQUE(task_id,attempt_number)
);
CREATE INDEX IF NOT EXISTS attempts_task_idx ON attempts(task_id,attempt_number);
CREATE TABLE IF NOT EXISTS ready_items(
  mission_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  attempt_id TEXT NOT NULL UNIQUE,
  manifest_sha256 TEXT NOT NULL,
  item_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  risk_tier TEXT NOT NULL,
  ready_at TEXT NOT NULL,
  board_id TEXT,
  approval_state TEXT NOT NULL DEFAULT 'PENDING',
  FOREIGN KEY(task_id) REFERENCES tasks(task_id),
  FOREIGN KEY(attempt_id) REFERENCES attempts(attempt_id)
);
CREATE INDEX IF NOT EXISTS ready_queue_idx ON ready_items(approval_state,board_id,ready_at);
CREATE TABLE IF NOT EXISTS boards(
  board_id TEXT PRIMARY KEY,
  board_digest TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT
);
CREATE TABLE IF NOT EXISTS board_items(
  board_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  item_digest TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  decision TEXT,
  PRIMARY KEY(board_id,mission_id),
  UNIQUE(board_id,position),
  FOREIGN KEY(board_id) REFERENCES boards(board_id)
);
CREATE TABLE IF NOT EXISTS board_approvals(
  board_digest TEXT PRIMARY KEY,
  approval_digest TEXT NOT NULL,
  approved_ids_json TEXT NOT NULL,
  rejected_ids_json TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS publications(
  mission_id TEXT PRIMARY KEY,
  task_id TEXT,
  branch TEXT,
  pushed_oid TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  pr_head_oid TEXT,
  pr_base_branch TEXT,
  pr_state TEXT,
  merged INTEGER NOT NULL DEFAULT 0,
  ci_state TEXT,
  outcome_recorded_at TEXT,
  receipt_url TEXT,
  receipt_state TEXT NOT NULL DEFAULT 'NOT_STARTED',
  receipt_proof_sha256 TEXT,
  receipt_batch_commit_oid TEXT,
  receipt_approval_digest TEXT,
  proof_published INTEGER NOT NULL DEFAULT 0,
  attestation_state TEXT NOT NULL DEFAULT 'NOT_STARTED',
  attestation_url TEXT,
  attested_at TEXT,
  attestation_error TEXT,
  submitted_at TEXT,
  status_state TEXT NOT NULL DEFAULT 'NOT_STARTED',
  status_url TEXT,
  status_error TEXT,
  publication_state TEXT NOT NULL DEFAULT 'APPROVED',
  last_error TEXT,
  last_error_detail TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(mission_id) REFERENCES ready_items(mission_id)
);
CREATE TABLE IF NOT EXISTS repository_state(
  repository TEXT PRIMARY KEY,
  owner_login TEXT,
  open_northset_prs INTEGER NOT NULL DEFAULT 0,
  opened_today INTEGER NOT NULL DEFAULT 0,
  cooldown_reason TEXT,
  cooldown_until TEXT,
  last_pr_at TEXT,
  updated_at TEXT NOT NULL
);
`;

export function openFactoryDb(databasePath, {missionStart = 1000} = {}) {
  if (!Number.isInteger(missionStart) || missionStart < 1) throw new Error('missionStart must be a positive integer');
  const database = path.resolve(databasePath);
  mkdirSync(path.dirname(database), {recursive: true, mode: 0o700});
  const connection = new DatabaseSync(database);
  connection.exec(SCHEMA);
  connection.prepare("INSERT INTO factory_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO NOTHING")
    .run(String(FACTORY_SCHEMA_VERSION));
  connection.prepare("INSERT INTO factory_meta(key,value) VALUES('next_mission_number',?) ON CONFLICT(key) DO NOTHING")
    .run(String(missionStart));
  let version = Number(connection.prepare("SELECT value FROM factory_meta WHERE key='schema_version'").get().value);
  if (version === 1) {
    const columns = new Set(connection.prepare('PRAGMA table_info(publications)').all().map((row) => row.name));
    const additions = [
      ['task_id', 'TEXT'],
      ['pr_base_branch', 'TEXT'],
      ['receipt_state', "TEXT NOT NULL DEFAULT 'NOT_STARTED'"],
      ['attestation_url', 'TEXT'],
      ['attested_at', 'TEXT'],
      ['attestation_error', 'TEXT'],
      ['submitted_at', 'TEXT'],
      ['status_state', "TEXT NOT NULL DEFAULT 'NOT_STARTED'"],
      ['status_url', 'TEXT'],
      ['status_error', 'TEXT'],
      ['last_error_detail', 'TEXT'],
    ];
    connection.exec('BEGIN IMMEDIATE');
    try {
      for (const [name, definition] of additions) {
        if (!columns.has(name)) connection.exec(`ALTER TABLE publications ADD COLUMN ${name} ${definition}`);
      }
      connection.prepare("UPDATE factory_meta SET value='2' WHERE key='schema_version'").run();
      connection.exec('COMMIT');
      version = 2;
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }
  if (version === 2) {
    const columns = new Set(connection.prepare('PRAGMA table_info(board_items)').all().map((row) => row.name));
    connection.exec('BEGIN IMMEDIATE');
    try {
      if (!columns.has('manifest_sha256')) {
        connection.exec("ALTER TABLE board_items ADD COLUMN manifest_sha256 TEXT NOT NULL DEFAULT ''");
        connection.exec(`UPDATE board_items SET manifest_sha256=COALESCE(
          (SELECT r.manifest_sha256 FROM ready_items r WHERE r.mission_id=board_items.mission_id),'')`);
      }
      connection.prepare("UPDATE factory_meta SET value='3' WHERE key='schema_version'").run();
      connection.exec('COMMIT');
      version = 3;
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }
  if (version === 3) {
    const columns = new Set(connection.prepare('PRAGMA table_info(publications)').all().map((row) => row.name));
    connection.exec('BEGIN IMMEDIATE');
    try {
      for (const [name, definition] of [
        ['receipt_proof_sha256', 'TEXT'],
        ['receipt_batch_commit_oid', 'TEXT'],
        ['receipt_approval_digest', 'TEXT'],
      ]) {
        if (!columns.has(name)) connection.exec(`ALTER TABLE publications ADD COLUMN ${name} ${definition}`);
      }
      connection.prepare("UPDATE factory_meta SET value='4' WHERE key='schema_version'").run();
      connection.exec('COMMIT');
      version = 4;
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }
  if (version === 4) {
    const columns = new Set(connection.prepare('PRAGMA table_info(publications)').all().map((row) => row.name));
    connection.exec('BEGIN IMMEDIATE');
    try {
      for (const [name, definition] of [
        ['pr_state', 'TEXT'],
        ['merged', 'INTEGER NOT NULL DEFAULT 0'],
        ['ci_state', 'TEXT'],
        ['outcome_recorded_at', 'TEXT'],
      ]) {
        if (!columns.has(name)) connection.exec(`ALTER TABLE publications ADD COLUMN ${name} ${definition}`);
      }
      connection.prepare("UPDATE factory_meta SET value=? WHERE key='schema_version'")
        .run(String(FACTORY_SCHEMA_VERSION));
      connection.exec('COMMIT');
      version = FACTORY_SCHEMA_VERSION;
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }
  if (version !== FACTORY_SCHEMA_VERSION) throw new Error(`unsupported factory schema version ${version}`);

  function transaction(operation) {
    connection.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      connection.exec('COMMIT');
      return value;
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }

  function enqueueTasks(records, {now = new Date()} = {}) {
    const observedAt = iso(now);
    const insert = connection.prepare(`INSERT INTO tasks(
      task_id,candidate,repository,issue_number,profile,priority,state,base_oid,
      live_state_json,issue_snapshot_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET
      priority=excluded.priority,
      base_oid=COALESCE(excluded.base_oid,tasks.base_oid),
      live_state_json=excluded.live_state_json,
      issue_snapshot_json=excluded.issue_snapshot_json,
      updated_at=excluded.updated_at`);
    return transaction(() => records.map((record) => {
      const candidate = String(record.candidate);
      const match = /^([^/]+)\/([^#]+)#([1-9][0-9]*)$/.exec(candidate);
      if (!match) throw new Error(`invalid candidate ${candidate}`);
      const taskId = record.task_id ?? taskIdForCandidate(candidate);
      const repository = record.repository ?? `${match[1]}/${match[2]}`;
      const state = record.state ?? 'QUEUED';
      assertState(state);
      insert.run(
        taskId, candidate, repository, record.issue_number ?? Number(match[3]),
        record.profile ?? 'node', Number(record.priority ?? 0), state,
        record.base_oid ?? null, json(record.live_state, {}), json(record.issue_snapshot, {}),
        observedAt, observedAt,
      );
      return getTask(taskId);
    }));
  }

  function recordPreflightOutcomes(records, {now = new Date()} = {}) {
    const skipped = records.filter((record) => record?.outcome !== 'GO').map((record) => {
      const candidate = record.candidate;
      const live = record.liveState;
      return {
        candidate: candidate.candidate,
        repository: live?.repository?.nameWithOwner ?? candidate.repository,
        issue_number: live?.issue?.number ?? candidate.issueNumber,
        profile: 'node',
        priority: candidate.priority,
        state: 'SKIPPED',
        base_oid: live?.repository?.defaultOid ?? null,
        live_state: live ?? {},
        issue_snapshot: live?.issue ?? {},
      };
    });
    return skipped.length ? enqueueTasks(skipped, {now}) : [];
  }

  function getTask(taskId) {
    return mapTask(connection.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId));
  }

  function listTasks({state = null, profile = null, limit = 1000} = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('task limit must be positive');
    const clauses = [];
    const args = [];
    if (state) { assertState(state); clauses.push('state=?'); args.push(state); }
    if (profile) { clauses.push('profile=?'); args.push(profile); }
    args.push(limit);
    return connection.prepare(`SELECT * FROM tasks ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY priority DESC,created_at,task_id LIMIT ?`).all(...args).map(mapTask);
  }

  function claimNextTask({profile = 'node', workerId = 'factory', now = new Date(), model = null} = {}) {
    return transaction(() => {
      const row = connection.prepare(`SELECT * FROM tasks WHERE state='QUEUED' AND profile=?
        ORDER BY priority DESC,created_at,task_id LIMIT 1`).get(profile);
      if (!row) return null;
      const startedAt = iso(now);
      const attemptId = randomUUID();
      const attemptNumber = Number(row.attempt_count) + 1;
      connection.prepare(`UPDATE tasks SET state='WORKING',worker_id=?,attempt_count=?,last_error=NULL,updated_at=?
        WHERE task_id=? AND state='QUEUED'`).run(workerId, attemptNumber, startedAt, row.task_id);
      connection.prepare(`INSERT INTO attempts(attempt_id,task_id,attempt_number,started_at,model)
        VALUES(?,?,?,?,?)`).run(attemptId, row.task_id, attemptNumber, startedAt, model);
      return {task: getTask(row.task_id), attempt: getAttempt(attemptId)};
    });
  }

  function recoverWorkingTasks({now = new Date()} = {}) {
    return transaction(() => {
      const recoveredAt = iso(now);
      const attempts = connection.prepare(`SELECT a.attempt_id,a.task_id FROM attempts a
        JOIN tasks t ON t.task_id=a.task_id
        WHERE t.state='WORKING' AND a.finished_at IS NULL`).all();
      const finish = connection.prepare(`UPDATE attempts SET finished_at=?,outcome='FAILED',
        failure_class='infrastructure',duration_ms=NULL WHERE attempt_id=? AND finished_at IS NULL`);
      const requeue = connection.prepare(`UPDATE tasks SET state='QUEUED',worker_id=NULL,
        last_error='recovered after interrupted worker',updated_at=? WHERE task_id=? AND state='WORKING'`);
      for (const attempt of attempts) {
        finish.run(recoveredAt, attempt.attempt_id);
        requeue.run(recoveredAt, attempt.task_id);
      }
      return {recovered: attempts.length, task_ids: attempts.map((item) => item.task_id)};
    });
  }

  function getAttempt(attemptId) {
    return mapAttempt(connection.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(attemptId));
  }

  function finishAttempt(attemptId, {
    outcome, failureClass = null, durationMs = null, patchSha256 = null,
    commitOid = null, verification = null, error = null, now = new Date(),
  }) {
    if (!['VERIFIED', 'SKIPPED', 'FAILED'].includes(outcome)) throw new Error('attempt outcome must be VERIFIED, SKIPPED, or FAILED');
    const nextState = outcome;
    return transaction(() => {
      const attempt = connection.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(attemptId);
      if (!attempt) throw new Error(`unknown attempt ${attemptId}`);
      if (attempt.finished_at) throw new Error(`attempt ${attemptId} is already finished`);
      const finishedAt = iso(now);
      connection.prepare(`UPDATE attempts SET finished_at=?,outcome=?,failure_class=?,duration_ms=?,patch_sha256=?,
        commit_oid=?,verification_json=? WHERE attempt_id=?`).run(
        finishedAt, outcome, failureClass, durationMs, patchSha256, commitOid,
        verification === null ? null : json(verification), attemptId,
      );
      connection.prepare(`UPDATE tasks SET state=?,last_error=?,worker_id=NULL,updated_at=? WHERE task_id=?`)
        .run(nextState, error, finishedAt, attempt.task_id);
      return {task: getTask(attempt.task_id), attempt: getAttempt(attemptId)};
    });
  }

  function allocateMissionId() {
    const row = connection.prepare("SELECT value FROM factory_meta WHERE key='next_mission_number'").get();
    const number = Number(row.value);
    if (!Number.isInteger(number) || number < 1) throw new Error('next mission number is corrupt');
    connection.prepare("UPDATE factory_meta SET value=? WHERE key='next_mission_number'").run(String(number + 1));
    return `M-${String(number).padStart(3, '0')}`;
  }

  function promoteVerified(attemptId, manifestDraft, {riskTier = 'GREEN', now = new Date()} = {}) {
    if (!['GREEN', 'AMBER', 'RED'].includes(riskTier)) throw new Error('risk tier must be GREEN, AMBER, or RED');
    return transaction(() => {
      const attempt = connection.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(attemptId);
      if (!attempt || attempt.outcome !== 'VERIFIED') throw new Error('only a VERIFIED attempt can enter READY');
      const task = connection.prepare('SELECT * FROM tasks WHERE task_id=?').get(attempt.task_id);
      if (!task || task.state !== 'VERIFIED') throw new Error('verified task is not promotable');
      const existing = connection.prepare('SELECT * FROM ready_items WHERE task_id=?').get(task.task_id);
      if (existing) return mapReady(existing);
      const missionId = allocateMissionId();
      const readyAt = iso(now);
      const suppliedManifest = typeof manifestDraft === 'function'
        ? manifestDraft(missionId, mapTask(task), mapAttempt(attempt))
        : manifestDraft;
      if (!suppliedManifest || typeof suppliedManifest !== 'object') {
        throw new Error('READY promotion requires a manifest object');
      }
      const manifest = {
        schema_version: 1,
        ...suppliedManifest,
        mission_id: missionId,
        task_id: task.task_id,
        repository: suppliedManifest.repository ?? task.repository,
        issue_number: suppliedManifest.issue_number ?? task.issue_number,
        base_oid: suppliedManifest.base_oid ?? task.base_oid,
        risk_tier: riskTier,
        ready_at: readyAt,
      };
      manifest.pr_body = normalizePrBody(manifest.pr_body);
      const manifestSha = sha256(Buffer.from(canonical(manifest), 'utf8'));
      const itemDigest = readyItemDigest(manifest);
      connection.prepare(`INSERT INTO ready_items(
        mission_id,task_id,attempt_id,manifest_sha256,item_digest,manifest_json,risk_tier,ready_at
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        missionId, task.task_id, attemptId, manifestSha, itemDigest, json(manifest), riskTier, readyAt,
      );
      connection.prepare("UPDATE tasks SET state='READY',updated_at=? WHERE task_id=?").run(readyAt, task.task_id);
      return getReadyItem(missionId);
    });
  }

  function finishVerifiedReady(attemptId, manifestDraft, {
    durationMs = null, patchSha256 = null, commitOid = null, verification = null,
    riskTier = 'GREEN', now = new Date(),
  } = {}) {
    if (!['GREEN', 'AMBER', 'RED'].includes(riskTier)) throw new Error('risk tier must be GREEN, AMBER, or RED');
    return transaction(() => {
      const attempt = connection.prepare('SELECT * FROM attempts WHERE attempt_id=?').get(attemptId);
      if (!attempt) throw new Error(`unknown attempt ${attemptId}`);
      if (attempt.finished_at) throw new Error(`attempt ${attemptId} is already finished`);
      const task = connection.prepare('SELECT * FROM tasks WHERE task_id=?').get(attempt.task_id);
      if (!task || task.state !== 'WORKING') throw new Error('only a WORKING task can enter READY');

      const readyAt = iso(now);
      connection.prepare(`UPDATE attempts SET finished_at=?,outcome='VERIFIED',failure_class=NULL,
        duration_ms=?,patch_sha256=?,commit_oid=?,verification_json=? WHERE attempt_id=?`).run(
        readyAt, durationMs, patchSha256, commitOid,
        verification === null ? null : json(verification), attemptId,
      );

      const missionId = allocateMissionId();
      const suppliedManifest = typeof manifestDraft === 'function'
        ? manifestDraft(missionId, mapTask(task), getAttempt(attemptId))
        : manifestDraft;
      if (!suppliedManifest || typeof suppliedManifest !== 'object') {
        throw new Error('READY promotion requires a manifest object');
      }
      const manifest = {
        schema_version: 1,
        ...suppliedManifest,
        mission_id: missionId,
        task_id: task.task_id,
        repository: suppliedManifest.repository ?? task.repository,
        issue_number: suppliedManifest.issue_number ?? task.issue_number,
        base_oid: suppliedManifest.base_oid ?? task.base_oid,
        risk_tier: riskTier,
        ready_at: readyAt,
      };
      manifest.pr_body = normalizePrBody(manifest.pr_body);
      const manifestSha = sha256(Buffer.from(canonical(manifest), 'utf8'));
      const itemDigest = readyItemDigest(manifest);
      connection.prepare(`INSERT INTO ready_items(
        mission_id,task_id,attempt_id,manifest_sha256,item_digest,manifest_json,risk_tier,ready_at
      ) VALUES(?,?,?,?,?,?,?,?)`).run(
        missionId, task.task_id, attemptId, manifestSha, itemDigest, json(manifest), riskTier, readyAt,
      );
      connection.prepare("UPDATE tasks SET state='READY',last_error=NULL,worker_id=NULL,updated_at=? WHERE task_id=?")
        .run(readyAt, task.task_id);
      return getReadyItem(missionId);
    });
  }

  function getReadyItem(missionId) {
    return mapReady(connection.prepare('SELECT * FROM ready_items WHERE mission_id=?').get(missionId));
  }

  function listReady({unboarded = false, states = ['PENDING'], limit = 100} = {}) {
    if (!Array.isArray(states) || !states.length) throw new Error('ready states are required');
    if (!Number.isInteger(limit) || limit < 1) throw new Error('ready limit must be positive');
    const placeholders = states.map(() => '?').join(',');
    const clauses = [`approval_state IN (${placeholders})`];
    if (unboarded) clauses.push('board_id IS NULL');
    return connection.prepare(`SELECT * FROM ready_items WHERE ${clauses.join(' AND ')}
      ORDER BY ready_at,mission_id LIMIT ?`).all(...states, limit).map(mapReady);
  }

  function insertBoard({boardId, boardDigest, items, createdAt = new Date()}) {
    return transaction(() => {
      const created = iso(createdAt);
      connection.prepare('INSERT INTO boards(board_id,board_digest,state,created_at) VALUES(?,?,?,?)')
        .run(boardId, boardDigest, 'OPEN', created);
      const add = connection.prepare(`INSERT INTO board_items(
        board_id,mission_id,position,item_digest,manifest_sha256,manifest_json
      ) VALUES(?,?,?,?,?,?)`);
      const bind = connection.prepare('UPDATE ready_items SET board_id=? WHERE mission_id=? AND board_id IS NULL');
      for (const [index, item] of items.entries()) {
        const result = bind.run(boardId, item.mission_id);
        if (result.changes !== 1) throw new Error(`${item.mission_id} is already on another board`);
        add.run(boardId, item.mission_id, index + 1, item.item_digest, item.manifest_sha256, json(item.manifest));
      }
      return getBoard(boardDigest);
    });
  }

  function getBoard(identifier) {
    const row = connection.prepare('SELECT * FROM boards WHERE board_digest=? OR board_id=?').get(identifier, identifier);
    if (!row) return null;
    const items = connection.prepare('SELECT * FROM board_items WHERE board_id=? ORDER BY position').all(row.board_id)
      .map((item) => ({
        mission_id: item.mission_id,
        position: item.position,
        item_digest: item.item_digest,
        manifest_sha256: item.manifest_sha256,
        manifest: parseJson(item.manifest_json, {}),
        decision: item.decision,
      }));
    return {...row, items};
  }

  function getCurrentBoard() {
    const row = connection.prepare("SELECT board_digest FROM boards WHERE state='OPEN' ORDER BY created_at,board_id LIMIT 1")
      .get();
    return row ? getBoard(row.board_digest) : null;
  }

  function approveBoard(boardDigest, approvedIds, {
    rejectedIds = [], approvedBy = 'internal-user:aeziz', now = new Date(), approvalDigest = null,
  } = {}) {
    return transaction(() => {
      const board = getBoard(boardDigest);
      if (!board || board.state !== 'OPEN') throw new Error('board is missing or no longer open');
      const available = new Set(board.items.map((item) => item.mission_id));
      const requestedApproved = [...new Set(approvedIds)].sort();
      const requestedRejected = [...new Set(rejectedIds)].sort();
      if (!requestedApproved.length && !requestedRejected.length) {
        throw new Error('at least one mission must be approved or rejected');
      }
      if (requestedApproved.some((id) => !available.has(id)) || requestedRejected.some((id) => !available.has(id))) {
        throw new Error('approval references a mission outside the board');
      }
      if (requestedApproved.some((id) => requestedRejected.includes(id))) {
        throw new Error('mission cannot be both approved and rejected');
      }
      const boardById = new Map(board.items.map((item) => [item.mission_id, item]));
      const invalidated = [];
      const currentAndBound = (id) => {
        const current = getReadyItem(id);
        const frozen = boardById.get(id);
        const valid = current && current.board_id === board.board_id &&
          current.approval_state === 'PENDING' && current.item_digest === frozen.item_digest &&
          current.manifest_sha256 === frozen.manifest_sha256 &&
          readyItemDigest(current.manifest) === current.item_digest &&
          sha256(Buffer.from(canonical(current.manifest), 'utf8')) === current.manifest_sha256;
        if (!valid) invalidated.push(id);
        return valid;
      };
      const approved = requestedApproved.filter(currentAndBound);
      const rejected = requestedRejected.filter(currentAndBound);
      if (!approved.length && !rejected.length) {
        throw new Error(`all selected missions were invalidated: ${invalidated.join(', ')}`);
      }
      const approvedAt = iso(now);
      const computedDigest = batchApprovalDigest({
        boardDigest,
        approvedMissionIds: approved,
        rejectedMissionIds: rejected,
        approvedBy,
        approvedAt,
      });
      if (approvalDigest !== null && approvalDigest !== computedDigest) {
        throw new Error('supplied approval digest does not match the selected immutable board bytes');
      }
      const digest = computedDigest;
      connection.prepare(`INSERT INTO board_approvals(
        board_digest,approval_digest,approved_ids_json,rejected_ids_json,approved_by,approved_at
      ) VALUES(?,?,?,?,?,?)`).run(boardDigest, digest, json(approved), json(rejected), approvedBy, approvedAt);
      const decide = connection.prepare('UPDATE board_items SET decision=? WHERE board_id=? AND mission_id=?');
      for (const item of board.items) {
        if (approved.includes(item.mission_id)) {
          decide.run('APPROVED', board.board_id, item.mission_id);
          connection.prepare("UPDATE ready_items SET approval_state='APPROVED' WHERE mission_id=?").run(item.mission_id);
          connection.prepare("UPDATE tasks SET state='APPROVED',updated_at=? WHERE task_id=(SELECT task_id FROM ready_items WHERE mission_id=?)")
            .run(approvedAt, item.mission_id);
        } else if (rejected.includes(item.mission_id)) {
          decide.run('REJECTED', board.board_id, item.mission_id);
          connection.prepare("UPDATE ready_items SET approval_state='REJECTED' WHERE mission_id=?").run(item.mission_id);
          connection.prepare("UPDATE tasks SET state='REJECTED_BY_OWNER',updated_at=? WHERE task_id=(SELECT task_id FROM ready_items WHERE mission_id=?)")
            .run(approvedAt, item.mission_id);
        } else {
          connection.prepare('UPDATE ready_items SET board_id=NULL WHERE mission_id=?').run(item.mission_id);
        }
      }
      connection.prepare("UPDATE boards SET state='APPROVED',approved_at=? WHERE board_id=?").run(approvedAt, board.board_id);
      return {...getBoardApproval(boardDigest), invalidated_mission_ids: [...new Set(invalidated)].sort()};
    });
  }

  function getBoardApproval(boardDigest) {
    const row = connection.prepare('SELECT * FROM board_approvals WHERE board_digest=?').get(boardDigest);
    if (!row) return null;
    return {
      board_digest: row.board_digest,
      approval_digest: row.approval_digest,
      approved_mission_ids: parseJson(row.approved_ids_json, []),
      rejected_mission_ids: parseJson(row.rejected_ids_json, []),
      approved_by: row.approved_by,
      approved_at: row.approved_at,
    };
  }

  function replaceReadyManifest(missionId, manifestDraft, {now = new Date()} = {}) {
    return transaction(() => {
      const current = getReadyItem(missionId);
      if (!current) throw new Error(`unknown mission ${missionId}`);
      const manifest = {
        ...manifestDraft,
        mission_id: missionId,
        task_id: current.task_id,
        risk_tier: manifestDraft.risk_tier ?? current.risk_tier,
        ready_at: iso(now),
      };
      manifest.pr_body = normalizePrBody(manifest.pr_body);
      const manifestSha = sha256(Buffer.from(canonical(manifest), 'utf8'));
      const itemDigest = readyItemDigest(manifest);
      connection.prepare(`UPDATE ready_items SET manifest_sha256=?,item_digest=?,manifest_json=?,risk_tier=?,
        ready_at=?,board_id=NULL,approval_state='PENDING' WHERE mission_id=?`).run(
        manifestSha, itemDigest, json(manifest), manifest.risk_tier, manifest.ready_at, missionId,
      );
      connection.prepare("UPDATE tasks SET state='READY',updated_at=? WHERE task_id=?").run(manifest.ready_at, current.task_id);
      return getReadyItem(missionId);
    });
  }

  function replaceVerifiedReady(missionId, manifestDraft, {
    durationMs = null, patchSha256 = null, commitOid = null, verification = null,
    riskTier = 'GREEN', model = null, now = new Date(),
  } = {}) {
    if (!['GREEN', 'AMBER', 'RED'].includes(riskTier)) throw new Error('risk tier must be GREEN, AMBER, or RED');
    return transaction(() => {
      const current = getReadyItem(missionId);
      if (!current) throw new Error(`unknown mission ${missionId}`);
      if (current.approval_state !== 'REJECTED') {
        throw new Error('only a rejected READY item can be replaced');
      }
      if (getPublication(missionId)) throw new Error('a published mission cannot be replaced');
      const board = current.board_id ? getBoard(current.board_id) : null;
      if (board?.state === 'OPEN') throw new Error('the previous READY board must be closed before replacement');
      const task = connection.prepare('SELECT * FROM tasks WHERE task_id=?').get(current.task_id);
      if (!task || task.state !== 'REJECTED_BY_OWNER') {
        throw new Error('only an owner-rejected task can receive replacement verified bytes');
      }

      const readyAt = iso(now);
      const attemptId = randomUUID();
      const attemptNumber = Number(task.attempt_count) + 1;
      connection.prepare(`INSERT INTO attempts(
        attempt_id,task_id,attempt_number,started_at,finished_at,model,outcome,failure_class,
        duration_ms,patch_sha256,commit_oid,verification_json
      ) VALUES(?,?,?,?,?,?,'VERIFIED',NULL,?,?,?,?)`).run(
        attemptId, task.task_id, attemptNumber, readyAt, readyAt, model,
        durationMs, patchSha256, commitOid, verification === null ? null : json(verification),
      );
      const suppliedManifest = typeof manifestDraft === 'function'
        ? manifestDraft(missionId, mapTask(task), getAttempt(attemptId))
        : manifestDraft;
      if (!suppliedManifest || typeof suppliedManifest !== 'object') {
        throw new Error('READY replacement requires a manifest object');
      }
      const manifest = {
        schema_version: 1,
        ...suppliedManifest,
        mission_id: missionId,
        task_id: task.task_id,
        repository: suppliedManifest.repository ?? task.repository,
        issue_number: suppliedManifest.issue_number ?? task.issue_number,
        base_oid: suppliedManifest.base_oid ?? task.base_oid,
        risk_tier: riskTier,
        ready_at: readyAt,
      };
      manifest.pr_body = normalizePrBody(manifest.pr_body);
      const manifestSha = sha256(Buffer.from(canonical(manifest), 'utf8'));
      const itemDigest = readyItemDigest(manifest);
      const replaced = connection.prepare(`UPDATE ready_items SET
        attempt_id=?,manifest_sha256=?,item_digest=?,manifest_json=?,risk_tier=?,ready_at=?,
        board_id=NULL,approval_state='PENDING'
        WHERE mission_id=? AND task_id=? AND approval_state='REJECTED'`).run(
        attemptId, manifestSha, itemDigest, json(manifest), riskTier, readyAt,
        missionId, task.task_id,
      );
      if (replaced.changes !== 1) throw new Error('READY replacement lost its rejected mission binding');
      const updated = connection.prepare(`UPDATE tasks SET state='READY',attempt_count=?,last_error=NULL,
        worker_id=NULL,updated_at=? WHERE task_id=? AND state='REJECTED_BY_OWNER'`).run(
        attemptNumber, readyAt, task.task_id,
      );
      if (updated.changes !== 1) throw new Error('READY replacement lost its rejected task binding');
      return getReadyItem(missionId);
    });
  }

  function savePublication(missionId, patch = {}, {now = new Date()} = {}) {
    const current = getPublication(missionId) ?? {
      mission_id: missionId, task_id: null, branch: null, pushed_oid: null, pr_url: null, pr_number: null,
      pr_head_oid: null, pr_base_branch: null, pr_state: null, merged: false, ci_state: null,
      outcome_recorded_at: null, receipt_url: null, receipt_state: 'NOT_STARTED',
      receipt_proof_sha256: null, receipt_batch_commit_oid: null, receipt_approval_digest: null,
      proof_published: false, attestation_state: 'NOT_STARTED', attestation_url: null,
      attested_at: null, attestation_error: null, submitted_at: null, status_state: 'NOT_STARTED',
      status_url: null, status_error: null, publication_state: 'APPROVED', last_error: null,
      last_error_detail: null,
    };
    const next = {...current, ...patch, updated_at: iso(now)};
    connection.prepare(`INSERT INTO publications(
      mission_id,task_id,branch,pushed_oid,pr_url,pr_number,pr_head_oid,pr_base_branch,
      pr_state,merged,ci_state,outcome_recorded_at,
      receipt_url,receipt_state,receipt_proof_sha256,receipt_batch_commit_oid,receipt_approval_digest,
      proof_published,attestation_state,attestation_url,attested_at,
      attestation_error,submitted_at,status_state,status_url,status_error,publication_state,
      last_error,last_error_detail,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(mission_id) DO UPDATE SET
      task_id=excluded.task_id,branch=excluded.branch,pushed_oid=excluded.pushed_oid,pr_url=excluded.pr_url,
      pr_number=excluded.pr_number,pr_head_oid=excluded.pr_head_oid,receipt_url=excluded.receipt_url,
      pr_base_branch=excluded.pr_base_branch,pr_state=excluded.pr_state,merged=excluded.merged,
      ci_state=excluded.ci_state,outcome_recorded_at=excluded.outcome_recorded_at,
      receipt_state=excluded.receipt_state,
      receipt_proof_sha256=excluded.receipt_proof_sha256,
      receipt_batch_commit_oid=excluded.receipt_batch_commit_oid,
      receipt_approval_digest=excluded.receipt_approval_digest,
      proof_published=excluded.proof_published,attestation_state=excluded.attestation_state,
      attestation_url=excluded.attestation_url,attested_at=excluded.attested_at,
      attestation_error=excluded.attestation_error,submitted_at=excluded.submitted_at,
      status_state=excluded.status_state,status_url=excluded.status_url,status_error=excluded.status_error,
      publication_state=excluded.publication_state,last_error=excluded.last_error,
      last_error_detail=excluded.last_error_detail,updated_at=excluded.updated_at`).run(
      missionId, next.task_id, next.branch, next.pushed_oid, next.pr_url, next.pr_number, next.pr_head_oid,
      next.pr_base_branch, next.pr_state, next.merged ? 1 : 0, next.ci_state, next.outcome_recorded_at,
      next.receipt_url, next.receipt_state,
      next.receipt_proof_sha256, next.receipt_batch_commit_oid, next.receipt_approval_digest,
      next.proof_published ? 1 : 0,
      next.attestation_state, next.attestation_url, next.attested_at, next.attestation_error,
      next.submitted_at, next.status_state, next.status_url, next.status_error,
      next.publication_state, next.last_error, next.last_error_detail, next.updated_at,
    );
    return getPublication(missionId);
  }

  function getPublication(missionId) {
    return mapPublication(connection.prepare('SELECT * FROM publications WHERE mission_id=?').get(missionId));
  }

  function listPublications({states = ['SUBMITTED'], limit = 30} = {}) {
    if (!Array.isArray(states) || !states.length) throw new Error('publication states are required');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('publication limit must be an integer from 1 through 1000');
    }
    const placeholders = states.map(() => '?').join(',');
    return connection.prepare(`SELECT * FROM publications WHERE publication_state IN (${placeholders})
      ORDER BY updated_at,mission_id LIMIT ?`).all(...states, limit).map(mapPublication);
  }

  function listReconciliationCandidates({limit = 30} = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('reconciliation limit must be an integer from 1 through 1000');
    }
    return connection.prepare(`SELECT * FROM publications
      WHERE publication_state='SUBMITTED' AND (
        attestation_state!='RECEIPT_ATTESTED' OR
        outcome_recorded_at IS NULL OR
        status_state!='PUBLISHED'
      )
      ORDER BY updated_at,mission_id LIMIT ?`).all(limit).map(mapPublication);
  }

  function recordPublicationObservation(missionId, {
    repository,
    prState,
    merged = false,
    ciState = null,
    prHeadOid = null,
    observedAt = new Date(),
  } = {}) {
    if (typeof repository !== 'string' || !repository.includes('/')) {
      throw new Error('publication observation requires repository owner/name');
    }
    const normalizedState = String(prState ?? '').toUpperCase();
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(normalizedState)) {
      throw new Error('publication observation requires PR state OPEN, CLOSED, or MERGED');
    }
    const observed = iso(observedAt);
    return transaction(() => {
      const current = getPublication(missionId);
      if (!current) throw new Error(`unknown publication ${missionId}`);
      const closed = merged === true || normalizedState === 'CLOSED' || normalizedState === 'MERGED';
      const previouslyClosed = current.outcome_recorded_at !== null || current.merged === true ||
        ['CLOSED', 'MERGED'].includes(String(current.pr_state ?? '').toUpperCase());
      const repositoryReleased = closed && !previouslyClosed;
      connection.prepare(`UPDATE publications SET pr_state=?,merged=?,ci_state=?,pr_head_oid=coalesce(?,pr_head_oid),
        outcome_recorded_at=?,updated_at=? WHERE mission_id=?`).run(
        merged === true || normalizedState === 'MERGED' ? 'MERGED' : normalizedState,
        merged === true || normalizedState === 'MERGED' ? 1 : 0,
        ciState,
        prHeadOid,
        closed ? (current.outcome_recorded_at ?? observed) : current.outcome_recorded_at,
        observed,
        missionId,
      );
      if (repositoryReleased) {
        connection.prepare(`UPDATE repository_state
          SET open_northset_prs=max(open_northset_prs-1,0),updated_at=?
          WHERE lower(repository)=lower(?)`).run(observed, repository);
      }
      return {publication: getPublication(missionId), repository_released: repositoryReleased};
    });
  }

  function updateTaskState(taskId, state, detail = null, {now = new Date()} = {}) {
    assertState(state);
    connection.prepare('UPDATE tasks SET state=?,last_error=?,updated_at=? WHERE task_id=?')
      .run(state, detail, iso(now), taskId);
    return getTask(taskId);
  }

  function getRepositoryState(repository) {
    const row = connection.prepare('SELECT * FROM repository_state WHERE lower(repository)=lower(?)').get(repository);
    if (!row) return null;
    return {...row};
  }

  function getPublicActionState({repository, owner = repository?.split('/')[0], now = new Date()} = {}) {
    if (typeof repository !== 'string' || !repository.includes('/')) {
      throw new Error('public action state requires repository owner/name');
    }
    const observed = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(observed.getTime())) throw new Error('public action state timestamp is invalid');
    const today = observed.toISOString().slice(0, 10);
    const hourStart = new Date(observed.getTime() - 60 * 60_000).toISOString();
    const repositoryState = getRepositoryState(repository) ?? {};
    const counts = connection.prepare(`SELECT
      sum(CASE WHEN lower(substr(t.repository,1,instr(t.repository,'/')-1))=lower(?) AND
        substr(p.submitted_at,1,10)=? THEN 1 ELSE 0 END) AS owner_today,
      sum(CASE WHEN p.submitted_at>=? THEN 1 ELSE 0 END) AS last_hour,
      sum(CASE WHEN substr(p.submitted_at,1,10)=? THEN 1 ELSE 0 END) AS today
      FROM publications p
      JOIN ready_items r ON r.mission_id=p.mission_id
      JOIN tasks t ON t.task_id=r.task_id
      WHERE p.submitted_at IS NOT NULL`).get(
      owner, today, hourStart, today,
    );
    return {
      ...repositoryState,
      repository,
      owner_login: owner,
      owner_prs_today: Number(counts.owner_today ?? 0),
      prs_last_hour: Number(counts.last_hour ?? 0),
      prs_today: Number(counts.today ?? 0),
    };
  }

  function setRepositoryState(repository, patch = {}, {now = new Date()} = {}) {
    const current = getRepositoryState(repository) ?? {
      repository, owner_login: repository.split('/')[0], open_northset_prs: 0, opened_today: 0,
      cooldown_reason: null, cooldown_until: null, last_pr_at: null,
    };
    const next = {...current, ...patch, repository, updated_at: iso(now)};
    connection.prepare(`INSERT INTO repository_state(
      repository,owner_login,open_northset_prs,opened_today,cooldown_reason,cooldown_until,last_pr_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(repository) DO UPDATE SET owner_login=excluded.owner_login,
      open_northset_prs=excluded.open_northset_prs,opened_today=excluded.opened_today,
      cooldown_reason=excluded.cooldown_reason,cooldown_until=excluded.cooldown_until,
      last_pr_at=excluded.last_pr_at,updated_at=excluded.updated_at`).run(
      repository, next.owner_login, next.open_northset_prs, next.opened_today,
      next.cooldown_reason, next.cooldown_until, next.last_pr_at, next.updated_at,
    );
    return getRepositoryState(repository);
  }

  function stats() {
    const row = connection.prepare(`SELECT
      (SELECT count(*) FROM tasks) AS tasks,
      (SELECT count(*) FROM attempts) AS attempts,
      (SELECT count(*) FROM ready_items) AS ready_items,
      (SELECT count(*) FROM boards) AS boards,
      (SELECT count(*) FROM publications WHERE publication_state IN ('SUBMITTED','PR_OPENED')) AS submitted`).get();
    return row;
  }

  function candidateAttemptStats() {
    const rows = connection.prepare(`SELECT t.candidate,count(a.attempt_id) AS attempts,
      sum(CASE WHEN a.outcome='VERIFIED' THEN 1 ELSE 0 END) AS ready,
      avg(CASE WHEN a.duration_ms IS NOT NULL THEN a.duration_ms END) AS average_duration_ms
      FROM tasks t LEFT JOIN attempts a ON a.task_id=t.task_id GROUP BY t.task_id,t.candidate`).all();
    return new Map(rows.map((row) => [row.candidate.toLowerCase(), {
      attempts: Number(row.attempts ?? 0),
      ready: Number(row.ready ?? 0),
      average_duration_ms: row.average_duration_ms === null ? null : Number(row.average_duration_ms),
    }]));
  }

  return {
    database,
    connection,
    close: () => connection.close(),
    enqueueTasks,
    recordPreflightOutcomes,
    getTask,
    listTasks,
    claimNextTask,
    recoverWorkingTasks,
    getAttempt,
    finishAttempt,
    promoteVerified,
    finishVerifiedReady,
    getReadyItem,
    listReady,
    insertBoard,
    getBoard,
    getCurrentBoard,
    approveBoard,
    getBoardApproval,
    replaceReadyManifest,
    replaceVerifiedReady,
    savePublication,
    getPublication,
    listPublications,
    listReconciliationCandidates,
    recordPublicationObservation,
    updateTaskState,
    getRepositoryState,
    getPublicActionState,
    setRepositoryState,
    candidateAttemptStats,
    stats,
  };
}
