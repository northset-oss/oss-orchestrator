import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';

import {FACTORY_SCHEMA_VERSION, openFactoryDb} from './db.mjs';

test('public limits persist in policy state and cannot increase during the first twenty', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-public-limits-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const database = path.join(root, 'factory.sqlite');
  const db = openFactoryDb(database);
  const firstTwenty = {
    repositoryOpen: 1,
    ownerRolling7d: 2,
    perHour: 1,
    perDay: 3,
  };
  const postCohort = {
    repositoryOpen: 1,
    ownerRolling7d: 3,
    perHour: 2,
    perDay: 5,
  };
  assert.deepEqual(db.getPolicyState().public_limits, firstTwenty);
  assert.throws(() => db.setPublicLimits({
    limits: postCohort,
    changedBy: 'internal-user:aeziz',
    reason: 'premature increase',
  }), /cannot increase before twenty/);

  const resumedAt = new Date('2026-07-24T12:00:00.000Z');
  db.resumePublication({
    releasedBy: 'internal-user:aeziz',
    reason: 'test cohort started',
    now: resumedAt,
  });
  db.connection.exec('PRAGMA foreign_keys = OFF');
  const insertPublication = db.connection.prepare(`INSERT INTO publications(
    mission_id,submitted_at,publication_state,updated_at
  ) VALUES(?,?,'SUBMITTED',?)`);
  for (let index = 1; index <= 20; index += 1) {
    const submittedAt = new Date(resumedAt.getTime() + index * 1_000).toISOString();
    insertPublication.run(`M-${index}`, submittedAt, submittedAt);
  }
  db.connection.exec('PRAGMA foreign_keys = ON');
  const changedAt = new Date('2026-07-25T12:00:00.000Z');
  const changed = db.setPublicLimits({
    limits: postCohort,
    changedBy: 'internal-user:aeziz',
    reason: 'first twenty reviewed',
    now: changedAt,
  });
  assert.equal(changed.contribution_prs_since_resume, 20);
  assert.deepEqual(changed.public_limits, postCohort);
  assert.equal(changed.public_limits_changed_at, changedAt.toISOString());
  assert.equal(changed.public_limits_changed_by, 'internal-user:aeziz');
  assert.equal(changed.public_limits_change_reason, 'first twenty reviewed');
  assert.throws(() => db.setPublicLimits({
    limits: {...postCohort, repositoryOpen: 2},
    changedBy: 'internal-user:aeziz',
    reason: 'invalid repository cap',
  }), /repositoryOpen must remain 1/);
  db.close();

  const reopened = openFactoryDb(database);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.getPolicyState().public_limits, postCohort);
});

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

