#!/usr/bin/env node

/**
 * Northset OSS candidate finder v2.
 *
 * Finite pipeline:
 *   GitHub search -> deterministic live preflight -> one semantic review -> audited batch.
 *
 * Exit codes:
 *   0: requested batch completed (or --dry-run completed)
 *   2: valid partial batch; budget or eligible queue was exhausted
 *   1: finder infrastructure/configuration failure
 */

import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {PROFILE_REGISTRY, isInvitationLabel, normalizeLabel, taskIdForCandidate} from './core.mjs';
import {candidateEvidenceKey, canonicalCandidate, openCandidateLake} from './candidate-lake.mjs';
import {assertPhase1Runtime} from './campaign/phase1/runtime-guard.mjs';
import {
  assertGhRateSafetyAllowsAction,
  ghRequest,
  isGhGatewayTerminalError,
  resolveGhGatewayStateDir,
} from './gh-gateway.mjs';
import {
  TRUSTED_MODEL_PROVIDER_ERROR_FIELD,
  isProviderThrottle,
  loadResourceControl,
  tripPersistentProviderThrottle,
  trustedModelProviderError,
} from './campaign/phase0/resource-breakers.mjs';

export {isInvitationLabel, normalizeLabel};

export const FINDER_SCHEMA_VERSION = 2;
export const FINDER_VERSION = '3.0.0';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const DEFAULT_HISTORY = path.join(SCRIPT_DIR, 'runs', 'candidate-history-v2.jsonl');
const DEFAULT_REVIEWER = path.join(SCRIPT_DIR, 'review-issue.mjs');
const DEFAULT_REPO_POLICY = path.join(SCRIPT_DIR, 'repo-policy.json');
const DEFAULT_RESOURCE_CONTROL = path.join(SCRIPT_DIR, 'runs', 'phase0', 'resource-control.json');
const DEFAULT_LAKE = path.join(SCRIPT_DIR, 'candidate_lake.sqlite');
const DEFAULT_LABELS = ['good first issue', 'help wanted'];
export const SUPPORTED_PROFILES = Object.freeze(Object.keys(PROFILE_REGISTRY.profiles));
export const PROFILE_LANGUAGES = Object.freeze(Object.fromEntries(
  Object.entries(PROFILE_REGISTRY.profiles).map(([name, value]) => [name, value.languages]),
));
export const INVITATION_LABEL_PATTERNS = [
  /good.?first.?issue/i,
  /help.?wanted/i,
  /up.?for.?grabs/i,
  /beginner.?friendly/i,
  /\beasy\b/i,
  /e[-: ]?help.?wanted/i,
  /status[: ]?help.?wanted/i,
  /effort[: ]?good.?first.?issue/i,
];
const MAX_SEARCH_QUERIES = 20;
const DEFAULT_MAX_OUTPUT_BYTES = 4_000_000;
const GITHUB_REST_API_VERSION = '2026-03-10';

export function assignCrawlProfile(repository, requestedProfiles, policyProfile = null) {
  const requested = new Set(requestedProfiles ?? []);
  const available = SUPPORTED_PROFILES.filter((profile) => requested.has(profile));
  if (!available.length) throw new Error('crawl profile assignment requires at least one supported profile');
  if (available.length === 1) return available[0];
  if (policyProfile && available.includes(policyProfile)) return policyProfile;
  const language = String(repository?.primary_language ?? repository?.primaryLanguage ?? '').toLowerCase();
  return available.find((profile) => (PROFILE_LANGUAGES[profile] ?? [])
    .some((candidate) => candidate.toLowerCase() === language)) ?? available[0];
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function progress(message) {
  process.stderr.write(`[finder ${nowIso()}] ${message}\n`);
}

export function canonical(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('cannot canonicalize a non-finite number');
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw new Error(`cannot canonicalize ${typeof value}`);
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function positiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/.test(String(value ?? ''))) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function nonNegativeInteger(value, label) {
  if (!/^[0-9]+$/.test(String(value ?? ''))) throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}

function commaList(value, label) {
  if (value === undefined || value === null) return [];
  const items = [...new Set(String(value).split(',').map((item) => item.trim()).filter(Boolean))];
  if (items.length === 0) throw new Error(`${label} must contain at least one value`);
  return items;
}

function validateRepositories(repositories) {
  for (const repository of repositories) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error(`repository must be owner/repo, received ${repository}`);
    }
  }
  return repositories;
}

function defaultExclusionFiles() {
  const root = path.join(os.homedir(), 'northset-bd', 'docs', 'internal', 'business_development',
    'active_outreach', '2026-07-02_30D_GTM_operation_v2');
  return [
    path.join(root, 'phase0_ignition', '13_live_oss_target_candidate_register_2026-07-11.md'),
    path.join(root, 'review_artifacts', 'oss_missions', 'research_working', 'batch2',
      '2026-07-12_batch2_final_validated_candidate_register.md'),
  ];
}

function outputPaths(explicitOutput, explicitAudit) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const report = explicitOutput
    ? path.resolve(explicitOutput)
    : path.join(SCRIPT_DIR, 'runs', `candidate-batch-${stamp}.json`);
  const audit = explicitAudit
    ? path.resolve(explicitAudit)
    : report.replace(/\.json$/i, '.audit.jsonl');
  return {report, audit};
}

export function parseArgs(argv, env = process.env) {
  if (argv.includes('-h') || argv.includes('--help')) return {help: true};

  let requested = null;
  const options = new Map();
  const repeated = new Map();
  const boolean = new Set();
  const booleanFlags = new Set(['--dry-run', '--include-only']);
  const repeatableFlags = new Set(['--exclude-file', '--include-file']);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      if (requested !== null) throw new Error(`unexpected positional argument ${token}`);
      requested = positiveInteger(token, 'candidate count');
      continue;
    }
    if (booleanFlags.has(token)) {
      boolean.add(token);
      continue;
    }
    const value = argv[++index];
    if (value === undefined) throw new Error(`${token} requires a value`);
    if (repeatableFlags.has(token)) {
      const values = repeated.get(token) ?? [];
      values.push(value);
      repeated.set(token, values);
    } else {
      if (options.has(token)) throw new Error(`${token} may be specified only once`);
      options.set(token, value);
    }
  }

  if (options.has('--count')) {
    if (requested !== null) throw new Error('candidate count was supplied twice');
    requested = positiveInteger(options.get('--count'), '--count');
  }
  if (requested === null) throw new Error('usage: node find-candidates.mjs N [options]');

  const profile = options.get('--profile') ?? env.OSS_FIND_PROFILE ?? 'node';
  if (!SUPPORTED_PROFILES.includes(profile)) {
    throw new Error(`--profile must be one of ${SUPPORTED_PROFILES.join(', ')}`);
  }

  const labels = commaList(options.get('--labels') ?? env.OSS_FIND_LABELS ?? DEFAULT_LABELS.join(','), '--labels');
  const terms = commaList(options.get('--terms') ?? env.OSS_FIND_TERMS, '--terms');
  const repositories = validateRepositories(commaList(options.get('--repos') ?? env.OSS_FIND_REPOS, '--repos'));
  const explicitExclusions = [
    ...(repeated.get('--exclude-file') ?? []),
    ...String(env.OSS_FIND_EXCLUDE_FILES ?? '').split(path.delimiter).filter(Boolean),
  ].map((file) => path.resolve(file));
  const explicitInclusions = [
    ...(repeated.get('--include-file') ?? []),
    ...String(env.OSS_FIND_INCLUDE_FILES ?? '').split(path.delimiter).filter(Boolean),
  ].map((file) => path.resolve(file));
  const includeOnly = boolean.has('--include-only');
  if (includeOnly && explicitInclusions.length === 0) {
    throw new Error('--include-only requires at least one --include-file');
  }

  const budgetSeconds = positiveInteger(options.get('--budget-seconds') ?? env.OSS_FIND_BUDGET_SECONDS ?? '1200', '--budget-seconds');
  const reviewTimeoutSeconds = positiveInteger(options.get('--review-timeout-seconds') ?? env.OSS_FIND_REVIEW_TIMEOUT_SECONDS ?? '300', '--review-timeout-seconds');
  if (reviewTimeoutSeconds > budgetSeconds) throw new Error('--review-timeout-seconds cannot exceed --budget-seconds');

  const concurrency = positiveInteger(options.get('--concurrency') ?? env.OSS_FIND_CONCURRENCY ?? '4', '--concurrency');
  if (concurrency > 12) throw new Error('--concurrency must be at most 12');

  const searchLimit = positiveInteger(options.get('--search-limit') ?? env.OSS_FIND_SEARCH_LIMIT
    ?? String(Math.min(100, Math.max(40, requested * 4))), '--search-limit');
  if (searchLimit > 100) throw new Error('--search-limit must be at most 100 so each search stratum is one auditable API request');

  const maxReviews = positiveInteger(options.get('--max-reviews') ?? env.OSS_FIND_MAX_REVIEWS
    ?? String(Math.min(40, Math.max(12, requested * 4))), '--max-reviews');
  const preflightLimit = positiveInteger(options.get('--preflight-limit') ?? env.OSS_FIND_PREFLIGHT_LIMIT
    ?? String(Math.min(200, Math.max(60, requested * 8))), '--preflight-limit');
  if (preflightLimit < maxReviews) throw new Error('--preflight-limit must be at least --max-reviews');

  const starsMin = nonNegativeInteger(options.get('--stars-min') ?? env.OSS_FIND_STARS_MIN ?? '10', '--stars-min');
  const maxComments = positiveInteger(options.get('--max-comments') ?? env.OSS_FIND_MAX_COMMENTS ?? '30', '--max-comments');
  const maxPushAgeDays = positiveInteger(options.get('--max-push-age-days') ?? env.OSS_FIND_MAX_PUSH_AGE_DAYS ?? '180', '--max-push-age-days');
  const minScore = nonNegativeInteger(options.get('--min-score') ?? env.OSS_FIND_MIN_SCORE ?? '60', '--min-score');
  const maxPerOwner = positiveInteger(options.get('--max-per-owner') ?? env.OSS_FIND_MAX_PER_OWNER ?? '2', '--max-per-owner');
  const qualificationTtlMinutes = positiveInteger(options.get('--qualification-ttl-minutes')
    ?? env.OSS_FIND_QUALIFICATION_TTL_MINUTES ?? '120', '--qualification-ttl-minutes');
  const createdWindowDays = options.has('--created-window-days')
    ? positiveInteger(options.get('--created-window-days'), '--created-window-days') : null;
  const updatedWindowDays = options.has('--updated-window-days')
    ? positiveInteger(options.get('--updated-window-days'), '--updated-window-days') : null;
  const searchShards = positiveInteger(options.get('--search-shards') ?? '1', '--search-shards');
  if (searchShards > 12) throw new Error('--search-shards must be at most 12');
  const labelPages = positiveInteger(options.get('--label-pages') ?? '3', '--label-pages');
  if (labelPages > 10) throw new Error('--label-pages must be at most 10');
  const discoveryFile = options.has('--discovery-file')
    ? path.resolve(options.get('--discovery-file'))
    : env.OSS_FIND_DISCOVERY_FILE ? path.resolve(env.OSS_FIND_DISCOVERY_FILE) : null;
  const gatewayWaveId = env.OSS_GATEWAY_WAVE_ID ?? null;
  const gatewayWaveBudget = env.OSS_GATEWAY_WAVE_BUDGET === undefined || env.OSS_GATEWAY_WAVE_BUDGET === ''
    ? null
    : nonNegativeInteger(env.OSS_GATEWAY_WAVE_BUDGET, 'OSS_GATEWAY_WAVE_BUDGET');

  const historyFile = path.resolve(options.get('--history') ?? env.OSS_FIND_HISTORY ?? DEFAULT_HISTORY);
  const reviewScript = path.resolve(options.get('--review-script') ?? env.OSS_FIND_REVIEW_SCRIPT ?? DEFAULT_REVIEWER);
  const repoPolicyFile = path.resolve(options.get('--repo-policy') ?? env.OSS_FIND_REPO_POLICY ?? DEFAULT_REPO_POLICY);
  const outputs = outputPaths(options.get('--output') ?? env.OSS_FIND_OUTPUT, options.get('--audit') ?? env.OSS_FIND_AUDIT);

  const known = new Set([
    '--count', '--profile', '--labels', '--terms', '--repos', '--budget-seconds',
    '--review-timeout-seconds', '--concurrency', '--search-limit', '--max-reviews',
    '--preflight-limit', '--stars-min', '--max-comments', '--max-push-age-days',
    '--min-score', '--max-per-owner', '--qualification-ttl-minutes', '--history',
    '--review-script', '--repo-policy', '--output', '--audit', '--created-window-days',
    '--updated-window-days', '--search-shards', '--label-pages', '--discovery-file',
  ]);
  for (const key of options.keys()) if (!known.has(key)) throw new Error(`unknown argument ${key}`);

  return {
    requested,
    profile,
    labels,
    terms,
    repositories,
    exclusionFiles: explicitExclusions.length ? explicitExclusions : defaultExclusionFiles(),
    inclusionFiles: explicitInclusions,
    includeOnly,
    totalBudgetMs: budgetSeconds * 1000,
    reviewTimeoutMs: reviewTimeoutSeconds * 1000,
    ghTimeoutMs: Math.min(120_000, budgetSeconds * 1000),
    concurrency,
    searchLimit,
    maxReviews,
    preflightLimit,
    starsMin,
    maxComments,
    maxPushAgeDays,
    minScore,
    maxPerOwner,
    qualificationTtlMs: qualificationTtlMinutes * 60_000,
    createdWindowDays,
    updatedWindowDays,
    searchShards,
    labelPages,
    discoveryFile,
    gatewayWaveId,
    gatewayWaveBudget,
    historyFile,
    reviewScript,
    repoPolicyFile,
    outputFile: outputs.report,
    auditFile: outputs.audit,
    dryRun: boolean.has('--dry-run'),
  };
}

