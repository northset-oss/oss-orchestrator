import assert from 'node:assert/strict';
import test from 'node:test';

import {reasonCodeFromFollowUp, reconcilePublicationBatch} from './reconciler.mjs';

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

function fakeDb(seed = publication(), readyManifest = null) {
  const publications = new Map([[seed.mission_id, {...seed}]]);
  let released = false;
  const taskStates = [];
  const interactionBlocks = [];
  return {
    publications,
    taskStates,
    interactionBlocks,
    async listReconciliationCandidates({limit}) {
      return [...publications.values()].filter((item) => item.publication_state === 'SUBMITTED').slice(0, limit);
    },
    async getReadyItem(missionId) {
      return {mission_id: missionId, manifest: {
        repository: 'upstream/project', commit_oid: HEAD, verification: {ok: true},
        ...readyManifest,
      }};
    },
    async getPublication(missionId) { return publications.get(missionId) ?? null; },
    async savePublication(missionId, patch) {
      const next = {...publications.get(missionId), ...patch};
      publications.set(missionId, next);
      return next;
    },
    async updateTaskState(taskId, state) { taskStates.push({taskId, state}); },
    async recordPublicationObservation(missionId, {prState, merged, ciState, prHeadOid, observedAt}) {
      const current = publications.get(missionId);
      const closed = merged || prState === 'CLOSED' || prState === 'MERGED';
      const repositoryReleased = closed && !released;
      if (repositoryReleased) released = true;
      const next = {
        ...current,
        pr_state: merged || prState === 'MERGED' ? 'MERGED' : prState,
        merged: merged || prState === 'MERGED',
        ci_state: ciState,
        pr_head_oid: prHeadOid ?? current.pr_head_oid,
        outcome_recorded_at: closed ? (current.outcome_recorded_at ?? observedAt) : current.outcome_recorded_at,
      };
      publications.set(missionId, next);
      return {publication: next, repository_released: repositoryReleased};
    },
    async recordInteractionBlock(record) {
      interactionBlocks.push(structuredClone(record));
      return record;
    },
  };
}

function harness({
  seed,
  prState = 'open',
  merged = false,
  attestor,
  statusPublisher,
  readyManifest = null,
  appendDemand = () => {},
  demandDir = 'runs/demand',
} = {}) {
  const db = fakeDb(seed, readyManifest);
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
        merge_commit_oid: merged ? 'd'.repeat(40) : null,
        updated_at: '2026-07-19T13:00:00.000Z',
      };
    },
    async getPullRequestCommits() { return {commits: [HEAD]}; },
    async getPullRequestFollowUp() {
      return {
        number: 17, url: 'https://github.com/upstream/project/pull/17', author_login: 'AysajanE',
        review_decision: null, comments: [], reviews: [], threads: [], history_truncated: false,
      };
    },
    async getCommitStatus() { return {found: true, state: 'SUCCESS'}; },
    async getArtifactAttestation() { return {found: false}; },
    async createPullRequest() { prohibited.create += 1; throw new Error('must not create'); },
    async closePullRequest() { prohibited.close += 1; throw new Error('must not close'); },
  };
  return {
    db, safety, github, safetyCalls, releases, prohibited, attestor, statusPublisher,
    appendDemand, demandDir,
  };
}

test('private reconciliation keeps factual PR state without public attestation or status calls', async () => {
  let attestationCalls = 0;
  let statusCalls = 0;
  const fixture = harness({
    seed: publication({
      receipt_url: null,
      receipt_proof_sha256: null,
      receipt_state: 'PRIVATE_INTERNAL',
      attestation_state: 'NOT_APPLICABLE',
      status_state: 'NOT_APPLICABLE',
    }),
    readyManifest: {
      mission_id: 'M-001',
      receipt_visibility: 'private_internal',
      receipt_url: null,
      consent_scopes: {
        schema_version: 2,
        mission_id: 'M-001',
        scopes: {receipt_publication_consent: {status: 'absent'}},
      },
    },
    attestor: async () => { attestationCalls += 1; },
    statusPublisher: async () => { statusCalls += 1; },
  });
  fixture.github.getArtifactAttestation = async () => {
    attestationCalls += 1;
    return {found: true};
  };

  const result = await reconcilePublicationBatch(fixture);
  const saved = await fixture.db.getPublication('M-001');
  assert.equal(result.processed, 1);
  assert.equal(result.results[0].receipt_visibility, 'private_internal');
  assert.equal(saved.pr_state, 'OPEN');
  assert.equal(saved.ci_state, 'SUCCESS');
  assert.equal(saved.attestation_state, 'NOT_APPLICABLE');
  assert.equal(saved.status_state, 'NOT_APPLICABLE');
  assert.equal(attestationCalls, 0);
  assert.equal(statusCalls, 0);
  assert.deepEqual(fixture.db.taskStates, []);
  assert.equal(fixture.safetyCalls.some((call) =>
    call.operation === 'reconcile_get_attestation' ||
    call.operation === 'publish_receipt_status_batch'), false);
});

