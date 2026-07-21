import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';

import {FACTORY_SCHEMA_VERSION, openFactoryDb} from './db.mjs';

test('schema v1 publication checkpoints migrate additively and retain async recovery fields', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-db-migration-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const database = path.join(root, 'factory.sqlite');
  const legacy = new DatabaseSync(database);
  legacy.exec(`
    CREATE TABLE factory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO factory_meta(key,value) VALUES('schema_version','1'),('next_mission_number','1000');
    CREATE TABLE publications(
      mission_id TEXT PRIMARY KEY,branch TEXT,pushed_oid TEXT,pr_url TEXT,pr_number INTEGER,
      pr_head_oid TEXT,receipt_url TEXT,proof_published INTEGER NOT NULL DEFAULT 0,
      attestation_state TEXT NOT NULL DEFAULT 'NOT_STARTED',
      publication_state TEXT NOT NULL DEFAULT 'APPROVED',last_error TEXT,updated_at TEXT NOT NULL
    );
    INSERT INTO publications(mission_id,branch,proof_published,attestation_state,publication_state,updated_at)
      VALUES('M-1000','northset/m-1000',1,'ATTESTATION_PENDING','SUBMITTED','2026-07-19T12:00:00.000Z');
  `);
  legacy.close();

  const db = openFactoryDb(database);
  t.after(() => db.close());
  assert.equal(Number(db.connection.prepare("SELECT value FROM factory_meta WHERE key='schema_version'").get().value),
    FACTORY_SCHEMA_VERSION);
  const saved = db.savePublication('M-1000', {
    task_id: 'TASK-OSS-RECOVERY',
    pr_base_branch: 'main',
    receipt_state: 'PUBLISHED',
    attestation_url: 'https://example.test/attestations/1000',
    attested_at: '2026-07-19T12:05:00.000Z',
    attestation_error: null,
    submitted_at: '2026-07-19T12:01:00.000Z',
    status_state: 'PENDING',
    status_url: null,
    status_error: 'temporary status failure',
    pr_state: 'OPEN',
    merged: false,
    ci_state: 'PENDING',
    last_error_detail: 'retry asynchronously',
  });
  assert.equal(saved.branch, 'northset/m-1000');
  assert.equal(saved.proof_published, true);
  assert.equal(saved.task_id, 'TASK-OSS-RECOVERY');
  assert.equal(saved.pr_base_branch, 'main');
  assert.equal(saved.receipt_state, 'PUBLISHED');
  assert.equal(saved.attestation_url, 'https://example.test/attestations/1000');
  assert.equal(saved.attested_at, '2026-07-19T12:05:00.000Z');
  assert.equal(saved.submitted_at, '2026-07-19T12:01:00.000Z');
  assert.equal(saved.status_state, 'PENDING');
  assert.equal(saved.status_error, 'temporary status failure');
  assert.equal(saved.pr_state, 'OPEN');
  assert.equal(saved.merged, false);
  assert.equal(saved.ci_state, 'PENDING');
  assert.equal(saved.outcome_recorded_at, null);
  assert.equal(saved.last_error_detail, 'retry asynchronously');
});

test('schema v5 adds per-attempt reasons without rewriting existing attempts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-db-attempt-reason-migration-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const database = path.join(root, 'factory.sqlite');
  const legacy = new DatabaseSync(database);
  legacy.exec(`
    CREATE TABLE factory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO factory_meta(key,value) VALUES('schema_version','5'),('next_mission_number','1000');
    CREATE TABLE attempts(
      attempt_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,attempt_number INTEGER NOT NULL,
      started_at TEXT NOT NULL,finished_at TEXT,model TEXT,outcome TEXT,failure_class TEXT,
      duration_ms INTEGER,patch_sha256 TEXT,commit_oid TEXT,verification_json TEXT
    );
    INSERT INTO attempts(attempt_id,task_id,attempt_number,started_at,outcome,failure_class)
      VALUES('ATTEMPT-1','TASK-1',1,'2026-07-19T12:00:00.000Z','FAILED','infrastructure');
  `);
  legacy.close();

  const db = openFactoryDb(database);
  t.after(() => db.close());
  assert.equal(Number(db.connection.prepare("SELECT value FROM factory_meta WHERE key='schema_version'").get().value),
    FACTORY_SCHEMA_VERSION);
  assert.equal(db.connection.prepare("SELECT reason FROM attempts WHERE attempt_id='ATTEMPT-1'").get().reason, null);
});

function enqueueAndClaim(db) {
  const [task] = db.enqueueTasks([{
    candidate: 'owner/repo#123',
    repository: 'owner/repo',
    issue_number: 123,
    profile: 'node',
    base_oid: 'a'.repeat(40),
  }], {now: '2026-07-19T12:00:00.000Z'});
  return {task, claim: db.claimNextTask({now: '2026-07-19T12:01:00.000Z'})};
}

