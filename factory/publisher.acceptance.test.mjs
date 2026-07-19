import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';

import {
  PublisherCheckpointError,
  publishBoard,
  reconcileReceipt,
} from './publisher.mjs';

const BOARD_DIGEST = `sha256:${'b'.repeat(64)}`;

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function oid(index) {
  return index.toString(16).padStart(40, '0');
}

function mission(index) {
  const id = `M-${String(index).padStart(3, '0')}`;
  const itemDigest = digest(`item:${id}`);
  return {
    mission_id: id,
    task_id: `TASK-${String(index).padStart(3, '0')}`,
    item_digest: itemDigest,
    manifest_sha256: itemDigest,
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
      this.repositoryStates.set(item.repository, {open_northset_prs: 0});
    }
    this.board = {board_digest: BOARD_DIGEST, items};
    this.approval = {
      board_digest: BOARD_DIGEST,
      approved_ids: items.map((item) => item.mission_id),
      approved_by: 'internal-user:aeziz',
    };
  }

  async getBoard(digestValue) {
    return digestValue === BOARD_DIGEST ? structuredClone(this.board) : null;
  }

  async getBoardApproval(digestValue) {
    return digestValue === BOARD_DIGEST ? structuredClone(this.approval) : null;
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
}

class FakeGitHub {
  constructor() {
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
  }]));
}

function options(db, github, overrides = {}) {
  return {
    db,
    github,
    safety: safetyFor(github),
    liveRecheck: async () => ({clean: true}),
    receiptPublisher: async (items) => receipts(items),
    now: () => new Date('2026-07-19T12:00:00.000Z'),
    ...overrides,
  };
}

test('publisher resumes after seven of twenty branch pushes without duplicates', async () => {
  const db = new FakeDb(20);
  const github = new FakeGitHub();
  db.failCheckpoint = {state: 'BRANCH_PUSHED', id: 'M-007', used: false};

  await assert.rejects(() => publishBoard(BOARD_DIGEST, options(db, github)),
    (error) => error instanceof PublisherCheckpointError);
  assert.equal(github.count('push_branch'), 7);

  const resumed = await publishBoard(BOARD_DIGEST, options(db, github));
  assert.equal(resumed.results.filter((item) => item.state === 'SUBMITTED').length, 20);
  assert.equal(github.count('push_branch'), 20);
  assert.equal(new Set(github.events.filter((event) => event.operation === 'push_branch')
    .map((event) => `${event.repository}:${event.branch}`)).size, 20);
  assert.equal(github.count('create_pull_request'), 20);
});

test('publisher adopts seven exact existing PRs after a crash without duplicates', async () => {
  const db = new FakeDb(20);
  const github = new FakeGitHub();
  db.failCheckpoint = {state: 'PR_CHECKPOINTED', id: 'M-007', used: false};

  await assert.rejects(() => publishBoard(BOARD_DIGEST, options(db, github)),
    (error) => error instanceof PublisherCheckpointError);
  assert.equal(github.count('create_pull_request'), 7);
  for (let index = 1; index <= 7; index += 1) {
    db.repositoryStates.set(db.ready.get(`M-${String(index).padStart(3, '0')}`).repository,
      {open_northset_prs: 1});
  }

  const resumed = await publishBoard(BOARD_DIGEST, options(db, github));
  assert.equal(resumed.results.filter((item) => item.state === 'SUBMITTED').length, 20);
  assert.equal(github.count('create_pull_request'), 20);
  assert.equal(github.pullRequests.size, 20);
  assert.equal(github.closeCount, 0);
  assert.equal(github.deleteCount, 0);
});

test('one stale item is removed without stopping clean batch items', async () => {
  const db = new FakeDb(20);
  const github = new FakeGitHub();
  const result = await publishBoard(BOARD_DIGEST, options(db, github, {
    liveRecheck: async (item) => item.mission_id === 'M-008'
      ? {clean: false, reason: 'issue was claimed'} : {clean: true},
  }));

  assert.equal(result.results.find((item) => item.mission_id === 'M-008').state, 'SUPERSEDED');
  assert.equal(result.results.filter((item) => item.state === 'SUBMITTED').length, 19);
  assert.equal(github.count('push_branch'), 19);
  assert.equal(github.count('create_pull_request'), 19);
  assert.equal(db.taskStates.get('TASK-008').state, 'SUPERSEDED');
});

test('stored PR body or head mismatch fails only that item', async () => {
  const db = new FakeDb(5);
  const github = new FakeGitHub();
  const mismatched = db.ready.get('M-003');
  github.insertPullRequest(mismatched, {body: 'different approved bytes\n'});

  const result = await publishBoard(BOARD_DIGEST, options(db, github));
  const failed = result.results.find((item) => item.mission_id === 'M-003');
  assert.equal(failed.code, 'STORED_PR_MISMATCH');
  assert.equal(result.results.filter((item) => item.state === 'SUBMITTED').length, 4);
  assert.equal(github.count('create_pull_request'), 4);
  assert.equal(github.pullRequests.size, 5);
  assert.equal(github.closeCount, 0);
  assert.equal(github.deleteCount, 0);
});

test('attestation failure leaves the upstream PR open and unique', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  await publishBoard(BOARD_DIGEST, options(db, github));
  let statusCalls = 0;
  const result = await reconcileReceipt('M-001', {
    db,
    attestor: async () => { throw new Error('attestation service unavailable'); },
    statusPublisher: async () => { statusCalls += 1; },
  });

  assert.deepEqual(result, {
    mission_id: 'M-001', state: 'SUBMITTED', attestation_state: 'ATTESTATION_PENDING',
  });
  assert.equal((await db.getPublication('M-001')).publication_state, 'SUBMITTED');
  assert.equal((await db.getPublication('M-001')).attestation_state, 'ATTESTATION_PENDING');
  assert.equal(statusCalls, 0);
  assert.equal(github.pullRequests.size, 1);
  assert.equal(github.count('create_pull_request'), 1);
  assert.equal(github.closeCount, 0);
  assert.equal(github.deleteCount, 0);
});

test('final status publication failure leaves a recoverable submitted state', async () => {
  const db = new FakeDb(1);
  const github = new FakeGitHub();
  await publishBoard(BOARD_DIGEST, options(db, github));
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