export function usage() {
  return `Northset OSS candidate finder v${FINDER_VERSION}

Usage:
  node find-candidates.mjs N [options]
  node find-candidates.mjs import --out candidate_lake.sqlite batch3.json [...]
  node find-candidates.mjs crawl --profile node,python,go,rust --out candidate_lake.sqlite
  node find-candidates.mjs rank --lake candidate_lake.sqlite --count 500 --profile node --out queue.json
  node find-candidates.mjs qualify --lake candidate_lake.sqlite --queue queue.json --count 100

Core options:
  --profile node                    Explicit executor profile: node, python, go, or rust
  --budget-seconds 1200             One non-resetting wall-clock budget
  --review-timeout-seconds 300      Per-candidate semantic-review cap
  --concurrency 4                   Concurrent semantic reviews
  --max-reviews N                   Maximum semantic reviews (default: min(40, max(12, 4*N)))
  --preflight-limit N               Maximum candidates hydrated mechanically
  --search-limit N                  Results per auditable REST search stratum (max: 100)
  --stars-min N                     Minimum repository stars (default: 10)
  --max-comments N                  Comment-count risk threshold; never a sole rejection
  --min-score N                     Minimum deterministic preflight score (default: 60)
  --max-per-owner N                 Maximum selected candidates per GitHub owner (default: 2)

Search controls:
  --discovery-file path             Use an archive discovery file; skip all live search calls
  --labels a,b                      Invitation labels (default: good first issue,help wanted)
  --terms a,b                       Optional high-signal phrases; labels remain mandatory
  --repos owner/repo,...            Optional targeted repository set
  --created-window-days N           Shard searches by bounded created-date windows
  --updated-window-days N           Shard searches by bounded updated-date windows
  --search-shards N                 Number of non-overlapping time shards (max: 12)
  --exclude-file path               Repeatable prior-register exclusion file
  --include-file path               Repeatable exact issue-key priority file
  --include-only                    Review only exact keys from inclusion files

Artifacts:
  --history path                    Append-only semantic-review history
  --output path                     Batch JSON output
  --audit path                      Full decision audit JSONL
  --review-script path              One-review-per-candidate validator
  --repo-policy path                Repository cooldown policy
  --dry-run                         Stop after live preflight and ranking
`;
}

export class Deadline {
  constructor(totalMs, {clock = Date.now} = {}) {
    this.clock = clock;
    this.startedAtMs = clock();
    this.endsAtMs = this.startedAtMs + totalMs;
  }

  remainingMs() {
    return Math.max(0, this.endsAtMs - this.clock());
  }

  expired() {
    return this.remainingMs() <= 0;
  }

  timeoutFor(limitMs) {
    return Math.max(1, Math.min(limitMs, this.remainingMs()));
  }
}

function signalProcessTree(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

export function runBounded(command, args, {
  cwd,
  env = process.env,
  input,
  deadline,
  timeoutMs = 120_000,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  signal: abortSignal = null,
} = {}) {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve({code: 130, stdout: '', stderr: 'operation aborted before subprocess start', timedOut: false,
        outputLimitExceeded: false, aborted: true, signal: null});
      return;
    }
    if (deadline?.expired()) {
      resolve({code: 124, stdout: '', stderr: 'global deadline expired', timedOut: true,
        outputLimitExceeded: false, aborted: false, signal: null});
      return;
    }

    const allowedMs = deadline ? deadline.timeoutFor(timeoutMs) : timeoutMs;
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let aborted = false;
    let spawnError = null;
    let terminating = false;
    let escalationTimer = null;

    const terminate = (reason) => {
      if (terminating) return;
      terminating = true;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'output') outputLimitExceeded = true;
      if (reason === 'abort') aborted = true;
      signalProcessTree(child, 'SIGTERM');
      escalationTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), 2_000);
      escalationTimer.unref?.();
    };

    const timer = setTimeout(() => terminate('timeout'), allowedMs);
    timer.unref?.();
    const abort = () => terminate('abort');
    abortSignal?.addEventListener('abort', abort, {once: true});

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxOutputBytes) stdout += chunk;
      else terminate('output');
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxOutputBytes) stderr += chunk;
      else terminate('output');
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', abort);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (spawnError) stderr = `${stderr}${stderr ? '\n' : ''}${spawnError.message}`;
      const normalizedCode = timedOut ? 124 : outputLimitExceeded ? 125 : aborted ? 130 : (code ?? 127);
      resolve({
        code: normalizedCode,
        stdout,
        stderr,
        timedOut,
        outputLimitExceeded,
        aborted,
        signal,
      });
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function transientFailure(result) {
  if (result.timedOut) return true;
  const text = `${result.stderr}\n${result.stdout}`;
  return /(?:HTTP 5\d\d|502|503|504|ECONNRESET|ETIMEDOUT|connection reset|temporary failure|service unavailable)/i.test(text);
}

async function pause(ms, deadline) {
  if (deadline?.expired()) return;
  await new Promise((resolve) => setTimeout(resolve, Math.min(ms, deadline?.remainingMs() ?? ms)));
}

async function commandJson(label, command, args, {
  deadline,
  timeoutMs,
  retries = 1,
  maxOutputBytes = 8_000_000,
  env,
  requestClass,
  waveId,
  waveBudget,
} = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    last = command === 'gh'
      ? await ghRequest(args, {
        label,
        requestClass,
        env,
        timeoutMs: deadline ? deadline.timeoutFor(timeoutMs) : timeoutMs,
        maxBuffer: maxOutputBytes,
        waveId,
        waveBudget,
      })
      : await runBounded(command, args, {deadline, timeoutMs, maxOutputBytes, env});
    if (last.code === 0) {
      try {
        return JSON.parse(last.stdout);
      } catch (error) {
        throw new Error(`${label} returned invalid JSON: ${error.message}`);
      }
    }
    if (attempt < retries && transientFailure(last) && !deadline?.expired()) {
      await pause(500, deadline);
      continue;
    }
    const detail = (last.stderr || last.stdout || `exit ${last.code}`).trim().slice(-3000);
    throw new Error(`${label} failed${last.timedOut ? ' (timeout)' : ''}${last.outputLimitExceeded ? ' (output limit)' : ''}: ${detail}`);
  }
  throw new Error(`${label} failed`);
}

export function candidateKey(issue) {
  const repository = issue?.repository?.nameWithOwner;
  if (!repository || !Number.isInteger(issue?.number)) throw new Error('GitHub search returned an invalid issue');
  return `${repository}#${issue.number}`;
}

export function parseCandidateKey(value) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(value ?? '');
  if (!match) throw new Error(`invalid candidate key ${JSON.stringify(value)}`);
  return {owner: match[1], repo: match[2], number: Number(match[3]), key: value};
}

export function extractIssueKeys(text) {
  const keys = new Set();
  for (const match of String(text).matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)\b/g)) {
    keys.add(`${match[1]}#${match[2]}`);
  }
  for (const match of String(text).matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)\b/g)) {
    keys.add(`${match[1]}#${match[2]}`);
  }
  return keys;
}

function labelsOf(issue) {
  return (issue.labels ?? []).map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean);
}

const HARD_BLOCKED_LABEL = /(?:^|\b)(security|vulnerability|cve|bug bounty|bounty|dependencies?|translation|localization|documentation|docs|hacktoberfest|needs design|proposal|rfc|breaking change)(?:\b|$)/i;
const HARD_BLOCKED_TITLE = /\b(translate|translation|documentation|docs?|readme|typo|bount(?:y|ies)|security|vulnerabilit(?:y|ies)|cve[- ]?\d*|dependency update|upgrade dependenc|release checklist|migration|benchmark|performance|concurrency|distributed|rfc|proposal|redesign)\b/i;
const LOW_VALUE_TITLE = /\b(campaign|call for contributors|onboard|review an open pr|write (?:a|the) (?:blog|review)|compare .+ project|stars? drive|launch checklist|create (?:a )?(?:logo|image|pixel art)|add yourself)\b/i;
const LOW_YIELD_SCOPE_TITLE = /(?:\b(?:improve|increase|expand|extend|boost)\b.{0,32}\b(?:test )?coverage\b|\bfeature request\b|\b(?:add|create|introduce|implement|expose)\b.{0,48}\b(?:new )?(?:feature|api|cli|command[- ]line|endpoint|flag|option)\b|\b(?:add|expand|improve|create|implement)\b.{0,48}\b(?:hardware|kubernetes|k8s|end[- ]to[- ]end|e2e)\b|\b(?:hardware|kubernetes|k8s|end[- ]to[- ]end|e2e)\b.{0,32}\b(?:integration|test(?:ing)?|suite|coverage|support)\b|\b(?:umbrella|tracking|meta) issue\b|\bepic\b)/i;

export function lowValueReason(issue) {
  if (issue.isLocked) return 'locked';
  const repository = String(issue?.repository?.nameWithOwner ?? '').toLowerCase();
  if (/bount(?:y|ies)/.test(repository)) return 'bounty repository';
  const labels = labelsOf(issue).map(normalizeLabel);
  if (labels.some((label) => HARD_BLOCKED_LABEL.test(label))) return 'excluded label';
  const title = String(issue.title ?? '');
  if (HARD_BLOCKED_TITLE.test(title)) return 'excluded task type';
  if (LOW_VALUE_TITLE.test(title) || LOW_YIELD_SCOPE_TITLE.test(title)) return 'low-value task type';
  return null;
}

