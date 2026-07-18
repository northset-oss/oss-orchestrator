import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  isProviderThrottle,
  loadResourceControl,
  tripPersistentProviderThrottle,
} from './campaign/phase0/resource-breakers.mjs';
import {openCampaignControls} from './campaign/phase1/controls.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUDGET_ENV_FIELDS = Object.freeze({
  OSS_GH_DAILY_BUDGET_STARTING_CAP: 'startingCap',
  OSS_GH_DAILY_BUDGET_CEILING: 'ceiling',
  OSS_GH_DAILY_BUDGET_FLOOR: 'floor',
  OSS_GH_DAILY_BUDGET_ALERT_THRESHOLD_PERCENT: 'alertThresholdPercent',
  OSS_GH_DAILY_BUDGET_ADDITIVE_INCREASE_PERCENT: 'additiveIncreasePercent',
  OSS_GH_DAILY_BUDGET_MULTIPLICATIVE_DECREASE_PERCENT: 'multiplicativeDecreasePercent',
});
const configurationLedgerEvents = new Map();
const DEFAULTS = Object.freeze({
  stateDir: path.join(HERE, 'runs', 'gh-gateway-state'),
  ledgerFile: path.join(HERE, 'runs', 'gh-request-ledger.jsonl'),
  resourceControlFile: path.join(HERE, 'runs', 'phase0', 'resource-control.json'),
  controlStateFile: path.join(HERE, 'runs', 'phase1', 'control-state.json'),
  minSpacingMs: 1_000,
  searchSpacingMs: 6_000,
  mutationSpacingMs: 3_000,
  jitterMaxMs: 500,
  lockPollMs: 50,
  lockTimeoutMs: 10 * 60 * 1_000,
  staleLockMs: 10 * 60 * 1_000,
  lockHeartbeatMs: 5_000,
  requestTimeoutMs: 120_000,
  requestKillGraceMs: 5_000,
  maxBuffer: 10_000_000,
  dailyBudgetStartingCap: 2_000,
  dailyBudgetCeiling: 5_000,
  dailyBudgetFloor: 500,
  dailyBudgetAlertThresholdPercent: 75,
  dailyBudgetAdditiveIncreasePercent: 20,
  dailyBudgetMultiplicativeDecreasePercent: 50,
});

const REQUEST_CLASSES = new Set(['search', 'graphql', 'rest_read', 'mutation']);
const THROTTLE_SIGNALS = new Set([
  'GITHUB_SECONDARY_RATE_LIMIT', 'GITHUB_ABUSE_DETECTION', 'HTTP_429', 'RETRY_AFTER',
  'GITHUB_PROVIDER_THROTTLE',
]);
const MUTATION_COMMANDS = new Set([
  'issue close', 'issue comment', 'issue create', 'issue delete', 'issue edit', 'issue reopen',
  'pr close', 'pr comment', 'pr create', 'pr edit', 'pr merge', 'pr ready', 'pr reopen', 'pr review',
  'release create', 'release delete', 'release edit', 'release upload',
  'repo archive', 'repo create', 'repo delete', 'repo edit', 'repo fork', 'repo rename', 'repo sync',
  'run cancel', 'run delete', 'run rerun', 'workflow run',
]);

export class GitHubGatewayError extends Error {
  constructor(message, {reason = 'gateway', cause} = {}) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'GitHubGatewayError';
    this.code = 'GITHUB_GATEWAY_TERMINAL';
    this.reason = reason;
  }
}

export class GitHubGatewayRefusalError extends GitHubGatewayError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'GitHubGatewayRefusalError';
    this.code = 'GITHUB_GATEWAY_REFUSED';
  }
}

export class GitHubThrottleError extends GitHubGatewayError {
  constructor(message, {
    signal = 'GITHUB_PROVIDER_THROTTLE', result = null, incidentId = null, trippedAt = null, cause,
  } = {}) {
    super(message, {reason: 'provider-throttle', cause});
    this.name = 'GitHubThrottleError';
    this.code = 'GITHUB_PROVIDER_THROTTLED';
    this.signal = signal;
    this.result = result;
    this.incident_id = incidentId;
    this.tripped_at = trippedAt;
  }
}

export function isGhGatewayTerminalError(error) {
  return error instanceof GitHubGatewayError;
}

export function classifyGhRequest(argv) {
  if (!Array.isArray(argv)) throw new TypeError('gh argv must be an array');
  if (argv[0] === 'search' || (argv[0] === 'api' && /^search(?:\/|$)/.test(argv[1] ?? ''))) return 'search';
  if (argv[0] === 'api' && argv[1] === 'graphql') {
    const query = graphqlQueryFromArgv(argv);
    if (/^mutation\b/i.test(query.trimStart())) return 'mutation';
    if (/\bsearch\s*\(/i.test(query)) return 'search';
    return 'graphql';
  }
  if (MUTATION_COMMANDS.has(`${argv[0] ?? ''} ${argv[1] ?? ''}`)) return 'mutation';
  if (argv[0] === 'api') {
    const methodIndex = argv.findIndex((argument) => argument === '--method' || argument === '-X');
    const method = methodIndex >= 0 ? String(argv[methodIndex + 1] ?? '').toUpperCase() : null;
    if (method) return method === 'GET' || method === 'HEAD' ? 'rest_read' : 'mutation';
    if (argv.some((argument) => ['-f', '-F', '--field', '--raw-field'].includes(argument))) return 'mutation';
  }
  return 'rest_read';
}

function graphqlQueryFromArgv(argv) {
  const fieldFlags = new Set(['-f', '-F', '--field', '--raw-field']);
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    let field = null;
    if (fieldFlags.has(argument)) {
      field = argv[index + 1] ?? '';
      index += 1;
    } else {
      const long = /^(?:--field|--raw-field)=(.*)$/.exec(argument);
      const short = /^-[fF](.*)$/.exec(argument);
      field = long?.[1] ?? short?.[1] ?? null;
    }
    if (field === null) continue;
    const separator = field.indexOf('=');
    if (separator > 0 && field.slice(0, separator) === 'query') return field.slice(separator + 1);
  }
  return '';
}

function assertBoundedGhArgv(argv) {
  if (argv.some((argument) => argument === '--paginate' || argument === '--slurp' ||
      argument.startsWith('--paginate=') || argument.startsWith('--slurp='))) {
    throw new GitHubGatewayRefusalError(
      'GitHub gateway refuses gh pagination flags because one process can emit multiple unpaced requests',
      {reason: 'pagination-bypass'},
    );
  }
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (['--limit', '-L', '--page-size'].includes(argument)) {
      values.push({token: argument, value: argv[index + 1]});
      index += 1;
      continue;
    }
    const option = /^(--limit|-L|--page-size)=(.*)$/.exec(argument);
    if (option) values.push({token: option[1], value: option[2]});
    const concatenated = /^-L([^=].*|)$/.exec(argument);
    if (concatenated && argument !== '-L') values.push({token: '-L', value: concatenated[1]});
    for (const match of argument.matchAll(/(?:^|[?&]|\b)per_page=([^&#\s]*)/g)) {
      values.push({token: 'per_page', value: match[1]});
    }
  }
  const malformed = values.find(({value}) => !/^[1-9]\d*$/.test(String(value ?? '')));
  if (malformed) {
    throw new GitHubGatewayRefusalError(
      `GitHub gateway refuses malformed or missing ${malformed.token} numeric bounds`,
      {reason: 'invalid-page-bound'},
    );
  }
  const exceeded = values.find(({value}) => Number(value) > 100);
  if (exceeded) {
    throw new GitHubGatewayRefusalError(
      `GitHub gateway refuses ${exceeded.token} values above 100`,
      {reason: 'page-bound-exceeded'},
    );
  }
}

function positiveInteger(value, fallback, {allowZero = false} = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) return fallback;
  return parsed;
}

function percentageInteger(value, fallback, {allowZero = false} = {}) {
  const parsed = positiveInteger(value, fallback, {allowZero});
  return parsed <= 100 ? parsed : fallback;
}

function validateEnvironmentBudgetOverride(values) {
  const normalized = {
    startingCap: DEFAULTS.dailyBudgetStartingCap,
    ceiling: DEFAULTS.dailyBudgetCeiling,
    floor: DEFAULTS.dailyBudgetFloor,
    alertThresholdPercent: DEFAULTS.dailyBudgetAlertThresholdPercent,
    additiveIncreasePercent: DEFAULTS.dailyBudgetAdditiveIncreasePercent,
    multiplicativeDecreasePercent: DEFAULTS.dailyBudgetMultiplicativeDecreasePercent,
  };
  for (const [field, value] of Object.entries(values)) {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
      return {valid: false, reason: `${field}-must-be-an-integer`, normalized: null};
    }
    const parsed = Number(value);
    const zeroAllowed = field === 'additiveIncreasePercent';
    if (!Number.isSafeInteger(parsed) || parsed < (zeroAllowed ? 0 : 1)) {
      return {valid: false, reason: `${field}-out-of-range`, normalized: null};
    }
    if (field.endsWith('Percent') && parsed > 100) {
      return {valid: false, reason: `${field}-out-of-range`, normalized: null};
    }
    normalized[field] = parsed;
  }
  if (normalized.floor > normalized.ceiling) {
    return {valid: false, reason: 'floor-exceeds-ceiling', normalized: null};
  }
  if (normalized.startingCap < normalized.floor || normalized.startingCap > normalized.ceiling) {
    return {valid: false, reason: 'starting-cap-outside-floor-ceiling', normalized: null};
  }
  return {valid: true, reason: null, normalized};
}

function nonBlankPathValue(value) {
  return typeof value === 'string' && !value.trim() ? undefined : value;
}

function pathIdentity(value) {
  const resolved = path.resolve(value);
  let identity;
  try {
    identity = realpathSync.native(resolved);
  } catch {
    let ancestor = resolved;
    const suffix = [];
    while (path.dirname(ancestor) !== ancestor) {
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
      try {
        identity = path.join(realpathSync.native(ancestor), ...suffix);
        break;
      } catch {}
    }
    identity ??= resolved;
  }
  const normalized = path.normalize(identity).normalize('NFC');
  return ['darwin', 'win32'].includes(process.platform) ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function pathIsWithin(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function identityDigest(identity) {
  return createHash('sha256').update(identity).digest('hex');
}

function samePeerPathIdentities(left, right) {
  return left && right && ['resource_control', 'control_state', 'ledger']
    .every((field) => left[field] === right[field]);
}

function parsePeerPathIdentities(value, description) {
  if (value === null || value === undefined) return null;
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); }
    catch { throw new Error(`${description} must be valid JSON`); }
  }
  if (!peerPathIdentitiesValid(parsed)) {
    throw new Error(`${description} must contain exact lowercase SHA-256 resource_control, control_state, and ledger digests`);
  }
  return parsed;
}

function throttleMarkerDigest(marker) {
  return createHash('sha256').update(JSON.stringify(marker)).digest('hex');
}

