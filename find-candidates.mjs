#!/usr/bin/env node

// Find the next N Northset OSS candidates, using review-issue.mjs as the validator.
//
// Usage: node find-candidates.mjs 10

import {spawn} from 'node:child_process';
import {appendFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const DEFAULT_HISTORY = path.join(SCRIPT_DIR, 'runs', 'candidate-history.jsonl');
const DEFAULT_REVIEWER = path.join(SCRIPT_DIR, 'review-issue.mjs');
const DEFAULT_SEARCH_LABELS = ['good first issue', 'help wanted'];
const SUPPORTED_PROFILES = ['node'];

export function parseCount(value) {
  if (!/^[1-9][0-9]*$/.test(value || '')) throw new Error('N must be a positive integer');
  return Number(value);
}

export function parseStarsMin(value) {
  return value === undefined ? 10 : parseCount(value);
}

export function parseProfile(value = 'node') {
  if (!SUPPORTED_PROFILES.includes(value)) throw new Error(`profile must be one of ${SUPPORTED_PROFILES.join(', ')}`);
  return value;
}

export function parseSearchLimit(value, fallback) {
  const limit = value === undefined ? fallback : parseCount(value);
  if (limit > 1000) throw new Error('OSS_FIND_SEARCH_LIMIT must be at most 1000');
  return limit;
}

export function parseSearchLabels(value) {
  if (value === undefined) return [...DEFAULT_SEARCH_LABELS];
  const labels = [...new Set(value.split(',').map((label) => label.trim()).filter(Boolean))];
  if (labels.length === 0) throw new Error('OSS_FIND_LABELS must contain at least one label');
  return labels;
}

export function parseSearchTerms(value) {
  if (value === undefined) return [];
  const terms = [...new Set(value.split(',').map((term) => term.trim()).filter(Boolean))];
  if (terms.length === 0) throw new Error('OSS_FIND_TERMS must contain at least one term');
  return terms;
}

export function parseSearchRepos(value) {
  if (value === undefined) return [];
  const repos = [...new Set(value.split(',').map((repo) => repo.trim()).filter(Boolean))];
  if (repos.length === 0) throw new Error('OSS_FIND_REPOS must contain at least one owner/repo');
  for (const repo of repos) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new Error(`OSS_FIND_REPOS expected owner/repo, received ${repo}`);
    }
  }
  return repos;
}

export function candidateKey(issue) {
  const repository = issue?.repository?.nameWithOwner;
  if (!repository || !Number.isInteger(issue?.number)) throw new Error('GitHub search returned an invalid issue');
  return `${repository}#${issue.number}`;
}

export function extractIssueKeys(text) {
  const keys = new Set();
  for (const match of text.matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)\b/g)) {
    keys.add(`${match[1]}#${match[2]}`);
  }
  for (const match of text.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)\b/g)) {
    keys.add(`${match[1]}#${match[2]}`);
  }
  return keys;
}

function lowValueReason(issue) {
  if (issue.isLocked) return 'locked';
  const repository = String(issue?.repository?.nameWithOwner || '').toLowerCase();
  if (/bount(y|ies)/.test(repository)) return 'bounty repository';
  const labels = (issue.labels || []).map((label) => String(label.name || '').toLowerCase());
  const blockedLabels = /(^|\b)(bount(y|ies)|bug bounty|community|documentation|onboarding|translation|dependencies|security|hacktoberfest)(\b|$)/;
  if (labels.some((label) => blockedLabels.test(label))) return 'excluded label';
  const title = String(issue.title || '').toLowerCase();
  if (/\b(translate|translation|docs?|documentation|readme|typo|bount(y|ies))\b/.test(title) ||
      /\b(campaign|call for contributors|onboard|review an open pr|write (a|the) (blog|review)|compare .+ project|stars? drive|launch checklist|create (a )?(logo|image|pixel art)|add yourself)\b/.test(title)) {
    return 'excluded task type';
  }
  return null;
}

