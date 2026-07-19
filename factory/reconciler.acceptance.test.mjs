import assert from 'node:assert/strict';
import test from 'node:test';

import {reconcilePublicationBatch} from './reconciler.mjs';

const HEAD = 'b'.repeat(40);
const PROOF = `sha256:${'a'.repeat(64)}`;

function publication(overrides = {}) {
  return {
    mission_id: 'M-001', task_id: 'TASK-1', pushed_oid: HEAD, pr_head_oid: HEAD,
    pr_url: 'https://github.com/upstream/project/pull/17', pr_number: 17,
    pr_state: null, merged: false, ci_state: null, outcome_recorded_at: null,
    receipt_url: `https://github.com/northset-oss/verification-pilot/blob/receipts/receipts/M-001/${HEAD}/proof.json`,
    receipt_proof_sha256: PROOF, attestation_state: 'ATTESTATION_PENDING',
    attestation_url: null, attested_at: null, attestation_error: null,
    status_state: 'NOT_STARTED', status_url: null, status_error: null,
    publication_state: 'SUBMITTED', submitted_at: '2026-07-19T12:00:00.000Z',
    last_error: null, last_error_detail: null,
    ...overrides,
  };
}

function fakeDb(seed = publication()) {
  const publications = new Map([[seed.mission_id, {...seed}]]);
  let released = false;
  const taskStates = [];
  return {
    publications,
    taskStates,
    async listReconciliationCandidates({limit}) {
      return [...publications.values()].filter((item) => item.publication_state === 'SUBMITTED').slice(0, limit);
    },
    async getReadyItem(missionId) {
      return {mission_id: missionId, manifest: {repository: 'upstream/project', commit_oid: HEAD}};
    },
    async getPublication(missionId) { return publications.get(missionId) ?? null; },
    async savePublication(missionId, patch) {
      const next = {...publications.get(missionId), ...patch};
      publications.set(missionId, next);
      return next;
    },
    async updateTaskState(taskId, state) { taskStates.push({taskId, state}); },
    async recordPublicationObservation(missionId, {prState, merged, ciState, observedAt}) {
      const current = publications.get(missionId);
      const closed = merged || prState === 'CLOSED' || prState === 'MERGED';
      const repositoryReleased = closed && !released;
      if (repositoryReleased) released = true;
      const next = {
        ...current,
        pr_state: merged || prState === 'MERGED' ? 'MERGED' : prState,
        merged: merged || prState === 'MERGED',
        ci_state: ciState,
        outcome_recorded_at: closed ? (current.outcome_recorded_at ?? observedAt) : current.outcome_recorded_at,
      };
      publications.set(missionId, next);
      return {publication: next, repository_released: repositoryReleased};
    },
  };
}

function harness({seed, prState = 'open', merged = false, attestor, statusPublisher} = {}) {
  const db = fakeDb(seed);
  const safetyCalls = [];
  const releases = [];
  const prohibited = {create: 0, close: 0};
  const safety = {
    async request(request) {
      safetyCalls.push(request);
      return request.execute();
    },
    async releaseRepository(repository) { releases.push(repository); },
  };
  const github = {
    async getPullRequest() {
      return {
        number: 17, repository: 'upstream/project', head_oid: HEAD,
        state: prState, merged, merged_at: merged ? '2026-07-19T13:00:00.000Z' : null,
        updated_at: '2026-07-19T13:00:00.000Z',
      };
    },
    async getCommitStatus() { return {found: true, state: 'SUCCESS'}; },
    async getArtifactAttestation() { return {found: false}; },
    async createPullRequest() { prohibited.create += 1; throw new Error('must not create'); },
    async closePullRequest() { prohibited.close += 1; throw new Error('must not close'); },
  };
  return {db, safety, github, safetyCalls, releases, prohibited, attestor, statusPublisher};
}

