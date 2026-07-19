import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';

import {
  clearPersistentProviderThrottle,
  loadResourceControl,
  migratePersistentProviderThrottle,
} from '../phase0/resource-breakers.mjs';
import {clearGhGatewayThrottle, migrateLegacyGhGatewayThrottle} from '../../gh-gateway.mjs';
import {openCampaignControls} from './controls.mjs';
import {parseControlsCliArgs, runControlsCli} from './controls-cli.mjs';

const execFileAsync = promisify(execFile);

function outputSink() {
  let value = '';
  return {stream: {write(chunk) { value += chunk; }}, value: () => value};
}

async function seedMigrationHold(root) {
  const controlsFile = path.join(root, 'control-state.json');
  const resourceControlFile = path.join(root, 'resource-control.json');
  const gatewayStateDir = path.join(root, 'gateway-state');
  await writeFile(controlsFile, JSON.stringify({
    schema_version: 1,
    incidents: [{
      incident_id: 'legacy-rate-hold', severity: 'SEV_1', scope: 'platform',
      event_class: 'platform_warning', incident_class: 'provider_rate_limit', provider: 'GitHub',
      signal: 'secondary_rate_limit', occurred_at: '2026-07-18T12:14:00.000Z',
    }],
    closures: [],
    hold_clearances: [],
  }));
  return {controlsFile, resourceControlFile, gatewayStateDir};
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
      event_class: 'platform_warning', incident_class: 'provider_rate_limit', provider: 'GitHub',
      signal: 'GITHUB_SECONDARY_RATE_LIMIT', tripped_at: '2026-07-18T12:14:00.000Z',
      occurred_at: '2026-07-18T12:14:00Z',
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
        cleared_at: '2026-07-18T14:00:00Z',
        cleared_pause: {signal: 'GITHUB_SECONDARY_RATE_LIMIT', tripped_at: '2026-07-18T12:14:00.000Z'}}] : []),
    ],
  }));
  const resourcePause = {
    kind: 'PROVIDER_THROTTLED', provider: 'GitHub', signal: 'GITHUB_SECONDARY_RATE_LIMIT',
    tripped_at: '2026-07-18T12:14:00.000Z', incident_id: 'github-secondary-rate-limit', auto_resume: false,
  };
  const unrelatedPause = {
    kind: 'PROVIDER_THROTTLED', provider: 'GitHub', signal: 'HTTP_429',
    tripped_at: '2026-07-17T12:14:00.000Z', incident_id: 'prior-platform-hold', auto_resume: false,
  };
  await writeFile(resourceControlFile, JSON.stringify({
    schema_version: 1,
    provider_pause: resourcePause,
    exception_task_ids: [],
    active_exception: null,
    provider_pause_clearances: usedDecisionLocation === 'resource'
      ? [{...priorClearance, provider_pause: unrelatedPause}] : [],
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
      ? [{...priorClearance, provider_pause: unrelatedPause}] : [],
    waves: {},
  }));
  return {controlsFile, resourceControlFile, gatewayStateDir};
}

test('clear-hold CLI requires a founder decision ID', () => {
  assert.throws(() => parseControlsCliArgs([
    'clear-hold', '--hold-id', 'incident:github-secondary-rate-limit',
  ]), /founder-decision-id is required/i);
});

test('migrate-legacy-hold accepts only a hold ID and never a founder decision', () => {
  assert.equal(parseControlsCliArgs([
    'migrate-legacy-hold', '--hold-id', 'incident:legacy-rate-hold',
  ]).holdId, 'incident:legacy-rate-hold');
  assert.throws(() => parseControlsCliArgs([
    'migrate-legacy-hold', '--hold-id', 'incident:legacy-rate-hold',
    '--founder-decision-id', 'not-valid-for-migration',
  ]), /not valid for migrate-legacy-hold/i);
});

