#!/usr/bin/env node

import * as fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const FIRST_TIME_ASSOCIATIONS = new Set(['FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER']);
const CI_WAITING = new Set(['EXPECTED', 'PENDING']);
const CI_FAILURE = new Set(['ERROR', 'FAILURE']);
const OFFER_STAGES = new Set([
  'identified', 'offer_drafted', 'offer_sent', 'yes', 'run_delivered',
  'five_questions_recorded', 'second_invocation', 'declined', 'no_response',
]);

export function appendDemandRecord(filePath, object) {
  fs.appendFileSync(filePath, `${JSON.stringify(object)}\n`);
}

function timestamp(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must be a valid timestamp');
  return date.toISOString();
}

function ageMilliseconds(pr, observedAt) {
  const created = Date.parse(pr.created_at ?? '');
  return Number.isFinite(created) ? Math.max(0, observedAt - created) : 0;
}

function ciPain(pr) {
  const state = String(pr.ci_state ?? '').toUpperCase();
  if (CI_FAILURE.has(state)) return 2;
  if (CI_WAITING.has(state)) return 1;
  return 0;
}

function awaitingFirstTimerCi(pr) {
  const state = String(pr.ci_state ?? '').toUpperCase();
  return pr.is_cross_repository === true && FIRST_TIME_ASSOCIATIONS.has(pr.author_association) &&
    (!state || CI_WAITING.has(state));
}

function painOrder(left, right, observedAt) {
  const tuples = [left, right].map((pr) => [
    awaitingFirstTimerCi(pr) ? 1 : 0,
    ageMilliseconds(pr, observedAt),
    ciPain(pr),
    Number(pr.reviewer_count ?? 0) === 0 ? 1 : 0,
  ]);
  for (let index = 0; index < tuples[0].length; index += 1) {
    if (tuples[0][index] !== tuples[1][index]) return tuples[1][index] - tuples[0][index];
  }
  return Number(left.number) - Number(right.number);
}

function painReason(pr, observedAt) {
  const reasons = [];
  if (awaitingFirstTimerCi(pr)) {
    reasons.push('fork PR from a first-time contributor appears stuck before CI can start');
  }
  const ageDays = Math.floor(ageMilliseconds(pr, observedAt) / 86_400_000);
  if (ageDays > 0) reasons.push(`open for ${ageDays} day${ageDays === 1 ? '' : 's'}`);
  const state = String(pr.ci_state ?? '').toUpperCase();
  if (CI_FAILURE.has(state)) reasons.push('CI is failing');
  else if (CI_WAITING.has(state) && !awaitingFirstTimerCi(pr)) reasons.push('CI is pending');
  if (Number(pr.reviewer_count ?? 0) === 0) reasons.push('no review has been submitted');
  return reasons.join('; ') || 'open PR may benefit from an independent verification pass';
}

function dossierPr(pr, observedAt) {
  return {
    number: Number(pr.number),
    title: pr.title,
    url: pr.url,
    'why-it-hurts': painReason(pr, observedAt),
  };
}

