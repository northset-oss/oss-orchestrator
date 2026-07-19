export const QUALIFICATION_TTL_MS = 2 * 60 * 60 * 1000;
export const READY_TTL_MS = 8 * 60 * 60 * 1000;
export const BOARD_PREPARE_WINDOW_MS = 6 * 60 * 60 * 1000;
export const JIT_QUALIFICATION_WINDOW_MS = 90 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

function finiteNonnegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isoTimestamp(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

export function maxQualifiedAhead({lanes, p75_attempt_start_interval_ms}) {
  positiveInteger(lanes, 'lanes');
  if (!Number.isFinite(p75_attempt_start_interval_ms) || p75_attempt_start_interval_ms <= 0) {
    throw new Error('p75_attempt_start_interval_ms must be positive');
  }
  return lanes * Math.floor(JIT_QUALIFICATION_WINDOW_MS / p75_attempt_start_interval_ms);
}

export class ShiftSchedule {
  #clock;
  #ntp;

  constructor({clock, lanes, p75_attempt_start_interval_ms, max_ntp_offset_ms}) {
    if (!clock || typeof clock.monotonicMs !== 'function' || typeof clock.wallMs !== 'function') {
      throw new Error('clock must provide monotonicMs() and wallMs()');
    }
    this.#clock = clock;
    this.lanes = positiveInteger(lanes, 'lanes');
    this.p75_attempt_start_interval_ms = p75_attempt_start_interval_ms;
    this.max_qualified_ahead = maxQualifiedAhead({lanes, p75_attempt_start_interval_ms});
    this.max_ntp_offset_ms = finiteNonnegative(max_ntp_offset_ms, 'max_ntp_offset_ms');
    this.#ntp = {state: 'UNKNOWN', max_offset_ms: this.max_ntp_offset_ms, last_observation: null, hold: null};
  }

  canPrepare({board_monotonic_ms}) {
    finiteNonnegative(board_monotonic_ms, 'board_monotonic_ms');
    if (this.#ntp.state === 'HOLD') return {allowed: false, reason: 'NTP_HOLD'};
    const untilBoard = board_monotonic_ms - this.#clock.monotonicMs();
    if (untilBoard < 0) return {allowed: false, reason: 'BOARD_PASSED'};
    if (untilBoard > BOARD_PREPARE_WINDOW_MS) return {allowed: false, reason: 'OUTSIDE_BOARD_WINDOW'};
    return {allowed: true, reason: null, milliseconds_until_board: untilBoard};
  }

  canQualify({predicted_prepare_start_monotonic_ms, qualified_ahead}) {
    finiteNonnegative(predicted_prepare_start_monotonic_ms, 'predicted_prepare_start_monotonic_ms');
    if (!Number.isInteger(qualified_ahead) || qualified_ahead < 0) throw new Error('qualified_ahead must be a non-negative integer');
    if (this.#ntp.state === 'HOLD') return {allowed: false, reason: 'NTP_HOLD'};
    const untilPrepare = predicted_prepare_start_monotonic_ms - this.#clock.monotonicMs();
    if (untilPrepare < 0) return {allowed: false, reason: 'PREDICTED_START_PASSED'};
    if (untilPrepare > JIT_QUALIFICATION_WINDOW_MS) return {allowed: false, reason: 'OUTSIDE_JIT_WINDOW'};
    if (qualified_ahead >= this.max_qualified_ahead) return {allowed: false, reason: 'QUALIFICATION_WATERMARK'};
    return {allowed: true, reason: null, max_qualified_ahead: this.max_qualified_ahead};
  }

  recordNtpHealth({offset_ms, observed_at}) {
    finiteNonnegative(Math.abs(offset_ms), 'offset_ms');
    const observation = {offset_ms, observed_at: isoTimestamp(observed_at, 'observed_at')};
    if (this.#ntp.state === 'HOLD') {
      this.#ntp.last_observation = observation;
      return this.ntpState();
    }
    if (Math.abs(offset_ms) > this.max_ntp_offset_ms) {
      this.#ntp = {
        ...this.#ntp,
        state: 'HOLD',
        last_observation: observation,
        hold: {reason: 'NTP_OFFSET_EXCEEDED', triggered_at: observation.observed_at, observed_offset_ms: offset_ms},
      };
    } else {
      this.#ntp = {...this.#ntp, state: 'HEALTHY', last_observation: observation};
    }
    return this.ntpState();
  }

  releaseNtpHold({operator, reason, released_at}) {
    if (this.#ntp.state !== 'HOLD') throw new Error('NTP hold is not active');
    if (typeof operator !== 'string' || !operator.trim()) throw new Error('operator is required to release an NTP hold');
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('reason is required to release an NTP hold');
    this.#ntp = {
      ...this.#ntp,
      state: 'HEALTHY',
      hold: {...this.#ntp.hold, released_at: isoTimestamp(released_at, 'released_at'), released_by: operator, release_reason: reason},
    };
    return this.ntpState();
  }

  ntpState() { return structuredClone(this.#ntp); }
}

export function simulateFullDay({start_wall_time, lanes, p75_attempt_start_interval_ms, max_ntp_offset_ms}) {
  const startWallMs = Date.parse(isoTimestamp(start_wall_time, 'start_wall_time'));
  let monotonicMs = 0;
  const clock = {monotonicMs: () => monotonicMs, wallMs: () => startWallMs + monotonicMs};
  const schedule = new ShiftSchedule({clock, lanes, p75_attempt_start_interval_ms, max_ntp_offset_ms});
  schedule.recordNtpHealth({offset_ms: 0, observed_at: new Date(startWallMs).toISOString()});
  const events = [];
  const shifts = [];
  const violations = [];

  for (let index = 0; index < 2; index += 1) {
    const shiftStart = index * 12 * HOUR_MS;
    const prepareWindow = shiftStart + 6 * HOUR_MS;
    const board = shiftStart + 12 * HOUR_MS;
    shifts.push({
      shift_id: `SHIFT-${index + 1}`,
      start_monotonic_ms: shiftStart,
      end_monotonic_ms: board,
      first_half: 'FOLLOW_UP_DISCOVERY_REMEDIATION',
      second_half: 'JIT_QUALIFY_PREPARE_REVIEW',
    });
    events.push({kind: 'SHIFT_START', shift_id: `SHIFT-${index + 1}`, monotonic_ms: shiftStart});
    monotonicMs = prepareWindow;
    const prepareDecision = schedule.canPrepare({board_monotonic_ms: board});
    events.push({kind: 'PREPARE_WINDOW_OPEN', shift_id: `SHIFT-${index + 1}`, monotonic_ms: prepareWindow});
    if (!prepareDecision.allowed) violations.push({shift_id: `SHIFT-${index + 1}`, reason: prepareDecision.reason});
    monotonicMs = board;
    events.push({kind: 'BOARD', shift_id: `SHIFT-${index + 1}`, monotonic_ms: board});
    if (index === 0) events.push({kind: 'SIGNED_HANDOFF', from_shift: 'SHIFT-1', to_shift: 'SHIFT-2', monotonic_ms: board});
  }

  return {
    schema_version: 1,
    start_wall_time: new Date(startWallMs).toISOString(),
    duration_ms: 24 * HOUR_MS,
    shifts,
    events,
    max_qualified_ahead: schedule.max_qualified_ahead,
    violations,
  };
}
