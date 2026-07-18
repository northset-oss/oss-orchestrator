import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {loadResourceControl, tripPersistentProviderThrottle} from '../phase0/resource-breakers.mjs';
import {openCampaignControls} from './controls.mjs';
import {parseControlsCliArgs, runControlsCli} from './controls-cli.mjs';

const execFileAsync = promisify(execFile);

function outputSink() {
  let value = '';
  return {stream: {write(chunk) { value += chunk; }}, value: () => value};
}

async function seedClearanceState(root, {
  alreadyCleared = false,
  usedDecisionLocation = null,
  usedDecisionId = 'founder-replay-1',
} = {}) {
  const controlsFile = path.join(root, 'control-state.json');
  const resourceControlFile = path.join(root, 'resource-control.json');
  const gatewayStateDir = path.join(root, 'gateway-state');
  const priorClearance = {founder_decision_id: usedDecisionId, cleared_at: '2026-07-18T13:00:00Z'};
  await writeFile(controlsFile, JSON.stringify({
    schema_version: 1,
    incidents: [{
      incident_id: 'github-secondary-rate-limit', severity: 'SEV_1', scope: 'platform',
      event_class: 'platform_warning', occurred_at: '2026-07-18T12:14:00Z',
    }, {
      incident_id: 'prior-platform-hold', severity: 'SEV_1', scope: 'platform',
      event_class: 'platform_warning', occurred_at: '2026-07-17T12:14:00Z',
    }],
    closures: [],
    hold_clearances: [
      {hold_id: 'incident:prior-platform-hold',
        founder_decision_id: usedDecisionLocation === 'campaign' ? usedDecisionId : 'prior-decision',
        cleared_at: '2026-07-17T13:00:00Z'},
      ...(alreadyCleared ? [{hold_id: 'incident:github-secondary-rate-limit', founder_decision_id: 'already-cleared',
        cleared_at: '2026-07-18T14:00:00Z'}] : []),
    ],
  }));
  const resourcePause = {
    kind: 'PROVIDER_THROTTLED', provider: 'GitHub', signal: 'GITHUB_SECONDARY_RATE_LIMIT',
    tripped_at: '2026-07-18T12:14:00Z', auto_resume: false,
  };
  await writeFile(resourceControlFile, JSON.stringify({
    schema_version: 1,
    provider_pause: resourcePause,
    exception_task_ids: [],
    active_exception: null,
    provider_pause_clearances: usedDecisionLocation === 'resource'
      ? [{...priorClearance, provider_pause: resourcePause}] : [],
  }));
  await mkdir(gatewayStateDir, {recursive: true});
  const gatewayPause = {...resourcePause};
  await writeFile(path.join(gatewayStateDir, 'state.json'), JSON.stringify({
    schema_version: 1,
    last_request_at_ms: null,
    last_completed_at_ms: null,
    last_class: null,
    provider_pause: gatewayPause,
    provider_pause_clearances: usedDecisionLocation === 'gateway'
      ? [{...priorClearance, provider_pause: gatewayPause}] : [],
    waves: {},
  }));
  return {controlsFile, resourceControlFile, gatewayStateDir};
}

test('clear-hold CLI requires a founder decision ID', () => {
  assert.throws(() => parseControlsCliArgs([
    'clear-hold', '--hold-id', 'incident:github-secondary-rate-limit',
  ]), /founder-decision-id is required/i);
});

