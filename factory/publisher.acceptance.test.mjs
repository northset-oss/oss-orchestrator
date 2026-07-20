import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';

import {boardDigest} from './board.mjs';
import {batchApprovalDigest, canonical, readyItemDigest, sha256} from './db.mjs';
import {
  PublisherCheckpointError,
  publishBoard,
  reconcileReceipt,
} from './publisher.mjs';
import {GitHubPublicLimitError} from './github-safety.mjs';

const RECEIPT_PROOF_DIGEST = `sha256:${'c'.repeat(64)}`;
const RECEIPT_BATCH_OID = 'd'.repeat(40);

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function oid(index) {
  return index.toString(16).padStart(40, '0');
}

function mission(index) {
  const id = `M-${String(index).padStart(3, '0')}`;
  const manifest = {
    mission_id: id,
    task_id: `TASK-${String(index).padStart(3, '0')}`,
    repository: `upstream${index}/project`,
    fork_repository: `northset/project-${index}`,
    repository_path: `/private/factory/M-${String(index).padStart(3, '0')}/repo`,
    base_branch: 'main',
    branch: `northset/${id.toLowerCase()}`,
    commit_oid: oid(index),
    tested_tree_oid: oid(index + 100),
    patch_sha256: digest(`patch:${id}`),
    pr_title: `fix: bounded correction ${index}`,
    pr_body: `## Summary\r\n\r\nBounded correction ${index}.\r\n`,
    receipt_claim: `The declared check for ${id} passed in the clean verifier.`,
    receipt_url: `https://example.test/receipts/${id}/proof.json`,
  };
  return {
    ...manifest,
    manifest,
    item_digest: readyItemDigest(manifest),
    manifest_sha256: sha256(Buffer.from(canonical(manifest), 'utf8')),
    approval_state: 'APPROVED',
  };
}

class FakeDb {
  constructor(count) {
    this.ready = new Map();
    this.publications = new Map();
    this.taskStates = new Map();
    this.repositoryStates = new Map();
    this.failCheckpoint = null;
    const items = [];
    for (let index = 1; index <= count; index += 1) {
      const item = mission(index);
      this.ready.set(item.mission_id, structuredClone(item));
      items.push(structuredClone(item));
      this.repositoryStates.set(item.manifest.repository, {open_northset_prs: 0});
    }
    const boardDigestValue = boardDigest(items);
    const approvedAt = '2026-07-19T11:59:00.000Z';
    const approvedIds = items.map((item) => item.mission_id);
    this.board = {board_digest: boardDigestValue, items};
    this.approval = {
      board_digest: boardDigestValue,
      approval_digest: batchApprovalDigest({
        boardDigest: boardDigestValue,
        approvedMissionIds: approvedIds,
        rejectedMissionIds: [],
        approvedBy: 'internal-user:aeziz',
        approvedAt,
      }),
      approved_ids: approvedIds,
      rejected_ids: [],
      approved_by: 'internal-user:aeziz',
      approved_at: approvedAt,
    };
  }

  async getBoard(digestValue) {
    return digestValue === this.board.board_digest ? structuredClone(this.board) : null;
  }

  async getBoardApproval(digestValue) {
    return digestValue === this.board.board_digest ? structuredClone(this.approval) : null;
  }

  async getReadyItem(id) {
    return structuredClone(this.ready.get(id) ?? null);
  }

  async getPublication(id) {
    return structuredClone(this.publications.get(id) ?? null);
  }

  async savePublication(id, patch) {
    if (this.failCheckpoint && !this.failCheckpoint.used &&
        patch.publication_state === this.failCheckpoint.state && id === this.failCheckpoint.id) {
      this.failCheckpoint.used = true;
      throw new Error(`simulated crash at ${this.failCheckpoint.state}`);
    }
    const next = {...(this.publications.get(id) ?? {}), ...structuredClone(patch)};
    this.publications.set(id, next);
    return structuredClone(next);
  }

  async updateTaskState(taskId, state, detail = null) {
    this.taskStates.set(taskId, {state, detail});
  }