function sameExactRecord(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
      Array.isArray(left) || Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

function configuration(options) {
  const environment = {...process.env, ...(options.env ?? {})};
  const envTestMode = environment.OSS_GH_GATEWAY_TEST_MODE === '1';
  const testMode = options.testMode === true || envTestMode;
  const requestedTiming = testMode ? {
    minSpacingMs: environment.OSS_GH_GATEWAY_TEST_MIN_SPACING_MS,
    searchSpacingMs: environment.OSS_GH_GATEWAY_TEST_SEARCH_SPACING_MS,
    mutationSpacingMs: environment.OSS_GH_GATEWAY_TEST_MUTATION_SPACING_MS,
    jitterMaxMs: environment.OSS_GH_GATEWAY_TEST_JITTER_MAX_MS,
    lockPollMs: environment.OSS_GH_GATEWAY_TEST_LOCK_POLL_MS,
    lockTimeoutMs: environment.OSS_GH_GATEWAY_TEST_LOCK_TIMEOUT_MS,
    staleLockMs: environment.OSS_GH_GATEWAY_TEST_STALE_LOCK_MS,
    lockHeartbeatMs: environment.OSS_GH_GATEWAY_TEST_LOCK_HEARTBEAT_MS,
    requestTimeoutMs: environment.OSS_GH_GATEWAY_TEST_REQUEST_TIMEOUT_MS,
    requestKillGraceMs: environment.OSS_GH_GATEWAY_TEST_REQUEST_KILL_GRACE_MS,
    ...(options.timing ?? {}),
  } : {};
  const envBudgetValues = Object.fromEntries(Object.entries(BUDGET_ENV_FIELDS)
    .filter(([name]) => environment[name] !== undefined)
    .map(([name, field]) => [field, environment[name]]));
  const envBudgetRequested = Object.keys(envBudgetValues).length > 0;
  const overrideDecisionId = typeof environment.OSS_GH_DAILY_BUDGET_OVERRIDE_DECISION_ID === 'string' &&
    environment.OSS_GH_DAILY_BUDGET_OVERRIDE_DECISION_ID.trim()
    ? environment.OSS_GH_DAILY_BUDGET_OVERRIDE_DECISION_ID.trim() : null;
  const envBudgetValidation = validateEnvironmentBudgetOverride(envBudgetValues);
  const acceptedEnvBudget = envBudgetRequested && overrideDecisionId !== null && envBudgetValidation.valid;
  const requestedDailyBudget = {
    ...(acceptedEnvBudget ? envBudgetValidation.normalized : {}),
    ...(options.dailyBudget ?? {}),
  };
  const dailyBudgetFloor = positiveInteger(
    requestedDailyBudget.floor,
    DEFAULTS.dailyBudgetFloor,
  );
  const dailyBudgetCeiling = Math.max(dailyBudgetFloor, positiveInteger(
    requestedDailyBudget.ceiling,
    DEFAULTS.dailyBudgetCeiling,
  ));
  const dailyBudgetStartingCap = Math.min(dailyBudgetCeiling, Math.max(dailyBudgetFloor,
    positiveInteger(
      requestedDailyBudget.startingCap,
      DEFAULTS.dailyBudgetStartingCap,
    )));
  const dailyBudgetAlertThresholdPercent = percentageInteger(
    requestedDailyBudget.alertThresholdPercent,
    DEFAULTS.dailyBudgetAlertThresholdPercent,
  );
  const dailyBudgetAdditiveIncreasePercent = percentageInteger(
    requestedDailyBudget.additiveIncreasePercent,
    DEFAULTS.dailyBudgetAdditiveIncreasePercent,
    {allowZero: true},
  );
  const dailyBudgetMultiplicativeDecreasePercent = percentageInteger(
    requestedDailyBudget.multiplicativeDecreasePercent,
    DEFAULTS.dailyBudgetMultiplicativeDecreasePercent,
  );
  const envStateDir = nonBlankPathValue(environment.OSS_GH_GATEWAY_STATE_DIR);
  const envLedgerFile = nonBlankPathValue(environment.OSS_GH_REQUEST_LEDGER);
  const envResourceControlFile = nonBlankPathValue(environment.OSS_RESOURCE_CONTROL_FILE);
  const envControlStateFile = nonBlankPathValue(environment.OSS_CAMPAIGN_CONTROL_STATE);
  const stateDir = path.resolve(nonBlankPathValue(options.stateDir) ?? envStateDir ?? DEFAULTS.stateDir);
  const ledgerFile = path.resolve(nonBlankPathValue(options.ledgerFile) ?? envLedgerFile ?? DEFAULTS.ledgerFile);
  const resourceControlFile = path.resolve(nonBlankPathValue(options.resourceControlFile) ??
    envResourceControlFile ?? DEFAULTS.resourceControlFile);
  const controlStateFile = path.resolve(nonBlankPathValue(options.controlStateFile) ??
    envControlStateFile ?? DEFAULTS.controlStateFile);
  const canonicalRoot = path.resolve(nonBlankPathValue(environment.OSS_GH_CANONICAL_ROOT) ?? HERE);
  const canonicalRootIdentity = pathIdentity(canonicalRoot);
  const pathSources = [
    ['stateDir', options.stateDir, envStateDir, stateDir],
    ['ledgerFile', options.ledgerFile, envLedgerFile, ledgerFile],
    ['resourceControlFile', options.resourceControlFile, envResourceControlFile, resourceControlFile],
    ['controlStateFile', options.controlStateFile, envControlStateFile, controlStateFile],
  ];
  const hasEnvDerivedPath = pathSources.some(([, optionValue, envValue]) =>
    nonBlankPathValue(optionValue) === undefined && envValue !== undefined);
  const pathsRequiringCanonicalRoot = hasEnvDerivedPath
    ? pathSources.filter(([, optionValue]) => nonBlankPathValue(optionValue) === undefined)
    : [];
  const outsideCanonicalRoot = pathsRequiringCanonicalRoot.filter(([, , , resolved]) =>
    !pathIsWithin(pathIdentity(resolved), canonicalRootIdentity));
  const safetyPathIdentities = {
    stateDir: pathIdentity(stateDir),
    ledgerFile: pathIdentity(ledgerFile),
    resourceControlFile: pathIdentity(resourceControlFile),
    controlStateFile: pathIdentity(controlStateFile),
  };
  const productionRootIdentity = pathIdentity(path.join(HERE, 'runs'));
  const productionSafetyFields = Object.entries(safetyPathIdentities)
    .filter(([, identity]) => pathIsWithin(identity, productionRootIdentity))
    .map(([field]) => field);
  const peerPathIdentities = {
    resource_control: identityDigest(safetyPathIdentities.resourceControlFile),
    control_state: identityDigest(safetyPathIdentities.controlStateFile),
    ledger: identityDigest(safetyPathIdentities.ledgerFile),
  };
  return {
    environment,
    testMode,
    envTestMode,
    stateDir,
    ledgerFile,
    resourceControlFile,
    controlStateFile,
    canonicalRoot,
    peerPathIdentities,
    productionSafetyFields,
    pathDivergence: outsideCanonicalRoot.map(([field, , , resolved]) => ({field, resolved})),
    stateDirDigest: identityDigest(safetyPathIdentities.stateDir).slice(0, 8),
    budgetOverride: {
      requested: envBudgetRequested,
      accepted: acceptedEnvBudget,
      decision_id: envBudgetRequested ? overrideDecisionId : null,
      requested_values: envBudgetValues,
      effective_values: acceptedEnvBudget ? {
        startingCap: dailyBudgetStartingCap,
        ceiling: dailyBudgetCeiling,
        floor: dailyBudgetFloor,
        alertThresholdPercent: dailyBudgetAlertThresholdPercent,
        additiveIncreasePercent: dailyBudgetAdditiveIncreasePercent,
        multiplicativeDecreasePercent: dailyBudgetMultiplicativeDecreasePercent,
      } : null,
      rejection_reason: !envBudgetRequested || acceptedEnvBudget ? null
        : overrideDecisionId === null ? 'founder-decision-required' : envBudgetValidation.reason,
    },
    minSpacingMs: positiveInteger(requestedTiming.minSpacingMs, DEFAULTS.minSpacingMs, {allowZero: true}),
    searchSpacingMs: positiveInteger(requestedTiming.searchSpacingMs, DEFAULTS.searchSpacingMs, {allowZero: true}),
    mutationSpacingMs: positiveInteger(requestedTiming.mutationSpacingMs, DEFAULTS.mutationSpacingMs, {allowZero: true}),
    jitterMaxMs: positiveInteger(requestedTiming.jitterMaxMs, DEFAULTS.jitterMaxMs, {allowZero: true}),
    lockPollMs: positiveInteger(requestedTiming.lockPollMs, DEFAULTS.lockPollMs),
    lockTimeoutMs: positiveInteger(requestedTiming.lockTimeoutMs, DEFAULTS.lockTimeoutMs),
    staleLockMs: positiveInteger(requestedTiming.staleLockMs, DEFAULTS.staleLockMs),
    lockHeartbeatMs: positiveInteger(requestedTiming.lockHeartbeatMs, DEFAULTS.lockHeartbeatMs),
    requestTimeoutMs: positiveInteger(requestedTiming.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
    requestKillGraceMs: positiveInteger(requestedTiming.requestKillGraceMs, DEFAULTS.requestKillGraceMs),
    dailyBudgetStartingCap,
    dailyBudgetCeiling,
    dailyBudgetFloor,
    dailyBudgetAlertThresholdPercent,
    dailyBudgetAdditiveIncreasePercent,
    dailyBudgetMultiplicativeDecreasePercent,
    now: testMode && typeof options.now === 'function' ? options.now : Date.now,
    sleep: testMode && typeof options.sleep === 'function'
      ? options.sleep
      : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    random: testMode && typeof options.random === 'function' ? options.random : Math.random,
    processIdentity: testMode && typeof options.processIdentity === 'function'
      ? options.processIdentity : processStartIdentity,
    beforeThrottleGatewayStateSave: testMode && typeof options.beforeThrottleGatewayStateSave === 'function'
      ? options.beforeThrottleGatewayStateSave : null,
  };
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    return true;
  }
}

function processStartIdentity(pid) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && stdout.trim() ? `ps:${stdout.trim()}` : null));
  });
}

async function removeAbandonedLock(lockFile, config) {
  let record = null;
  try { record = JSON.parse(await readFile(lockFile, 'utf8')); } catch {}
  const details = await stat(lockFile).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!details) return {removed: false, disappeared: true};
  const ageMs = config.now() - details.mtimeMs;
  const pid = Number(record?.pid);
  const alive = processExists(pid);
  let identityMismatch = false;
  if (alive === true && typeof record?.process_start_identity === 'string' &&
      record.process_start_identity.startsWith('ps:')) {
    const currentIdentity = await config.processIdentity(pid);
    identityMismatch = currentIdentity !== null && currentIdentity !== record.process_start_identity;
  }
  if (alive === true && !identityMismatch) return {removed: false, disappeared: false};
  const earlyReclaimMs = Math.max(config.requestTimeoutMs + 30_000, 150_000);
  const provablyAbandoned = alive === false || identityMismatch;
  if (ageMs < (provablyAbandoned ? earlyReclaimMs : config.staleLockMs)) {
    return {removed: false, disappeared: false};
  }
  await unlink(lockFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  return {
    removed: true,
    disappeared: false,
    record,
    reason: identityMismatch ? 'process-identity-mismatch' : 'process-not-running',
  };
}

