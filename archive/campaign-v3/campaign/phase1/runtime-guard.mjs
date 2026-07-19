import {readFile} from 'node:fs/promises';
import path from 'node:path';

import {openCampaignControls} from './controls.mjs';

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
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
  units: _units = 1,
  monotonicMs: _monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n),
  now = () => new Date(),
} = {}) {
  if (!runtimeFile) return {active: false};
  if (!['discover', 'qualify', 'prepare', 'ship'].includes(action)) throw new Error('Phase-1 runtime action is invalid');

  const absolute = path.resolve(runtimeFile);
  const runtime = JSON.parse(await readFile(absolute, 'utf8'));
  if (!isObject(runtime) || runtime.schema_version !== 1 || runtime.active !== true) {
    throw new Error('Phase-1 runtime must have schema_version 1 and active true');
  }

  const observedNow = now();
  if (!(observedNow instanceof Date) || !Number.isFinite(observedNow.getTime())) {
    throw new Error('Phase-1 runtime wall clock is invalid');
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
