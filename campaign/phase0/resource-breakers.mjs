import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_POLICY = Object.freeze({
  max_model_minutes_per_attempt: 12,
  max_standard_attempts_per_task: 3,
  max_standard_lane_hours_per_task: 2,
  receipt_lane_hour_flag_above: 2,
  exception_task_share: 0.01,
  max_active_exceptions: 1,
  max_exception_lane_hours: 4,
});

export async function loadResourceControl(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value?.schema_version !== 1) throw new Error('resource-control schema_version must equal 1');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {schema_version: 1, provider_pause: null, exception_task_ids: [], active_exception: null};
    throw error;
  }
}

export function assertPhase0Spec(spec) {
  if (spec?.schema_version !== 2 || typeof spec.task_id !== 'string' || !spec.task_id ||
      !Number.isInteger(spec.attempt_sequence) || spec.attempt_sequence < 1) {
    throw new Error('Phase 0 campaign execution requires schema_version 2 with task identity and attempt sequence');
  }
  return true;
}

export function assertTaskResourcePolicy(spec, control = {}) {
  if (control.provider_pause) throw new Error('pipeline is paused for founder review after a provider throttle');
  if (!Number.isInteger(spec?.attempt_sequence) || spec.attempt_sequence < 1) return true;
  const used = Number(control.task_lane_hours_used ?? 0);
  if (!Number.isFinite(used) || used < 0) throw new Error('task lane-hour usage is invalid');
  if (spec.attempt_sequence <= DEFAULT_POLICY.max_standard_attempts_per_task) {
    if (used >= DEFAULT_POLICY.max_standard_lane_hours_per_task) throw new Error('task exhausted the 2.0 lane-hour standard cap');
    return true;
  }
  const active = control.active_exception;
  if (!active || active.task_id !== spec.task_id) throw new Error('task exhausted three standard attempts and requires the exception lane');
  if (typeof active.expected_value_note !== 'string' || active.expected_value_note.trim().length < 20) {
    throw new Error('exception lane requires a written expected-value note');
  }
  if (!Number.isFinite(active.lane_hours_used) || active.lane_hours_used < 0 ||
      active.lane_hours_used >= DEFAULT_POLICY.max_exception_lane_hours || used >= DEFAULT_POLICY.max_exception_lane_hours) {
    throw new Error('exception task has exhausted its 4.0 lane-hour cap');
  }
  if (!Number.isInteger(control.campaign_tasks) || control.campaign_tasks < 1) {
    throw new Error('exception lane requires the campaign task denominator');
  }
  const ids = [...new Set(control.exception_task_ids ?? [])];
  if (!ids.includes(spec.task_id) || ids.length > Math.floor(control.campaign_tasks * DEFAULT_POLICY.exception_task_share)) {
    throw new Error('exception lane exceeds the 1% campaign task limit');
  }
  return true;
}

export function remainingTaskLaneMs(spec, control = {}) {
  const used = Number(control.task_lane_hours_used ?? 0);
  const cap = spec?.attempt_sequence > DEFAULT_POLICY.max_standard_attempts_per_task
    ? DEFAULT_POLICY.max_exception_lane_hours : DEFAULT_POLICY.max_standard_lane_hours_per_task;
  return Math.max(0, Math.floor((cap - used) * 60 * 60 * 1000));
}