test('attestation failure remains pending, publishes factual status, and restart never duplicates a PR', async () => {
  let attestationCalls = 0;
  const statusBatches = [];
  const fixture = harness({
    attestor: async () => {
      attestationCalls += 1;
      if (attestationCalls === 1) throw new Error('attestation service unavailable');
      return {
        found: true,
        attestation_url: 'https://github.com/northset-oss/verification-pilot/attestations/1',
        attested_at: '2026-07-19T13:01:00.000Z',
      };
    },
    statusPublisher: async (items) => {
      statusBatches.push(structuredClone(items));
      return Object.fromEntries(items.map((item) => [item.mission_id, {
        mission_id: item.mission_id,
        status_url: `https://example.test/${item.mission_id}/publication.json`,
      }]));
    },
  });

  await reconcilePublicationBatch(fixture);
  let saved = await fixture.db.getPublication('M-001');
  assert.equal(saved.attestation_state, 'ATTESTATION_PENDING');
  assert.equal(saved.status_state, 'PUBLISHED');
  assert.equal(statusBatches[0][0].attestation_state, 'ATTESTATION_PENDING');

  await reconcilePublicationBatch(fixture);
  saved = await fixture.db.getPublication('M-001');
  assert.equal(saved.attestation_state, 'RECEIPT_ATTESTED');
  assert.equal(saved.status_state, 'PUBLISHED');
  assert.equal(statusBatches[1][0].attestation_state, 'RECEIPT_ATTESTED');
  assert.deepEqual(fixture.db.taskStates, [{taskId: 'TASK-1', state: 'RECEIPT_ATTESTED'}]);

  await reconcilePublicationBatch(fixture);
  assert.equal(statusBatches.length, 2, 'unchanged restart must not republish status');
  assert.equal(fixture.prohibited.create, 0);
  assert.equal(fixture.prohibited.close, 0);
  assert.ok(fixture.safetyCalls.every((call) => call.priority === 'reconciliation'));
  assert.equal(fixture.safetyCalls.filter((call) => call.kind === 'git_push').length, 2);
});

test('status batch failure is recoverable and retries once on the next bounded invocation', async () => {
  let statusAttempts = 0;
  const fixture = harness({
    attestor: async () => ({found: false}),
    statusPublisher: async (items) => {
      statusAttempts += 1;
      if (statusAttempts === 1) throw new Error('status remote unavailable');
      return Object.fromEntries(items.map((item) => [item.mission_id, {
        status_url: `https://example.test/${item.mission_id}/publication.json`,
      }]));
    },
  });

  const first = await reconcilePublicationBatch(fixture);
  assert.equal(first.processed, 1);
  assert.equal((await fixture.db.getPublication('M-001')).status_state, 'PENDING');
  await reconcilePublicationBatch(fixture);
  assert.equal((await fixture.db.getPublication('M-001')).status_state, 'PUBLISHED');
  await reconcilePublicationBatch(fixture);
  assert.equal(statusAttempts, 2);
  assert.equal(fixture.prohibited.create, 0);
  assert.equal(fixture.prohibited.close, 0);
});

test('merged outcome releases the repository exactly once across restarts and publishes one final status', async () => {
  const statusBatches = [];
  const fixture = harness({
    prState: 'closed', merged: true,
    attestor: async () => ({found: false}),
    statusPublisher: async (items) => {
      statusBatches.push(structuredClone(items));
      return Object.fromEntries(items.map((item) => [item.mission_id, {
        status_url: `https://example.test/${item.mission_id}/publication.json`,
      }]));
    },
  });

  await reconcilePublicationBatch(fixture);
  await reconcilePublicationBatch(fixture);
  const saved = await fixture.db.getPublication('M-001');
  assert.equal(saved.pr_state, 'MERGED');
  assert.equal(saved.merged, true);
  assert.equal(saved.outcome_recorded_at, '2026-07-19T13:00:00.000Z');
  assert.deepEqual(fixture.releases, ['upstream/project']);
  assert.equal(statusBatches.length, 1);
  assert.equal(statusBatches[0][0].pr_state, 'MERGED');
});

test('a PR head mismatch is persisted as pending and cannot publish or mutate GitHub', async () => {
  const fixture = harness({
    attestor: async () => ({found: false}),
    statusPublisher: async () => { throw new Error('must not publish'); },
  });
  fixture.github.getPullRequest = async () => ({
    number: 17, repository: 'upstream/project', head_oid: 'c'.repeat(40),
    state: 'open', updated_at: '2026-07-19T13:00:00.000Z',
  });
  const result = await reconcilePublicationBatch(fixture);
  assert.equal(result.results[0].code, 'RECONCILIATION_PR_HEAD_MISMATCH');
  assert.match((await fixture.db.getPublication('M-001')).last_error, /RECONCILIATION_PR_HEAD_MISMATCH/);
  assert.equal(fixture.safetyCalls.filter((call) => call.kind === 'git_push').length, 0);
  assert.equal(fixture.prohibited.create, 0);
  assert.equal(fixture.prohibited.close, 0);
});