test('schema v7 migration atomically refreshes only active pending READY bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-db-policy-v2-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const database = path.join(root, 'factory.sqlite');
  let db = openFactoryDb(database, {missionStart: 1068});
  const {claim} = enqueueAndClaim(db);
  const ready = db.finishVerifiedReady(claim.attempt.attempt_id, {
    repository: 'owner/repo',
    issue_url: 'https://github.com/owner/repo/issues/123',
    pr_title: 'fix: bounded issue',
    pr_body: `Fix it.\n\n<!-- northset-receipt:M-1068:start -->\nold\n<!-- northset-receipt:M-1068:end -->`,
    checks: ['node --test'],
    branch: 'northset/m-1068',
    receipt_url: 'https://northset-oss.example/receipts/M-1068/',
    planned_actions: ['publish-proof', 'open-upstream-pr'],
    proof: {schema_version: 2, checks: ['node --test']},
  }, {
    patchSha256: `sha256:${'b'.repeat(64)}`,
    commitOid: 'c'.repeat(40),
    verification: {ok: true},
  });
  db.insertBoard({
    boardId: 'B-OLD',
    boardDigest: `sha256:${'d'.repeat(64)}`,
    items: [ready],
  });
  const {claim: rejectedClaim} = enqueueAndClaim(db, 'owner/rejected#124');
  const rejected = db.finishVerifiedReady(rejectedClaim.attempt.attempt_id, {
    repository: 'owner/rejected',
    issue_url: 'https://github.com/owner/rejected/issues/124',
    pr_title: 'fix: rejected issue',
    pr_body: 'Rejected terminal item.',
    checks: ['node --test'],
  }, {
    patchSha256: `sha256:${'e'.repeat(64)}`,
    commitOid: 'f'.repeat(40),
    verification: {ok: true},
  });
  db.connection.prepare("UPDATE ready_items SET approval_state='REJECTED' WHERE mission_id=?")
    .run(rejected.mission_id);
  db.connection.prepare("UPDATE tasks SET state='REJECTED_BY_OWNER' WHERE task_id=?")
    .run(rejected.task_id);
  const {claim: supersededClaim} = enqueueAndClaim(db, 'owner/superseded#125');
  const superseded = db.finishVerifiedReady(supersededClaim.attempt.attempt_id, {
    repository: 'owner/superseded',
    issue_url: 'https://github.com/owner/superseded/issues/125',
    pr_title: 'fix: superseded issue',
    pr_body: 'Superseded terminal item.',
    checks: ['node --test'],
  }, {
    patchSha256: `sha256:${'1'.repeat(64)}`,
    commitOid: '2'.repeat(40),
    verification: {ok: true},
  });
  db.supersedeReady(superseded.mission_id, {reason: 'terminal before migration'});
  db.close();

  const legacy = new DatabaseSync(database);
  legacy.exec(`
    UPDATE factory_meta SET value='7' WHERE key='schema_version';
    DROP TABLE interaction_blocks;
    CREATE TABLE verification_prospects(
      repository TEXT PRIMARY KEY COLLATE NOCASE,
      owner_login TEXT NOT NULL COLLATE NOCASE,
      reason_code TEXT NOT NULL,
      mission_id TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
    INSERT INTO verification_prospects VALUES(
      'prometheus/client_js','prometheus','ai_rejection','M-014','2026-07-21T00:00:00.000Z'
    );
  `);
  legacy.close();

  db = openFactoryDb(database);
  t.after(() => db.close());
  assert.equal(db.getPolicyState().publication_paused, true);
  const migrated = db.getReadyItem('M-1068');
  assert.equal(migrated.approval_state, 'PENDING');
  assert.equal(migrated.board_id, null);
  assert.equal(migrated.manifest.receipt_visibility, 'private_internal');
  assert.equal(migrated.manifest.receipt_url, null);
  assert.match(migrated.manifest.branch, /^fix\//);
  assert.doesNotMatch(migrated.manifest.pr_body, /northset-receipt|M-1068|without trusting us/iu);
  assert.equal(db.getBoard('B-OLD').state, 'SUPERSEDED');
  assert.equal(db.getReadyItem(rejected.mission_id).approval_state, 'REJECTED');
  assert.equal(db.getTask(rejected.task_id).state, 'REJECTED_BY_OWNER');
  assert.equal(db.getReadyItem(superseded.mission_id).approval_state, 'SUPERSEDED');
  assert.equal(db.getTask(superseded.task_id).state, 'SUPERSEDED');
  const [block] = db.findInteractionBlocks({
    repository: 'prometheus/client_js',
    action: 'authoring',
  });
  assert.equal(block.mission_id, 'M-014');
  assert.equal(block.source_url,
    'https://github.com/prometheus/client_js/pull/773#issuecomment-4953870322');
  assert.equal(block.release_policy, 'manual_only');
  db.close();
  db = openFactoryDb(database);
  assert.equal(db.getReadyItem('M-1068').approval_state, 'PENDING');
  assert.equal(db.getReadyItem(rejected.mission_id).approval_state, 'REJECTED');
  assert.equal(db.getReadyItem(superseded.mission_id).approval_state, 'SUPERSEDED');
});