function quoteSearchPhrase(value) {
  const clean = String(value).replace(/[\r\n"]/g, ' ').trim();
  if (!clean) throw new Error('empty search term');
  return `"${clean}"`;
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export function buildTimeWindows({field, windowDays, shards = 1, now = new Date()} = {}) {
  if (!['created', 'updated'].includes(field)) throw new Error('time-window field must be created or updated');
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new Error('windowDays must be positive');
  if (!Number.isInteger(shards) || shards < 1 || shards > 12) throw new Error('shards must be 1..12');
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const remaining = {days: windowDays};
  const result = [];
  let cursor = end;
  for (let index = 0; index < shards && remaining.days > 0; index += 1) {
    const slots = shards - index;
    const days = Math.ceil(remaining.days / slots);
    const start = new Date(cursor.getTime() - (days - 1) * 86_400_000);
    const date = (value) => value.toISOString().slice(0, 10);
    result.push({field, from: date(start), to: date(cursor), qualifier: `${field}:${date(start)}..${date(cursor)}`});
    cursor = new Date(start.getTime() - 86_400_000);
    remaining.days -= days;
  }
  return result;
}

function policyEntry(policy, repository) {
  const wanted = String(repository ?? '').toLowerCase();
  return Object.entries(policy?.repositories ?? {}).find(([key]) => key.toLowerCase() === wanted)?.[1] ?? {};
}

export function repositoryCaps(policy, repository) {
  const entry = policyEntry(policy, repository);
  return {
    max_open_prs: entry.max_open_prs ?? policy?.defaults?.max_open_prs ?? 1,
    daily_pr_cap: entry.daily_pr_cap ?? policy?.defaults?.daily_pr_cap ?? 1,
  };
}

export function invitationLabelsForRepository(labels, policy, repository) {
  const entry = policyEntry(policy, repository);
  const approved = new Set([
    ...(entry.invitation_labels ?? []),
    ...Object.entries(entry.invitation_label_map ?? {}).filter(([, enabled]) => enabled === true).map(([label]) => label),
  ].map(normalizeLabel));
  return [...new Set((labels ?? []).map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean))]
    .filter((label) => isInvitationLabel(label) || approved.has(normalizeLabel(label)));
}

export async function discoverRepositoryInvitationLabels(repository, fetchPage, {
  policy = {}, maxPages = 3, perPage = 100,
} = {}) {
  const labels = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const values = await fetchPage({repository, page, perPage});
    if (!Array.isArray(values)) throw new Error(`label page ${page} for ${repository} was not an array`);
    labels.push(...values);
    if (values.length < perPage) break;
    if (page === maxPages) truncated = true;
  }
  return {labels: invitationLabelsForRepository(labels, policy, repository), pages_bounded: maxPages, truncated};
}

export function buildSearchPlan(config) {
  if (config.includeOnly || config.discoveryFile) return [];
  const plan = [];
  const add = ({label, term = null, language = null, repositories = [], sort = 'updated', order = 'desc', window = null}) => {
    const queryParts = [];
    if (term) queryParts.push(quoteSearchPhrase(term));
    const id = `q${String(plan.length + 1).padStart(2, '0')}`;
    plan.push({id, label, term, language, repositories, sort, order, window, query: queryParts.join(' ')});
  };

  if (config.repositories.length) {
    for (const repositoryGroup of chunks(config.repositories, 10)) {
      for (const label of config.labels) add({label, repositories: repositoryGroup});
    }
  } else if (config.terms.length) {
    for (const term of config.terms) {
      for (const label of config.labels) add({label, term});
    }
  } else {
    const languages = PROFILE_LANGUAGES[config.profile] ?? [];
    for (const label of config.labels) {
      add({label});
      for (const language of languages) add({label, language});
      // A time-window qualifier already supplies the broad created/updated coverage. Keeping
      // the unwindowed sort duplicate would turn the documented 3-shard Node plan into 30
      // queries and breach the deliberately fail-closed 20-query ceiling.
      if (config.requested >= 10 && !config.createdWindowDays && !config.updatedWindowDays) {
        for (const language of languages) add({label, language, sort: 'created'});
      }
    }
  }

  const windowPlans = [];
  if (config.createdWindowDays) windowPlans.push(...buildTimeWindows({field: 'created', windowDays: config.createdWindowDays, shards: config.searchShards ?? 1, now: config.searchNow ?? new Date()}));
  if (config.updatedWindowDays) windowPlans.push(...buildTimeWindows({field: 'updated', windowDays: config.updatedWindowDays, shards: config.searchShards ?? 1, now: config.searchNow ?? new Date()}));
  if (windowPlans.length) {
    const bases = [...plan];
    plan.length = 0;
    for (const base of bases) {
      for (const window of windowPlans) plan.push({...base, id: `q${String(plan.length + 1).padStart(2, '0')}`, window});
    }
  }
  if (plan.length > MAX_SEARCH_QUERIES) {
    throw new Error(`search plan has ${plan.length} queries; maximum is ${MAX_SEARCH_QUERIES}`);
  }
  return plan;
}

function searchQualifierValue(value) {
  const clean = String(value).replace(/[\r\n"]/g, ' ').trim();
  return `"${clean}"`;
}

export function restSearchQuery(query, config) {
  const parts = [
    'is:issue',
    'is:open',
    'no:assignee',
    'archived:false',
    'is:public',
    `label:${searchQualifierValue(query.label)}`,
  ];
  if (query.term) parts.push(quoteSearchPhrase(query.term));
  if (query.language) parts.push(`language:${searchQualifierValue(query.language)}`);
  if (query.repositories.length) {
    for (const repository of query.repositories) parts.push(`repo:${repository}`);
  }
  if (query.window?.qualifier) parts.push(query.window.qualifier);
  return parts.join(' ');
}

function searchArgs(query, config) {
  return [
    'api', '--method', 'GET',
    '-H', 'Accept: application/vnd.github+json',
    '-H', `X-GitHub-Api-Version: ${GITHUB_REST_API_VERSION}`,
    'search/issues',
    '-f', `q=${restSearchQuery(query, config)}`,
    '-f', `sort=${query.sort}`,
    '-f', `order=${query.order}`,
    '-f', `per_page=${config.searchLimit}`,
    '--jq', '{total_count,incomplete_results,items:[.items[]|{number,title,body:((.body // "")[0:4000]),html_url,repository_url,labels,assignees,updated_at,created_at,locked,comments,author_association}]}',
  ];
}

function repositoryFromApiUrl(value) {
  try {
    const url = new URL(value);
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    const reposIndex = parts.lastIndexOf('repos');
    if (reposIndex >= 0 && parts.length >= reposIndex + 3) return `${parts[reposIndex + 1]}/${parts[reposIndex + 2]}`;
  } catch {}
  return null;
}

export function normalizeRestSearchIssue(item) {
  const repository = repositoryFromApiUrl(item?.repository_url)
    ?? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/[1-9][0-9]*$/.exec(item?.html_url ?? '')?.[1];
  if (!repository) throw new Error('GitHub search item has no repository identity');
  return {
    number: item.number,
    title: item.title,
    body: item.body ?? '',
    url: item.html_url,
    repository: {nameWithOwner: repository},
    labels: item.labels ?? [],
    assignees: item.assignees ?? [],
    updatedAt: item.updated_at,
    createdAt: item.created_at,
    isLocked: item.locked,
    commentsCount: item.comments,
    authorAssociation: item.author_association,
  };
}

class AuditLog {
  constructor(runId) {
    this.runId = runId;
    this.sequence = 0;
    this.records = [];
  }

  add(event, data = {}) {
    const record = {schema_version: FINDER_SCHEMA_VERSION, run_id: this.runId, sequence: ++this.sequence, at: nowIso(), event, ...data};
    this.records.push(record);
    return record;
  }
}

async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

export async function loadSeen(historyFile, exclusionFiles) {
  const seen = new Set();
  const history = await readIfExists(historyFile);
  for (const line of history.split('\n').filter(Boolean)) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid JSON line in history file ${historyFile}: ${error.message}`);
    }
    const conclusiveReview = record.event === 'review_finished'
      && ['ACCEPTED', 'REJECTED_SEMANTIC'].includes(record.terminal_state);
    const disposedCandidate = record.event === 'batch_disposition';
    const legacyCandidate = record.event == null;
    if (typeof record.candidate === 'string' && (conclusiveReview || disposedCandidate || legacyCandidate)) {
      seen.add(record.candidate.toLowerCase());
    }
  }
  for (const file of exclusionFiles) {
    const contents = await readIfExists(file);
    for (const key of extractIssueKeys(contents)) seen.add(key.toLowerCase());
  }
  return seen;
}

async function loadIncluded(files) {
  const included = new Set();
  for (const file of files) {
    const contents = await readIfExists(file);
    for (const key of extractIssueKeys(contents)) included.add(key.toLowerCase());
  }
  return included;
}

export function mergeIncludedCandidates(candidates, included) {
  const merged = new Map(candidates.map((candidate) => [candidate.key.toLowerCase(), candidate]));
  for (const key of included) {
    const normalized = key.toLowerCase();
    if (merged.has(normalized)) continue;
    const parsed = parseCandidateKey(normalized);
    const repository = `${parsed.owner}/${parsed.repo}`;
    merged.set(normalized, {
      key: normalized,
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
      url: `https://github.com/${repository}/issues/${parsed.number}`,
      title: '',
      body: '',
      labels: [],
      assignees: [],
      updated_at: null,
      created_at: null,
      is_locked: false,
      comments_count: 0,
      author_association: null,
      repository,
      discovery_queries: ['include-file'],
      discovery_score: Number.MAX_SAFE_INTEGER,
      raw_search: {
        number: parsed.number,
        title: '',
        body: '',
        repository: {nameWithOwner: repository},
        labels: [],
        assignees: [],
        isLocked: false,
      },
    });
  }
  return [...merged.values()];
}

/**
 * Load the archive miner's discovery artifact (or the older root-array form)
 * into the same normalized records produced by live REST search.
 */
export async function loadDiscoveryFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`invalid discovery file ${file}: ${error.message}`);
  }
  const values = Array.isArray(parsed) ? parsed : parsed?.unscreened_candidates ?? parsed?.candidates;
  if (!Array.isArray(values)) {
    throw new Error(`discovery file ${file} must be an array or contain unscreened_candidates[]`);
  }

  const latest = new Map();
  for (const [index, value] of values.entries()) {
    if (!value || typeof value !== 'object') throw new Error(`discovery file ${file} candidate ${index + 1} must be an object`);
    const candidate = value.candidate ?? value.key;
    let identity;
    try { identity = parseCandidateKey(candidate); }
    catch (error) { throw new Error(`discovery file ${file} candidate ${index + 1}: ${error.message}`); }
    const observed = value.event_at ?? value.updated_at ?? value.updated ?? value.created_at ?? value.created ?? null;
    const previous = latest.get(identity.key.toLowerCase());
    if (previous && Date.parse(previous.observed ?? '') > Date.parse(observed ?? '')) continue;
    latest.set(identity.key.toLowerCase(), {value, identity, observed});
  }

  const discovered = new Map();
  for (const {value, identity} of latest.values()) {
    const repository = `${identity.owner}/${identity.repo}`;
    const labels = (value.labels ?? []).map((label) => typeof label === 'string' ? {name: label} : label);
    const issue = {
      number: identity.number,
      title: String(value.title ?? ''),
      body: String(value.body_excerpt ?? value.body ?? ''),
      url: value.url ?? `https://github.com/${repository}/issues/${identity.number}`,
      repository: {nameWithOwner: repository},
      labels,
      assignees: value.assignees ?? [],
      updatedAt: value.updated_at ?? value.updated ?? value.event_at ?? null,
      createdAt: value.created_at ?? value.created ?? null,
      isLocked: Boolean(value.locked ?? value.is_locked),
      commentsCount: Number(value.comments_count ?? value.comments ?? 0),
      authorAssociation: value.author_association ?? null,
    };
    mergeSearchResult(discovered, issue, 'discovery-file');
  }
  return [...discovered.values()];
}

async function loadRepoPolicy(file) {
  const contents = await readIfExists(file);
  if (!contents) return {cooldowns: {}};
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`invalid repository policy ${file}: ${error.message}`);
  }
  return parsed;
}

function roughDiscoveryScore(issue) {
  let score = 0;
  const title = String(issue.title ?? '').toLowerCase();
  const body = String(issue.body ?? '').toLowerCase();
  const labels = labelsOf(issue).map(normalizeLabel);
  if (labels.some((label) => label.includes('good first issue'))) score += 8;
  if (labels.some((label) => label.endsWith('help wanted') || label === 'help wanted')) score += 6;
  if (/\b(bug|fix|incorrect|wrong|fails?|failure|regression|crash|error|deterministic|idempotent|parser|test)\b/.test(title)) score += 10;
  if (/\b(repro|expected|actual|test|steps to reproduce)\b/.test(body)) score += 5;
  const comments = Number(issue.commentsCount ?? 0);
  if (comments <= 3) score += 6;
  else if (comments > 20) score -= 8;
  const updated = Date.parse(issue.updatedAt ?? '');
  if (Number.isFinite(updated)) {
    const ageDays = (Date.now() - updated) / 86_400_000;
    if (ageDays <= 14) score += 6;
    else if (ageDays > 365) score -= 4;
  }
  return score;
}

function mergeSearchResult(map, issue, queryId) {
  const key = candidateKey(issue);
  const existing = map.get(key.toLowerCase());
  if (existing) {
    existing.discovery_queries.push(queryId);
    return;
  }
  const parsed = parseCandidateKey(key);
  map.set(key.toLowerCase(), {
    key,
    owner: parsed.owner,
    repo: parsed.repo,
    number: parsed.number,
    url: issue.url,
    title: issue.title,
    body: issue.body ?? '',
    labels: labelsOf(issue),
    assignees: (issue.assignees ?? []).map((item) => item.login ?? item).filter(Boolean),
    updated_at: issue.updatedAt,
    created_at: issue.createdAt,
    is_locked: Boolean(issue.isLocked),
    comments_count: Number(issue.commentsCount ?? 0),
    author_association: issue.authorAssociation ?? null,
    repository: issue.repository.nameWithOwner,
    discovery_queries: [queryId],
    discovery_score: roughDiscoveryScore(issue),
    raw_search: issue,
  });
}

async function checkRateLimits(config, plan, deadline, audit) {
  const rate = await commandJson('GitHub rate-limit check', 'gh', ['api', 'rate_limit'], {
    deadline,
    timeoutMs: config.ghTimeoutMs,
    requestClass: 'rest_read',
    waveId: config.gatewayWaveId,
    waveBudget: config.gatewayWaveBudget,
  });
  const search = rate?.resources?.search;
  const graphql = rate?.resources?.graphql;
  audit.add('rate_limit_checked', {
    search_remaining: search?.remaining ?? null,
    search_reset: search?.reset ? new Date(search.reset * 1000).toISOString() : null,
    graphql_remaining: graphql?.remaining ?? null,
    graphql_reset: graphql?.reset ? new Date(graphql.reset * 1000).toISOString() : null,
  });
  if (Number.isInteger(search?.remaining) && search.remaining < plan.length + 2) {
    throw new Error(`GitHub search rate limit has ${search.remaining} requests remaining; ${plan.length + 2} required`);
  }
  if (Number.isInteger(graphql?.remaining) && graphql.remaining < 20) {
    throw new Error(`GitHub GraphQL rate limit is too low (${graphql.remaining} remaining)`);
  }
}

async function discover(config, plan, deadline, audit) {
  const discovered = new Map();
  for (const query of plan) {
    if (deadline.expired()) throw new Error('global deadline expired during GitHub search');
    let response = await commandJson(`GitHub issue search ${query.id}`, 'gh', searchArgs(query, config), {
      deadline,
      timeoutMs: config.ghTimeoutMs,
      requestClass: 'search',
      waveId: config.gatewayWaveId,
      waveBudget: config.gatewayWaveBudget,
    });
    if (response?.incomplete_results === true && !deadline.expired()) {
      await pause(500, deadline);
      response = await commandJson(`GitHub issue search retry ${query.id}`, 'gh', searchArgs(query, config), {
        deadline,
        timeoutMs: config.ghTimeoutMs,
        retries: 0,
        requestClass: 'search',
        waveId: config.gatewayWaveId,
        waveBudget: config.gatewayWaveBudget,
      });
    }
    if (!response || !Array.isArray(response.items)) throw new Error(`GitHub issue search ${query.id} returned an invalid response`);
    if (response.incomplete_results === true) {
      throw new Error(`GitHub issue search ${query.id} remained incomplete after one retry`);
    }
    const issues = response.items.map(normalizeRestSearchIssue);
    for (const issue of issues) mergeSearchResult(discovered, issue, query.id);
    audit.add('search_completed', {
      query: {...query, rest_query: restSearchQuery(query, config)},
      total_count: response.total_count ?? null,
      returned: issues.length,
      intentionally_truncated: Number(response.total_count ?? 0) > issues.length,
      unique_so_far: discovered.size,
      incomplete_results: false,
    });
  }
  return [...discovered.values()];
}

async function northsetPrSearch(config, deadline, query, label) {
  let response = await commandJson(label, 'gh', [
    'api', '--method', 'GET',
    '-H', 'Accept: application/vnd.github+json',
    '-H', `X-GitHub-Api-Version: ${GITHUB_REST_API_VERSION}`,
    'search/issues', '-f', `q=${query}`, '-f', 'sort=updated', '-f', 'order=desc', '-f', 'per_page=100',
    '--jq', '{total_count,incomplete_results,items:[.items[]|{repository_url,created_at}]}',
  ], {deadline, timeoutMs: config.ghTimeoutMs, requestClass: 'search',
    waveId: config.gatewayWaveId, waveBudget: config.gatewayWaveBudget});
  if (response?.incomplete_results === true && !deadline.expired()) {
    await pause(500, deadline);
    response = await commandJson(`${label} retry`, 'gh', [
      'api', '--method', 'GET',
      '-H', 'Accept: application/vnd.github+json',
      '-H', `X-GitHub-Api-Version: ${GITHUB_REST_API_VERSION}`,
      'search/issues', '-f', `q=${query}`, '-f', 'sort=updated', '-f', 'order=desc', '-f', 'per_page=100',
      '--jq', '{total_count,incomplete_results,items:[.items[]|{repository_url,created_at}]}',
    ], {deadline, timeoutMs: config.ghTimeoutMs, retries: 0, requestClass: 'search',
      waveId: config.gatewayWaveId, waveBudget: config.gatewayWaveBudget});
  }
  if (!response || !Array.isArray(response.items) || response.incomplete_results === true) {
    throw new Error(`${label} was incomplete or invalid`);
  }
  if (Number(response.total_count ?? 0) > 100) {
    throw new Error(`${label} exceeded 100 results; repository-cap evidence is intentionally bounded and cannot be trusted`);
  }
  return response;
}

