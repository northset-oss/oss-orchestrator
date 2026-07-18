#!/usr/bin/env node

/**
 * GitHub Archive discovery miner.
 *
 * This module deliberately has no GitHub API integration. Its only remote
 * source is data.gharchive.org, and all pipeline tests inject a fake fetch.
 */

import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {mkdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createGunzip} from 'node:zlib';

export const ARCHIVE_MINER_SCHEMA_VERSION = 1;
export const ARCHIVE_MINER_VERSION = '1.0.0';
export const DEFAULT_LABELS = Object.freeze(['good first issue', 'help wanted', 'bug']);
export const DEFAULT_MAX_HOURS = 48;
export const MIN_DOWNLOAD_SPACING_MS = 500;
export const ARCHIVE_USER_AGENT = `northset-oss-orchestrator-gharchive-miner/${ARCHIVE_MINER_VERSION}`;

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const DEFAULT_CACHE_DIR = path.join(SCRIPT_DIR, 'runs', 'gharchive-cache');
const DEFAULT_LAKE = path.join(SCRIPT_DIR, 'candidate_lake.sqlite');
const ALLOWED_ACTIONS = new Set(['opened', 'labeled', 'reopened']);

function positiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/.test(String(value ?? ''))) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function commaList(value, label) {
  const items = [...new Set(String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean))];
  if (!items.length) throw new Error(`${label} must contain at least one value`);
  return items;
}

function utcHour(value) {
  if (!String(value ?? '').endsWith('Z')) throw new Error('--from must be a UTC ISO hour ending in Z');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) {
    throw new Error('--from must be aligned to a UTC hour');
  }
  return date;
}

export function parseArgs(argv, env = process.env) {
  if (argv.includes('-h') || argv.includes('--help')) return {help: true};
  const values = new Map();
  const known = new Set(['--from', '--hours', '--labels', '--languages', '--out', '--cache-dir', '--max-hours']);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!known.has(name)) throw new Error(`unknown argument ${name}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} may be specified only once`);
    values.set(name, value);
  }
  if (!values.has('--from') || !values.has('--hours') || !values.has('--out')) {
    throw new Error('--from, --hours, and --out are required');
  }
  const from = utcHour(values.get('--from'));
  const hours = positiveInteger(values.get('--hours'), '--hours');
  const maxHours = positiveInteger(values.get('--max-hours') ?? String(DEFAULT_MAX_HOURS), '--max-hours');
  if (maxHours > DEFAULT_MAX_HOURS) throw new Error(`--max-hours cannot exceed ${DEFAULT_MAX_HOURS}`);
  if (hours > maxHours) throw new Error(`--hours cannot exceed --max-hours (${maxHours})`);
  return {
    from,
    hours,
    labels: commaList(values.get('--labels') ?? DEFAULT_LABELS.join(','), '--labels'),
    languages: values.has('--languages') ? commaList(values.get('--languages'), '--languages') : [],
    outputFile: path.resolve(values.get('--out')),
    cacheDir: path.resolve(values.get('--cache-dir') ?? DEFAULT_CACHE_DIR),
    maxHours,
    lakeFile: path.resolve(env.OSS_CANDIDATE_LAKE ?? DEFAULT_LAKE),
  };
}

export function usage() {
  return `GitHub Archive candidate miner v${ARCHIVE_MINER_VERSION}

Usage:
  node archive-miner.mjs --from <UTC ISO hour> --hours <N> --out <file> [options]

Options:
  --labels a,b        Target labels (default: good first issue,help wanted,bug)
  --languages a,b     Optional local-lake language filter
  --cache-dir path    Archive cache (default: runs/gharchive-cache)
  --max-hours N       Safety bound for --hours (default and ceiling: 48)
`;
}

export function archiveHourId(date) {
  return `${date.toISOString().slice(0, 10)}-${String(date.getUTCHours()).padStart(2, '0')}`;
}

function normalizedLabels(issue) {
  return [...new Set((issue?.labels ?? []).map((label) => typeof label === 'string' ? label : label?.name)
    .map((label) => String(label ?? '').trim()).filter(Boolean))];
}

function archiveCandidate(event, targetLabels) {
  if (event?.type !== 'IssuesEvent' || !ALLOWED_ACTIONS.has(event?.payload?.action)) return null;
  const issue = event.payload.issue;
  const repository = event?.repo?.name;
  if (!issue || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repository ?? '')) ||
      !Number.isInteger(issue.number) || issue.number < 1) return null;
  const labels = normalizedLabels(issue);
  if (!labels.some((label) => targetLabels.has(label.toLowerCase()))) return null;
  const candidate = `${repository}#${issue.number}`;
  return {
    candidate,
    title: String(issue.title ?? ''),
    body_excerpt: String(issue.body ?? '').slice(0, 8_000),
    url: issue.html_url ?? `https://github.com/${repository}/issues/${issue.number}`,
    labels,
    assignees: (issue.assignees ?? []).map((item) => item?.login ?? item).filter(Boolean),
    comments_count: Number(issue.comments ?? 0),
    author_association: issue.author_association ?? null,
    locked: Boolean(issue.locked),
    created_at: issue.created_at ?? null,
    updated_at: issue.updated_at ?? event.created_at ?? null,
    event_at: event.created_at ?? issue.updated_at ?? null,
    archive_action: event.payload.action,
    language: null,
  };
}

