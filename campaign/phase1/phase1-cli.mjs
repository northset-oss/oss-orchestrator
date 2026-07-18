#!/usr/bin/env node

import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {canonical, directoryDigest, manifestDigest} from '../../core.mjs';
import {buildSpecDraft} from '../../review-issue.mjs';
import {verifyReviewedBoard, verifyReviewSet} from '../phase0/approvals.mjs';
import {reviewableManifestDigest} from '../phase0/integrity.mjs';
import {reviewRequirement} from '../phase0/review-policy.mjs';
import {loadReviewerRoster} from '../phase0/roster.mjs';
import {addPilotEvent, createPilotLedger, pilotSnapshot} from './pilot-ledger.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const ACCEPT_STATES = new Set(['ACCEPTED', 'CACHED_ACCEPT']);
const PREPARE_STATES = new Set([
  'READY', 'STALE', 'NOCHANGE', 'FAILED_BUDGET', 'FAILED_AUTHOR',
  'FAILED_ORACLE', 'FAILED_INFRA_TERMINAL',
]);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function nonblank(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function canonicalCandidate(value) {
  const candidate = nonblank(value, 'candidate');
  if (!/^[^/\s]+\/[^/#\s]+#[1-9][0-9]*$/.test(candidate)) throw new Error('candidate must have the form owner/repo#N');
  return candidate.toLowerCase();
}

function jsonArray(value, key, label) {
  const records = Array.isArray(value) ? value : value?.[key];
  if (!Array.isArray(records)) throw new Error(`${label} must be an array or contain ${key}[]`);
  return records;
}

async function readJson(file, label) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  }
}

async function atomicWriteJson(file, value) {
  const absolute = path.resolve(file);
  await mkdir(path.dirname(absolute), {recursive: true, mode: 0o700});
  const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
    await rename(temporary, absolute);
  } finally {
    await rm(temporary, {force: true});
  }
}

export async function draftFromQualification({
  qualificationFile, queueFile, candidate, testPath, baseFailureContains, draftOut, policyOut,
}, {
  now = () => new Date(), buildSpecDraftImpl = buildSpecDraft,
} = {}) {
  const candidateKey = canonicalCandidate(candidate);
  const normalizedTestPath = nonblank(testPath, 'test-path');
  if (path.posix.isAbsolute(normalizedTestPath) || normalizedTestPath !== path.posix.normalize(normalizedTestPath) ||
      normalizedTestPath.split('/').includes('..')) {
    throw new Error('test-path must be a normalized relative path');
  }
  const failureMarker = nonblank(baseFailureContains, 'base-failure-contains');
  for (const [value, label] of [[qualificationFile, 'qualification'], [queueFile, 'queue'],
    [draftOut, 'draft-out'], [policyOut, 'policy-out']]) nonblank(value, label);
  if (path.resolve(draftOut) === path.resolve(policyOut)) throw new Error('draft-out and policy-out must be different files');

  const [qualificationDocument, queueDocument] = await Promise.all([
    readJson(qualificationFile, 'qualification file'), readJson(queueFile, 'queue file'),
  ]);
  const qualificationRecords = jsonArray(qualificationDocument, 'results', 'qualification file');
  const accepted = qualificationRecords.filter((record) => (
    canonicalCandidate(record?.candidate ?? '') === candidateKey && ACCEPT_STATES.has(record?.state)
  ));
  if (accepted.length !== 1) throw new Error('candidate must have exactly one current ACCEPTED or CACHED_ACCEPT qualification');
  const selected = accepted[0];
  const evidenceKey = nonblank(selected.evidence_key, 'accepted qualification evidence_key');
  if (!/^sha256:[0-9a-f]{64}$/i.test(evidenceKey)) throw new Error('accepted qualification evidence_key must be a sha256 digest');
  const review = object(selected.review, 'accepted qualification review');
  if (review.verdict !== 'ACCEPT' || canonicalCandidate(review.candidate) !== candidateKey) {
    throw new Error('accepted qualification review must be an ACCEPT for the requested candidate');
  }
  const expiry = Date.parse(review.qualification_expires_at ?? '');
  const currentTime = now();
  if (!(currentTime instanceof Date) || !Number.isFinite(currentTime.getTime())) throw new Error('current time is invalid');
  if (!Number.isFinite(expiry) || expiry <= currentTime.getTime()) throw new Error('accepted qualification has expired');

  const queueRecords = jsonArray(queueDocument, 'queue', 'queue file');
  const queueMatches = queueRecords.filter((record) => (
    canonicalCandidate(record?.candidate ?? '') === candidateKey && record?.evidence_key === evidenceKey
  ));
  if (queueMatches.length !== 1) throw new Error('candidate must have exactly one matching queue policy for the accepted evidence key');
  const queueRecord = queueMatches[0];
  const policy = queueRecord.repository_profile?.repo_policy ?? queueRecord.preflight?.repo_policy_snapshot;
  object(policy, 'matching queue policy snapshot');
  if (Object.keys(policy).length === 0) throw new Error('matching queue policy snapshot must not be empty');

  const specDraft = buildSpecDraftImpl(review, {
    testPaths: [normalizedTestPath], baseFailureContains: failureMarker,
  });
  const wrapper = {review, spec_draft: specDraft};
  await atomicWriteJson(draftOut, wrapper);
  await atomicWriteJson(policyOut, policy);
  return {candidate: review.candidate, evidence_key: evidenceKey, draft_out: path.resolve(draftOut),
    policy_out: path.resolve(policyOut), wrapper, policy};
}