function repositoryCounts(items) {
  const counts = new Map();
  for (const item of items) {
    const repository = repositoryFromApiUrl(item.repository_url)?.toLowerCase();
    if (repository) counts.set(repository, (counts.get(repository) ?? 0) + 1);
  }
  return counts;
}

async function openNorthsetPolicyCounts(config, deadline, audit) {
  const query = 'is:pr is:open author:AysajanE';
  const today = new Date().toISOString().slice(0, 10);
  const response = await northsetPrSearch(config, deadline, query, 'Northset open-PR repository check');
  const dailyResponse = await northsetPrSearch(
    config,
    deadline,
    `is:pr author:AysajanE created:>=${today}`,
    'Northset daily-PR repository check',
  );
  const openCounts = repositoryCounts(response.items);
  const dailyCounts = repositoryCounts(dailyResponse.items);
  audit.add('northset_open_pr_repositories_checked', {
    repositories: [...openCounts.keys()].sort(),
    open_counts: Object.fromEntries([...openCounts].sort()),
    daily_counts: Object.fromEntries([...dailyCounts].sort()),
    count: openCounts.size,
    total_count: response.total_count ?? null,
    incomplete_results: false,
  });
  return {openCounts, dailyCounts};
}

export function filterDiscovered(candidates, {
  seen, cooldowns, northsetOpenRepositories = new Set(), northsetOpenCounts = new Map(),
  northsetDailyCounts = new Map(), repoPolicy = {}, preflightLimit, included = new Set(), includeOnly = false,
}) {
  const accepted = [];
  const rejected = [];
  const perRepo = new Map();
  for (const candidate of [...candidates].sort((a, b) => Number(included.has(b.key.toLowerCase())) - Number(included.has(a.key.toLowerCase()))
    || b.discovery_score - a.discovery_score
    || Date.parse(b.updated_at ?? 0) - Date.parse(a.updated_at ?? 0)
    || a.key.localeCompare(b.key))) {
    let reason = null;
    if (includeOnly && !included.has(candidate.key.toLowerCase())) reason = 'not explicitly included';
    else if (seen.has(candidate.key.toLowerCase())) reason = 'previously reviewed or excluded';
    else {
      const repository = candidate.repository.toLowerCase();
      const caps = repositoryCaps(repoPolicy, candidate.repository);
      const openCount = northsetOpenCounts.get(repository) ?? Number(northsetOpenRepositories.has(repository));
      const dailyCount = northsetDailyCounts.get(repository) ?? 0;
      if (openCount >= caps.max_open_prs) reason = `Northset open PR cap reached for repository (${caps.max_open_prs})`;
      else if (dailyCount >= caps.daily_pr_cap) reason = `Northset daily PR cap reached for repository (${caps.daily_pr_cap})`;
    }
    if (!reason && cooldowns[candidate.repository.toLowerCase()]) reason = 'repository cooldown';
    else if (!reason && candidate.assignees.length) reason = 'assigned';
    else if (!reason) reason = lowValueReason(candidate.raw_search);
    if (!reason && !included.has(candidate.key.toLowerCase())
      && (perRepo.get(candidate.repository.toLowerCase()) ?? 0) >= 3) reason = 'preflight repository concentration cap';
    if (reason) {
      rejected.push({candidate: candidate.key, terminal_state: 'REJECTED_DISCOVERY', reason});
      continue;
    }
    if (!included.has(candidate.key.toLowerCase())) {
      perRepo.set(candidate.repository.toLowerCase(), (perRepo.get(candidate.repository.toLowerCase()) ?? 0) + 1);
    }
    accepted.push(candidate);
    if (accepted.length >= preflightLimit) break;
  }
  return {accepted, rejected};
}

export function buildPreflightQuery(candidates) {
  const fields = candidates.map((candidate, index) => `
    c${index}: repository(owner: ${JSON.stringify(candidate.owner)}, name: ${JSON.stringify(candidate.repo)}) {
      id
      owner { id login }
      nameWithOwner
      isArchived
      isFork
      isPrivate
      pushedAt
      stargazerCount
      primaryLanguage { name }
      licenseInfo { spdxId }
      defaultBranchRef {
        name
        target { ... on Commit { oid } }
      }
      issue(number: ${candidate.number}) {
        id
        number
        title
        bodyText
        url
        state
        createdAt
        updatedAt
        locked
        authorAssociation
        author { login }
        assignees(first: 20) { nodes { login } }
        labels(first: 50) { nodes { name } }
        comments(last: 10) {
          totalCount
          nodes {
            body
            createdAt
            authorAssociation
            author { login }
          }
        }
        timelineItems(first: 50, itemTypes: [CROSS_REFERENCED_EVENT]) {
          pageInfo { hasNextPage }
          nodes {
            ... on CrossReferencedEvent {
              createdAt
              source {
                __typename
                ... on PullRequest {
                  number
                  title
                  url
                  state
                  isDraft
                  repository { nameWithOwner }
                }
              }
            }
          }
        }
      }
    }`).join('\n');
  return `query NorthsetCandidatePreflight {${fields}
    rateLimit { cost remaining resetAt }
  }`;
}

export function normalizePreflight(candidate, repository) {
  const issue = repository?.issue ?? null;
  return {
    candidate: candidate.key,
    repository: repository ? {
      node_id: repository.id,
      owner: repository.owner ? {node_id: repository.owner.id, login: repository.owner.login} : null,
      name_with_owner: repository.nameWithOwner,
      archived: repository.isArchived,
      fork: repository.isFork,
      private: repository.isPrivate,
      pushed_at: repository.pushedAt,
      stars: repository.stargazerCount,
      primary_language: repository.primaryLanguage?.name ?? null,
      license: repository.licenseInfo?.spdxId ?? null,
      default_branch: repository.defaultBranchRef?.name ?? null,
      default_head: repository.defaultBranchRef?.target?.oid ?? null,
    } : null,
    issue: issue ? {
      node_id: issue.id,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      state: issue.state,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      locked: issue.locked,
      author_association: issue.authorAssociation,
      author: issue.author?.login ?? null,
      assignees: (issue.assignees?.nodes ?? []).map((item) => item.login),
      labels: (issue.labels?.nodes ?? []).map((item) => item.name),
      comments_total: issue.comments?.totalCount ?? 0,
      recent_comments: (issue.comments?.nodes ?? []).map((comment) => ({
        author: comment.author?.login ?? null,
        author_association: comment.authorAssociation,
        body: String(comment.body ?? '').slice(0, 2000),
        created_at: comment.createdAt,
      })),
      timeline_has_next_page: Boolean(issue.timelineItems?.pageInfo?.hasNextPage),
      cross_referenced_prs: (issue.timelineItems?.nodes ?? []).map((event) => event?.source)
        .filter((source) => source?.__typename === 'PullRequest')
        .map((pr) => ({
          number: pr.number,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          draft: pr.isDraft,
          repository: pr.repository?.nameWithOwner ?? null,
        })),
    } : null,
    discovery: {
      title: issue?.title ?? candidate.title ?? '',
      body_excerpt: String(issue?.bodyText ?? candidate.body ?? '').slice(0, 4000),
      labels: issue ? (issue.labels?.nodes ?? []).map((item) => item.name) : (candidate.labels ?? []),
      updated_at: issue?.updatedAt ?? candidate.updated_at,
      comments_count: issue?.comments?.totalCount ?? candidate.comments_count,
      queries: candidate.discovery_queries,
    },
  };
}

const CLAIM_PATTERN = /\b(?:i(?:'m| am|'ll| will)?\s+(?:work(?:ing)?|take|claim|implement)(?:\s+on)?\s+(?:this|it)|can i work on this|please assign (?:this|it|me)|working on this|i opened (?:a )?pr|i have (?:a )?pr)\b/i;

export function activeClaimComment(preflight, nowMs = Date.now()) {
  const comments = preflight.issue?.recent_comments ?? [];
  for (const comment of comments) {
    if (!comment.author || comment.author === 'AysajanE' || /\[bot\]$/i.test(comment.author)) continue;
    const created = Date.parse(comment.created_at ?? '');
    if (!Number.isFinite(created) || nowMs - created > 45 * 86_400_000) continue;
    if (CLAIM_PATTERN.test(comment.body)) {
      return {
        author: comment.author,
        created_at: comment.created_at,
        excerpt: comment.body.replace(/\s+/g, ' ').trim().slice(0, 240),
      };
    }
  }
  return null;
}

function ageDays(value, nowMs = Date.now()) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? Math.max(0, (nowMs - parsed) / 86_400_000) : Infinity;
}

export function scorePreflight(preflight, profile, nowMs = Date.now()) {
  const factors = [];
  let total = 50;
  const add = (name, points) => {
    factors.push({name, points});
    total += points;
  };

  const labels = preflight.issue?.labels ?? [];
  if (labels.some((label) => normalizeLabel(label).includes('good first issue'))) add('good-first-issue invitation', 5);
  if (labels.some((label) => normalizeLabel(label).endsWith('help wanted') || normalizeLabel(label) === 'help wanted')) add('help-wanted invitation', 5);
  const maintainerAuthored = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(preflight.issue?.author_association);
  if (maintainerAuthored) add('maintainer-authored issue', 8);

  const language = preflight.repository?.primary_language;
  if ((PROFILE_LANGUAGES[profile] ?? []).includes(language)) add(`profile language ${language}`, 12);
  else add(`non-primary ${profile} language ${language ?? 'unknown'}`, -8);

  const stars = Number(preflight.repository?.stars ?? 0);
  if (stars >= 10_000) add('established repository', 8);
  else if (stars >= 1_000) add('mature repository', 6);
  else if (stars >= 100) add('proven repository', 4);
  else if (stars >= 10) add('minimum repository signal', 2);

  const pushed = ageDays(preflight.repository?.pushed_at, nowMs);
  if (pushed <= 7) add('repository pushed within 7 days', 8);
  else if (pushed <= 30) add('repository pushed within 30 days', 6);
  else if (pushed <= 90) add('repository pushed within 90 days', 3);

  const updated = ageDays(preflight.issue?.updated_at, nowMs);
  if (updated <= 7) add('issue active within 7 days', 8);
  else if (updated <= 30) add('issue active within 30 days', 5);
  else if (updated <= 90) add('issue active within 90 days', 2);
  else if (updated > 365) add('issue inactive over one year', -4);

  const comments = Number(preflight.issue?.comments_total ?? 0);
  if (comments <= 3) add('low discussion burden', 8);
  else if (comments <= 10) add('bounded discussion', 4);
  else if (comments > 20) add('high discussion burden', -8);

  const title = String(preflight.issue?.title ?? '').toLowerCase();
  const highSignals = ['bug', 'fix', 'incorrect', 'wrong', 'fail', 'regression', 'crash', 'error', 'deterministic', 'idempotent', 'parser', 'test'];
  const highCount = highSignals.filter((word) => title.includes(word)).length;
  if (highCount) add('bounded correctness title signal', Math.min(12, highCount * 4));

  const body = `${preflight.discovery?.body_excerpt ?? ''} ${preflight.issue?.title ?? ''}`;
  const behaviorSignalCount = [
    /\bexpected\b/i,
    /\bactual\b/i,
    /\b(?:repro(?:duction)?|steps? to reproduce)\b/i,
    /\b(?:tests?|assert(?:ion)?)\b/i,
  ].filter((pattern) => pattern.test(body)).length;
  if (behaviorSignalCount) add('observable-behavior signal', Math.min(12, behaviorSignalCount * 3));
  if (maintainerAuthored && behaviorSignalCount >= 2 &&
      /\b(?:bug|fix|incorrect|wrong|fails?|failure|regression|crash|error)\b/i.test(title)) {
    add('maintainer-authored evidenced defect', 8);
  }
  if (/\b(feature|proposal|design|refactor|api|option|flag|performance|benchmark|concurrency|distributed)\b/i.test(title)) {
    add('broader-design title risk', -15);
  }
  if (/\b(ui|visual|browser|hardware|cloud|kubernetes|database)\b/i.test(title)) add('environment or subjective-oracle risk', -8);
  if (!preflight.repository?.license || preflight.repository.license === 'NOASSERTION') add('license needs semantic confirmation', -3);

  return {total, factors};
}

