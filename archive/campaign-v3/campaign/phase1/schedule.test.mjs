import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOARD_PREPARE_WINDOW_MS,
  JIT_QUALIFICATION_WINDOW_MS,
  QUALIFICATION_TTL_MS,
  READY_TTL_MS,
  ShiftSchedule,
  maxQualifiedAhead,
  simulateFullDay,
} from './schedule.mjs';

const HOUR = 60 * 60 * 1000;

function clockAt(monotonicMs = 0, wallMs = Date.parse('2026-07-18T00:00:00Z')) {
  return {
    monotonicMs: () => monotonicMs,
    wallMs: () => wallMs,
    setMonotonic(value) { monotonicMs = value; },
  };
}

test('schedule freezes the two TTLs, six-hour board window, and 90-minute JIT watermark', () => {
  assert.equal(QUALIFICATION_TTL_MS, 2 * HOUR);
  assert.equal(READY_TTL_MS, 8 * HOUR);
  assert.equal(BOARD_PREPARE_WINDOW_MS, 6 * HOUR);
  assert.equal(JIT_QUALIFICATION_WINDOW_MS, 90 * 60 * 1000);
  assert.equal(maxQualifiedAhead({lanes: 8, p75_attempt_start_interval_ms: 15 * 60 * 1000}), 48);
});

test('schedule uses an injected monotonic clock and keeps an NTP hold latched', () => {
  const clock = clockAt();
  const schedule = new ShiftSchedule({
    clock,
    lanes: 4,
    p75_attempt_start_interval_ms: 15 * 60 * 1000,
    max_ntp_offset_ms: 500,
  });

  const boardAt = 12 * HOUR;
  clock.setMonotonic(5 * HOUR);
  assert.equal(schedule.canPrepare({board_monotonic_ms: boardAt}).allowed, false);
  clock.setMonotonic(6 * HOUR);
  assert.equal(schedule.canPrepare({board_monotonic_ms: boardAt}).allowed, true);
  assert.equal(schedule.canQualify({predicted_prepare_start_monotonic_ms: 7.5 * HOUR, qualified_ahead: 0}).allowed, true);
  assert.equal(schedule.canQualify({predicted_prepare_start_monotonic_ms: 8 * HOUR, qualified_ahead: 0}).allowed, false);

  assert.equal(schedule.recordNtpHealth({offset_ms: 750, observed_at: '2026-07-18T06:00:00Z'}).state, 'HOLD');
  assert.equal(schedule.recordNtpHealth({offset_ms: 10, observed_at: '2026-07-18T06:01:00Z'}).state, 'HOLD');
  assert.equal(schedule.canPrepare({board_monotonic_ms: boardAt}).reason, 'NTP_HOLD');
  schedule.releaseNtpHold({operator: 'Aysajan', reason: 'clock source verified', released_at: '2026-07-18T06:02:00Z'});
  assert.equal(schedule.ntpState().state, 'HEALTHY');
});

test('deterministic simulation covers one full day, two shifts, signed handoff, and both boards', () => {
  const result = simulateFullDay({
    start_wall_time: '2026-07-18T00:00:00Z',
    lanes: 8,
    p75_attempt_start_interval_ms: 15 * 60 * 1000,
    max_ntp_offset_ms: 500,
  });

  assert.equal(result.duration_ms, 24 * HOUR);
  assert.equal(result.shifts.length, 2);
  assert.deepEqual(result.events.filter((event) => event.kind === 'BOARD').map((event) => event.monotonic_ms), [12 * HOUR, 24 * HOUR]);
  assert.deepEqual(result.events.filter((event) => event.kind === 'PREPARE_WINDOW_OPEN').map((event) => event.monotonic_ms), [6 * HOUR, 18 * HOUR]);
  assert.deepEqual(result.events.filter((event) => event.kind === 'SIGNED_HANDOFF').map((event) => event.monotonic_ms), [12 * HOUR]);
  assert.deepEqual(result.violations, []);
});
