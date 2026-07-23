#!/usr/bin/env node

import * as fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {draftOfferMessage} from './offer-messages.mjs';
import {reasonCodeFromFollowUp, summarizeFollowUp} from './reconciler.mjs';

const FIRST_TIME_ASSOCIATIONS = new Set(['FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER']);
const CI_WAITING = new Set(['EXPECTED', 'PENDING']);
const CI_FAILURE = new Set(['ERROR', 'FAILURE']);
const OFFER_STAGES = new Set([
  'identified', 'offer_drafted', 'offer_sent', 'yes', 'run_delivered',
  'five_questions_recorded', 'second_invocation', 'declined', 'no_response',
]);
const OFFER_TRANSITIONS = new Map([
  ['identified', new Set(['offer_drafted'])],
  ['offer_drafted', new Set(['offer_sent'])],
  ['offer_sent', new Set(['yes', 'declined', 'no_response'])],
  ['yes', new Set(['run_delivered', 'declined'])],
  ['run_delivered', new Set(['five_questions_recorded'])],
  ['five_questions_recorded', new Set(['second_invocation'])],
]);
const OFFER_TYPES = new Set(['self_authored_verify', 'foreign_pr_verify', 'issue_choice']);
export const PUBLIC_LEDGER_URL = 'https://northset-oss.github.io/verification-pilot/ledger.json';

export function appendDemandRecord(filePath, object) {
  fs.appendFileSync(filePath, `${JSON.stringify(object)}\n`);
}

function readDemandRecords(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function appendDemandRecordOnce(filePath, object, identity) {
  const key = identity(object);
  if (readDemandRecords(filePath).some((record) => identity(record) === key)) return false;
  appendDemandRecord(filePath, object);
  return true;
}

function githubRepository(value) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.hostname !== 'github.com' || parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
}

function githubPullRequestNumber(value, repository) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.hostname !== 'github.com' || parts.length !== 4 || parts[2] !== 'pull' ||
        `${parts[0]}/${parts[1]}`.toLowerCase() !== repository.toLowerCase()) return null;
    const number = Number(parts[3]);
    return Number.isInteger(number) && number > 0 ? number : null;
  } catch {
    return null;
  }
}

export function relationshipsFromLedger(ledger) {
  if (!ledger || !Array.isArray(ledger.receipts)) throw new Error('public ledger has no receipts array');
  const warm = new Map();
  const rejections = new Map();
  for (const receipt of ledger.receipts) {
    const repository = githubRepository(receipt?.links?.target_repo);
    const prNumber = repository === null ? null
      : githubPullRequestNumber(receipt?.links?.publication_pr ?? receipt?.upstream_outcome?.link, repository);
    if (repository === null || prNumber === null) continue;
    const record = {
      repository,
      owner_login: repository.split('/')[0],
      relationship_pr_number: prNumber,
      mission_id: receipt.receipt_id,
      last_pr_at: receipt?.upstream_outcome?.decided_at ?? receipt?.timestamps?.finished_at ?? null,
    };
    const status = receipt?.upstream_outcome?.status;
    if (status === 'merged') {
      const key = repository.toLowerCase();
      const previous = warm.get(key);
      if (!previous || record.relationship_pr_number > previous.relationship_pr_number) warm.set(key, record);
    } else if (['closed_unmerged', 'changes_requested'].includes(status)) {
      rejections.set(`${repository.toLowerCase()}#${prNumber}`, {
        ...record,
        decision_url: receipt?.upstream_outcome?.attribution === 'Linked maintainer review'
          ? receipt.upstream_outcome.link
          : null,
      });
    }
  }
  return {warm: [...warm.values()], rejections: [...rejections.values()]};
}

export async function fetchPublicLedger({fetchImpl = globalThis.fetch, url = PUBLIC_LEDGER_URL} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required to read the public ledger');
  const response = await fetchImpl(url, {signal: AbortSignal.timeout(20_000)});
  if (!response?.ok) throw new Error(`public ledger request failed with HTTP ${response?.status ?? 'unknown'}`);
  return response.json();
}

function mergeWarmRepositories(databaseRows, ledgerRows) {
  const merged = new Map();
  for (const row of [...databaseRows, ...ledgerRows]) {
    if (typeof row?.repository !== 'string' || !row.repository.includes('/')) continue;
    const relationshipPrNumber = Number(row.relationship_pr_number ?? row.pr_number);
    if (!Number.isInteger(relationshipPrNumber) || relationshipPrNumber < 1) continue;
    const key = row.repository.toLowerCase();
    const previous = merged.get(key);
    if (previous && previous.relationship_pr_number > relationshipPrNumber) continue;
    merged.set(key, {
      ...(previous ?? {}),
      ...row,
      owner_login: row.owner_login ?? row.maintainer_login ?? previous?.owner_login ?? row.repository.split('/')[0],
      relationship_pr_number: relationshipPrNumber,
    });
  }
  return [...merged.values()].sort((left, right) => left.repository.toLowerCase()
    .localeCompare(right.repository.toLowerCase()));
}