test('clear-hold clears both campaign hold and persistent breaker with the founder decision recorded', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-controls-cli-clear-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const controlsFile = path.join(root, 'control-state.json');
  const resourceControlFile = path.join(root, 'resource-control.json');
  const gatewayStateDir = path.join(root, 'gateway-state');
  await writeFile(controlsFile, JSON.stringify({
    schema_version: 1,
    incidents: [{
      incident_id: 'github-secondary-rate-limit', severity: 'SEV_1', scope: 'platform',
      event_class: 'platform_warning', occurred_at: '2026-07-18T12:14:00Z',
    }],
    closures: [],
    hold_clearances: [],
  }));
  await tripPersistentProviderThrottle(resourceControlFile, {
    provider: 'GitHub', signal: 'secondary rate limit', at: '2026-07-18T12:14:00Z',
    gatewayStateDir,
  });
  await mkdir(gatewayStateDir, {recursive: true});
  await writeFile(path.join(gatewayStateDir, 'state.json'), JSON.stringify({
    schema_version: 1,
    last_request_at_ms: null,
    last_completed_at_ms: null,
    last_class: null,
    provider_pause: {
      kind: 'PROVIDER_THROTTLED', provider: 'GitHub', signal: 'GITHUB_SECONDARY_RATE_LIMIT',
      tripped_at: '2026-07-18T12:14:00Z', auto_resume: false,
    },
    provider_pause_clearances: [],
    waves: {},
  }));
  const output = outputSink();
  await runControlsCli([
    'clear-hold',
    '--controls-state', controlsFile,
    '--resource-control', resourceControlFile,
    '--gateway-state', gatewayStateDir,
    '--hold-id', 'incident:github-secondary-rate-limit',
    '--founder-decision-id', 'founder-rate-resume-1',
  ], {stdout: output.stream, now: () => new Date('2026-07-18T15:00:00Z')});

  const controls = await openCampaignControls(controlsFile);
  assert.equal(controls.snapshot({now: new Date('2026-07-18T15:00:00Z')}).global_publication_hold.active, false);
  const control = await loadResourceControl(resourceControlFile);
  assert.equal(control.provider_pause, null);
  assert.equal(control.provider_pause_clearances[0].founder_decision_id, 'founder-rate-resume-1');
  const gatewayState = JSON.parse(await readFile(path.join(gatewayStateDir, 'state.json'), 'utf8'));
  assert.equal(gatewayState.provider_pause, null);
  assert.equal(gatewayState.provider_pause_clearances[0].founder_decision_id, 'founder-rate-resume-1');
  const state = JSON.parse(await readFile(controlsFile, 'utf8'));
  assert.equal(state.hold_clearances[0].founder_decision_id, 'founder-rate-resume-1');
  assert.deepEqual(state.hold_clearances[0].cleared_pause, {
    signal: 'GITHUB_SECONDARY_RATE_LIMIT', tripped_at: '2026-07-18T12:14:00Z',
  });
  assert.deepEqual(control.provider_pause_clearances[0].cleared_pause, {
    signal: 'secondary rate limit', tripped_at: '2026-07-18T12:14:00Z',
  });
  assert.deepEqual(gatewayState.provider_pause_clearances[0].cleared_pause, {
    signal: 'GITHUB_SECONDARY_RATE_LIMIT', tripped_at: '2026-07-18T12:14:00Z',
  });
  assert.match(output.value(), /founder-rate-resume-1/);
});

test('clear-hold refuses a decision ID already used in any clearance ledger without clearing state', async (t) => {
  for (const location of ['campaign', 'resource', 'gateway']) {
    await t.test(location, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `campaign-controls-cli-replay-${location}-`));
      t.after(() => rm(root, {recursive: true, force: true}));
      const paths = await seedClearanceState(root, {usedDecisionLocation: location});
      const before = await Promise.all([
        readFile(paths.controlsFile, 'utf8'),
        readFile(paths.resourceControlFile, 'utf8'),
        readFile(path.join(paths.gatewayStateDir, 'state.json'), 'utf8'),
      ]);
      await assert.rejects(() => runControlsCli([
        'clear-hold',
        '--controls-state', paths.controlsFile,
        '--resource-control', paths.resourceControlFile,
        '--gateway-state', paths.gatewayStateDir,
        '--hold-id', 'incident:github-secondary-rate-limit',
        '--founder-decision-id', 'founder-replay-1',
      ], {stdout: outputSink().stream}), /founder decision ID .* already used/i);
      assert.deepEqual(await Promise.all([
        readFile(paths.controlsFile, 'utf8'),
        readFile(paths.resourceControlFile, 'utf8'),
        readFile(path.join(paths.gatewayStateDir, 'state.json'), 'utf8'),
      ]), before);
    });
  }
});

test('clear-hold refuses an already-cleared hold without touching a newly tripped latch', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-controls-cli-already-cleared-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const paths = await seedClearanceState(root, {alreadyCleared: true});
  const beforeResource = await readFile(paths.resourceControlFile, 'utf8');
  const beforeGateway = await readFile(path.join(paths.gatewayStateDir, 'state.json'), 'utf8');
  await assert.rejects(() => runControlsCli([
    'clear-hold',
    '--controls-state', paths.controlsFile,
    '--resource-control', paths.resourceControlFile,
    '--gateway-state', paths.gatewayStateDir,
    '--hold-id', 'incident:github-secondary-rate-limit',
    '--founder-decision-id', 'new-decision-must-not-clear-new-latch',
  ], {stdout: outputSink().stream}), /already cleared before this invocation/i);
  assert.equal(await readFile(paths.resourceControlFile, 'utf8'), beforeResource);
  assert.equal(await readFile(path.join(paths.gatewayStateDir, 'state.json'), 'utf8'), beforeGateway);
});

