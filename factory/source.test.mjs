import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPreflightQuery,
  createSource,
  enqueueCandidates,
  evaluatePreflight,
  preflightCandidates,
  readyPerMinutePriority,
  selectCandidates,
} from './source.mjs';

const NOW = new Date('2026-07-19T12:00:00Z');
const OID = 'a'.repeat(40);

function row(number, overrides = {}) {
  return {
    candidate_display: `Owner/Repo${number}#${number}`,
    repo_display: `Owner/Repo${number}`,
    repository_node_id: `R_${number}`,
    issue_node_id: `I_${number}`,
    profile: 'node',
    state: 'OPEN',
    mechanical_score: 80 - number,
    mechanical_reasons_json: '[]',
    last_hydrated_at: '2026-07-10T12:00:00Z',
    invitation_label_map_json: '{}',
    raw_json: '{}',
    ...overrides,
  };
}

function candidate(number = 1, overrides = {}) {
  return {
    candidate: `owner/repo${number}#${number}`,
    repository: `Owner/Repo${number}`,
    repositoryNodeId: `R_${number}`,
    issueNumber: number,
    issueNodeId: `I_${number}`,
    profile: 'node',
    priority: 0.1,
    invitationLabels: [],
    invitationPolicyPresent: false,
    ...overrides,
  };
}

function graphRepository(number = 1, overrides = {}) {
  const base = {
    id: `R_${number}`,
    nameWithOwner: `Owner/Repo${number}`,
    isArchived: false,
    isFork: false,
    defaultBranchRef: {name: 'main', target: {oid: OID}},
    issue: {
      id: `I_${number}`,
      number,
      title: 'Fix parser regression',
      bodyText: 'Expected behavior differs from actual behavior.',
      url: `https://github.com/Owner/Repo${number}/issues/${number}`,
      state: 'OPEN',
      locked: false,
      updatedAt: NOW.toISOString(),
      assignees: {nodes: []},
      labels: {nodes: [{name: 'good first issue'}]},
      comments: {nodes: []},
      timelineItems: {pageInfo: {hasPreviousPage: false}, nodes: []},
    },
  };
  return {...base, ...overrides, issue: {...base.issue, ...(overrides.issue ?? {})}};
}

function normalizedLive(overrides = {}) {
  const base = {
    candidate: candidate(),
    repository: {
      nodeId: 'R_1', nameWithOwner: 'Owner/Repo1', archived: false, fork: false,
      defaultBranch: 'main', defaultOid: OID, northsetOpenPrs: 0,
    },
    issue: {
      nodeId: 'I_1', number: 1, title: 'Fix parser regression', body: 'Expected differs from actual.',
      url: 'https://github.com/Owner/Repo1/issues/1', state: 'OPEN', locked: false,
      assignees: [], labels: ['good first issue'], comments: [], crossReferencedPrs: [], timelineTruncated: false,
    },
  };
  return {
    ...base,
    ...overrides,
    repository: overrides.repository === null ? null : {...base.repository, ...(overrides.repository ?? {})},
    issue: overrides.issue === null ? null : {...base.issue, ...(overrides.issue ?? {})},
  };
}

test('READY-per-minute priority combines mechanical score with observed conversion and duration', () => {
  const baseline = readyPerMinutePriority(90);
  const provenFast = readyPerMinutePriority(70, {attempts: 5, ready: 4, average_duration_ms: 4 * 60_000});
  const slowFailure = readyPerMinutePriority(110, {attempts: 5, ready: 0, average_duration_ms: 30 * 60_000});
  assert.ok(provenFast > baseline);
  assert.ok(baseline > slowFailure);
});

test('selector uses 14-day Node discovery records without semantic review or snapshot expiry', async () => {
  let sql = '';
  const rows = [
    row(1, {mechanical_score: 70}),
    row(2, {mechanical_score: 100, last_hydrated_at: '2026-07-01T00:00:00Z'}),
    row(3, {profile: 'python'}),
    row(4, {mechanical_reasons_json: '["not eligible"]'}),
  ];
  const selected = await selectCandidates({
    workers: 2,
    now: NOW,
    query: async (value) => { sql = value; return rows; },
  });
  assert.deepEqual(selected.map((item) => item.candidate), ['owner/repo1#1']);
  assert.match(sql, /2026-07-05T12:00:00\.000Z/);
  assert.doesNotMatch(sql, /reviews|evidence_key|snapshot_expires_at/);
});

test('a generic repository policy snapshot is not treated as contribution invitation', async () => {
  const [selected] = await selectCandidates({
    workers: 1,
    now: NOW,
    query: async () => [row(1, {raw_json: JSON.stringify({repo_policy_snapshot: {defaults: {max_open_prs: 1}}})})],
  });
  assert.equal(selected.invitationPolicyPresent, false);
});

test('selector defaults to 2x workers and clamps an explicit request at 4x workers', async () => {
  const rows = Array.from({length: 20}, (_, index) => row(index + 1));
  const query = async () => rows;
  assert.equal((await selectCandidates({workers: 3, query, now: NOW})).length, 6);
  assert.equal((await selectCandidates({workers: 3, limit: 99, query, now: NOW})).length, 12);
});