export function dedupeAndFilter(issues, seen = new Set(), maxPerRepo = 3, openNorthsetRepos = new Set()) {
  const candidates = [];
  const unique = new Set();
  const perRepo = new Map();
  let skippedDuplicate = 0;
  let skippedSeen = 0;
  let skippedLowValue = 0;
  let skippedConcentration = 0;
  let skippedNorthsetOpen = 0;

  for (const issue of issues) {
    const key = candidateKey(issue);
    if (unique.has(key)) { skippedDuplicate += 1; continue; }
    unique.add(key);
    if (seen.has(key)) { skippedSeen += 1; continue; }
    if (lowValueReason(issue)) { skippedLowValue += 1; continue; }
    const repo = issue.repository.nameWithOwner;
    if (openNorthsetRepos.has(repo.toLowerCase())) { skippedNorthsetOpen += 1; continue; }
    if ((perRepo.get(repo) || 0) >= maxPerRepo) { skippedConcentration += 1; continue; }
    perRepo.set(repo, (perRepo.get(repo) || 0) + 1);
    candidates.push(issue);
  }
  return {candidates, skippedDuplicate, skippedSeen, skippedLowValue, skippedConcentration, skippedNorthsetOpen};
}

function run(command, args, {env = process.env, timeoutMs = 11 * 60 * 1000} = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({code: 127, stdout, stderr: `${stderr}\n${error.message}`});
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({code: code ?? 1, stdout, stderr});
    });
  });
}

async function searchIssues({label, term, repo}, limit, starsMin) {
  const starQuery = `stars:${starsMin}..*`;
  const query = repo ? `repo:${repo}` : term ? `"${term}" ${starQuery}` : starQuery;
  const args = ['search', 'issues', query, '--state', 'open', '--no-assignee', '--archived=false'];
  if (label) args.push('--label', label);
  args.push('--sort', 'updated', '--order', 'desc', '--limit', String(limit),
    '--json', 'number,title,url,repository,labels,assignees,updatedAt,isLocked,commentsCount');
  const result = await run('gh', args, {timeoutMs: 2 * 60 * 1000});
  const description = repo ? `repository ${repo}` : label ? `label ${label}` : `term ${term}`;
  if (result.code !== 0) throw new Error(`GitHub search failed for ${description}: ${(result.stderr || result.stdout).trim()}`);
  try { return JSON.parse(result.stdout); }
  catch (error) { throw new Error(`GitHub search returned invalid JSON: ${error.message}`); }
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

function exclusionFiles() {
  if (process.env.OSS_FIND_EXCLUDE_FILES !== undefined) {
    return process.env.OSS_FIND_EXCLUDE_FILES.split(path.delimiter).filter(Boolean);
  }
  return defaultExclusionFiles();
}

async function loadSeen(historyFile) {
  const seen = new Set();
  for (const file of exclusionFiles()) {
    const contents = await readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    for (const key of extractIssueKeys(contents)) seen.add(key);
  }
  const history = await readFile(historyFile, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  for (const line of history.split('\n').filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      if (typeof record.candidate === 'string') seen.add(record.candidate);
    } catch {
      throw new Error(`Invalid JSON line in history file: ${historyFile}`);
    }
  }
  return seen;
}

async function reviewCandidate(issue, reviewer) {
  const key = candidateKey(issue);
  const result = await run(process.execPath, [reviewer, key]);
  if (![0, 2].includes(result.code)) {
    throw new Error((result.stderr || result.stdout).trim() || `reviewer exited ${result.code}`);
  }
  let review;
  try { review = JSON.parse(result.stdout); }
  catch (error) { throw new Error(`reviewer returned invalid JSON: ${error.message}`); }
  if (!['ACCEPT', 'REJECT'].includes(review.verdict)) throw new Error('reviewer returned no ACCEPT/REJECT verdict');
  return review;
}

function positiveEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  return parseCount(process.env[name]);
}

function outputPath() {
  if (process.env.OSS_FIND_OUTPUT) return path.resolve(process.env.OSS_FIND_OUTPUT);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return path.join(SCRIPT_DIR, 'runs', `candidate-batch-${stamp}.json`);
}