  async getRepositoryState(repository) {
    return structuredClone(this.repositoryStates.get(repository) ?? {open_northset_prs: 0});
  }

  async replaceReadyManifest(id, manifest) {
    const current = this.ready.get(id);
    const nextManifest = {...structuredClone(manifest), mission_id: id};
    const next = {...current, ...nextManifest, manifest: nextManifest,
      approval_state: 'PENDING', item_digest: readyItemDigest(nextManifest),
      manifest_sha256: sha256(Buffer.from(canonical(nextManifest), 'utf8'))};
    this.ready.set(id, next);
    return structuredClone(next);
  }
}

class FakeGitHub {
  constructor() {
    this.forks = new Map();
    this.branches = new Map();
    this.pullRequests = new Map();
    this.events = [];
    this.nextPr = 1;
    this.closeCount = 0;
    this.deleteCount = 0;
  }

  branchKey(repository, branch) {
    return `${repository}:${branch}`;
  }

  async getFork({repository, upstream_repository: upstreamRepository}) {
    this.events.push({operation: 'get_fork', repository, upstream_repository: upstreamRepository});
    const parent = this.forks.get(repository);
    return parent ? {status: 200, found: true, repository, upstream_repository: parent}
      : {status: 404, found: false};
  }

  async createFork({repository, upstream_repository: upstreamRepository}) {
    this.events.push({operation: 'create_fork', repository, upstream_repository: upstreamRepository});
    assert.equal(this.forks.has(repository), false, `duplicate fork creation for ${repository}`);
    this.forks.set(repository, upstreamRepository);
    return {status: 202, found: true, repository, upstream_repository: upstreamRepository};
  }

  async getBranch({repository, branch}) {
    this.events.push({operation: 'get_branch', repository, branch});
    const commit = this.branches.get(this.branchKey(repository, branch));
    return commit ? {status: 200, found: true, oid: commit} : {status: 200, found: false};
  }

  async pushBranch({repository, branch, oid: commit, force}) {
    assert.equal(force, false);
    this.events.push({operation: 'push_branch', repository, branch, oid: commit});
    const key = this.branchKey(repository, branch);
    assert.equal(this.branches.has(key), false, `duplicate push for ${key}`);
    this.branches.set(key, commit);
    return {status: 200, oid: commit};
  }

  async findPullRequests({repository, branch, base_branch: baseBranch}) {
    this.events.push({operation: 'find_pull_requests', repository, branch});
    return {status: 200, pull_requests: [...this.pullRequests.values()].filter((pr) =>
      pr.repository === repository && pr.head_branch === branch && pr.base_branch === baseBranch)};
  }

  async createPullRequest(payload) {
    this.events.push({operation: 'create_pull_request', repository: payload.repository, branch: payload.branch});
    const number = this.nextPr++;
    const pr = {
      status: 201,
      number,
      url: `https://github.com/${payload.repository}/pull/${number}`,
      repository: payload.repository,
      base_branch: payload.base_branch,
      head_branch: payload.branch,
      head_oid: payload.head_oid,
      title: payload.title,
      body: payload.body,
      state: 'OPEN',
    };
    this.pullRequests.set(`${payload.repository}#${number}`, pr);
    return structuredClone(pr);
  }

  async getPullRequest({repository, number}) {
    this.events.push({operation: 'get_pull_request', repository, number});
    return structuredClone(this.pullRequests.get(`${repository}#${number}`));
  }

  insertPullRequest(plan, overrides = {}) {
    const number = this.nextPr++;
    const pr = {
      status: 200,
      number,
      url: `https://github.com/${plan.repository}/pull/${number}`,
      repository: plan.repository,
      base_branch: plan.base_branch,
      head_branch: plan.branch,
      head_oid: plan.commit_oid,
      title: plan.pr_title,
      body: plan.pr_body.replaceAll('\r\n', '\n'),
      state: 'OPEN',
      ...overrides,
    };
    this.pullRequests.set(`${plan.repository}#${number}`, pr);
    return pr;
  }