test('preflight skips retain their exact decision in the existing task snapshot', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-db-preflight-decision-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const db = openFactoryDb(path.join(root, 'factory.sqlite'));
  t.after(() => db.close());
  const observedAt = '2026-07-21T19:00:00.000Z';
  const [task] = db.recordPreflightOutcomes([{
    outcome: 'SKIP',
    reasons: ['repository policy prohibits AI-generated contributions (README.md)'],
    candidate: {
      candidate: 'owner/repo#123', repository: 'owner/repo', issueNumber: 123, priority: 0.9,
    },
    liveState: {
      repository: {nameWithOwner: 'owner/repo', defaultOid: 'a'.repeat(40)},
      issue: {number: 123, state: 'OPEN'},
    },
  }], {now: observedAt});

  assert.deepEqual(task.live_state.preflight_decision, {
    version: 1,
    outcome: 'SKIP',
    reasons: ['repository policy prohibits AI-generated contributions (README.md)'],
    observed_at: observedAt,
  });
  assert.deepEqual(task.issue_snapshot, {number: 123, state: 'OPEN'});
});

test('one exhausted infrastructure attempt can re-enter only after a fresh enqueue', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-db-infrastructure-retry-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const db = openFactoryDb(path.join(root, 'factory.sqlite'));
  t.after(() => db.close());
  const record = {
    candidate: 'owner/repo#123', repository: 'owner/repo', issue_number: 123,
    profile: 'node', base_oid: 'a'.repeat(40), state: 'QUEUED',
  };
  const [task] = db.enqueueTasks([record], {now: '2026-07-19T12:00:00.000Z'});
  const first = db.claimNextTask({now: '2026-07-19T12:01:00.000Z'});
  db.finishAttempt(first.attempt.attempt_id, {
    outcome: 'FAILED', failureClass: 'infrastructure', error: 'clone timed out',
    now: '2026-07-19T12:02:00.000Z',
  });
  assert.equal(db.getAttempt(first.attempt.attempt_id).reason, 'clone timed out');

  const [requeued] = db.enqueueTasks([{...record, base_oid: 'b'.repeat(40)}], {
    now: '2026-07-19T12:03:00.000Z',
  });
  assert.equal(requeued.state, 'QUEUED');
  assert.equal(requeued.base_oid, 'b'.repeat(40));
  assert.equal(requeued.attempt_count, 1);
  assert.equal(requeued.last_error, null);

  const second = db.claimNextTask({now: '2026-07-19T12:04:00.000Z'});
  db.finishAttempt(second.attempt.attempt_id, {
    outcome: 'FAILED', failureClass: 'worker', error: 'deterministic worker failure',
    now: '2026-07-19T12:05:00.000Z',
  });
  assert.equal(db.getAttempt(second.attempt.attempt_id).reason, 'deterministic worker failure');
  const [terminal] = db.enqueueTasks([record], {now: '2026-07-19T12:06:00.000Z'});
  assert.equal(terminal.task_id, task.task_id);
  assert.equal(terminal.state, 'FAILED');
  assert.equal(terminal.attempt_count, 2);
  assert.equal(terminal.last_error, 'deterministic worker failure');
});

test('successful verification closes its attempt and creates READY atomically', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-db-ready-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const db = openFactoryDb(path.join(root, 'factory.sqlite'), {missionStart: 42});
  t.after(() => db.close());
  const {task, claim} = enqueueAndClaim(db);
  const verification = {ok: true, patch_sha256: `sha256:${'b'.repeat(64)}`, commit_oid: 'c'.repeat(40)};

  const ready = db.finishVerifiedReady(claim.attempt.attempt_id, (missionId, callbackTask, callbackAttempt) => {
    assert.equal(missionId, 'M-042');
    assert.equal(callbackTask.task_id, task.task_id);
    assert.equal(callbackAttempt.outcome, 'VERIFIED');
    assert.deepEqual(callbackAttempt.verification, verification);
    return {pr_title: 'fix: bounded issue', pr_body: 'Fix the bounded issue.'};
  }, {
    durationMs: 321,
    patchSha256: verification.patch_sha256,
    commitOid: verification.commit_oid,
    verification,
    riskTier: 'GREEN',
    now: '2026-07-19T12:02:00.000Z',
  });

  assert.equal(ready.mission_id, 'M-042');
  assert.equal(ready.task_id, task.task_id);
  assert.equal(ready.attempt_id, claim.attempt.attempt_id);
  assert.equal(db.getTask(task.task_id).state, 'READY');
  assert.equal(db.getTask(task.task_id).worker_id, null);
  assert.deepEqual(db.getAttempt(claim.attempt.attempt_id), {
    ...claim.attempt,
    finished_at: '2026-07-19T12:02:00.000Z',
    outcome: 'VERIFIED',
    failure_class: null,
    duration_ms: 321,
    patch_sha256: verification.patch_sha256,
    commit_oid: verification.commit_oid,
    verification,
  });
  assert.equal(db.connection.prepare("SELECT value FROM factory_meta WHERE key='next_mission_number'").get().value, '43');
});

