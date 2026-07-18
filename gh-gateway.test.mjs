import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {chmod, copyFile, mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile} from 'node:fs/promises';
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
  readGhDailyBudgetState,
  readGhGatewayControlState,
  withGhGatewayLock,
} from './gh-gateway.mjs';
import {loadResourceControl} from './campaign/phase0/resource-breakers.mjs';
import {runControlsCli} from './campaign/phase1/controls-cli.mjs';

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

function digestRecord(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function testPathDigest(value) {
  const normalized = path.normalize(realpathSync.native(path.resolve(value))).normalize('NFC');
  const identity = ['darwin', 'win32'].includes(process.platform)
    ? normalized.toLocaleLowerCase('en-US') : normalized;
  return createHash('sha256').update(identity).digest('hex');
}

function testPeerDigests(files) {
  return {
    resource_control: testPathDigest(files.resourceControlFile),
    control_state: testPathDigest(files.controlStateFile),
    ledger: testPathDigest(files.ledgerFile),
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
  assert.equal(classifyGhRequest(['api', 'graphql', '-f', 'query=mutation Close { closeIssue(input:{}) { clientMutationId } }']), 'mutation');
  assert.equal(classifyGhRequest(['api', 'graphql', '--raw-field=query=query Find { search(query:"x", type:ISSUE) { issueCount } }']), 'search');
  assert.equal(classifyGhRequest(['api', 'graphql', '-Fquery=query { viewer { login } }']), 'graphql');
});

test('gateway refuses multi-request pagination flags and page bounds above 100 before running gh', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-page-bounds');
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return {code: 0, stdout: '[]', stderr: ''};
  };
  for (const argv of [
    ['api', 'repos/o/r/issues?per_page=100', '--paginate'],
    ['api', 'repos/o/r/issues', '--slurp'],
  ]) {
    await assert.rejects(() => ghRequest(argv, fastOptions(files, {runner})),
      (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'pagination-bypass');
  }
  for (const argv of [
    ['pr', 'list', '--limit', '500'],
    ['pr', 'list', '-L500'],
    ['pr', 'list', '-L=500'],
    ['api', 'repos/o/r/issues?per_page=101'],
    ['api', 'repos/o/r/issues', '--page-size=101'],
  ]) {
    await assert.rejects(() => ghRequest(argv, fastOptions(files, {runner})),
      (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'page-bound-exceeded');
  }
  for (const argv of [
    ['pr', 'list', '--limit'],
    ['pr', 'list', '--limit=lots'],
    ['pr', 'list', '-L'],
    ['pr', 'list', '-Llots'],
    ['api', 'repos/o/r/issues', '--page-size='],
    ['api', 'repos/o/r/issues?per_page=NaN'],
  ]) {
    await assert.rejects(() => ghRequest(argv, fastOptions(files, {runner})),
      (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'invalid-page-bound');
  }
  assert.equal(calls, 0);
  assert.equal((await ghRequest(['api', 'repos/o/r/issues?per_page=100'], fastOptions(files, {runner}))).code, 0);
  assert.equal(calls, 1);
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
    OSS_GH_CANONICAL_ROOT: files.root,
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
    assert.match(entry.state_dir_digest, /^[0-9a-f]{8}$/);
  }
});

test('environment test mode refuses production state but remains allowed under a temporary canonical root', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-env-test-mode');
  const refusalOptions = {
    ledgerFile: files.ledgerFile,
    resourceControlFile: files.resourceControlFile,
    controlStateFile: files.controlStateFile,
    env: {...process.env, OSS_GH_GATEWAY_TEST_MODE: '1'},
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      () => readGhDailyBudgetState(refusalOptions),
      (error) => error instanceof GitHubGatewayRefusalError &&
        error.reason === 'env-test-mode-production-path-identity',
    );
  }
  await assert.rejects(() => readFile(files.ledgerFile), {code: 'ENOENT'});

  const allowedRoot = path.join(files.root, 'allowed');
  const allowed = await readGhDailyBudgetState({env: {
    ...process.env,
    OSS_GH_CANONICAL_ROOT: allowedRoot,
    OSS_GH_GATEWAY_TEST_MODE: '1',
    OSS_GH_GATEWAY_STATE_DIR: path.join(allowedRoot, 'gateway'),
    OSS_GH_REQUEST_LEDGER: path.join(allowedRoot, 'ledger.jsonl'),
    OSS_RESOURCE_CONTROL_FILE: path.join(allowedRoot, 'phase0', 'resource.json'),
    OSS_CAMPAIGN_CONTROL_STATE: path.join(allowedRoot, 'phase1', 'controls.json'),
  }});
  assert.equal(allowed.daily_cap, 2_000);
});