async function acquireLock(config, {reconcilePending = true} = {}) {
  await ensureConfigurationAllowed(config);
  await mkdir(config.stateDir, {recursive: true, mode: 0o700});
  const lockFile = path.join(config.stateDir, 'gateway.lock');
  const beganAt = config.now();
  const processIdentity = await config.processIdentity(process.pid) ?? `nonce:${randomUUID()}`;
  let reclaimed = null;
  while (true) {
    let handle;
    let created = false;
    try {
      handle = await open(lockFile, 'wx', 0o600);
      created = true;
      const lockNonce = randomUUID();
      await handle.writeFile(`${JSON.stringify({
        pid: process.pid,
        process_start_identity: processIdentity,
        lock_nonce: lockNonce,
        acquired_at: new Date(config.now()).toISOString(),
      })}\n`);
      if (reconcilePending) await reconcilePendingIncident(config);
      if (reclaimed) await recordLockReclaim(config, reclaimed);
      const heartbeat = setInterval(() => {
        const heartbeatAt = new Date();
        handle.utimes(heartbeatAt, heartbeatAt).catch(() => {});
      }, config.lockHeartbeatMs);
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        let ownsPath = false;
        try {
          const current = JSON.parse(await readFile(lockFile, 'utf8'));
          ownsPath = current?.lock_nonce === lockNonce;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await handle.close();
        if (ownsPath) {
          await unlink(lockFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        }
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (created) await unlink(lockFile).catch(() => {});
      if (error.code !== 'EEXIST') throw error;
      const recovery = await removeAbandonedLock(lockFile, config);
      if (recovery.removed) {
        reclaimed = recovery;
        continue;
      }
      if (recovery.disappeared) continue;
      if (config.now() - beganAt >= config.lockTimeoutMs) {
        throw new GitHubGatewayRefusalError('GitHub gateway lock acquisition timed out', {reason: 'lock-timeout'});
      }
      await config.sleep(config.lockPollMs);
    }
  }
}

async function recordLockReclaim(config, recovery) {
  const reclaimedAtMs = config.now();
  const stateFile = path.join(config.stateDir, 'state.json');
  const state = await readGatewayState(stateFile, {config});
  state.last_request_at_ms = reclaimedAtMs;
  state.last_request_at = new Date(reclaimedAtMs).toISOString();
  await saveGatewayState(stateFile, state);
  await appendLedger(config, {
    timestamp: new Date(reclaimedAtMs).toISOString(),
    event: 'lock_reclaimed',
    class: 'control',
    previous_holder_pid: Number.isInteger(Number(recovery.record?.pid))
      ? Number(recovery.record.pid) : null,
    reclaim_reason: recovery.reason,
  });
}

function emptyGatewayState() {
  return {
    schema_version: 1,
    last_request_at_ms: null,
    last_completed_at_ms: null,
    last_class: null,
    provider_pause: null,
    provider_pause_clearances: [],
    pending_incident: null,
    probe_required: null,
    probe_completions: [],
    probe_dispositions: [],
    peer_path_identities: null,
    throttle_state_repairs: [],
    waves: {},
  };
}

function validWaveId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function peerPathIdentitiesValid(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'control_state,ledger,resource_control' &&
    Object.values(value).every((digest) => typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest));
}

function pendingIncidentEnvelopeValid(pendingIncident, state, config) {
  if (pendingIncident === null) return true;
  if (!pendingIncident || typeof pendingIncident !== 'object' || Array.isArray(pendingIncident) ||
      !THROTTLE_SIGNALS.has(pendingIncident.signal) ||
      typeof pendingIncident.evidence_file !== 'string' || !pendingIncident.evidence_file ||
      !Number.isFinite(Date.parse(pendingIncident.tripped_at ?? '')) ||
      !Number.isFinite(Date.parse(pendingIncident.occurred_at ?? '')) ||
      !peerPathIdentitiesValid(pendingIncident.peer_path_identities) ||
      !samePeerPathIdentities(pendingIncident.peer_path_identities, state.peer_path_identities)) return false;
  const pinnedConfig = {...config, ledgerFile: pendingIncident.evidence_file,
    peerPathIdentities: state.peer_path_identities};
  if (identityDigest(pathIdentity(pendingIncident.evidence_file)) !== state.peer_path_identities.ledger) return false;
  const expectedIncident = throttleIncidentPayload(pinnedConfig, pendingIncident.signal, pendingIncident.tripped_at);
  const expected = pendingIncidentMarker(pinnedConfig, expectedIncident);
  if (!sameExactRecord(pendingIncident, expected)) return false;
  const expectedPause = {
    kind: 'PROVIDER_THROTTLED',
    provider: 'GitHub',
    incident_id: expectedIncident.incident_id,
    signal: expectedIncident.signal,
    tripped_at: expectedIncident.tripped_at,
    auto_resume: false,
  };
  return sameExactRecord(state.provider_pause, expectedPause) &&
    Number.isFinite(Date.parse(state.provider_pause?.tripped_at ?? '')) &&
    new Date(state.provider_pause.tripped_at).toISOString() === expectedIncident.tripped_at;
}

async function readGatewayState(file, {
  config = null,
  allowPendingIncidentRepair = false,
  allowPeerPathMismatch = false,
} = {}) {
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return emptyGatewayState();
    throw new GitHubGatewayRefusalError(`GitHub gateway state is unreadable: ${error.message}`, {
      reason: 'invalid-state', cause: error,
    });
  }
  const timestampsValid = ['last_request_at_ms', 'last_completed_at_ms'].every((field) =>
    state?.[field] === null || (Number.isFinite(state?.[field]) && state[field] >= 0));
  const wavesValid = state?.waves && typeof state.waves === 'object' && !Array.isArray(state.waves) &&
    Object.entries(state.waves).every(([waveId, wave]) => validWaveId(waveId) && (
      (Number.isInteger(wave) && wave >= 0) ||
      (wave && typeof wave === 'object' && !Array.isArray(wave) &&
        (wave.declared_budget === null ||
          (Number.isInteger(wave.declared_budget) && wave.declared_budget >= 0)) &&
        Number.isInteger(wave.used) && wave.used >= 0)
    ));
  const providerPauseValid = state?.provider_pause === null || (
    state?.provider_pause?.kind === 'PROVIDER_THROTTLED' &&
    state.provider_pause.auto_resume === false &&
    typeof state.provider_pause.signal === 'string' && state.provider_pause.signal
  );
  const pinnedPeerPaths = state?.peer_path_identities ?? null;
  const pinnedPeerPathsValid = pinnedPeerPaths === null || peerPathIdentitiesValid(pinnedPeerPaths);
  if (config && pinnedPeerPathsValid && !allowPeerPathMismatch &&
      pinnedPeerPaths !== null &&
      !samePeerPathIdentities(pinnedPeerPaths, config.peerPathIdentities)) {
    throw new GitHubGatewayRefusalError('GitHub gateway peer path identities do not match the pinned state', {
      reason: 'gateway-peer-path-mismatch',
    });
  }
  state.peer_path_identities = pinnedPeerPaths;
  const pendingIncident = state?.pending_incident ?? null;
  const pendingIncidentValid = config && pinnedPeerPaths !== null && pinnedPeerPathsValid
    ? pendingIncidentEnvelopeValid(pendingIncident, state, config)
    : pendingIncident === null;
  const probeRequired = state?.probe_required ?? null;
  const probeRequiredValid = probeRequired === null || (
    probeRequired && typeof probeRequired === 'object' && !Array.isArray(probeRequired) &&
    Number.isFinite(Date.parse(probeRequired.set_at ?? '')) &&
      typeof probeRequired.cleared_hold_id === 'string' && probeRequired.cleared_hold_id
  );
  const probeCompletions = state?.probe_completions ?? [];
  const probeCompletionsValid = Array.isArray(probeCompletions) && probeCompletions.every((receipt) =>
    receipt && typeof receipt === 'object' && !Array.isArray(receipt) &&
    typeof receipt.cleared_hold_id === 'string' && receipt.cleared_hold_id &&
    Number.isFinite(Date.parse(receipt.clearance_at ?? '')) &&
    Number.isFinite(Date.parse(receipt.completed_at ?? '')) &&
    Number.isFinite(Date.parse(receipt.ledger_timestamp ?? '')));
  const probeDispositions = state?.probe_dispositions ?? [];
  const probeDispositionsValid = Array.isArray(probeDispositions) && probeDispositions.every((receipt) =>
    receipt && typeof receipt === 'object' && !Array.isArray(receipt) &&
    typeof receipt.cleared_hold_id === 'string' && receipt.cleared_hold_id &&
    Number.isFinite(Date.parse(receipt.clearance_at ?? '')) &&
    receipt.disposition === 'superseded_by_throttle' &&
    Number.isFinite(Date.parse(receipt.disposed_at ?? '')) &&
    typeof receipt.superseding_incident_id === 'string' && receipt.superseding_incident_id &&
    typeof receipt.superseding_signal === 'string' && THROTTLE_SIGNALS.has(receipt.superseding_signal));
  const throttleStateRepairs = state?.throttle_state_repairs ?? [];
  const throttleStateRepairsValid = Array.isArray(throttleStateRepairs) && throttleStateRepairs.every((receipt) =>
    receipt && typeof receipt === 'object' && !Array.isArray(receipt) &&
    typeof receipt.founder_decision_id === 'string' && receipt.founder_decision_id &&
    Number.isFinite(Date.parse(receipt.repaired_at ?? '')) &&
    typeof receipt.marker_digest === 'string' && /^[0-9a-f]{64}$/.test(receipt.marker_digest));
  if (state?.schema_version !== 1 || !timestampsValid ||
      (state.last_class !== null && !REQUEST_CLASSES.has(state.last_class)) || !providerPauseValid ||
      !Array.isArray(state?.provider_pause_clearances) || !pinnedPeerPathsValid ||
      (!allowPendingIncidentRepair && !pendingIncidentValid) || !probeRequiredValid ||
      !probeCompletionsValid || !probeDispositionsValid || !throttleStateRepairsValid || !wavesValid) {
    if (!allowPendingIncidentRepair && !pendingIncidentValid) {
      throw new GitHubGatewayRefusalError('GitHub gateway pending incident marker is invalid', {
        reason: 'invalid-pending-incident',
      });
    }
    throw new GitHubGatewayRefusalError('GitHub gateway state is invalid', {reason: 'invalid-state'});
  }
  state.waves = Object.fromEntries(Object.entries(state.waves).map(([waveId, wave]) => [
    waveId,
    Number.isInteger(wave) ? {declared_budget: null, used: wave} : wave,
  ]));
  state.probe_required = probeRequired;
  state.probe_completions = probeCompletions;
  state.probe_dispositions = probeDispositions;
  state.throttle_state_repairs = throttleStateRepairs;
  state.pending_incident = pendingIncident;
  return state;
}

async function saveGatewayState(file, state) {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {mode: 0o600});
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function utcDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function emptyDailyBudgetState(config, dateUtc = utcDate(config.now())) {
  return {
    schema_version: 1,
    date_utc: dateUtc,
    daily_cap: config.dailyBudgetStartingCap,
    used_today: 0,
    throttle_seen_today: false,
    alert_emitted_today: false,
    history: [],
  };
}

function validUtcDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && utcDate(timestamp) === value;
}

function assertValidDailyBudgetState(state) {
  const validHistory = Array.isArray(state?.history) && state.history.every((entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry) &&
    validUtcDate(entry.date_utc) && Number.isInteger(entry.daily_cap) && entry.daily_cap >= 1 &&
    Number.isInteger(entry.used) && entry.used >= 0 && typeof entry.throttled === 'boolean');
  if (state?.schema_version !== 1 || !validUtcDate(state?.date_utc) ||
      !Number.isInteger(state?.daily_cap) || state.daily_cap < 1 ||
      !Number.isInteger(state?.used_today) || state.used_today < 0 ||
      typeof state?.throttle_seen_today !== 'boolean' ||
      typeof state?.alert_emitted_today !== 'boolean' || !validHistory) {
    throw new GitHubGatewayRefusalError('GitHub gateway daily budget state is invalid', {
      reason: 'invalid-daily-budget-state',
    });
  }
  return state;
}

async function readDailyBudgetState(file, config) {
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return emptyDailyBudgetState(config);
    throw new GitHubGatewayRefusalError(
      `GitHub gateway daily budget state is unreadable: ${error.message}`,
      {reason: 'invalid-daily-budget-state', cause: error},
    );
  }
  return assertValidDailyBudgetState(state);
}

