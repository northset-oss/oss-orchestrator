import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {chmod, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';

import {
  acquireGhGatewayLock,
  assertGhNetworkAllowed,
  clearGhGatewayThrottle,
  classifyGhRequest,
  ghRequest,
  GitHubGatewayRefusalError,
  GitHubThrottleError,
  isGhGatewayTerminalError,
  ledgerEvent,
  readGhGatewayControlState,
  withGhGatewayLock,
} from './gh-gateway.mjs';
import {loadResourceControl} from './campaign/phase0/resource-breakers.mjs';

const exec = promisify(execFile);
const GATEWAY_URL = new URL('./gh-gateway.mjs', import.meta.url).href;

async function temporaryGateway(t, name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  t.after(() => rm(root, {recursive: true, force: true}));
  return {
    root,
    stateDir: path.join(root, 'gateway-state'),
    ledgerFile: path.join(root, 'gh-ledger.jsonl'),
    resourceControlFile: path.join(root, 'resource-control.json'),
    controlStateFile: path.join(root, 'control-state.json'),
  };
}

function fastOptions(files, additions = {}) {
  return {
    ...files,
    testMode: true,
    timing: {
      minSpacingMs: 0,
      searchSpacingMs: 0,
      mutationSpacingMs: 0,
      jitterMaxMs: 0,
      lockPollMs: 2,
    },
    ...additions,
  };
}

test('classifyGhRequest separates search, GraphQL, reads, and mutations', () => {
  assert.equal(classifyGhRequest(['search', 'issues', 'bug']), 'search');
  assert.equal(classifyGhRequest(['api', 'search/issues', '-f', 'q=bug']), 'search');
  assert.equal(classifyGhRequest(['api', 'graphql', '-f', 'query=query { viewer { login } }']), 'graphql');
  assert.equal(classifyGhRequest(['pr', 'list', '--limit', '100']), 'rest_read');
  assert.equal(classifyGhRequest(['pr', 'create', '--title', 'title']), 'mutation');
  assert.equal(classifyGhRequest(['api', '--method', 'PATCH', 'repos/o/r']), 'mutation');
  assert.equal(classifyGhRequest(['api', '--method', 'GET', 'repos/o/r/issues', '-f', 'state=open']), 'rest_read');
});

test('gateway serializes concurrent processes, enforces spacing, and ledgers every request', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-process-lock');
  const bin = path.join(files.root, 'bin');
  const gh = path.join(bin, 'gh');
  const eventsFile = path.join(files.root, 'events.jsonl');
  await mkdir(bin);
  await writeFile(gh, `#!/usr/bin/env node
import {appendFile} from 'node:fs/promises';
const event = (kind) => appendFile(process.env.FAKE_GH_EVENTS, JSON.stringify({kind, pid: process.pid, at: Date.now()}) + '\\n');
await event('start');
await new Promise((resolve) => setTimeout(resolve, 20));
await event('end');
process.stdout.write('{"ok":true}\\n');
`);
  await chmod(gh, 0o700);
  const script = `
import {ghRequest} from ${JSON.stringify(GATEWAY_URL)};
const result = await ghRequest(['api', 'rate_limit'], {label: process.env.REQUEST_LABEL});
if (result.code !== 0) process.exit(2);
`;
  const environment = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_GH_EVENTS: eventsFile,
    OSS_GH_GATEWAY_STATE_DIR: files.stateDir,
    OSS_GH_REQUEST_LEDGER: files.ledgerFile,
    OSS_RESOURCE_CONTROL_FILE: files.resourceControlFile,
    OSS_CAMPAIGN_CONTROL_STATE: files.controlStateFile,
    OSS_GH_GATEWAY_TEST_MODE: '1',
    OSS_GH_GATEWAY_TEST_MIN_SPACING_MS: '35',
    OSS_GH_GATEWAY_TEST_SEARCH_SPACING_MS: '35',
    OSS_GH_GATEWAY_TEST_MUTATION_SPACING_MS: '35',
    OSS_GH_GATEWAY_TEST_JITTER_MAX_MS: '0',
    OSS_GH_GATEWAY_TEST_LOCK_POLL_MS: '3',
  };
  await Promise.all([
    exec(process.execPath, ['--input-type=module', '--eval', script], {
      env: {...environment, REQUEST_LABEL: 'process one'},
    }),
    exec(process.execPath, ['--input-type=module', '--eval', script], {
      env: {...environment, REQUEST_LABEL: 'process two'},
    }),
  ]);
  const events = (await readFile(eventsFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 4);
  assert.equal(events[0].kind, 'start');
  assert.equal(events[1].kind, 'end');
  assert.equal(events[2].kind, 'start');
  assert.equal(events[3].kind, 'end');
  assert.notEqual(events[0].pid, events[2].pid);
  assert.ok(events[2].at - events[1].at >= 30,
    `expected at least 30ms between requests, observed ${events[2].at - events[1].at}ms`);
  const ledger = (await readFile(files.ledgerFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(ledger.length, 2);
  assert.deepEqual(new Set(ledger.map((entry) => entry.label)), new Set(['process one', 'process two']));
  for (const entry of ledger) {
    assert.equal(entry.class, 'rest_read');
    assert.equal(entry.request_class, 'rest_read');
    assert.deepEqual(entry.argv_summary, ['api', 'rate_limit']);
    assert.equal(entry.exit_code, 0);
    assert.equal(typeof entry.duration_ms, 'number');
    assert.equal(entry.wave_id, null);
  }
});

test('gateway refuses active persistent breaker and campaign hold before running gh', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-holds');
  let calls = 0;
  const runner = async () => { calls += 1; return {code: 0, stdout: '{}', stderr: ''}; };
  await writeFile(files.resourceControlFile, JSON.stringify({
    schema_version: 1,
    provider_pause: {kind: 'PROVIDER_THROTTLED', provider: 'GitHub', signal: 'HTTP_429', auto_resume: false},
    exception_task_ids: [],
    active_exception: null,
  }));
  await assert.rejects(
    () => ghRequest(['api', 'rate_limit'], fastOptions(files, {runner})),
    (error) => error instanceof GitHubGatewayRefusalError &&
      error.reason === 'persistent-provider-throttle' && isGhGatewayTerminalError(error),
  );
  assert.equal(calls, 0);

  await writeFile(files.resourceControlFile, JSON.stringify({
    schema_version: 1, provider_pause: null, exception_task_ids: [], active_exception: null,
  }));
  await writeFile(files.controlStateFile, JSON.stringify({
    schema_version: 1,
    incidents: [{
      incident_id: 'github-secondary-rate-limit',
      severity: 'SEV_1',
      scope: 'platform',
      event_class: 'platform_warning',
      occurred_at: '2026-07-18T12:14:00Z',
    }],
    closures: [],
    hold_clearances: [],
  }));
  await assert.rejects(
    () => ghRequest(['api', 'rate_limit'], fastOptions(files, {runner})),
    (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'global-campaign-hold',
  );
  assert.equal(calls, 0);
});

test('gateway atomically refuses requests beyond a declared wave budget', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-wave');
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return {code: 0, stdout: '{}', stderr: ''};
  };
  const options = fastOptions(files, {runner, waveId: 'offline-wave', waveBudget: 1});
  assert.equal((await ghRequest(['api', 'rate_limit'], options)).code, 0);
  await assert.rejects(
    () => ghRequest(['api', 'rate_limit'], options),
    (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'wave-budget-exhausted',
  );
  assert.equal(calls, 1);
  const ledger = (await readFile(files.ledgerFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].wave_id, 'offline-wave');
});

test('rate-limit response fields are included in the request ledger', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-rate-fields');
  const stdout = JSON.stringify({resources: {
    core: {limit: 5000, remaining: 4990, reset: 1, used: 10, extra: 'omitted'},
    search: {limit: 30, remaining: 29, reset: 2, used: 1},
    graphql: {limit: 5000, remaining: 4998, reset: 3, used: 2},
    code_search: {limit: 10, remaining: 10, reset: 4, used: 0},
  }});
  await ghRequest(['api', 'rate_limit'], fastOptions(files, {
    runner: async () => ({code: 0, stdout, stderr: ''}),
  }));
  const ledger = JSON.parse((await readFile(files.ledgerFile, 'utf8')).trim());
  assert.deepEqual(ledger.rate_limit, {resources: {
    core: {limit: 5000, remaining: 4990, reset: 1, used: 10},
    search: {limit: 30, remaining: 29, reset: 2, used: 1},
    graphql: {limit: 5000, remaining: 4998, reset: 3, used: 2},
  }});
});