function summarizeRejectionFollowUp(rawFollowUp, decisionUrl) {
  const followUp = summarizeFollowUp(rawFollowUp);
  if (typeof decisionUrl !== 'string' || decisionUrl.length === 0) return followUp;
  const linkedDecision = [
    ...(rawFollowUp?.comments ?? []),
    ...(rawFollowUp?.reviews ?? []),
    ...(rawFollowUp?.threads ?? []).flatMap((thread) => thread.comments ?? []),
  ].find((event) => event?.url === decisionUrl);
  if (linkedDecision === undefined) return followUp;
  const linkedAt = linkedDecision.submitted_at ?? linkedDecision.updated_at ??
    linkedDecision.created_at ?? null;
  return {
    ...followUp,
    linked_decision_events: [linkedDecision],
    latest_maintainer_activity_at: [followUp.latest_maintainer_activity_at, linkedAt]
      .filter(Boolean).sort().at(-1) ?? null,
  };
}

export function loadDossierRelationships(filePath) {
  if (!fs.existsSync(filePath)) return {repositories: new Set(), owners: new Set()};
  try {
    const dossiers = JSON.parse(fs.readFileSync(filePath, 'utf8')).dossiers;
    if (!Array.isArray(dossiers)) return {repositories: new Set(), owners: new Set()};
    return {
      repositories: new Set(dossiers.map((item) => String(item.repo).toLowerCase())),
      owners: new Set(dossiers.map((item) => String(item.owner ?? item.repo?.split('/')[0] ?? '').toLowerCase())
        .filter(Boolean)),
    };
  } catch {
    return {repositories: new Set(), owners: new Set()};
  }
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
    lines.push(`${dossier.repo} (${dossier.maintainer ?? dossier.owner ?? 'maintainer unknown'}): #${dossier.best_pr.number} ${dossier.best_pr.title}`);
    lines.push(`  ${dossier.best_pr['why-it-hurts']}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function buildOfferDossier({
  db,
  github,
  safety,
  now = () => new Date(),
  limit = 30,
  loadLedger = () => fetchPublicLedger(),
}) {
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

  const ledger = await safety.request({
    kind: 'read',
    priority: 'discovery_top_up',
    operation: 'fetch_public_ledger',
    repository: 'northset-oss/verification-pilot',
    execute: loadLedger,
  });
  const ledgerRelationships = relationshipsFromLedger(ledger);
  const warmRepositories = mergeWarmRepositories(
    await db.listWarmRepositories(), ledgerRelationships.warm,
  );
  const verificationProspects = [];
  if (typeof db.recordVerificationProspect === 'function' &&
      typeof github.getPullRequestFollowUp === 'function') {
    for (const rejected of ledgerRelationships.rejections) {
      const rawFollowUp = await safety.request({
        kind: 'read',
        priority: 'discovery_top_up',
        operation: 'harvest_rejected_pull_request',
        repository: rejected.repository,
        execute: () => github.getPullRequestFollowUp({
          repository: rejected.repository,
          number: rejected.relationship_pr_number,
        }),
      });
      const followUp = summarizeRejectionFollowUp(rawFollowUp, rejected.decision_url);
      const reasonCode = reasonCodeFromFollowUp(followUp);
      if (!['ai_policy_concern', 'ai_rejection', 'not_wanted'].includes(reasonCode)) continue;
      verificationProspects.push(await db.recordVerificationProspect({
        repository: rejected.repository,
        owner: rejected.owner_login,
        reasonCode,
        missionId: rejected.mission_id,
        observedAt: followUp.latest_maintainer_activity_at ?? generatedAt,
      }));
    }
  }
  const dossiers = [];
  for (const warm of warmRepositories) {
    const repo = warm.repository;
    const response = await safety.request({
      kind: 'read',
      priority: 'discovery_top_up',
      operation: 'find_open_pull_requests',
      repository: repo,
      execute: () => github.findOpenPullRequests(repo, {
        limit,
        relationshipPrNumber: warm.relationship_pr_number,
      }),
    });
    const owner = response?.owner_login ?? warm.owner_login ?? repo.split('/')[0];
    const maintainer = response?.relationship_maintainer_login ??
      (response?.owner_type === 'User' ? owner : null);
    const orgType = response?.owner_type === 'Organization' ? 'org'
      : response?.owner_type === 'User' ? 'user' : 'unknown';
    appendDemandRecordOnce(icpPath, {
      ts: generatedAt,
      source: 'dossier',
      actor_login: maintainer ?? owner,
      actor_role: maintainer !== null || orgType === 'user' ? 'maintainer' : 'unknown',
      org_type: orgType,
      repo,
      money_relationship: 'none',
      note: `Merged Northset publication marks ${repo} as a warm relationship.`,
      mission_id: warm.mission_id ?? '',
    }, (record) => [record.source, record.repo, record.actor_login, record.mission_id].join('\0'));
    const ranked = [...(response?.pull_requests ?? [])].sort((left, right) =>
      painOrder(left, right, observedAt));
    const best = ranked[0] ? dossierPr(ranked[0], observedAt) : null;
    const draftMessage = best ? draftOfferMessage('post_merge', {
      prNumber: best.number,
      prAgeDays: Math.floor(ageMilliseconds(ranked[0], observedAt) / 86_400_000),
      firstTimeContributor: FIRST_TIME_ASSOCIATIONS.has(ranked[0].author_association),
      crossRepository: ranked[0].is_cross_repository === true,
      ciState: ranked[0].ci_state,
      hasReview: Number(ranked[0].reviewer_count ?? 0) > 0,
    }) : null;
    const dossier = {
      repo,
      owner,
      owner_type: orgType,
      maintainer,
      relationship_pr_number: warm.relationship_pr_number,
      best_pr: best,
      draft_message: draftMessage,
      runners_up: ranked.slice(1).map((pr) => dossierPr(pr, observedAt)),
    };
    dossiers.push(dossier);
    if (best) {
      const identified = {
        ts: generatedAt,
        offer_id: `OF-${repo}-${best.number}`,
        repo,
        pr_number: best.number,
        offer_type: 'foreign_pr_verify',
        stage: 'identified',
        maintainer_login: maintainer ?? '',
        note: best['why-it-hurts'],
      };
      appendDemandRecordOnce(
        funnelPath, identified, (record) => `${record.offer_id}\0${record.stage}`,
      );
      const current = readDemandRecords(funnelPath)
        .findLast((record) => record.offer_id === identified.offer_id);
      if (current?.stage === 'identified') {
        appendDemandRecordOnce(funnelPath, {
          ...identified,
          stage: 'offer_drafted',
          note: 'Dossier draft generated for operator review.',
        }, (record) => `${record.offer_id}\0${record.stage}`);
      }
    }
  }

  const output = {generated_at: generatedAt, dossiers, verification_prospects: verificationProspects};
  fs.writeFileSync(dossierPath, `${JSON.stringify(output, null, 2)}\n`);
  return {...output, summary: renderSummary(dossiers), path: dossierPath};
}

export function advanceOfferStage(filePath, {offer_id: offerId, stage, note = '', now = () => new Date()}) {
  if (!OFFER_STAGES.has(stage)) throw new TypeError(`unsupported offer stage ${JSON.stringify(stage)}`);
  const records = readDemandRecords(filePath);
  const current = records.findLast((record) => record.offer_id === offerId);
  if (!current) throw new Error(`offer ${offerId} was not found`);
  if (!OFFER_TRANSITIONS.get(current.stage)?.has(stage)) {
    throw new Error(`invalid offer stage transition for ${offerId}: ${current.stage} -> ${stage}`);
  }
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

export function identifyOffer(filePath, {
  repo,
  pr_number: prNumber,
  offer_type: offerType,
  maintainer_login: maintainerLogin = '',
  note = '',
  now = () => new Date(),
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo ?? ''))) {
    throw new TypeError('repo must be owner/name');
  }
  if (!OFFER_TYPES.has(offerType)) throw new TypeError(`unsupported offer type ${JSON.stringify(offerType)}`);
  if (!Number.isInteger(prNumber) || prNumber < 0 || (offerType !== 'issue_choice' && prNumber === 0)) {
    throw new TypeError('pr_number must be positive, or zero only for issue_choice');
  }
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const record = {
    ts: timestamp(now),
    offer_id: `OF-${repo}-${prNumber === 0 ? 'issue-choice' : prNumber}`,
    repo,
    pr_number: prNumber,
    offer_type: offerType,
    stage: 'identified',
    maintainer_login: String(maintainerLogin),
    note: String(note),
  };
  appendDemandRecordOnce(filePath, record, (item) => `${item.offer_id}\0${item.stage}`);
  return record;
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
    const command = argv.shift();
    const defaultPath = path.resolve(path.dirname(SCRIPT_FILE), '..', 'runs', 'demand', 'offer_funnel.jsonl');
    const filePath = argv.includes('--path') ? cliValue(argv, '--path') : defaultPath;
    let record;
    if (command === 'advance') {
      record = advanceOfferStage(filePath, {
        offer_id: cliValue(argv, '--offer-id'),
        stage: cliValue(argv, '--stage'),
        note: argv.includes('--note') ? cliValue(argv, '--note') : '',
      });
    } else if (command === 'identify') {
      record = identifyOffer(filePath, {
        repo: cliValue(argv, '--repo'),
        pr_number: Number(cliValue(argv, '--pr-number')),
        offer_type: cliValue(argv, '--offer-type'),
        maintainer_login: argv.includes('--maintainer') ? cliValue(argv, '--maintainer') : '',
        note: argv.includes('--note') ? cliValue(argv, '--note') : '',
      });
    } else {
      throw new Error('usage: offer-dossier.mjs identify --repo owner/name --pr-number N --offer-type TYPE [--maintainer LOGIN] [--note NOTE] | offer-dossier.mjs advance --offer-id ID --stage STAGE [--note NOTE]');
    }
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