async function saveDailyBudgetState(file, state) {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {mode: 0o600});
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function rollDailyBudgetState(state, dateUtc, config) {
  const effectiveCap = Math.min(
    config.dailyBudgetCeiling,
    Math.max(config.dailyBudgetFloor, state.daily_cap),
  );
  if (state.date_utc === dateUtc) return {...state, daily_cap: effectiveCap};
  if (state.date_utc > dateUtc) {
    throw new GitHubGatewayRefusalError(
      `GitHub gateway daily budget date ${state.date_utc} is ahead of clock date ${dateUtc}`,
      {reason: 'daily-budget-clock-regression'},
    );
  }
  const completed = {
    date_utc: state.date_utc,
    daily_cap: state.daily_cap,
    used: state.used_today,
    throttled: state.throttle_seen_today,
  };
  let dailyCap = effectiveCap;
  if (state.throttle_seen_today) {
    dailyCap = Math.max(
      Math.floor(effectiveCap * config.dailyBudgetMultiplicativeDecreasePercent / 100),
      config.dailyBudgetFloor,
    );
  } else if (state.used_today >= 1) {
    const additiveStep = Math.floor(
      config.dailyBudgetStartingCap * config.dailyBudgetAdditiveIncreasePercent / 100,
    );
    dailyCap = Math.min(
      effectiveCap + additiveStep,
      config.dailyBudgetCeiling,
    );
  }
  dailyCap = Math.min(config.dailyBudgetCeiling, Math.max(config.dailyBudgetFloor, dailyCap));
  return {
    schema_version: 1,
    date_utc: dateUtc,
    daily_cap: dailyCap,
    used_today: 0,
    throttle_seen_today: false,
    alert_emitted_today: false,
    history: [...state.history, completed],
  };
}

function dailyBudgetAlertThreshold(state, config) {
  return Math.ceil(state.daily_cap * config.dailyBudgetAlertThresholdPercent / 100);
}

function dailyBudgetView(state, config, {clockDateUtc = utcDate(config.now())} = {}) {
  const thresholdRequests = dailyBudgetAlertThreshold(state, config);
  const clockRegression = state.date_utc > clockDateUtc;
  return {
    schema_version: state.schema_version,
    date_utc: state.date_utc,
    daily_cap: state.daily_cap,
    used_today: state.used_today,
    remaining_today: Math.max(0, state.daily_cap - state.used_today),
    throttle_seen_today: state.throttle_seen_today,
    clock_regression: {
      active: clockRegression,
      stored_date_utc: clockRegression ? state.date_utc : null,
      clock_date_utc: clockRegression ? clockDateUtc : null,
    },
    budget_override: {
      requested: config.budgetOverride.requested,
      accepted: config.budgetOverride.accepted,
      decision_id: config.budgetOverride.decision_id,
      values: config.budgetOverride.accepted ? config.budgetOverride.requested_values : {},
    },
    alert: {
      threshold_percent: config.dailyBudgetAlertThresholdPercent,
      threshold_requests: thresholdRequests,
      active: state.used_today >= thresholdRequests,
      emitted_today: state.alert_emitted_today,
    },
    recent_history: state.history.slice(-7),
  };
}

function isSanctionedResumeProbe(argv, requestClass, resumeProbe) {
  return resumeProbe === true && requestClass === 'rest_read' &&
    argv?.length === 2 && argv[0] === 'api' && argv[1] === 'rate_limit';
}

async function assertCampaignAllowsRequest(config, gatewayState, request = {}) {
  if (gatewayState.provider_pause) {
    throw new GitHubGatewayRefusalError(
      'GitHub gateway refused the request because its durable provider-throttle latch is active',
      {reason: 'gateway-provider-throttle'},
    );
  }
  if (gatewayState.probe_required &&
      !isSanctionedResumeProbe(request.argv, request.requestClass, request.resumeProbe)) {
    throw new GitHubGatewayRefusalError(
      `GitHub gateway requires the cleared hold ${gatewayState.probe_required.cleared_hold_id} rate_limit resume probe before any other request`,
      {reason: 'resume-probe-required'},
    );
  }
  let resourceControl;
  try { resourceControl = await loadResourceControl(config.resourceControlFile); }
  catch (error) {
    throw new GitHubGatewayRefusalError(`GitHub gateway could not read the persistent breaker: ${error.message}`, {
      reason: 'breaker-state-error', cause: error,
    });
  }
  if (resourceControl.provider_pause) {
    throw new GitHubGatewayRefusalError(
      'GitHub gateway refused the request because the persistent provider-throttle breaker is active',
      {reason: 'persistent-provider-throttle'},
    );
  }
  let snapshot;
  try { snapshot = (await openCampaignControls(config.controlStateFile)).snapshot(); }
  catch (error) {
    throw new GitHubGatewayRefusalError(`GitHub gateway could not read campaign hold state: ${error.message}`, {
      reason: 'control-state-error', cause: error,
    });
  }
  if (snapshot.global_publication_hold.active) {
    throw new GitHubGatewayRefusalError(
      `GitHub gateway refused the request because global hold ${snapshot.global_publication_hold.hold_id} is active`,
      {reason: 'global-campaign-hold'},
    );
  }
}