test('migrate-legacy-hold refuses unknown, cleared, wrong-class, and ambiguous pause state', async (t) => {
  const incident = {
    incident_id: 'legacy-rate-hold', severity: 'SEV_1', scope: 'platform',
    event_class: 'platform_warning', incident_class: 'provider_rate_limit', provider: 'GitHub',
    signal: 'secondary_rate_limit', occurred_at: '2026-07-18T12:14:00.000Z',
  };
  for (const scenario of ['unknown', 'cleared', 'wrong-class', 'resource-pause', 'gateway-pause']) {
    await t.test(scenario, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `campaign-controls-cli-migrate-${scenario}-`));
      t.after(() => rm(root, {recursive: true, force: true}));
      const controlsFile = path.join(root, 'control-state.json');
      const resourceControlFile = path.join(root, 'resource-control.json');
      const gatewayStateDir = path.join(root, 'gateway-state');
      const selected = scenario === 'unknown' ? [] : [{...incident,
        ...(scenario === 'wrong-class' ? {incident_class: 'authorization'} : {})}];
      await writeFile(controlsFile, JSON.stringify({
        schema_version: 1,
        incidents: selected,
        closures: [],
        hold_clearances: scenario === 'cleared' ? [{
          hold_id: 'incident:legacy-rate-hold', founder_decision_id: 'already-cleared',
          cleared_at: '2026-07-18T13:00:00.000Z',
        }] : [],
      }));
      if (scenario === 'resource-pause') {
        await writeFile(resourceControlFile, JSON.stringify({
          schema_version: 1,
          provider_pause: {kind: 'PROVIDER_THROTTLED', provider: 'GitHub', signal: 'HTTP_429',
            tripped_at: '2026-07-18T12:00:00.000Z', auto_resume: false},
        }));
      }
      if (scenario === 'gateway-pause') {
        await mkdir(gatewayStateDir, {recursive: true});
        await writeFile(path.join(gatewayStateDir, 'state.json'), JSON.stringify({
          schema_version: 1, last_request_at_ms: null, last_completed_at_ms: null, last_class: null,
          provider_pause: {kind: 'PROVIDER_THROTTLED', provider: 'GitHub', signal: 'HTTP_429',
            tripped_at: '2026-07-18T12:00:00.000Z', auto_resume: false},
          provider_pause_clearances: [], waves: {},
        }));
      }
      const expected = scenario === 'unknown' ? /unknown/i
        : scenario === 'cleared' ? /already cleared/i
          : scenario === 'wrong-class' ? /not a provider_rate_limit/i
            : /does not match .* migration provenance and binding/i;
      await assert.rejects(() => runControlsCli([
        'migrate-legacy-hold', '--controls-state', controlsFile,
        '--resource-control', resourceControlFile, '--gateway-state', gatewayStateDir,
        '--hold-id', 'incident:legacy-rate-hold',
      ], {stdout: outputSink().stream}), expected);
    });
  }
});

