#!/usr/bin/env node

import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {clearPersistentProviderThrottle, loadResourceControl} from '../phase0/resource-breakers.mjs';
import {openCampaignControls} from './controls.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_FILE), '..', '..');
const DEFAULT_CONTROL_STATE = path.join(REPO_ROOT, 'runs', 'phase1', 'control-state.json');
const DEFAULT_RESOURCE_CONTROL = path.join(REPO_ROOT, 'runs', 'phase0', 'resource-control.json');
const DEFAULT_GATEWAY_STATE = path.join(REPO_ROOT, 'runs', 'gh-gateway-state');

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
  if (!['snapshot', 'clear-hold', 'probe', 'budget'].includes(command)) {
    throw new Error('command must be snapshot, clear-hold, probe, or budget');
  }
  const controlStateFile = path.resolve(takeValue(values, '--controls-state') ?? DEFAULT_CONTROL_STATE);
  const resourceControlFile = path.resolve(takeValue(values, '--resource-control') ?? DEFAULT_RESOURCE_CONTROL);
  const gatewayStateDir = path.resolve(takeValue(values, '--gateway-state') ?? DEFAULT_GATEWAY_STATE);
  const holdId = takeValue(values, '--hold-id');
  const founderDecisionId = takeValue(values, '--founder-decision-id');
  if (values.length) throw new Error(`unknown argument ${values[0]}`);
  if (command === 'clear-hold') {
    if (!holdId) throw new Error('--hold-id is required for clear-hold');
    if (!founderDecisionId) throw new Error('--founder-decision-id is required for clear-hold');
  } else if (holdId || founderDecisionId) {
    throw new Error('--hold-id and --founder-decision-id are only valid for clear-hold');
  }
  return {command, controlStateFile, resourceControlFile, gatewayStateDir, holdId, founderDecisionId};
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

async function readGatewayBudgetState(options) {
  const {readGhDailyBudgetState} = await import('../../gh-gateway.mjs');
  return readGhDailyBudgetState(options);
}

async function withGatewayLock(options, callback) {
  const {withGhGatewayLock} = await import('../../gh-gateway.mjs');
  return withGhGatewayLock(options, callback);
}

function printJson(stdout, value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runControlsCli(argv, {
  gatewayRequestImpl = gatewayRequest,
  gatewayClearImpl = clearGatewayThrottle,
  gatewayReadImpl = readGatewayControlState,
  gatewayBudgetReadImpl = readGatewayBudgetState,
  gatewayWithLockImpl = withGatewayLock,
  stdout = process.stdout,
  now = () => new Date(),
} = {}) {
  const options = parseControlsCliArgs(argv);
  if (options.command === 'snapshot') {
    const controls = await openCampaignControls(options.controlStateFile);
    const snapshot = controls.snapshot({now: now()});
    printJson(stdout, snapshot);
    return snapshot;
  }
  if (options.command === 'budget') {
    const budget = await gatewayBudgetReadImpl({stateDir: options.gatewayStateDir});
    printJson(stdout, budget);
    return budget;
  }
  if (options.command === 'clear-hold') {
    const result = await gatewayWithLockImpl({stateDir: options.gatewayStateDir}, async () => {
      const controls = await openCampaignControls(options.controlStateFile, {
        gatewayStateDir: options.gatewayStateDir,
      });
      const hold = controls.inspectHold(options.holdId);
      if (!hold.known) throw new Error(`hold ${options.holdId} is unknown`);
      if (hold.clearance) {
        throw new Error(`hold ${options.holdId} was already cleared before this invocation`);
      }

      const founderDecisionId = options.founderDecisionId.trim();
      const resourceControl = await loadResourceControl(options.resourceControlFile);
      const gatewayState = await gatewayReadImpl({
        stateDir: options.gatewayStateDir,
        gatewayLockHeld: true,
      });
      if (controls.founderDecisionUsed(founderDecisionId) ||
          (resourceControl.provider_pause_clearances ?? [])
            .some((item) => item.founder_decision_id === founderDecisionId) ||
          (gatewayState.provider_pause_clearances ?? [])
            .some((item) => item.founder_decision_id === founderDecisionId)) {
        throw new Error(`founder decision ID ${founderDecisionId} was already used`);
      }
      if (!resourceControl.provider_pause) {
        throw new Error('persistent provider throttle is not active; clearance state mismatch');
      }
      if (!gatewayState.provider_pause) {
        throw new Error('GitHub gateway provider throttle is not active; clearance state mismatch');
      }

      const clearedAt = now().toISOString();
      const campaignPause = {
        signal: gatewayState.provider_pause.signal,
        tripped_at: gatewayState.provider_pause.tripped_at,
      };
      const holdClearance = await controls.clearHold({
        hold_id: options.holdId,
        founder_decision_id: founderDecisionId,
        cleared_pause: campaignPause,
        at: clearedAt,
      }, {gatewayLockHeld: true});
      const providerThrottle = await clearPersistentProviderThrottle(options.resourceControlFile, {
        founderDecisionId,
        at: clearedAt,
        expectedProviderPause: resourceControl.provider_pause,
        gatewayLockHeld: true,
      });
      const gatewayThrottle = await gatewayClearImpl({
        founderDecisionId,
        stateDir: options.gatewayStateDir,
        expectedProviderPause: gatewayState.provider_pause,
        gatewayLockHeld: true,
      });
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
    label: 'controls-probe',
    controlStateFile: options.controlStateFile,
    resourceControlFile: options.resourceControlFile,
    stateDir: options.gatewayStateDir,
  });
  if (result.code !== 0 && result.status !== 0) {
    throw new Error(`GitHub rate-limit probe failed with exit code ${result.code ?? result.status}`);
  }
  stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  runControlsCli(process.argv.slice(2)).catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