function summarizeArgv(argv) {
  const fullySensitiveFlags = new Set(['--body', '--body-file', '--header', '-H', '--input']);
  const fieldFlags = new Set(['--raw-field', '--field', '-f', '-F']);
  let pendingFlag = null;
  const redactField = (value) => {
    const separator = value.indexOf('=');
    if (separator > 0 && value.slice(0, separator) === 'q') return scrub(value);
    return separator > 0 ? `${value.slice(0, separator)}=<redacted>` : '<redacted>';
  };
  const scrub = (value) => value
    .replace(/(authorization\s*:\s*(?:bearer|token)\s+)\S+/ig, '$1<redacted>')
    .replace(/([?&](?:token|access_token|client_secret|client_id)=)[^&#\s]*/ig, '$1<redacted>');
  const truncate = (value) => value.length > 160 ? `${value.slice(0, 157)}...` : value;
  return argv.map((argument) => {
    if (pendingFlag) {
      const flag = pendingFlag;
      pendingFlag = null;
      return fieldFlags.has(flag) ? redactField(argument) : '<redacted>';
    }
    if (fullySensitiveFlags.has(argument) || fieldFlags.has(argument)) {
      pendingFlag = argument;
      return argument;
    }
    for (const flag of fullySensitiveFlags) {
      if (argument.startsWith(`${flag}=`)) return `${flag}=<redacted>`;
    }
    for (const flag of fieldFlags) {
      if (argument.startsWith(`${flag}=`)) {
        return `${flag}=${redactField(argument.slice(flag.length + 1))}`;
      }
    }
    return scrub(argument);
  }).map(truncate);
}

function normalizeResult(value, durationMs) {
  const result = value && typeof value === 'object' ? value : {};
  const status = Number.isInteger(result.status) ? result.status
    : Number.isInteger(result.code) ? result.code : 0;
  return {
    ...result,
    status,
    code: status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    signal: result.signal ?? null,
    timedOut: Boolean(result.timedOut),
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : durationMs,
  };
}

function defaultRunner(argv, {
  cwd,
  env,
  timeoutMs,
  killGraceMs = DEFAULTS.requestKillGraceMs,
  maxBuffer = DEFAULTS.maxBuffer,
  input,
} = {}) {
  return new Promise((resolve) => {
    const beganAt = Date.now();
    const child = spawn('gh', argv, {cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let overflow = false;
    const capture = (current, chunk) => {
      const remaining = Math.max(0, maxBuffer - Buffer.byteLength(current));
      if (chunk.length > remaining) overflow = true;
      return current + chunk.subarray(0, remaining).toString();
    };
    child.stdout.on('data', (chunk) => { stdout = capture(stdout, Buffer.from(chunk)); });
    child.stderr.on('data', (chunk) => { stderr = capture(stderr, Buffer.from(chunk)); });
    let killTimer = null;
    const timer = Number.isFinite(timeoutMs) ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
      killTimer.unref();
    }, timeoutMs) : null;
    const finish = (code, signal = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        status: timedOut ? 124 : overflow ? 125 : (code ?? 1),
        stdout,
        stderr: overflow ? `${stderr}\n[gh output exceeded ${maxBuffer} bytes]` : stderr,
        signal,
        timedOut,
        outputLimitExceeded: overflow,
        durationMs: Date.now() - beganAt,
      });
    };
    child.on('close', finish);
    child.on('error', (error) => {
      stderr = `${stderr}${stderr ? '\n' : ''}${error.message}`;
      finish(127);
    });
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function throttleSignal(value) {
  const text = typeof value === 'string'
    ? value
    : [value?.message, value?.stdout, value?.stderr].filter(Boolean).join('\n');
  if (/\bsecondary[ -]+rate[ -]+limit/i.test(text)) return 'GITHUB_SECONDARY_RATE_LIMIT';
  if (/\babuse[ -]+detection\b/i.test(text)) return 'GITHUB_ABUSE_DETECTION';
  if (Number(value?.status ?? value?.code) === 429 ||
      /\bhttp(?:\/\d(?:\.\d)?)?\s*429\b|\b429\s+too many requests\b|\bstatus(?:\s+code)?\s*[:=]?\s*429\b|\b(?:returned\s+)?error:\s*429\b/i.test(text)) {
    return 'HTTP_429';
  }
  if (/\bretry-after\b/i.test(text)) return 'RETRY_AFTER';
  return 'GITHUB_PROVIDER_THROTTLE';
}

function throttleIncidentId(signal, occurredAt) {
  const slug = signal.replace(/^GITHUB_/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const compactUtc = new Date(occurredAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `github-${slug}-${compactUtc}`;
}

function throttleIncidentPayload(config, signal, trippedAt) {
  const canonicalTripTime = new Date(trippedAt).toISOString();
  return {
    incident_id: throttleIncidentId(signal, canonicalTripTime),
    severity: 'SEV_1',
    scope: 'platform',
    event_class: 'platform_warning',
    incident_class: 'provider_rate_limit',
    provider: 'GitHub',
    signal,
    tripped_at: canonicalTripTime,
    occurred_at: canonicalTripTime,
    disposition: 'global_pipeline_hold_pending_founder_review_no_auto_resume',
    evidence_file: config.ledgerFile,
  };
}

function pendingIncidentMarker(config, incident) {
  return {...incident, peer_path_identities: config.peerPathIdentities};
}

function combinedError(errors, message) {
  const present = errors.filter(Boolean);
  if (!present.length) return null;
  if (present.length === 1) return present[0];
  return new AggregateError(present, message, {cause: present[0]});
}

async function completeThrottlePeers(config, incident, {acceptConflictingCampaignReplay = false} = {}) {
  const errors = [];
  let campaignReplay = false;
  try {
    await tripPersistentProviderThrottle(config.resourceControlFile, {
      provider: 'GitHub',
      signal: incident.signal,
      at: incident.tripped_at,
      incidentId: incident.incident_id,
      gatewayLockHeld: true,
      gatewayStateDir: config.stateDir,
    });
  } catch (error) {
    errors.push(error);
  }
  try {
    const controls = await openCampaignControls(config.controlStateFile, {
      gatewayStateDir: config.stateDir,
    });
    await controls.recordIncident(incident, {gatewayLockHeld: true});
  } catch (error) {
    if (acceptConflictingCampaignReplay && error?.code === 'CAMPAIGN_INCIDENT_CONFLICTING_REPLAY' &&
        error.incident_id === incident.incident_id) {
      campaignReplay = true;
    } else {
      errors.push(error);
    }
  }
  return {error: combinedError(errors, 'GitHub throttle peer persistence failed'), campaignReplay};
}

async function persistThrottleTrip(config, state, signal, trippedAt) {
  const incident = throttleIncidentPayload(config, signal, trippedAt);
  const supersededProbe = state.probe_required ? {
    cleared_hold_id: state.probe_required.cleared_hold_id,
    clearance_at: state.probe_required.set_at,
    disposition: 'superseded_by_throttle',
    disposed_at: incident.tripped_at,
    superseding_incident_id: incident.incident_id,
    superseding_signal: incident.signal,
  } : null;
  state.provider_pause = {
    kind: 'PROVIDER_THROTTLED',
    provider: 'GitHub',
    incident_id: incident.incident_id,
    signal: incident.signal,
    tripped_at: incident.tripped_at,
    auto_resume: false,
  };
  state.peer_path_identities = config.peerPathIdentities;
  state.pending_incident = pendingIncidentMarker(config, incident);
  if (supersededProbe && !(state.probe_dispositions ?? []).some((receipt) =>
    receipt.cleared_hold_id === supersededProbe.cleared_hold_id &&
    receipt.clearance_at === supersededProbe.clearance_at)) {
    state.probe_dispositions = [...(state.probe_dispositions ?? []), supersededProbe];
  }
  state.probe_required = null;
  const errors = [];
  let gatewaySaved = false;
  try {
    if (config.beforeThrottleGatewayStateSave) {
      await config.beforeThrottleGatewayStateSave({
        phase: 'trip-initial',
        incident: JSON.parse(JSON.stringify(incident)),
      });
    }
    await saveGatewayState(path.join(config.stateDir, 'state.json'), state);
    gatewaySaved = true;
  } catch (error) {
    errors.push(error);
  }
  const peers = await completeThrottlePeers(config, incident);
  if (peers.error) errors.push(peers.error);
  if (gatewaySaved && !peers.error) {
    state.pending_incident = null;
    try { await saveGatewayState(path.join(config.stateDir, 'state.json'), state); }
    catch (error) { errors.push(error); }
  }
  return {incident, peerError: combinedError(errors, 'GitHub throttle persistence failed')};
}

async function reconcilePendingIncident(config) {
  const stateFile = path.join(config.stateDir, 'state.json');
  const state = await readGatewayState(stateFile, {config, allowPeerPathMismatch: true});
  const marker = state.pending_incident;
  if (!marker) return false;
  if (!samePeerPathIdentities(state.peer_path_identities, config.peerPathIdentities) ||
      !samePeerPathIdentities(marker.peer_path_identities, config.peerPathIdentities)) {
    throw new GitHubGatewayRefusalError(
      'GitHub gateway pending incident is bound to different peer path identities',
      {reason: 'pending-incident-peer-path-mismatch'},
    );
  }
  const {peer_path_identities: _peerPathIdentities, ...incident} = marker;
  const peers = await completeThrottlePeers(config, incident, {acceptConflictingCampaignReplay: true});
  if (peers.error) throw peers.error;
  state.pending_incident = null;
  await saveGatewayState(stateFile, state);
  await appendLedger(config, {
    timestamp: new Date(config.now()).toISOString(),
    event: 'pending_incident_reconciled',
    class: 'control',
    incident_id: incident.incident_id,
    signal: incident.signal,
    tripped_at: incident.tripped_at,
    outcome: peers.campaignReplay ? 'already_reconciled_conflicting_replay' : 'completed',
  });
  return true;
}

function throttleDescription(signal) {
  return ({
    GITHUB_SECONDARY_RATE_LIMIT: 'GitHub secondary rate limit',
    GITHUB_ABUSE_DETECTION: 'GitHub abuse detection',
    HTTP_429: 'GitHub HTTP 429',
    RETRY_AFTER: 'GitHub Retry-After throttle',
    GITHUB_PROVIDER_THROTTLE: 'GitHub provider throttle',
  })[signal] ?? 'GitHub provider throttle';
}

function responseThrottleDetected(result, thrown, {inspectStdoutText = false, source = null} = {}) {
  if (thrown || result.status !== 0) {
    return isProviderThrottle({
      message: thrown?.message,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    }, {source});
  }
  if (result.stderr && isProviderThrottle(result.stderr, {source})) return true;
  if (inspectStdoutText && result.stdout && isProviderThrottle(result.stdout, {source})) return true;
  let value;
  try { value = JSON.parse(result.stdout); } catch { return false; }
  const rateLimited = (candidate) => typeof candidate === 'string' &&
    candidate.replace(/[_ -]+/g, '').toUpperCase() === 'RATELIMITED';
  if (Array.isArray(value?.errors) && value.errors.some((error) =>
    rateLimited(error?.type) || rateLimited(error?.code) ||
    rateLimited(error?.extensions?.code))) return true;
  const responseLevel = {
    message: value?.message,
    documentation_url: value?.documentation_url,
    errors: Array.isArray(value?.errors)
      ? value.errors.map((error) => ({
        message: error?.message,
        type: error?.type,
        code: error?.code,
        extensions_code: error?.extensions?.code,
      }))
      : null,
  };
  return isProviderThrottle(JSON.stringify(responseLevel));
}

function automaticRateLimitFields(result) {
  let value;
  try { value = JSON.parse(result.stdout); } catch { return null; }
  const pick = (record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    const picked = {};
    for (const field of ['limit', 'remaining', 'reset', 'resetAt', 'used', 'cost']) {
      if (record[field] !== undefined) picked[field] = record[field];
    }
    return Object.keys(picked).length ? picked : null;
  };
  if (value?.resources && typeof value.resources === 'object') {
    const resources = {};
    for (const name of ['core', 'search', 'graphql']) {
      const fields = pick(value.resources[name]);
      if (fields) resources[name] = fields;
    }
    if (Object.keys(resources).length) return {resources};
  }
  const record = value?.data?.rateLimit ?? value?.rateLimit ?? value?.rate;
  return pick(record);
}

function validRateLimitFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  const validRecord = (record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    const values = Object.entries(record).filter(([field]) =>
      ['limit', 'remaining', 'reset', 'resetAt', 'used', 'cost'].includes(field));
    return values.length > 0 && values.every(([, value]) =>
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value))));
  };
  if (fields.resources && typeof fields.resources === 'object' && !Array.isArray(fields.resources)) {
    const resources = Object.values(fields.resources);
    return resources.length > 0 && resources.every(validRecord);
  }
  return validRecord(fields);
}

function waveConfiguration(options, environment) {
  const waveId = options.waveId ?? environment.OSS_GATEWAY_WAVE_ID ?? null;
  if (waveId !== null && !validWaveId(waveId)) {
    throw new GitHubGatewayRefusalError('GitHub gateway wave ID is invalid', {reason: 'invalid-wave-id'});
  }
  const rawBudget = options.waveBudget ?? environment.OSS_GATEWAY_WAVE_BUDGET;
  if (rawBudget === undefined || rawBudget === null || rawBudget === '') return {waveId, waveBudget: null};
  const waveBudget = Number(rawBudget);
  if (!Number.isInteger(waveBudget) || waveBudget < 0) {
    throw new GitHubGatewayRefusalError('GitHub gateway wave budget must be a nonnegative integer', {
      reason: 'invalid-wave-budget',
    });
  }
  return {waveId: waveId ?? 'default', waveBudget};
}

async function appendLedger(config, entry) {
  await mkdir(path.dirname(config.ledgerFile), {recursive: true, mode: 0o700});
  await appendFile(config.ledgerFile, `${JSON.stringify({
    ...entry,
    state_dir_digest: config.stateDirDigest,
  })}\n`, {mode: 0o600});
}

async function recordConfigurationEventOnce(config, entry, signature) {
  if (!configurationLedgerEvents.has(signature)) {
    const pending = appendLedger(config, entry).catch((error) => {
      configurationLedgerEvents.delete(signature);
      throw error;
    });
    configurationLedgerEvents.set(signature, pending);
  }
  await configurationLedgerEvents.get(signature);
}

async function ensureConfigurationAllowed(config) {
  const timestamp = new Date(config.now()).toISOString();
  if (config.envTestMode && config.productionSafetyFields.length) {
    throw new GitHubGatewayRefusalError(
      `Environment-activated GitHub gateway test mode is forbidden against production safety paths: ${config.productionSafetyFields.join(', ')}`,
      {reason: 'env-test-mode-production-path-identity'},
    );
  }
  if (config.pathDivergence.length) {
    throw new GitHubGatewayRefusalError(
      'Environment-derived GitHub rate-safety paths do not share the configured canonical root',
      {reason: 'env-path-root-divergence'},
    );
  }
  if (config.budgetOverride.requested) {
    const accepted = config.budgetOverride.accepted;
    const event = accepted ? 'budget_override' : 'budget_override_rejected';
    const signature = `${event}:${config.stateDirDigest}:${config.budgetOverride.decision_id ?? ''}:${JSON.stringify(config.budgetOverride.requested_values)}`;
    await recordConfigurationEventOnce(config, {
      timestamp,
      event,
      class: 'control',
      decision_id: config.budgetOverride.decision_id,
      requested_values: config.budgetOverride.requested_values,
      effective_values: accepted ? config.budgetOverride.effective_values : null,
      ...(accepted ? {} : {reason: config.budgetOverride.rejection_reason}),
    }, signature);
  }
}

export function resolveGhGatewayStateDir(options = {}) {
  return configuration(options).stateDir;
}

export async function acquireGhGatewayLock(options = {}) {
  return acquireLock(configuration(options));
}

export async function withGhGatewayLock(options, callback) {
  if (typeof callback !== 'function') throw new TypeError('withGhGatewayLock requires a callback');
  if (options?.gatewayLockHeld === true) return callback();
  const release = await acquireGhGatewayLock(options);
  let operationError = null;
  try {
    return await callback();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try { await release(); }
    catch (error) {
      if (!operationError) {
        throw new GitHubGatewayRefusalError(`GitHub gateway could not release its lock: ${error.message}`, {
          reason: 'lock-release-error', cause: error,
        });
      }
    }
  }
}

export async function readGhGatewayControlState(options = {}) {
  const config = configuration(options);
  await ensureConfigurationAllowed(config);
  const read = async () => JSON.parse(JSON.stringify(
    await readGatewayState(path.join(config.stateDir, 'state.json'), {config}),
  ));
  return options.gatewayLockHeld === true ? read() : withGhGatewayLock(options, read);
}

export async function migrateLegacyGhGatewayThrottle({
  provider,
  signal,
  trippedAt,
  migratedFromIncident,
  migratedAt,
  gatewayLockHeld = false,
  ...options
} = {}) {
  if (provider !== 'GitHub' || typeof signal !== 'string' || !signal.trim() ||
      !Number.isFinite(Date.parse(trippedAt ?? '')) ||
      typeof migratedFromIncident !== 'string' || !migratedFromIncident.trim() ||
      !Number.isFinite(Date.parse(migratedAt ?? ''))) {
    throw new Error('legacy GitHub gateway migration metadata is invalid');
  }
  const config = configuration(options);
  await ensureConfigurationAllowed(config);
  const stateFile = path.join(config.stateDir, 'state.json');
  const migrate = async () => {
    const state = await readGatewayState(stateFile, {config});
    const intended = {
      kind: 'PROVIDER_THROTTLED',
      provider,
      signal: signal.trim(),
      tripped_at: new Date(trippedAt).toISOString(),
      incident_id: migratedFromIncident.trim(),
      auto_resume: false,
      migrated_from_incident: migratedFromIncident.trim(),
      migrated_at: new Date(migratedAt).toISOString(),
    };
    if (state.provider_pause) {
      const existing = state.provider_pause;
      const sameProvenance = existing.migrated_from_incident === migratedFromIncident.trim() &&
        existing.incident_id === migratedFromIncident.trim() && existing.signal === signal.trim() &&
        Number.isFinite(Date.parse(existing.tripped_at ?? '')) &&
        new Date(existing.tripped_at).toISOString() === new Date(trippedAt).toISOString();
      if (!sameProvenance) throw new Error('GitHub gateway provider throttle already exists with conflicting migration binding');
      return JSON.parse(JSON.stringify(existing));
    }
    state.provider_pause = intended;
    await saveGatewayState(stateFile, state);
    return JSON.parse(JSON.stringify(state.provider_pause));
  };
  return gatewayLockHeld ? migrate() : withGhGatewayLock(options, migrate);
}

export async function readGhDailyBudgetState(options = {}) {
  const config = configuration(options);
  await ensureConfigurationAllowed(config);
  const file = path.join(config.stateDir, 'daily-request-budget.json');
  const state = await readDailyBudgetState(file, config);
  const clockDateUtc = utcDate(config.now());
  const projected = state.date_utc > clockDateUtc ? state : rollDailyBudgetState(state, clockDateUtc, config);
  return dailyBudgetView(projected, config, {clockDateUtc});
}

export async function repairGhDailyBudgetClock({
  founderDecisionId,
  gatewayLockHeld = false,
  ...options
} = {}) {
  if (typeof founderDecisionId !== 'string' || !founderDecisionId.trim()) {
    throw new Error('daily budget clock repair requires a founder decision ID');
  }
  const config = configuration(options);
  await ensureConfigurationAllowed(config);
  const repair = async () => {
    const file = path.join(config.stateDir, 'daily-request-budget.json');
    const state = await readDailyBudgetState(file, config);
    const clockDateUtc = utcDate(config.now());
    if (state.date_utc <= clockDateUtc) {
      return {repaired: false, ...dailyBudgetView(
        rollDailyBudgetState(state, clockDateUtc, config), config, {clockDateUtc},
      )};
    }
    const futureDateUtc = state.date_utc;
    state.date_utc = clockDateUtc;
    await saveDailyBudgetState(file, state);
    await appendLedger(config, {
      timestamp: new Date(config.now()).toISOString(),
      event: 'daily_budget_clock_repaired',
      class: 'control',
      founder_decision_id: founderDecisionId.trim(),
      previous_date_utc: futureDateUtc,
      repaired_date_utc: clockDateUtc,
    });
    return {repaired: true, previous_date_utc: futureDateUtc,
      ...dailyBudgetView(state, config, {clockDateUtc})};
  };
  return gatewayLockHeld ? repair() : withGhGatewayLock(options, repair);
}

function exactThrottleClearance(clearance, pause, {holdId = null} = {}) {
  if (!clearance || typeof clearance !== 'object' || Array.isArray(clearance) ||
      typeof clearance.founder_decision_id !== 'string' || !clearance.founder_decision_id ||
      !Number.isFinite(Date.parse(clearance.cleared_at ?? '')) ||
      !sameExactRecord(clearance.provider_pause, pause) ||
      !sameExactRecord(clearance.cleared_pause, {
        signal: pause.signal,
        tripped_at: pause.tripped_at,
      })) return false;
  return holdId === null || clearance.cleared_hold_id === holdId;
}

async function readExactThrottlePeers(config, state, expectedIncidentId) {
  const controls = await openCampaignControls(config.controlStateFile, {
    gatewayStateDir: config.stateDir,
  });
  const holdId = `incident:${expectedIncidentId}`;
  const hold = controls.inspectHold(holdId);
  if (!hold.known || hold.incident?.incident_class !== 'provider_rate_limit' ||
      hold.incident?.provider !== 'GitHub' || !THROTTLE_SIGNALS.has(hold.incident?.signal) ||
      !Number.isFinite(Date.parse(hold.incident?.tripped_at ?? '')) ||
      !Number.isFinite(Date.parse(hold.incident?.occurred_at ?? '')) ||
      new Date(hold.incident.tripped_at).toISOString() !== new Date(hold.incident.occurred_at).toISOString() ||
      typeof hold.incident.evidence_file !== 'string' || !hold.incident.evidence_file) {
    throw new GitHubGatewayRefusalError('Throttle repair campaign peer is missing or invalid', {
      reason: 'throttle-repair-peer-mismatch',
    });
  }
  const trippedAt = new Date(hold.incident.tripped_at).toISOString();
  const canonicalIncident = throttleIncidentPayload(
    {...config, ledgerFile: hold.incident.evidence_file},
    hold.incident.signal,
    trippedAt,
  );
  if (canonicalIncident.incident_id !== expectedIncidentId ||
      !sameExactRecord(hold.incident, {...canonicalIncident, repository: null})) {
    throw new GitHubGatewayRefusalError('Throttle repair campaign incident does not match its canonical binding', {
      reason: 'throttle-repair-peer-mismatch',
    });
  }
  const evidenceDigest = identityDigest(pathIdentity(hold.incident.evidence_file));
  const allowedLedgerDigests = [state.peer_path_identities?.ledger, config.peerPathIdentities.ledger].filter(Boolean);
  if (!allowedLedgerDigests.includes(evidenceDigest)) {
    throw new GitHubGatewayRefusalError('Throttle repair campaign evidence path is not bound to the old or current ledger', {
      reason: 'throttle-repair-peer-mismatch',
    });
  }
  const pause = {
    kind: 'PROVIDER_THROTTLED',
    provider: 'GitHub',
    incident_id: canonicalIncident.incident_id,
    signal: canonicalIncident.signal,
    tripped_at: canonicalIncident.tripped_at,
    auto_resume: false,
  };
  const resourceControl = await loadResourceControl(config.resourceControlFile);
  if (resourceControl.provider_pause) {
    if (!sameExactRecord(resourceControl.provider_pause, pause) || hold.clearance) {
      throw new GitHubGatewayRefusalError('Throttle repair active peers do not agree on the incident binding', {
        reason: 'throttle-repair-peer-mismatch',
      });
    }
    if (state.provider_pause && !sameExactRecord(state.provider_pause, pause)) {
      throw new GitHubGatewayRefusalError('Throttle repair would overwrite a different gateway pause', {
        reason: 'throttle-repair-peer-mismatch',
      });
    }
    return {mode: 'active', controls, hold, resourceControl, pause, incident: canonicalIncident};
  }
  const resourceClearances = (resourceControl.provider_pause_clearances ?? [])
    .filter((entry) => exactThrottleClearance(entry, pause));
  const gatewayClearances = (state.provider_pause_clearances ?? [])
    .filter((entry) => exactThrottleClearance(entry, pause, {holdId}));
  if (resourceClearances.length !== 1 || gatewayClearances.length !== 1 || !hold.clearance ||
      hold.clearance.hold_id !== holdId ||
      hold.clearance.founder_decision_id !== resourceClearances[0].founder_decision_id ||
      hold.clearance.founder_decision_id !== gatewayClearances[0].founder_decision_id ||
      !Number.isFinite(Date.parse(hold.clearance.cleared_at ?? '')) ||
      new Date(hold.clearance.cleared_at).toISOString() !==
        new Date(resourceClearances[0].cleared_at).toISOString() ||
      new Date(hold.clearance.cleared_at).toISOString() !==
        new Date(gatewayClearances[0].cleared_at).toISOString() ||
      !sameExactRecord(hold.clearance.cleared_pause, {
        signal: pause.signal,
        tripped_at: pause.tripped_at,
      }) || state.provider_pause) {
    throw new GitHubGatewayRefusalError('Throttle repair terminal peers do not contain one exact clearance', {
      reason: 'throttle-repair-peer-mismatch',
    });
  }
  return {mode: 'terminal', controls, hold, resourceControl, pause, incident: canonicalIncident};
}

export async function repairGhThrottleState({
  founderDecisionId,
  expectedIncidentId,
  expectedMarkerDigest,
  expectedOldPeerDigests = null,
  expectedNewPeerDigests = null,
  ...options
} = {}) {
  if (typeof founderDecisionId !== 'string' || !founderDecisionId.trim()) {
    throw new Error('GitHub throttle-state repair requires a founder decision ID');
  }
  if (typeof expectedIncidentId !== 'string' || !expectedIncidentId.trim()) {
    throw new Error('GitHub throttle-state repair requires the expected incident ID');
  }
  if (typeof expectedMarkerDigest !== 'string' || !/^[0-9a-f]{64}$/.test(expectedMarkerDigest)) {
    throw new Error('GitHub throttle-state repair requires the expected lowercase SHA-256 marker digest');
  }
  if (Boolean(expectedOldPeerDigests) !== Boolean(expectedNewPeerDigests)) {
    throw new Error('GitHub throttle-state repair requires both old and new peer digests');
  }
  const expectedOldPaths = parsePeerPathIdentities(expectedOldPeerDigests, 'expected old peer digests');
  const expectedNewPaths = parsePeerPathIdentities(expectedNewPeerDigests, 'expected new peer digests');
  const config = configuration(options);
  await ensureConfigurationAllowed(config);
  const release = await acquireLock(config, {reconcilePending: false});
  let operationError = null;
  try {
    const stateFile = path.join(config.stateDir, 'state.json');
    const state = await readGatewayState(stateFile, {
      config,
      allowPendingIncidentRepair: true,
      allowPeerPathMismatch: true,
    });
    const decisionId = founderDecisionId.trim();
    const incidentId = expectedIncidentId.trim();
    if (state.throttle_state_repairs.some((entry) => entry.founder_decision_id === decisionId) ||
        state.provider_pause_clearances.some((entry) => entry?.founder_decision_id === decisionId)) {
      throw new GitHubGatewayRefusalError('Founder decision ID was already used by the GitHub gateway', {
        reason: 'founder-decision-reused',
      });
    }
    const pathsMismatch = state.peer_path_identities !== null &&
      !samePeerPathIdentities(state.peer_path_identities, config.peerPathIdentities);
    if (pathsMismatch) {
      if (!expectedOldPaths || !expectedNewPaths ||
          !samePeerPathIdentities(expectedOldPaths, state.peer_path_identities) ||
          !samePeerPathIdentities(expectedNewPaths, config.peerPathIdentities)) {
        throw new GitHubGatewayRefusalError('Throttle repair peer-path decision does not match old and current digests', {
          reason: 'throttle-repair-peer-path-mismatch',
        });
      }
    } else if (expectedOldPaths || expectedNewPaths) {
      throw new GitHubGatewayRefusalError('Throttle repair peer-path digests were supplied without a path relocation', {
        reason: 'throttle-repair-peer-path-mismatch',
      });
    }
    const marker = state.pending_incident;
    if (marker && marker.incident_id !== incidentId) {
      throw new GitHubGatewayRefusalError('Throttle repair incident ID does not match the pending marker', {
        reason: 'throttle-repair-incident-mismatch',
      });
    }
    let markerDigest = marker ? throttleMarkerDigest(marker) : null;
    if (markerDigest && markerDigest !== expectedMarkerDigest) {
      throw new GitHubGatewayRefusalError('Throttle repair marker digest does not match the founder decision', {
        reason: 'throttle-repair-marker-digest-mismatch',
      });
    }
    if (marker && !pathsMismatch && pendingIncidentEnvelopeValid(marker, state, config)) {
      throw new GitHubGatewayRefusalError('A valid pending incident must be reconciled, not founder-cleared', {
        reason: 'valid-pending-incident',
      });
    }
    const peers = await readExactThrottlePeers(config, state, incidentId);
    if (peers.controls.founderDecisionUsed(decisionId) ||
        (peers.resourceControl.provider_pause_clearances ?? [])
          .some((entry) => entry?.founder_decision_id === decisionId)) {
      throw new GitHubGatewayRefusalError('Founder decision ID was already used by a throttle peer', {
        reason: 'founder-decision-reused',
      });
    }
    const markerForDigest = marker ?? pendingIncidentMarker({
      ...config,
      peerPathIdentities: state.peer_path_identities ?? config.peerPathIdentities,
    }, peers.incident);
    markerDigest ??= throttleMarkerDigest(markerForDigest);
    if (markerDigest !== expectedMarkerDigest) {
      throw new GitHubGatewayRefusalError('Throttle repair marker digest does not match the founder decision', {
        reason: 'throttle-repair-marker-digest-mismatch',
      });
    }
    const oldPeerPaths = state.peer_path_identities;
    let action = null;
    if (!state.provider_pause && peers.mode === 'active') {
      state.provider_pause = peers.pause;
      if (state.probe_required) {
        const disposition = {
          cleared_hold_id: state.probe_required.cleared_hold_id,
          clearance_at: state.probe_required.set_at,
          disposition: 'superseded_by_throttle',
          disposed_at: peers.pause.tripped_at,
          superseding_incident_id: peers.pause.incident_id,
          superseding_signal: peers.pause.signal,
        };
        if (!state.probe_dispositions.some((receipt) =>
          receipt.cleared_hold_id === disposition.cleared_hold_id &&
          receipt.clearance_at === disposition.clearance_at)) {
          state.probe_dispositions = [...state.probe_dispositions, disposition];
        }
      }
      state.probe_required = null;
      action = marker ? 'reconstruct_gateway_pause_and_clear_invalid_marker' : 'reconstruct_gateway_pause';
    }
    if (marker) {
      state.pending_incident = null;
      action ??= pathsMismatch ? 'reconcile_and_repin_peer_paths' : 'clear_invalid_pending_marker';
    }
    if (pathsMismatch || (!state.peer_path_identities && action)) {
      state.peer_path_identities = config.peerPathIdentities;
      action ??= 'repin_peer_paths';
    }
    if (!action) return {repaired: false, audit_record: null};
    const repairedAt = new Date(config.now()).toISOString();
    const auditRecord = {
      founder_decision_id: decisionId,
      repaired_at: repairedAt,
      pending_incident_id: incidentId,
      marker_digest: markerDigest,
      reason: action,
      old_peer_path_identities: oldPeerPaths,
      new_peer_path_identities: state.peer_path_identities,
    };
    state.throttle_state_repairs = [...state.throttle_state_repairs, auditRecord];
    await saveGatewayState(stateFile, state);
    let ledgerRecorded = true;
    try {
      await appendLedger(config, {
        timestamp: repairedAt,
        event: 'throttle_state_repaired',
        class: 'control',
        ...auditRecord,
      });
    } catch {
      ledgerRecorded = false;
    }
    return {repaired: true, audit_record: auditRecord, ledger_recorded: ledgerRecorded};
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try { await release(); }
    catch (error) {
      if (!operationError) {
        throw new GitHubGatewayRefusalError(`GitHub gateway could not release its lock: ${error.message}`, {
          reason: 'lock-release-error', cause: error,
        });
      }
    }
  }
}

export async function assertGhRateSafetyAllowsAction(options = {}) {
  const config = configuration(options);
  await ensureConfigurationAllowed(config);
  const check = async () => {
    const state = await readGatewayState(path.join(config.stateDir, 'state.json'), {config});
    await assertCampaignAllowsRequest(config, state);
    return true;
  };
  return options.gatewayLockHeld === true ? check() : withGhGatewayLock(options, check);
}

export async function assertGhNetworkAllowed(options = {}) {
  return assertGhRateSafetyAllowsAction(options);
}

export async function ledgerEvent(event, options = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('GitHub gateway ledger event must be an object');
  }
  const forbidden = Object.keys(event).find((key) =>
    /(?:body|content|credential|password|secret|token|authorization)/i.test(key));
  if (forbidden) {
    throw new TypeError(`GitHub gateway ledger event cannot contain sensitive field ${forbidden}`);
  }
  const config = configuration(options);
  await ensureConfigurationAllowed(config);
  const write = () => appendLedger(config, {...event, timestamp: new Date(config.now()).toISOString()});
  return options.gatewayLockHeld === true ? write() : withGhGatewayLock(options, write);
}

