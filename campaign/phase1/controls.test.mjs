import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {evaluateMetricPolicy, evaluateStopCondition, loadControlPolicy, openCampaignControls} from './controls.mjs';
import {assertPhase1Runtime} from './runtime-guard.mjs';

test('metric policy records deterministically warn, stop, and resume', () => {
  const record = {warning: 0.5, stop: 0.35, action: 'hold_profile', resume: {operator: '>=', value: 0.5}};
  assert.deepEqual(evaluateMetricPolicy(record, 0.6), {state: 'pass', action: null});
  assert.deepEqual(evaluateMetricPolicy(record, 0.4), {state: 'warning', action: null});
  assert.deepEqual(evaluateMetricPolicy(record, 0.3), {state: 'stop', action: 'hold_profile'});
  assert.equal(evaluateMetricPolicy(record, 0.5, {resuming: true}).state, 'pass');
});

test('follow-up stop-condition records implement the action-plan thresholds', async () => {
  const policy = await loadControlPolicy();
  assert.equal(policy.stop_conditions.length, 5);
  const messages = policy.stop_conditions.find((record) => record.id === 'unacknowledged_maintainer_messages_over_12h');
  assert.deepEqual(evaluateStopCondition(messages, 5), {triggered: false, action: null});
  assert.deepEqual(evaluateStopCondition(messages, 6), {triggered: true, action: 'hold_all_new_authored_prs'});
  const missedSla = policy.stop_conditions.find((record) => record.id === 'repository_sla_missed');
  assert.equal(evaluateStopCondition(missedSla, 1).triggered, true);
});

test('SEV actions and rate reductions persist with no automatic resume', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-controls-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const file = path.join(root, 'controls.json');
  const gatewayStateDir = path.join(root, 'gateway-state');
  let controls = await openCampaignControls(file, {gatewayStateDir});
  await controls.recordIncident({incident_id: 'i1', severity: 'SEV_1', scope: 'repository', repository: 'Owner/Repo',
    event_class: 'stop_request', occurred_at: '2026-07-17T10:00:00Z'});
  await controls.recordIncident({incident_id: 'i2', severity: 'SEV_1', scope: 'platform',
    event_class: 'platform_warning', occurred_at: '2026-07-17T10:01:00Z'});
  await controls.recordIncident({incident_id: 'i3', severity: 'SEV_2', scope: 'repository', repository: 'Other/One',
    event_class: 'duplicate_work_complaint', occurred_at: '2026-07-15T10:00:00Z'});
  await controls.recordIncident({incident_id: 'i4', severity: 'SEV_2', scope: 'repository', repository: 'Other/Two',
    event_class: 'maintainer_burden', occurred_at: '2026-07-17T10:00:00Z'});
  await controls.recordIncident({incident_id: 'i5', severity: 'SEV_3', scope: 'mission', mission_id: 'M-1',
    event_class: 'implementation_disagreement', occurred_at: '2026-07-17T10:02:00Z'});
  controls = await openCampaignControls(file, {gatewayStateDir});
  const state = controls.snapshot({now: new Date('2026-07-17T12:00:00Z')});
  assert.equal(state.global_publication_hold.active, true);
  assert.equal(state.repository_holds['owner/repo'].active, true);
  assert.equal(state.rate_step_reduction, 1);
  assert.equal(state.mission_outcomes.length, 1);
  await assert.rejects(() => controls.clearHold({hold_id: state.global_publication_hold.hold_id}), /founder decision/i);
  await controls.clearHold({hold_id: state.global_publication_hold.hold_id, founder_decision_id: 'decision-1'});
  assert.equal((await openCampaignControls(file, {gatewayStateDir}))
    .snapshot({now: new Date('2026-07-17T12:00:00Z')}).global_publication_hold.active, false);
});

test('frozen technical SEV-1 classes are durable and require founder clearance', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-controls-technical-sev-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const controls = await openCampaignControls(path.join(root, 'controls.json'), {
    gatewayStateDir: path.join(root, 'gateway-state'),
  });
  await controls.recordIncident({incident_id: 'pr39', severity: 'SEV_1', scope: 'platform',
    event_class: 'unauthorized_publication', incident_class: 'claim', occurred_at: '2026-07-17T20:36:00Z'});
  const hold = controls.snapshot({now: new Date('2026-07-17T21:00:00Z')}).global_publication_hold;
  assert.equal(hold.active, true);
  await controls.clearHold({hold_id: hold.hold_id, founder_decision_id: 'retain-pr39-after-verification'});
  assert.equal(controls.snapshot({now: new Date('2026-07-17T21:01:00Z')}).global_publication_hold.active, false);
});

test('clearing one repository SEV-1 hold cannot mask another active hold for the same repository', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-controls-duplicate-repo-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const file = path.join(root, 'controls.json');
  const controls = await openCampaignControls(file, {gatewayStateDir: path.join(root, 'gateway-state')});
  await controls.recordIncident({incident_id: 'first', severity: 'SEV_1', scope: 'repository', repository: 'Owner/Repo',
    event_class: 'stop_request', occurred_at: '2026-07-17T10:00:00Z'});
  await controls.recordIncident({incident_id: 'second', severity: 'SEV_1', scope: 'repository', repository: 'Owner/Repo',
    event_class: 'spam_accusation', occurred_at: '2026-07-17T10:01:00Z'});
  await controls.clearHold({hold_id: 'incident:second', founder_decision_id: 'decision-2'});
  const state = controls.snapshot({now: new Date('2026-07-17T12:00:00Z')});
  assert.equal(state.repository_holds['owner/repo'].active, true);
  assert.equal(state.repository_holds['owner/repo'].hold_id, 'incident:first');
});