test('snapshot prints the active campaign hold without changing state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-controls-cli-snapshot-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const controlsFile = path.join(root, 'control-state.json');
  const before = `${JSON.stringify({
    schema_version: 1,
    incidents: [{
      incident_id: 'github-secondary-rate-limit', severity: 'SEV_1', scope: 'platform',
      event_class: 'platform_warning', occurred_at: '2026-07-18T12:14:00Z',
    }],
    closures: [],
    hold_clearances: [],
  }, null, 2)}\n`;
  await writeFile(controlsFile, before);
  const output = outputSink();
  await runControlsCli(['snapshot', '--controls-state', controlsFile], {stdout: output.stream});
  assert.equal(JSON.parse(output.value()).global_publication_hold.active, true);
  assert.equal(await readFile(controlsFile, 'utf8'), before);
});

test('budget prints the read-only gateway budget view including alert state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-controls-cli-budget-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const gatewayStateDir = path.join(root, 'gateway-state');
  const expected = {
    schema_version: 1,
    date_utc: '2026-07-18',
    daily_cap: 2_000,
    used_today: 1_500,
    remaining_today: 500,
    throttle_seen_today: false,
    alert: {
      threshold_percent: 75,
      threshold_requests: 1_500,
      active: true,
      emitted_today: true,
    },
    recent_history: [],
  };
  const calls = [];
  const output = outputSink();
  const result = await runControlsCli([
    'budget', '--gateway-state', gatewayStateDir,
  ], {
    stdout: output.stream,
    gatewayBudgetReadImpl: async (options) => {
      calls.push(options);
      return expected;
    },
  });
  assert.deepEqual(result, expected);
  assert.deepEqual(JSON.parse(output.value()), expected);
  assert.deepEqual(calls, [{stateDir: gatewayStateDir}]);
});

test('probe makes exactly one rate_limit request through the gateway interface', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-controls-cli-probe-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const controlsFile = path.join(root, 'control-state.json');
  const resourceControlFile = path.join(root, 'resource-control.json');
  const gatewayStateDir = path.join(root, 'gateway-state');
  const calls = [];
  const output = outputSink();
  const result = await runControlsCli([
    'probe', '--controls-state', controlsFile, '--resource-control', resourceControlFile,
    '--gateway-state', gatewayStateDir,
  ], {
    stdout: output.stream,
    gatewayRequestImpl: async (argv, options) => {
      calls.push({argv, options});
      return {status: 0, code: 0, stdout: '{"resources":{}}\n', stderr: '', signal: null, timedOut: false};
    },
  });
  assert.equal(result.code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['api', 'rate_limit']);
  assert.equal(calls[0].options.requestClass, 'rest_read');
  assert.equal(calls[0].options.label, 'controls-probe');
  assert.equal(calls[0].options.controlStateFile, controlsFile);
  assert.equal(calls[0].options.resourceControlFile, resourceControlFile);
  assert.equal(calls[0].options.stateDir, gatewayStateDir);
  assert.equal(output.value(), '{"resources":{}}\n');
});

test('probe executable reaches a fake gh exactly once through the real gateway', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-controls-cli-probe-gateway-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const bin = path.join(root, 'bin');
  const callsFile = path.join(root, 'fake-gh-calls.jsonl');
  const ledgerFile = path.join(root, 'gh-request-ledger.jsonl');
  await mkdir(bin);
  const gh = path.join(bin, 'gh');
  await writeFile(gh, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write('{"resources":{}}\\n');
`);
  await chmod(gh, 0o700);
  const controlStateFile = path.join(root, 'control-state.json');
  const resourceControlFile = path.join(root, 'resource-control.json');
  const result = await execFileAsync(process.execPath, [
    path.join(import.meta.dirname, 'controls-cli.mjs'),
    'probe', '--controls-state', controlStateFile, '--resource-control', resourceControlFile,
    '--gateway-state', path.join(root, 'gateway-state'),
  ], {env: {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_GH_CALLS: callsFile,
    OSS_GH_GATEWAY_STATE_DIR: path.join(root, 'gateway-state'),
    OSS_GH_REQUEST_LEDGER: ledgerFile,
    OSS_GH_GATEWAY_TEST_MODE: '1',
    OSS_GH_GATEWAY_TEST_MIN_SPACING_MS: '0',
    OSS_GH_GATEWAY_TEST_JITTER_MAX_MS: '0',
  }});
  assert.equal(result.stdout, '{"resources":{}}\n');
  assert.deepEqual((await readFile(callsFile, 'utf8')).trim().split('\n').map(JSON.parse), [['api', 'rate_limit']]);
  const ledger = (await readFile(ledgerFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].label, 'controls-probe');
  assert.equal(ledger[0].class, 'rest_read');
});