  count(operation) {
    return this.events.filter((event) => event.operation === operation).length;
  }
}

function safetyFor(github) {
  return {
    request: async (request) => {
      assert.equal(typeof request.execute, 'function');
      return request.execute();
    },
    github,
  };
}

function receipts(items) {
  return Object.fromEntries(items.map((item) => [item.mission_id, {
    mission_id: item.mission_id,
    receipt_url: item.receipt_url,
    proof_sha256: RECEIPT_PROOF_DIGEST,
    batch_commit_oid: RECEIPT_BATCH_OID,
    batch_approval_digest: item.approval_digest,
  }]));
}

function options(db, github, overrides = {}) {
  return {
    db,
    github,
    safety: safetyFor(github),
    liveRecheck: async () => ({clean: true}),
    receiptPublisher: async (items) => receipts(items),
    artifactVerifier: () => ({ok: true}),
    now: () => new Date('2026-07-19T12:00:00.000Z'),
    ...overrides,
  };
}

function addEvidenceAsset(db, id = 'M-001', overrides = {}) {
  const current = db.ready.get(id);
  const evidenceCommit = oid(500);
  const evidencePath = '.github/test-evidence/focused.png';
  const evidenceUrl = `https://raw.githubusercontent.com/${current.fork_repository}/${evidenceCommit}/${evidencePath}`;
  const manifest = {
    ...structuredClone(current.manifest),
    pr_body: `${current.manifest.pr_body.trimEnd()}\n\n![Focused check](${evidenceUrl})\n`,
    evidence_asset: {
      repository: current.fork_repository,
      branch: `northset/evidence-${id.toLowerCase()}`,
      commit_oid: evidenceCommit,
      path: evidencePath,
      sha256: `sha256:${'e'.repeat(64)}`,
      url: evidenceUrl,
      ...overrides,
    },
  };
  const ready = {
    ...manifest,
    manifest,
    item_digest: readyItemDigest(manifest),
    manifest_sha256: sha256(Buffer.from(canonical(manifest), 'utf8')),
    approval_state: 'APPROVED',
  };
  db.ready.set(id, structuredClone(ready));
  db.board.items = db.board.items.map((item) => item.mission_id === id ? structuredClone(ready) : item);
  db.board.board_digest = boardDigest(db.board.items);
  db.approval.board_digest = db.board.board_digest;
  db.approval.approval_digest = batchApprovalDigest({
    boardDigest: db.board.board_digest,
    approvedMissionIds: db.approval.approved_ids,
    rejectedMissionIds: db.approval.rejected_ids,
    approvedBy: db.approval.approved_by,
    approvedAt: db.approval.approved_at,
  });
  return manifest.evidence_asset;
}

test('publisher resumes after seven of twenty branch pushes without duplicates', async () => {
  const db = new FakeDb(20);
  const github = new FakeGitHub();
  db.failCheckpoint = {state: 'BRANCH_PUSHED', id: 'M-007', used: false};

  await assert.rejects(() => publishBoard(db.board.board_digest, options(db, github)),
    (error) => error instanceof PublisherCheckpointError);
  assert.equal(github.count('push_branch'), 7);

  const resumed = await publishBoard(db.board.board_digest, options(db, github));
  assert.equal(resumed.results.filter((item) => item.state === 'SUBMITTED').length, 20);
  assert.equal(github.count('push_branch'), 20);
  assert.equal(new Set(github.events.filter((event) => event.operation === 'push_branch')
    .map((event) => `${event.repository}:${event.branch}`)).size, 20);
  assert.equal(github.count('create_pull_request'), 20);
  assert.equal(github.count('create_fork'), 20);
});