test('environment test mode treats blank paths as unset and refuses mixed or real-identity production paths without writes', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-env-test-identity');
  const isolatedEnv = {
    ...process.env,
    OSS_GH_CANONICAL_ROOT: files.root,
    OSS_GH_GATEWAY_TEST_MODE: '1',
    OSS_GH_GATEWAY_STATE_DIR: files.stateDir,
    OSS_GH_REQUEST_LEDGER: files.ledgerFile,
    OSS_RESOURCE_CONTROL_FILE: files.resourceControlFile,
    OSS_CAMPAIGN_CONTROL_STATE: files.controlStateFile,
  };
  const refusesProductionIdentity = (error) => error instanceof GitHubGatewayRefusalError &&
    error.reason === 'env-test-mode-production-path-identity';

  await assert.rejects(() => readGhDailyBudgetState({env: {
    ...isolatedEnv,
    OSS_GH_GATEWAY_STATE_DIR: '   ',
    OSS_GH_REQUEST_LEDGER: '',
    OSS_RESOURCE_CONTROL_FILE: '\t',
    OSS_CAMPAIGN_CONTROL_STATE: '\n',
  }}), refusesProductionIdentity);

  await assert.rejects(() => readGhDailyBudgetState({env: {
    ...isolatedEnv,
    OSS_GH_REQUEST_LEDGER: ' ',
  }}), refusesProductionIdentity);

  const productionAlias = path.join(files.root, 'production-runs-alias');
  await symlink(path.join(process.cwd(), 'runs'), productionAlias);
  await assert.rejects(() => readGhDailyBudgetState({env: {
    ...isolatedEnv,
    OSS_GH_GATEWAY_STATE_DIR: productionAlias,
  }}), refusesProductionIdentity);

  if (process.platform === 'darwin') {
    await assert.rejects(() => readGhDailyBudgetState({env: {
      ...isolatedEnv,
      OSS_GH_GATEWAY_STATE_DIR: path.join(process.cwd().toUpperCase(), 'RUNS', 'GH-GATEWAY-STATE'),
    }}), refusesProductionIdentity);
  }

  for (const file of [files.ledgerFile, files.resourceControlFile, files.controlStateFile]) {
    await assert.rejects(() => readFile(file), {code: 'ENOENT'});
  }
  await assert.rejects(() => stat(files.stateDir), {code: 'ENOENT'});
});

test('environment-derived state paths refuse canonical-root divergence while option paths stay exempt', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-env-root-divergence');
  const canonicalRoot = path.join(files.root, 'canonical');
  await assert.rejects(() => readGhDailyBudgetState({
    ledgerFile: files.ledgerFile,
    resourceControlFile: files.resourceControlFile,
    controlStateFile: files.controlStateFile,
    env: {
      ...process.env,
      OSS_GH_CANONICAL_ROOT: canonicalRoot,
      OSS_GH_GATEWAY_STATE_DIR: path.join(files.root, 'outside', 'gateway'),
    },
  }), (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'env-path-root-divergence');
  await assert.rejects(() => readFile(files.ledgerFile), {code: 'ENOENT'});

  const exempt = await readGhDailyBudgetState({
    stateDir: path.join(files.root, 'option-state'),
    ledgerFile: files.ledgerFile,
    resourceControlFile: files.resourceControlFile,
    controlStateFile: files.controlStateFile,
    env: {...process.env, OSS_GH_CANONICAL_ROOT: canonicalRoot},
  });
  assert.equal(exempt.daily_cap, 2_000);
});

test('one environment-derived path makes every non-option peer share its canonical root', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-env-root-partial');
  const canonicalRoot = path.join(files.root, 'canonical');
  const ledgerFile = path.join(canonicalRoot, 'ledger.jsonl');
  await assert.rejects(() => readGhDailyBudgetState({
    ledgerFile,
    env: {
      ...process.env,
      OSS_GH_CANONICAL_ROOT: canonicalRoot,
      OSS_GH_GATEWAY_STATE_DIR: path.join(canonicalRoot, 'gateway'),
    },
  }), (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'env-path-root-divergence');
  await assert.rejects(() => readFile(ledgerFile), {code: 'ENOENT'});
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
    incident_id: control.provider_pause.incident_id,
    auto_resume: false,
  });
  const campaign = JSON.parse(await readFile(files.controlStateFile, 'utf8'));
  assert.equal(campaign.incidents.length, 1);
  assert.deepEqual(campaign.incidents[0], {
    incident_id: `github-secondary-rate-limit-${control.provider_pause.tripped_at
      .replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`,
    severity: 'SEV_1',
    scope: 'platform',
    event_class: 'platform_warning',
    incident_class: 'provider_rate_limit',
    provider: 'GitHub',
    signal: 'GITHUB_SECONDARY_RATE_LIMIT',
    tripped_at: control.provider_pause.tripped_at,
    occurred_at: control.provider_pause.tripped_at,
    disposition: 'global_pipeline_hold_pending_founder_review_no_auto_resume',
    evidence_file: files.ledgerFile,
    repository: null,
  });
  assert.equal(control.provider_pause.incident_id, campaign.incidents[0].incident_id);
  assert.equal((await readGhGatewayControlState(fastOptions(files))).pending_incident, null);
  await assert.rejects(
    () => ghRequest(['api', 'rate_limit'], fastOptions(files, {runner})),
    (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'gateway-provider-throttle',
  );
  assert.equal(calls, 1);
  const ledger = JSON.parse((await readFile(files.ledgerFile, 'utf8')).trim());
  assert.equal(ledger.throttle_detected, true);
  assert.equal(ledger.exit_code, 1);
});