test('interaction blocks persist exact scope, reason, and manual-only release', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-db-targeting-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const db = openFactoryDb(path.join(root, 'factory.sqlite'), {missionStart: 1});
  t.after(() => db.close());
  const {claim} = enqueueAndClaim(db);
  const ready = db.finishVerifiedReady(claim.attempt.attempt_id, {
    repository: 'owner/repo', pr_title: 'fix: bounded issue', pr_body: 'Fix it.',
  }, {
    patchSha256: `sha256:${'b'.repeat(64)}`,
    commitOid: 'c'.repeat(40),
    verification: {ok: true},
  });
  db.savePublication(ready.mission_id, {
    task_id: ready.task_id, publication_state: 'SUBMITTED', pr_state: 'MERGED', merged: true,
  });

  db.recordInteractionBlock({
    scope: 'repository',
    subject: 'Owner/Repo',
    blockAuthoring: true,
    blockOutreach: true,
    reason: 'Maintainer asked us to stop.',
    reasonCode: 'not_wanted',
    missionId: ready.mission_id,
    createdAt: '2026-07-21T15:00:00Z',
  });
  const [block] = db.findInteractionBlocks({repository: 'owner/repo', action: 'authoring'})
    .filter((item) => item.reason_code === 'not_wanted');
  assert.equal(block.scope, 'repository');
  assert.equal(block.subject, 'owner/repo');
  assert.equal(block.reason, 'Maintainer asked us to stop.');
  assert.equal(block.release_policy, 'manual_only');
  assert.throws(() => db.releaseInteractionBlock('repository', 'owner/repo', {
    releasedBy: 'worker', reason: 'automatic',
  }), /internal owner identity/);
});

function enqueueAndClaim(db, candidate = 'owner/repo#123') {
  const [repository, issue] = candidate.split('#');
  const [task] = db.enqueueTasks([{
    candidate,
    repository,
    issue_number: Number(issue),
    profile: 'node',
    base_oid: 'a'.repeat(40),
  }], {now: '2026-07-19T12:00:00.000Z'});
  return {task, claim: db.claimNextTask({now: '2026-07-19T12:01:00.000Z'})};
}

test('explicit task state changes clear stale worker ownership', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-db-task-state-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const db = openFactoryDb(path.join(root, 'factory.sqlite'));
  t.after(() => db.close());
  const {task, claim} = enqueueAndClaim(db);

  assert.equal(db.getTask(task.task_id).worker_id, 'factory');
  assert.throws(() => db.updateTaskState(task.task_id, 'SKIPPED', 'manual quality stop'), /WORKING task/);
  assert.equal(db.getTask(task.task_id).state, 'WORKING');
  assert.equal(db.getTask(task.task_id).worker_id, 'factory');
  db.finishAttempt(claim.attempt.attempt_id, {
    outcome: 'SKIPPED',
    failureClass: 'candidate',
    error: 'manual quality stop',
    now: '2026-07-19T12:01:30.000Z',
  });
  db.connection.prepare('UPDATE tasks SET worker_id=? WHERE task_id=?')
    .run('stale-worker', task.task_id);
  const updated = db.updateTaskState(task.task_id, 'SKIPPED', 'manual quality stop', {
    now: '2026-07-19T12:02:00.000Z',
  });
  assert.equal(updated.state, 'SKIPPED');
  assert.equal(updated.worker_id, null);
  assert.equal(updated.last_error, 'manual quality stop');
});

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

