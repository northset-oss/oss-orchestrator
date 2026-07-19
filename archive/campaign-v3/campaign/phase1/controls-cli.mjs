#!/usr/bin/env node

import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  clearPersistentProviderThrottle,
  loadResourceControl,
  migratePersistentProviderThrottle,
} from '../phase0/resource-breakers.mjs';
import {openCampaignControls} from './controls.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_FILE), '..', '..');
const DEFAULT_CONTROL_STATE = path.join(REPO_ROOT, 'runs', 'phase1', 'control-state.json');
const DEFAULT_RESOURCE_CONTROL = path.join(REPO_ROOT, 'runs', 'phase0', 'resource-control.json');
const DEFAULT_GATEWAY_STATE = path.join(REPO_ROOT, 'runs', 'gh-gateway-state');
const DEFAULT_LEDGER = path.join(REPO_ROOT, 'runs', 'gh-request-ledger.jsonl');

function takeValue(values, flag) {
  const index = values.indexOf(flag);
  if (index === -1) return null;
  const value = values[index + 1];
  if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  values.splice(index, 2);
  return value;
}

export function parseControlsCliArgs(argv) {
  const values = [...argv];
  const command = values.shift();
  if (!['snapshot', 'clear-hold', 'migrate-legacy-hold', 'probe', 'budget', 'repair-clock',
    'repair-throttle-state'].includes(command)) {
    throw new Error('command must be snapshot, clear-hold, migrate-legacy-hold, probe, budget, repair-clock, or repair-throttle-state');
  }
  const controlStateFile = path.resolve(takeValue(values, '--controls-state') ?? DEFAULT_CONTROL_STATE);
  const resourceControlFile = path.resolve(takeValue(values, '--resource-control') ?? DEFAULT_RESOURCE_CONTROL);
  const gatewayStateValue = takeValue(values, '--gateway-state');
  const gatewayStateDir = path.resolve(gatewayStateValue ?? DEFAULT_GATEWAY_STATE);
  const ledgerFile = path.resolve(takeValue(values, '--ledger') ??
    (gatewayStateValue ? path.join(path.dirname(gatewayStateDir), 'gh-request-ledger.jsonl') : DEFAULT_LEDGER));
  const holdId = takeValue(values, '--hold-id');
  const founderDecisionId = takeValue(values, '--founder-decision-id');
  const expectedIncidentId = takeValue(values, '--expected-incident-id');
  const expectedMarkerDigest = takeValue(values, '--expected-marker-digest');
  const expectedOldPeerDigests = takeValue(values, '--expected-old-peer-digests');
  const expectedNewPeerDigests = takeValue(values, '--expected-new-peer-digests');
  if (values.length) throw new Error(`unknown argument ${values[0]}`);
  if (command === 'clear-hold') {
    if (!holdId) throw new Error('--hold-id is required for clear-hold');
    if (!founderDecisionId) throw new Error('--founder-decision-id is required for clear-hold');
    if (expectedIncidentId || expectedMarkerDigest || expectedOldPeerDigests || expectedNewPeerDigests) {
      throw new Error('throttle repair binding arguments are only valid for repair-throttle-state');
    }
  } else if (command === 'migrate-legacy-hold') {
    if (!holdId) throw new Error('--hold-id is required for migrate-legacy-hold');
    if (founderDecisionId) throw new Error('--founder-decision-id is not valid for migrate-legacy-hold');
    if (expectedIncidentId || expectedMarkerDigest || expectedOldPeerDigests || expectedNewPeerDigests) {
      throw new Error('throttle repair binding arguments are only valid for repair-throttle-state');
    }
  } else if (command === 'repair-clock' || command === 'repair-throttle-state') {
    if (holdId) throw new Error(`--hold-id is not valid for ${command}`);
    if (!founderDecisionId) throw new Error(`--founder-decision-id is required for ${command}`);
    if (command === 'repair-throttle-state') {
      if (!expectedIncidentId) throw new Error('--expected-incident-id is required for repair-throttle-state');
      if (!expectedMarkerDigest) throw new Error('--expected-marker-digest is required for repair-throttle-state');
      if (Boolean(expectedOldPeerDigests) !== Boolean(expectedNewPeerDigests)) {
        throw new Error('repair-throttle-state requires both --expected-old-peer-digests and --expected-new-peer-digests');
      }
    } else if (expectedIncidentId || expectedMarkerDigest || expectedOldPeerDigests || expectedNewPeerDigests) {
      throw new Error('throttle repair binding arguments are only valid for repair-throttle-state');
    }
  } else if (holdId || founderDecisionId) {
    throw new Error('--hold-id is only valid for clear-hold or migrate-legacy-hold; --founder-decision-id is only valid for clear-hold, repair-clock, or repair-throttle-state');
  } else if (expectedIncidentId || expectedMarkerDigest || expectedOldPeerDigests || expectedNewPeerDigests) {
    throw new Error('throttle repair binding arguments are only valid for repair-throttle-state');
  }
  return {command, controlStateFile, resourceControlFile, gatewayStateDir, ledgerFile, holdId,
    founderDecisionId, expectedIncidentId, expectedMarkerDigest, expectedOldPeerDigests,
    expectedNewPeerDigests};
}