test('publisher creates a missing fork once, validates it through safety, and adopts it on retry', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  db.failCheckpoint = {state: 'BRANCH_PUSHED', id: 'M-001', used: false};
  const requests = [];
  const publicationOptions = options(db, github, {
    safety: {request: async (request) => { requests.push({kind: request.kind, operation: request.operation});
      return request.execute(); }},
  });
  await assert.rejects(() => publishBoard(db.board.board_digest, publicationOptions),
    (error) => error instanceof PublisherCheckpointError);
  const resumed = await publishBoard(db.board.board_digest, publicationOptions);
  assert.equal(resumed.results[0].state, 'SUBMITTED');
  assert.equal(github.count('create_fork'), 1);
  assert.equal(requests.filter((item) => item.operation === 'create_fork').length, 1);
  assert.equal(requests.find((item) => item.operation === 'create_fork').kind, 'mutation');
});

test('publisher pushes an approved evidence commit before the PR branch and adopts both on retry', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  const evidence = addEvidenceAsset(db);

  const first = await publishBoard(db.board.board_digest, options(db, github));
  assert.equal(first.results[0].state, 'SUBMITTED');
  assert.deepEqual(github.events.filter((event) => event.operation === 'push_branch')
    .map((event) => [event.branch, event.oid]), [
    [evidence.branch, evidence.commit_oid],
    ['northset/m-001', oid(1)],
  ]);
  assert.equal(github.count('create_pull_request'), 1);

  const resumed = await publishBoard(db.board.board_digest, options(db, github));
  assert.equal(resumed.results[0].state, 'SUBMITTED');
  assert.equal(github.count('push_branch'), 2);
  assert.equal(github.count('create_pull_request'), 1);
});

test('publisher refuses a mismatched remote evidence branch before pushing the PR branch', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  const evidence = addEvidenceAsset(db);
  const item = db.ready.get('M-001');
  github.forks.set(item.fork_repository, item.repository);
  github.branches.set(github.branchKey(evidence.repository, evidence.branch), oid(999));

  const result = await publishBoard(db.board.board_digest, options(db, github));
  assert.equal(result.results[0].code, 'REMOTE_EVIDENCE_BRANCH_MISMATCH');
  assert.equal(github.count('push_branch'), 0);
  assert.equal(github.count('create_pull_request'), 0);
});

test('publisher rejects an evidence branch that collides with the approved PR branch before transport', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  addEvidenceAsset(db, 'M-001', {branch: 'northset/m-001'});

  const result = await publishBoard(db.board.board_digest, options(db, github));
  assert.equal(result.results[0].code, 'APPROVED_ITEM_INVALID');
  assert.match(result.results[0].detail, /evidence and PR branches must be distinct/);
  assert.equal(github.events.length, 0);
});

test('publisher adopts seven exact existing PRs after a crash without duplicates', async () => {
  const db = new FakeDb(20);
  const github = new FakeGitHub();
  db.failCheckpoint = {state: 'PR_CHECKPOINTED', id: 'M-007', used: false};

  await assert.rejects(() => publishBoard(db.board.board_digest, options(db, github)),
    (error) => error instanceof PublisherCheckpointError);
  assert.equal(github.count('create_pull_request'), 7);
  for (let index = 1; index <= 7; index += 1) {
    db.repositoryStates.set(db.ready.get(`M-${String(index).padStart(3, '0')}`).repository,
      {open_northset_prs: 1});
  }

  const resumed = await publishBoard(db.board.board_digest, options(db, github));
  assert.equal(resumed.results.filter((item) => item.state === 'SUBMITTED').length, 20);
  assert.equal(github.count('create_pull_request'), 20);
  assert.equal(github.pullRequests.size, 20);
  assert.equal(github.closeCount, 0);
  assert.equal(github.deleteCount, 0);
});

test('one stale item is removed without stopping clean batch items', async () => {
  const db = new FakeDb(20);
  const github = new FakeGitHub();
  const result = await publishBoard(db.board.board_digest, options(db, github, {
    liveRecheck: async (item) => item.mission_id === 'M-008'
      ? {clean: false, reason: 'issue was claimed'} : {clean: true},
  }));

  assert.equal(result.results.find((item) => item.mission_id === 'M-008').state, 'SUPERSEDED');
  assert.equal(result.results.filter((item) => item.state === 'SUBMITTED').length, 19);
  assert.equal(github.count('push_branch'), 19);
  assert.equal(github.count('create_pull_request'), 19);
  assert.equal(db.taskStates.get('TASK-008').state, 'SUPERSEDED');
});