test('attempt history can reorder the initial mechanical ranking', async () => {
  const selected = await selectCandidates({
    workers: 1,
    limit: 2,
    now: NOW,
    query: async () => [row(1, {mechanical_score: 110}), row(2, {mechanical_score: 70})],
    attemptStats: {
      'owner/repo1#1': {attempts: 8, ready: 0, average_duration_ms: 30 * 60_000},
      'owner/repo2#2': {attempts: 8, ready: 7, average_duration_ms: 5 * 60_000},
    },
  });
  assert.deepEqual(selected.map((item) => item.candidate), ['owner/repo2#2', 'owner/repo1#1']);
});

test('preflight query consolidates all live fields and repository-wide Northset PR search', () => {
  const query = buildPreflightQuery([candidate()]);
  for (const expected of ['isArchived', 'isFork', 'defaultBranchRef', 'assignees', 'labels', 'comments', 'timelineItems']) {
    assert.match(query, new RegExp(expected));
  }
  assert.match(query, /repo:owner\/repo1 is:pr is:open author:AysajanE/);
});

test('clean invited live state returns GO', () => {
  assert.deepEqual(evaluatePreflight(normalizedLive(), {now: NOW}).outcome, 'GO');
});

test('each hard live-preflight violation returns SKIP', async (t) => {
  const claim = {author: 'Contributor', authorType: 'User', body: 'I am working on this now', createdAt: NOW.toISOString()};
  const cases = [
    ['closed issue', normalizedLive({issue: {state: 'CLOSED'}}), /issue is closed/],
    ['external assignment', normalizedLive({issue: {assignees: ['someone']}}), /assigned/],
    ['missing invitation', normalizedLive({issue: {labels: []}}), /invitation/],
    ['archived repository', normalizedLive({repository: {archived: true}}), /archived/],
    ['Northset open PR', normalizedLive({repository: {northsetOpenPrs: 1}}), /Northset already/],
    ['linked open PR', normalizedLive({issue: {crossReferencedPrs: [{state: 'OPEN', url: 'https://github.com/o/r/pull/2'}]}}), /linked open PR/],
    ['external claimant', normalizedLive({issue: {comments: [claim]}}), /claimant/],
    ['missing base OID', normalizedLive({repository: {defaultOid: null}}), /OID/],
  ];
  for (const [name, live, pattern] of cases) {
    await t.test(name, () => {
      const result = evaluatePreflight(live, {now: NOW});
      assert.equal(result.outcome, 'SKIP');
      assert.match(result.reasons.join(' '), pattern);
    });
  }
});

test('ambiguous overlap escalates only after all hard checks pass', () => {
  const live = normalizedLive({issue: {
    crossReferencedPrs: [{state: 'CLOSED', url: 'https://github.com/o/r/pull/2'}],
  }});
  assert.equal(evaluatePreflight(live, {now: NOW}).outcome, 'ESCALATE');
  live.repository.archived = true;
  assert.equal(evaluatePreflight(live, {now: NOW}).outcome, 'SKIP');
});

test('live preflight makes exactly one GraphQL call and respects the default 2x bound', async () => {
  let calls = 0;
  const github = {
    async graphql(query) {
      calls += 1;
      assert.match(query, /FactoryLivePreflight/);
      return {data: {
        c0: graphRepository(1), n0: {issueCount: 0},
        c1: graphRepository(2), n1: {issueCount: 0},
      }};
    },
  };
  const results = await preflightCandidates([candidate(1), candidate(2), candidate(3)], {
    github, workers: 1, now: NOW,
  });
  assert.equal(calls, 1);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((result) => result.outcome), ['GO', 'GO']);
});

test('enqueue sends only GO tasks and never allocates a public mission ID', async () => {
  let captured;
  const go = {outcome: 'GO', candidate: candidate(), liveState: normalizedLive()};
  const skip = {outcome: 'SKIP', candidate: candidate(2), liveState: normalizedLive()};
  const result = await enqueueCandidates([go, skip], {db: {
    async enqueueTasks(tasks) { captured = tasks; return {inserted: tasks.length}; },
  }});
  assert.deepEqual(result, {inserted: 1});
  assert.equal(captured.length, 1);
  assert.equal(captured[0].candidate, 'owner/repo1#1');
  assert.equal(captured[0].state, 'QUEUED');
  assert.equal(Object.hasOwn(captured[0], 'mission_id'), false);
});

test('createSource fills from lake through one preflight and injected enqueue seam', async () => {
  let enqueued = 0;
  const source = createSource({
    query: async () => [row(1)],
    github: {graphql: async () => ({data: {c0: graphRepository(1), n0: {issueCount: 0}}})},
    db: {enqueueTasks: async (tasks) => { enqueued += tasks.length; return tasks.length; }},
  });
  const result = await source.fill({workers: 1, now: NOW});
  assert.equal(result.candidates.length, 1);
  assert.equal(result.results[0].outcome, 'GO');
  assert.equal(result.enqueued, 1);
  assert.equal(enqueued, 1);
});