test('unapproved duplicate work and a stale open board can be superseded without owner decisions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-db-supersede-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const db = openFactoryDb(path.join(root, 'factory.sqlite'), {missionStart: 1});
  t.after(() => db.close());
  db.enqueueTasks([
    {
      candidate: 'owner/first#1',
      repository: 'owner/first',
      issue_number: 1,
      profile: 'node',
      base_oid: 'a'.repeat(40),
    },
    {
      candidate: 'owner/second#2',
      repository: 'owner/second',
      issue_number: 2,
      profile: 'node',
      base_oid: 'b'.repeat(40),
    },
  ]);
  const ready = [];
  for (let index = 0; index < 2; index += 1) {
    const claim = db.claimNextTask();
    ready.push(db.finishVerifiedReady(claim.attempt.attempt_id, {
      pr_title: `fix: bounded issue ${index + 1}`,
      pr_body: `Fix bounded issue ${index + 1}.`,
    }, {
      patchSha256: `sha256:${String(index + 1).repeat(64)}`,
      commitOid: String(index + 2).repeat(40),
      verification: {ok: true},
    }));
  }
  const boardDigest = `sha256:${'e'.repeat(64)}`;
  db.insertBoard({boardId: 'B-STALE', boardDigest, items: ready});
  db.replaceReadyManifest(ready[1].mission_id, {
    ...db.getReadyItem(ready[1].mission_id).manifest,
    base_oid: 'd'.repeat(40),
  });

  const closed = db.supersedeBoard(boardDigest, {reason: 'base moved before review'});
  assert.equal(closed.state, 'SUPERSEDED');
  assert.equal(db.getCurrentBoard(), null);
  assert.equal(db.getReadyItem(ready[0].mission_id).board_id, null);
  assert.equal(db.getTask(ready[0].task_id).state, 'READY');
  assert.equal(db.getTask(ready[0].task_id).last_error, 'base moved before review');
  assert.equal(db.getReadyItem(ready[1].mission_id).board_id, null);
  assert.equal(db.getTask(ready[1].task_id).last_error, null);

  db.replaceReadyManifest(ready[0].mission_id, {
    ...db.getReadyItem(ready[0].mission_id).manifest,
    base_oid: 'c'.repeat(40),
  });
  assert.equal(db.getTask(ready[0].task_id).state, 'READY');
  assert.equal(db.getTask(ready[0].task_id).last_error, null);
  assert.equal(db.getTask(ready[0].task_id).base_oid, 'c'.repeat(40));

  const superseded = db.supersedeReady(ready[1].mission_id, {
    reason: 'linked merged PR already implements the issue',
  });
  assert.equal(superseded.approval_state, 'SUPERSEDED');
  assert.equal(db.getTask(ready[1].task_id).state, 'SUPERSEDED');
  assert.equal(db.getTask(ready[1].task_id).last_error, 'linked merged PR already implements the issue');
  assert.deepEqual(db.listReady({unboarded: true}).map((item) => item.mission_id), [ready[0].mission_id]);
});

test('a settled publication with a stale error remains eligible for one cleanup observation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-db-stale-publication-error-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const db = openFactoryDb(path.join(root, 'factory.sqlite'), {missionStart: 42});
  t.after(() => db.close());
  const {claim} = enqueueAndClaim(db);
  const ready = db.finishVerifiedReady(claim.attempt.attempt_id, {
    pr_title: 'fix: bounded issue',
    pr_body: 'Fix the bounded issue.',
  }, {
    patchSha256: `sha256:${'b'.repeat(64)}`,
    commitOid: 'c'.repeat(40),
    verification: {ok: true},
    now: '2026-07-19T12:02:00.000Z',
  });
  db.savePublication(ready.mission_id, {
    publication_state: 'SUBMITTED',
    attestation_state: 'RECEIPT_ATTESTED',
    outcome_recorded_at: '2026-07-19T13:00:00.000Z',
    status_state: 'PUBLISHED',
    last_error: 'GH_COMMAND_FAILED',
    last_error_detail: 'temporary status timeout',
  });

  assert.deepEqual(db.listReconciliationCandidates({limit: 10}).map((item) => item.mission_id),
    [ready.mission_id]);
  db.savePublication(ready.mission_id, {last_error: null, last_error_detail: null});
  assert.deepEqual(db.listReconciliationCandidates({limit: 10}), []);
});

