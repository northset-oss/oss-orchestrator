import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY_FILE = path.join(HERE, 'control-policy.json');

const EVENT_CLASSES = Object.freeze({
  SEV_1: new Set([
    'stop_request', 'spam_accusation', 'platform_warning', 'account_warning',
    'credential_exposure', 'unauthorized_publication', 'wrong_code_receipt',
    'counter_inflation', 'cross_job_isolation_breach',
  ]),
  SEV_2: new Set(['ai_volume_concern', 'duplicate_work_complaint', 'maintainer_burden']),
  SEV_3: new Set(['implementation_disagreement', 'requested_changes', 'non_hostile_closure']),
});

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export async function loadControlPolicy(file = DEFAULT_POLICY_FILE) {
  const policy = JSON.parse(await readFile(file, 'utf8'));
  validateControlPolicy(policy);
  return policy;
}

export function validateControlPolicy(policy) {
  if (!isObject(policy) || policy.schema_version !== 1) throw new Error('control policy schema_version must equal 1');
  if (!Array.isArray(policy.metric_policies) || !policy.metric_policies.length) throw new Error('control policy requires metric records');
  for (const record of policy.metric_policies) {
    for (const field of ['id', 'metric', 'scope', 'window', 'warning', 'stop', 'action', 'resume']) {
      if (record[field] === undefined || record[field] === null) throw new Error(`metric policy is missing ${field}`);
    }
    if (!Number.isFinite(record.warning) || !Number.isFinite(record.stop) || record.stop > record.warning) {
      throw new Error('metric policy warning/stop thresholds are invalid');
    }
  }
  if (!Array.isArray(policy.stop_conditions) || !policy.stop_conditions.length) {
    throw new Error('control policy requires executable stop-condition records');
  }
  for (const record of policy.stop_conditions) {
    for (const field of ['id', 'metric', 'scope', 'operator', 'threshold', 'action']) {
      if (record[field] === undefined || record[field] === null) throw new Error(`stop condition is missing ${field}`);
    }
    if (!['>', '>=', '<', '<=', '=='].includes(record.operator) || !Number.isFinite(record.threshold)) {
      throw new Error('stop-condition operator or threshold is invalid');
    }
  }
  if (!isObject(policy.sev_actions?.SEV_1) || !isObject(policy.sev_actions?.SEV_2) || !isObject(policy.sev_actions?.SEV_3)) {
    throw new Error('control policy requires SEV_1/2/3 actions');
  }
  if (!Object.hasOwn(policy.closure_policy ?? {}, 'min_samples')) {
    throw new Error('closure policy must explicitly declare min_samples');
  }
  const minimum = policy.closure_policy.min_samples;
  if (minimum !== null && (!Number.isInteger(minimum) || minimum < 1)) {
    throw new Error('closure min_samples must be null or a positive prospective value');
  }
  if (!Array.isArray(policy.closure_policy.reason_codes) || !policy.closure_policy.reason_codes.length) {
    throw new Error('closure policy requires reason codes');
  }
  return true;
}

function compare(operator, left, right) {
  if (operator === '>=') return left >= right;
  if (operator === '>') return left > right;
  if (operator === '<=') return left <= right;
  if (operator === '<') return left < right;
  if (operator === '==') return left === right;
  throw new Error(`unsupported policy operator ${operator}`);
}

export function evaluateMetricPolicy(record, value, {resuming = false} = {}) {
  if (!Number.isFinite(value)) throw new Error('metric value must be finite');
  if (resuming) {
    return compare(record.resume.operator, value, record.resume.value)
      ? {state: 'pass', action: null}
      : {state: 'stop', action: record.action};
  }
  if (value < record.stop) return {state: 'stop', action: record.action};
  if (value < record.warning) return {state: 'warning', action: null};
  return {state: 'pass', action: null};
}

export function evaluateStopCondition(record, value) {
  if (!isObject(record) || !Number.isFinite(value)) throw new Error('stop condition and finite value are required');
  const triggered = compare(record.operator, value, record.threshold);
  return {triggered, action: triggered ? record.action : null};
}

function emptyState() {
  return {schema_version: 1, incidents: [], closures: [], hold_clearances: []};
}

async function readState(file) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    if (state?.schema_version !== 1 || !Array.isArray(state.incidents) || !Array.isArray(state.closures) ||
        !Array.isArray(state.hold_clearances)) throw new Error('campaign control state is invalid');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function withGatewayLock({gatewayLockHeld = false, gatewayStateDir, gatewayLockOptions} = {}, callback) {
  if (gatewayLockHeld) return callback();
  const {withGhGatewayLock} = await import('../../gh-gateway.mjs');
  return withGhGatewayLock({stateDir: gatewayStateDir, ...(gatewayLockOptions ?? {})}, callback);
}

