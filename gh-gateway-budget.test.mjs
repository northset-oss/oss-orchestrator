import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ghRequest,
  GitHubGatewayRefusalError,
  GitHubThrottleError,
  readGhDailyBudgetState,
  repairGhDailyBudgetClock,
} from './gh-gateway.mjs';

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

function budgetFile(files) {
  return path.join(files.stateDir, 'daily-request-budget.json');
}

function fastOptions(files, clock, additions = {}) {
  return {
    ...files,
    testMode: true,
    now: () => clock.value,
    random: () => 0,
    timing: {
      minSpacingMs: 0,
      searchSpacingMs: 0,
      mutationSpacingMs: 0,
      jitterMaxMs: 0,
      lockPollMs: 2,
    },
    runner: async () => ({code: 0, stdout: '{}', stderr: ''}),
    ...additions,
  };
}

async function persistedBudget(files) {
  return JSON.parse(await readFile(budgetFile(files), 'utf8'));
}

test('clean-day rollover adds a fixed percent-of-starting-cap step and stops at the ceiling', async (t) => {
  const files = await temporaryGateway(t, 'gh-budget-clean-rollover');
  const clock = {value: Date.parse('2026-07-18T12:00:00Z')};
  const options = fastOptions(files, clock, {
    dailyBudget: {startingCap: 10, floor: 1, ceiling: 12},
  });

  await ghRequest(['api', 'rate_limit'], options);
  clock.value = Date.parse('2026-07-19T12:00:00Z');
  await ghRequest(['api', 'rate_limit'], options);
  let state = await persistedBudget(files);
  assert.equal(state.daily_cap, 12);
  assert.deepEqual(state.history, [{
    date_utc: '2026-07-18', daily_cap: 10, used: 1, throttled: false,
  }]);

  clock.value = Date.parse('2026-07-20T12:00:00Z');
  await ghRequest(['api', 'rate_limit'], options);
  state = await persistedBudget(files);
  assert.equal(state.daily_cap, 12);
  assert.deepEqual(state.history.at(-1), {
    date_utc: '2026-07-19', daily_cap: 12, used: 1, throttled: false,
  });
});

test('clean-day increase is truly additive at the default 400-request step', async (t) => {
  const files = await temporaryGateway(t, 'gh-budget-additive-step');
  const clock = {value: Date.parse('2026-07-19T12:00:00Z')};
  await mkdir(files.stateDir, {recursive: true});
  await writeFile(budgetFile(files), `${JSON.stringify({
    schema_version: 1,
    date_utc: '2026-07-18',
    daily_cap: 3_000,
    used_today: 1,
    throttle_seen_today: false,
    alert_emitted_today: false,
    history: [],
  })}\n`);
  await ghRequest(['api', 'rate_limit'], fastOptions(files, clock));
  const state = await persistedBudget(files);
  assert.equal(state.daily_cap, 3_400);
  assert.deepEqual(state.history, [{
    date_utc: '2026-07-18', daily_cap: 3_000, used: 1, throttled: false,
  }]);
});

test('throttle-day rollover halves capacity and clamps at the configured floor', async (t) => {
  for (const [name, cap, expected] of [['halves', 1_200, 600], ['floor-clamp', 600, 500]]) {
    await t.test(name, async (t) => {
      const files = await temporaryGateway(t, `gh-budget-throttle-${name}`);
      const clock = {value: Date.parse('2026-07-19T08:00:00Z')};
      await mkdir(files.stateDir, {recursive: true});
      await writeFile(budgetFile(files), `${JSON.stringify({
        schema_version: 1,
        date_utc: '2026-07-18',
        daily_cap: cap,
        used_today: 7,
        throttle_seen_today: true,
        alert_emitted_today: false,
        history: [],
      })}\n`);
      await ghRequest(['api', 'rate_limit'], fastOptions(files, clock, {
        dailyBudget: {startingCap: 2_000, floor: 500, ceiling: 5_000},
      }));
      const state = await persistedBudget(files);
      assert.equal(state.daily_cap, expected);
      assert.equal(state.used_today, 1);
      assert.deepEqual(state.history, [{
        date_utc: '2026-07-18', daily_cap: cap, used: 7, throttled: true,
      }]);
    });
  }
});