export function mechanicalDecision(preflight, config, nowMs = Date.now()) {
  const reasons = [];
  const warnings = [];
  const repository = preflight.repository;
  const issue = preflight.issue;

  if (!repository) reasons.push('repository missing or inaccessible');
  if (!issue) reasons.push('issue missing');
  if (repository?.archived) reasons.push('repository archived');
  if (repository?.fork) reasons.push('repository is a fork');
  if (repository?.private) reasons.push('repository is not public');
  if (Number(repository?.stars ?? -1) < config.starsMin) reasons.push(`repository has fewer than ${config.starsMin} stars`);
  if (ageDays(repository?.pushed_at, nowMs) > config.maxPushAgeDays) reasons.push(`repository not pushed within ${config.maxPushAgeDays} days`);
  if (!repository?.default_branch || !/^[0-9a-f]{40}$/i.test(repository?.default_head ?? '')) reasons.push('default branch head is unavailable');
  if (issue?.state !== 'OPEN') reasons.push('issue is not open');
  if (issue?.locked) reasons.push('issue is locked');
  if ((issue?.assignees ?? []).length) reasons.push('issue is assigned');
  const approvedLabels = invitationLabelsForRepository(issue?.labels ?? [], config.repoPolicy ?? {}, repository?.name_with_owner);
  if (!approvedLabels.length) reasons.push('qualifying invitation label is missing');
  const commentCount = Number(issue?.comments_total ?? 0);
  if (commentCount > config.maxComments) warnings.push(`high discussion count (${commentCount})`);
  if (issue?.timeline_has_next_page) reasons.push('issue has more than 50 cross-reference events');
  const blockedReason = issue && lowValueReason({
    isLocked: issue.locked,
    title: issue.title,
    labels: (issue.labels ?? []).map((name) => ({name})),
    repository: {nameWithOwner: repository?.name_with_owner},
  });
  if (blockedReason && !reasons.includes(blockedReason)) reasons.push(blockedReason);

  const sameRepository = repository?.name_with_owner?.toLowerCase();
  const openCrossReferences = (issue?.cross_referenced_prs ?? []).filter((pr) =>
    pr.state === 'OPEN' && pr.repository?.toLowerCase() === sameRepository);
  if (openCrossReferences.length) reasons.push(`open cross-referenced PR(s): ${openCrossReferences.map((pr) => pr.url).join(', ')}`);
  const relatedImplementationPrs = (issue?.cross_referenced_prs ?? []).filter((pr) => pr.repository?.toLowerCase() === sameRepository);
  if (relatedImplementationPrs.length > 12) reasons.push(`issue has excessive related implementation PRs (${relatedImplementationPrs.length})`);

  const unresolvedDesign = (issue?.recent_comments ?? []).find((comment) =>
    /\b(?:unresolved|do not agree|disagree|needs design|design is not settled|which approach|hold off|do not implement)\b/i.test(comment.body ?? ''));
  if (unresolvedDesign) reasons.push(`unresolved design disagreement in recent comment by ${unresolvedDesign.author ?? 'unknown author'}`);

  const claim = activeClaimComment(preflight, nowMs);
  if (claim) reasons.push(`recent active-claim comment by ${claim.author} at ${claim.created_at}`);
  if (!repository?.license || repository.license === 'NOASSERTION') warnings.push('license needs semantic confirmation');

  const score = scorePreflight(preflight, config.profile, nowMs);
  if (score.total < config.minScore) reasons.push(`preflight score ${score.total} is below ${config.minScore}`);

  return {
    eligible: reasons.length === 0,
    terminal_state: reasons.length ? 'REJECTED_PREFLIGHT' : 'ELIGIBLE_FOR_REVIEW',
    reasons,
    warnings,
    active_claim: claim,
    score,
  };
}

export function deterministicSemanticReject(preflight, repositoryProfile = {}) {
  const record = preflight?.preflight ?? preflight;
  const issue = record.issue ?? {};
  const repository = record.repository ?? {};
  const text = `${issue.title ?? record.title ?? ''}\n${record.discovery?.body_excerpt ?? record.body_excerpt ?? ''}`;
  if (!invitationLabelsForRepository(issue.labels ?? record.labels ?? [], repositoryProfile.repo_policy ?? {}, repository.name_with_owner ?? record.repository_name).length &&
      !record.invitation_kind) return 'no invitation signal';
  if (/\b(proposal|rfc|redesign|performance|security|dependency update|translation|documentation|docs?)\b/i.test(text)) {
    return 'excluded semantic class';
  }
  if ((issue.recent_comments ?? []).some((comment) =>
    /\b(?:unresolved|disagree|needs design|hold off|do not implement)\b/i.test(comment.body ?? ''))) {
    return 'unresolved design disagreement';
  }
  if (activeClaimComment(record)) return 'active claimant';
  if ((issue.cross_referenced_prs ?? []).filter((pr) =>
    pr.repository?.toLowerCase() === repository.name_with_owner?.toLowerCase()).length > 12) {
    return 'excessive related implementation PRs';
  }
  if (!/\b(expected|actual|repro|fails?|wrong|incorrect|regression|test|assert)\b/i.test(text) &&
      !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(issue.author_association ?? record.author_association)) {
    return 'no observable behavior signal';
  }
  return null;
}

async function preflightCandidates(candidates, config, deadline, audit) {
  const records = [];
  for (const group of chunks(candidates, 10)) {
    if (deadline.expired()) throw new Error('global deadline expired during live preflight');
    const query = buildPreflightQuery(group);
    const response = await commandJson('GitHub candidate preflight', 'gh', ['api', 'graphql', '-f', `query=${query}`], {
      deadline,
      timeoutMs: config.ghTimeoutMs,
      maxOutputBytes: 12_000_000,
      requestClass: 'graphql',
      waveId: config.gatewayWaveId,
      waveBudget: config.gatewayWaveBudget,
    });
    if (response?.errors?.length) throw new Error(`GitHub candidate preflight returned GraphQL errors: ${JSON.stringify(response.errors).slice(0, 2000)}`);
    for (let index = 0; index < group.length; index += 1) {
      const normalized = normalizePreflight(group[index], response?.data?.[`c${index}`] ?? null);
      const decision = mechanicalDecision(normalized, config, deadline.startedAtMs);
      const commentsTailSha = sha256(Buffer.from(canonical(normalized.issue?.recent_comments ?? [])));
      const timelinePrsSha = sha256(Buffer.from(canonical(normalized.issue?.cross_referenced_prs ?? [])));
      const evidenceKey = candidateEvidenceKey({
        candidate: normalized.candidate,
        profile: config.profile,
        base_commit: normalized.repository?.default_head,
        issue_updated_at: normalized.issue?.updated_at,
        labels: normalized.issue?.labels,
        assignees: normalized.issue?.assignees,
        comments_tail_sha256: commentsTailSha,
        timeline_prs_sha256: timelinePrsSha,
        repo_policy_sha256: config.repoPolicySha ?? null,
      });
      records.push({...normalized, decision, comments_tail_sha256: commentsTailSha,
        timeline_prs_sha256: timelinePrsSha, repo_policy_sha256: config.repoPolicySha ?? null,
        repo_policy_snapshot: config.repoPolicy ?? null,
        evidence_sha256: evidenceKey});
      audit.add('preflight_decision', {
        candidate: group[index].key,
        terminal_state: decision.terminal_state,
        reasons: decision.reasons,
        warnings: decision.warnings,
        score: decision.score,
        evidence_sha256: records.at(-1).evidence_sha256,
      });
    }
    audit.add('preflight_chunk_completed', {
      candidates: group.map((candidate) => candidate.key),
      graphql_cost: response?.data?.rateLimit?.cost ?? null,
      graphql_remaining: response?.data?.rateLimit?.remaining ?? null,
      graphql_reset_at: response?.data?.rateLimit?.resetAt ?? null,
    });
  }
  return records;
}

export function buildReviewQueue(records, maxReviews) {
  const sorted = records.filter((record) => record.decision.eligible)
    .sort((a, b) => b.decision.score.total - a.decision.score.total
      || Date.parse(b.issue.updated_at) - Date.parse(a.issue.updated_at)
      || a.candidate.localeCompare(b.candidate));
  const queue = [];
  const used = new Set();
  for (let repoCap = 1; repoCap <= 3 && queue.length < maxReviews; repoCap += 1) {
    const perRepo = new Map();
    for (const record of sorted) {
      if (used.has(record.candidate.toLowerCase())) continue;
      const repository = record.repository.name_with_owner.toLowerCase();
      const count = perRepo.get(repository) ?? 0;
      if (count >= repoCap) continue;
      queue.push(record);
      used.add(record.candidate.toLowerCase());
      perRepo.set(repository, count + 1);
      if (queue.length >= maxReviews) break;
    }
  }
  return queue;
}

export function validateReview(review, candidate, resultCode, profile, {
  expectedBaseCommit, expectedIssueUrl, expectedEvidenceKey,
} = {}) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) throw new Error('reviewer returned a non-object');
  if (!['ACCEPT', 'REJECT'].includes(review.verdict)) throw new Error('reviewer returned no ACCEPT/REJECT verdict');
  if (String(review.candidate).toLowerCase() !== candidate.toLowerCase()) throw new Error('reviewer candidate does not match requested candidate');
  if (review.verdict === 'ACCEPT' && resultCode !== 0) throw new Error(`reviewer returned ACCEPT with exit ${resultCode}`);
  if (review.verdict === 'REJECT' && resultCode !== 2) throw new Error(`reviewer returned REJECT with exit ${resultCode}`);
  if (expectedEvidenceKey && review.candidate_evidence_key !== expectedEvidenceKey) {
    throw new Error(`reviewer evidence does not match queued evidence ${expectedEvidenceKey}`);
  }
  if (review.verdict === 'ACCEPT') {
    if (review.task_id !== taskIdForCandidate(candidate)) throw new Error('reviewer ACCEPT task ID does not match the candidate');
    if (!String(review.requested_model ?? '').trim()) throw new Error('reviewer ACCEPT has no requested model');
    if (!String(review.reasoning_effort ?? '').trim()) throw new Error('reviewer ACCEPT has no reasoning effort');
    if (!String(review.service_tier ?? '').trim()) throw new Error('reviewer ACCEPT has no service tier');
    if (review.tier !== 'A') throw new Error('reviewer ACCEPT is not Tier A');
    if (review.executor_profile !== profile) throw new Error(`reviewer ACCEPT does not match profile ${profile}`);
    if (!/^[0-9a-f]{40}$/i.test(review.base_commit ?? '')) throw new Error('reviewer ACCEPT has no full base commit');
    if (expectedBaseCommit && review.base_commit !== expectedBaseCommit) throw new Error(`review snapshot drifted from ${expectedBaseCommit} to ${review.base_commit}`);
    if (expectedIssueUrl && String(review.issue_url).toLowerCase() !== expectedIssueUrl.toLowerCase()) {
      throw new Error('reviewer issue URL does not match the preflight snapshot');
    }
    if (!String(review.test_command ?? '').trim()) throw new Error('reviewer ACCEPT has no exact test command');
    if (!Array.isArray(review.source_evidence) || review.source_evidence.length === 0) throw new Error('reviewer ACCEPT has no source evidence');
    if (!review.invitation_evidence || !review.acceptance_contract) throw new Error('reviewer ACCEPT lacks invitation or acceptance-contract evidence');
    const failed = Object.entries(review.checks ?? {}).filter(([, value]) => value !== 'PASS');
    if (failed.length) throw new Error(`reviewer ACCEPT contains failed checks: ${failed.map(([name]) => name).join(', ')}`);
  }
  return review;
}

class JsonlWriter {
  constructor(file) {
    this.file = file;
    this.queue = Promise.resolve();
  }

  append(record) {
    this.queue = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), {recursive: true, mode: 0o700});
      await appendFile(this.file, `${JSON.stringify(record)}\n`, {mode: 0o600});
    });
    return this.queue;
  }

  flush() {
    return this.queue;
  }
}

function qualificationFrom(preflight, review, config, reviewedAt, runId) {
  const subject = {
    schema_version: 1,
    candidate: preflight.candidate,
    preflight_evidence_sha256: preflight.evidence_sha256,
    preflight: {
      repository: preflight.repository,
      issue: preflight.issue,
      score: preflight.decision.score,
    },
    review,
    requested_model: review.requested_model ?? null,
    actual_model: review.actual_model ?? null,
    reasoning_effort: review.reasoning_effort ?? null,
    service_tier: review.service_tier ?? null,
  };
  const evidenceSha = sha256(Buffer.from(canonical(subject)));
  const reviewId = sha256(Buffer.from(canonical({
    finder_version: FINDER_VERSION,
    candidate: preflight.candidate,
    evidence_sha256: evidenceSha,
    review,
  })));
  return {
    task_id: review.task_id,
    finder_run_id: runId,
    review_id: reviewId,
    reviewed_at: reviewedAt,
    qualification_expires_at: new Date(Date.parse(reviewedAt) + config.qualificationTtlMs).toISOString(),
    evidence_sha256: evidenceSha,
    preflight_evidence_sha256: preflight.evidence_sha256,
    base_commit: review.base_commit,
    score: preflight.decision.score,
    candidate: preflight.candidate,
    repository: preflight.repository,
    issue: preflight.issue,
    requested_model: review.requested_model,
    actual_model: review.actual_model ?? null,
    reasoning_effort: review.reasoning_effort,
    service_tier: review.service_tier,
    model_requests: review.model_requests ?? null,
    input_tokens: review.input_tokens ?? null,
    cached_input_tokens: review.cached_input_tokens ?? null,
    output_tokens: review.output_tokens ?? null,
    reasoning_tokens: review.reasoning_tokens ?? null,
    review,
  };
}

function selectDiverse(accepted, requested, maxPerOwner) {
  const sorted = [...accepted].sort((a, b) => b.score.total - a.score.total
    || a.candidate.localeCompare(b.candidate));
  const selected = [];
  const reserves = [];
  const repositories = new Set();
  const owners = new Map();
  for (const item of sorted) {
    const parsed = parseCandidateKey(item.candidate);
    const repository = `${parsed.owner}/${parsed.repo}`.toLowerCase();
    const owner = parsed.owner.toLowerCase();
    if (selected.length < requested && !repositories.has(repository) && (owners.get(owner) ?? 0) < maxPerOwner) {
      selected.push(item);
      repositories.add(repository);
      owners.set(owner, (owners.get(owner) ?? 0) + 1);
    } else {
      reserves.push(item);
    }
  }
  return {selected, reserves};
}