/** Stream-decompress and line-parse one cached hourly archive. */
export async function parseArchive(file, labels = DEFAULT_LABELS) {
  const targetLabels = new Set(labels.map((label) => label.toLowerCase()));
  const input = createReadStream(file).pipe(createGunzip());
  const lines = readline.createInterface({input, crlfDelay: Infinity});
  const candidates = new Map();
  let eventsSeen = 0;
  let matchedEvents = 0;
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      eventsSeen += 1;
      let event;
      try { event = JSON.parse(line); }
      catch (error) { throw new Error(`${file}:${lineNumber} is invalid JSON: ${error.message}`); }
      const candidate = archiveCandidate(event, targetLabels);
      if (!candidate) continue;
      matchedEvents += 1;
      const key = candidate.candidate.toLowerCase();
      const previous = candidates.get(key);
      if (!previous || Date.parse(candidate.event_at ?? '') >= Date.parse(previous.event_at ?? '')) {
        candidates.set(key, candidate);
      }
    }
  } finally {
    lines.close();
  }
  return {candidates: [...candidates.values()], events_seen: eventsSeen, matched_events: matchedEvents};
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqliteJson(database, source, sqliteBin) {
  return new Promise((resolve, reject) => {
    const child = spawn(sqliteBin, ['-readonly', '-json', database], {stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`sqlite3 failed: ${(stderr || stdout).trim() || `exit ${code}`}`));
        return;
      }
      try { resolve(stdout.trim() ? JSON.parse(stdout) : []); }
      catch (error) { reject(new Error(`sqlite3 returned invalid JSON: ${error.message}`)); }
    });
    child.stdin.end(`.timeout 5000\n${source}\n`);
  });
}

export async function enrichLanguages(candidates, {lakeFile = DEFAULT_LAKE, sqliteBin = 'sqlite3'} = {}) {
  try { await stat(lakeFile); }
  catch (error) {
    if (error.code === 'ENOENT') return {available: false, reason: 'candidate lake not found', candidates};
    throw error;
  }
  const repositories = [...new Set(candidates.map((candidate) => candidate.candidate.split('#')[0].toLowerCase()))];
  try {
    const rows = repositories.length ? await sqliteJson(lakeFile,
      `SELECT lower(repo_key) AS repo_key, primary_language FROM repositories WHERE lower(repo_key) IN (${repositories.map(sql).join(',')});`,
    sqliteBin) : [];
    const languages = new Map(rows.map((row) => [String(row.repo_key).toLowerCase(), row.primary_language ?? null]));
    return {
      available: true,
      reason: null,
      candidates: candidates.map((candidate) => ({...candidate,
        language: languages.get(candidate.candidate.split('#')[0].toLowerCase()) ?? null})),
    };
  } catch (error) {
    return {available: false, reason: error.message, candidates};
  }
}

async function fileExists(file) {
  try { await stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function atomicWrite(file, contents) {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents, {flag: 'wx'});
  try { await rename(temporary, file); }
  catch (error) { await rm(temporary, {force: true}); throw error; }
}

async function responseBytes(response) {
  if (typeof response.arrayBuffer !== 'function') throw new Error('archive response has no readable body');
  return Buffer.from(await response.arrayBuffer());
}

class ArchiveHostThrottleError extends Error {
  constructor(status, attempts) {
    super(`archive host refused request with HTTP ${status}`);
    this.name = 'ArchiveHostThrottleError';
    this.status = status;
    this.attempts = attempts;
  }
}

async function downloadHour(url, cacheFile, {
  fetchImpl, sleep, clock, spacingMs, retryBackoffMs, pacing,
}) {
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (pacing.last_started_at !== null) {
      const wait = Math.max(0, spacingMs - (clock() - pacing.last_started_at));
      if (wait > 0) await sleep(wait);
    }
    pacing.last_started_at = clock();
    let response;
    try {
      response = await fetchImpl(url, {headers: {'User-Agent': ARCHIVE_USER_AGENT, Accept: 'application/gzip'}});
    } catch (error) {
      attempts.push({attempt, error: error.message});
      return {ok: false, attempts, error: error.message};
    }
    attempts.push({attempt, status: response.status});
    if (response.status === 403 || response.status === 429) throw new ArchiveHostThrottleError(response.status, attempts);
    if (!response.ok) {
      if (response.status >= 500 && response.status <= 599 && attempt === 1) {
        await sleep(retryBackoffMs);
        continue;
      }
      return {ok: false, attempts, error: `HTTP ${response.status}`};
    }
    const temporary = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      const bytes = await responseBytes(response);
      await writeFile(temporary, bytes, {flag: 'wx'});
      await rename(temporary, cacheFile);
    } catch (error) {
      await rm(temporary, {force: true});
      attempts.at(-1).error = error.message;
      return {ok: false, attempts, error: `archive body/cache failure: ${error.message}`};
    }
    return {ok: true, attempts};
  }
  return {ok: false, attempts, error: 'archive download failed'};
}