test('secondary-limit output trips the durable breaker and throws without retry', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-throttle');
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return {
      code: 1,
      stdout: '',
      stderr: JSON.stringify({
        documentation_url: 'https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits',
        message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
      }),
    };
  };
  await assert.rejects(
    () => ghRequest(['search', 'issues', 'bug'], fastOptions(files, {
      runner,
      label: 'throttled search',
      waveId: 'throttle-regression',
      waveBudget: 1,
    })),
    (error) => error instanceof GitHubThrottleError &&
      error.signal === 'GITHUB_SECONDARY_RATE_LIMIT' && isGhGatewayTerminalError(error),
  );
  assert.equal(calls, 1);
  const control = await loadResourceControl(files.resourceControlFile);
  assert.deepEqual(control.provider_pause, {
    kind: 'PROVIDER_THROTTLED',
    provider: 'GitHub',
    signal: 'GITHUB_SECONDARY_RATE_LIMIT',
    tripped_at: control.provider_pause.tripped_at,
    auto_resume: false,
  });
  await assert.rejects(
    () => ghRequest(['api', 'rate_limit'], fastOptions(files, {runner})),
    (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'gateway-provider-throttle',
  );
  assert.equal(calls, 1);
  const ledger = JSON.parse((await readFile(files.ledgerFile, 'utf8')).trim());
  assert.equal(ledger.throttle_detected, true);
  assert.equal(ledger.exit_code, 1);
});