export function isFatalReviewerInfrastructureError(message) {
  const normalized = String(message ?? '').toLowerCase();
  return normalized.includes("you've hit your usage limit")
    || normalized.includes('usage limit reached')
    || normalized.includes('quota exceeded')
    || normalized.includes('insufficient credits')
    || normalized.includes('authentication required')
    || normalized.includes('run codex login')
    || (/model\s+[^\s]+\s+is\s+unavailable/.test(normalized));
}

export class ModelProviderThrottleError extends Error {
  constructor(message = 'semantic reviewer hit a trusted model-provider throttle', options = {}) {
    super(message, options);
    this.name = 'ModelProviderThrottleError';
    this.code = 'MODEL_PROVIDER_THROTTLED';
    this.retryable = false;
  }
}

function qualificationResourceControlFile(explicit = null) {
  return path.resolve(explicit ?? process.env.OSS_RESOURCE_CONTROL_FILE ?? DEFAULT_RESOURCE_CONTROL);
}

export async function latchQualificationProviderThrottle(result, {
  resourceControlFile = null,
  gatewayOptions = {},
  at = new Date().toISOString(),
} = {}) {
  if (!isProviderThrottle(result, {source: 'model_runner'})) return false;
  const trusted = trustedModelProviderError(result);
  const controlFile = qualificationResourceControlFile(resourceControlFile);
  const control = await loadResourceControl(controlFile);
  if (!control.provider_pause) {
    await tripPersistentProviderThrottle(controlFile, {
      provider: trusted.provider,
      signal: 'OPENAI_MODEL_RATE_LIMIT',
      at,
      gatewayStateDir: resolveGhGatewayStateDir(gatewayOptions),
    });
  }
  return true;
}

async function trustedReviewerReceipt(statusFile) {
  let parsed;
  try { parsed = JSON.parse(await readFile(statusFile, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`model-runner status receipt is invalid: ${error.message}`);
  }
  if (parsed?.schema_version !== 1 || parsed?.kind !== 'MODEL_PROVIDER_ERROR') {
    throw new Error('model-runner status receipt has an invalid envelope');
  }
  const trusted = trustedModelProviderError(parsed);
  if (!trusted) throw new Error('model-runner status receipt has an invalid trusted provider signal');
  return trusted;
}

async function runReviewerWithTrustedStatus(args, options) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-model-runner-status-'));
  const statusFile = path.join(root, 'status.json');
  try {
    // The receipt path is carried only in the trusted reviewer environment; the
    // reviewer's Codex subprocess receives a small allowlisted environment that
    // does not inherit this variable.
    const result = await runBounded(process.execPath, args, {
      ...options,
      env: {...process.env, ...(options?.env ?? {}), OSS_MODEL_RUNNER_STATUS_FILE: statusFile},
    });
    const trusted = await trustedReviewerReceipt(statusFile);
    if (trusted) Object.defineProperty(result, TRUSTED_MODEL_PROVIDER_ERROR_FIELD, {value: trusted});
    return result;
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

export function isTerminalGitHubSubprocessError(message) {
  return /\bGITHUB_(?:PROVIDER_THROTTLED|GATEWAY_REFUSED|GATEWAY_TERMINAL)\b/.test(String(message ?? ''));
}

export class GitHubSubprocessTerminalError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'GitHubSubprocessTerminalError';
    this.code = 'GITHUB_GATEWAY_SUBPROCESS_TERMINAL';
  }
}