test('a cleanly refreshed moved-base item keeps its mission ID and returns alone for reapproval', async () => {
  const db = new FakeDb(3);
  const github = new FakeGitHub();
  const refreshedBase = 'e'.repeat(40);
  const result = await publishBoard(db.board.board_digest, options(db, github, {
    liveRecheck: async (item) => item.mission_id === 'M-002'
      ? {clean: false, refreshable: true, current_base_oid: refreshedBase, reason: 'base moved'}
      : {clean: true},
    refreshStale: async (plan) => ({manifest: {...plan.manifest, base_oid: refreshedBase,
      commit_oid: 'f'.repeat(40)}}),
  }));
  const refreshed = result.results.find((item) => item.mission_id === 'M-002');
  assert.equal(refreshed.state, 'READY');
  assert.equal(refreshed.code, 'REAPPROVAL_REQUIRED');
  assert.equal(db.ready.get('M-002').approval_state, 'PENDING');
  assert.equal(db.ready.get('M-002').base_oid, refreshedBase);
  assert.equal(result.results.filter((item) => item.state === 'SUBMITTED').length, 2);
  assert.equal(github.count('create_pull_request'), 2);
});

test('stored PR body or head mismatch fails only that item', async () => {
  const db = new FakeDb(5);
  const github = new FakeGitHub();
  const mismatched = db.ready.get('M-003');
  github.insertPullRequest(mismatched, {body: 'different approved bytes\n'});

  const result = await publishBoard(db.board.board_digest, options(db, github));
  const failed = result.results.find((item) => item.mission_id === 'M-003');
  assert.equal(failed.code, 'STORED_PR_MISMATCH');
  assert.equal(result.results.filter((item) => item.state === 'SUBMITTED').length, 4);
  assert.equal(github.count('create_pull_request'), 4);
  assert.equal(github.pullRequests.size, 5);
  assert.equal(github.closeCount, 0);
  assert.equal(github.deleteCount, 0);
});

test('publisher recomputes immutable board bytes before any outbound action', async () => {
  const db = new FakeDb(2);
  const github = new FakeGitHub();
  db.board.items[0].manifest.pr_title = 'UNAPPROVED TITLE';
  await assert.rejects(
    () => publishBoard(db.board.board_digest, options(db, github)),
    /immutable board bytes do not match stored digests/,
  );
  assert.equal(github.events.length, 0);
});

test('durable artifact tampering refuses publication before any outbound action', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  const result = await publishBoard(db.board.board_digest, options(db, github, {
    artifactVerifier: () => { throw new Error('durable patch digest changed'); },
  }));
  assert.equal(result.results[0].code, 'ARTIFACT_INTEGRITY_FAILED');
  assert.equal(github.events.length, 0);
});

test('artifact drift blocks a rerun without erasing an already submitted PR', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  await publishBoard(db.board.board_digest, options(db, github));
  const outboundBefore = github.events.length;
  const artifactVerifier = () => { throw new Error('durable patch digest changed'); };

  const repeated = await publishBoard(db.board.board_digest, options(db, github, {artifactVerifier}));
  assert.equal(repeated.results[0].state, 'SUBMITTED');
  assert.equal(repeated.results[0].code, 'ARTIFACT_INTEGRITY_FAILED');
  assert.equal((await db.getPublication('M-001')).publication_state, 'SUBMITTED');
  assert.equal((await db.getPublication('M-001')).last_error, 'ARTIFACT_INTEGRITY_FAILED');
  assert.equal(github.events.length, outboundBefore);

  db.publications.set('M-001', {
    ...db.publications.get('M-001'), publication_state: 'FAILED',
  });
  db.taskStates.set('TASK-001', {state: 'FAILED'});
  const repaired = await publishBoard(db.board.board_digest, options(db, github, {artifactVerifier}));
  assert.equal(repaired.results[0].state, 'SUBMITTED');
  assert.equal(repaired.results[0].code, 'ARTIFACT_INTEGRITY_FAILED');
  assert.equal((await db.getPublication('M-001')).publication_state, 'SUBMITTED');
  assert.equal(db.taskStates.get('TASK-001').state, 'PR_OPENED');
  assert.equal(github.events.length, outboundBefore);
});

