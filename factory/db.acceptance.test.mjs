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
    duration_ms: 654,
    patch_sha256: secondVerification.patch_sha256,
    commit_oid: secondVerification.commit_oid,
    verification: secondVerification,
  });
  assert.equal(db.getTask(task.task_id).state, 'READY');
  assert.equal(db.getTask(task.task_id).attempt_count, 2);
  assert.equal(db.connection.prepare("SELECT value FROM factory_meta WHERE key='next_mission_number'").get().value, '43');
});
