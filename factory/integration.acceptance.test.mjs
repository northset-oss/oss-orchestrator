import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {approveBoard, createBoardIfDue} from './board.mjs';
import {openFactoryDb} from './db.mjs';
import {publishBoard} from './publisher.mjs';

const OID = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const PATCH = `sha256:${'c'.repeat(64)}`;

async function fixture(t, suffix = 'one') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-real-integration-'));
  const db = openFactoryDb(path.join(root, 'factory.sqlite'));
  t.after(async () => { db.close(); await rm(root, {recursive: true, force: true}); });
  const [task] = db.enqueueTasks([{
    candidate: `owner/${suffix}#1`, repository: `owner/${suffix}`, issue_number: 1,
    profile: 'node', base_oid: 'd'.repeat(40), live_state: {repository: {defaultBranch: 'main'}},
  }]);
  const claim = db.claimNextTask({profile: 'node'});
  db.finishAttempt(claim.attempt.attempt_id, {
    outcome: 'VERIFIED', patchSha256: PATCH, commitOid: OID,
    verification: {ok: true, patch_sha256: PATCH, tested_tree_oid: TREE, commit_oid: OID},
  });
  const ready = db.promoteVerified(claim.attempt.attempt_id, (missionId) => ({
    repository: task.repository,
    fork_repository: `AysajanE/${suffix}`,
    repository_path: path.join(root, 'artifact', 'repo'),
    patch_path: path.join(root, 'artifact', 'change.patch'),
    issue_number: 1,
    issue_url: `https://github.com/${task.repository}/issues/1`,
    base_branch: 'main',
    branch: `northset/${missionId.toLowerCase()}`,
    base_oid: 'd'.repeat(40),
    patch_sha256: PATCH,
    tested_tree_oid: TREE,
    commit_oid: OID,
    checks: ['node --test'],
    verification: {
      ok: true, claim_type: 'regression_fix', patch_sha256: PATCH, tested_tree_oid: TREE,
      commit_oid: OID, base_observation: {exit_code: 1}, patched_observation: {exit_code: 0},
    },
    pr_title: 'fix: bounded correction',
    pr_body: `Fix the bounded issue.\n\nhttps://northset-oss.github.io/verification-pilot/receipts/${missionId}/`,
    receipt_claim: {type: 'regression_fix', statement: 'The focused regression failed on base and passed after the patch.'},
    receipt_url: `https://northset-oss.github.io/verification-pilot/receipts/${missionId}/`,
    changed_files: [{path: 'src/index.mjs', status: 'M', class: 'production', lines: 2}],
    changed_lines: 2,
    risk_tier: 'GREEN',
    proof: {proof_sha256: `sha256:${'e'.repeat(64)}`},
    planned_actions: ['publish-proof', 'push-approved-commit', 'open-upstream-pr', 'verify-pr-readback'],
  }));
  const board = createBoardIfDue(db, {force: true});
  approveBoard(db, {board: board.board_digest, ids: [ready.mission_id]});
  return {root, db, task, ready, board};
}

function outbound(plan, events) {
  const pr = {
    number: 1,
    url: `https://github.com/${plan.repository}/pull/1`,
    repository: plan.repository,
    base_branch: plan.base_branch,
    head_branch: plan.branch,
    head_oid: plan.commit_oid,
    title: plan.pr_title,
    body: plan.pr_body,
  };
  return {
    getBranch: async () => ({found: false, status: 200}),
    pushBranch: async (payload) => { events.push(['push', payload]); return {oid: payload.oid, status: 200}; },
    findPullRequests: async () => ({pull_requests: [], status: 200}),
    createPullRequest: async (payload) => { events.push(['pr', payload]); return pr; },
    getPullRequest: async () => pr,
  };
}

test('real database carries one approved item through exact publication and durable public counters', async (t) => {
  const {db, ready, board} = await fixture(t);
  const events = [];
  const github = outbound(ready.manifest, events);
  const result = await publishBoard(board.board_digest, {
    db,
    github,
    safety: {request: (request) => request.execute()},
    liveRecheck: async () => ({clean: true}),
    receiptPublisher: async (items) => Object.fromEntries(items.map((item) => [item.mission_id, {
      mission_id: item.mission_id, receipt_url: item.receipt_url,
    }])),
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  });
  assert.equal(result.results[0].state, 'SUBMITTED', JSON.stringify(result.results[0]));
  assert.deepEqual(events.map(([kind]) => kind), ['push', 'pr']);
  const publication = db.getPublication(ready.mission_id);
  assert.equal(publication.task_id, ready.task_id);
  assert.equal(publication.publication_state, 'SUBMITTED');
  assert.equal(publication.attestation_state, 'ATTESTATION_PENDING');
  assert.equal(publication.pr_head_oid, OID);
  const publicState = db.getPublicActionState({
    repository: ready.manifest.repository,
    now: new Date('2026-07-19T12:01:00.000Z'),
  });
  assert.equal(publicState.open_northset_prs, 1);
  assert.equal(publicState.owner_prs_today, 1);
  assert.equal(publicState.prs_last_hour, 1);
  assert.equal(publicState.prs_today, 1);
});

test('changing the outbound fork after approval invalidates only that READY item before transport', async (t) => {
  const {db, ready, board} = await fixture(t, 'two');
  db.replaceReadyManifest(ready.mission_id, {...ready.manifest, fork_repository: 'attacker/other'});
  let calls = 0;
  const result = await publishBoard(board.board_digest, {
    db,
    github: outbound(ready.manifest, []),
    safety: {request: async (request) => { calls += 1; return request.execute(); }},
    liveRecheck: async () => ({clean: true}),
    receiptPublisher: async () => ({}),
  });
  assert.equal(result.results[0].code, 'ITEM_NOT_APPROVED');
  assert.equal(calls, 0);
});

test('interrupted WORKING attempts are closed and requeued without a mission ID', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-recovery-'));
  const db = openFactoryDb(path.join(root, 'factory.sqlite'));
  t.after(async () => { db.close(); await rm(root, {recursive: true, force: true}); });
  const [task] = db.enqueueTasks([{candidate: 'owner/recovery#2', repository: 'owner/recovery', issue_number: 2}]);
  const claim = db.claimNextTask({profile: 'node'});
  const recovered = db.recoverWorkingTasks();
  assert.equal(recovered.recovered, 1);
  assert.equal(db.getTask(task.task_id).state, 'QUEUED');
  assert.equal(db.getAttempt(claim.attempt.attempt_id).outcome, 'FAILED');
  assert.equal(db.stats().ready_items, 0);
});