test('migrate-legacy-hold retries after every write and creates only missing matching peers', async (t) => {
  for (const failedAfter of ['migrate-campaign', 'migrate-resource', 'migrate-gateway']) {
    await t.test(failedAfter, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `campaign-controls-cli-migrate-retry-${failedAfter}-`));
      t.after(() => rm(root, {recursive: true, force: true}));
      const paths = await seedMigrationHold(root);
      const argv = [
        'migrate-legacy-hold', '--controls-state', paths.controlsFile,
        '--resource-control', paths.resourceControlFile, '--gateway-state', paths.gatewayStateDir,
        '--hold-id', 'incident:legacy-rate-hold',
      ];
      let injected = false;
      let resourceWrites = 0;
      let gatewayWrites = 0;
      const dependencies = {
        stdout: outputSink().stream,
        now: () => new Date('2026-07-18T19:00:00.000Z'),
        resourceMigrateImpl: async (...args) => {
          resourceWrites += 1;
          return migratePersistentProviderThrottle(...args);
        },
        gatewayMigrateImpl: async (options) => {
          gatewayWrites += 1;
          return migrateLegacyGhGatewayThrottle(options);
        },
        afterTransitionStep: async (step) => {
          if (!injected && step === failedAfter) {
            injected = true;
            throw new Error(`injected failure after ${step}`);
          }
        },
      };
      await assert.rejects(() => runControlsCli(argv, dependencies), /injected failure/);
      const result = await runControlsCli(argv, {
        ...dependencies,
        now: () => new Date('2026-07-18T20:00:00.000Z'),
      });
      const resourcePause = (await loadResourceControl(paths.resourceControlFile)).provider_pause;
      const gatewayPause = JSON.parse(await readFile(path.join(paths.gatewayStateDir, 'state.json'), 'utf8')).provider_pause;
      const campaignIncident = JSON.parse(await readFile(paths.controlsFile, 'utf8')).incidents[0];
      assert.equal(campaignIncident.incident_id, 'legacy-rate-hold');
      assert.equal(campaignIncident.signal, 'GITHUB_SECONDARY_RATE_LIMIT');
      assert.equal(campaignIncident.tripped_at, '2026-07-18T12:14:00.000Z');
      assert.equal(campaignIncident.migrated_at, '2026-07-18T19:00:00.000Z');
      for (const pause of [resourcePause, gatewayPause]) {
        assert.equal(pause.incident_id, 'legacy-rate-hold');
        assert.equal(pause.migrated_from_incident, 'legacy-rate-hold');
        assert.equal(pause.signal, 'GITHUB_SECONDARY_RATE_LIMIT');
        assert.equal(pause.tripped_at, '2026-07-18T12:14:00.000Z');
        assert.equal(pause.migrated_at, '2026-07-18T19:00:00.000Z');
      }
      assert.deepEqual(result.provider_pause, resourcePause);
      assert.deepEqual(result.gateway_provider_pause, gatewayPause);
      assert.equal(resourceWrites, 1, 'matching resource peer is never rewritten');
      assert.equal(gatewayWrites, 1, 'matching gateway peer is never rewritten');
    });
  }
});

test('migrate-legacy-hold refuses a partial peer whose provenance, incident ID, signal, or trip time mismatches', async (t) => {
  for (const mismatch of ['incident', 'incident-id', 'signal', 'tripped-at']) {
    await t.test(mismatch, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `campaign-controls-cli-migrate-mismatch-${mismatch}-`));
      t.after(() => rm(root, {recursive: true, force: true}));
      const paths = await seedMigrationHold(root);
      const pause = {
        kind: 'PROVIDER_THROTTLED', provider: 'GitHub', signal: 'GITHUB_SECONDARY_RATE_LIMIT',
        tripped_at: '2026-07-18T12:14:00.000Z', incident_id: 'legacy-rate-hold', auto_resume: false,
        migrated_from_incident: 'legacy-rate-hold', migrated_at: '2026-07-18T19:00:00.000Z',
        ...(mismatch === 'incident' ? {migrated_from_incident: 'another-incident'} : {}),
        ...(mismatch === 'incident-id' ? {incident_id: 'another-incident'} : {}),
        ...(mismatch === 'signal' ? {signal: 'HTTP_429'} : {}),
        ...(mismatch === 'tripped-at' ? {tripped_at: '2026-07-18T12:15:00.000Z'} : {}),
      };
      await writeFile(paths.resourceControlFile, JSON.stringify({schema_version: 1, provider_pause: pause}));
      await assert.rejects(() => runControlsCli([
        'migrate-legacy-hold', '--controls-state', paths.controlsFile,
        '--resource-control', paths.resourceControlFile, '--gateway-state', paths.gatewayStateDir,
        '--hold-id', 'incident:legacy-rate-hold',
      ], {stdout: outputSink().stream}), /does not match .* migration provenance and binding/i);
      await assert.rejects(readFile(path.join(paths.gatewayStateDir, 'state.json'), 'utf8'), {code: 'ENOENT'});
    });
  }
});

