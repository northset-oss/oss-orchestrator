import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const PRIORITIES = Object.freeze({
  maintainer_response: 1,
  final_submission: 2,
  reconciliation: 3,
  live_preflight: 4,
  discovery_top_up: 5,
});

const PUBLIC_LIMITS = Object.freeze({
  repositoryOpen: 1,
  ownerPerDay: 2,
  perHour: 4,
  perDay: 30,
});

export class GitHubSafetyError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'GitHubSafetyError';
    this.code = code;
    Object.assign(this, details);
  }
}

export class GitHubPausedError extends GitHubSafetyError {
  constructor(pause) {
    super(`GitHub transport is paused: ${pause.kind}`, 'GITHUB_PAUSED', {pause});
    this.name = 'GitHubPausedError';
  }
}

export class GitHubPublicLimitError extends GitHubSafetyError {
  constructor(reason) {
    super(`GitHub PR creation refused: ${reason}`, 'GITHUB_PUBLIC_LIMIT', {reason});
    this.name = 'GitHubPublicLimitError';
  }
}

function timeMs(now) {
  const value = now();
  const parsed = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError('now() must return a Date or epoch milliseconds');
  return parsed;
}

function iso(now) {
  return new Date(timeMs(now)).toISOString();
}

function normalizeHeaders(value) {
  const headers = {};
  if (!value) return headers;
  if (typeof value.forEach === 'function') {
    value.forEach((entry, key) => { headers[String(key).toLowerCase()] = String(entry); });
    return headers;
  }
  const entries = Array.isArray(value) ? value : Object.entries(value);
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    headers[String(entry[0]).toLowerCase()] = Array.isArray(entry[1])
      ? entry[1].join(', ') : String(entry[1]);
  }
  return headers;
}

function responseStatus(result) {
  for (const value of [result?.httpStatus, result?.statusCode, result?.response?.status, result?.status]) {
    if (Number.isInteger(Number(value))) return Number(value);
  }
  return result?.code === 0 ? 200 : Number(result?.code) || 0;
}

function structuredBody(result) {
  for (const value of [result?.body, result?.data, result?.response?.body, result?.response?.data]) {
    if (value && typeof value === 'object') return value;
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch {}
    }
  }
  if (typeof result?.stdout === 'string') {
    try { return JSON.parse(result.stdout); } catch {}
  }
  return null;
}

function topLevelMessage(result, body) {
  return [result?.message, body?.message, result?.stderr]
    .find((value) => typeof value === 'string' && value.trim())?.trim() ?? '';
}

function rateLimitedGraphQl(body) {
  const normalized = (value) => typeof value === 'string' &&
    value.replace(/[_ -]+/g, '').toUpperCase() === 'RATELIMITED';
  return Array.isArray(body?.errors) && body.errors.some((error) =>
    normalized(error?.type) || normalized(error?.code) || normalized(error?.extensions?.code));
}

function retryAfter(headers, nowMs) {
  const value = headers['retry-after'];
  if (value === undefined) return null;
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number(value.trim());
    return {seconds, untilMs: nowMs + seconds * 1_000};
  }
  const untilMs = Date.parse(value);
  if (!Number.isFinite(untilMs)) return {seconds: null, untilMs: nowMs};
  return {seconds: Math.max(0, Math.ceil((untilMs - nowMs) / 1_000)), untilMs};
}