test('manifest callback failure rolls back attempt, task, READY item, and mission allocation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-db-ready-rollback-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const db = openFactoryDb(path.join(root, 'factory.sqlite'), {missionStart: 42});
  t.after(() => db.close());
  const {task, claim} = enqueueAndClaim(db);

  assert.throws(() => db.finishVerifiedReady(claim.attempt.attempt_id, (missionId, _task, attempt) => {
    assert.equal(missionId, 'M-042');
    assert.equal(attempt.outcome, 'VERIFIED');
    throw new Error('manifest persistence failed');
  }, {
    durationMs: 321,
    patchSha256: `sha256:${'b'.repeat(64)}`,
    commitOid: 'c'.repeat(40),
    verification: {ok: true},
    now: '2026-07-19T12:02:00.000Z',
  }), /manifest persistence failed/);

  assert.deepEqual(db.getAttempt(claim.attempt.attempt_id), claim.attempt);
  assert.equal(db.getTask(task.task_id).state, 'WORKING');
  assert.equal(db.getTask(task.task_id).worker_id, 'factory');
  assert.equal(db.stats().ready_items, 0);
  assert.equal(db.connection.prepare("SELECT value FROM factory_meta WHERE key='next_mission_number'").get().value, '42');
});

test('rejected unpublished READY bytes can be replaced by a new verified attempt without a new mission', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-db-ready-replacement-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const db = openFactoryDb(path.join(root, 'factory.sqlite'), {missionStart: 42});
  t.after(() => db.close());
  const {task, claim} = enqueueAndClaim(db);
  const first = db.finishVerifiedReady(claim.attempt.attempt_id, {
    pr_title: 'feat: broad first version',
    pr_body: 'Implement the first version.',
  }, {
    patchSha256: `sha256:${'b'.repeat(64)}`,
    commitOid: 'c'.repeat(40),
    verification: {ok: true, claim_type: 'feature_implementation'},
    now: '2026-07-19T12:02:00.000Z',
  });
  const board = db.insertBoard({
    boardId: 'B-REPLACEMENT',
    boardDigest: `sha256:${'d'.repeat(64)}`,
    items: [first],
    createdAt: '2026-07-19T12:03:00.000Z',
  });

  assert.throws(() => db.replaceVerifiedReady(first.mission_id, {}),
    /only a rejected READY item can be replaced/);
  db.approveBoard(board.board_digest, [], {
    rejectedIds: [first.mission_id],
    now: '2026-07-19T12:04:00.000Z',
  });
  const secondVerification = {
    ok: true,
    claim_type: 'feature_implementation',
    patch_sha256: `sha256:${'e'.repeat(64)}`,
    commit_oid: 'f'.repeat(40),
  };
  const replacement = db.replaceVerifiedReady(first.mission_id, (missionId, callbackTask, attempt) => {
    assert.equal(missionId, 'M-042');
    assert.equal(callbackTask.task_id, task.task_id);
    assert.equal(attempt.attempt_number, 2);
    assert.equal(attempt.outcome, 'VERIFIED');
    return {
      pr_title: 'feat: scoped corrected version',
      pr_body: 'Implement the scoped corrected version.',
      patch_sha256: secondVerification.patch_sha256,
      commit_oid: secondVerification.commit_oid,
    };
  }, {
    durationMs: 654,
    patchSha256: secondVerification.patch_sha256,
    commitOid: secondVerification.commit_oid,
    verification: secondVerification,
    riskTier: 'GREEN',
    model: 'test-model',
    now: '2026-07-19T12:05:00.000Z',
  });

  assert.equal(replacement.mission_id, 'M-042');
  assert.notEqual(replacement.attempt_id, first.attempt_id);
  assert.equal(replacement.approval_state, 'PENDING');
  assert.equal(replacement.board_id, null);
  assert.equal(replacement.manifest.pr_title, 'feat: scoped corrected version');
  assert.equal(db.getAttempt(first.attempt_id).commit_oid, 'c'.repeat(40));
  assert.deepEqual(db.getAttempt(replacement.attempt_id), {
    attempt_id: replacement.attempt_id,
    task_id: task.task_id,
    attempt_number: 2,
    started_at: '2026-07-19T12:05:00.000Z',
    finished_at: '2026-07-19T12:05:00.000Z',
    model: 'test-model',
    outcome: 'VERIFIED',
    failure_class: null,
    reason: null,
    duration_ms: 654,
    patch_sha256: secondVerification.patch_sha256,
    commit_oid: secondVerification.commit_oid,
    verification: secondVerification,
  });
  assert.equal(db.getTask(task.task_id).state, 'READY');
  assert.equal(db.getTask(task.task_id).attempt_count, 2);
  assert.equal(db.connection.prepare("SELECT value FROM factory_meta WHERE key='next_mission_number'").get().value, '43');
});