function renderSummary(dossiers) {
  const named = dossiers.filter((item) => item.best_pr);
  const lines = [`Offer dossiers: ${dossiers.length} warm repos; ${named.length} named PRs.`];
  for (const dossier of named) {
    lines.push(`${dossier.repo} (${dossier.maintainer}): #${dossier.best_pr.number} ${dossier.best_pr.title}`);
    lines.push(`  ${dossier.best_pr['why-it-hurts']}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function buildOfferDossier({db, github, safety, now = () => new Date(), limit = 30}) {
  if (typeof db?.listWarmRepositories !== 'function') throw new TypeError('db.listWarmRepositories is required');
  if (typeof github?.findOpenPullRequests !== 'function') {
    throw new TypeError('github.findOpenPullRequests is required');
  }
  if (typeof safety?.request !== 'function') throw new TypeError('safety.request is required');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('limit must be an integer from 1 through 100');
  }
  if (typeof db.database !== 'string' || !db.database) throw new TypeError('db.database is required');

  const generatedAt = timestamp(now);
  const observedAt = Date.parse(generatedAt);
  const demandDirectory = path.resolve(path.dirname(db.database), '..', 'demand');
  const dossierPath = path.join(demandDirectory, 'offer_dossiers.json');
  const icpPath = path.join(demandDirectory, 'icp_log.jsonl');
  const funnelPath = path.join(demandDirectory, 'offer_funnel.jsonl');
  fs.mkdirSync(demandDirectory, {recursive: true});

  const warmRepositories = await db.listWarmRepositories();
  const dossiers = [];
  for (const warm of warmRepositories) {
    const repo = warm.repository;
    const response = await safety.request({
      kind: 'read',
      priority: 'discovery_top_up',
      operation: 'find_open_pull_requests',
      repository: repo,
      execute: () => github.findOpenPullRequests(repo, {limit}),
    });
    const maintainer = warm.maintainer_login ?? response?.owner_login ?? repo.split('/')[0];
    const orgType = response?.owner_type === 'Organization' ? 'org'
      : response?.owner_type === 'User' ? 'user' : 'unknown';
    appendDemandRecord(icpPath, {
      ts: generatedAt,
      source: 'dossier',
      actor_login: maintainer,
      actor_role: 'maintainer',
      org_type: orgType,
      repo,
      money_relationship: 'none',
      note: `Merged Northset publication marks ${repo} as a warm relationship.`,
      mission_id: warm.mission_id ?? '',
    });
    const ranked = [...(response?.pull_requests ?? [])].sort((left, right) =>
      painOrder(left, right, observedAt));
    const best = ranked[0] ? dossierPr(ranked[0], observedAt) : null;
    const dossier = {
      repo,
      maintainer,
      best_pr: best,
      runners_up: ranked.slice(1).map((pr) => dossierPr(pr, observedAt)),
    };
    dossiers.push(dossier);
    if (best) {
      appendDemandRecord(funnelPath, {
        ts: generatedAt,
        offer_id: `OF-${repo}-${best.number}`,
        repo,
        pr_number: best.number,
        offer_type: 'foreign_pr_verify',
        stage: 'identified',
        maintainer_login: maintainer,
        note: best['why-it-hurts'],
      });
    }
  }

  const output = {generated_at: generatedAt, dossiers};
  fs.writeFileSync(dossierPath, `${JSON.stringify(output, null, 2)}\n`);
  return {...output, summary: renderSummary(dossiers), path: dossierPath};
}

export function advanceOfferStage(filePath, {offer_id: offerId, stage, note = '', now = () => new Date()}) {
  if (!OFFER_STAGES.has(stage)) throw new TypeError(`unsupported offer stage ${JSON.stringify(stage)}`);
  const records = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line));
  const current = records.findLast((record) => record.offer_id === offerId);
  if (!current) throw new Error(`offer ${offerId} was not found`);
  const next = {
    ts: timestamp(now),
    offer_id: current.offer_id,
    repo: current.repo,
    pr_number: current.pr_number,
    offer_type: current.offer_type,
    stage,
    maintainer_login: current.maintainer_login,
    note,
  };
  appendDemandRecord(filePath, next);
  return next;
}

function cliValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith('--')) {
    throw new Error(`${flag} is required`);
  }
  return argv[index + 1];
}

const SCRIPT_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] !== 'advance') throw new Error('usage: offer-dossier.mjs advance --offer-id ID --stage STAGE [--note NOTE]');
    const defaultPath = path.resolve(path.dirname(SCRIPT_FILE), '..', 'runs', 'demand', 'offer_funnel.jsonl');
    const record = advanceOfferStage(argv.includes('--path') ? cliValue(argv, '--path') : defaultPath, {
      offer_id: cliValue(argv, '--offer-id'),
      stage: cliValue(argv, '--stage'),
      note: argv.includes('--note') ? cliValue(argv, '--note') : '',
    });
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