function probeCompletionMatchesClearance(receipt, clearance) {
  return receipt?.cleared_hold_id === clearance?.cleared_hold_id &&
    receipt?.clearance_at === clearance?.cleared_at;
}

function probeDispositionMatchesClearance(receipt, clearance) {
  return receipt?.cleared_hold_id === clearance?.cleared_hold_id &&
    receipt?.clearance_at === clearance?.cleared_at &&
    receipt?.disposition === 'superseded_by_throttle';
}

export async function clearGhGatewayThrottle({
  founderDecisionId,
  clearedHoldId,
  at = null,
  expectedProviderPause,
  gatewayLockHeld = false,
  ...options
} = {}) {
  if (typeof founderDecisionId !== 'string' || !founderDecisionId.trim()) {
    throw new Error('GitHub gateway throttle clearance requires a founder decision ID');
  }
  if (typeof clearedHoldId !== 'string' || !clearedHoldId.trim()) {
    throw new Error('GitHub gateway throttle clearance requires the cleared hold ID');
  }
  const config = configuration(options);
  await ensureConfigurationAllowed(config);
  const clearedAt = at ?? new Date(config.now()).toISOString();
  if (!Number.isFinite(Date.parse(clearedAt))) throw new Error('GitHub gateway throttle clearance time is invalid');
  const stateFile = path.join(config.stateDir, 'state.json');
  const release = gatewayLockHeld ? null : await acquireLock(config);
  let operationError = null;
  try {
    const state = await readGatewayState(stateFile, {config});
    const decisionId = founderDecisionId.trim();
    const holdId = clearedHoldId.trim();
    const sameDecisionClearance = state.provider_pause_clearances.find((entry) =>
      entry?.founder_decision_id === decisionId);
    const holdClearance = state.provider_pause_clearances.find((entry) =>
      entry?.cleared_hold_id === holdId);
    if (!state.provider_pause && sameDecisionClearance) {
      const expectedMatches = expectedProviderPause === undefined ||
        JSON.stringify(sameDecisionClearance.provider_pause) === JSON.stringify(expectedProviderPause);
      if (sameDecisionClearance.cleared_hold_id !== holdId || !expectedMatches) {
        throw new GitHubGatewayRefusalError('Founder decision ID was already used for a different gateway clearance', {
          reason: 'founder-decision-reused',
        });
      }
      const intendedProbe = {
        set_at: sameDecisionClearance.cleared_at,
        cleared_hold_id: holdId,
      };
      const completed = state.probe_completions.some((receipt) =>
        probeCompletionMatchesClearance(receipt, sameDecisionClearance));
      const terminallyDisposed = state.probe_dispositions.some((receipt) =>
        probeDispositionMatchesClearance(receipt, sameDecisionClearance));
      if (!completed && !terminallyDisposed &&
          JSON.stringify(state.probe_required) !== JSON.stringify(intendedProbe)) {
        state.probe_required = intendedProbe;
        await saveGatewayState(stateFile, state);
      }
      return sameDecisionClearance;
    }
    if (!state.provider_pause && holdClearance && holdClearance.founder_decision_id !== decisionId) {
      throw new GitHubGatewayRefusalError('The gateway hold was already cleared with a different founder decision ID', {
        reason: 'founder-decision-reused',
      });
    }
    if (sameDecisionClearance) {
      throw new GitHubGatewayRefusalError('Founder decision ID was already used for a gateway clearance', {
        reason: 'founder-decision-reused',
      });
    }
    if (!state.provider_pause) return null;
    if (expectedProviderPause !== undefined) {
      const expected = JSON.stringify(expectedProviderPause);
      const actual = JSON.stringify(state.provider_pause);
      if (expected !== actual) {
        throw new GitHubGatewayRefusalError('Gateway provider pause changed before clearance', {
          reason: 'provider-pause-mismatch',
        });
      }
    }
    const clearance = {
      founder_decision_id: decisionId,
      cleared_hold_id: holdId,
      cleared_at: new Date(clearedAt).toISOString(),
      provider_pause: state.provider_pause,
      cleared_pause: {
        signal: state.provider_pause.signal,
        tripped_at: state.provider_pause.tripped_at,
      },
    };
    state.provider_pause = null;
    state.provider_pause_clearances = [...state.provider_pause_clearances, clearance];
    state.probe_required = {
      set_at: new Date(clearedAt).toISOString(),
      cleared_hold_id: clearedHoldId.trim(),
    };
    try { await saveGatewayState(stateFile, state); }
    catch (error) {
      throw new GitHubGatewayRefusalError(`GitHub gateway could not persist throttle clearance: ${error.message}`, {
        reason: 'state-write-error', cause: error,
      });
    }
    return clearance;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try { if (release) await release(); }
    catch (error) {
      if (!operationError) {
        throw new GitHubGatewayRefusalError(`GitHub gateway could not release its lock: ${error.message}`, {
          reason: 'lock-release-error', cause: error,
        });
      }
    }
  }
}