test('campaign incident write failure persists a marker that snapshot reconciles before clear-hold', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-incident-fallback');
  await assert.rejects(
    () => ghRequest(['api', 'repos/o/r'], fastOptions(files, {
      runner: async () => {
        await mkdir(files.controlStateFile);
        return {code: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests'};
      },
    })),
    (error) => error instanceof GitHubThrottleError &&
      error.cause?.code === 'EISDIR' && error.signal === 'HTTP_429',
  );
  assert.equal((await loadResourceControl(files.resourceControlFile)).provider_pause?.signal, 'HTTP_429');
  const interrupted = JSON.parse(await readFile(path.join(files.stateDir, 'state.json'), 'utf8'));
  assert.equal(interrupted.provider_pause?.signal, 'HTTP_429');
  assert.equal(interrupted.pending_incident?.incident_id, interrupted.provider_pause.incident_id);
  await rm(files.controlStateFile, {recursive: true, force: true});
  const common = [
    '--controls-state', files.controlStateFile,
    '--resource-control', files.resourceControlFile,
    '--gateway-state', files.stateDir,
    '--ledger', files.ledgerFile,
  ];
  const sink = {write() {}};
  const snapshot = await runControlsCli(['snapshot', ...common], {stdout: sink});
  assert.equal(snapshot.global_publication_hold.active, true);
  assert.equal((await readGhGatewayControlState(fastOptions(files))).pending_incident, null);
  await runControlsCli([
    'clear-hold', ...common,
    '--hold-id', `incident:${interrupted.provider_pause.incident_id}`,
    '--founder-decision-id', 'founder-reconcile-clear-1',
  ], {stdout: sink, now: () => new Date('2026-07-18T15:00:00.000Z')});
  assert.equal((await loadResourceControl(files.resourceControlFile)).provider_pause, null);
  assert.equal((await readGhGatewayControlState(fastOptions(files))).provider_pause, null);
});

test('pending incident reconciliation refuses wrong peer paths without touching them', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-pending-peer-binding');
  await assert.rejects(() => ghRequest(['api', 'repos/o/r'], fastOptions(files, {
    runner: async () => {
      await mkdir(files.controlStateFile);
      return {code: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests'};
    },
  })), (error) => error instanceof GitHubThrottleError);
  const before = await readFile(path.join(files.stateDir, 'state.json'), 'utf8');
  const wrong = {
    resourceControlFile: path.join(files.root, 'wrong', 'resource.json'),
    controlStateFile: path.join(files.root, 'wrong', 'controls.json'),
    ledgerFile: path.join(files.root, 'wrong', 'ledger.jsonl'),
  };
  await assert.rejects(
    () => withGhGatewayLock(fastOptions(files, wrong), async () => {}),
    (error) => error instanceof GitHubGatewayRefusalError &&
      error.reason === 'pending-incident-peer-path-mismatch',
  );
  assert.equal(await readFile(path.join(files.stateDir, 'state.json'), 'utf8'), before);
  for (const file of Object.values(wrong)) await assert.rejects(() => stat(file), {code: 'ENOENT'});
});

test('same-ID campaign conflicting replay is treated as already reconciled and clears the marker', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-conflicting-replay');
  const trippedAt = '2026-07-18T12:00:00.000Z';
  const incidentId = 'github-http-429-20260718T120000Z';
  const conflictingCampaign = `${JSON.stringify({
    schema_version: 1,
    incidents: [{
      incident_id: incidentId,
      severity: 'SEV_1',
      scope: 'platform',
      event_class: 'platform_warning',
      occurred_at: trippedAt,
      disposition: 'preexisting_campaign_incident_with_different_fields',
    }],
    closures: [],
    hold_clearances: [],
  })}\n`;
  const options = fastOptions(files, {
    now: () => Date.parse(trippedAt),
    runner: async () => {
      await writeFile(files.controlStateFile, conflictingCampaign);
      return {code: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests'};
    },
  });
  await assert.rejects(() => ghRequest(['api', 'repos/o/r'], options),
    (error) => error instanceof GitHubThrottleError && error.incident_id === incidentId);
  assert.equal((await readGhGatewayControlState(options)).pending_incident, null);
  const reconciliation = (await readFile(files.ledgerFile, 'utf8')).trim().split('\n').map(JSON.parse)
    .find((entry) => entry.event === 'pending_incident_reconciled');
  assert.equal(reconciliation.outcome, 'already_reconciled_conflicting_replay');
});

