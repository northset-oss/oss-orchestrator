import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GitHubPausedError,
  GitHubPublicLimitError,
  GitHubSafetyError,
  createGitHubSafety,
  resumeGitHub,
} from './github-safety.mjs';

async function fixture(t, name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  t.after(() => rm(root, {recursive: true, force: true}));
  let current = Date.parse('2026-07-19T12:00:00.000Z');
  const sleeps = [];
  return {
    pauseFile: path.join(root, 'github-pause.json'),
    now: () => current,
    advance: (milliseconds) => { current += milliseconds; },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      current += milliseconds;
    },
    sleeps,
  };
}

test('G1 secondary limit stops the current and entire queued GitHub transport', async (t) => {
  const clock = await fixture(t, 'factory-github-secondary');
  const calls = [];
  const github = createGitHubSafety({
    ...clock,
    transport: async (request) => {
      calls.push(request.operation);
      return {
        status: 403,
        headers: {'x-ratelimit-remaining': '4999'},
        body: {
          message: 'You have exceeded a secondary rate limit. Please wait before retrying.',
          documentation_url: 'https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api',
        },
      };
    },
  });

  const results = await Promise.allSettled([
    github.request({priority: 'maintainer_response', kind: 'read', operation: 'first'}),
    github.request({priority: 'final_submission', kind: 'mutation', operation: 'second'}),
    github.request({priority: 'discovery_top_up', kind: 'search', operation: 'third'}),
  ]);

  assert.deepEqual(calls, ['first']);
  assert.equal(results.every((result) => result.status === 'rejected' && result.reason instanceof GitHubPausedError), true);
  const pause = JSON.parse(await readFile(clock.pauseFile, 'utf8'));
  assert.equal(pause.paused, true);
  assert.equal(pause.kind, 'GITHUB_SECONDARY_RATE_LIMIT');
  assert.equal((await github.status()).queue_depth, 0);
  await assert.rejects(
    () => github.request({priority: 'live_preflight', kind: 'read', operation: 'after-pause'}),
    (error) => error instanceof GitHubPausedError,
  );
  assert.deepEqual(calls, ['first']);
});

test('G1b any HTTP 403 pauses transport even when it is a permission denial', async (t) => {
  const clock = await fixture(t, 'factory-github-forbidden');
  let probes = 0;
  const github = createGitHubSafety({
    ...clock,
    transport: async () => ({
      status: 403,
      headers: {'x-ratelimit-remaining': '4949'},
      body: {message: 'Must have push access to view collaborator permission.'},
    }),
  });

  await assert.rejects(
    () => github.request({priority: 'live_preflight', kind: 'read', operation: 'collaborator_permission'}),
    (error) => error instanceof GitHubPausedError && error.pause.kind === 'GITHUB_HTTP_403',
  );
  const pause = JSON.parse(await readFile(clock.pauseFile, 'utf8'));
  assert.equal(pause.paused, true);
  assert.equal(pause.kind, 'GITHUB_HTTP_403');
  assert.match(pause.details, /Must have push access/);
  const probe = async () => {
    probes += 1;
    return {status: 200, headers: {'x-ratelimit-remaining': '4949'}, body: {ok: true}};
  };
  await assert.rejects(() => resumeGitHub({
    pauseFile: clock.pauseFile,
    reason: 'operator reviewed permission denial',
    clearedBy: 'internal-user:aeziz',
    transport: probe,
    now: clock.now,
  }), (error) => error instanceof GitHubSafetyError && error.code === 'GITHUB_FORBIDDEN_REVIEW');
  assert.equal(probes, 0);

  const cleared = await resumeGitHub({
    pauseFile: clock.pauseFile,
    reason: 'operator reviewed permission denial',
    clearedBy: 'internal-user:aeziz',
    transport: probe,
    acknowledgeForbidden: true,
    now: clock.now,
  });
  assert.equal(probes, 1);
  assert.equal(cleared.paused, false);
});

test('exit-zero GraphQL RATE_LIMITED is a structured secondary-limit signal', async (t) => {
  const clock = await fixture(t, 'factory-github-graphql-limit');
  const github = createGitHubSafety({
    ...clock,
    transport: async () => ({
      status: 200,
      body: {data: null, errors: [{extensions: {code: 'RATE_LIMITED'}}]},
    }),
  });
  await assert.rejects(
    () => github.request({priority: 'live_preflight', kind: 'read', operation: 'graphql'}),
    (error) => error instanceof GitHubPausedError && error.pause.kind === 'GITHUB_SECONDARY_RATE_LIMIT',
  );
});