export async function openCampaignControls(file, {
  policy = null,
  gatewayStateDir = undefined,
  gatewayLockOptions = undefined,
} = {}) {
  const absolute = path.resolve(file);
  const activePolicy = policy ?? await loadControlPolicy();
  validateControlPolicy(activePolicy);
  let state = await readState(absolute);
  const save = async () => {
    await mkdir(path.dirname(absolute), {recursive: true, mode: 0o700});
    await writeFile(absolute, `${JSON.stringify(state, null, 2)}\n`, {mode: 0o600});
  };

  const api = {
    async recordIncident(input, {
      gatewayLockHeld = false,
      gatewayStateDir: writerGatewayStateDir = gatewayStateDir,
      gatewayLockOptions: writerGatewayLockOptions = gatewayLockOptions,
    } = {}) {
      if (!isObject(input) || typeof input.incident_id !== 'string' || !input.incident_id) throw new Error('incident_id is required');
      if (!EVENT_CLASSES[input.severity]?.has(input.event_class)) throw new Error('incident has an invalid SEV event class');
      if (!['repository', 'platform', 'mission'].includes(input.scope)) throw new Error('incident scope is invalid');
      if (input.severity === 'SEV_1' && !['repository', 'platform'].includes(input.scope)) throw new Error('SEV_1 scope must be repository or platform');
      if (input.scope === 'repository' && (typeof input.repository !== 'string' || !input.repository.includes('/'))) {
        throw new Error('repository incident requires owner/repo');
      }
      if (!Number.isFinite(Date.parse(input.occurred_at ?? ''))) throw new Error('incident occurred_at is invalid');
      const githubProviderThrottle = input.incident_class === 'provider_rate_limit' && input.provider === 'GitHub';
      if (githubProviderThrottle && (typeof input.signal !== 'string' || !input.signal.trim() ||
          !Number.isFinite(Date.parse(input.tripped_at ?? '')))) {
        throw new Error('GitHub provider throttle incidents require signal and tripped_at binding metadata');
      }
      const occurredAt = new Date(input.occurred_at).toISOString();
      const trippedAt = githubProviderThrottle ? new Date(input.tripped_at).toISOString() : null;
      if (githubProviderThrottle && trippedAt !== occurredAt) {
        throw new Error('GitHub provider throttle incident tripped_at conflicts with occurred_at');
      }
      const normalized = {...input, repository: input.repository?.toLowerCase() ?? null,
        occurred_at: occurredAt,
        ...(githubProviderThrottle ? {signal: input.signal.trim(), tripped_at: trippedAt} : {})};
      return withGatewayLock({
        gatewayLockHeld,
        gatewayStateDir: writerGatewayStateDir,
        gatewayLockOptions: writerGatewayLockOptions,
      }, async () => {
        state = await readState(absolute);
        const existing = state.incidents.find((item) => item.incident_id === normalized.incident_id);
        if (existing) {
          if (!sameRecord(existing, normalized)) {
            const error = new Error('incident ID is a conflicting replay');
            error.code = 'CAMPAIGN_INCIDENT_CONFLICTING_REPLAY';
            error.incident_id = normalized.incident_id;
            throw error;
          }
          return existing;
        }
        state.incidents.push(normalized);
        await save();
        return normalized;
      });
    },

    async recordClosure(input) {
      if (!isObject(input) || typeof input.closure_id !== 'string' || !input.closure_id) throw new Error('closure_id is required');
      if (!activePolicy.closure_policy.reason_codes.includes(input.reason_code)) throw new Error('closure reason code is not in policy');
      const normalized = {...input};
      const existing = state.closures.find((item) => item.closure_id === normalized.closure_id);
      if (existing) {
        if (!sameRecord(existing, normalized)) throw new Error('closure ID is a conflicting replay');
        return existing;
      }
      state.closures.push(normalized);
      await save();
      return normalized;
    },

    closureRate({reasonCodes = []} = {}) {
      const matches = state.closures.filter((item) => reasonCodes.includes(item.reason_code)).length;
      const samples = state.closures.length;
      const minimum = activePolicy.closure_policy.min_samples;
      if (minimum === null) return {status: 'policy_unconfigured', samples, minimum_samples: null, matches, rate: null};
      if (samples < minimum) return {status: 'insufficient_sample', samples, minimum_samples: minimum, matches, rate: null};
      return {status: 'active', samples, minimum_samples: minimum, matches, rate: matches / samples};
    },

    snapshot({now = new Date()} = {}) {
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('control snapshot now is invalid');
      const cleared = new Set(state.hold_clearances.map((item) => item.hold_id));
      const platform = state.incidents.filter((item) => item.severity === 'SEV_1' && item.scope === 'platform')
        .map((item) => ({hold_id: `incident:${item.incident_id}`, incident: item}));
      const activePlatform = platform.find((item) => !cleared.has(item.hold_id));
      const repositoryHolds = {};
      for (const incident of state.incidents.filter((item) => item.severity === 'SEV_1' && item.scope === 'repository')) {
        const holdId = `incident:${incident.incident_id}`;
        const current = repositoryHolds[incident.repository];
        if (!current || (!current.active && !cleared.has(holdId))) {
          repositoryHolds[incident.repository] = {hold_id: holdId, active: !cleared.has(holdId),
            action: activePolicy.sev_actions.SEV_1.repository};
        }
      }
      const sev2Since = new Date(now.getTime() - activePolicy.sev_actions.SEV_2.window_days * 86_400_000).getTime();
      const sev2 = state.incidents.filter((item) => item.severity === 'SEV_2' && Date.parse(item.occurred_at) >= sev2Since && Date.parse(item.occurred_at) <= now.getTime());
      return {
        global_publication_hold: activePlatform
          ? {hold_id: activePlatform.hold_id, active: true, action: activePolicy.sev_actions.SEV_1.platform}
          : {hold_id: platform[0]?.hold_id ?? null, active: false, action: null},
        repository_holds: repositoryHolds,
        rate_step_reduction: Math.floor(sev2.length / activePolicy.sev_actions.SEV_2.threshold),
        mission_outcomes: state.incidents.filter((item) => item.severity === 'SEV_3'),
      };
    },

    inspectHold(hold_id) {
      const incident = state.incidents.find((item) =>
        `incident:${item.incident_id}` === hold_id && item.severity === 'SEV_1');
      return {
        known: Boolean(incident),
        incident: incident ?? null,
        clearance: state.hold_clearances.find((item) => item.hold_id === hold_id) ?? null,
      };
    },

    async migrateProviderThrottleBinding({incident_id, signal, tripped_at, migrated_at} = {}, {
      gatewayLockHeld = false,
      gatewayStateDir: writerGatewayStateDir = gatewayStateDir,
      gatewayLockOptions: writerGatewayLockOptions = gatewayLockOptions,
    } = {}) {
      if (typeof incident_id !== 'string' || !incident_id.trim() ||
          typeof signal !== 'string' || !signal.trim() || !Number.isFinite(Date.parse(tripped_at ?? '')) ||
          !Number.isFinite(Date.parse(migrated_at ?? ''))) {
        throw new Error('provider throttle incident migration binding is invalid');
      }
      return withGatewayLock({
        gatewayLockHeld,
        gatewayStateDir: writerGatewayStateDir,
        gatewayLockOptions: writerGatewayLockOptions,
      }, async () => {
        state = await readState(absolute);
        const index = state.incidents.findIndex((item) => item.incident_id === incident_id.trim());
        const incident = state.incidents[index];
        if (!incident || incident.incident_class !== 'provider_rate_limit' || incident.provider !== 'GitHub') {
          throw new Error('provider throttle incident migration target is missing or invalid');
        }
        const canonicalTrip = new Date(tripped_at).toISOString();
        const occurredAt = Number.isFinite(Date.parse(incident.occurred_at ?? ''))
          ? new Date(incident.occurred_at).toISOString() : null;
        const existingTrip = Number.isFinite(Date.parse(incident.tripped_at ?? ''))
          ? new Date(incident.tripped_at).toISOString() : null;
        if (occurredAt !== canonicalTrip || (existingTrip !== null && existingTrip !== canonicalTrip)) {
          throw new Error('provider throttle incident migration trip time conflicts with its recorded occurrence');
        }
        const normalized = {...incident, signal: signal.trim(), tripped_at: canonicalTrip,
          migrated_at: new Date(migrated_at).toISOString()};
        if (sameRecord(incident, normalized)) return {incident, changed: false};
        state.incidents[index] = normalized;
        await save();
        return {incident: normalized, changed: true};
      });
    },

    founderDecisionUsed(founderDecisionId) {
      const decisionId = typeof founderDecisionId === 'string' ? founderDecisionId.trim() : '';
      return Boolean(decisionId) && state.hold_clearances.some((item) => item.founder_decision_id === decisionId);
    },

    async clearHold({hold_id, founder_decision_id, cleared_pause = null, at = new Date().toISOString()} = {}, {
      gatewayLockHeld = false,
      gatewayStateDir: writerGatewayStateDir = gatewayStateDir,
      gatewayLockOptions: writerGatewayLockOptions = gatewayLockOptions,
    } = {}) {
      if (typeof founder_decision_id !== 'string' || !founder_decision_id.trim()) {
        throw new Error('holds have no automatic resume; a founder decision ID is required');
      }
      if (cleared_pause !== null && (!isObject(cleared_pause) || typeof cleared_pause.signal !== 'string' ||
          typeof cleared_pause.tripped_at !== 'string')) {
        throw new Error('cleared pause metadata requires signal and tripped_at');
      }
      return withGatewayLock({
        gatewayLockHeld,
        gatewayStateDir: writerGatewayStateDir,
        gatewayLockOptions: writerGatewayLockOptions,
      }, async () => {
        state = await readState(absolute);
        const known = state.incidents.some((item) =>
          `incident:${item.incident_id}` === hold_id && item.severity === 'SEV_1');
        if (!known) throw new Error('hold ID is unknown');
        const clearance = {
          hold_id,
          founder_decision_id: founder_decision_id.trim(),
          cleared_at: at,
          ...(cleared_pause ? {cleared_pause} : {}),
        };
        const existing = state.hold_clearances.find((item) => item.hold_id === hold_id);
        if (existing) return existing;
        state.hold_clearances.push(clearance);
        await save();
        return clearance;
      });
    },
  };
  return api;
}