export async function mineArchives(config, {
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = Date.now,
  sqliteBin = 'sqlite3',
  spacingMs = MIN_DOWNLOAD_SPACING_MS,
  retryBackoffMs = 1_000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  if (spacingMs < MIN_DOWNLOAD_SPACING_MS) throw new Error(`download spacing must be at least ${MIN_DOWNLOAD_SPACING_MS}ms`);
  await mkdir(config.cacheDir, {recursive: true, mode: 0o700});
  const manifest = {
    requested_hours: [],
    mined_hours: [],
    skipped_cached_hours: [],
    failed_hours: [],
    unattempted_hours: [],
    aborted: false,
    abort_reason: null,
  };
  const allCandidates = new Map();
  const pacing = {last_started_at: null};

  for (let offset = 0; offset < config.hours; offset += 1) {
    const date = new Date(config.from.getTime() + offset * 3_600_000);
    const hour = archiveHourId(date);
    manifest.requested_hours.push(hour);
    const cacheFile = path.join(config.cacheDir, `${hour}.json.gz`);
    const cached = await fileExists(cacheFile);
    let download = {ok: true, attempts: []};
    if (!cached) {
      try {
        download = await downloadHour(`https://data.gharchive.org/${hour}.json.gz`, cacheFile, {
          fetchImpl, sleep, clock, spacingMs, retryBackoffMs, pacing,
        });
      } catch (error) {
        if (!(error instanceof ArchiveHostThrottleError)) throw error;
        manifest.failed_hours.push({hour, status: error.status, error: error.message, attempts: error.attempts});
        manifest.aborted = true;
        manifest.abort_reason = `archive-host-throttle-${error.status}`;
        for (let rest = offset + 1; rest < config.hours; rest += 1) {
          manifest.unattempted_hours.push(archiveHourId(new Date(config.from.getTime() + rest * 3_600_000)));
        }
        break;
      }
      if (!download.ok) {
        manifest.failed_hours.push({hour, error: download.error, attempts: download.attempts});
        continue;
      }
    }
    try {
      const parsed = await parseArchive(cacheFile, config.labels);
      const detail = {hour, cache_file: cacheFile, events_seen: parsed.events_seen,
        matched_events: parsed.matched_events, candidates: parsed.candidates.length,
        ...(download.attempts.length ? {download_attempts: download.attempts} : {})};
      if (cached) manifest.skipped_cached_hours.push(detail);
      else manifest.mined_hours.push(detail);
      for (const candidate of parsed.candidates) {
        const key = candidate.candidate.toLowerCase();
        const previous = allCandidates.get(key);
        if (!previous || Date.parse(candidate.event_at ?? '') >= Date.parse(previous.event_at ?? '')) {
          allCandidates.set(key, candidate);
        }
      }
    } catch (error) {
      manifest.failed_hours.push({hour, cache_file: cacheFile, error: error.message, attempts: download.attempts});
    }
  }

  let candidates = [...allCandidates.values()];
  const enrichment = await enrichLanguages(candidates, {lakeFile: config.lakeFile, sqliteBin});
  candidates = enrichment.candidates;
  const requestedLanguages = new Set(config.languages.map((language) => language.toLowerCase()));
  if (requestedLanguages.size && enrichment.available) {
    candidates = candidates.filter((candidate) => requestedLanguages.has(String(candidate.language ?? '').toLowerCase()));
  }
  candidates.sort((left, right) => Date.parse(right.event_at ?? '') - Date.parse(left.event_at ?? '')
    || left.candidate.localeCompare(right.candidate));
  const unscreened = candidates.map((candidate, index) => ({rank: index + 1, ...candidate}));
  const complete = !manifest.aborted && manifest.failed_hours.length === 0;
  const report = {
    schema_version: ARCHIVE_MINER_SCHEMA_VERSION,
    miner_version: ARCHIVE_MINER_VERSION,
    source: 'gharchive',
    state: complete ? 'COMPLETE' : manifest.aborted ? 'PARTIAL_ABORTED' : 'PARTIAL',
    generated_at: new Date(clock()).toISOString(),
    from: config.from.toISOString(),
    hours: config.hours,
    labels: config.labels,
    languages: config.languages,
    language_enrichment: {available: enrichment.available, reason: enrichment.reason,
      filter_applied: requestedLanguages.size > 0 && enrichment.available},
    manifest,
    unscreened_candidates: unscreened,
  };
  await atomicWrite(config.outputFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function main() {
  let config;
  try { config = parseArgs(process.argv.slice(2)); }
  catch (error) {
    console.error(`archive miner error: ${error.message}`);
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  if (config.help) {
    process.stdout.write(usage());
    return;
  }
  try {
    const report = await mineArchives(config);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.state === 'COMPLETE' ? 0 : 2;
  } catch (error) {
    console.error(`archive miner error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) await main();