test('each item gets another final live check immediately before its branch and PR', async () => {
  const db = new FakeDb(2);
  const github = new FakeGitHub();
  const calls = new Map();
  let receiptsPublished = false;
  const result = await publishBoard(db.board.board_digest, options(db, github, {
    liveRecheck: async (plan) => {
      const count = (calls.get(plan.mission_id) ?? 0) + 1;
      calls.set(plan.mission_id, count);
      if (plan.mission_id === 'M-002' && count === 2) {
        assert.equal(receiptsPublished, true);
        return {clean: false, reason: 'a competing claim appeared'};
      }
      return {clean: true};
    },
    receiptPublisher: async (items) => {
      receiptsPublished = true;
      return receipts(items);
    },
  }));
  assert.deepEqual([...calls.values()], [2, 2]);
  assert.equal(result.results.find((item) => item.mission_id === 'M-001').state, 'SUBMITTED');
  assert.equal(result.results.find((item) => item.mission_id === 'M-002').code, 'STALE_AFTER_RECEIPT');
  assert.equal(github.count('create_pull_request'), 1);
});

test('canonical Pages availability does not gate an approved upstream PR', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  const result = await publishBoard(db.board.board_digest, options(db, github));
  assert.equal(result.results[0].state, 'SUBMITTED');
  assert.equal(github.count('push_branch'), 1);
  assert.equal(github.count('create_pull_request'), 1);
});

test('internal public cap defers approved bytes and resumes without another branch push', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  let blocked = true;
  const safety = {
    request: async (request) => {
      if (blocked && request.kind === 'pr_create') {
        throw new GitHubPublicLimitError('hourly PR cap reached');
      }
      return request.execute();
    },
  };
  const first = await publishBoard(db.board.board_digest, options(db, github, {safety}));
  assert.equal(first.results[0].state, 'APPROVED');
  assert.equal(first.results[0].code, 'GITHUB_PUBLIC_LIMIT');
  assert.equal(db.publications.get('M-001').publication_state, 'BRANCH_PUSHED');
  assert.equal(db.publications.get('M-001').receipt_state, 'PUBLISHED');
  assert.equal(db.publications.get('M-001').last_error, 'GITHUB_PUBLIC_LIMIT');
  assert.equal(db.taskStates.has('TASK-001'), false);
  assert.equal(github.count('push_branch'), 1);
  assert.equal(github.count('create_pull_request'), 0);

  db.publications.set('M-001', {
    ...db.publications.get('M-001'),
    publication_state: 'FAILED',
    last_error: 'GITHUB_PUBLIC_LIMIT',
  });
  db.taskStates.set('TASK-001', {state: 'FAILED', detail: 'legacy cap handling'});
  const repaired = await publishBoard(db.board.board_digest, options(db, github, {safety}));
  assert.equal(repaired.results[0].state, 'APPROVED');
  assert.equal(db.publications.get('M-001').publication_state, 'BRANCH_PUSHED');
  assert.equal(db.taskStates.get('TASK-001').state, 'APPROVED');

  blocked = false;
  const resumed = await publishBoard(db.board.board_digest, options(db, github, {safety}));
  assert.equal(resumed.results[0].state, 'SUBMITTED');
  assert.equal(github.count('push_branch'), 1);
  assert.equal(github.count('create_pull_request'), 1);
  assert.equal(db.publications.get('M-001').last_error, null);
});