test('global hold blocks every GitHub-touching runtime action', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-global-runtime-hold-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const runtimeFile = path.join(root, 'runtime.json');
  const controlsFile = path.join(root, 'controls.json');
  const monotonicMs = 1_000;
  const now = new Date('2026-07-18T12:30:00Z');
  await writeFile(controlsFile, JSON.stringify({
    schema_version: 1,
    incidents: [{
      incident_id: 'github-secondary-rate-limit', severity: 'SEV_1', scope: 'platform',
      event_class: 'platform_warning', occurred_at: '2026-07-18T12:14:00Z',
    }],
    closures: [],
    hold_clearances: [],
  }));
  await writeFile(runtimeFile, JSON.stringify({
    schema_version: 1,
    active: true,
    controls_state_file: './controls.json',
    lanes: 8,
    p75_attempt_start_interval_ms: 15 * 60 * 1000,
    max_ntp_offset_ms: 1000,
    ntp: {offset_ms: 0, observed_at: now.toISOString()},
    board_monotonic_ms: monotonicMs + 60 * 60 * 1000,
    qualification: {predicted_prepare_start_monotonic_ms: monotonicMs + 30 * 60 * 1000, qualified_ahead: 0},
  }));
  for (const action of ['discover', 'qualify', 'prepare', 'ship']) {
    await assert.rejects(() => assertPhase1Runtime(runtimeFile, {
      action, repositories: ['owner/repo'], monotonicMs: () => monotonicMs, now: () => now,
    }), new RegExp(`Phase-1 runtime blocked ${action}: GLOBAL_PUBLICATION_HOLD`));
  }
});

test('recordIncident waits for an in-flight gateway request and the next request observes the hold', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-controls-gateway-serialization-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const controlStateFile = path.join(root, 'control-state.json');
  const resourceControlFile = path.join(root, 'resource-control.json');
  const gatewayStateDir = path.join(root, 'gateway-state');
  const ledgerFile = path.join(root, 'gh-request-ledger.jsonl');
  const controls = await openCampaignControls(controlStateFile, {gatewayStateDir});
  const {ghRequest} = await import('../../gh-gateway.mjs');
  let letRunnerFinish;
  let markRunnerStarted;
  const runnerStarted = new Promise((resolve) => { markRunnerStarted = resolve; });
  const runnerCanFinish = new Promise((resolve) => { letRunnerFinish = resolve; });
  const requestOptions = {
    stateDir: gatewayStateDir,
    ledgerFile,
    resourceControlFile,
    controlStateFile,
    testMode: true,
    timing: {minSpacingMs: 0, jitterMaxMs: 0, lockPollMs: 1},
  };
  const firstRequest = ghRequest(['api', 'repos/owner/repo'], {
    ...requestOptions,
    runner: async () => {
      markRunnerStarted();
      await runnerCanFinish;
      return {status: 0, stdout: '{}', stderr: ''};
    },
  });
  await runnerStarted;

  let incidentSettled = false;
  const incidentWrite = controls.recordIncident({
    incident_id: 'hold-after-active-request',
    severity: 'SEV_1',
    scope: 'platform',
    event_class: 'platform_warning',
    occurred_at: '2026-07-18T12:14:00Z',
  }).finally(() => { incidentSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(incidentSettled, false);

  letRunnerFinish();
  await firstRequest;
  await incidentWrite;
  assert.equal(incidentSettled, true);
  await assert.rejects(() => ghRequest(['api', 'repos/owner/repo'], {
    ...requestOptions,
    runner: async () => assert.fail('held request must not reach the runner'),
  }), /global hold .* active/i);
});

test('closures are reason-coded and evaluation stays inactive until a prospective minimum is configured and reached', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'campaign-closures-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const controls = await openCampaignControls(path.join(root, 'unconfigured.json'), {
    gatewayStateDir: path.join(root, 'gateway-state'),
  });
  await assert.rejects(() => controls.recordClosure({closure_id: 'bad', reason_code: 'vague'}), /reason code/i);
  await controls.recordClosure({closure_id: 'unconfigured', reason_code: 'process_concern'});
  assert.deepEqual(controls.closureRate({reasonCodes: ['process_concern']}), {
    status: 'policy_unconfigured', samples: 1, minimum_samples: null, matches: 1, rate: null,
  });
  const policy = await loadControlPolicy();
  policy.closure_policy.min_samples = 10;
  const configured = await openCampaignControls(path.join(root, 'configured-prospectively.json'), {
    policy,
    gatewayStateDir: path.join(root, 'gateway-state'),
  });
  for (let index = 0; index < 9; index += 1) {
    await configured.recordClosure({closure_id: `c${index}`, reason_code: index < 2 ? 'process_concern' : 'implementation_disagreement'});
  }
  assert.deepEqual(configured.closureRate({reasonCodes: ['process_concern']}), {
    status: 'insufficient_sample', samples: 9, minimum_samples: 10, matches: 2, rate: null,
  });
  await configured.recordClosure({closure_id: 'c9', reason_code: 'process_concern'});
  assert.equal(configured.closureRate({reasonCodes: ['process_concern']}).rate, 0.3);
});