test('gateway latch stays fail-closed when the phase-0 breaker cannot be written', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-latch-fallback');
  let calls = 0;
  const runner = async () => {
    calls += 1;
    await mkdir(files.resourceControlFile);
    return {code: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests'};
  };
  await assert.rejects(
    () => ghRequest(['api', 'rate_limit'], fastOptions(files, {runner})),
    (error) => error instanceof GitHubThrottleError,
  );
  await assert.rejects(
    () => ghRequest(['api', 'rate_limit'], fastOptions(files, {runner})),
    (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'gateway-provider-throttle',
  );
  assert.equal(calls, 1);
  const clearance = await clearGhGatewayThrottle({
    stateDir: files.stateDir,
    founderDecisionId: 'founder-latch-clearance-1',
    testMode: true,
    timing: {lockPollMs: 1},
  });
  assert.equal(clearance.founder_decision_id, 'founder-latch-clearance-1');
});

test('ordinary permission 403 is returned without tripping the throttle breaker', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-permission');
  const result = await ghRequest(['api', 'repos/o/r'], fastOptions(files, {
    runner: async () => ({code: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by integration'}),
  }));
  assert.equal(result.code, 1);
  assert.equal((await loadResourceControl(files.resourceControlFile)).provider_pause, null);
});

test('successful GitHub payload content cannot masquerade as a provider throttle', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-user-content');
  const result = await ghRequest(['api', '--method', 'GET', 'search/issues'], fastOptions(files, {
    requestClass: 'search',
    waveId: 'content-regression',
    waveBudget: 1,
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        total_count: 1,
        incomplete_results: false,
        items: [{number: 429, title: 'Document Retry-After and secondary rate limit behavior', body: 'Issue 403 discusses abuse detection.'}],
      }),
      stderr: '',
    }),
  }));
  assert.equal(result.code, 0);
  assert.equal((await loadResourceControl(files.resourceControlFile)).provider_pause, null);
});

test('exit-zero GraphQL RATE_LIMITED errors latch, trip the breaker, and throw', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-graphql-rate-limited');
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return {
      code: 0,
      stdout: JSON.stringify({data: null, errors: [{type: 'RATE_LIMITED'}]}),
      stderr: '',
    };
  };
  await assert.rejects(
    () => ghRequest(['api', 'graphql', '-f', 'query=query { viewer { login } }'],
      fastOptions(files, {runner})),
    (error) => error instanceof GitHubThrottleError &&
      error.code === 'GITHUB_PROVIDER_THROTTLED',
  );
  assert.equal(calls, 1);
  assert.equal((await loadResourceControl(files.resourceControlFile)).provider_pause?.kind,
    'PROVIDER_THROTTLED');
  assert.equal((await readGhGatewayControlState(fastOptions(files))).provider_pause?.kind,
    'PROVIDER_THROTTLED');
  await assert.rejects(
    () => ghRequest(['api', 'rate_limit'], fastOptions(files, {runner})),
    (error) => error instanceof GitHubGatewayRefusalError &&
      error.reason === 'gateway-provider-throttle',
  );
  assert.equal(calls, 1);
});

