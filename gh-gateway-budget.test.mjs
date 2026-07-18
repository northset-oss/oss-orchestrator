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

test('clean-day rollover adds 20 percent and stops at the configured ceiling', async (t) => {
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