test('persisted caps are clamped to the effective ceiling on same-day admission and throttled rollover', async (t) => {
  const sameDay = await temporaryGateway(t, 'gh-budget-effective-same-day-clamp');
  const clock = {value: Date.parse('2026-07-18T12:00:00Z')};
  await mkdir(sameDay.stateDir, {recursive: true});
  await writeFile(budgetFile(sameDay), `${JSON.stringify({
    schema_version: 1,
    date_utc: '2026-07-18',
    daily_cap: 5_000,
    used_today: 0,
    throttle_seen_today: false,
    alert_emitted_today: false,
    history: [],
  })}\n`);
  const authorizedBudget = {startingCap: 1_000, floor: 500, ceiling: 1_000};
  await ghRequest(['api', 'rate_limit'], fastOptions(sameDay, clock, {dailyBudget: authorizedBudget}));
  assert.equal((await persistedBudget(sameDay)).daily_cap, 1_000);

  const rollover = await temporaryGateway(t, 'gh-budget-effective-rollover-clamp');
  await mkdir(rollover.stateDir, {recursive: true});
  await writeFile(budgetFile(rollover), `${JSON.stringify({
    schema_version: 1,
    date_utc: '2026-07-18',
    daily_cap: 5_000,
    used_today: 7,
    throttle_seen_today: true,
    alert_emitted_today: false,
    history: [],
  })}\n`);
  clock.value = Date.parse('2026-07-19T12:00:00Z');
  await ghRequest(['api', 'rate_limit'], fastOptions(rollover, clock, {dailyBudget: authorizedBudget}));
  const rolled = await persistedBudget(rollover);
  assert.equal(rolled.daily_cap, 500);
  assert.deepEqual(rolled.history, [{
    date_utc: '2026-07-18', daily_cap: 5_000, used: 7, throttled: true,
  }]);
});

test('daily budget exhaustion refuses without invoking the runner', async (t) => {
  const files = await temporaryGateway(t, 'gh-budget-exhaustion');
  const clock = {value: Date.parse('2026-07-18T12:00:00Z')};
  let calls = 0;
  const options = fastOptions(files, clock, {
    dailyBudget: {startingCap: 2, floor: 1, ceiling: 2},
    runner: async () => {
      calls += 1;
      return {code: 0, stdout: '{}', stderr: ''};
    },
  });
  await ghRequest(['api', 'rate_limit'], options);
  await ghRequest(['api', 'rate_limit'], options);
  await assert.rejects(
    () => ghRequest(['api', 'rate_limit'], options),
    (error) => error instanceof GitHubGatewayRefusalError &&
      error.reason === 'daily-budget-exhausted',
  );
  assert.equal(calls, 2);
  assert.equal((await persistedBudget(files)).used_today, 2);
});

test('budget alert is emitted once when usage crosses 75 percent', async (t) => {
  const files = await temporaryGateway(t, 'gh-budget-alert');
  const clock = {value: Date.parse('2026-07-18T12:00:00Z')};
  const options = fastOptions(files, clock, {
    dailyBudget: {startingCap: 4, floor: 1, ceiling: 4},
  });
  for (let index = 0; index < 4; index += 1) {
    await ghRequest(['api', 'rate_limit'], options);
  }
  const ledger = (await readFile(files.ledgerFile, 'utf8')).trim().split('\n').map(JSON.parse);
  const alerts = ledger.filter((entry) => entry.event === 'budget_alert');
  assert.equal(alerts.length, 1);
  assert.deepEqual({
    date_utc: alerts[0].date_utc,
    daily_cap: alerts[0].daily_cap,
    used_today: alerts[0].used_today,
    threshold_percent: alerts[0].threshold_percent,
    threshold_requests: alerts[0].threshold_requests,
  }, {
    date_utc: '2026-07-18', daily_cap: 4, used_today: 3,
    threshold_percent: 75, threshold_requests: 3,
  });
  assert.equal((await persistedBudget(files)).alert_emitted_today, true);
});