test('migrate-legacy-hold accepts a matching gateway-only partial state and creates the missing resource peer', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-controls-cli-migrate-gateway-partial-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const paths = await seedMigrationHold(root);
  const pause = {
    kind: 'PROVIDER_THROTTLED', provider: 'GitHub', signal: 'GITHUB_SECONDARY_RATE_LIMIT',
    tripped_at: '2026-07-18T12:14:00.000Z', incident_id: 'legacy-rate-hold', auto_resume: false,
    migrated_from_incident: 'legacy-rate-hold', migrated_at: '2026-07-18T19:00:00.000Z',
  };
  await mkdir(paths.gatewayStateDir, {recursive: true});
  await writeFile(path.join(paths.gatewayStateDir, 'state.json'), JSON.stringify({
    schema_version: 1, last_request_at_ms: null, last_completed_at_ms: null, last_class: null,
    provider_pause: pause, provider_pause_clearances: [], pending_incident: null, probe_required: null, waves: {},
  }));
  let gatewayWrites = 0;
  const result = await runControlsCli([
    'migrate-legacy-hold', '--controls-state', paths.controlsFile,
    '--resource-control', paths.resourceControlFile, '--gateway-state', paths.gatewayStateDir,
    '--hold-id', 'incident:legacy-rate-hold',
  ], {
    stdout: outputSink().stream,
    now: () => new Date('2026-07-18T20:00:00.000Z'),
    gatewayMigrateImpl: async () => {
      gatewayWrites += 1;
      throw new Error('matching gateway peer must not be rewritten');
    },
  });
  assert.equal(gatewayWrites, 0);
  assert.deepEqual((await loadResourceControl(paths.resourceControlFile)).provider_pause, pause);
  assert.deepEqual(result.restrictions_added, ['persistent_provider_throttle']);
  assert.deepEqual(result.gateway_provider_pause, pause);
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
      event_class: 'platform_warning', incident_class: 'provider_rate_limit', provider: 'GitHub',
      signal: 'GITHUB_SECONDARY_RATE_LIMIT', tripped_at: '2026-07-18T12:14:00.000Z',
      occurred_at: '2026-07-18T12:14:00Z',
    }],
    closures: [],
    hold_clearances: [],
  }));
  const boundPause = {
    kind: 'PROVIDER_THROTTLED', provider: 'GitHub', signal: 'GITHUB_SECONDARY_RATE_LIMIT',
    tripped_at: '2026-07-18T12:14:00.000Z', incident_id: 'github-secondary-rate-limit', auto_resume: false,
  };
  await writeFile(resourceControlFile, JSON.stringify({
    schema_version: 1,
    provider_pause: boundPause,
    exception_task_ids: [],
    active_exception: null,
    provider_pause_clearances: [],
  }));
  await mkdir(gatewayStateDir, {recursive: true});
  await writeFile(path.join(gatewayStateDir, 'state.json'), JSON.stringify({
    schema_version: 1,
    last_request_at_ms: null,
    last_completed_at_ms: null,
    last_class: null,
    provider_pause: boundPause,
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
  assert.deepEqual(gatewayState.probe_required, {
    set_at: '2026-07-18T15:00:00.000Z',
    cleared_hold_id: 'incident:github-secondary-rate-limit',
  });
  const state = JSON.parse(await readFile(controlsFile, 'utf8'));
  assert.equal(state.hold_clearances[0].founder_decision_id, 'founder-rate-resume-1');
  assert.deepEqual(state.hold_clearances[0].cleared_pause, {
    signal: 'GITHUB_SECONDARY_RATE_LIMIT', tripped_at: '2026-07-18T12:14:00.000Z',
  });
  assert.deepEqual(control.provider_pause_clearances[0].cleared_pause, {
    signal: 'GITHUB_SECONDARY_RATE_LIMIT', tripped_at: '2026-07-18T12:14:00.000Z',
  });
  assert.deepEqual(gatewayState.provider_pause_clearances[0].cleared_pause, {
    signal: 'GITHUB_SECONDARY_RATE_LIMIT', tripped_at: '2026-07-18T12:14:00.000Z',
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
  ], {stdout: outputSink().stream}), /already cleared with a different founder decision ID/i);
  assert.equal(await readFile(paths.resourceControlFile, 'utf8'), beforeResource);
  assert.equal(await readFile(path.join(paths.gatewayStateDir, 'state.json'), 'utf8'), beforeGateway);
});