test('G2 Retry-After blocks early resume and later performs exactly one clean probe', async (t) => {
  const clock = await fixture(t, 'factory-github-retry-after');
  const github = createGitHubSafety({
    ...clock,
    transport: async () => ({status: 429, headers: {'Retry-After': '120'}, body: {message: 'slow down'}}),
  });
  await assert.rejects(
    () => github.request({priority: 'final_submission', kind: 'mutation', operation: 'publish'}),
    (error) => error instanceof GitHubPausedError && error.pause.retry_after === 120,
  );

  let probes = 0;
  const probe = async (request) => {
    probes += 1;
    assert.deepEqual(request, {
      priority: 'maintainer_response', kind: 'read', operation: 'rate_limit_probe', path: '/rate_limit', probe: true,
    });
    return {status: 200, headers: {'x-ratelimit-remaining': '4998'}, body: {ok: true}};
  };
  await assert.rejects(() => resumeGitHub({
    pauseFile: clock.pauseFile,
    reason: 'owner reviewed incident',
    clearedBy: 'internal-user:aeziz',
    transport: probe,
    now: clock.now,
  }), (error) => error instanceof GitHubSafetyError && error.code === 'GITHUB_RETRY_AFTER_ACTIVE');
  assert.equal(probes, 0);

  clock.advance(120_000);
  const cleared = await resumeGitHub({
    pauseFile: clock.pauseFile,
    reason: 'owner reviewed incident',
    clearedBy: 'internal-user:aeziz',
    transport: probe,
    now: clock.now,
  });
  assert.equal(probes, 1);
  assert.equal(cleared.paused, false);
  assert.equal(cleared.cleared_by, 'internal-user:aeziz');
  assert.equal(JSON.parse(await readFile(clock.pauseFile, 'utf8')).paused, false);
});

test('G3 primary-exhaustion HTTP 403 pauses instead of retrying automatically', async (t) => {
  const clock = await fixture(t, 'factory-github-primary');
  const calls = [];
  const resetSeconds = Math.floor((clock.now() + 3_000) / 1_000);
  const github = createGitHubSafety({
    ...clock,
    transport: async () => {
      calls.push(clock.now());
      return calls.length === 1
        ? {status: 403, headers: {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds)}, body: {message: 'API rate limit exceeded'}}
        : {status: 200, headers: {'x-ratelimit-remaining': '4999'}, body: {ok: true}};
    },
  });
  await assert.rejects(
    () => github.request({priority: 'live_preflight', kind: 'read', operation: 'preflight'}),
    (error) => error instanceof GitHubPausedError && error.pause.kind === 'GITHUB_PRIMARY_RATE_LIMIT',
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(clock.sleeps, []);
  assert.equal((await github.status()).paused, true);
  const pause = JSON.parse(await readFile(clock.pauseFile, 'utf8'));
  assert.equal(pause.primary_reset_at, new Date(resetSeconds * 1_000).toISOString());

  await assert.rejects(() => resumeGitHub({
    pauseFile: clock.pauseFile,
    reason: 'operator reviewed primary exhaustion',
    clearedBy: 'internal-user:aeziz',
    transport: async () => { calls.push(clock.now()); return {status: 200}; },
    now: clock.now,
  }), (error) => error instanceof GitHubSafetyError && error.code === 'GITHUB_PRIMARY_RESET_ACTIVE');
  assert.equal(calls.length, 1);

  clock.advance(3_000);
  const cleared = await resumeGitHub({
    pauseFile: clock.pauseFile,
    reason: 'operator reviewed primary exhaustion',
    clearedBy: 'internal-user:aeziz',
    transport: async () => {
      calls.push(clock.now());
      return {status: 200, headers: {'x-ratelimit-remaining': '4999'}, body: {ok: true}};
    },
    now: clock.now,
  });
  assert.equal(calls.length, 2);
  assert.equal(cleared.paused, false);
});