test('crash recovery adopts an exact PR that closed before its checkpoint retry', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  db.failCheckpoint = {state: 'PR_CHECKPOINTED', id: 'M-001', used: false};
  await assert.rejects(() => publishBoard(db.board.board_digest, options(db, github)),
    (error) => error instanceof PublisherCheckpointError);
  assert.equal(github.count('create_pull_request'), 1);
  const existing = [...github.pullRequests.values()][0];
  existing.state = 'CLOSED';
  const resumed = await publishBoard(db.board.board_digest, options(db, github));
  assert.equal(github.count('create_pull_request'), 1);
  assert.equal(resumed.results[0].state, 'SUBMITTED');
  assert.equal(resumed.results[0].pr_state, 'CLOSED');
  assert.equal(db.repositoryStates.get(existing.repository).open_northset_prs, 0);
});

test('attestation failure leaves the upstream PR open and unique', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  await publishBoard(db.board.board_digest, options(db, github));
  let statusCalls = 0;
  const result = await reconcileReceipt('M-001', {
    db,
    attestor: async () => { throw new Error('attestation service unavailable'); },
    statusPublisher: async () => { statusCalls += 1; },
  });

  assert.deepEqual(result, {
    mission_id: 'M-001', state: 'SUBMITTED', attestation_state: 'ATTESTATION_PENDING',
    status_state: 'PUBLISHED',
  });
  assert.equal((await db.getPublication('M-001')).publication_state, 'SUBMITTED');
  assert.equal((await db.getPublication('M-001')).attestation_state, 'ATTESTATION_PENDING');
  assert.equal((await db.getPublication('M-001')).status_state, 'PUBLISHED');
  assert.equal(statusCalls, 1);
  assert.equal(github.pullRequests.size, 1);
  assert.equal(github.count('create_pull_request'), 1);
  assert.equal(github.closeCount, 0);
  assert.equal(github.deleteCount, 0);
});

test('final status publication failure leaves a recoverable submitted state', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  await publishBoard(db.board.board_digest, options(db, github));
  const result = await reconcileReceipt('M-001', {
    db,
    attestor: async () => ({attestation_url: 'https://example.test/attestations/M-001'}),
    statusPublisher: async () => { throw new Error('status repository unavailable'); },
    now: () => new Date('2026-07-19T13:00:00.000Z'),
  });

  assert.deepEqual(result, {mission_id: 'M-001', state: 'SUBMITTED', status_state: 'PENDING'});
  const publication = await db.getPublication('M-001');
  assert.equal(publication.publication_state, 'SUBMITTED');
  assert.equal(publication.attestation_state, 'RECEIPT_ATTESTED');
  assert.equal(publication.status_state, 'PENDING');
  assert.match(publication.status_error, /status repository unavailable/);
  assert.equal(github.count('create_pull_request'), 1);
  assert.equal(github.closeCount, 0);
  assert.equal(github.deleteCount, 0);
});

test('rerunning a submitted board adopts the PR without double-counting repository state', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  await publishBoard(db.board.board_digest, options(db, github));
  const first = await db.getRepositoryState('upstream1/project');
  await db.savePublication('M-001', {
    attestation_state: 'RECEIPT_ATTESTED',
    status_state: 'PUBLISHED',
  });
  db.taskStates.set('TASK-001', {state: 'RECEIPT_ATTESTED'});
  const repeated = await publishBoard(db.board.board_digest, options(db, github));
  assert.equal(repeated.results[0].state, 'SUBMITTED');
  assert.equal(github.count('create_pull_request'), 1);
  assert.deepEqual(await db.getRepositoryState('upstream1/project'), first);
  assert.equal((await db.getPublication('M-001')).attestation_state, 'RECEIPT_ATTESTED');
  assert.equal((await db.getPublication('M-001')).status_state, 'PUBLISHED');
  assert.equal(db.taskStates.get('TASK-001').state, 'RECEIPT_ATTESTED');
});

