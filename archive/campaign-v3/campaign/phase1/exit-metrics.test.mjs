import assert from 'node:assert/strict';
import test from 'node:test';

import {buildExitSnapshot} from './exit-metrics.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function timestamp(start, offsetMs) {
  return new Date(Date.parse(start) + offsetMs).toISOString();
}

function passingInput() {
  const fix = '2026-07-17T00:00:00.000Z';
  const periods = [
    {start_at: timestamp(fix, -DAY), end_at: fix, A_SHIPPED_PUBLIC: 99},
    ...Array.from({length: 3}, (_, index) => ({
      start_at: timestamp(fix, index * DAY),
      end_at: timestamp(fix, (index + 1) * DAY),
      A_SHIPPED_PUBLIC: 10,
    })),
  ];
  const attempts = Array.from({length: 50}, (_, index) => ({
    attempt_id: `A-${index}`,
    task_id: `TASK-${index}`,
    started_at: timestamp(fix, HOUR + index * 1000),
    attempt_sequence: index < 25 ? 1 : 2,
    state: index < 25 ? 'READY' : 'FAILED_ORACLE',
    prepare_duration_ms: 20 * 60 * 1000,
    attribution_complete: index < 48,
  }));
  const tasks = Array.from({length: 30}, (_, index) => ({
    task_id: `T-${index}`,
    terminal_at: timestamp(fix, 2 * HOUR + index * 1000),
    state: index < 21 ? 'SHIPPED' : 'FAILED_ORACLE',
    attempt_count: index === 0 ? 3 : 2,
  }));
  return {
    now: timestamp(fix, 4 * DAY),
    fixes_live_at: fix,
    periods,
    attempts,
    tasks,
    reviews: Array.from({length: 21}, (_, index) => ({receipt_subject_id: `R-${index}`, reviewed_at: timestamp(fix, HOUR), signed: true})),
    incidents: [],
    d8_closed: true,
    lake: {
      fresh_issues: 1000,
      fresh_repositories: 400,
      available_slots: 300,
      phase1_daily_rate: 10,
      p75_lifetime_days: 30,
      owner_concentration_in_policy: true,
      snapshot_at: timestamp(fix, 3 * DAY),
    },
    batch_tests_passed: true,
    restore_test_passed: true,
    pilot_profiles: {python: {production_ready: true}, go: {production_ready: true}},
    fixes_demonstrably_landed: false,
  };
}

test('exit snapshot reports every action-plan threshold and passes only complete evidence', () => {
  const snapshot = buildExitSnapshot(passingInput());
  assert.equal(snapshot.status, 'PASS');
  assert.equal(snapshot.metrics.consecutive_qualifying_24h_periods, 3);
  assert.equal(snapshot.metrics.first_attempt_ready.sample_size, 50);
  assert.equal(snapshot.metrics.first_attempt_ready.rate, 0.5);
  assert.equal(snapshot.metrics.task_to_shipped.sample_size, 30);
  assert.equal(snapshot.metrics.task_to_shipped.rate, 0.7);
  assert.equal(snapshot.metrics.median_attempts_per_receipt, 2);
  assert.ok(snapshot.metrics.third_attempt_rate < 0.05);
  assert.equal(snapshot.metrics.p95_prepare_ms, 20 * 60 * 1000);
  assert.equal(snapshot.metrics.cost_attribution.rate, 0.96);
  assert.equal(snapshot.metrics.available_slot_floor, 300);
  assert.ok(snapshot.checks.every((check) => check.passed));
});

test('pre-fix historical volume never counts toward the three complete periods', () => {
  const input = passingInput();
  input.periods = input.periods.slice(0, 3);
  const snapshot = buildExitSnapshot(input);
  assert.equal(snapshot.metrics.consecutive_qualifying_24h_periods, 2);
  assert.equal(snapshot.status, 'HOLD');
  assert.equal(snapshot.checks.find((check) => check.id === 'three_24h_periods').passed, false);
});

test('trailing windows do not pass without their required sample sizes', () => {
  const input = passingInput();
  input.attempts = input.attempts.slice(1);
  input.tasks = input.tasks.slice(1);
  const snapshot = buildExitSnapshot(input);
  assert.equal(snapshot.metrics.first_attempt_ready.sample_size, 49);
  assert.equal(snapshot.metrics.task_to_shipped.sample_size, 29);
  assert.equal(snapshot.status, 'HOLD');
});

test('workspace mode dashboard reports the per-profile writable-copy share and action band', () => {
  const input = passingInput();
  input.attempts = Array.from({length: 20}, (_, index) => ({
    ...input.attempts[index],
    profile: index < 10 ? 'python' : 'go',
    workspace_mode: index === 0 || index >= 10 && index < 12 ? 'writable_copy' : 'readonly',
  }));
  const snapshot = buildExitSnapshot(input);
  assert.deepEqual(snapshot.metrics.workspace_modes, {
    go: {attempts: 10, writable_copy: 2, writable_copy_share: 0.2, attention: true, investigate: true},
    python: {attempts: 10, writable_copy: 1, writable_copy_share: 0.1, attention: false, investigate: false},
  });
});

test('exit snapshot counts the control ledger SEV_1 spelling', () => {
  const input = passingInput();
  input.incidents = [{
    incident_id: 'i1', severity: 'SEV_1', incident_class: 'authorization',
    occurred_at: timestamp(input.fixes_live_at, HOUR),
  }];
  const snapshot = buildExitSnapshot(input);
  assert.equal(snapshot.metrics.sev1_incidents, 1);
  assert.equal(snapshot.checks.find((check) => check.id === 'sev1').passed, false);
});
