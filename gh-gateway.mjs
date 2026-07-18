import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
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
  constructor(message, {signal = 'GITHUB_PROVIDER_THROTTLE', result = null, cause} = {}) {
    super(message, {reason: 'provider-throttle', cause});
    this.name = 'GitHubThrottleError';
    this.code = 'GITHUB_PROVIDER_THROTTLED';
    this.signal = signal;
    this.result = result;
  }
}

export function isGhGatewayTerminalError(error) {
  return error instanceof GitHubGatewayError;
}

export function classifyGhRequest(argv) {
  if (!Array.isArray(argv)) throw new TypeError('gh argv must be an array');
  if (argv[0] === 'search' || (argv[0] === 'api' && /^search(?:\/|$)/.test(argv[1] ?? ''))) return 'search';
  if (argv[0] === 'api' && argv[1] === 'graphql') return 'graphql';
  if (MUTATION_COMMANDS.has(`${argv[0] ?? ''} ${argv[1] ?? ''}`)) return 'mutation';
  if (argv[0] === 'api') {
    const methodIndex = argv.findIndex((argument) => argument === '--method' || argument === '-X');
    const method = methodIndex >= 0 ? String(argv[methodIndex + 1] ?? '').toUpperCase() : null;
    if (method) return method === 'GET' || method === 'HEAD' ? 'rest_read' : 'mutation';
    if (argv.some((argument) => ['-f', '-F', '--field', '--raw-field'].includes(argument))) return 'mutation';
  }
  return 'rest_read';
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

function configuration(options) {
  const environment = {...process.env, ...(options.env ?? {})};
  const testMode = options.testMode === true || environment.OSS_GH_GATEWAY_TEST_MODE === '1';
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
  const requestedDailyBudget = options.dailyBudget ?? {};
  const dailyBudgetFloor = positiveInteger(
    requestedDailyBudget.floor ?? environment.OSS_GH_DAILY_BUDGET_FLOOR,
    DEFAULTS.dailyBudgetFloor,
  );
  const dailyBudgetCeiling = Math.max(dailyBudgetFloor, positiveInteger(
    requestedDailyBudget.ceiling ?? environment.OSS_GH_DAILY_BUDGET_CEILING,
    DEFAULTS.dailyBudgetCeiling,
  ));
  const dailyBudgetStartingCap = Math.min(dailyBudgetCeiling, Math.max(dailyBudgetFloor,
    positiveInteger(
      requestedDailyBudget.startingCap ?? environment.OSS_GH_DAILY_BUDGET_STARTING_CAP,
      DEFAULTS.dailyBudgetStartingCap,
    )));
  return {
    environment,
    testMode,
    stateDir: path.resolve(options.stateDir ?? environment.OSS_GH_GATEWAY_STATE_DIR ?? DEFAULTS.stateDir),
    ledgerFile: path.resolve(options.ledgerFile ?? environment.OSS_GH_REQUEST_LEDGER ?? DEFAULTS.ledgerFile),
    resourceControlFile: path.resolve(options.resourceControlFile ??
      environment.OSS_RESOURCE_CONTROL_FILE ?? DEFAULTS.resourceControlFile),
    controlStateFile: path.resolve(options.controlStateFile ??
      environment.OSS_CAMPAIGN_CONTROL_STATE ?? DEFAULTS.controlStateFile),
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
    dailyBudgetAlertThresholdPercent: percentageInteger(
      requestedDailyBudget.alertThresholdPercent ??
        environment.OSS_GH_DAILY_BUDGET_ALERT_THRESHOLD_PERCENT,
      DEFAULTS.dailyBudgetAlertThresholdPercent,
    ),
    dailyBudgetAdditiveIncreasePercent: percentageInteger(
      requestedDailyBudget.additiveIncreasePercent ??
        environment.OSS_GH_DAILY_BUDGET_ADDITIVE_INCREASE_PERCENT,
      DEFAULTS.dailyBudgetAdditiveIncreasePercent,
      {allowZero: true},
    ),
    dailyBudgetMultiplicativeDecreasePercent: percentageInteger(
      requestedDailyBudget.multiplicativeDecreasePercent ??
        environment.OSS_GH_DAILY_BUDGET_MULTIPLICATIVE_DECREASE_PERCENT,
      DEFAULTS.dailyBudgetMultiplicativeDecreasePercent,
    ),
    now: testMode && typeof options.now === 'function' ? options.now : Date.now,
    sleep: testMode && typeof options.sleep === 'function'
      ? options.sleep
      : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    random: testMode && typeof options.random === 'function' ? options.random : Math.random,
    processIdentity: testMode && typeof options.processIdentity === 'function'
      ? options.processIdentity : processStartIdentity,
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

async function removeAbandonedLock(lockFile, staleLockMs, now, identityForPid) {
  let record = null;
  try { record = JSON.parse(await readFile(lockFile, 'utf8')); } catch {}
  const details = await stat(lockFile).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!details) return {removed: false, disappeared: true};
  if (now() - details.mtimeMs < staleLockMs) return {removed: false, disappeared: false};

  const pid = Number(record?.pid);
  const alive = processExists(pid);
  let identityMismatch = false;
  if (alive === true && typeof record?.process_start_identity === 'string' &&
      record.process_start_identity.startsWith('ps:')) {
    const currentIdentity = await identityForPid(pid);
    identityMismatch = currentIdentity !== null && currentIdentity !== record.process_start_identity;
  }
  const holderDead = alive === false || alive === null;
  if (!holderDead && !identityMismatch) return {removed: false, disappeared: false};
  await unlink(lockFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  return {
    removed: true,
    disappeared: false,
    record,
    reason: identityMismatch ? 'process-identity-mismatch' : 'process-not-running',
  };
}

async function acquireLock(config) {
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
      const recovery = await removeAbandonedLock(
        lockFile, config.staleLockMs, config.now, config.processIdentity,
      );
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
  const state = await readGatewayState(stateFile);
  state.last_request_at_ms = reclaimedAtMs;
  state.last_request_at = new Date(reclaimedAtMs).toISOString();
  await saveGatewayState(stateFile, state);
  await appendLedger(config.ledgerFile, {
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
    waves: {},
  };
}

function validWaveId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

async function readGatewayState(file) {
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
  if (state?.schema_version !== 1 || !timestampsValid ||
      (state.last_class !== null && !REQUEST_CLASSES.has(state.last_class)) || !providerPauseValid ||
      !Array.isArray(state?.provider_pause_clearances) || !wavesValid) {
    throw new GitHubGatewayRefusalError('GitHub gateway state is invalid', {reason: 'invalid-state'});
  }
  state.waves = Object.fromEntries(Object.entries(state.waves).map(([waveId, wave]) => [
    waveId,
    Number.isInteger(wave) ? {declared_budget: null, used: wave} : wave,
  ]));
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
  if (state.date_utc === dateUtc) return state;
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
  let dailyCap = state.daily_cap;
  if (state.throttle_seen_today) {
    dailyCap = Math.max(
      Math.floor(state.daily_cap * config.dailyBudgetMultiplicativeDecreasePercent / 100),
      config.dailyBudgetFloor,
    );
  } else if (state.used_today >= 1) {
    dailyCap = Math.min(
      Math.floor(state.daily_cap * (100 + config.dailyBudgetAdditiveIncreasePercent) / 100),
      config.dailyBudgetCeiling,
    );
  }
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

function dailyBudgetView(state, config) {
  const thresholdRequests = dailyBudgetAlertThreshold(state, config);
  return {
    schema_version: state.schema_version,
    date_utc: state.date_utc,
    daily_cap: state.daily_cap,
    used_today: state.used_today,
    remaining_today: Math.max(0, state.daily_cap - state.used_today),
    throttle_seen_today: state.throttle_seen_today,
    alert: {
      threshold_percent: config.dailyBudgetAlertThresholdPercent,
      threshold_requests: thresholdRequests,
      active: state.used_today >= thresholdRequests,
      emitted_today: state.alert_emitted_today,
    },
    recent_history: state.history.slice(-7),
  };
}

async function assertCampaignAllowsRequest(config, gatewayState) {
  if (gatewayState.provider_pause) {
    throw new GitHubGatewayRefusalError(
      'GitHub gateway refused the request because its durable provider-throttle latch is active',
      {reason: 'gateway-provider-throttle'},
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
      /\bhttp(?:\/\d(?:\.\d)?)?\s*429\b|\b429\s+too many requests\b|\bstatus(?:\s+code)?\s*[:=]?\s*429\b/i.test(text)) {
    return 'HTTP_429';
  }
  if (/\bretry-after\b/i.test(text)) return 'RETRY_AFTER';
  return 'GITHUB_PROVIDER_THROTTLE';
}

function responseThrottleDetected(result, thrown) {
  if (thrown || result.status !== 0) {
    return isProviderThrottle({
      message: thrown?.message,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  if (result.stderr && isProviderThrottle(result.stderr)) return true;
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

async function appendLedger(file, entry) {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  await appendFile(file, `${JSON.stringify(entry)}\n`, {mode: 0o600});
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
  const read = async () => JSON.parse(JSON.stringify(
    await readGatewayState(path.join(config.stateDir, 'state.json')),
  ));
  return options.gatewayLockHeld === true ? read() : withGhGatewayLock(options, read);
}

export async function readGhDailyBudgetState(options = {}) {
  const config = configuration(options);
  const file = path.join(config.stateDir, 'daily-request-budget.json');
  const state = await readDailyBudgetState(file, config);
  const projected = rollDailyBudgetState(state, utcDate(config.now()), config);
  return dailyBudgetView(projected, config);
}

export async function assertGhNetworkAllowed(options = {}) {
  const config = configuration(options);
  const check = async () => {
    const state = await readGatewayState(path.join(config.stateDir, 'state.json'));
    await assertCampaignAllowsRequest(config, state);
    return true;
  };
  return options.gatewayLockHeld === true ? check() : withGhGatewayLock(options, check);
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
  await appendLedger(config.ledgerFile, {
    ...event,
    timestamp: new Date(config.now()).toISOString(),
  });
}

export async function clearGhGatewayThrottle({
  founderDecisionId,
  expectedProviderPause,
  gatewayLockHeld = false,
  ...options
} = {}) {
  if (typeof founderDecisionId !== 'string' || !founderDecisionId.trim()) {
    throw new Error('GitHub gateway throttle clearance requires a founder decision ID');
  }
  const config = configuration(options);
  const stateFile = path.join(config.stateDir, 'state.json');
  const release = gatewayLockHeld ? null : await acquireLock(config);
  let operationError = null;
  try {
    const state = await readGatewayState(stateFile);
    if (state.provider_pause_clearances.some((entry) =>
      entry?.founder_decision_id === founderDecisionId.trim())) {
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
      founder_decision_id: founderDecisionId.trim(),
      cleared_at: new Date(config.now()).toISOString(),
      provider_pause: state.provider_pause,
      cleared_pause: {
        signal: state.provider_pause.signal,
        tripped_at: state.provider_pause.tripped_at,
      },
    };
    state.provider_pause = null;
    state.provider_pause_clearances = [...state.provider_pause_clearances, clearance];
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

export async function ghRequest(argv, options = {}) {
  if (!Array.isArray(argv) || !argv.length || !argv.every((argument) => typeof argument === 'string')) {
    throw new TypeError('gh argv must be a nonempty array of strings');
  }
  const requestClass = options.requestClass ?? classifyGhRequest(argv);
  if (!REQUEST_CLASSES.has(requestClass)) {
    throw new TypeError(`gh requestClass must be one of ${[...REQUEST_CLASSES].join(', ')}`);
  }
  const label = typeof options.label === 'string' && options.label.trim()
    ? options.label.trim()
    : `gh ${argv.slice(0, 2).join(' ')}`;
  const config = configuration(options);
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
    const state = await readGatewayState(stateFile);
    await assertCampaignAllowsRequest(config, state);
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
      await assertCampaignAllowsRequest(config, state);
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
        await appendLedger(config.ledgerFile, {
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
    let rateLimitFields = automaticRateLimitFields(result);
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
    try { await appendLedger(config.ledgerFile, ledgerEntry); }
    catch (error) { ledgerError = error; }
    if (throttle) {
      const signal = throttleSignal(thrown ?? result);
      state.provider_pause = {
        kind: 'PROVIDER_THROTTLED',
        provider: 'GitHub',
        signal,
        tripped_at: new Date(completedAtMs).toISOString(),
        auto_resume: false,
      };
      let latchSaveError = null;
      try { await saveGatewayState(stateFile, state); }
      catch (error) { latchSaveError = error; }
      let tripError = null;
      try {
        await tripPersistentProviderThrottle(config.resourceControlFile, {
          provider: 'GitHub', signal, gatewayLockHeld: true, gatewayStateDir: config.stateDir,
        });
      } catch (error) {
        tripError = error;
      }
      const descriptions = {
        GITHUB_SECONDARY_RATE_LIMIT: 'GitHub secondary rate limit',
        GITHUB_ABUSE_DETECTION: 'GitHub abuse detection',
        HTTP_429: 'GitHub HTTP 429',
        RETRY_AFTER: 'GitHub Retry-After throttle',
        GITHUB_PROVIDER_THROTTLE: 'GitHub provider throttle',
      };
      throw new GitHubThrottleError(
        `${descriptions[signal]} stopped the gateway; automatic retry is forbidden`,
        {signal, result, cause: tripError ?? latchSaveError ?? dailyBudgetThrottleSaveError ??
          stateSaveError ?? ledgerError ?? rateLimitParseError ?? thrown ?? undefined},
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