test('GraphQL throttle codes tolerate underscore, hyphen, space, and extensions forms', async (t) => {
  for (const [index, errorRecord] of [
    {code: 'rate_limited'},
    {type: 'RATE-LIMITED'},
    {extensions: {code: 'rate limited'}},
  ].entries()) {
    const files = await temporaryGateway(t, `gh-gateway-graphql-code-${index}`);
    await assert.rejects(
      () => ghRequest(['api', 'graphql'], fastOptions(files, {
        runner: async () => ({
          code: 0,
          stdout: JSON.stringify({errors: [errorRecord]}),
          stderr: '',
        }),
      })),
      (error) => error instanceof GitHubThrottleError,
    );
  }
});

test('wave budgets are immutable and budget-less uses count against the declaration', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-immutable-wave');
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return {code: 0, stdout: '{}', stderr: ''};
  };
  await ghRequest(['api', 'rate_limit'], fastOptions(files, {
    runner, waveId: 'immutable-wave', waveBudget: 2,
  }));
  await assert.rejects(
    () => ghRequest(['api', 'rate_limit'], fastOptions(files, {
      runner, waveId: 'immutable-wave', waveBudget: 3,
    })),
    (error) => error instanceof GitHubGatewayRefusalError &&
      error.reason === 'wave-budget-mismatch',
  );
  await ghRequest(['api', 'rate_limit'], fastOptions(files, {
    runner, waveId: 'immutable-wave',
  }));
  await assert.rejects(
    () => ghRequest(['api', 'rate_limit'], fastOptions(files, {
      runner, waveId: 'immutable-wave',
    })),
    (error) => error instanceof GitHubGatewayRefusalError &&
      error.reason === 'wave-budget-exhausted',
  );
  assert.equal(calls, 2);
  assert.deepEqual((await readGhGatewayControlState(fastOptions(files))).waves['immutable-wave'], {
    declared_budget: 2,
    used: 2,
  });
});

test('search requests require a named wave with a declared budget', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-search-wave');
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return {code: 0, stdout: '{}', stderr: ''};
  };
  await assert.rejects(
    () => ghRequest(['search', 'issues', 'bug'], fastOptions(files, {runner})),
    (error) => error instanceof GitHubGatewayRefusalError &&
      error.reason === 'search-wave-required',
  );
  await assert.rejects(
    () => ghRequest(['search', 'issues', 'bug'], fastOptions(files, {
      runner, waveId: 'budgetless-search',
    })),
    (error) => error instanceof GitHubGatewayRefusalError &&
      error.reason === 'search-wave-budget-required',
  );
  assert.equal(calls, 0);
});

test('ledger argv summary redacts inline bodies, raw fields, and credential URLs', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-redaction');
  const secrets = [
    'private-pr-body',
    'raw-token-value',
    'url-access-token',
    'url-client-secret',
    'url-client-id',
  ];
  await ghRequest([
    'api', 'repos/o/r/pulls',
    `--body=${secrets[0]}`,
    `--raw-field=token=${secrets[1]}`,
    `https://api.github.com/repos/o/r?access_token=${secrets[2]}&client_secret=${secrets[3]}&client_id=${secrets[4]}`,
  ], fastOptions(files, {
    runner: async () => ({code: 0, stdout: '{}', stderr: ''}),
  }));
  const line = await readFile(files.ledgerFile, 'utf8');
  for (const secret of secrets) assert.equal(line.includes(secret), false, `leaked ${secret}`);
  const entry = JSON.parse(line);
  assert.ok(entry.argv_summary.includes('--body=<redacted>'));
  assert.ok(entry.argv_summary.includes('--raw-field=token=<redacted>'));
  assert.match(entry.argv_summary.at(-1), /access_token=<redacted>/);
});

test('identity mismatch reclaims only a stale lock, records it, and resets pacing state', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-lock-reclaim');
  await mkdir(files.stateDir, {recursive: true});
  const lockFile = path.join(files.stateDir, 'gateway.lock');
  await writeFile(lockFile, `${JSON.stringify({
    pid: process.pid,
    process_start_identity: 'ps:old-process-start',
    lock_nonce: 'old-lock',
  })}\n`);
  const stale = new Date(Date.now() - 10_000);
  await utimes(lockFile, stale, stale);
  const before = Date.now();
  const options = fastOptions(files, {
    timing: {
      minSpacingMs: 0,
      searchSpacingMs: 0,
      mutationSpacingMs: 0,
      jitterMaxMs: 0,
      lockPollMs: 2,
      staleLockMs: 5,
      lockHeartbeatMs: 10_000,
    },
    processIdentity: async () => 'ps:current-process-start',
  });
  const release = await acquireGhGatewayLock(options);
  const snapshot = await readGhGatewayControlState({...options, gatewayLockHeld: true});
  assert.ok(snapshot.last_request_at_ms >= before);
  const ledger = (await readFile(files.ledgerFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].event, 'lock_reclaimed');
  assert.equal(ledger[0].reclaim_reason, 'process-identity-mismatch');
  await release();
});