test('repair-throttle-state refuses a semantically valid pending marker', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-valid-pending-repair-refusal');
  await assert.rejects(() => ghRequest(['api', 'repos/o/r'], fastOptions(files, {
    runner: async () => {
      await mkdir(files.controlStateFile);
      return {code: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests'};
    },
  })), (error) => error instanceof GitHubThrottleError);
  const stateFile = path.join(files.stateDir, 'state.json');
  const before = await readFile(stateFile, 'utf8');
  const state = JSON.parse(before);
  await assert.rejects(() => runControlsCli([
    'repair-throttle-state',
    '--controls-state', files.controlStateFile,
    '--resource-control', files.resourceControlFile,
    '--gateway-state', files.stateDir,
    '--ledger', files.ledgerFile,
    '--founder-decision-id', 'founder-valid-marker-refused-1',
    '--expected-incident-id', state.pending_incident.incident_id,
    '--expected-marker-digest', digestRecord(state.pending_incident),
  ], {stdout: {write() {}}}),
  (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'valid-pending-incident');
  assert.equal(await readFile(stateFile, 'utf8'), before);
});

test('repair-throttle-state clears only a digest-bound invalid marker with an embedded founder audit', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-pending-repair');
  await assert.rejects(() => ghRequest(['api', 'repos/o/r'], fastOptions(files, {
    runner: async () => {
      await mkdir(files.controlStateFile);
      return {code: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests'};
    },
  })), (error) => error instanceof GitHubThrottleError);
  const stateFile = path.join(files.stateDir, 'state.json');
  const damaged = JSON.parse(await readFile(stateFile, 'utf8'));
  await rm(files.controlStateFile, {recursive: true, force: true});
  const {peer_path_identities: _peerPaths, ...campaignIncident} = damaged.pending_incident;
  await writeFile(files.controlStateFile, `${JSON.stringify({
    schema_version: 1,
    incidents: [{...campaignIncident, repository: null}],
    closures: [],
    hold_clearances: [],
  }, null, 2)}\n`);
  damaged.pending_incident.incident_class = 'authorization';
  await writeFile(stateFile, `${JSON.stringify(damaged, null, 2)}\n`);
  await assert.rejects(
    () => withGhGatewayLock(fastOptions(files), async () => {}),
    (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'invalid-pending-incident',
  );
  const sink = {write() {}};
  const repair = await runControlsCli([
    'repair-throttle-state',
    '--controls-state', files.controlStateFile,
    '--resource-control', files.resourceControlFile,
    '--gateway-state', files.stateDir,
    '--ledger', files.ledgerFile,
    '--founder-decision-id', 'founder-pending-repair-1',
    '--expected-incident-id', damaged.pending_incident.incident_id,
    '--expected-marker-digest', digestRecord(damaged.pending_incident),
  ], {stdout: sink});
  assert.equal(repair.repaired, true);
  const repaired = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(repaired.pending_incident, null);
  assert.equal(repaired.provider_pause.signal, 'HTTP_429');
  assert.equal(repaired.throttle_state_repairs.at(-1).founder_decision_id, 'founder-pending-repair-1');
  assert.equal(await withGhGatewayLock(fastOptions(files), async () => true), true);
  await assert.rejects(() => runControlsCli([
    'repair-throttle-state',
    '--controls-state', files.controlStateFile,
    '--resource-control', files.resourceControlFile,
    '--gateway-state', files.stateDir,
    '--ledger', files.ledgerFile,
    '--founder-decision-id', 'founder-pending-repair-1',
    '--expected-incident-id', damaged.pending_incident.incident_id,
    '--expected-marker-digest', digestRecord(damaged.pending_incident),
  ], {stdout: sink}),
  (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'founder-decision-reused');
});

test('repair-throttle-state verifies relocated peers, atomically re-pins them, and restores normal reads', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-peer-relocation-repair');
  await assert.rejects(() => ghRequest(['api', 'repos/o/r'], fastOptions(files, {
    runner: async () => ({code: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests'}),
  })), (error) => error instanceof GitHubThrottleError);
  const before = await readGhGatewayControlState(fastOptions(files));
  const relocated = {
    ...files,
    resourceControlFile: path.join(files.root, 'relocated-resource-control.json'),
    controlStateFile: path.join(files.root, 'relocated-control-state.json'),
    ledgerFile: path.join(files.root, 'relocated-gh-ledger.jsonl'),
  };
  await Promise.all([
    copyFile(files.resourceControlFile, relocated.resourceControlFile),
    copyFile(files.controlStateFile, relocated.controlStateFile),
    copyFile(files.ledgerFile, relocated.ledgerFile),
  ]);
  const campaign = JSON.parse(await readFile(relocated.controlStateFile, 'utf8'));
  const incident = campaign.incidents[0];
  const {repository: _repository, ...markerIncident} = incident;
  const markerDigest = digestRecord({...markerIncident, peer_path_identities: before.peer_path_identities});
  const newPeerDigests = testPeerDigests(relocated);
  const repair = await runControlsCli([
    'repair-throttle-state',
    '--controls-state', relocated.controlStateFile,
    '--resource-control', relocated.resourceControlFile,
    '--gateway-state', files.stateDir,
    '--ledger', relocated.ledgerFile,
    '--founder-decision-id', 'founder-peer-relocation-1',
    '--expected-incident-id', incident.incident_id,
    '--expected-marker-digest', markerDigest,
    '--expected-old-peer-digests', JSON.stringify(before.peer_path_identities),
    '--expected-new-peer-digests', JSON.stringify(newPeerDigests),
  ], {stdout: {write() {}}});
  assert.equal(repair.repaired, true);
  assert.equal(repair.audit_record.reason, 'repin_peer_paths');
  const after = await readGhGatewayControlState(fastOptions(relocated));
  assert.deepEqual(after.peer_path_identities, newPeerDigests);
  assert.equal(after.provider_pause.incident_id, incident.incident_id);
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
    /EISDIR|pending incident/i,
  );
  assert.equal(calls, 1);
  await rm(files.resourceControlFile, {recursive: true, force: true});
  await withGhGatewayLock(fastOptions(files), async () => {});
  const clearance = await clearGhGatewayThrottle({
    stateDir: files.stateDir,
    ledgerFile: files.ledgerFile,
    resourceControlFile: files.resourceControlFile,
    controlStateFile: files.controlStateFile,
    founderDecisionId: 'founder-latch-clearance-1',
    clearedHoldId: 'incident:gateway-latch-fallback',
    testMode: true,
    timing: {lockPollMs: 1},
  });
  assert.equal(clearance.founder_decision_id, 'founder-latch-clearance-1');
});

test('gateway atomically replaces a cleared latch with an exact one-shot resume probe gate', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-resume-probe');
  await mkdir(files.stateDir, {recursive: true});
  await writeFile(path.join(files.stateDir, 'state.json'), JSON.stringify({
    schema_version: 1,
    last_request_at_ms: null,
    last_completed_at_ms: null,
    last_class: null,
    provider_pause: {
      kind: 'PROVIDER_THROTTLED', provider: 'GitHub', signal: 'HTTP_429',
      tripped_at: '2026-07-18T12:00:00.000Z', auto_resume: false,
    },
    provider_pause_clearances: [],
    waves: {},
  }));
  await clearGhGatewayThrottle({
    stateDir: files.stateDir,
    founderDecisionId: 'founder-resume-probe-1',
    clearedHoldId: 'incident:github-http-429-20260718T120000Z',
    at: '2026-07-18T13:00:00.000Z',
    testMode: true,
    timing: {lockPollMs: 1},
  });
  const gated = await readGhGatewayControlState(fastOptions(files));
  assert.equal(gated.provider_pause, null);
  assert.deepEqual(gated.probe_required, {
    set_at: '2026-07-18T13:00:00.000Z',
    cleared_hold_id: 'incident:github-http-429-20260718T120000Z',
  });
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return {code: 0, stdout: '{"resources":{"core":{"remaining":5000}}}', stderr: ''};
  };
  await assert.rejects(
    () => ghRequest(['api', 'repos/o/r'], fastOptions(files, {runner})),
    (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'resume-probe-required',
  );
  await assert.rejects(
    () => ghRequest(['api', 'repos/o/r'], fastOptions(files, {runner, resumeProbe: true})),
    (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'invalid-resume-probe',
  );
  assert.equal(calls, 0);
  assert.equal((await ghRequest(['api', 'rate_limit'], fastOptions(files, {
    runner, requestClass: 'rest_read', resumeProbe: true,
  }))).code, 0);
  assert.equal(calls, 1);
  assert.equal((await readGhGatewayControlState(fastOptions(files))).probe_required, null);
});

test('resume probe keeps the gate on empty, malformed, or non-durable evidence', async (t) => {
  for (const [name, stdout, ledgerDirectory, reason] of [
    ['empty', '', false, 'invalid-resume-probe-evidence'],
    ['malformed', '{not-json', false, 'invalid-resume-probe-evidence'],
    ['wrong-shape', '{"resources":{"core":{"remaining":"many"}}}', false, 'invalid-resume-probe-evidence'],
    ['ledger-failure', '{"resources":{"core":{"remaining":5000}}}', true, 'ledger-write-error'],
  ]) {
    await t.test(name, async (t) => {
      const files = await temporaryGateway(t, `gh-gateway-probe-evidence-${name}`);
      await mkdir(files.stateDir, {recursive: true});
      await writeFile(path.join(files.stateDir, 'state.json'), JSON.stringify({
        schema_version: 1,
        last_request_at_ms: null,
        last_completed_at_ms: null,
        last_class: null,
        provider_pause: {
          kind: 'PROVIDER_THROTTLED', provider: 'GitHub', signal: 'HTTP_429',
          tripped_at: '2026-07-18T12:00:00.000Z', auto_resume: false,
        },
        provider_pause_clearances: [],
        waves: {},
      }));
      await clearGhGatewayThrottle({
        ...fastOptions(files),
        founderDecisionId: `founder-probe-evidence-${name}`,
        clearedHoldId: `incident:probe-evidence-${name}`,
        at: '2026-07-18T13:00:00.000Z',
      });
      if (ledgerDirectory) await mkdir(files.ledgerFile);
      await assert.rejects(() => ghRequest(['api', 'rate_limit'], fastOptions(files, {
        runner: async () => ({code: 0, stdout, stderr: ''}),
        requestClass: 'rest_read',
        resumeProbe: true,
      })), (error) => error instanceof GitHubGatewayRefusalError && error.reason === reason);
      const state = JSON.parse(await readFile(path.join(files.stateDir, 'state.json'), 'utf8'));
      assert.equal(state.probe_required.cleared_hold_id, `incident:probe-evidence-${name}`);
      assert.deepEqual(state.probe_completions, []);
    });
  }
});

test('completed clearance replay does not re-arm the resume probe', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-probe-replay');
  await mkdir(files.stateDir, {recursive: true});
  await writeFile(path.join(files.stateDir, 'state.json'), JSON.stringify({
    schema_version: 1,
    last_request_at_ms: null,
    last_completed_at_ms: null,
    last_class: null,
    provider_pause: {
      kind: 'PROVIDER_THROTTLED', provider: 'GitHub', signal: 'HTTP_429',
      tripped_at: '2026-07-18T12:00:00.000Z', auto_resume: false,
    },
    provider_pause_clearances: [],
    waves: {},
  }));
  const clearanceOptions = {
    ...fastOptions(files),
    founderDecisionId: 'founder-completed-probe-replay',
    clearedHoldId: 'incident:completed-probe-replay',
    at: '2026-07-18T13:00:00.000Z',
  };
  await clearGhGatewayThrottle(clearanceOptions);
  await ghRequest(['api', 'rate_limit'], fastOptions(files, {
    runner: async () => ({code: 0, stdout: '{"resources":{"core":{"remaining":5000}}}', stderr: ''}),
    requestClass: 'rest_read',
    resumeProbe: true,
  }));
  await clearGhGatewayThrottle(clearanceOptions);
  const replayed = await readGhGatewayControlState(fastOptions(files));
  assert.equal(replayed.probe_required, null);
  assert.equal(replayed.probe_completions.length, 1);
  assert.equal((await ghRequest(['api', 'repos/o/r'], fastOptions(files, {
    runner: async () => ({code: 0, stdout: '{}', stderr: ''}),
  }))).code, 0);
});

test('a throttle during the sanctioned probe supersedes the old marker and permits a fresh clear-probe cycle', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-throttle-during-probe');
  let clock = Date.parse('2026-07-18T12:00:00.000Z');
  const options = fastOptions(files, {now: () => clock});
  await assert.rejects(() => ghRequest(['api', 'repos/o/r'], {
    ...options,
    runner: async () => ({code: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests'}),
  }), (error) => error instanceof GitHubThrottleError);
  const first = await readGhGatewayControlState(options);
  const firstHold = `incident:${first.provider_pause.incident_id}`;
  const common = [
    '--controls-state', files.controlStateFile,
    '--resource-control', files.resourceControlFile,
    '--gateway-state', files.stateDir,
    '--ledger', files.ledgerFile,
  ];
  const sink = {write() {}};
  await runControlsCli([
    'clear-hold', ...common, '--hold-id', firstHold,
    '--founder-decision-id', 'founder-probe-throttle-first',
  ], {stdout: sink, now: () => new Date('2026-07-18T12:01:00.000Z')});

  clock = Date.parse('2026-07-18T12:02:00.000Z');
  await assert.rejects(() => ghRequest(['api', 'rate_limit'], {
    ...options,
    requestClass: 'rest_read',
    resumeProbe: true,
    runner: async () => ({code: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests'}),
  }), (error) => error instanceof GitHubThrottleError);
  const second = await readGhGatewayControlState(options);
  assert.notEqual(second.provider_pause.incident_id, first.provider_pause.incident_id);
  assert.equal(second.probe_required, null);
  assert.deepEqual(second.probe_dispositions, [{
    cleared_hold_id: firstHold,
    clearance_at: '2026-07-18T12:01:00.000Z',
    disposition: 'superseded_by_throttle',
    disposed_at: '2026-07-18T12:02:00.000Z',
    superseding_incident_id: second.provider_pause.incident_id,
    superseding_signal: 'HTTP_429',
  }]);
  const secondHold = `incident:${second.provider_pause.incident_id}`;
  await runControlsCli([
    'clear-hold', ...common, '--hold-id', secondHold,
    '--founder-decision-id', 'founder-probe-throttle-second',
  ], {stdout: sink, now: () => new Date('2026-07-18T12:03:00.000Z')});

  clock = Date.parse('2026-07-18T12:04:00.000Z');
  await ghRequest(['api', 'rate_limit'], {
    ...options,
    requestClass: 'rest_read',
    resumeProbe: true,
    runner: async () => ({code: 0, stdout: '{"resources":{"core":{"remaining":5000}}}', stderr: ''}),
  });
  await runControlsCli([
    'clear-hold', ...common, '--hold-id', secondHold,
    '--founder-decision-id', 'founder-probe-throttle-second',
  ], {stdout: sink, now: () => new Date('2026-07-18T12:03:00.000Z')});
  await runControlsCli([
    'clear-hold', ...common, '--hold-id', firstHold,
    '--founder-decision-id', 'founder-probe-throttle-first',
  ], {stdout: sink, now: () => new Date('2026-07-18T12:01:00.000Z')});
  assert.equal((await readGhGatewayControlState(options)).probe_required, null);
  assert.equal((await ghRequest(['api', 'repos/o/r'], {
    ...options,
    runner: async () => ({code: 0, stdout: '{}', stderr: ''}),
  })).code, 0);
});

test('founder repair reconstructs a probe-superseding throttle after the first gateway trip save fails', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-trip-save-reconstruction');
  let clock = Date.parse('2026-07-18T12:00:00.000Z');
  const options = fastOptions(files, {now: () => clock});
  await assert.rejects(() => ghRequest(['api', 'repos/o/r'], {
    ...options,
    runner: async () => ({code: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests'}),
  }), (error) => error instanceof GitHubThrottleError);
  const first = await readGhGatewayControlState(options);
  const firstHold = `incident:${first.provider_pause.incident_id}`;
  const common = [
    '--controls-state', files.controlStateFile,
    '--resource-control', files.resourceControlFile,
    '--gateway-state', files.stateDir,
    '--ledger', files.ledgerFile,
  ];
  const sink = {write() {}};
  await runControlsCli([
    'clear-hold', ...common, '--hold-id', firstHold,
    '--founder-decision-id', 'founder-trip-save-first-1',
  ], {stdout: sink, now: () => new Date('2026-07-18T12:01:00.000Z')});

  clock = Date.parse('2026-07-18T12:02:00.000Z');
  await assert.rejects(() => ghRequest(['api', 'rate_limit'], {
    ...options,
    requestClass: 'rest_read',
    resumeProbe: true,
    beforeThrottleGatewayStateSave: async ({phase}) => {
      if (phase === 'trip-initial') throw new Error('injected first throttle-trip gateway save failure');
    },
    runner: async () => ({code: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests'}),
  }), (error) => error instanceof GitHubThrottleError &&
    /injected first throttle-trip gateway save failure/.test(error.cause?.message ?? ''));
  const interrupted = JSON.parse(await readFile(path.join(files.stateDir, 'state.json'), 'utf8'));
  assert.equal(interrupted.provider_pause, null);
  assert.deepEqual(interrupted.probe_required, {set_at: '2026-07-18T12:01:00.000Z', cleared_hold_id: firstHold});
  const resource = await loadResourceControl(files.resourceControlFile);
  const secondPause = resource.provider_pause;
  assert.notEqual(secondPause.incident_id, first.provider_pause.incident_id);
  const campaign = JSON.parse(await readFile(files.controlStateFile, 'utf8'));
  const secondIncident = campaign.incidents.find((entry) => entry.incident_id === secondPause.incident_id);
  const {repository: _repository, ...markerIncident} = secondIncident;
  const markerDigest = digestRecord({...markerIncident, peer_path_identities: interrupted.peer_path_identities});
  const repair = await runControlsCli([
    'repair-throttle-state', ...common,
    '--founder-decision-id', 'founder-trip-save-repair-1',
    '--expected-incident-id', secondPause.incident_id,
    '--expected-marker-digest', markerDigest,
  ], {stdout: sink, now: () => new Date('2026-07-18T12:02:30.000Z')});
  assert.equal(repair.repaired, true);
  assert.equal(repair.audit_record.reason, 'reconstruct_gateway_pause');
  const reconstructed = await readGhGatewayControlState(options);
  assert.deepEqual(reconstructed.provider_pause, secondPause);
  assert.equal(reconstructed.probe_required, null);
  assert.equal(reconstructed.probe_dispositions.at(-1).cleared_hold_id, firstHold);

  const secondHold = `incident:${secondPause.incident_id}`;
  await runControlsCli([
    'clear-hold', ...common, '--hold-id', secondHold,
    '--founder-decision-id', 'founder-trip-save-second-1',
  ], {stdout: sink, now: () => new Date('2026-07-18T12:03:00.000Z')});
  const cleared = await readGhGatewayControlState(options);
  assert.equal(cleared.provider_pause, null);
  assert.equal(cleared.probe_required.cleared_hold_id, secondHold);
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

test('quoted worker throttling language does not latch while GitHub HTTP 403 and 429 throttles do', async (t) => {
  const quoted = await temporaryGateway(t, 'gh-gateway-false-throttle-language');
  const result = await ghRequest(['api', 'repos/o/r/issues/1'], fastOptions(quoted, {
    runner: async () => ({
      code: 1,
      stdout: '',
      stderr: 'issue body: "we should throttle the worker pool and honor retry-after"',
    }),
  }));
  assert.equal(result.code, 1);
  assert.equal((await readGhGatewayControlState(fastOptions(quoted))).provider_pause, null);

  for (const [name, stderr] of [
    ['403', 'HTTP 403 Forbidden: GitHub API rate limit exceeded'],
    ['429', 'gh: HTTP 429 Too Many Requests'],
  ]) {
    const files = await temporaryGateway(t, `gh-gateway-real-throttle-${name}`);
    await assert.rejects(() => ghRequest(['api', 'rate_limit'], fastOptions(files, {
      runner: async () => ({code: 1, stdout: '', stderr}),
    })), (error) => error instanceof GitHubThrottleError);
  }
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
  await assert.rejects(
    () => ghRequest(['api', 'graphql', '-f', 'query=query { search(query:"bug", type:ISSUE) { issueCount } }'],
      fastOptions(files, {runner})),
    (error) => error instanceof GitHubGatewayRefusalError &&
      error.reason === 'search-wave-required',
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
    '--field', 'q=org:openai is:issue label:bug',
    `https://api.github.com/repos/o/r?access_token=${secrets[2]}&client_secret=${secrets[3]}&client_id=${secrets[4]}`,
  ], fastOptions(files, {
    runner: async () => ({code: 0, stdout: '{}', stderr: ''}),
  }));
  const line = await readFile(files.ledgerFile, 'utf8');
  for (const secret of secrets) assert.equal(line.includes(secret), false, `leaked ${secret}`);
  const entry = JSON.parse(line);
  assert.ok(entry.argv_summary.includes('--body=<redacted>'));
  assert.ok(entry.argv_summary.includes('--raw-field=token=<redacted>'));
  assert.ok(entry.argv_summary.includes('q=org:openai is:issue label:bug'));
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
  const stale = new Date(Date.now() - 160_000);
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

test('a provably dead holder is reclaimable after 150 seconds instead of the ten-minute stale window', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-dead-lock-reclaim');
  await mkdir(files.stateDir, {recursive: true});
  const lockFile = path.join(files.stateDir, 'gateway.lock');
  await writeFile(lockFile, `${JSON.stringify({
    pid: 99_999_999,
    process_start_identity: 'ps:dead-process-start',
    lock_nonce: 'dead-lock',
  })}\n`);
  const reclaimable = new Date(Date.now() - 160_000);
  await utimes(lockFile, reclaimable, reclaimable);
  const options = fastOptions(files, {
    timing: {...fastOptions(files).timing, staleLockMs: 600_000, lockHeartbeatMs: 10_000},
  });
  const release = await acquireGhGatewayLock(options);
  const event = JSON.parse((await readFile(files.ledgerFile, 'utf8')).trim());
  assert.equal(event.event, 'lock_reclaimed');
  assert.equal(event.reclaim_reason, 'process-not-running');
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
  assert.match(entry.state_dir_digest, /^[0-9a-f]{8}$/);
});

test('generic ledger events acquire the gateway lock unless gatewayLockHeld is explicit', async (t) => {
  const files = await temporaryGateway(t, 'gh-gateway-ledger-lock');
  const options = fastOptions(files, {
    timing: {...fastOptions(files).timing, lockTimeoutMs: 20, lockPollMs: 2},
    processIdentity: async () => 'ps:ledger-lock-owner',
  });
  const release = await acquireGhGatewayLock(options);
  await assert.rejects(
    () => ledgerEvent({class: 'control', event: 'must_lock'}, options),
    (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'lock-timeout',
  );
  await ledgerEvent({class: 'control', event: 'already_locked'}, {...options, gatewayLockHeld: true});
  await release();
  const entries = (await readFile(files.ledgerFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(entries.map((entry) => entry.event), ['already_locked']);
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