test('clear-hold retries after each peer clear with the same decision and rejects a new decision', async (t) => {
  for (const failedAfter of ['clear-campaign', 'clear-resource', 'clear-gateway']) {
    await t.test(failedAfter, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `campaign-controls-cli-clear-retry-${failedAfter}-`));
      t.after(() => rm(root, {recursive: true, force: true}));
      const paths = await seedClearanceState(root);
      const argv = [
        'clear-hold', '--controls-state', paths.controlsFile,
        '--resource-control', paths.resourceControlFile, '--gateway-state', paths.gatewayStateDir,
        '--hold-id', 'incident:github-secondary-rate-limit',
        '--founder-decision-id', 'founder-retry-clear-1',
      ];
      let injected = false;
      let resourceWrites = 0;
      let gatewayWrites = 0;
      const dependencies = {
        stdout: outputSink().stream,
        now: () => new Date('2026-07-18T15:00:00.000Z'),
        resourceClearImpl: async (...args) => {
          resourceWrites += 1;
          return clearPersistentProviderThrottle(...args);
        },
        gatewayClearImpl: async (options) => {
          gatewayWrites += 1;
          return clearGhGatewayThrottle(options);
        },
        afterTransitionStep: async (step) => {
          if (!injected && step === failedAfter) {
            injected = true;
            throw new Error(`injected failure after ${step}`);
          }
        },
      };
      await assert.rejects(() => runControlsCli(argv, dependencies), /injected failure/);
      const result = await runControlsCli(argv, {
        ...dependencies,
        now: () => new Date('2026-07-18T16:00:00.000Z'),
      });
      assert.equal(result.hold_clearance.founder_decision_id, 'founder-retry-clear-1');
      assert.equal(result.provider_throttle_clearance.founder_decision_id, 'founder-retry-clear-1');
      assert.equal(result.gateway_throttle_clearance.founder_decision_id, 'founder-retry-clear-1');
      for (const clearance of [result.hold_clearance, result.provider_throttle_clearance,
        result.gateway_throttle_clearance]) {
        assert.equal(clearance.cleared_at, '2026-07-18T15:00:00.000Z');
      }
      assert.equal(resourceWrites, 1, 'matching resource clearance is never rewritten');
      assert.equal(gatewayWrites, 1, 'matching gateway clearance/probe is never rewritten');
      assert.deepEqual(JSON.parse(await readFile(path.join(paths.gatewayStateDir, 'state.json'), 'utf8')).probe_required, {
        set_at: '2026-07-18T15:00:00.000Z',
        cleared_hold_id: 'incident:github-secondary-rate-limit',
      });

      const sameDecision = await runControlsCli(argv, {
        ...dependencies,
        now: () => new Date('2026-07-18T17:00:00.000Z'),
      });
      assert.deepEqual(sameDecision, result);
      assert.equal(resourceWrites, 1);
      assert.equal(gatewayWrites, 1);

      const before = await Promise.all([
        readFile(paths.controlsFile, 'utf8'),
        readFile(paths.resourceControlFile, 'utf8'),
        readFile(path.join(paths.gatewayStateDir, 'state.json'), 'utf8'),
      ]);
      await assert.rejects(() => runControlsCli([
        ...argv.slice(0, -1), 'founder-retry-clear-2',
      ], {stdout: outputSink().stream}), /already cleared with a different founder decision ID/i);
      assert.deepEqual(await Promise.all([
        readFile(paths.controlsFile, 'utf8'),
        readFile(paths.resourceControlFile, 'utf8'),
        readFile(path.join(paths.gatewayStateDir, 'state.json'), 'utf8'),
      ]), before);
    });
  }
});

