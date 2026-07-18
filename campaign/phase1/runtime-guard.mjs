import {readFile} from 'node:fs/promises';
import path from 'node:path';

import {openCampaignControls} from './controls.mjs';
import {ShiftSchedule} from './schedule.mjs';

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonnegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number`);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonnegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function repositoryName(value) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(String(value ?? ''));
  if (!match) throw new Error(`Phase-1 runtime repository must be owner/repo: ${value}`);
  return `${match[1]}/${match[2]}`.toLowerCase();
}

function blocked(action, reason) {
  throw new Error(`Phase-1 runtime blocked ${action}: ${reason}`);
}

export async function assertPhase1Runtime(runtimeFile, {
  action,
  repositories = [],
  units = 1,
  monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n),
  now = () => new Date(),
} = {}) {
  if (!runtimeFile) return {active: false};
  if (!['discover', 'qualify', 'prepare', 'ship'].includes(action)) throw new Error('Phase-1 runtime action is invalid');

  const absolute = path.resolve(runtimeFile);
  const runtime = JSON.parse(await readFile(absolute, 'utf8'));
  if (!isObject(runtime) || runtime.schema_version !== 1 || runtime.active !== true) {
    throw new Error('Phase-1 runtime must have schema_version 1 and active true');
  }

  const observedMonotonicMs = finiteNonnegative(monotonicMs(), 'runtime monotonic clock');
  const observedNow = now();
  if (!(observedNow instanceof Date) || !Number.isFinite(observedNow.getTime())) {
    throw new Error('Phase-1 runtime wall clock is invalid');
  }
  const schedule = new ShiftSchedule({
    clock: {monotonicMs: () => observedMonotonicMs, wallMs: () => observedNow.getTime()},
    lanes: positiveInteger(runtime.lanes, 'runtime lanes'),
    p75_attempt_start_interval_ms: runtime.p75_attempt_start_interval_ms,
    max_ntp_offset_ms: runtime.max_ntp_offset_ms,
  });
  if (!isObject(runtime.ntp)) throw new Error('Phase-1 runtime ntp observation is required');
  schedule.recordNtpHealth(runtime.ntp);
  if (schedule.ntpState().state === 'HOLD') blocked(action, 'NTP_HOLD');

  if (action === 'qualify') {
    if (!isObject(runtime.qualification)) throw new Error('Phase-1 runtime qualification state is required');
    const firstStart = finiteNonnegative(
      runtime.qualification.predicted_prepare_start_monotonic_ms,
      'predicted_prepare_start_monotonic_ms',
    );
    const qualifiedAhead = runtime.qualification.qualified_ahead;
    if (!Number.isInteger(qualifiedAhead) || qualifiedAhead < 0) {
      throw new Error('qualified_ahead must be a non-negative integer');
    }
    nonnegativeInteger(units, 'runtime qualification units');
    for (let index = 0; index < units; index += 1) {
      const decision = schedule.canQualify({
        predicted_prepare_start_monotonic_ms: firstStart + index * runtime.p75_attempt_start_interval_ms,
        qualified_ahead: qualifiedAhead + index,
      });
      if (!decision.allowed) blocked(action, decision.reason);
    }
  }

  if (action === 'prepare') {
    const decision = schedule.canPrepare({board_monotonic_ms: runtime.board_monotonic_ms});
    if (!decision.allowed) blocked(action, decision.reason);
  }

  if (typeof runtime.controls_state_file !== 'string' || !runtime.controls_state_file.trim()) {
    throw new Error('Phase-1 runtime controls_state_file is required');
  }
  const controlsFile = path.resolve(path.dirname(absolute), runtime.controls_state_file);
  const controls = await openCampaignControls(controlsFile);
  const snapshot = controls.snapshot({now: observedNow});
  if (snapshot.global_publication_hold.active) {
    blocked(action, 'GLOBAL_PUBLICATION_HOLD');
  }
  for (const repository of [...new Set(repositories.map(repositoryName))]) {
    if (snapshot.repository_holds[repository]?.active) blocked(action, `REPOSITORY_HOLD ${repository}`);
  }

  return {active: true, action};
}