async function reviewQueue(queue, config, deadline, audit, history, runId) {
  const accepted = [];
  const terminal = [];
  let cursor = 0;
  let started = 0;
  let fatalInfrastructureError = null;
  let terminalGitHubError = null;
  let terminalModelProviderError = null;
  let modelProviderTrip = null;
  const modelProviderCancellation = new AbortController();

  const enough = () => selectDiverse(accepted, config.requested, config.maxPerOwner).selected.length >= config.requested;

  async function worker() {
    while (!deadline.expired() && !enough() && fatalInfrastructureError == null &&
        terminalGitHubError == null && terminalModelProviderError == null) {
      const index = cursor++;
      if (index >= queue.length) return;
      const candidate = queue[index];
      started += 1;
      const startedMs = Date.now();
      const startedAt = nowIso();
      const startRecord = {
        schema_version: FINDER_SCHEMA_VERSION,
        event: 'review_started',
        run_id: runId,
        at: startedAt,
        candidate: candidate.candidate,
        preflight_evidence_sha256: candidate.evidence_sha256,
      };
      await history.append(startRecord);
      progress(`review ${started}/${config.maxReviews}: ${candidate.candidate}`);
      audit.add('semantic_review_started', {
        candidate: candidate.candidate,
        queue_index: index,
        score: candidate.decision.score,
        preflight_evidence_sha256: candidate.evidence_sha256,
      });

      const result = await runReviewerWithTrustedStatus(numericReviewerInvocationArgs(candidate.candidate, config), {
        deadline,
        timeoutMs: config.reviewTimeoutMs,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        signal: modelProviderCancellation.signal,
      });
      const finishedAt = nowIso();
      const durationMs = Date.now() - startedMs;
      let terminalState;
      let review = null;
      let qualification = null;
      let error = null;

      if (isProviderThrottle(result, {source: 'model_runner'})) {
        terminalState = 'REJECTED_REVIEW_TOOL_ERROR';
        error = 'trusted model-runner transport reported a provider throttle';
        terminalModelProviderError ??= new ModelProviderThrottleError();
        modelProviderCancellation.abort();
        modelProviderTrip ??= latchQualificationProviderThrottle(result);
        await modelProviderTrip;
      } else if (terminalModelProviderError !== null) {
        return;
      } else if (![0, 2].includes(result.code)) {
        terminalState = result.timedOut ? 'REJECTED_REVIEW_TIMEOUT'
          : result.outputLimitExceeded ? 'REJECTED_REVIEW_OUTPUT_LIMIT'
            : 'REJECTED_REVIEW_TOOL_ERROR';
        error = (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(-3000);
        if (terminalState === 'REJECTED_REVIEW_TOOL_ERROR') {
          if (isTerminalGitHubSubprocessError(error)) terminalGitHubError ??= error;
          else if (isFatalReviewerInfrastructureError(error)) fatalInfrastructureError ??= error;
        }
      } else {
        try {
          review = JSON.parse(result.stdout);
          validateReview(review, candidate.candidate, result.code, config.profile, {
            expectedBaseCommit: candidate.repository.default_head,
            expectedIssueUrl: candidate.issue.url,
          });
          if (review.verdict === 'ACCEPT') {
            terminalState = 'ACCEPTED';
            qualification = {...qualificationFrom(candidate, review, config, finishedAt, runId), review_duration_ms: durationMs};
            accepted.push(qualification);
          } else {
            terminalState = 'REJECTED_SEMANTIC';
          }
        } catch (parseError) {
          terminalState = 'REJECTED_INVALID_REVIEW_OUTPUT';
          error = parseError.message;
        }
      }

      const finishRecord = {
        schema_version: FINDER_SCHEMA_VERSION,
        event: 'review_finished',
        run_id: runId,
        at: finishedAt,
        candidate: candidate.candidate,
        terminal_state: terminalState,
        duration_ms: durationMs,
        error,
        qualification,
        review: review?.verdict === 'REJECT' ? review : undefined,
      };
      await history.append(finishRecord);
      progress(`${terminalState} ${candidate.candidate}`);
      audit.add('semantic_review_finished', {
        candidate: candidate.candidate,
        terminal_state: terminalState,
        duration_ms: durationMs,
        error,
        review_id: qualification?.review_id ?? null,
        qualification_expires_at: qualification?.qualification_expires_at ?? null,
        stderr_tail: result.stderr.trim().slice(-1000) || null,
      });
      terminal.push({candidate: candidate.candidate, terminal_state: terminalState, duration_ms: durationMs, error, review});
    }
  }

  const workers = Array.from({length: Math.min(config.concurrency, queue.length || 1)}, () => worker());
  await Promise.all(workers);
  await history.flush();
  if (terminalGitHubError != null) {
    throw new GitHubSubprocessTerminalError(`semantic reviewer hit a terminal GitHub gateway stop: ${terminalGitHubError}`);
  }
  if (terminalModelProviderError != null) throw terminalModelProviderError;
  if (fatalInfrastructureError != null) {
    throw new Error(`semantic reviewer infrastructure failure: ${fatalInfrastructureError}`);
  }
  return {accepted, terminal, reviewsStarted: started, queueConsumed: Math.min(cursor, queue.length)};
}

async function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function acquireHistoryLock(historyFile, staleAfterMs) {
  await mkdir(path.dirname(historyFile), {recursive: true, mode: 0o700});
  const lockFile = `${historyFile}.lock`;
  async function attempt(allowRecovery) {
    try {
      const handle = await open(lockFile, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({pid: process.pid, host: os.hostname(), started_at: nowIso()})}\n`);
      await handle.sync();
      return {lockFile, handle};
    } catch (error) {
      if (error.code !== 'EEXIST' || !allowRecovery) throw error;
      let record = null;
      try { record = JSON.parse(await readFile(lockFile, 'utf8')); } catch {}
      const lockStat = await stat(lockFile);
      const stale = Date.now() - lockStat.mtimeMs > staleAfterMs;
      const alive = record?.host === os.hostname() ? await processAlive(record?.pid) : true;
      if (stale && !alive) {
        await rm(lockFile, {force: true});
        return attempt(false);
      }
      throw new Error(`candidate history is locked at ${lockFile}${record?.pid ? ` by pid ${record.pid}` : ''}`);
    }
  }
  const lock = await attempt(true);
  return async () => {
    try { await lock.handle.close(); } finally { await rm(lock.lockFile, {force: true}); }
  };
}

async function atomicWrite(file, contents, mode = 0o600) {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
}

function countValues(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function publicConfig(config) {
  return {
    requested: config.requested,
    profile: config.profile,
    labels: config.labels,
    terms: config.terms,
    repositories: config.repositories,
    total_budget_ms: config.totalBudgetMs,
    review_timeout_ms: config.reviewTimeoutMs,
    concurrency: config.concurrency,
    search_limit_per_query: config.searchLimit,
    max_reviews: config.maxReviews,
    preflight_limit: config.preflightLimit,
    stars_min: config.starsMin,
    max_comments: config.maxComments,
    max_push_age_days: config.maxPushAgeDays,
    min_score: config.minScore,
    max_per_owner: config.maxPerOwner,
    qualification_ttl_ms: config.qualificationTtlMs,
    exclusion_files: config.exclusionFiles,
    inclusion_files: config.inclusionFiles,
    include_only: config.includeOnly,
    discovery_file: config.discoveryFile,
    review_script: config.reviewScript,
    repo_policy_file: config.repoPolicyFile,
    gateway_wave_id: config.gatewayWaveId,
    gateway_wave_budget: config.gatewayWaveBudget,
  };
}

function takeOption(argv, names, fallback = null) {
  for (let index = 0; index < argv.length; index += 1) {
    if (!names.includes(argv[index])) continue;
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argv[index]} requires a value`);
    argv.splice(index, 2);
    return value;
  }
  return fallback;
}

function commandOutput(value, fallback) {
  return path.resolve(value ?? fallback);
}

export function reviewerProfileInvocationArgs(candidate, {profile = 'node', reviewScript = DEFAULT_REVIEWER} = {}) {
  parseCandidateKey(candidate);
  if (!SUPPORTED_PROFILES.includes(profile)) throw new Error(`profile must be one of ${SUPPORTED_PROFILES.join(', ')}`);
  return [reviewScript, candidate, '--profile', profile];
}

export function numericReviewerInvocationArgs(candidate, config = {}) {
  return reviewerProfileInvocationArgs(candidate, {
    profile: config.profile,
    reviewScript: config.reviewScript,
  });
}

export function reviewerInvocationArgs(record, {profile = 'node', reviewScript = DEFAULT_REVIEWER} = {}) {
  const repoPolicySha256 = record.preflight?.repo_policy_sha256;
  if (!validReviewDigest(repoPolicySha256)) {
    throw new Error('queued evidence is missing its canonical repo policy digest');
  }
  const args = [...reviewerProfileInvocationArgs(record.candidate, {profile, reviewScript}),
    '--expected-evidence-key', record.evidence_key, '--repo-policy-sha256', repoPolicySha256];
  const policy = record.repository_profile?.repo_policy ?? record.preflight?.repo_policy_snapshot ?? null;
  if (policy !== null) {
    const observed = sha256(Buffer.from(canonical(policy)));
    if (observed !== repoPolicySha256) {
      throw new Error(`queued repository policy bytes do not match ${repoPolicySha256}`);
    }
    args.push('--repo-policy-json', JSON.stringify(policy));
  }
  return args;
}

export async function qualifyQueueRecords(records, {
  lake,
  profile = 'node',
  count = records.length,
  concurrency = 4,
  reviewScript = DEFAULT_REVIEWER,
  reviewTimeoutMs = 5 * 60 * 1000,
  qualificationTtlMs = 2 * 60 * 60 * 1000,
  now = () => new Date(),
  reviewRunner = null,
  resourceControlFile = null,
  gatewayOptions = {},
} = {}) {
  if (!lake) throw new Error('qualify requires a candidate lake');
  if (!SUPPORTED_PROFILES.includes(profile)) throw new Error(`profile must be one of ${SUPPORTED_PROFILES.join(', ')}`);
  if (!Number.isInteger(count) || count < 1) throw new Error('qualify count must be positive');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error('qualify concurrency must be 1..12');
  const unique = [];
  const seen = new Set();
  for (const record of records) {
    const key = `${canonicalCandidate(record.candidate)}\0${record.evidence_key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(record);
    if (unique.length >= count) break;
  }
  const results = new Array(unique.length);
  let cursor = 0;
  let terminalGitHubError = null;
  let terminalModelProviderError = null;
  let modelProviderTrip = null;
  const modelProviderCancellation = new AbortController();
  const runner = reviewRunner ?? (async (record, {signal} = {}) => {
    return runReviewerWithTrustedStatus(reviewerInvocationArgs(record, {profile, reviewScript}),
    {timeoutMs: reviewTimeoutMs, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES, signal});
  });

  async function lane() {
    while (cursor < unique.length && terminalGitHubError === null && terminalModelProviderError === null) {
      const index = cursor++;
      const record = unique[index];
      try {
        const current = await lake.getIssue(record.candidate);
        if (!current || current.evidence_key !== record.evidence_key) {
          results[index] = {candidate: record.candidate, evidence_key: record.evidence_key, state: 'STALE_EVIDENCE'};
          continue;
        }
        if ((record.profile && record.profile !== profile) || (current.profile && current.profile !== profile)) {
          results[index] = {candidate: record.candidate, evidence_key: record.evidence_key,
            state: 'PROFILE_MISMATCH', cache_hit: false, error: `queue profile does not match requested ${profile}`};
          continue;
        }
        const cached = await lake.getCachedReview(record.candidate, record.evidence_key, now(), {profile});
        if (cached) {
          results[index] = {candidate: record.candidate, evidence_key: record.evidence_key,
            state: `CACHED_${cached.verdict}`, cache_hit: true, review: cached.result};
          continue;
        }
        const deterministicReason = deterministicSemanticReject(record, record.repository_profile ?? {});
        if (deterministicReason) {
          const latest = await lake.getIssue(record.candidate);
          if (!latest || latest.evidence_key !== record.evidence_key) {
            results[index] = {candidate: record.candidate, evidence_key: record.evidence_key, state: 'STALE_EVIDENCE'};
            continue;
          }
          const reviewedAt = now();
          const result = {
            verdict: 'REJECT', candidate: record.candidate, issue_url: record.preflight?.issue?.url ?? null,
            tier: 'C', executor_profile: profile, deterministic: true, reasons: [deterministicReason],
          };
          const reviewId = sha256(Buffer.from(canonical({kind: 'deterministic-semantic-reject-v1',
            candidate: canonicalCandidate(record.candidate), evidence_key: record.evidence_key, reason: deterministicReason})));
          await lake.putReview({
            candidate: record.candidate, evidence_key: record.evidence_key, verdict: 'REJECT', tier: 'C',
            executor_profile: profile, review_id: reviewId, result,
            provenance: {source: 'find-candidates qualify', kind: 'deterministic_semantic_reject'},
            reviewed_at: reviewedAt.toISOString(),
            expires_at: new Date(reviewedAt.getTime() + qualificationTtlMs).toISOString(),
          });
          results[index] = {candidate: record.candidate, evidence_key: record.evidence_key,
            state: 'REJECTED_DETERMINISTIC', cache_hit: false, review: result};
          continue;
        }
        const executed = await runner(record, {signal: modelProviderCancellation.signal});
        if (isProviderThrottle(executed, {source: 'model_runner'})) {
          terminalModelProviderError ??= new ModelProviderThrottleError();
          modelProviderCancellation.abort();
          modelProviderTrip ??= latchQualificationProviderThrottle(executed, {
            resourceControlFile, gatewayOptions, at: now().toISOString(),
          });
          await modelProviderTrip;
          return;
        }
        if (terminalModelProviderError !== null) return;
        if (!executed?.verdict && ![0, 2].includes(executed?.code)) {
          const detail = String(executed?.stderr || executed?.stdout || `exit ${executed?.code}`).trim().slice(-3000);
          if (isTerminalGitHubSubprocessError(detail)) {
            throw new GitHubSubprocessTerminalError(`semantic reviewer hit a terminal GitHub gateway stop: ${detail}`);
          }
          throw new Error(`semantic reviewer process failed: ${detail}`);
        }
        const review = executed?.verdict ? executed : JSON.parse(executed.stdout);
        const code = executed?.verdict ? (review.verdict === 'ACCEPT' ? 0 : 2) : executed.code;
        validateReview(review, record.candidate, code, profile, {
          expectedBaseCommit: record.preflight?.repository?.default_head,
          expectedIssueUrl: record.preflight?.issue?.url,
          expectedEvidenceKey: record.evidence_key,
        });
        const latest = await lake.getIssue(record.candidate);
        if (!latest || latest.evidence_key !== record.evidence_key) {
          results[index] = {candidate: record.candidate, evidence_key: record.evidence_key, state: 'STALE_EVIDENCE'};
          continue;
        }
        const reviewedAt = Number.isFinite(Date.parse(review.reviewed_at ?? '')) ? new Date(review.reviewed_at) : now();
        const expiresAt = Number.isFinite(Date.parse(review.qualification_expires_at ?? ''))
          ? new Date(review.qualification_expires_at)
          : new Date(reviewedAt.getTime() + qualificationTtlMs);
        const reviewId = validReviewDigest(review.review_id) ? review.review_id : sha256(Buffer.from(canonical({
          candidate: canonicalCandidate(record.candidate), evidence_key: record.evidence_key, review,
        })));
        await lake.putReview({
          candidate: record.candidate, evidence_key: record.evidence_key, verdict: review.verdict,
          tier: review.tier, executor_profile: review.executor_profile, review_id: reviewId,
          result: review, provenance: {source: 'find-candidates qualify', reviewer: reviewScript},
          reviewed_at: reviewedAt.toISOString(), expires_at: expiresAt.toISOString(),
        });
        results[index] = {candidate: record.candidate, evidence_key: record.evidence_key,
          state: review.verdict === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED_SEMANTIC', cache_hit: false, review};
      } catch (error) {
        if (terminalModelProviderError !== null || error instanceof ModelProviderThrottleError) return;
        if (error instanceof GitHubSubprocessTerminalError || isGhGatewayTerminalError(error)) {
          terminalGitHubError ??= error;
          return;
        }
        const failure = {candidate: record.candidate, evidence_key: record.evidence_key,
          state: 'REVIEW_TOOL_ERROR', cache_hit: false, error: error.message};
        await lake.recordCandidateState({...failure, observed_at: now().toISOString()}, {
          candidate: record.candidate,
          evidenceKey: record.evidence_key,
          state: failure.state,
          stateClass: 'retryable',
          source: 'find-candidates qualify',
        });
        results[index] = failure;
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, unique.length || 1)}, () => lane()));
  if (terminalGitHubError) {
    if (terminalGitHubError instanceof GitHubSubprocessTerminalError) throw terminalGitHubError;
    throw new GitHubSubprocessTerminalError(
      `semantic reviewer hit a terminal GitHub gateway stop: ${terminalGitHubError.message}`,
      {cause: terminalGitHubError},
    );
  }
  if (terminalModelProviderError) throw terminalModelProviderError;
  return results;
}

function validReviewDigest(value) {
  return /^sha256:[0-9a-f]{64}$/i.test(String(value ?? ''));
}

async function runCrawlCommand(argv) {
  const values = [...argv];
  const lakeFile = commandOutput(takeOption(values, ['--out', '--lake']), DEFAULT_LAKE);
  const count = positiveInteger(takeOption(values, ['--count'], '500'), '--count');
  const profiles = [...new Set(commaList(takeOption(values, ['--profile'], 'node'), '--profile'))];
  if (!profiles.every((profile) => SUPPORTED_PROFILES.includes(profile))) {
    throw new Error(`--profile must contain only ${SUPPORTED_PROFILES.join(', ')}`);
  }
  await assertGhRateSafetyAllowsAction();
  const lake = await openCandidateLake(lakeFile);
  const discoveredKeys = new Set();
  const preflightedKeys = new Set();
  const eligibleKeys = new Set();
  const persistedThisRun = new Set();
  const preflightPersisted = new Set();
  for (const [profileIndex, profile] of profiles.entries()) {
    const config = parseArgs([String(count), '--profile', profile, ...values]);
    // One archive corpus is profile-independent. The first pass can assign each
    // repository across the full requested profile set, so repeating GraphQL
    // hydration for later profiles would only consume gateway capacity.
    if (config.discoveryFile && profileIndex > 0) continue;
    const deadline = new Deadline(config.totalBudgetMs);
    const audit = new AuditLog(randomUUID());
    const [seen, included, repoPolicy] = await Promise.all([
      loadSeen(config.historyFile, config.exclusionFiles),
      loadIncluded(config.inclusionFiles),
      loadRepoPolicy(config.repoPolicyFile),
    ]);
    config.repoPolicy = repoPolicy;
    config.repoPolicySha = sha256(Buffer.from(canonical(repoPolicy)));
    if (!config.discoveryFile && config.repositories.length) {
      for (const repository of config.repositories) {
        const scanned = await discoverRepositoryInvitationLabels(repository, async ({page, perPage}) =>
          commandJson(`repository labels ${repository} page ${page}`, 'gh', [
            'api', `repos/${repository}/labels?per_page=${perPage}&page=${page}`, '--jq', '[.[]|.name]',
          ], {deadline, timeoutMs: config.ghTimeoutMs, requestClass: 'rest_read',
            waveId: config.gatewayWaveId, waveBudget: config.gatewayWaveBudget}),
        {policy: repoPolicy, maxPages: config.labelPages});
        config.labels = [...new Set([...config.labels, ...scanned.labels])];
        audit.add('repository_invitation_labels_scanned', {repository, ...scanned});
      }
    }
    const plan = buildSearchPlan(config);
    let counts;
    let searched;
    if (config.discoveryFile) {
      searched = await loadDiscoveryFile(config.discoveryFile);
      counts = {openCounts: new Map(), dailyCounts: new Map()};
      audit.add('discovery_file_loaded', {
        file: config.discoveryFile,
        candidates: searched.length,
        live_searches_skipped: true,
        northset_policy_searches_skipped: true,
      });
    } else {
      await checkRateLimits(config, plan, deadline, audit);
      counts = await openNorthsetPolicyCounts(config, deadline, audit);
      searched = await discover(config, plan, deadline, audit);
    }
    const discovered = mergeIncludedCandidates(searched, included);
    for (const candidate of discovered) discoveredKeys.add(candidate.key.toLowerCase());
    for (const candidate of discovered) {
      const key = candidate.key.toLowerCase();
      if (persistedThisRun.has(key)) continue;
      const existing = profiles.length > 1 ? await lake.getIssue(candidate.key) : null;
      // In a combined crawl, a new candidate is persisted only after live preflight can assign
      // one profile. Existing current state is invalidated once without changing its profile.
      if (profiles.length > 1 && !existing?.profile) continue;
      await lake.upsertIssue({
        candidate: candidate.key, repository: candidate.repository, issue: {
          title: candidate.title, state: 'OPEN', updated_at: candidate.updated_at, labels: candidate.labels,
          assignees: candidate.assignees, comments_count: candidate.comments_count,
          author_association: candidate.author_association,
        }, profile: existing?.profile ?? profile, clear_evidence: true,
        mechanical_reasons: ['pending live mechanical preflight'],
        raw: candidate, provenance: {finder_version: FINDER_VERSION, phase: 'crawl_discovery'},
      });
      persistedThisRun.add(key);
    }
    const cooldowns = Object.fromEntries(Object.entries(repoPolicy.cooldowns ?? {})
      .map(([repository, value]) => [repository.toLowerCase(), value]));
    const filtered = filterDiscovered(discovered, {
      seen, cooldowns, northsetOpenCounts: counts.openCounts, northsetDailyCounts: counts.dailyCounts,
      repoPolicy, preflightLimit: config.preflightLimit, included, includeOnly: config.includeOnly,
    });
    const preflight = await preflightCandidates(filtered.accepted, config, deadline, audit);
    for (const record of preflight) {
      const entry = policyEntry(repoPolicy, record.repository.name_with_owner);
      const assignedProfile = assignCrawlProfile(record.repository, profiles, entry.test_profile);
      const key = record.candidate.toLowerCase();
      if (preflightPersisted.has(key)) continue;
      const assignedRecord = assignedProfile === profile ? record : (() => {
        const decision = mechanicalDecision(record, {...config, profile: assignedProfile}, deadline.startedAtMs);
        const evidenceSha256 = candidateEvidenceKey({
          candidate: record.candidate,
          profile: assignedProfile,
          base_commit: record.repository.default_head,
          issue_updated_at: record.issue.updated_at,
          labels: record.issue.labels,
          assignees: record.issue.assignees,
          comments_tail_sha256: record.comments_tail_sha256,
          timeline_prs_sha256: record.timeline_prs_sha256,
          repo_policy_sha256: record.repo_policy_sha256,
        });
        return {...record, decision, evidence_sha256: evidenceSha256};
      })();
      audit.add('candidate_profile_assigned', {candidate: record.candidate, observed_profile: profile,
        assigned_profile: assignedProfile, primary_language: record.repository.primary_language,
        evidence_sha256: assignedRecord.evidence_sha256});
      preflightedKeys.add(key);
      if (assignedRecord.decision.eligible) eligibleKeys.add(key);
      const caps = repositoryCaps(repoPolicy, record.repository.name_with_owner);
      const invitationLabelMap = Object.fromEntries([
        ...(entry.invitation_labels ?? []).map((label) => [label, true]),
        ...Object.entries(entry.invitation_label_map ?? {}).filter(([, enabled]) => enabled === true),
      ]);
      await lake.upsertRepository({
        repo: record.repository.name_with_owner, ...record.repository, test_profile: assignedProfile,
        install_command: entry.install_command, full_check_commands: entry.full_check_commands ?? [],
        invitation_label_map: invitationLabelMap, ...caps,
        ...(config.discoveryFile ? {} : {
          open_northset_prs: counts.openCounts.get(record.repository.name_with_owner.toLowerCase()) ?? 0,
          northset_prs_opened_today: counts.dailyCounts.get(record.repository.name_with_owner.toLowerCase()) ?? 0,
        }),
        observed_at: new Date().toISOString(),
        raw: record.repository, provenance: {finder_version: FINDER_VERSION, phase: 'crawl_preflight'},
      });
      await lake.upsertIssue({
        ...assignedRecord, profile: assignedProfile, evidence_key: assignedRecord.evidence_sha256,
        base_commit: assignedRecord.repository.default_head,
        mechanical_score: assignedRecord.decision.score.total,
        mechanical_reasons: assignedRecord.decision.reasons,
        raw: assignedRecord, provenance: {finder_version: FINDER_VERSION, phase: 'crawl_preflight'},
      });
      persistedThisRun.add(key);
      preflightPersisted.add(key);
    }
  }
  return {schema_version: 1, command: 'crawl', profiles, lake: lake.database,
    discovered: discoveredKeys.size, preflighted: preflightedKeys.size, eligible: eligibleKeys.size,
    lake_stats: await lake.stats()};
}

async function runRankCommand(argv) {
  const values = [...argv];
  const lakeFile = commandOutput(takeOption(values, ['--lake']), DEFAULT_LAKE);
  const output = commandOutput(takeOption(values, ['--out', '--output']), path.join(SCRIPT_DIR, 'runs', 'review-queue.json'));
  const count = positiveInteger(takeOption(values, ['--count'], '100'), '--count');
  const profile = takeOption(values, ['--profile'], 'node');
  if (values.length) throw new Error(`unknown rank argument ${values[0]}`);
  if (!SUPPORTED_PROFILES.includes(profile)) throw new Error(`--profile must be one of ${SUPPORTED_PROFILES.join(', ')}`);
  const lake = await openCandidateLake(lakeFile);
  const queue = await lake.rank({profile, count});
  const report = {schema_version: 1, command: 'rank', profile, count: queue.length, queue};
  await atomicWrite(output, `${JSON.stringify(report, null, 2)}\n`);
  return {...report, output};
}

async function runQualifyCommand(argv) {
  const values = [...argv];
  const queueFile = commandOutput(takeOption(values, ['--queue']), path.join(SCRIPT_DIR, 'runs', 'review-queue.json'));
  const lakeFile = commandOutput(takeOption(values, ['--lake']), DEFAULT_LAKE);
  const output = commandOutput(takeOption(values, ['--out', '--output']), path.join(SCRIPT_DIR, 'runs', 'qualifications.json'));
  const countValue = takeOption(values, ['--count'], null);
  const concurrency = positiveInteger(takeOption(values, ['--concurrency'], '4'), '--concurrency');
  if (concurrency > 12) throw new Error('--concurrency must be at most 12');
  const profile = takeOption(values, ['--profile'], 'node');
  const reviewScript = commandOutput(takeOption(values, ['--review-script']), DEFAULT_REVIEWER);
  const timeoutSeconds = positiveInteger(takeOption(values, ['--review-timeout-seconds'], '300'), '--review-timeout-seconds');
  const phase1RuntimeValue = takeOption(values, ['--phase1-runtime'], null);
  const phase1Runtime = phase1RuntimeValue ? path.resolve(phase1RuntimeValue) : null;
  if (values.length) throw new Error(`unknown qualify argument ${values[0]}`);
  await assertGhRateSafetyAllowsAction();
  const loaded = JSON.parse(await readFile(queueFile, 'utf8'));
  const queue = Array.isArray(loaded) ? loaded : loaded.queue;
  if (!Array.isArray(queue)) throw new Error('review queue must be an array or an object with queue[]');
  const count = countValue ? positiveInteger(countValue, '--count') : queue.length;
  const selected = queue.slice(0, count);
  await assertPhase1Runtime(phase1Runtime, {
    action: 'qualify',
    repositories: selected.map((record) => {
      const candidate = parseCandidateKey(record.candidate);
      return `${candidate.owner}/${candidate.repo}`;
    }),
    units: selected.length,
  });
  const lake = await openCandidateLake(lakeFile);
  const results = await qualifyQueueRecords(queue, {
    lake, profile, count,
    concurrency, reviewScript, reviewTimeoutMs: timeoutSeconds * 1000,
  });
  const report = {schema_version: 1, command: 'qualify', profile, queue_file: queueFile,
    accepted: results.filter((item) => ['ACCEPTED', 'CACHED_ACCEPT'].includes(item.state)).length, results};
  await atomicWrite(output, `${JSON.stringify(report, null, 2)}\n`);
  return {...report, output};
}

async function runImportCommand(argv) {
  const values = [...argv];
  const lakeFile = commandOutput(takeOption(values, ['--lake', '--out']), DEFAULT_LAKE);
  if (!values.length) throw new Error('import requires one or more Batch 3 JSON/JSONL files');
  if (values.some((value) => value.startsWith('--'))) throw new Error(`unknown import argument ${values.find((value) => value.startsWith('--'))}`);
  const lake = await openCandidateLake(lakeFile);
  return {schema_version: 1, command: 'import', lake: lake.database, ...(await lake.importFiles(values))};
}

async function subcommandMain(command, argv) {
  const handlers = {crawl: runCrawlCommand, rank: runRankCommand, qualify: runQualifyCommand, import: runImportCommand};
  const report = await handlers[command](argv);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  let config;
  try {
    config = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`find error: ${error.message}`);
    console.error(usage());
    process.exit(1);
  }
  if (config.help) {
    process.stdout.write(usage());
    return;
  }

  await assertGhRateSafetyAllowsAction();

  const runId = randomUUID();
  const deadline = new Deadline(config.totalBudgetMs);
  const startedAt = nowIso();
  const audit = new AuditLog(runId);
  const history = new JsonlWriter(config.historyFile);
  let releaseLock = null;

  try {
    releaseLock = await acquireHistoryLock(config.historyFile, config.totalBudgetMs * 2);
    audit.add('run_started', {finder_version: FINDER_VERSION, config: publicConfig(config)});
    progress(`starting batch: requested=${config.requested} budget=${Math.round(config.totalBudgetMs / 1000)}s max_reviews=${config.maxReviews}`);

    const [seen, included, repoPolicy, scriptBytes] = await Promise.all([
      loadSeen(config.historyFile, config.exclusionFiles),
      loadIncluded(config.inclusionFiles),
      loadRepoPolicy(config.repoPolicyFile),
      readFile(SCRIPT_FILE),
    ]);
    const cooldowns = Object.fromEntries(Object.entries(repoPolicy.cooldowns ?? {})
      .map(([repository, value]) => [repository.toLowerCase(), value]));
    config.repoPolicy = repoPolicy;
    config.repoPolicySha = sha256(Buffer.from(canonical(repoPolicy)));
    const plan = buildSearchPlan(config);
    let northsetPolicyCounts;
    let searched;
    if (config.discoveryFile) {
      searched = await loadDiscoveryFile(config.discoveryFile);
      northsetPolicyCounts = {openCounts: new Map(), dailyCounts: new Map()};
      audit.add('discovery_file_loaded', {
        file: config.discoveryFile,
        candidates: searched.length,
        live_searches_skipped: true,
        northset_policy_searches_skipped: true,
      });
    } else {
      await checkRateLimits(config, plan, deadline, audit);
      northsetPolicyCounts = await openNorthsetPolicyCounts(config, deadline, audit);
      searched = await discover(config, plan, deadline, audit);
    }
    const discovered = mergeIncludedCandidates(searched, included);
    audit.add('discovery_completed', {
      unique_candidates: discovered.length,
      search_candidates: searched.length,
      explicitly_included: included.size,
    });
    progress(`discovery complete: ${discovered.length} unique issues`);

    const filtered = filterDiscovered(discovered, {
      seen,
      cooldowns,
      northsetOpenCounts: northsetPolicyCounts.openCounts,
      northsetDailyCounts: northsetPolicyCounts.dailyCounts,
      repoPolicy,
      preflightLimit: config.preflightLimit,
      included,
      includeOnly: config.includeOnly,
    });
    for (const rejection of filtered.rejected) audit.add('discovery_rejected', rejection);
    audit.add('discovery_filter_completed', {eligible_for_preflight: filtered.accepted.length, rejected: filtered.rejected.length});

    const preflight = await preflightCandidates(filtered.accepted, config, deadline, audit);
    const eligible = preflight.filter((record) => record.decision.eligible);
    const reviewQueueRecords = buildReviewQueue(preflight, config.maxReviews);
    progress(`preflight complete: ${eligible.length} eligible; ${reviewQueueRecords.length} queued for one semantic review each`);
    audit.add('review_queue_built', {
      preflighted: preflight.length,
      eligible: eligible.length,
      queued: reviewQueueRecords.length,
      max_reviews: config.maxReviews,
    });

    let reviewResult = {accepted: [], terminal: [], reviewsStarted: 0, queueConsumed: 0};
    if (!config.dryRun && reviewQueueRecords.length && !deadline.expired()) {
      reviewResult = await reviewQueue(reviewQueueRecords, config, deadline, audit, history, runId);
    }

    const diversity = selectDiverse(reviewResult.accepted, config.requested, config.maxPerOwner);
    for (const item of diversity.selected) {
      await history.append({schema_version: FINDER_SCHEMA_VERSION, event: 'batch_disposition', run_id: runId,
        at: nowIso(), candidate: item.candidate, disposition: 'SELECTED', review_id: item.review_id});
    }
    for (const item of diversity.reserves) {
      await history.append({schema_version: FINDER_SCHEMA_VERSION, event: 'batch_disposition', run_id: runId,
        at: nowIso(), candidate: item.candidate, disposition: 'RESERVE', review_id: item.review_id});
    }
    await history.flush();

    const complete = config.dryRun ? true : diversity.selected.length === config.requested;
    const state = config.dryRun ? 'PREFLIGHT_ONLY'
      : complete ? 'COMPLETE'
        : deadline.expired() ? 'PARTIAL_BUDGET'
          : 'PARTIAL_EXHAUSTED';
    const finishedAt = nowIso();
    const report = {
      schema_version: FINDER_SCHEMA_VERSION,
      finder_version: FINDER_VERSION,
      run_id: runId,
      state,
      requested: config.requested,
      found: diversity.selected.length,
      complete,
      started_at: startedAt,
      finished_at: finishedAt,
      elapsed_ms: Date.now() - deadline.startedAtMs,
      remaining_budget_ms: deadline.remainingMs(),
      config: publicConfig(config),
      provenance: {
        script_sha256: sha256(scriptBytes),
        config_sha256: sha256(Buffer.from(canonical(publicConfig(config)))),
        search_plan: plan.map((query) => ({...query, rest_query: restSearchQuery(query, config)})),
      },
      counts: {
        discovered_unique: discovered.length,
        rejected_before_preflight: filtered.rejected.length,
        preflighted: preflight.length,
        preflight_eligible: eligible.length,
        semantic_reviews_started: reviewResult.reviewsStarted,
        semantic_accepts: reviewResult.accepted.length,
        semantic_reserves: diversity.reserves.length,
      },
      rejection_summary: {
        discovery: countValues(filtered.rejected.map((item) => item.reason)),
        preflight: countValues(preflight.filter((item) => !item.decision.eligible)
          .flatMap((item) => item.decision.reasons)),
        semantic_terminal_states: countValues(reviewResult.terminal.map((item) => item.terminal_state)),
      },
      output_file: config.outputFile,
      audit_file: config.auditFile,
      history_file: config.historyFile,
      candidates: diversity.selected.map((item, index) => ({
        rank: index + 1,
        candidate_rank: index + 1,
        finder_run_id: runId,
        task_id: item.task_id,
        reviewer_model: item.review?.requested_model ?? null,
        reviewer_effort: item.review?.reasoning_effort ?? null,
        finder_elapsed_ms: Date.now() - deadline.startedAtMs,
        ...item,
      })),
      reserves: diversity.reserves,
      preflight_ranking: config.dryRun
        ? eligible.sort((a, b) => b.decision.score.total - a.decision.score.total
          || a.candidate.localeCompare(b.candidate)).map((record, index) => ({
            rank: index + 1,
            candidate: record.candidate,
            score: record.decision.score,
            repository: record.repository,
            issue: record.issue,
            evidence_sha256: record.evidence_sha256,
          }))
        : undefined,
      review_decisions: reviewResult.terminal.map((item) => ({
        candidate: item.candidate,
        terminal_state: item.terminal_state,
        duration_ms: item.duration_ms,
        error: item.error,
        summary: item.review?.summary ?? null,
        reasons: item.review?.reasons?.slice(0, 3) ?? [],
      })),
    };
    audit.add('run_finished', {state, found: report.found, complete, elapsed_ms: report.elapsed_ms});
    progress(`finished: state=${state} found=${report.found}/${config.requested} elapsed=${Math.round(report.elapsed_ms / 1000)}s`);

    await Promise.all([
      atomicWrite(config.outputFile, `${JSON.stringify(report, null, 2)}\n`),
      atomicWrite(config.auditFile, `${audit.records.map((record) => JSON.stringify(record)).join('\n')}\n`),
    ]);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = complete ? 0 : 2;
  } catch (error) {
    audit.add('run_failed', {error: error.message});
    try {
      await atomicWrite(config.auditFile, `${audit.records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    } catch {}
    console.error(`find error: ${error.message}`);
    process.exitCode = 1;
  } finally {
    try { await history.flush(); } catch {}
    if (releaseLock) await releaseLock();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  const command = process.argv[2];
  if (['crawl', 'rank', 'qualify', 'import'].includes(command)) {
    try { await subcommandMain(command, process.argv.slice(3)); }
    catch (error) {
      console.error(`find ${command} error: ${error.message}`);
      process.exitCode = 1;
    }
  } else {
    await main();
  }
}