test('public v3 reconciliation with publication consent attests and publishes status', async () => {
  let attestationCalls = 0;
  let statusCalls = 0;
  const fixture = harness({
    readyManifest: {
      mission_id: 'M-001',
      receipt_visibility: 'public_opt_in',
      receipt_url: 'https://northset-oss.example/receipts/M-001/',
      consent_scopes: {
        schema_version: 2,
        mission_id: 'M-001',
        scopes: {
          contribution_invitation: {status: 'not_applicable'},
          verification_execution_consent: {status: 'not_applicable'},
          receipt_publication_consent: {
            status: 'granted',
            evidence: {kind: 'public_url', value: 'https://example.test/consent/1'},
            granted_at: '2026-07-19T11:00:00.000Z',
            granted_by: 'maintainer',
          },
          marketing_reference_consent: {status: 'absent'},
        },
      },
    },
    attestor: async () => {
      attestationCalls += 1;
      return {
        found: true,
        attestation_url: 'https://example.test/attestations/1',
        attested_at: '2026-07-19T13:01:00.000Z',
      };
    },
    statusPublisher: async (items) => {
      statusCalls += 1;
      return Object.fromEntries(items.map((item) => [item.mission_id, {
        status_url: `https://example.test/${item.mission_id}/publication.json`,
      }]));
    },
  });

  await reconcilePublicationBatch(fixture);
  const saved = await fixture.db.getPublication('M-001');
  assert.equal(attestationCalls, 1);
  assert.equal(statusCalls, 1);
  assert.equal(saved.attestation_state, 'RECEIPT_ATTESTED');
  assert.equal(saved.status_state, 'PUBLISHED');
  assert.deepEqual(fixture.db.taskStates, [{taskId: 'TASK-1', state: 'RECEIPT_ATTESTED'}]);
  assert.ok(fixture.safetyCalls.some((call) => call.operation === 'reconcile_get_attestation'));
  assert.ok(fixture.safetyCalls.some((call) => call.operation === 'publish_receipt_status_batch'));
});

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
  assert.equal(statusBatches[0][0].receipt_url,
    'https://northset-oss.github.io/verification-pilot/receipts/M-001/');

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

test('a successful complete observation clears a resolved transient error', async () => {
  const fixture = harness({
    seed: publication({
      pr_state: 'OPEN',
      ci_state: 'SUCCESS',
      attestation_state: 'RECEIPT_ATTESTED',
      attestation_url: 'https://example.test/attestations/1',
      attested_at: '2026-07-19T13:00:00.000Z',
      status_state: 'PUBLISHED',
      status_url: 'https://example.test/M-001/publication.json',
      last_error: 'GH_COMMAND_FAILED',
      last_error_detail: 'temporary status timeout',
    }),
    statusPublisher: async () => { throw new Error('unchanged facts must not republish status'); },
  });

  const result = await reconcilePublicationBatch(fixture);
  const saved = await fixture.db.getPublication('M-001');
  assert.equal(result.processed, 1);
  assert.equal(saved.last_error, null);
  assert.equal(saved.last_error_detail, null);
  assert.equal(saved.status_state, 'PUBLISHED');
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
  assert.equal(statusBatches[0][0].merge_commit_oid, 'd'.repeat(40));
});