async function main() {
  if (['-h', '--help'].includes(process.argv[2])) {
    console.error('usage: node find-candidates.mjs N [--profile node]');
    process.exit(0);
  }
  const requested = parseCount(process.argv[2]);
  let profile = 'node';
  for (let index = 3; index < process.argv.length; index += 1) {
    if (process.argv[index] !== '--profile' || process.argv[index + 1] === undefined) throw new Error('usage: node find-candidates.mjs N [--profile node]');
    profile = process.argv[++index];
  }
  profile = parseProfile(profile);
  const concurrency = positiveEnv('OSS_FIND_CONCURRENCY', 4);
  const historyFile = path.resolve(process.env.OSS_FIND_HISTORY || DEFAULT_HISTORY);
  const reviewer = path.resolve(process.env.OSS_FIND_REVIEW_SCRIPT || DEFAULT_REVIEWER);
  const reportFile = outputPath();
  const searchLabels = parseSearchLabels(process.env.OSS_FIND_LABELS);
  const searchTerms = parseSearchTerms(process.env.OSS_FIND_TERMS);
  const searchRepos = parseSearchRepos(process.env.OSS_FIND_REPOS);
  const starsMin = parseStarsMin(process.env.OSS_FIND_STARS_MIN);
  const defaultSearchLimit = Math.min(1000, Math.max(100, requested * 20));
  const searchLimit = parseSearchLimit(process.env.OSS_FIND_SEARCH_LIMIT, defaultSearchLimit);
  const seen = await loadSeen(historyFile);

  console.error(`find: searching GitHub (excluding ${seen.size} previously reviewed candidates)…`);
  const searches = searchRepos.length
    ? searchRepos.map((repo) => ({repo}))
    : searchTerms.length
      ? searchTerms.map((term) => ({term}))
      : searchLabels.map((label) => ({label}));
  const searchResults = (await Promise.all(
    searches.map((search) => searchIssues(search, searchLimit, starsMin)),
  )).flat();
  const authored = await run('gh', ['search', 'prs', '--author', 'AysajanE', '--state', 'open', '--limit', '1000',
    '--json', 'repository,url']);
  if (authored.code !== 0) throw new Error(`cannot check Northset open-PR repository cap: ${(authored.stderr || authored.stdout).trim()}`);
  const openNorthsetRepos = new Set(JSON.parse(authored.stdout).map((pr) => pr.repository.nameWithOwner.toLowerCase()));
  const filtered = dedupeAndFilter(searchResults, seen, 3, openNorthsetRepos);
  const maxReviews = Math.min(filtered.candidates.length,
    positiveEnv('OSS_FIND_MAX_REVIEWS', Math.max(20, requested * 20)));
  const queue = filtered.candidates.slice(0, maxReviews);
  const candidates = [];
  const failures = [];
  let cursor = 0;
  let reviewed = 0;
  const historyRecords = [];

  await mkdir(path.dirname(historyFile), {recursive: true});
  async function worker() {
    while (candidates.length < requested) {
      const index = cursor++;
      if (index >= queue.length) return;
      const issue = queue[index];
      const key = candidateKey(issue);
      console.error(`find: review ${index + 1}/${queue.length} ${key}`);
      try {
        const review = await reviewCandidate(issue, reviewer);
        reviewed += 1;
        const selected = review.verdict === 'ACCEPT' && review.executor_profile === profile && review.tier === 'A' && candidates.length < requested;
        if (selected) {
          candidates.push({...review, discovery: {
            title: issue.title,
            labels: (issue.labels || []).map((label) => label.name),
            updated_at: issue.updatedAt,
          }});
          console.error(`find: ACCEPT ${key} (${candidates.length}/${requested})`);
        } else {
          console.error(`find: ${review.verdict} ${key}`);
        }
        // Do not remember a parallel overflow ACCEPT; it can lead the next batch.
        if (review.verdict === 'REJECT' || selected || review.executor_profile !== profile || review.tier !== 'A') {
          historyRecords.push(JSON.stringify({
            reviewed_at: new Date().toISOString(), candidate: key, issue_url: issue.url,
            verdict: selected ? 'ACCEPT' : 'REJECT',
          }));
        }
      } catch (error) {
        failures.push({candidate: key, error: error.message});
        console.error(`find: ERROR ${key}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({length: Math.min(concurrency, queue.length || 1)}, () => worker()));
  if (historyRecords.length) await appendFile(historyFile, `${historyRecords.join('\n')}\n`);

  const report = {
    requested,
    found: candidates.length,
    complete: candidates.length === requested,
    generated_at: new Date().toISOString(),
    search_labels: searchLabels,
    search_terms: searchTerms,
    search_repos: searchRepos,
    stars_min: starsMin,
    search_limit: searchLimit,
    profile,
    output_file: reportFile,
    history_file: historyFile,
    discovered: searchResults.length,
    eligible_for_review: filtered.candidates.length,
    reviewed,
    review_failures: failures,
    skipped: {
      previously_seen: filtered.skippedSeen,
      duplicate: filtered.skippedDuplicate,
      low_value: filtered.skippedLowValue,
      repository_concentration: filtered.skippedConcentration,
      northset_open_repository: filtered.skippedNorthsetOpen,
    },
    candidates,
  };
  await mkdir(path.dirname(reportFile), {recursive: true});
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.complete ? 0 : 2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    console.error(`find error: ${error.message}`);
    process.exit(1);
  });
}