async function gatewayRequest(argv, options) {
  const {ghRequest} = await import('../../gh-gateway.mjs');
  return ghRequest(argv, options);
}

async function clearGatewayThrottle(options) {
  const {clearGhGatewayThrottle} = await import('../../gh-gateway.mjs');
  return clearGhGatewayThrottle(options);
}

async function readGatewayControlState(options) {
  const {readGhGatewayControlState} = await import('../../gh-gateway.mjs');
  return readGhGatewayControlState(options);
}

async function migrateGatewayThrottle(options) {
  const {migrateLegacyGhGatewayThrottle} = await import('../../gh-gateway.mjs');
  return migrateLegacyGhGatewayThrottle(options);
}

async function readGatewayBudgetState(options) {
  const {readGhDailyBudgetState} = await import('../../gh-gateway.mjs');
  return readGhDailyBudgetState(options);
}

async function repairGatewayBudgetClock(options) {
  const {repairGhDailyBudgetClock} = await import('../../gh-gateway.mjs');
  return repairGhDailyBudgetClock(options);
}

async function repairGatewayThrottleState(options) {
  const {repairGhThrottleState} = await import('../../gh-gateway.mjs');
  return repairGhThrottleState(options);
}

async function withGatewayLock(options, callback) {
  const {withGhGatewayLock} = await import('../../gh-gateway.mjs');
  return withGhGatewayLock(options, callback);
}

