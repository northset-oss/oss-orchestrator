import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {ghRequest, GitHubThrottleError} from '../../gh-gateway.mjs';
import {runControlsCli} from './controls-cli.mjs';
import {openCampaignControls} from './controls.mjs';

const LEGACY_CONTROL_STATE = new URL('./fixtures/control-state-legacy-rate-hold-20260718.json', import.meta.url);
const REAL_THROTTLE_BODY = new URL('./fixtures/github-secondary-rate-limit-20260718.json', import.meta.url);
const LEGACY_HOLD_ID = 'incident:github-secondary-rate-limit-20260718T121400Z';
const execFileAsync = promisify(execFile);

function outputSink() {
  let value = '';
  return {stream: {write(chunk) { value += chunk; }}, value: () => value};
}

test('GitHub rate-safety lifecycle rehearses legacy recovery and resume offline', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'github-rate-safety-lifecycle-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const controlStateFile = path.join(root, 'control-state.json');
  const resourceControlFile = path.join(root, 'resource-control.json');
  const gatewayStateDir = path.join(root, 'gateway-state');
  const ledgerFile = path.join(root, 'gh-request-ledger.jsonl');
  await writeFile(controlStateFile, await readFile(LEGACY_CONTROL_STATE));

  const common = [
    '--controls-state', controlStateFile,
    '--resource-control', resourceControlFile,
    '--gateway-state', gatewayStateDir,
  ];
  let clockMs = Date.parse('2026-07-18T19:01:30.000Z');
  const pacingDelays = [];
  const gatewayOptions = {
    stateDir: gatewayStateDir,
    ledgerFile,
    resourceControlFile,
    controlStateFile,
    testMode: true,
    timing: {minSpacingMs: 1_000, searchSpacingMs: 1_000, mutationSpacingMs: 1_000, jitterMaxMs: 0, lockPollMs: 1},
    now: () => clockMs,
    sleep: async (milliseconds) => {
      pacingDelays.push(milliseconds);
      clockMs += milliseconds;
    },
  };
  await assert.rejects(() => runControlsCli([
    'clear-hold', ...common, '--hold-id', LEGACY_HOLD_ID,
    '--founder-decision-id', 'founder-lifecycle-legacy-clear',
  ], {stdout: outputSink().stream}),
  /has not been migrated; run 'migrate-legacy-hold --hold-id incident:github-secondary-rate-limit-20260718T121400Z' first/);

  const migrationOutput = outputSink();
  const migration = await runControlsCli([
    'migrate-legacy-hold', ...common, '--hold-id', LEGACY_HOLD_ID,
  ], {
    stdout: migrationOutput.stream,
    now: () => new Date('2026-07-18T19:00:00.000Z'),
  });
  assert.deepEqual(JSON.parse(migrationOutput.value()), migration);
  assert.equal(migration.founder_decision_id, null);
  assert.deepEqual(migration.restrictions_added,
    ['persistent_provider_throttle', 'github_gateway_provider_throttle']);
  for (const pause of [migration.provider_pause, migration.gateway_provider_pause]) {
    assert.equal(pause.signal, 'GITHUB_SECONDARY_RATE_LIMIT');
    assert.equal(pause.tripped_at, '2026-07-18T12:14:00.000Z');
    assert.equal(pause.auto_resume, false);
    assert.equal(pause.migrated_from_incident, 'github-secondary-rate-limit-20260718T121400Z');
    assert.equal(pause.migrated_at, '2026-07-18T19:00:00.000Z');
  }
  const migratedCampaign = JSON.parse(await readFile(controlStateFile, 'utf8')).incidents
    .find((item) => `incident:${item.incident_id}` === LEGACY_HOLD_ID);
  assert.equal(migratedCampaign.signal, 'GITHUB_SECONDARY_RATE_LIMIT');
  assert.equal(migratedCampaign.tripped_at, '2026-07-18T12:14:00.000Z');
  assert.equal(migratedCampaign.migrated_at, '2026-07-18T19:00:00.000Z');
  assert.deepEqual(JSON.parse(await readFile(resourceControlFile, 'utf8')).provider_pause,
    migration.provider_pause);
  assert.deepEqual(JSON.parse(await readFile(path.join(gatewayStateDir, 'state.json'), 'utf8')).provider_pause,
    migration.gateway_provider_pause);

  const clearance = await runControlsCli([
    'clear-hold', ...common, '--hold-id', LEGACY_HOLD_ID,
    '--founder-decision-id', 'founder-lifecycle-legacy-clear',
  ], {
    stdout: outputSink().stream,
    now: () => new Date('2026-07-18T19:01:00.000Z'),
  });
  assert.equal(clearance.hold_clearance.hold_id, LEGACY_HOLD_ID);
  assert.deepEqual(JSON.parse(await readFile(path.join(gatewayStateDir, 'state.json'), 'utf8')).probe_required, {
    set_at: '2026-07-18T19:01:00.000Z',
    cleared_hold_id: LEGACY_HOLD_ID,
  });

  let ordinaryCalls = 0;
  await assert.rejects(() => ghRequest(['api', 'repos/example/project'], {
    ...gatewayOptions,
    runner: async () => {
      ordinaryCalls += 1;
      return {code: 0, stdout: '{}', stderr: ''};
    },
  }), (error) => error.reason === 'resume-probe-required');
  assert.equal(ordinaryCalls, 0);

  const probe = await runControlsCli(['probe', ...common], {
    stdout: outputSink().stream,
    gatewayRequestImpl: (argv, options) => ghRequest(argv, {
      ...gatewayOptions,
      ...options,
      ledgerFile,
      runner: async () => ({code: 0, stdout: '{"resources":{"core":{"remaining":5000}}}\n', stderr: ''}),
    }),
  });
  assert.equal(probe.code, 0);
  assert.equal(JSON.parse(await readFile(path.join(gatewayStateDir, 'state.json'), 'utf8')).probe_required, null);

  const ordinary = await ghRequest(['api', 'repos/example/project'], {
    ...gatewayOptions,
    runner: async () => {
      ordinaryCalls += 1;
      return {code: 0, stdout: '{"ok":true}', stderr: ''};
    },
  });
  assert.equal(ordinary.code, 0);
  assert.equal(ordinaryCalls, 1);
  assert.deepEqual(pacingDelays, [1_000]);

  const throttleBody = await readFile(REAL_THROTTLE_BODY, 'utf8');
  clockMs = Date.parse('2026-07-18T19:02:00.000Z');
  await assert.rejects(() => ghRequest(['api', 'repos/example/project/issues/1'], {
    ...gatewayOptions,
    runner: async () => ({code: 1, stdout: '', stderr: throttleBody}),
  }), (error) => error instanceof GitHubThrottleError && error.signal === 'GITHUB_SECONDARY_RATE_LIMIT');

  const futureIncidentId = 'github-secondary-rate-limit-20260718T190200Z';
  const trippedGateway = JSON.parse(await readFile(path.join(gatewayStateDir, 'state.json'), 'utf8'));
  const trippedResource = JSON.parse(await readFile(resourceControlFile, 'utf8'));
  const trippedCampaign = JSON.parse(await readFile(controlStateFile, 'utf8'));
  assert.equal(trippedGateway.provider_pause.tripped_at, '2026-07-18T19:02:00.000Z');
  assert.deepEqual(trippedResource.provider_pause, trippedGateway.provider_pause);
  assert.deepEqual(trippedCampaign.incidents.find((item) => item.incident_id === futureIncidentId), {
    incident_id: futureIncidentId,
    severity: 'SEV_1',
    scope: 'platform',
    event_class: 'platform_warning',
    incident_class: 'provider_rate_limit',
    provider: 'GitHub',
    signal: 'GITHUB_SECONDARY_RATE_LIMIT',
    tripped_at: '2026-07-18T19:02:00.000Z',
    occurred_at: '2026-07-18T19:02:00.000Z',
    disposition: 'global_pipeline_hold_pending_founder_review_no_auto_resume',
    evidence_file: ledgerFile,
    repository: null,
  });

  const futureHoldId = `incident:${futureIncidentId}`;
  const futureClearance = await runControlsCli([
    'clear-hold', ...common, '--hold-id', futureHoldId,
    '--founder-decision-id', 'founder-lifecycle-future-clear',
  ], {
    stdout: outputSink().stream,
    now: () => new Date('2026-07-18T19:03:00.000Z'),
  });
  assert.equal(futureClearance.hold_clearance.hold_id, futureHoldId);

  let boundedRefusalCalls = 0;
  for (const [argv, reason] of [
    [['api', 'repos/example/project/issues?per_page=100', '--paginate'], 'pagination-bypass'],
    [['pr', 'list', '--limit', '500'], 'page-bound-exceeded'],
  ]) {
    await assert.rejects(() => ghRequest(argv, {
      ...gatewayOptions,
      runner: async () => {
        boundedRefusalCalls += 1;
        return {code: 0, stdout: '[]', stderr: ''};
      },
    }), (error) => error.reason === reason);
  }
  assert.equal(boundedRefusalCalls, 0);

  clockMs = Date.parse('2026-07-18T19:03:30.000Z');
  await runControlsCli(['probe', ...common], {
    stdout: outputSink().stream,
    gatewayRequestImpl: (argv, options) => ghRequest(argv, {
      ...gatewayOptions,
      ...options,
      ledgerFile,
      runner: async () => ({code: 0, stdout: '{"resources":{"core":{"remaining":5000}}}\n', stderr: ''}),
    }),
  });
  const entryHoldId = 'lifecycle-entrypoint-active-hold';
  const controls = await openCampaignControls(controlStateFile, {gatewayStateDir});
  await controls.recordIncident({
    incident_id: entryHoldId,
    severity: 'SEV_1',
    scope: 'platform',
    event_class: 'platform_warning',
    incident_class: 'authorization',
    occurred_at: '2026-07-18T19:04:00.000Z',
    disposition: 'lifecycle_test_hold',
  });

  const bin = path.join(root, 'bin');
  const unexpectedCalls = path.join(root, 'unexpected-gh-calls.jsonl');
  await mkdir(bin);
  await writeFile(unexpectedCalls, '');
  const fakeGh = path.join(bin, 'gh');
  await writeFile(fakeGh, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(99);
`);
  await chmod(fakeGh, 0o700);
  const environment = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_GH_CALLS: unexpectedCalls,
    OSS_GH_GATEWAY_STATE_DIR: gatewayStateDir,
    OSS_GH_REQUEST_LEDGER: ledgerFile,
    OSS_GH_CANONICAL_ROOT: root,
    OSS_RESOURCE_CONTROL_FILE: resourceControlFile,
    OSS_CAMPAIGN_CONTROL_STATE: controlStateFile,
    OSS_GH_GATEWAY_TEST_MODE: '1',
    OSS_GH_GATEWAY_TEST_LOCK_POLL_MS: '1',
  };
  const entrypoints = [
    [path.resolve(import.meta.dirname, '..', '..', 'find-candidates.mjs'),
      'crawl', '--profile', 'node', '--count', '1', '--out', path.join(root, 'lake.sqlite')],
    [path.resolve(import.meta.dirname, '..', '..', 'find-candidates.mjs'),
      'qualify', '--queue', path.join(root, 'missing-queue.json'), '--lake', path.join(root, 'lake.sqlite')],
    [path.resolve(import.meta.dirname, '..', '..', 'find-candidates.mjs'),
      '1', '--dry-run', '--output', path.join(root, 'discover.json'),
      '--audit', path.join(root, 'discover-audit.jsonl'), '--history', path.join(root, 'discover-history.jsonl')],
    [path.resolve(import.meta.dirname, '..', '..', 'oss.mjs'),
      'prepare', 'M-LIFECYCLE', '--specs', path.join(root, 'missing-specs'),
      '--runs', path.join(root, 'mission-runs'), '--no-push'],
    [path.resolve(import.meta.dirname, '..', '..', 'oss.mjs'),
      'ship', 'M-LIFECYCLE', '--specs', path.join(root, 'missing-specs'),
      '--runs', path.join(root, 'mission-runs'), '--approve', `sha256:${'a'.repeat(64)}`,
      '--approval-record', path.join(root, 'missing-approval.json'), '--no-push'],
  ];
  for (const argv of entrypoints) {
    await assert.rejects(() => execFileAsync(process.execPath, argv, {env: environment}),
      (error) => error.code === 1 &&
        new RegExp(`global hold incident:${entryHoldId} is active`).test(error.stderr));
  }
  assert.equal(await readFile(unexpectedCalls, 'utf8'), '');
});