function stablePrepareEventId(attempt) {
  const identity = JSON.stringify([
    'northset-phase1-dry-prepare-v1', attempt.mission_id, attempt.task_id, attempt.attempt_sequence,
  ]);
  return `dry-prepare:sha256:${createHash('sha256').update(identity).digest('hex')}`;
}

function stableShippedEventId(receiptSubjectId) {
  return `shipped:${receiptSubjectId}`;
}

async function loadPilotLedger(file) {
  let parsed;
  try { parsed = await readJson(file, 'pilot ledger'); }
  catch (error) {
    if (error.code === 'ENOENT') return createPilotLedger();
    throw error;
  }
  if (parsed?.schema_version !== 1 || !Array.isArray(parsed.events)) throw new Error('pilot ledger is invalid');
  let validated = createPilotLedger();
  for (const event of parsed.events) validated = addPilotEvent(validated, event);
  return validated;
}

async function verifyPrepareReviewEvidence({manifest, manifestFile, reviewedBoardFile, reviewerRosterFile}) {
  const reviewRecordsFile = path.join(path.dirname(path.resolve(manifestFile)), 'review-records.json');
  const [reviewRecords, reviewedBoard, roster] = await Promise.all([
    readJson(reviewRecordsFile, 'signed review records'),
    readJson(reviewedBoardFile, 'reviewed board'),
    loadReviewerRoster(reviewerRosterFile),
  ]);
  if (!Array.isArray(reviewRecords) || !reviewRecords.length) throw new Error('signed review records are required');
  const riskTiers = new Set(reviewRecords.map((record) => record?.risk_tier));
  if (riskTiers.size !== 1) throw new Error('signed review risk tiers must agree');
  const riskTier = [...riskTiers][0];
  const expectedRisk = (manifest.risk_flags ?? []).length ? 'AMBER' : 'GREEN';
  if (riskTier !== expectedRisk) throw new Error('signed review risk tier does not match the prepared risk flags');
  const requirement = reviewRequirement({
    calibration_ordinal: manifest.calibration_ordinal,
    risk_tier: riskTier,
    receipt_subject_id: reviewableManifestDigest(manifest),
  });
  verifyReviewSet(manifest, reviewRecords, roster.keys, {
    minimumReviewers: requirement.minimum_reviewers,
    requireShip: true,
  });

  const missionIds = reviewedBoard?.ordered_mission_ids;
  if (!Array.isArray(missionIds) || missionIds.filter((id) => id === manifest.mission_id).length !== 1 ||
      missionIds.some((id) => !/^M-[0-9]{3,}$/.test(id ?? ''))) {
    throw new Error('reviewed board must contain the exact prepared mission once');
  }
  const runsRoot = path.dirname(path.dirname(path.dirname(path.resolve(manifestFile))));
  const manifests = await Promise.all(missionIds.map((missionId) => readJson(
    path.join(runsRoot, missionId, 'ready-pack', 'manifest.json'),
    `reviewed board manifest ${missionId}`,
  )));
  const boardManifest = manifests.find((item) => item?.mission_id === manifest.mission_id);
  if (canonical(boardManifest) !== canonical(manifest)) {
    throw new Error('reviewed board does not bind the exact prepared manifest');
  }
  verifyReviewedBoard(reviewedBoard, manifests);
}