test('clear-hold same-decision retry repairs a missing gateway resume probe', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-controls-cli-clear-probe-repair-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const paths = await seedClearanceState(root);
  const argv = [
    'clear-hold', '--controls-state', paths.controlsFile,
    '--resource-control', paths.resourceControlFile, '--gateway-state', paths.gatewayStateDir,
    '--hold-id', 'incident:github-secondary-rate-limit',
    '--founder-decision-id', 'founder-probe-repair-1',
  ];
  await runControlsCli(argv, {
    stdout: outputSink().stream,
    now: () => new Date('2026-07-18T15:00:00.000Z'),
  });
  const gatewayStateFile = path.join(paths.gatewayStateDir, 'state.json');
  const interrupted = JSON.parse(await readFile(gatewayStateFile, 'utf8'));
  interrupted.probe_required = null;
  await writeFile(gatewayStateFile, `${JSON.stringify(interrupted, null, 2)}\n`);
  const result = await runControlsCli(argv, {
    stdout: outputSink().stream,
    now: () => new Date('2026-07-18T16:00:00.000Z'),
  });
  assert.equal(result.gateway_throttle_clearance.founder_decision_id, 'founder-probe-repair-1');
  assert.deepEqual(JSON.parse(await readFile(gatewayStateFile, 'utf8')).probe_required, {
    set_at: '2026-07-18T15:00:00.000Z',
    cleared_hold_id: 'incident:github-secondary-rate-limit',
  });
});

test('snapshot prints the active campaign hold and future-clock condition without changing control state', async (t) => {
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
  const resourceControlFile = path.join(root, 'resource-control.json');
  const gatewayStateDir = path.join(root, 'gateway-state');
  const ledgerFile = path.join(root, 'gh-request-ledger.jsonl');
  await mkdir(gatewayStateDir, {recursive: true});
  await writeFile(path.join(gatewayStateDir, 'daily-request-budget.json'), JSON.stringify({
    schema_version: 1,
    date_utc: '2099-01-01',
    daily_cap: 2_000,
    used_today: 12,
    throttle_seen_today: false,
    alert_emitted_today: false,
    history: [],
  }));
  const locks = [];
  await runControlsCli([
    'snapshot', '--controls-state', controlsFile, '--resource-control', resourceControlFile,
    '--gateway-state', gatewayStateDir,
  ], {
    stdout: output.stream,
    gatewayWithLockImpl: async (options, callback) => {
      locks.push(options);
      return callback();
    },
  });
  const snapshot = JSON.parse(output.value());
  assert.equal(snapshot.global_publication_hold.active, true);
  assert.equal(snapshot.github_daily_budget.clock_regression.active, true);
  assert.equal(snapshot.github_daily_budget.clock_regression.stored_date_utc, '2099-01-01');
  assert.equal(await readFile(controlsFile, 'utf8'), before);
  assert.deepEqual(locks, [{stateDir: gatewayStateDir, ledgerFile,
    controlStateFile: controlsFile, resourceControlFile}]);
});

test('budget prints the read-only gateway budget view including alert state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-controls-cli-budget-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const gatewayStateDir = path.join(root, 'gateway-state');
  const ledgerFile = path.join(root, 'gh-request-ledger.jsonl');
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
  assert.deepEqual(calls, [{stateDir: gatewayStateDir, ledgerFile}]);
});