test('G4 serial queue enforces mutation and search start spacing and priority order', async (t) => {
  const clock = await fixture(t, 'factory-github-spacing');
  const starts = [];
  const github = createGitHubSafety({
    ...clock,
    transport: async (request) => {
      starts.push({operation: request.operation, at: clock.now()});
      return {status: 200, body: {ok: true}};
    },
  });
  await Promise.all([
    github.request({priority: 'discovery_top_up', kind: 'mutation', operation: 'low'}),
    github.request({priority: 'final_submission', kind: 'mutation', operation: 'high'}),
    github.request({priority: 'reconciliation', kind: 'mutation', operation: 'middle'}),
  ]);
  assert.deepEqual(starts.map((entry) => entry.operation), ['high', 'middle', 'low']);
  assert.deepEqual(starts.map((entry) => entry.at - starts[0].at), [0, 1_250, 2_500]);

  starts.length = 0;
  await Promise.all([
    github.request({priority: 'discovery_top_up', kind: 'search', operation: 'search-1'}),
    github.request({priority: 'discovery_top_up', kind: 'search', operation: 'search-2'}),
  ]);
  assert.equal(starts[1].at - starts[0].at, 2_000);
});

test('G5 repository cooldown and one-open-PR cap reject before transport', async (t) => {
  const clock = await fixture(t, 'factory-github-repository-limits');
  let calls = 0;
  const states = {
    'owner/cooling': {cooldown_reason: 'maintainer asked for a pause', cooldown_until: 'manual-release'},
    'owner/open': {open_northset_prs: 1},
  };
  const github = createGitHubSafety({
    ...clock,
    repositoryState: ({repository}) => states[repository] ?? {},
    transport: async () => { calls += 1; return {status: 201}; },
  });
  await assert.rejects(
    () => github.request({priority: 'final_submission', kind: 'pr_create', operation: 'create', repository: 'owner/cooling'}),
    (error) => error instanceof GitHubPublicLimitError && /cooldown/.test(error.reason),
  );
  await assert.rejects(
    () => github.request({priority: 'final_submission', kind: 'pr_create', operation: 'create', repository: 'owner/open'}),
    (error) => error instanceof GitHubPublicLimitError && /one-open-PR/.test(error.reason),
  );
  assert.equal(calls, 0);
});

test('G6 a paused GitHub publisher does not govern local worker execution', async (t) => {
  const clock = await fixture(t, 'factory-github-worker-isolation');
  const github = createGitHubSafety({
    ...clock,
    transport: async () => ({status: 429, headers: {'retry-after': '60'}, body: {message: 'rate limited'}}),
  });
  await assert.rejects(
    () => github.request({priority: 'final_submission', kind: 'pr_create', operation: 'create', repository: 'owner/repo'}),
    (error) => error instanceof GitHubPausedError,
  );
  let localRuns = 0;
  const runLocalWorker = async () => { localRuns += 1; return 'VERIFIED'; };
  assert.equal(await runLocalWorker(), 'VERIFIED');
  assert.equal(await runLocalWorker(), 'VERIFIED');
  assert.equal(localRuns, 2);
  assert.equal((await github.status()).paused, true);
});

test('public governor applies owner/day cap across successful PR creations', async (t) => {
  const clock = await fixture(t, 'factory-github-owner-cap');
  const calls = [];
  const github = createGitHubSafety({
    ...clock,
    repositoryState: () => ({}),
    transport: async (request) => {
      calls.push(request.repository);
      return {status: 201, body: {url: `https://github.com/${request.repository}/pull/1`}};
    },
  });
  await github.request({priority: 'final_submission', kind: 'pr_create', operation: 'create', repository: 'org/one'});
  await github.request({priority: 'final_submission', kind: 'pr_create', operation: 'create', repository: 'org/two'});
  await assert.rejects(
    () => github.request({priority: 'final_submission', kind: 'pr_create', operation: 'create', repository: 'org/three'}),
    (error) => error instanceof GitHubPublicLimitError && /owner\/day/.test(error.reason),
  );
  assert.deepEqual(calls, ['org/one', 'org/two']);
});