export async function recordPrepare({
  ledgerFile, attemptFile, manifestFile, reviewedBoardFile, reviewerRosterFile,
}) {
  for (const [value, label] of [[ledgerFile, 'ledger'], [attemptFile, 'attempt'],
    [manifestFile, 'manifest'], [reviewedBoardFile, 'reviewed board'],
    [reviewerRosterFile, 'reviewer roster']]) nonblank(value, label);
  const attempt = object(await readJson(attemptFile, 'attempt file'), 'attempt file');
  if (attempt.schema_version !== 2) throw new Error('attempt schema_version must equal 2');
  if (!/^M-[0-9]{3,}$/.test(attempt.mission_id ?? '')) throw new Error('attempt mission_id is invalid');
  nonblank(attempt.task_id, 'attempt task_id');
  if (!Number.isInteger(attempt.attempt_sequence) || attempt.attempt_sequence < 1) {
    throw new Error('attempt attempt_sequence must be a positive integer');
  }
  if (!PREPARE_STATES.has(attempt.state)) throw new Error('attempt state is not a terminal prepare state');
  if (attempt.state !== 'READY') throw new Error('pilot credit requires a READY attempt with finalized prepare evidence');
  const occurredAt = Date.parse(attempt.updated_at ?? '');
  if (!Number.isFinite(occurredAt)) throw new Error('attempt updated_at must be an ISO timestamp');
  if (!Number.isFinite(attempt.lane_hours) || attempt.lane_hours < 0) throw new Error('attempt lane_hours must be non-negative');

  const manifest = object(await readJson(manifestFile, 'prepare manifest'), 'prepare manifest');
  if (manifest.mission_id !== attempt.mission_id) throw new Error('prepare manifest mission_id does not match attempt');
  const repoNodeId = nonblank(manifest.repository_node_id, 'prepare manifest repository_node_id');
  if (!/^sha256:[0-9a-f]{64}$/i.test(manifest.public_mission_sha256 ?? '')) {
    throw new Error('prepare manifest public_mission_sha256 is invalid');
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(manifest.bundle_digest ?? '')) {
    throw new Error('prepare manifest bundle_digest is invalid');
  }
  const readyPack = path.dirname(path.resolve(manifestFile));
  const publicMission = path.join(readyPack, 'public-mission');
  const [observedPublicMissionDigest, mission, runRecord, bundleManifest] = await Promise.all([
    directoryDigest(publicMission),
    readJson(path.join(publicMission, 'mission.json'), 'public mission'),
    readJson(path.join(publicMission, 'bundle', 'run_record.json'), 'public run record'),
    readJson(path.join(publicMission, 'bundle', 'bundle.manifest.json'), 'public bundle manifest'),
  ]);
  if (observedPublicMissionDigest !== manifest.public_mission_sha256) {
    throw new Error('public mission directory digest does not match prepare manifest');
  }
  if (bundleManifest?.bundle_digest !== manifest.bundle_digest) {
    throw new Error('public bundle digest does not match prepare manifest');
  }
  if (mission?.mission_id !== attempt.mission_id) throw new Error('public mission mission_id does not match attempt');
  if (runRecord?.schema_version !== 2) throw new Error('public run record schema_version must equal 2');
  await verifyPrepareReviewEvidence({manifest, manifestFile, reviewedBoardFile, reviewerRosterFile});
  const profile = runRecord.environment?.executor_profile;
  if (!['python', 'go'].includes(profile)) throw new Error('public run record profile must be python or go');
  const installCommands = runRecord.environment?.install_commands;
  const declaredCommands = mission.commands_declared;
  if (!Array.isArray(installCommands) || !installCommands.every((command) => typeof command === 'string' && command.trim())) {
    throw new Error('public run record install_commands are invalid');
  }
  if (!Array.isArray(declaredCommands) || !declaredCommands.length ||
      !declaredCommands.every((command) => typeof command === 'string' && command.trim())) {
    throw new Error('public mission commands_declared are invalid');
  }
  if (!Array.isArray(runRecord.commands) || runRecord.commands.length !== declaredCommands.length ||
      runRecord.commands.some((record, index) => record?.cmd !== declaredCommands[index] ||
        record.exit_code !== 0 || record.timed_out === true)) {
    throw new Error('public run record does not prove every declared command passed');
  }
  const buildConfig = `${profile}:sha256:${createHash('sha256').update(canonical({
    profile, install_commands: installCommands, commands_declared: declaredCommands,
  })).digest('hex')}`;

  const event = {
    event_id: stablePrepareEventId(attempt),
    profile,
    kind: 'DRY_PREPARE',
    occurred_at: new Date(occurredAt).toISOString(),
    repo_node_id: repoNodeId,
    build_config: buildConfig,
    full_prepare: true,
    publication_actions: 0,
    state: attempt.state,
    lane_hours: attempt.lane_hours,
  };
  const ledger = addPilotEvent(await loadPilotLedger(ledgerFile), event);
  await atomicWriteJson(ledgerFile, ledger);
  return {event, ledger, snapshot: pilotSnapshot(ledger)};
}