test('repair-clock requires a founder decision and delegates under the configured gateway lock', async (t) => {
  assert.throws(() => parseControlsCliArgs(['repair-clock']), /founder-decision-id is required/i);
  assert.throws(() => parseControlsCliArgs([
    'repair-clock', '--founder-decision-id', 'clock-fix-1', '--hold-id', 'not-valid',
  ]), /hold-id is not valid/i);
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-controls-cli-repair-clock-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const controlsFile = path.join(root, 'control-state.json');
  const resourceControlFile = path.join(root, 'resource-control.json');
  const gatewayStateDir = path.join(root, 'gateway-state');
  const ledgerFile = path.join(root, 'gh-request-ledger.jsonl');
  const calls = [];
  const expected = {operation: 'repair-clock', founder_decision_id: 'clock-fix-1'};
  const result = await runControlsCli([
    'repair-clock', '--controls-state', controlsFile, '--resource-control', resourceControlFile,
    '--gateway-state', gatewayStateDir, '--founder-decision-id', 'clock-fix-1',
  ], {
    stdout: outputSink().stream,
    gatewayWithLockImpl: async (options, callback) => {
      calls.push({kind: 'lock', options});
      return callback();
    },
    gatewayBudgetRepairImpl: async (options) => {
      calls.push({kind: 'repair', options});
      return expected;
    },
  });
  assert.deepEqual(result, expected);
  assert.deepEqual(calls, [{
    kind: 'lock',
    options: {stateDir: gatewayStateDir, ledgerFile, controlStateFile: controlsFile, resourceControlFile},
  }, {
    kind: 'repair',
    options: {stateDir: gatewayStateDir, ledgerFile, controlStateFile: controlsFile, resourceControlFile,
      founderDecisionId: 'clock-fix-1', gatewayLockHeld: true},
  }]);
});

test('repair-throttle-state requires a founder decision and owns its reconciliation-skipping lock', async (t) => {
  assert.throws(() => parseControlsCliArgs(['repair-throttle-state']), /founder-decision-id is required/i);
  assert.throws(() => parseControlsCliArgs([
    'repair-throttle-state', '--founder-decision-id', 'throttle-fix-1', '--hold-id', 'not-valid',
  ]), /hold-id is not valid/i);
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-controls-cli-repair-throttle-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const controlsFile = path.join(root, 'control-state.json');
  const resourceControlFile = path.join(root, 'resource-control.json');
  const gatewayStateDir = path.join(root, 'gateway-state');
  const ledgerFile = path.join(root, 'gh-request-ledger.jsonl');
  const calls = [];
  const expected = {repaired: true, audit_record: {founder_decision_id: 'throttle-fix-1'}};
  const markerDigest = 'a'.repeat(64);
  const result = await runControlsCli([
    'repair-throttle-state', '--controls-state', controlsFile, '--resource-control', resourceControlFile,
    '--gateway-state', gatewayStateDir, '--founder-decision-id', 'throttle-fix-1',
    '--expected-incident-id', 'github-http-429-20260718T120000Z',
    '--expected-marker-digest', markerDigest,
  ], {
    stdout: outputSink().stream,
    gatewayWithLockImpl: async () => { throw new Error('repair must own its specialized lock'); },
    gatewayThrottleRepairImpl: async (options) => {
      calls.push(options);
      return expected;
    },
  });
  assert.deepEqual(result, expected);
  assert.deepEqual(calls, [{
    stateDir: gatewayStateDir,
    ledgerFile,
    controlStateFile: controlsFile,
    resourceControlFile,
    founderDecisionId: 'throttle-fix-1',
    expectedIncidentId: 'github-http-429-20260718T120000Z',
    expectedMarkerDigest: markerDigest,
    expectedOldPeerDigests: null,
    expectedNewPeerDigests: null,
  }]);
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
  assert.equal(calls[0].options.resumeProbe, true);
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
    OSS_GH_CANONICAL_ROOT: root,
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