function printJson(stdout, value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function gatewayLockOptions(options) {
  return {
    stateDir: options.gatewayStateDir,
    ledgerFile: options.ledgerFile,
    controlStateFile: options.controlStateFile,
    resourceControlFile: options.resourceControlFile,
  };
}

function canonicalTimestamp(value, description) {
  if (!Number.isFinite(Date.parse(value ?? ''))) throw new Error(`${description} timestamp is invalid`);
  return new Date(value).toISOString();
}

function expectedBinding(incident, {allowLegacyTripAlias = false} = {}) {
  if (typeof incident?.incident_id !== 'string' || !incident.incident_id.trim()) {
    throw new Error('provider throttle incident has no incident ID');
  }
  if (typeof incident.signal !== 'string' || !incident.signal.trim()) {
    throw new Error(`hold incident:${incident.incident_id} has no provider throttle signal`);
  }
  const occurredAt = canonicalTimestamp(incident.occurred_at, `hold incident:${incident.incident_id}`);
  const trippedAt = incident.tripped_at === undefined && allowLegacyTripAlias
    ? occurredAt
    : canonicalTimestamp(incident.tripped_at, `hold incident:${incident.incident_id} trip`);
  if (trippedAt !== occurredAt) {
    throw new Error(`hold incident:${incident.incident_id} tripped_at conflicts with occurred_at`);
  }
  return {
    incidentId: incident.incident_id.trim(),
    signal: normalizeIncidentSignal(incident.signal),
    trippedAt,
  };
}

function assertPauseBinding(pause, binding, description, {migration = false} = {}) {
  if (!pause || typeof pause !== 'object' || Array.isArray(pause)) {
    throw new Error(`${description} is missing`);
  }
  const incidentId = pause.incident_id;
  const actual = {
    incidentId: typeof incidentId === 'string' ? incidentId.trim() : null,
    signal: typeof pause.signal === 'string' && pause.signal.trim()
      ? normalizeIncidentSignal(pause.signal) : null,
    trippedAt: Number.isFinite(Date.parse(pause.tripped_at ?? ''))
      ? new Date(pause.tripped_at).toISOString() : null,
  };
  const migrationMatches = !migration || pause.migrated_from_incident === binding.incidentId;
  if (pause.provider !== 'GitHub' || !migrationMatches || actual.incidentId !== binding.incidentId ||
      actual.signal !== binding.signal || actual.trippedAt !== binding.trippedAt) {
    throw new Error(`${description} does not match incident ${binding.incidentId} migration provenance and binding`);
  }
  return pause;
}

function matchingPeerClearance(clearances, founderDecisionId, binding, description) {
  const selected = (clearances ?? []).filter((item) => item?.founder_decision_id === founderDecisionId);
  if (selected.length > 1) throw new Error(`founder decision ID ${founderDecisionId} has ambiguous ${description} clearances`);
  if (!selected.length) return null;
  try {
    assertPauseBinding(selected[0].provider_pause, binding, `${description} clearance`);
  } catch {
    throw new Error(`founder decision ID ${founderDecisionId} was already used for a different ${description} binding`);
  }
  return selected[0];
}

function clearanceTimestamp(clearance, description) {
  if (!clearance) return null;
  return canonicalTimestamp(clearance.cleared_at, description);
}

export async function runControlsCli(argv, {
  gatewayRequestImpl = gatewayRequest,
  gatewayClearImpl = clearGatewayThrottle,
  gatewayReadImpl = readGatewayControlState,
  gatewayMigrateImpl = migrateGatewayThrottle,
  gatewayBudgetReadImpl = readGatewayBudgetState,
  gatewayBudgetRepairImpl = repairGatewayBudgetClock,
  gatewayThrottleRepairImpl = repairGatewayThrottleState,
  gatewayWithLockImpl = withGatewayLock,
  resourceLoadImpl = loadResourceControl,
  resourceMigrateImpl = migratePersistentProviderThrottle,
  resourceClearImpl = clearPersistentProviderThrottle,
  afterTransitionStep = async () => {},
  stdout = process.stdout,
  now = () => new Date(),
} = {}) {
  const options = parseControlsCliArgs(argv);
  if (options.command === 'snapshot') {
    const snapshot = await gatewayWithLockImpl(gatewayLockOptions(options), async () => {
      const controls = await openCampaignControls(options.controlStateFile, {
        gatewayStateDir: options.gatewayStateDir,
      });
      const campaign = controls.snapshot({now: now()});
      const budget = await gatewayBudgetReadImpl({
        stateDir: options.gatewayStateDir,
        ledgerFile: options.ledgerFile,
        controlStateFile: options.controlStateFile,
        resourceControlFile: options.resourceControlFile,
        gatewayLockHeld: true,
      });
      return {...campaign, github_daily_budget: budget};
    });
    printJson(stdout, snapshot);
    return snapshot;
  }
  if (options.command === 'budget') {
    const budget = await gatewayBudgetReadImpl({stateDir: options.gatewayStateDir, ledgerFile: options.ledgerFile});
    printJson(stdout, budget);
    return budget;
  }
  if (options.command === 'repair-clock') {
    const repair = await gatewayWithLockImpl(gatewayLockOptions(options), () => gatewayBudgetRepairImpl({
      stateDir: options.gatewayStateDir,
      ledgerFile: options.ledgerFile,
      controlStateFile: options.controlStateFile,
      resourceControlFile: options.resourceControlFile,
      founderDecisionId: options.founderDecisionId.trim(),
      gatewayLockHeld: true,
    }));
    printJson(stdout, repair);
    return repair;
  }
  if (options.command === 'repair-throttle-state') {
    const repair = await gatewayThrottleRepairImpl({
      ...gatewayLockOptions(options),
      founderDecisionId: options.founderDecisionId.trim(),
      expectedIncidentId: options.expectedIncidentId.trim(),
      expectedMarkerDigest: options.expectedMarkerDigest.trim(),
      expectedOldPeerDigests: options.expectedOldPeerDigests,
      expectedNewPeerDigests: options.expectedNewPeerDigests,
    });
    printJson(stdout, repair);
    return repair;
  }
  if (options.command === 'migrate-legacy-hold') {
    const result = await gatewayWithLockImpl(gatewayLockOptions(options), async () => {
      const controls = await openCampaignControls(options.controlStateFile, {
        gatewayStateDir: options.gatewayStateDir,
      });
      const hold = controls.inspectHold(options.holdId);
      if (!hold.known) throw new Error(`hold ${options.holdId} is unknown`);
      if (hold.clearance) throw new Error(`hold ${options.holdId} was already cleared before this invocation`);
      if (hold.incident.incident_class !== 'provider_rate_limit') {
        throw new Error(`hold ${options.holdId} is not a provider_rate_limit incident`);
      }
      if (hold.incident.provider !== 'GitHub') {
        throw new Error(`hold ${options.holdId} is not a GitHub provider incident`);
      }
      if (typeof hold.incident.signal !== 'string' || !hold.incident.signal.trim()) {
        throw new Error(`hold ${options.holdId} has no provider throttle signal`);
      }
      if (!Number.isFinite(Date.parse(hold.incident.occurred_at ?? ''))) {
        throw new Error(`hold ${options.holdId} has an invalid occurred_at timestamp`);
      }
      const sourceSignal = hold.incident.signal;
      let binding = expectedBinding(hold.incident, {allowLegacyTripAlias: true});
      const resourceControl = await resourceLoadImpl(options.resourceControlFile);
      const gatewayState = await gatewayReadImpl({
        stateDir: options.gatewayStateDir,
        ledgerFile: options.ledgerFile,
        controlStateFile: options.controlStateFile,
        resourceControlFile: options.resourceControlFile,
        gatewayLockHeld: true,
      });
      const incidentId = hold.incident.incident_id;
      const normalizedSignal = binding.signal;
      const resourcePause = resourceControl.provider_pause
        ? assertPauseBinding(resourceControl.provider_pause, binding, 'persistent provider throttle', {migration: true})
        : null;
      const gatewayPause = gatewayState.provider_pause
        ? assertPauseBinding(gatewayState.provider_pause, binding, 'GitHub gateway provider throttle', {migration: true})
        : null;
      const existingMigrationTimes = [
        ...(hold.incident.migrated_at === undefined ? [] : [
          canonicalTimestamp(hold.incident.migrated_at, 'campaign migration'),
        ]),
        ...[resourcePause, gatewayPause]
          .filter(Boolean)
          .map((pause, index) => canonicalTimestamp(pause.migrated_at, `${index ? 'gateway' : 'resource'} migration`)),
      ];
      if (new Set(existingMigrationTimes).size > 1) {
        throw new Error('legacy hold migration peers have mismatched migration timestamps');
      }
      const migratedAt = existingMigrationTimes[0] ?? now().toISOString();
      const campaignBinding = await controls.migrateProviderThrottleBinding({
        incident_id: binding.incidentId,
        signal: binding.signal,
        tripped_at: binding.trippedAt,
        migrated_at: migratedAt,
      }, {gatewayLockHeld: true});
      if (campaignBinding.changed) await afterTransitionStep('migrate-campaign', campaignBinding);
      binding = expectedBinding(campaignBinding.incident);
      const migration = {
        provider: hold.incident.provider,
        signal: normalizedSignal,
        trippedAt: binding.trippedAt,
        migratedFromIncident: incidentId,
        migratedAt,
        gatewayLockHeld: true,
        gatewayStateDir: options.gatewayStateDir,
      };
      const restrictionsAdded = [];
      let providerPause = resourcePause;
      if (!providerPause) {
        providerPause = await resourceMigrateImpl(options.resourceControlFile, migration);
        restrictionsAdded.push('persistent_provider_throttle');
        await afterTransitionStep('migrate-resource', {providerPause});
      }
      let reconciledGatewayPause = gatewayPause;
      if (!reconciledGatewayPause) {
        reconciledGatewayPause = await gatewayMigrateImpl({
          ...migration,
          stateDir: options.gatewayStateDir,
          ledgerFile: options.ledgerFile,
          controlStateFile: options.controlStateFile,
          resourceControlFile: options.resourceControlFile,
        });
        restrictionsAdded.push('github_gateway_provider_throttle');
        await afterTransitionStep('migrate-gateway', {gatewayPause: reconciledGatewayPause});
      }
      return {
        operation: 'migrate-legacy-hold',
        hold_id: options.holdId,
        incident_id: incidentId,
        incident_class: hold.incident.incident_class,
        provider: hold.incident.provider,
        source_signal: sourceSignal,
        normalized_signal: normalizedSignal,
        occurred_at: new Date(hold.incident.occurred_at).toISOString(),
        migrated_at: migratedAt,
        founder_decision_id: null,
        restrictions_added: restrictionsAdded,
        restrictions_present: ['persistent_provider_throttle', 'github_gateway_provider_throttle'],
        provider_pause: providerPause,
        gateway_provider_pause: reconciledGatewayPause,
      };
    });
    printJson(stdout, result);
    return result;
  }
  if (options.command === 'clear-hold') {
    const result = await gatewayWithLockImpl(gatewayLockOptions(options), async () => {
      const controls = await openCampaignControls(options.controlStateFile, {
        gatewayStateDir: options.gatewayStateDir,
      });
      const hold = controls.inspectHold(options.holdId);
      if (!hold.known) throw new Error(`hold ${options.holdId} is unknown`);
      if (hold.incident.incident_class !== 'provider_rate_limit' || hold.incident.provider !== 'GitHub') {
        throw new Error(`hold ${options.holdId} is not a GitHub provider_rate_limit incident`);
      }
      if (hold.incident.tripped_at === undefined) {
        throw new Error(
          `hold ${options.holdId} has not been migrated; run 'migrate-legacy-hold --hold-id ${options.holdId}' first`,
        );
      }
      const founderDecisionId = options.founderDecisionId.trim();
      if (hold.clearance && hold.clearance.founder_decision_id !== founderDecisionId) {
        throw new Error(`hold ${options.holdId} was already cleared with a different founder decision ID`);
      }
      if (!hold.clearance && controls.founderDecisionUsed(founderDecisionId)) {
        throw new Error(`founder decision ID ${founderDecisionId} was already used`);
      }
      const binding = expectedBinding(hold.incident);
      if (hold.clearance?.cleared_pause) {
        const campaignClearancePause = {
          provider: 'GitHub',
          incident_id: binding.incidentId,
          signal: hold.clearance.cleared_pause.signal,
          tripped_at: hold.clearance.cleared_pause.tripped_at,
        };
        assertPauseBinding(campaignClearancePause, binding, 'campaign hold clearance');
      } else if (hold.clearance) {
        throw new Error(`hold ${options.holdId} clearance is missing provider throttle binding metadata`);
      }
      const resourceControl = await resourceLoadImpl(options.resourceControlFile);
      const gatewayState = await gatewayReadImpl({
        stateDir: options.gatewayStateDir,
        ledgerFile: options.ledgerFile,
        controlStateFile: options.controlStateFile,
        resourceControlFile: options.resourceControlFile,
        gatewayLockHeld: true,
      });
      const resourceClearance = matchingPeerClearance(
        resourceControl.provider_pause_clearances, founderDecisionId, binding, 'persistent provider throttle');
      const gatewayClearance = matchingPeerClearance(
        gatewayState.provider_pause_clearances, founderDecisionId, binding, 'GitHub gateway provider throttle');
      if (resourceControl.provider_pause) {
        assertPauseBinding(resourceControl.provider_pause, binding, 'persistent provider throttle');
        if (resourceClearance) throw new Error('persistent provider throttle is active after a matching prior clearance');
      } else if (!resourceClearance) {
        throw new Error('persistent provider throttle is not active; clearance state mismatch');
      }
      if (gatewayState.provider_pause) {
        assertPauseBinding(gatewayState.provider_pause, binding, 'GitHub gateway provider throttle');
        if (gatewayClearance) throw new Error('GitHub gateway provider throttle is active after a matching prior clearance');
      } else if (!gatewayClearance) {
        throw new Error('GitHub gateway provider throttle is not active; clearance state mismatch');
      }
      if (gatewayState.probe_required && gatewayState.probe_required.cleared_hold_id !== options.holdId) {
        throw new Error('GitHub gateway resume probe belongs to a different cleared hold');
      }
      const existingClearanceTimes = [
        clearanceTimestamp(hold.clearance, 'campaign hold clearance'),
        clearanceTimestamp(resourceClearance, 'persistent provider throttle clearance'),
        clearanceTimestamp(gatewayClearance, 'GitHub gateway provider throttle clearance'),
      ].filter(Boolean);
      if (new Set(existingClearanceTimes).size > 1) {
        throw new Error('provider throttle clearance peers have mismatched clearance timestamps');
      }
      const clearedAt = existingClearanceTimes[0] ?? now().toISOString();
      let holdClearance = hold.clearance;
      if (!holdClearance) {
        holdClearance = await controls.clearHold({
          hold_id: options.holdId,
          founder_decision_id: founderDecisionId,
          cleared_pause: {signal: binding.signal, tripped_at: binding.trippedAt},
          at: clearedAt,
        }, {gatewayLockHeld: true});
        await afterTransitionStep('clear-campaign', {holdClearance});
      }
      let providerThrottle = resourceClearance;
      if (resourceControl.provider_pause) {
        providerThrottle = await resourceClearImpl(options.resourceControlFile, {
          founderDecisionId,
          at: clearedAt,
          expectedProviderPause: resourceControl.provider_pause,
          gatewayLockHeld: true,
        });
        await afterTransitionStep('clear-resource', {providerThrottle});
      }
      let gatewayThrottle = gatewayClearance;
      const gatewayNeedsProbe = !gatewayState.probe_required;
      if (gatewayState.provider_pause || gatewayNeedsProbe) {
        gatewayThrottle = await gatewayClearImpl({
          founderDecisionId,
          clearedHoldId: options.holdId,
          at: clearedAt,
          stateDir: options.gatewayStateDir,
          ledgerFile: options.ledgerFile,
          controlStateFile: options.controlStateFile,
          resourceControlFile: options.resourceControlFile,
          expectedProviderPause: gatewayState.provider_pause ?? gatewayClearance?.provider_pause,
          gatewayLockHeld: true,
        });
        await afterTransitionStep('clear-gateway', {gatewayThrottle});
      }
      return {
        hold_clearance: holdClearance,
        provider_throttle_clearance: providerThrottle,
        gateway_throttle_clearance: gatewayThrottle,
      };
    });
    printJson(stdout, result);
    return result;
  }
  const result = await gatewayRequestImpl(['api', 'rate_limit'], {
    requestClass: 'rest_read',
    resumeProbe: true,
    label: 'controls-probe',
    controlStateFile: options.controlStateFile,
    resourceControlFile: options.resourceControlFile,
    stateDir: options.gatewayStateDir,
    ledgerFile: options.ledgerFile,
  });
  if (result.code !== 0 && result.status !== 0) {
    throw new Error(`GitHub rate-limit probe failed with exit code ${result.code ?? result.status}`);
  }
  stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  return result;
}

function normalizeIncidentSignal(signal) {
  const normalized = signal.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  if (normalized === 'SECONDARY_RATE_LIMIT') return 'GITHUB_SECONDARY_RATE_LIMIT';
  if (normalized === 'ABUSE_DETECTION') return 'GITHUB_ABUSE_DETECTION';
  if (['HTTP_429', 'RETRY_AFTER', 'GITHUB_PROVIDER_THROTTLE'].includes(normalized)) return normalized;
  if (normalized.startsWith('GITHUB_')) return normalized;
  return `GITHUB_${normalized}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  runControlsCli(process.argv.slice(2)).catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