test('a transient read failure cannot erase a factual submitted PR', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  await publishBoard(db.board.board_digest, options(db, github));
  const safety = {
    request: async (request) => {
      if (request.operation === 'find_pull_requests') {
        throw Object.assign(new Error('GraphQL request timed out'), {code: 'GH_COMMAND_FAILED'});
      }
      return request.execute();
    },
  };
  const repeated = await publishBoard(db.board.board_digest, options(db, github, {safety}));
  assert.equal(repeated.results[0].state, 'SUBMITTED');
  assert.equal(repeated.results[0].code, 'GH_COMMAND_FAILED');
  assert.equal((await db.getPublication('M-001')).publication_state, 'SUBMITTED');
  assert.equal((await db.getPublication('M-001')).last_error, 'GH_COMMAND_FAILED');
  assert.equal(github.count('create_pull_request'), 1);

  db.publications.set('M-001', {
    ...db.publications.get('M-001'), publication_state: 'FAILED', last_error: 'GH_COMMAND_FAILED',
  });
  db.taskStates.set('TASK-001', {state: 'FAILED'});
  const repaired = await publishBoard(db.board.board_digest, options(db, github));
  assert.equal(repaired.results[0].state, 'SUBMITTED');
  assert.equal((await db.getPublication('M-001')).publication_state, 'SUBMITTED');
  assert.equal(db.taskStates.get('TASK-001').state, 'PR_OPENED');
});

test('upstream title or body drift cannot erase a factual exact submission', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  await publishBoard(db.board.board_digest, options(db, github));
  const stored = [...github.pullRequests.values()][0];
  stored.body += '\nBot-added release notes.\n';

  db.publications.set('M-001', {
    ...db.publications.get('M-001'), publication_state: 'FAILED', last_error: 'STORED_PR_MISMATCH',
  });
  db.taskStates.set('TASK-001', {state: 'FAILED'});
  const repeated = await publishBoard(db.board.board_digest, options(db, github));
  assert.equal(repeated.results[0].state, 'SUBMITTED');
  assert.equal(repeated.results[0].code, 'STORED_PR_TEXT_DRIFT');
  assert.equal((await db.getPublication('M-001')).publication_state, 'SUBMITTED');
  assert.equal((await db.getPublication('M-001')).last_error, 'STORED_PR_TEXT_DRIFT');
  assert.equal(db.taskStates.get('TASK-001').state, 'PR_OPENED');
  assert.equal(github.count('create_pull_request'), 1);
});

test('a superseded mission cannot be resurrected under its previous approval', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  const stale = await publishBoard(db.board.board_digest, options(db, github, {
    liveRecheck: async () => ({clean: false, reason: 'issue was claimed'}),
  }));
  assert.equal(stale.results[0].state, 'SUPERSEDED');
  const repeated = await publishBoard(db.board.board_digest, options(db, github));
  assert.equal(repeated.results[0].state, 'SUPERSEDED');
  assert.equal(repeated.results[0].code, 'APPROVAL_TERMINAL');
  assert.equal(github.count('create_fork'), 0);
  assert.equal(github.count('create_pull_request'), 0);
});

test('an older board skips a corrected approval without mutating its current state', async () => {
  const db = new FakeDb(2);
  const github = new FakeGitHub();
  db.board.board_id = 'B-OLD';
  for (const ready of db.ready.values()) ready.board_id = 'B-OLD';
  db.ready.get('M-002').board_id = 'B-CORRECTED';
  const corrected = structuredClone(db.ready.get('M-002'));

  const result = await publishBoard(db.board.board_digest, options(db, github));

  assert.equal(result.results.find(({mission_id}) => mission_id === 'M-001').state, 'SUBMITTED');
  assert.deepEqual(result.results.find(({mission_id}) => mission_id === 'M-002'), {
    mission_id: 'M-002',
    state: 'SKIPPED',
    code: 'APPROVAL_SUPERSEDED',
    detail: 'the current READY item belongs to corrected board B-CORRECTED',
  });
  assert.deepEqual(await db.getReadyItem('M-002'), corrected);
  assert.equal(await db.getPublication('M-002'), null);
  assert.equal(db.taskStates.has('TASK-002'), false);
  assert.equal(github.count('create_pull_request'), 1);
});