export async function resourceUsageForTask(runsDir, taskId) {
  if (typeof taskId !== 'string' || !taskId) return 0;
  let total = 0;
  const entries = await readdir(runsDir, {withFileTypes: true}).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let record;
    try { record = JSON.parse(await readFile(path.join(runsDir, entry.name, 'attempt.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (record.task_id !== taskId) continue;
    let hours = Number(record.lane_hours);
    if (!Number.isFinite(hours)) {
      const began = Date.parse(record.started_at);
      const ended = Date.parse(record.updated_at);
      hours = Number.isFinite(began) && Number.isFinite(ended) ? Math.max(0, ended - began) / 3_600_000 : 0;
    }
    total += hours;
  }
  return total;
}

export function isProviderThrottle(error) {
  return /(?:^|\b)(?:429|rate[ -]?limit(?:ed)?|throttl(?:e|ed|ing))\b/i.test(String(error?.message ?? error ?? ''));
}

export async function tripPersistentProviderThrottle(file, {provider, signal, at = new Date().toISOString()} = {}) {
  const value = await loadResourceControl(file);
  if (!value.provider_pause) {
    value.provider_pause = {kind: 'PROVIDER_THROTTLED', provider, signal, tripped_at: at, auto_resume: false};
    await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
  }
  return value.provider_pause;
}

export class ResourceBreakers {
  constructor(policy = DEFAULT_POLICY) {
    this.policy = {...DEFAULT_POLICY, ...policy};
    this.attempts = [];
    this.receipts = [];
    this.exceptions = new Map();
    this.exceptionTasks = new Set();
    this.pause = null;
  }

  assertCanStart({task_id, lane = 'standard'}) {
    if (this.pause) throw new Error('pipeline is paused for founder review after a provider throttle');
    const attempts = this.attempts.filter((item) => item.task_id === task_id);
    const laneHours = attempts.reduce((sum, item) => sum + item.lane_hours, 0);
    if (lane === 'standard' && attempts.filter((item) => item.lane === 'standard').length >= this.policy.max_standard_attempts_per_task) {
      throw new Error('task exhausted three standard attempts and requires the exception lane');
    }
    if (lane === 'standard' && laneHours >= this.policy.max_standard_lane_hours_per_task) {
      throw new Error('task exhausted the 2.0 lane-hour standard cap');
    }
    if (lane === 'exception' && !this.exceptions.has(task_id)) throw new Error('exception lane is not active for this task');
    return true;
  }

  recordAttempt({task_id, lane = 'standard', model_minutes, lane_hours, outcome = null}) {
    if (typeof task_id !== 'string' || !task_id) throw new Error('task_id is required');
    if (!Number.isFinite(model_minutes) || model_minutes < 0 || model_minutes > this.policy.max_model_minutes_per_attempt) {
      throw new Error('each model attempt is capped at 12 minutes');
    }
    if (!Number.isFinite(lane_hours) || lane_hours < 0) throw new Error('lane_hours must be nonnegative');
    if (lane === 'exception') {
      if (!this.exceptions.has(task_id)) throw new Error('exception lane is not active for this task');
      const used = this.attempts.filter((item) => item.task_id === task_id && item.lane === 'exception')
        .reduce((sum, item) => sum + item.lane_hours, 0);
      if (used + lane_hours > this.policy.max_exception_lane_hours) throw new Error('exception tasks are capped at 4.0 lane-hours');
    } else {
      const used = this.attempts.filter((item) => item.task_id === task_id)
        .reduce((sum, item) => sum + item.lane_hours, 0);
      if (used + lane_hours > this.policy.max_standard_lane_hours_per_task) throw new Error('standard tasks are capped at 2.0 lane-hours');
    }
    const record = {task_id, lane, model_minutes, lane_hours, outcome};
    this.attempts.push(record);
    return record;
  }

  startException({task_id, expected_value_note, campaign_tasks}) {
    if (this.exceptions.size >= this.policy.max_active_exceptions) throw new Error('only one active exception is allowed');
    if (typeof expected_value_note !== 'string' || expected_value_note.trim().length < 20) {
      throw new Error('exception lane requires a written expected-value note');
    }
    if (!Number.isInteger(campaign_tasks) || campaign_tasks < 1) throw new Error('campaign_tasks must be a positive integer');
    const allowed = Math.floor(campaign_tasks * this.policy.exception_task_share);
    if (allowed < 1 || this.exceptionTasks.size + 1 > allowed) throw new Error('exception lane cannot exceed 1% of campaign tasks');
    this.exceptions.set(task_id, {task_id, expected_value_note});
    this.exceptionTasks.add(task_id);
    return this.exceptions.get(task_id);
  }

  finishException(task_id) {
    if (!this.exceptions.delete(task_id)) throw new Error('exception task is not active');
  }

  recordReceipt({receipt_subject_id, lane_hours}) {
    if (!/^sha256:[0-9a-f]{64}$/i.test(receipt_subject_id ?? '')) throw new Error('receipt_subject_id is invalid');
    if (!Number.isFinite(lane_hours) || lane_hours < 0) throw new Error('lane_hours must be nonnegative');
    const record = {receipt_subject_id, lane_hours, flagged: lane_hours > this.policy.receipt_lane_hour_flag_above};
    this.receipts.push(record);
    return record;
  }

  tripSubscriptionThrottle({provider, signal}) {
    if (this.pause) return this.pause;
    this.pause = {kind: 'PROVIDER_THROTTLED', provider, signal, auto_resume: false};
    return this.pause;
  }

  resume(signedFounderDecision = null) {
    if (!signedFounderDecision || typeof signedFounderDecision.signature !== 'string') {
      throw new Error('resume requires a signed founder decision');
    }
    this.pause = null;
  }
}