export async function recordGhTransportResult({
  class: transportClass,
  repoTarget,
  result: rawResult,
  thrown = null,
} = {}, options = {}) {
  if (transportClass !== 'git_push') throw new TypeError('unsupported GitHub transport class');
  if (typeof repoTarget !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoTarget)) {
    throw new TypeError('GitHub transport result requires an owner/repository target');
  }
  const config = configuration(options);
  await ensureConfigurationAllowed(config);
  const record = async () => {
    const stateFile = path.join(config.stateDir, 'state.json');
    const state = await readGatewayState(stateFile, {config});
    const completedAtMs = config.now();
    const result = normalizeResult(rawResult ?? {
      status: Number.isInteger(thrown?.status) ? thrown.status :
        Number.isInteger(thrown?.code) ? thrown.code : (thrown ? 1 : 0),
      stdout: thrown?.stdout,
      stderr: thrown?.stderr ?? thrown?.message,
    }, Number(rawResult?.durationMs) || 0);
    const throttle = responseThrottleDetected(result, thrown, {
      inspectStdoutText: true,
      source: 'git_transport',
    });
    state.last_request_at_ms = completedAtMs;
    state.last_request_at = new Date(completedAtMs).toISOString();
    state.last_completed_at_ms = completedAtMs;
    state.last_completed_at = new Date(completedAtMs).toISOString();
    state.last_class = 'mutation';
    let stateSaveError = null;
    try { await saveGatewayState(stateFile, state); }
    catch (error) { stateSaveError = error; }
    let ledgerError = null;
    try { await appendLedger(config, {
      timestamp: new Date(completedAtMs).toISOString(),
      event: 'transport_result',
      class: transportClass,
      repo_target: repoTarget,
      exit_code: result.status,
      duration_ms: result.durationMs,
      ...(throttle ? {throttle_detected: true} : {}),
    }); } catch (error) { ledgerError = error; }
    if (throttle) {
      const signal = throttleSignal(thrown ?? result);
      let tripError = null;
      let incident = null;
      try {
        const trip = await persistThrottleTrip(config, state, signal, new Date(completedAtMs).toISOString());
        tripError = trip.peerError;
        incident = trip.incident;
      } catch (error) {
        tripError = error;
      }
      throw new GitHubThrottleError(
        `${throttleDescription(signal)} stopped the gateway; automatic retry is forbidden`,
        {signal, result, incidentId: incident?.incident_id ?? null,
          trippedAt: incident?.tripped_at ?? null,
          cause: combinedError(
            [tripError, stateSaveError, ledgerError, thrown],
            'GitHub transport throttle and bookkeeping failures',
          ) ?? undefined},
      );
    }
    if (stateSaveError) {
      throw new GitHubGatewayRefusalError(
        `GitHub gateway could not persist transport state: ${stateSaveError.message}`,
        {reason: 'state-write-error', cause: stateSaveError},
      );
    }
    if (ledgerError) {
      throw new GitHubGatewayRefusalError(
        `GitHub gateway could not append its transport ledger: ${ledgerError.message}`,
        {reason: 'ledger-write-error', cause: ledgerError},
      );
    }
    return result;
  };
  return options.gatewayLockHeld === true ? record() : withGhGatewayLock(options, record);
}