export async function recordShipped({ledgerFile, manifestFile, journalFile}) {
  for (const [value, label] of [[ledgerFile, 'ledger'], [manifestFile, 'manifest'],
    [journalFile, 'journal']]) nonblank(value, label);
  const [manifest, journal] = await Promise.all([
    readJson(manifestFile, 'prepare manifest'), readJson(journalFile, 'shipment journal'),
  ]);
  object(manifest, 'prepare manifest');
  object(journal, 'shipment journal');
  if (manifest.schema_version !== 2) throw new Error('prepare manifest schema_version must equal 2');
  if (!/^M-[0-9]{3,}$/.test(manifest.mission_id ?? '')) throw new Error('prepare manifest mission_id is invalid');
  if (journal.schema_version !== 2 || journal.mission_id !== manifest.mission_id || journal.state !== 'SHIPPED') {
    throw new Error('shipment journal must be schema 2 SHIPPED evidence for the exact prepared mission');
  }
  if (journal.mission_manifest !== manifestDigest([manifest]) || journal.bundle_digest !== manifest.bundle_digest) {
    throw new Error('shipment journal does not bind the exact prepared manifest');
  }
  const {contributorReceiptCounted} = await import('../../ship.mjs');
  if (!contributorReceiptCounted(manifest, journal)) {
    throw new Error('shipment journal does not prove a counted contributor receipt');
  }
  const laneHours = journal.resource_usage?.lane_hours;
  if (journal.resource_usage?.measurement_class !== 'observed_usage') {
    throw new Error('shipment journal resource usage must be observed_usage');
  }
  if (!Number.isFinite(laneHours) || laneHours < 0) throw new Error('shipment journal lane_hours must be non-negative');
  const occurredAt = Date.parse(journal.updated_at ?? '');
  if (!Number.isFinite(occurredAt)) throw new Error('shipment journal updated_at must be an ISO timestamp');

  const readyPack = path.dirname(path.resolve(manifestFile));
  const publicMission = path.join(readyPack, 'public-mission');
  const [observedPublicMissionDigest, runRecord, bundleManifest] = await Promise.all([
    directoryDigest(publicMission),
    readJson(path.join(publicMission, 'bundle', 'run_record.json'), 'public run record'),
    readJson(path.join(publicMission, 'bundle', 'bundle.manifest.json'), 'public bundle manifest'),
  ]);
  if (observedPublicMissionDigest !== manifest.public_mission_sha256 ||
      bundleManifest?.bundle_digest !== manifest.bundle_digest) {
    throw new Error('shipment evidence does not match the prepared public mission');
  }
  const profile = runRecord?.environment?.executor_profile;
  if (!['python', 'go'].includes(profile)) throw new Error('public run record profile must be python or go');
  const receiptSubjectId = reviewableManifestDigest(manifest);
  const event = {
    event_id: stableShippedEventId(receiptSubjectId),
    profile,
    kind: 'SHIPPED',
    occurred_at: new Date(occurredAt).toISOString(),
    receipt_subject_id: receiptSubjectId,
    lane_hours: laneHours,
  };
  const ledger = addPilotEvent(await loadPilotLedger(ledgerFile), event);
  await atomicWriteJson(ledgerFile, ledger);
  return {event, ledger, snapshot: pilotSnapshot(ledger)};
}