test('a stale-looking live holder with matching identity is never reclaimed', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-live-lock');
  const identity = 'ps:matching-live-process';
  const heldOptions = fastOptions(files, {
    timing: {
      minSpacingMs: 0,
      searchSpacingMs: 0,
      mutationSpacingMs: 0,
      jitterMaxMs: 0,
      lockPollMs: 2,
      lockTimeoutMs: 25,
      staleLockMs: 1,
      lockHeartbeatMs: 10_000,
    },
    processIdentity: async () => identity,
  });
  const release = await acquireGhGatewayLock(heldOptions);
  const lockFile = path.join(files.stateDir, 'gateway.lock');
  const stale = new Date(Date.now() - 10_000);
  await utimes(lockFile, stale, stale);
  await assert.rejects(
    () => acquireGhGatewayLock(heldOptions),
    (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'lock-timeout',
  );
  assert.equal(JSON.parse(await readFile(lockFile, 'utf8')).process_start_identity, identity);
  await release();
});

test('a held gateway lock heartbeats its mtime', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-lock-heartbeat');
  const options = fastOptions(files, {
    timing: {
      minSpacingMs: 0,
      searchSpacingMs: 0,
      mutationSpacingMs: 0,
      jitterMaxMs: 0,
      lockPollMs: 2,
      lockHeartbeatMs: 5,
    },
    processIdentity: async () => 'ps:heartbeat-holder',
  });
  const release = await acquireGhGatewayLock(options);
  const lockFile = path.join(files.stateDir, 'gateway.lock');
  const beforeMtime = (await stat(lockFile)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 25));
  const afterMtime = (await stat(lockFile)).mtimeMs;
  assert.ok(afterMtime > beforeMtime, `${afterMtime} did not advance beyond ${beforeMtime}`);
  await release();
});

test('network assertion and generic ledger events honor injected offline paths', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-exported-helpers');
  await withGhGatewayLock(fastOptions(files), async () => {
    assert.equal(await assertGhNetworkAllowed({...fastOptions(files), gatewayLockHeld: true}), true);
    await ledgerEvent({class: 'git_push', repo_target: 'owner/repo'}, {
      ...fastOptions(files), gatewayLockHeld: true,
    });
  });
  const entry = JSON.parse((await readFile(files.ledgerFile, 'utf8')).trim());
  assert.equal(entry.class, 'git_push');
  assert.equal(entry.repo_target, 'owner/repo');
});

test('runner receives the hard 120 second default timeout and ceiling', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-default-timeout');
  let observedTimeout = null;
  await ghRequest(['api', 'rate_limit'], fastOptions(files, {
    runner: async (_argv, options) => {
      observedTimeout = options.timeoutMs;
      return {code: 0, stdout: '{}', stderr: ''};
    },
  }));
  assert.equal(observedTimeout, 120_000);
  await ghRequest(['api', 'rate_limit'], fastOptions(files, {
    timeoutMs: 900_000,
    runner: async (_argv, options) => {
      observedTimeout = options.timeoutMs;
      return {code: 0, stdout: '{}', stderr: ''};
    },
  }));
  assert.equal(observedTimeout, 120_000);
});

test('default runner hard-stops a timed-out gh child', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-timeout-escalation');
  const bin = path.join(files.root, 'bin');
  const gh = path.join(bin, 'gh');
  await mkdir(bin);
  await writeFile(gh, `#!/bin/sh
trap '' TERM
exec /bin/sleep 10
`);
  await chmod(gh, 0o700);
  const result = await ghRequest(['api', 'rate_limit'], fastOptions(files, {
    env: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`},
    timeoutMs: 100,
    timing: {
      minSpacingMs: 0,
      searchSpacingMs: 0,
      mutationSpacingMs: 0,
      jitterMaxMs: 0,
      lockPollMs: 2,
      requestKillGraceMs: 20,
    },
  }));
  assert.equal(result.timedOut, true);
  assert.equal(result.code, 124);
  assert.ok(['SIGTERM', 'SIGKILL'].includes(result.signal));
});