test('independent CLI governors share pacing, open-repository reservations, and owner caps', async (t) => {
  const clock = await fixture(t, 'factory-github-cross-process');
  const starts = [];
  const make = () => createGitHubSafety({
    ...clock,
    mutationSpacingMs: 25,
    repositoryState: () => ({}),
    transport: async (request) => {
      starts.push({repository: request.repository, at: clock.now()});
      return {status: 201, body: {url: `https://github.com/${request.repository}/pull/1`}};
    },
  });
  const governors = [make(), make(), make()];
  const results = await Promise.allSettled(governors.map((governor, index) => governor.request({
    priority: 'final_submission', kind: 'pr_create', operation: 'create',
    repository: `shared/repo-${index + 1}`,
  })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
  assert.equal(results.filter((result) => result.status === 'rejected' &&
    result.reason instanceof GitHubPublicLimitError && /owner\/day/.test(result.reason.reason)).length, 1);
  assert.equal(starts.length, 2);
  assert.ok(starts[1].at - starts[0].at >= 25);

  const firstRepository = starts[0].repository;
  await assert.rejects(() => make().request({
    priority: 'final_submission', kind: 'pr_create', operation: 'create', repository: firstRepository,
  }), (error) => error instanceof GitHubPublicLimitError && /one-open-PR/.test(error.reason));
  await governors[0].releaseRepository(firstRepository);
  assert.equal((await governors[0].status()).governor.open_repositories[firstRepository], undefined);
});

test('a live cross-process lease is never stolen merely because one request runs longer than stale recovery', async (t) => {
  const clock = await fixture(t, 'factory-github-live-lease');
  let releaseFirst;
  let signalStarted;
  const firstStarted = new Promise((resolve) => { signalStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const starts = [];
  const common = {
    ...clock,
    mutationSpacingMs: 0,
    leaseStaleMs: 30,
    leaseHeartbeatMs: 10,
  };
  const firstGovernor = createGitHubSafety({
    ...common,
    transport: async () => {
      starts.push('first');
      signalStarted();
      await firstGate;
      return {status: 200};
    },
  });
  const secondGovernor = createGitHubSafety({
    ...common,
    transport: async () => { starts.push('second'); return {status: 200}; },
  });
  const first = firstGovernor.request({priority: 'final_submission', kind: 'read', operation: 'first'});
  await firstStarted;
  await new Promise((resolve) => setTimeout(resolve, 75));
  const second = secondGovernor.request({priority: 'final_submission', kind: 'read', operation: 'second'});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(starts, ['first']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(starts, ['first', 'second']);
  await assert.rejects(() => stat(`${clock.pauseFile}.governor.json.lock`), {code: 'ENOENT'});
});

test('transient network and 5xx failures get one retry, not an unbounded loop', async (t) => {
  const clock = await fixture(t, 'factory-github-retry');
  let networkCalls = 0;
  const network = createGitHubSafety({
    ...clock,
    transport: async () => {
      networkCalls += 1;
      if (networkCalls === 1) throw Object.assign(new Error('socket reset'), {code: 'ECONNRESET'});
      return {status: 200};
    },
  });
  assert.equal((await network.request({priority: 'live_preflight', kind: 'read', operation: 'read'})).status, 200);
  assert.equal(networkCalls, 2);

  let serverCalls = 0;
  const server = createGitHubSafety({
    ...clock,
    transport: async () => ({status: 503, body: {message: `attempt ${++serverCalls}`}}),
  });
  assert.equal((await server.request({priority: 'live_preflight', kind: 'read', operation: 'read'})).status, 503);
  assert.equal(serverCalls, 2);
});

test('platform account restriction pauses transport and cannot be locally resumed', async (t) => {
  const clock = await fixture(t, 'factory-github-restriction');
  const github = createGitHubSafety({
    ...clock,
    transport: async () => ({status: 403, accountRestriction: true, body: {message: 'account restricted'}}),
  });
  await assert.rejects(
    () => github.request({priority: 'maintainer_response', kind: 'read', operation: 'read'}),
    (error) => error instanceof GitHubPausedError && error.pause.kind === 'GITHUB_ACCOUNT_RESTRICTION',
  );
  let probes = 0;
  await assert.rejects(() => resumeGitHub({
    pauseFile: clock.pauseFile,
    reason: 'local override',
    clearedBy: 'operator',
    transport: async () => { probes += 1; return {status: 200}; },
    now: clock.now,
  }), (error) => error instanceof GitHubSafetyError && error.code === 'GITHUB_RESTRICTION_REVIEW');
  assert.equal(probes, 0);
});