function primaryReset(headers, body) {
  const remaining = headers['x-ratelimit-remaining'] ?? body?.rateLimit?.remaining ??
    body?.data?.rateLimit?.remaining;
  if (Number(remaining) !== 0) return null;
  const raw = headers['x-ratelimit-reset'] ?? body?.rateLimit?.resetAt ??
    body?.data?.rateLimit?.resetAt ?? body?.rateLimit?.reset;
  if (raw === undefined || raw === null || raw === '') return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function inspectResult(result, nowMs) {
  const status = responseStatus(result);
  const headers = normalizeHeaders(result?.headers ?? result?.response?.headers);
  const body = structuredBody(result);
  const message = topLevelMessage(result, body);
  const signal = String(result?.signal ?? result?.kind ?? body?.signal ?? body?.kind ?? '').toUpperCase();
  const documentation = String(body?.documentation_url ?? body?.documentationUrl ?? '');
  const retry = retryAfter(headers, nowMs);
  const platformRestriction = result?.platformRestriction === true || result?.platformWarning === true ||
    result?.accountRestriction === true ||
    ['GITHUB_ACCOUNT_RESTRICTION', 'GITHUB_PLATFORM_WARNING'].includes(signal) ||
    /\baccount\b[^\n]{0,80}\b(?:suspended|restricted|disabled)\b/i.test(message);
  const secondaryText = `${message}\n${documentation}`;
  const exhaustedUntil = primaryReset(headers, body);
  const secondary = exhaustedUntil === null && (status === 429 || retry !== null || rateLimitedGraphQl(body) ||
    ['GITHUB_SECONDARY_RATE_LIMIT', 'GITHUB_ABUSE_DETECTION', 'RETRY_AFTER'].includes(signal) ||
    /\bsecondary[ _-]+rate[ _-]+limit|\babuse[ -]+detection\b/i.test(secondaryText) ||
    (status === 403 && /\b(?:rate[ _-]*limit|abuse)\b/i.test(secondaryText)));
  const kind = platformRestriction ? 'GITHUB_ACCOUNT_RESTRICTION'
    : signal === 'GITHUB_ABUSE_DETECTION' || /\babuse[ -]+detection\b/i.test(secondaryText)
      ? 'GITHUB_ABUSE_DETECTION'
      : retry !== null ? 'GITHUB_RETRY_AFTER'
        : status === 429 ? 'GITHUB_HTTP_429'
          : 'GITHUB_SECONDARY_RATE_LIMIT';
  return {
    status,
    headers,
    body,
    message,
    platformRestriction,
    secondary,
    kind,
    retry,
    primaryResetMs: exhaustedUntil,
    transient: status >= 500 && status <= 599,
  };
}

function transientNetworkError(error) {
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETDOWN', 'ENETUNREACH',
    'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(String(error?.code ?? '').toUpperCase()) ||
    error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

async function readPause(pauseFile) {
  try {
    const value = JSON.parse(await readFile(pauseFile, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writePause(pauseFile, value) {
  await mkdir(path.dirname(pauseFile), {recursive: true});
  const temporary = `${pauseFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
  await rename(temporary, pauseFile);
  return value;
}

function pauseFromInspection(inspection, now) {
  const observedAt = iso(now);
  return {
    paused: true,
    kind: inspection.kind,
    observed_at: observedAt,
    retry_after: inspection.retry?.seconds ?? null,
    retry_after_until: inspection.retry
      ? new Date(inspection.retry.untilMs).toISOString() : null,
    details: inspection.message.slice(0, 500) || `GitHub response status ${inspection.status}`,
    cleared_at: null,
    cleared_by: null,
  };
}

function priority(value) {
  if (Number.isInteger(value) && value >= 1) return value;
  if (Object.hasOwn(PRIORITIES, value)) return PRIORITIES[value];
  throw new TypeError(`unknown GitHub request priority ${JSON.stringify(value)}`);
}

function isMutation(kind) {
  return ['mutation', 'git_push', 'pr_create'].includes(kind);
}

function successful(result) {
  const status = responseStatus(result);
  return status === 0 || status < 400;
}

async function repositorySnapshot(repositoryState, context) {
  if (!repositoryState) return {};
  if (typeof repositoryState === 'function') return await repositoryState(context) ?? {};
  if (typeof repositoryState.getPublicActionState === 'function') {
    return await repositoryState.getPublicActionState(context) ?? {};
  }
  if (typeof repositoryState.getPublicationState === 'function') {
    return await repositoryState.getPublicationState(context) ?? {};
  }
  if (typeof repositoryState.getRepositoryState === 'function') {
    return await repositoryState.getRepositoryState(context.repository) ?? {};
  }
  if (typeof repositoryState.get === 'function') return await repositoryState.get(context.repository) ?? {};
  return repositoryState[context.repository] ?? repositoryState;
}

function numberField(state, names) {
  for (const name of names) {
    const value = Number(state?.[name]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

function activeCooldown(state, nowMs) {
  const until = state.cooldown_until ?? state.cooldownUntil ?? null;
  const reason = state.cooldown_reason ?? state.cooldownReason ?? null;
  if (until === 'manual-release') return reason ?? 'repository cooldown requires manual release';
  if (until) {
    const parsed = Date.parse(until);
    if (!Number.isFinite(parsed) || parsed > nowMs) return reason ?? `repository cooldown until ${until}`;
  }
  if (reason && !until) return reason;
  return null;
}

export function createGitHubSafety({
  pauseFile,
  transport,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  mutationSpacingMs = 1_250,
  searchSpacingMs = 2_000,
  repositoryState = null,
} = {}) {
  if (typeof pauseFile !== 'string' || !pauseFile) throw new TypeError('pauseFile is required');
  if (typeof transport !== 'function') throw new TypeError('transport is required');
  if (![mutationSpacingMs, searchSpacingMs].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new TypeError('GitHub spacing values must be non-negative numbers');
  }

  const queue = [];
  const sessionPublications = [];
  let sequence = 0;
  let scheduled = false;
  let draining = false;
  let active = false;
  let lastMutationStart = null;
  let lastSearchStart = null;
  let primaryWaitUntil = null;

  const rejectQueued = (pause) => {
    while (queue.length) queue.shift().reject(new GitHubPausedError(pause));
  };

  const assertPublicAction = async ({repository, owner} = {}) => {
    if (typeof repository !== 'string' || !repository.includes('/')) {
      throw new TypeError('PR creation requires repository owner/name');
    }
    const effectiveOwner = owner ?? repository.split('/')[0];
    const nowMs = timeMs(now);
    const state = await repositorySnapshot(repositoryState, {repository, owner: effectiveOwner, now: new Date(nowMs)});
    const cooldown = activeCooldown(state, nowMs);
    if (cooldown) throw new GitHubPublicLimitError(`repository cooldown: ${cooldown}`);
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const recent = sessionPublications.filter((item) => item.at > nowMs - 60 * 60 * 1_000);
    const sessionToday = sessionPublications.filter((item) => item.day === today);
    const repoOpen = numberField(state, ['open_northset_prs', 'openNorthsetPrs']);
    if (repoOpen >= PUBLIC_LIMITS.repositoryOpen) {
      throw new GitHubPublicLimitError(`one-open-PR cap reached for ${repository}`);
    }
    const ownerToday = Math.max(
      numberField(state, ['owner_prs_today', 'ownerPrsToday', 'owner_new_prs_today']),
      sessionToday.filter((item) => item.owner.toLowerCase() === effectiveOwner.toLowerCase()).length,
    );
    if (ownerToday >= PUBLIC_LIMITS.ownerPerDay) {
      throw new GitHubPublicLimitError(`owner/day cap reached for ${effectiveOwner}`);
    }
    const hourCount = Math.max(numberField(state, ['prs_last_hour', 'prsLastHour', 'new_prs_last_hour']), recent.length);
    if (hourCount >= PUBLIC_LIMITS.perHour) throw new GitHubPublicLimitError('hourly PR cap reached');
    const dayCount = Math.max(numberField(state, ['prs_today', 'prsToday', 'new_prs_today']), sessionToday.length);
    if (dayCount >= PUBLIC_LIMITS.perDay) throw new GitHubPublicLimitError('daily PR cap reached');
    return true;
  };

  const waitForSpacing = async (request) => {
    const current = timeMs(now);
    const previous = request.kind === 'search' ? lastSearchStart
      : isMutation(request.kind) ? lastMutationStart : null;
    const spacing = request.kind === 'search' ? searchSpacingMs
      : isMutation(request.kind) ? mutationSpacingMs : 0;
    if (previous !== null && current < previous + spacing) await sleep(previous + spacing - current);
    const started = timeMs(now);
    if (request.kind === 'search') lastSearchStart = started;
    if (isMutation(request.kind)) lastMutationStart = started;
  };

  const execute = async (request) => {
    if (request.kind === 'pr_create') await assertPublicAction(request);
    let transientRetried = false;
    const handledPrimaryResets = new Set();
    while (true) {
      await waitForSpacing(request);
      let result;
      try {
        result = await transport(request);
      } catch (error) {
        const inspection = inspectResult(error, timeMs(now));
        if (inspection.secondary || inspection.platformRestriction) {
          const pause = await writePause(pauseFile, pauseFromInspection(inspection, now));
          rejectQueued(pause);
          throw new GitHubPausedError(pause);
        }
        if (!transientRetried && transientNetworkError(error)) {
          transientRetried = true;
          continue;
        }
        throw error;
      }
      const inspection = inspectResult(result, timeMs(now));
      if (inspection.secondary || inspection.platformRestriction) {
        const pause = await writePause(pauseFile, pauseFromInspection(inspection, now));
        rejectQueued(pause);
        throw new GitHubPausedError(pause);
      }
      if (inspection.primaryResetMs !== null) {
        if (handledPrimaryResets.has(inspection.primaryResetMs)) return result;
        handledPrimaryResets.add(inspection.primaryResetMs);
        primaryWaitUntil = inspection.primaryResetMs;
        const delay = Math.max(0, inspection.primaryResetMs - timeMs(now));
        if (delay > 0) await sleep(delay);
        primaryWaitUntil = null;
        continue;
      }
      if (inspection.transient && !transientRetried) {
        transientRetried = true;
        continue;
      }
      if (request.kind === 'pr_create' && successful(result)) {
        const at = timeMs(now);
        sessionPublications.push({
          repository: request.repository,
          owner: request.owner ?? request.repository.split('/')[0],
          at,
          day: new Date(at).toISOString().slice(0, 10),
        });
      }
      return result;
    }
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    scheduled = false;
    try {
      while (queue.length) {
        const pause = await readPause(pauseFile);
        if (pause?.paused) {
          rejectQueued(pause);
          break;
        }
        queue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
        const item = queue.shift();
        active = true;
        try { item.resolve(await execute(item.request)); }
        catch (error) { item.reject(error); }
        finally { active = false; }
      }
    } finally {
      draining = false;
      if (queue.length && !scheduled) {
        scheduled = true;
        queueMicrotask(drain);
      }
    }
  };

  const request = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return Promise.reject(new TypeError('GitHub request must be an object'));
    }
    if (!['read', 'search', 'mutation', 'git_push', 'pr_create'].includes(value.kind)) {
      return Promise.reject(new TypeError(`unknown GitHub request kind ${JSON.stringify(value.kind)}`));
    }
    let requestPriority;
    try { requestPriority = priority(value.priority ?? 'live_preflight'); }
    catch (error) { return Promise.reject(error); }
    const promise = new Promise((resolve, reject) => {
      queue.push({request: value, priority: requestPriority, sequence: sequence++, resolve, reject});
    });
    if (!scheduled && !draining) {
      scheduled = true;
      queueMicrotask(drain);
    }
    return promise;
  };

  const status = async () => {
    const pause = await readPause(pauseFile);
    return {
      paused: pause?.paused === true,
      pause,
      queue_depth: queue.length,
      active,
      primary_wait_until: primaryWaitUntil === null ? null : new Date(primaryWaitUntil).toISOString(),
      limits: {...PUBLIC_LIMITS},
    };
  };

  return {request, status, assertPublicAction};
}

export async function resumeGitHub({
  pauseFile,
  reason,
  clearedBy,
  transport,
  now = () => Date.now(),
} = {}) {
  if (typeof pauseFile !== 'string' || !pauseFile) throw new TypeError('pauseFile is required');
  if (typeof transport !== 'function') throw new TypeError('transport is required');
  if (typeof reason !== 'string' || !reason.trim()) throw new TypeError('resume reason is required');
  if (typeof clearedBy !== 'string' || !clearedBy.trim()) throw new TypeError('clearedBy is required');
  const pause = await readPause(pauseFile);
  if (!pause?.paused) throw new GitHubSafetyError('GitHub transport is not paused', 'GITHUB_NOT_PAUSED');
  if (pause.kind === 'GITHUB_ACCOUNT_RESTRICTION') {
    throw new GitHubSafetyError('GitHub account restriction requires founder/support review', 'GITHUB_RESTRICTION_REVIEW');
  }
  const retryAt = Date.parse(pause.retry_after_until ?? '');
  if (Number.isFinite(retryAt) && timeMs(now) < retryAt) {
    throw new GitHubSafetyError('GitHub Retry-After interval has not elapsed', 'GITHUB_RETRY_AFTER_ACTIVE', {
      retry_at: new Date(retryAt).toISOString(),
    });
  }
  let result;
  try {
    result = await transport({
      priority: 'maintainer_response',
      kind: 'read',
      operation: 'rate_limit_probe',
      path: '/rate_limit',
      probe: true,
    });
  } catch (error) {
    const inspection = inspectResult(error, timeMs(now));
    if (inspection.secondary || inspection.platformRestriction) {
      const nextPause = await writePause(pauseFile, pauseFromInspection(inspection, now));
      throw new GitHubPausedError(nextPause);
    }
    throw error;
  }
  const inspection = inspectResult(result, timeMs(now));
  if (inspection.secondary || inspection.platformRestriction) {
    const nextPause = await writePause(pauseFile, pauseFromInspection(inspection, now));
    throw new GitHubPausedError(nextPause);
  }
  if (inspection.primaryResetMs !== null || inspection.status >= 400) {
    throw new GitHubSafetyError('GitHub resume probe did not show available capacity', 'GITHUB_PROBE_FAILED');
  }
  const cleared = {
    ...pause,
    paused: false,
    cleared_at: iso(now),
    cleared_by: clearedBy.trim(),
    clear_reason: reason.trim(),
  };
  await writePause(pauseFile, cleared);
  return cleared;
}
