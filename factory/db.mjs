import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export const FACTORY_SCHEMA_VERSION = 1;
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
    receipt_claim: manifest.receipt_claim,
    receipt_url: manifest.receipt_url,
    risk_tier: manifest.risk_tier,
    changed_files: manifest.changed_files,
    planned_actions: manifest.planned_actions,
  };
  return sha256(Buffer.from(`northset-factory-ready-v1\0${canonical(subject)}`, 'utf8'));
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
    branch: row.branch,
    pushed_oid: row.pushed_oid,
    pr_url: row.pr_url,
    pr_number: row.pr_number,
    pr_head_oid: row.pr_head_oid,
    receipt_url: row.receipt_url,
    proof_published: Boolean(row.proof_published),
    attestation_state: row.attestation_state,
    publication_state: row.publication_state,
    last_error: row.last_error,
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
  branch TEXT,
  pushed_oid TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  pr_head_oid TEXT,
  receipt_url TEXT,
  proof_published INTEGER NOT NULL DEFAULT 0,
  attestation_state TEXT NOT NULL DEFAULT 'NOT_STARTED',
  publication_state TEXT NOT NULL DEFAULT 'APPROVED',
  last_error TEXT,
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
  const version = Number(connection.prepare("SELECT value FROM factory_meta WHERE key='schema_version'").get().value);
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
        board_id,mission_id,position,item_digest,manifest_json
      ) VALUES(?,?,?,?,?)`);
      const bind = connection.prepare('UPDATE ready_items SET board_id=? WHERE mission_id=? AND board_id IS NULL');
      for (const [index, item] of items.entries()) {
        const result = bind.run(boardId, item.mission_id);
        if (result.changes !== 1) throw new Error(`${item.mission_id} is already on another board`);
        add.run(boardId, item.mission_id, index + 1, item.item_digest, json(item.manifest));
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
        manifest: parseJson(item.manifest_json, {}),
        decision: item.decision,
      }));
    return {...row, items};
  }

  function approveBoard(boardDigest, approvedIds, {
    rejectedIds = [], approvedBy = 'internal-user:aeziz', now = new Date(), approvalDigest = null,
  } = {}) {
    return transaction(() => {
      const board = getBoard(boardDigest);
      if (!board || board.state !== 'OPEN') throw new Error('board is missing or no longer open');
      const available = new Set(board.items.map((item) => item.mission_id));
      const approved = [...new Set(approvedIds)].sort();
      const rejected = [...new Set(rejectedIds)].sort();
      if (!approved.length) throw new Error('at least one mission must be approved');
      if (approved.some((id) => !available.has(id)) || rejected.some((id) => !available.has(id))) {
        throw new Error('approval references a mission outside the board');
      }
      if (approved.some((id) => rejected.includes(id))) throw new Error('mission cannot be both approved and rejected');
      const approvedAt = iso(now);
      const digest = approvalDigest ?? sha256(Buffer.from(canonical({
        domain: 'northset-factory-batch-approval-v1', board_digest: boardDigest,
        approved_mission_ids: approved, rejected_mission_ids: rejected,
        approved_by: approvedBy, approved_at: approvedAt,
      }), 'utf8'));
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
      return getBoardApproval(boardDigest);
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

  function savePublication(missionId, patch = {}, {now = new Date()} = {}) {
    const current = getPublication(missionId) ?? {
      mission_id: missionId, branch: null, pushed_oid: null, pr_url: null, pr_number: null,
      pr_head_oid: null, receipt_url: null, proof_published: false,
      attestation_state: 'NOT_STARTED', publication_state: 'APPROVED', last_error: null,
    };
    const next = {...current, ...patch, updated_at: iso(now)};
    connection.prepare(`INSERT INTO publications(
      mission_id,branch,pushed_oid,pr_url,pr_number,pr_head_oid,receipt_url,proof_published,
      attestation_state,publication_state,last_error,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(mission_id) DO UPDATE SET
      branch=excluded.branch,pushed_oid=excluded.pushed_oid,pr_url=excluded.pr_url,
      pr_number=excluded.pr_number,pr_head_oid=excluded.pr_head_oid,receipt_url=excluded.receipt_url,
      proof_published=excluded.proof_published,attestation_state=excluded.attestation_state,
      publication_state=excluded.publication_state,last_error=excluded.last_error,updated_at=excluded.updated_at`).run(
      missionId, next.branch, next.pushed_oid, next.pr_url, next.pr_number, next.pr_head_oid,
      next.receipt_url, next.proof_published ? 1 : 0, next.attestation_state,
      next.publication_state, next.last_error, next.updated_at,
    );
    return getPublication(missionId);
  }

  function getPublication(missionId) {
    return mapPublication(connection.prepare('SELECT * FROM publications WHERE mission_id=?').get(missionId));
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

  return {
    database,
    connection,
    close: () => connection.close(),
    enqueueTasks,
    getTask,
    listTasks,
    claimNextTask,
    getAttempt,
    finishAttempt,
    promoteVerified,
    getReadyItem,
    listReady,
    insertBoard,
    getBoard,
    approveBoard,
    getBoardApproval,
    replaceReadyManifest,
    savePublication,
    getPublication,
    updateTaskState,
    getRepositoryState,
    setRepositoryState,
    stats,
  };
}