export async function ghRequest(argv, options = {}) {
  if (!Array.isArray(argv) || !argv.length || !argv.every((argument) => typeof argument === 'string')) {
    throw new TypeError('gh argv must be a nonempty array of strings');
  }
  assertBoundedGhArgv(argv);
  const requestClass = options.requestClass ?? classifyGhRequest(argv);
  if (!REQUEST_CLASSES.has(requestClass)) {
    throw new TypeError(`gh requestClass must be one of ${[...REQUEST_CLASSES].join(', ')}`);
  }
  if (options.resumeProbe === true &&
      !isSanctionedResumeProbe(argv, requestClass, options.resumeProbe)) {
    throw new GitHubGatewayRefusalError(
      'GitHub gateway resumeProbe is valid only for exactly: gh api rate_limit',
      {reason: 'invalid-resume-probe'},
    );
  }
  const label = typeof options.label === 'string' && options.label.trim()
    ? options.label.trim()
    : `gh ${argv.slice(0, 2).join(' ')}`;
  const config = configuration(options);
  await ensureConfigurationAllowed(config);
  const {waveId, waveBudget} = waveConfiguration(options, config.environment);
  if (requestClass === 'search' && waveId === null) {
    throw new GitHubGatewayRefusalError(
      'GitHub gateway search requests require a named wave with a declared budget',
      {reason: 'search-wave-required'},
    );
  }
  const stateFile = path.join(config.stateDir, 'state.json');
  const dailyBudgetFile = path.join(config.stateDir, 'daily-request-budget.json');
  const release = await acquireLock(config);
  let requestError = null;
  try {
    const state = await readGatewayState(stateFile, {config});
    const requestContext = {argv, requestClass, resumeProbe: options.resumeProbe};
    await assertCampaignAllowsRequest(config, state, requestContext);
    const activeProbe = isSanctionedResumeProbe(argv, requestClass, options.resumeProbe) && state.probe_required
      ? JSON.parse(JSON.stringify(state.probe_required)) : null;
    const previousRequestAt = Math.max(
      Number(state.last_request_at_ms) || 0,
      Number(state.last_completed_at_ms) || 0,
    );
    if (previousRequestAt > 0) {
      const jitter = Math.floor(config.random() * (config.jitterMaxMs + 1));
      const spacing = Math.max(
        config.minSpacingMs + jitter,
        requestClass === 'search' ? config.searchSpacingMs : 0,
        state.last_class === 'mutation' ? config.mutationSpacingMs : 0,
      );
      const delay = previousRequestAt + spacing - config.now();
      if (delay > 0) await config.sleep(delay);
      await assertCampaignAllowsRequest(config, state, requestContext);
    }
    const wave = waveId && Object.hasOwn(state.waves, waveId) ? state.waves[waveId] : null;
    if (wave && waveBudget !== null && wave.declared_budget !== waveBudget) {
      throw new GitHubGatewayRefusalError(
        `GitHub gateway wave ${waveId} was declared with budget ${wave.declared_budget}; ${waveBudget} is immutable`,
        {reason: 'wave-budget-mismatch'},
      );
    }
    const declaredBudget = wave ? wave.declared_budget : waveBudget;
    const used = wave?.used ?? 0;
    if (requestClass === 'search' && declaredBudget === null) {
      throw new GitHubGatewayRefusalError(
        `GitHub gateway search wave ${waveId} requires a declared budget`,
        {reason: 'search-wave-budget-required'},
      );
    }
    if (declaredBudget !== null && used >= declaredBudget) {
      throw new GitHubGatewayRefusalError(
        `GitHub gateway wave ${waveId} exhausted its declared budget of ${declaredBudget}`,
        {reason: 'wave-budget-exhausted'},
      );
    }
    let dailyBudgetState = rollDailyBudgetState(
      await readDailyBudgetState(dailyBudgetFile, config),
      utcDate(config.now()),
      config,
    );
    if (dailyBudgetState.used_today >= dailyBudgetState.daily_cap) {
      throw new GitHubGatewayRefusalError(
        `GitHub gateway exhausted its UTC daily request budget of ${dailyBudgetState.daily_cap}`,
        {reason: 'daily-budget-exhausted'},
      );
    }
    dailyBudgetState.used_today += 1;
    const alertThreshold = dailyBudgetAlertThreshold(dailyBudgetState, config);
    const emitBudgetAlert = !dailyBudgetState.alert_emitted_today &&
      dailyBudgetState.used_today >= alertThreshold;
    if (emitBudgetAlert) dailyBudgetState.alert_emitted_today = true;
    try { await saveDailyBudgetState(dailyBudgetFile, dailyBudgetState); }
    catch (error) {
      throw new GitHubGatewayRefusalError(
        `GitHub gateway could not persist its daily request budget: ${error.message}`,
        {reason: 'daily-budget-state-write-error', cause: error},
      );
    }
    if (emitBudgetAlert) {
      try {
        await appendLedger(config, {
          timestamp: new Date(config.now()).toISOString(),
          event: 'budget_alert',
          class: 'control',
          date_utc: dailyBudgetState.date_utc,
          daily_cap: dailyBudgetState.daily_cap,
          used_today: dailyBudgetState.used_today,
          threshold_percent: config.dailyBudgetAlertThresholdPercent,
          threshold_requests: alertThreshold,
        });
      } catch (error) {
        dailyBudgetState.alert_emitted_today = false;
        let retryStateError = null;
        try { await saveDailyBudgetState(dailyBudgetFile, dailyBudgetState); }
        catch (saveError) { retryStateError = saveError; }
        throw new GitHubGatewayRefusalError(
          `GitHub gateway could not append its daily budget alert: ${error.message}`,
          {reason: 'ledger-write-error', cause: retryStateError ?? error},
        );
      }
    }
    if (waveId) {
      Object.defineProperty(state.waves, waveId, {
        value: {declared_budget: declaredBudget, used: used + 1},
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    const startedAtMs = config.now();
    state.last_request_at_ms = startedAtMs;
    state.last_request_at = new Date(startedAtMs).toISOString();
    state.last_class = requestClass;
    try { await saveGatewayState(stateFile, state); }
    catch (error) {
      throw new GitHubGatewayRefusalError(`GitHub gateway could not persist request state: ${error.message}`, {
        reason: 'state-write-error', cause: error,
      });
    }

    const runner = options.runner ?? defaultRunner;
    let result;
    let thrown = null;
    try {
      const value = await runner(argv, {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: Math.min(
          positiveInteger(options.timeoutMs, config.requestTimeoutMs),
          config.requestTimeoutMs,
        ),
        killGraceMs: config.requestKillGraceMs,
        maxBuffer: options.maxBuffer ?? DEFAULTS.maxBuffer,
        input: options.input,
      });
      result = normalizeResult(value, config.now() - startedAtMs);
    } catch (error) {
      thrown = error;
      result = normalizeResult({
        status: Number.isInteger(error?.status) ? error.status : Number.isInteger(error?.code) ? error.code : 1,
        stdout: error?.stdout,
        stderr: error?.stderr ?? error?.message,
        signal: error?.signal,
      }, config.now() - startedAtMs);
    }
    const completedAtMs = config.now();
    const throttle = responseThrottleDetected(result, thrown);
    let dailyBudgetThrottleSaveError = null;
    if (throttle) {
      dailyBudgetState.throttle_seen_today = true;
      try { await saveDailyBudgetState(dailyBudgetFile, dailyBudgetState); }
      catch (error) { dailyBudgetThrottleSaveError = error; }
    }
    state.last_completed_at_ms = completedAtMs;
    state.last_completed_at = new Date(completedAtMs).toISOString();
    state.last_class = requestClass;
    let stateSaveError = null;
    try { await saveGatewayState(stateFile, state); }
    catch (error) { stateSaveError = error; }
    const responseRateLimitFields = automaticRateLimitFields(result);
    let rateLimitFields = responseRateLimitFields;
    let rateLimitParseError = null;
    try {
      if (typeof options.parseRateLimit === 'function') {
        rateLimitFields = await options.parseRateLimit(result);
      } else if (options.rateLimitFields && typeof options.rateLimitFields === 'object') {
        rateLimitFields = options.rateLimitFields;
      }
    } catch (error) {
      rateLimitParseError = error;
    }
    const ledgerEntry = {
      timestamp: new Date(startedAtMs).toISOString(),
      label,
      class: requestClass,
      request_class: requestClass,
      argv_summary: summarizeArgv(argv),
      exit_code: result.status,
      duration_ms: Math.max(0, completedAtMs - startedAtMs),
      wave_id: waveId,
      ...(rateLimitFields ? {rate_limit: rateLimitFields} : {}),
      ...(throttle ? {throttle_detected: true} : {}),
    };
    let ledgerError = null;
    try { await appendLedger(config, ledgerEntry); }
    catch (error) { ledgerError = error; }
    if (throttle) {
      const signal = throttleSignal(thrown ?? result);
      const trippedAt = new Date(completedAtMs).toISOString();
      let tripError = null;
      let incident = null;
      try {
        const trip = await persistThrottleTrip(config, state, signal, trippedAt);
        tripError = trip.peerError;
        incident = trip.incident;
      } catch (error) {
        tripError = error;
      }
      throw new GitHubThrottleError(
        `${throttleDescription(signal)} stopped the gateway; automatic retry is forbidden`,
        {signal, result, incidentId: incident?.incident_id ?? null,
          trippedAt: incident?.tripped_at ?? trippedAt,
          cause: combinedError(
            [tripError, dailyBudgetThrottleSaveError, stateSaveError, ledgerError, rateLimitParseError, thrown],
            'GitHub request throttle and bookkeeping failures',
          ) ?? undefined},
      );
    }
    if (stateSaveError) {
      throw new GitHubGatewayRefusalError(`GitHub gateway could not persist pacing state: ${stateSaveError.message}`, {
        reason: 'state-write-error', cause: stateSaveError,
      });
    }
    if (ledgerError) {
      throw new GitHubGatewayRefusalError(`GitHub gateway could not append its request ledger: ${ledgerError.message}`, {
        reason: 'ledger-write-error', cause: ledgerError,
      });
    }
    if (rateLimitParseError) {
      throw new GitHubGatewayRefusalError(`GitHub gateway rate-limit parsing failed: ${rateLimitParseError.message}`, {
        reason: 'rate-limit-parse-error', cause: rateLimitParseError,
      });
    }
    if (thrown) throw thrown;
    if (activeProbe && result.status === 0) {
      if (!validRateLimitFields(responseRateLimitFields)) {
        throw new GitHubGatewayRefusalError(
          'GitHub gateway resume probe did not return valid rate-limit evidence',
          {reason: 'invalid-resume-probe-evidence'},
        );
      }
      const completion = {
        cleared_hold_id: activeProbe.cleared_hold_id,
        clearance_at: activeProbe.set_at,
        completed_at: new Date(completedAtMs).toISOString(),
        ledger_timestamp: ledgerEntry.timestamp,
      };
      if (!state.probe_completions.some((receipt) =>
        receipt.cleared_hold_id === completion.cleared_hold_id &&
        receipt.clearance_at === completion.clearance_at)) {
        state.probe_completions = [...state.probe_completions, completion];
      }
      state.probe_required = null;
      try { await saveGatewayState(stateFile, state); }
      catch (error) {
        throw new GitHubGatewayRefusalError(
          `GitHub gateway could not persist resume probe completion: ${error.message}`,
          {reason: 'state-write-error', cause: error},
        );
      }
    }
    return result;
  } catch (error) {
    requestError = error;
    throw error;
  } finally {
    try { await release(); }
    catch (error) {
      if (!requestError) {
        throw new GitHubGatewayRefusalError(`GitHub gateway could not release its lock: ${error.message}`, {
          reason: 'lock-release-error', cause: error,
        });
      }
    }
  }
}

export const runGh = ghRequest;