test('unboarded pending READY bytes can be replaced atomically by a new verified attempt', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-db-pending-ready-replacement-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const db = openFactoryDb(path.join(root, 'factory.sqlite'), {missionStart: 42});
  t.after(() => db.close());
  const {task, claim} = enqueueAndClaim(db);
  const first = db.finishVerifiedReady(claim.attempt.attempt_id, {
    pr_title: 'feat: first verified version',
    pr_body: 'Implement the first verified version.',
  }, {
    patchSha256: `sha256:${'b'.repeat(64)}`,
    commitOid: 'c'.repeat(40),
    verification: {ok: true, claim_type: 'feature_implementation'},
    now: '2026-07-19T12:02:00.000Z',
  });

  assert.throws(() => db.replacePendingVerifiedReady(first.mission_id, () => {
    throw new Error('replacement manifest failed');
  }, {
    patchSha256: `sha256:${'d'.repeat(64)}`,
    commitOid: 'e'.repeat(40),
    verification: {ok: true},
    now: '2026-07-19T12:03:00.000Z',
  }), /replacement manifest failed/);
  assert.deepEqual(db.getReadyItem(first.mission_id), first);
  assert.equal(db.getTask(task.task_id).attempt_count, 1);
  assert.equal(db.connection.prepare('SELECT count(*) AS count FROM attempts WHERE task_id=?')
    .get(task.task_id).count, 1);

  const verification = {
    ok: true,
    claim_type: 'feature_implementation',
    patch_sha256: `sha256:${'f'.repeat(64)}`,
    commit_oid: '1'.repeat(40),
  };
  const replacement = db.replacePendingVerifiedReady(
    first.mission_id,
    (missionId, callbackTask, attempt) => {
      assert.equal(missionId, 'M-042');
      assert.equal(callbackTask.task_id, task.task_id);
      assert.equal(callbackTask.state, 'READY');
      assert.equal(attempt.attempt_number, 2);
      assert.equal(attempt.outcome, 'VERIFIED');
      return {
        pr_title: 'feat: corrected verified version',
        pr_body: 'Implement the corrected verified version.',
        patch_sha256: verification.patch_sha256,
        commit_oid: verification.commit_oid,
      };
    },
    {
      durationMs: 654,
      patchSha256: verification.patch_sha256,
      commitOid: verification.commit_oid,
      verification,
      riskTier: 'AMBER',
      model: 'test-model',
      now: '2026-07-19T12:04:00.000Z',
    },
  );

  assert.equal(replacement.mission_id, first.mission_id);
  assert.notEqual(replacement.attempt_id, first.attempt_id);
  assert.equal(replacement.approval_state, 'PENDING');
  assert.equal(replacement.board_id, null);
  assert.equal(replacement.risk_tier, 'AMBER');
  assert.equal(replacement.manifest.pr_title, 'feat: corrected verified version');
  assert.equal(db.getAttempt(first.attempt_id).commit_oid, 'c'.repeat(40));
  assert.equal(db.getAttempt(replacement.attempt_id).attempt_number, 2);
  assert.equal(db.getTask(task.task_id).state, 'READY');
  assert.equal(db.getTask(task.task_id).attempt_count, 2);
  assert.equal(db.connection.prepare("SELECT value FROM factory_meta WHERE key='next_mission_number'").get().value, '43');
});

test('pending READY replacement rejects boarded, settled, published, and non-READY items', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-db-pending-ready-replacement-guards-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const db = openFactoryDb(path.join(root, 'factory.sqlite'), {missionStart: 42});
  t.after(() => db.close());
  const {task, claim} = enqueueAndClaim(db);
  const ready = db.finishVerifiedReady(claim.attempt.attempt_id, {
    pr_title: 'feat: verified version',
    pr_body: 'Implement the verified version.',
  }, {
    patchSha256: `sha256:${'b'.repeat(64)}`,
    commitOid: 'c'.repeat(40),
    verification: {ok: true},
  });

  const replace = () => db.replacePendingVerifiedReady(ready.mission_id, {
    pr_title: 'feat: replacement',
    pr_body: 'Implement the replacement.',
  });
  db.connection.prepare("UPDATE ready_items SET board_id='B-BOUND' WHERE mission_id=?")
    .run(ready.mission_id);
  assert.throws(replace, /unboarded pending READY item/);
  db.connection.prepare('UPDATE ready_items SET board_id=NULL WHERE mission_id=?').run(ready.mission_id);

  for (const state of ['APPROVED', 'REJECTED', 'SUPERSEDED']) {
    db.connection.prepare('UPDATE ready_items SET approval_state=? WHERE mission_id=?')
      .run(state, ready.mission_id);
    assert.throws(replace, /only a pending READY item/);
  }
  db.connection.prepare("UPDATE ready_items SET approval_state='PENDING' WHERE mission_id=?")
    .run(ready.mission_id);

  db.savePublication(ready.mission_id, {publication_state: 'APPROVED'});
  assert.throws(replace, /published mission/);
  db.connection.prepare('DELETE FROM publications WHERE mission_id=?').run(ready.mission_id);

  db.updateTaskState(task.task_id, 'FAILED');
  assert.throws(replace, /only a READY task/);

  assert.equal(db.getTask(task.task_id).attempt_count, 1);
  assert.equal(db.connection.prepare('SELECT count(*) AS count FROM attempts WHERE task_id=?')
    .get(task.task_id).count, 1);
  assert.equal(db.getReadyItem(ready.mission_id).attempt_id, ready.attempt_id);
});