function parseOptions(argv) {
  const options = new Map();
  while (argv.length) {
    const flag = argv.shift();
    if (!flag?.startsWith('--')) throw new Error(`unexpected argument ${flag ?? ''}`);
    if (options.has(flag)) throw new Error(`duplicate argument ${flag}`);
    const value = argv.shift();
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    options.set(flag, value);
  }
  return options;
}

function requireOptions(options, flags) {
  const missing = flags.filter((flag) => !options.has(flag));
  if (missing.length) throw new Error(`required argument(s) missing: ${missing.join(', ')}`);
  const unknown = [...options.keys()].filter((flag) => !flags.includes(flag));
  if (unknown.length) throw new Error(`unknown argument(s): ${unknown.join(', ')}`);
}

export function parsePhase1Args(argv) {
  const values = [...argv];
  const command = values.shift();
  if (!['draft-from-qualification', 'record-prepare', 'record-shipped'].includes(command)) {
    throw new Error('usage: phase1-cli.mjs <draft-from-qualification|record-prepare|record-shipped> [options]');
  }
  const options = parseOptions(values);
  if (command === 'draft-from-qualification') {
    const flags = ['--qualification', '--queue', '--candidate', '--test-path', '--base-failure-contains', '--draft-out', '--policy-out'];
    requireOptions(options, flags);
    return {
      command,
      qualificationFile: path.resolve(options.get('--qualification')),
      queueFile: path.resolve(options.get('--queue')),
      candidate: options.get('--candidate'),
      testPath: options.get('--test-path'),
      baseFailureContains: options.get('--base-failure-contains'),
      draftOut: path.resolve(options.get('--draft-out')),
      policyOut: path.resolve(options.get('--policy-out')),
    };
  }
  if (command === 'record-shipped') {
    const flags = ['--ledger', '--manifest', '--journal'];
    requireOptions(options, flags);
    return {
      command,
      ledgerFile: path.resolve(options.get('--ledger')),
      manifestFile: path.resolve(options.get('--manifest')),
      journalFile: path.resolve(options.get('--journal')),
    };
  }
  const flags = ['--ledger', '--attempt', '--manifest', '--reviewed-board', '--reviewer-roster'];
  requireOptions(options, flags);
  return {
    command,
    ledgerFile: path.resolve(options.get('--ledger')),
    attemptFile: path.resolve(options.get('--attempt')),
    manifestFile: path.resolve(options.get('--manifest')),
    reviewedBoardFile: path.resolve(options.get('--reviewed-board')),
    reviewerRosterFile: path.resolve(options.get('--reviewer-roster')),
  };
}

async function main(argv) {
  const options = parsePhase1Args(argv);
  if (options.command === 'draft-from-qualification') {
    const result = await draftFromQualification(options);
    process.stdout.write(`${JSON.stringify({
      candidate: result.candidate, evidence_key: result.evidence_key,
      draft_out: result.draft_out, policy_out: result.policy_out,
    }, null, 2)}\n`);
    return;
  }
  const result = options.command === 'record-prepare'
    ? await recordPrepare(options)
    : await recordShipped(options);
  process.stdout.write(`${JSON.stringify(result.snapshot, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`phase1 cli error: ${error.message}`);
    process.exitCode = 1;
  });
}