test('failed budget alert append leaves the alert eligible for retry', async (t) => {
  const files = await temporaryGateway(t, 'gh-budget-alert-retry');
  const clock = {value: Date.parse('2026-07-18T12:00:00Z')};
  await mkdir(files.stateDir, {recursive: true});
  await writeFile(budgetFile(files), `${JSON.stringify({
    schema_version: 1,
    date_utc: '2026-07-18',
    daily_cap: 4,
    used_today: 2,
    throttle_seen_today: false,
    alert_emitted_today: false,
    history: [],
  })}\n`);
  await mkdir(files.ledgerFile);
  const options = fastOptions(files, clock, {
    dailyBudget: {startingCap: 4, floor: 1, ceiling: 4},
  });

  await assert.rejects(
    () => ghRequest(['api', 'rate_limit'], options),
    (error) => error instanceof GitHubGatewayRefusalError && error.reason === 'ledger-write-error',
  );
  assert.equal((await persistedBudget(files)).alert_emitted_today, false);

  await rm(files.ledgerFile, {recursive: true});
  await ghRequest(['api', 'rate_limit'], options);
  const ledger = (await readFile(files.ledgerFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(ledger.filter((entry) => entry.event === 'budget_alert').length, 1);
  assert.equal((await persistedBudget(files)).alert_emitted_today, true);
});

test('daily budget mutations serialize under the gateway lock', async (t) => {
  const files = await temporaryGateway(t, 'gh-budget-lock-serialization');
  const clock = {value: Date.parse('2026-07-18T12:00:00Z')};
  let calls = 0;
  let firstEntered;
  let releaseFirst;
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  const held = new Promise((resolve) => { releaseFirst = resolve; });
  const options = fastOptions(files, clock, {
    dailyBudget: {startingCap: 10, floor: 1, ceiling: 10},
    runner: async () => {
      calls += 1;
      if (calls === 1) {
        firstEntered();
        await held;
      }
      return {code: 0, stdout: '{}', stderr: ''};
    },
  });

  const first = ghRequest(['api', 'rate_limit'], options);
  await entered;
  const second = ghRequest(['api', 'rate_limit'], options);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await persistedBudget(files)).used_today, 1);
  assert.equal(calls, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal((await persistedBudget(files)).used_today, 2);
  assert.equal(calls, 2);
});

test('throttle detection marks the budget day before the durable latch throws', async (t) => {
  const files = await temporaryGateway(t, 'gh-budget-throttle-mark');
  const clock = {value: Date.parse('2026-07-18T12:00:00Z')};
  const options = fastOptions(files, clock, {
    dailyBudget: {startingCap: 10, floor: 2, ceiling: 10},
    runner: async () => ({
      code: 1,
      stdout: '',
      stderr: 'HTTP 429 Too Many Requests',
    }),
  });
  await assert.rejects(
    () => ghRequest(['api', 'rate_limit'], options),
    (error) => error instanceof GitHubThrottleError,
  );
  const state = await persistedBudget(files);
  assert.equal(state.used_today, 1);
  assert.equal(state.throttle_seen_today, true);
  const view = await readGhDailyBudgetState(options);
  assert.equal(view.throttle_seen_today, true);
});

test('budget inspection synthesizes and projects state without writing or rolling the file', async (t) => {
  const files = await temporaryGateway(t, 'gh-budget-read-only');
  const clock = {value: Date.parse('2026-07-19T12:00:00Z')};
  const options = fastOptions(files, clock, {
    dailyBudget: {startingCap: 10, floor: 1, ceiling: 20},
  });
  const absentView = await readGhDailyBudgetState(options);
  assert.equal(absentView.date_utc, '2026-07-19');
  assert.equal(absentView.daily_cap, 10);
  await assert.rejects(() => readFile(budgetFile(files)), {code: 'ENOENT'});

  await mkdir(files.stateDir, {recursive: true});
  const stored = `${JSON.stringify({
    schema_version: 1,
    date_utc: '2026-07-18',
    daily_cap: 10,
    used_today: 1,
    throttle_seen_today: false,
    alert_emitted_today: false,
    history: [],
  }, null, 2)}\n`;
  await writeFile(budgetFile(files), stored);
  const projected = await readGhDailyBudgetState(options);
  assert.equal(projected.date_utc, '2026-07-19');
  assert.equal(projected.daily_cap, 12);
  assert.equal(projected.alert.emitted_today, false);
  assert.equal(await readFile(budgetFile(files), 'utf8'), stored);
});

test('environment budget overrides require and ledger a founder decision', async (t) => {
  const rejected = await temporaryGateway(t, 'gh-budget-env-rejected');
  const rejectedClock = {value: Date.parse('2026-07-18T12:00:00Z')};
  const rejectedOptions = fastOptions(rejected, rejectedClock, {env: {
    ...process.env,
    OSS_GH_DAILY_BUDGET_STARTING_CAP: '3333',
    OSS_GH_DAILY_BUDGET_CEILING: '4444',
  }});
  const rejectedView = await readGhDailyBudgetState(rejectedOptions);
  assert.equal(rejectedView.daily_cap, 2_000);
  assert.deepEqual(rejectedView.budget_override, {
    requested: true, accepted: false, decision_id: null, values: {},
  });
  await readGhDailyBudgetState(rejectedOptions);
  let ledger = (await readFile(rejected.ledgerFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(ledger.filter((entry) => entry.event === 'budget_override_rejected').length, 1);
  assert.deepEqual(ledger[0].requested_values, {startingCap: '3333', ceiling: '4444'});
  assert.equal(ledger[0].effective_values, null);
  assert.equal(ledger[0].reason, 'founder-decision-required');
  assert.match(ledger[0].state_dir_digest, /^[0-9a-f]{8}$/);

  const accepted = await temporaryGateway(t, 'gh-budget-env-accepted');
  const acceptedClock = {value: Date.parse('2026-07-18T12:00:00Z')};
  const acceptedOptions = fastOptions(accepted, acceptedClock, {env: {
    ...process.env,
    OSS_GH_DAILY_BUDGET_STARTING_CAP: '3334',
    OSS_GH_DAILY_BUDGET_CEILING: '4445',
    OSS_GH_DAILY_BUDGET_OVERRIDE_DECISION_ID: 'founder-budget-override-1',
  }});
  const acceptedView = await readGhDailyBudgetState(acceptedOptions);
  assert.equal(acceptedView.daily_cap, 3_334);
  assert.deepEqual(acceptedView.budget_override, {
    requested: true,
    accepted: true,
    decision_id: 'founder-budget-override-1',
    values: {startingCap: '3334', ceiling: '4445'},
  });
  ledger = (await readFile(accepted.ledgerFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(ledger.filter((entry) => entry.event === 'budget_override').length, 1);
  assert.equal(ledger[0].decision_id, 'founder-budget-override-1');
  assert.deepEqual(ledger[0].requested_values, {startingCap: '3334', ceiling: '4445'});
  assert.deepEqual(ledger[0].effective_values, {
    startingCap: 3334,
    ceiling: 4445,
    floor: 500,
    alertThresholdPercent: 75,
    additiveIncreasePercent: 20,
    multiplicativeDecreasePercent: 50,
  });
});

test('contradictory environment budget overrides are rejected without raising policy defaults', async (t) => {
  const files = await temporaryGateway(t, 'gh-budget-env-contradictory');
  const clock = {value: Date.parse('2026-07-18T12:00:00Z')};
  const options = fastOptions(files, clock, {env: {
    ...process.env,
    OSS_GH_DAILY_BUDGET_STARTING_CAP: '1000',
    OSS_GH_DAILY_BUDGET_FLOOR: '10000',
    OSS_GH_DAILY_BUDGET_CEILING: '1000',
    OSS_GH_DAILY_BUDGET_OVERRIDE_DECISION_ID: 'founder-invalid-budget-1',
  }});
  const view = await readGhDailyBudgetState(options);
  assert.equal(view.daily_cap, 2_000);
  assert.deepEqual(view.budget_override, {
    requested: true, accepted: false, decision_id: 'founder-invalid-budget-1', values: {},
  });
  const ledger = (await readFile(files.ledgerFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].event, 'budget_override_rejected');
  assert.equal(ledger[0].decision_id, 'founder-invalid-budget-1');
  assert.equal(ledger[0].reason, 'floor-exceeds-ceiling');
  assert.deepEqual(ledger[0].requested_values, {
    startingCap: '1000', ceiling: '1000', floor: '10000',
  });
  assert.equal(ledger[0].effective_values, null);
});

test('malformed and explicitly empty environment budget overrides are rejected as complete sets', async (t) => {
  for (const [name, value, reason] of [
    ['fractional', '12.5', 'startingCap-must-be-an-integer'],
    ['empty', '', 'startingCap-must-be-an-integer'],
  ]) {
    await t.test(name, async (t) => {
      const files = await temporaryGateway(t, `gh-budget-env-${name}`);
      const clock = {value: Date.parse('2026-07-18T12:00:00Z')};
      const view = await readGhDailyBudgetState(fastOptions(files, clock, {env: {
        ...process.env,
        OSS_GH_DAILY_BUDGET_STARTING_CAP: value,
        OSS_GH_DAILY_BUDGET_OVERRIDE_DECISION_ID: `founder-invalid-${name}-budget-1`,
      }}));
      assert.equal(view.daily_cap, 2_000);
      assert.equal(view.budget_override.accepted, false);
      const ledger = JSON.parse((await readFile(files.ledgerFile, 'utf8')).trim());
      assert.equal(ledger.event, 'budget_override_rejected');
      assert.equal(ledger.reason, reason);
      assert.deepEqual(ledger.requested_values, {startingCap: value});
    });
  }
});

test('future budget dates are readable, requests fail closed, and founder repair restores service', async (t) => {
  const files = await temporaryGateway(t, 'gh-budget-clock-repair');
  const clock = {value: Date.parse('2026-07-18T12:00:00Z')};
  await mkdir(files.stateDir, {recursive: true});
  await writeFile(budgetFile(files), `${JSON.stringify({
    schema_version: 1,
    date_utc: '2026-07-20',
    daily_cap: 2_000,
    used_today: 17,
    throttle_seen_today: false,
    alert_emitted_today: false,
    history: [],
  })}\n`);
  const options = fastOptions(files, clock);
  const view = await readGhDailyBudgetState(options);
  assert.deepEqual(view.clock_regression, {
    active: true,
    stored_date_utc: '2026-07-20',
    clock_date_utc: '2026-07-18',
  });
  await assert.rejects(
    () => ghRequest(['api', 'rate_limit'], options),
    (error) => error instanceof GitHubGatewayRefusalError &&
      error.reason === 'daily-budget-clock-regression',
  );
  const repaired = await repairGhDailyBudgetClock({
    ...options,
    founderDecisionId: 'founder-clock-repair-1',
  });
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.date_utc, '2026-07-18');
  assert.equal(repaired.used_today, 17);
  await ghRequest(['api', 'rate_limit'], options);
  assert.equal((await persistedBudget(files)).used_today, 18);
  const ledger = (await readFile(files.ledgerFile, 'utf8')).trim().split('\n').map(JSON.parse);
  const event = ledger.find((entry) => entry.event === 'daily_budget_clock_repaired');
  assert.equal(event.founder_decision_id, 'founder-clock-repair-1');
  assert.equal(event.previous_date_utc, '2026-07-20');
});