test('merged maintainer head drift is accepted only when the attested contribution remains in the PR', async () => {
  const finalHead = 'c'.repeat(40);
  const fixture = harness({
    prState: 'closed', merged: true,
    attestor: async () => ({found: false}),
    statusPublisher: async (items) => Object.fromEntries(items.map((item) => [item.mission_id, {
      status_url: `https://example.test/${item.mission_id}/publication.json`,
    }])),
  });
  fixture.github.getPullRequest = async () => ({
    number: 17, repository: 'upstream/project', head_oid: finalHead,
    state: 'closed', merged: true, merged_at: '2026-07-19T13:00:00.000Z',
    updated_at: '2026-07-19T13:00:00.000Z', merge_commit_oid: 'd'.repeat(40),
  });
  fixture.github.getPullRequestCommits = async () => ({commits: [HEAD, finalHead]});
  const result = await reconcilePublicationBatch(fixture);
  assert.equal(result.results[0].pr_state, 'MERGED');
  assert.equal((await fixture.db.getPublication('M-001')).pr_head_oid, finalHead);
  assert.deepEqual(fixture.releases, ['upstream/project']);
});

test('merged head drift without the attested contribution fails closed', async () => {
  const fixture = harness({
    prState: 'closed', merged: true,
    attestor: async () => ({found: false}),
    statusPublisher: async () => { throw new Error('must not publish'); },
  });
  fixture.github.getPullRequest = async () => ({
    number: 17, repository: 'upstream/project', head_oid: 'c'.repeat(40),
    state: 'closed', merged: true, merged_at: '2026-07-19T13:00:00.000Z',
    updated_at: '2026-07-19T13:00:00.000Z', merge_commit_oid: 'd'.repeat(40),
  });
  fixture.github.getPullRequestCommits = async () => ({commits: ['c'.repeat(40)]});
  const result = await reconcilePublicationBatch(fixture);
  assert.equal(result.results[0].code, 'RECONCILIATION_CONTRIBUTION_MISSING');
  assert.deepEqual(fixture.releases, []);
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

test('follow-up summary exposes contributor comments without relabeling maintainer activity', async () => {
  const fixture = harness({
    attestor: async () => ({found: false}),
    statusPublisher: async (items) => Object.fromEntries(items.map((item) => [item.mission_id, {
      status_url: `https://example.test/${item.mission_id}/publication.json`,
    }])),
  });
  fixture.github.getPullRequestFollowUp = async () => ({
    number: 17,
    url: 'https://github.com/upstream/project/pull/17',
    author_login: 'AysajanE',
    review_decision: 'CHANGES_REQUESTED',
    comments: [{
      author_login: 'AysajanE', author_type: 'User', author_association: 'NONE',
      url: 'https://github.com/upstream/project/pull/17#issuecomment-3',
      body: 'Implemented the requested change.', created_at: '2026-07-19T19:51:40Z',
      updated_at: '2026-07-19T19:51:40Z',
    }, {
      author_login: 'Jo-Con-El', author_type: 'User', author_association: 'CONTRIBUTOR',
      url: 'https://github.com/upstream/project/pull/17#issuecomment-4',
      body: 'Please leave a note on the issue before starting.', created_at: '2026-07-19T22:01:10Z',
      updated_at: '2026-07-19T22:01:10Z',
    }, {
      author_login: 'release-helper[bot]', author_type: 'Bot', author_association: 'CONTRIBUTOR',
      url: 'https://github.com/upstream/project/pull/17#issuecomment-5',
      body: 'Automated status.', created_at: '2026-07-19T22:02:10Z',
      updated_at: '2026-07-19T22:02:10Z',
    }],
    reviews: [{
      author_login: 'reviewer-one', author_type: 'User', author_association: 'MEMBER',
      url: 'https://github.com/upstream/project/pull/17#pullrequestreview-1',
      body: 'Feature is not correctly covered.', state: 'CHANGES_REQUESTED',
      submitted_at: '2026-07-13T09:42:13Z', commit_oid: 'a'.repeat(40),
    }, {
      author_login: 'reviewer-two', author_type: 'User', author_association: 'MEMBER',
      url: 'https://github.com/upstream/project/pull/17#pullrequestreview-2',
      body: '', state: 'APPROVED', submitted_at: '2026-07-19T21:46:36Z', commit_oid: HEAD,
    }],
    threads: [{
      is_resolved: false, is_outdated: true, path: 'src/index.mjs', line: null, original_line: 12,
      history_truncated: false,
      comments: [{
        author_login: 'reviewer-two', author_type: 'User', author_association: 'MEMBER',
        url: 'https://github.com/upstream/project/pull/17#discussion_r1',
        body: 'Please simplify this.', created_at: '2026-07-19T19:30:50Z',
        updated_at: '2026-07-19T19:30:50Z',
      }],
    }],
    history_truncated: true,
  });

  const result = await reconcilePublicationBatch(fixture);
  const followUp = result.results[0].follow_up;
  assert.equal(followUp.review_decision, 'CHANGES_REQUESTED');
  assert.deepEqual(followUp.latest_reviews_by_maintainer.map((review) => review.state),
    ['CHANGES_REQUESTED', 'APPROVED']);
  assert.equal(followUp.author_comments[0].body, 'Implemented the requested change.');
  assert.deepEqual(followUp.external_comments.map((comment) => comment.author_login),
    ['Jo-Con-El', 'reviewer-two']);
  assert.equal(followUp.external_comments[0].author_association, 'CONTRIBUTOR');
  assert.equal(followUp.maintainer_comments.length, 0);
  assert.equal(followUp.unresolved_threads[0].is_outdated, true);
  assert.equal(followUp.latest_change_request_at, '2026-07-13T09:42:13Z');
  assert.equal(followUp.latest_author_activity_at, '2026-07-19T19:51:40Z');
  assert.equal(followUp.latest_external_activity_at, '2026-07-19T22:01:10Z');
  assert.equal(followUp.author_activity_after_latest_change_request, true);
  assert.equal(followUp.history_truncated, true);
  assert.equal(result.results[0].follow_up_error, null);
  assert.ok(fixture.safetyCalls.some((call) =>
    call.operation === 'reconcile_get_pull_request_follow_up' && call.kind === 'read'));
  assert.equal(fixture.prohibited.create, 0);
  assert.equal(fixture.prohibited.close, 0);
});

test('maintainer AI-policy rejection creates a repository interaction block', async () => {
  const fixture = harness({
    prState: 'closed',
    attestor: async () => ({found: false}),
    statusPublisher: async (items) => Object.fromEntries(items.map((item) => [item.mission_id, {
      status_url: `https://example.test/${item.mission_id}/publication.json`,
    }])),
  });
  fixture.github.getPullRequestFollowUp = async () => ({
    author_login: 'AysajanE',
    review_decision: 'CHANGES_REQUESTED',
    comments: [],
    reviews: [{
      author_login: 'maintainer', author_type: 'User', author_association: 'OWNER',
      body: 'We do not accept AI-generated patches in this project.',
      state: 'CHANGES_REQUESTED', submitted_at: '2026-07-19T12:30:00Z',
    }],
    threads: [],
  });

  const result = await reconcilePublicationBatch(fixture);
  assert.equal(result.results[0].reason_code, 'ai_policy_concern');
  assert.equal(result.results[0].interaction_blocked, true);
  assert.deepEqual(fixture.db.interactionBlocks, [{
    scope: 'repository',
    subject: 'upstream/project',
    blockAuthoring: true,
    blockOutreach: true,
    reason: 'We do not accept AI-generated patches in this project.',
    reasonCode: 'ai_policy_concern',
    sourceUrl: 'https://github.com/upstream/project/pull/17',
    missionId: 'M-001',
    createdAt: '2026-07-19T13:00:00.000Z',
  }]);
  assert.equal(reasonCodeFromFollowUp({latest_reviews_by_maintainer: [], maintainer_comments: []}), 'unknown');
  assert.equal(reasonCodeFromFollowUp({latest_reviews_by_maintainer: [{
    body: 'AI-generated contributions are allowed if reviewed.',
  }]}), 'other');
  assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{
    body: "Unfortunately I am not able to accept your contribution due to this project's policy on the use of AI and LLMs.",
  }]}), 'ai_policy_concern');
  for (const body of [
    'We cannot accept contributions created with generative AI.',
    'We cannot merge this contribution under our AI policy.',
    'Our policy does not permit AI-assisted contributions.',
    'No AI-generated contributions.',
    'We have a no-AI policy.',
    'AI-generated submissions will be closed.',
    'AI contributions are forbidden.',
    'AI-assisted code is disallowed.',
    'Contributions made with AI are forbidden.',
    'We do not take contributions involving AI.',
  ]) {
    assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{body}]}), 'ai_policy_concern');
  }
  assert.equal(reasonCodeFromFollowUp({maintainer_comments: [
    {body: 'Please fix the failing tests'},
    {body: 'No AI-generated contributions.'},
  ]}), 'ai_policy_concern');
  assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{
    body: 'I am not able to accept the claim that LLM contributions are categorically unsafe; they are welcome.',
  }]}), 'other');
  assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{
    body: 'We cannot merge this yet because tests fail, but the AI disclosure is fine.',
  }]}), 'quality');
  assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{
    body: 'We cannot review the AI disclosure until next week.',
  }]}), 'other');
  assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{
    body: 'We cannot merge until the AI disclosure is added.',
  }]}), 'other');
  assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{
    body: 'We cannot merge AI-generated code until the failing tests are fixed.',
  }]}), 'quality');
  assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{
    body: "We don't want to merge this until CI passes.",
  }]}), 'other');
  assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{
    body: 'We cannot merge AI-generated code because the tests fail.',
  }]}), 'quality');
  assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{
    body: 'We cannot merge AI-generated code while CI is failing.',
  }]}), 'quality');
  assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{
    body: "We don't want to merge this while CI is red.",
  }]}), 'quality');
  for (const body of [
    'After reviewing this PR, we do not accept AI-generated contributions.',
    'Once again, AI contributions are forbidden.',
  ]) {
    assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{body}]}), 'ai_policy_concern');
  }
  assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{
    body: 'After reviewing the requested changes, we do not want this contribution.',
  }]}), 'not_wanted');
  for (const body of [
    'We cannot accept AI contributions because policy review is pending.',
    'We cannot accept AI contributions pending a policy review.',
  ]) {
    assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{body}]}), 'ai_policy_concern');
  }
  for (const body of [
    'We cannot merge AI-generated code before tests pass.',
    'We cannot merge AI-generated code due to failing tests.',
    'We cannot merge AI-generated code when CI is red.',
    'We cannot merge AI-generated code without passing checks.',
  ]) {
    assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{body}]}), 'quality');
  }
  for (const body of [
    'We cannot accept AI-generated contributions because our CI policy prohibits them.',
    'We cannot accept AI-generated contributions because repository checks reject them.',
  ]) {
    assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{body}]}), 'ai_policy_concern');
  }
  for (const body of [
    'We cannot merge this AI-generated change; tests are failing.',
    'We cannot merge this AI-generated change — tests are failing.',
  ]) {
    assert.equal(reasonCodeFromFollowUp({maintainer_comments: [{body}]}), 'quality');
  }
});

test('open PR maintainer AI-policy objection creates an interaction block without a review decision', async () => {
  const fixture = harness({
    prState: 'open',
    attestor: async () => ({found: false}),
    statusPublisher: async (items) => Object.fromEntries(items.map((item) => [item.mission_id, {
      status_url: `https://example.test/${item.mission_id}/publication.json`,
    }])),
  });
  fixture.github.getPullRequestFollowUp = async () => ({
    author_login: 'AysajanE',
    review_decision: null,
    comments: [{
      author_login: 'maintainer', author_type: 'User', author_association: 'OWNER',
      body: 'Our policy does not permit AI-assisted contributions.',
      created_at: '2026-07-19T12:30:00Z',
    }],
    reviews: [],
    threads: [],
  });

  const result = await reconcilePublicationBatch(fixture);
  assert.equal(result.results[0].reason_code, 'ai_policy_concern');
  assert.equal(result.results[0].interaction_blocked, true);
  assert.equal(fixture.db.interactionBlocks.length, 1);
  assert.equal(fixture.db.interactionBlocks[0].reasonCode, 'ai_policy_concern');
});
