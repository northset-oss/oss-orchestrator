// Ship only an already-prepared, content-bound mission. Preparation owns authoring and
// verification; this module owns the small set of irreversible publication steps.

import {chmod, cp, mkdtemp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {
  assertBindingChain,
  assertPatchCommitBinding,
  canonical,
  createDeadline,
  directoryDigest,
  manifestDigest,
  parseCandidate,
  recheck,
  run,
  sanitizedGitEnv,
  sha256,
} from './core.mjs';

const NORTHSET_OSS = process.env.NORTHSET_OSS_DIR ?? '/Users/aeziz-local/northset-oss';
const VERIFICATION_REPO = 'northset-oss/verification-pilot';
const FORK_OWNER = 'AysajanE';
const BUNDLE_CLI = path.join(NORTHSET_OSS, 'bin', 'bundle.mjs');
const WORKFLOW_FILE = 'attest-bundle.yml';
export const PLANNED_ACTIONS = [
  'push-reviewed-commit',
  'publish-prepared-receipt-pr', 'wait-prepared-receipt-checks', 'merge-prepared-receipt-pr',
  'verify-attestation', 'confirm-canonical-receipt-http-200', 'recheck-collision',
  'open-approved-upstream-pr', 'sync-guarded-pr-disclosure', 'record-pr-disclosure',
  'rebuild-full-ledger', 'publish-final-envelope-pr', 'wait-final-envelope-checks',
  'merge-final-envelope-pr',
];
export const SHIP_BUDGET_MS = 60 * 60 * 1000;
const TERMINAL_SHIP_STATES = new Set([
  'SHIPPED', 'DECLINED', 'ABORTED_STALE', 'ABORTED_AFTER_PUBLICATION',
  'ABORTED_BUDGET', 'FAILED_INFRA_TERMINAL',
]);

function shipRun(deadline, command, args, options = {}) {
  return run(command, args, {timeoutMs: 2 * 60 * 1000, ...options, deadline});
}

function shipGit(deadline, cwd, ...args) {
  return shipRun(deadline, 'git', ['-C', cwd, ...args], {env: sanitizedGitEnv()});
}

export function isTerminalShipState(state) { return TERMINAL_SHIP_STATES.has(state); }

export function ledgerPaths(missionId) {
  return [`missions/${missionId}`, 'missions/index.json', 'site'];
}

export function ledgerBranch(missionId, phase) {
  return `northset/${missionId.toLowerCase()}-${phase}`;
}

export function disclosureSyncArgs(ledgerDir, missionId, prUrl, now) {
  return [
    path.join(ledgerDir, 'bin', 'pr-receipt-disclosure.mjs'), 'sync',
    '--policy', path.join(ledgerDir, 'policies', 'pr_receipt_disclosure_policy.json'),
    '--mission-dir', path.join(ledgerDir, 'missions', missionId),
    '--apply', '--confirm-pr-url', prUrl, '--now', now, '--json',
  ];
}

export function terminalJournalDisposition(journal, approvedManifest, missionManifest, {retryInfraTerminal = false} = {}) {
  if (!journal || !isTerminalShipState(journal.state)) return 'resume';
  if (journal.mission_manifest === missionManifest) {
    if (retryInfraTerminal && journal.state === 'FAILED_INFRA_TERMINAL' && journal.approved_manifest === approvedManifest) {
      return 'archive-and-retry';
    }
    return 'terminal';
  }
  if (journal.approved_manifest !== approvedManifest && journal.mission_manifest !== missionManifest) return 'archive-and-restart';
  return 'reject';
}

export function newJournal(manifest, approvedManifest, missionManifest, now = new Date(), {approvedBy = null} = {}) {
  return {
    schema_version: 2,
    mission_id: manifest.mission_id,
    approved_manifest: approvedManifest,
    approved_by: approvedBy,
    approved_at: now.toISOString(),
    mission_manifest: missionManifest,
    bundle_digest: manifest.bundle_digest,
    state: 'APPROVED',
    started_at: now.toISOString(),
    updated_at: now.toISOString(),
    retry_count: 0,
    retry_history: [],
    last_error: null,
    terminal_reason: null,
    transitions: [{state: 'APPROVED', at: now.toISOString()}],
  };
}

export function approvalRecord({spec, manifest, journal}) {
  if (spec.schema_version !== 2) return null;
  if (manifest.schema_version !== 2 || manifest.task_id !== spec.task_id || manifest.attempt_sequence !== spec.attempt_sequence) {
    throw new Error('schema-v2 approval requires a task-bound prepared manifest');
  }
  if (typeof journal.approved_by !== 'string' || !journal.approved_by.trim()) {
    throw new Error('schema-v2 shipping requires an explicit approved_by identity');
  }
  return {
    schema_version: 1,
    mission_id: spec.mission_id,
    task_id: spec.task_id,
    attempt_id: spec.mission_id,
    approved_manifest_digest: journal.approved_manifest,
    approved_by: journal.approved_by,
    approved_at: journal.approved_at,
    funding_program: 'Northset OSS Fund',
    initiative: 'OSS mission experimentation',
    budget_id: null,
    financial_cap: null,
    operational_caps: {
      finder_wall_seconds: 1200,
      qualification_wall_seconds: 300,
      prepare_wall_seconds: 3600,
      ship_wall_seconds: 3600,
      maximum_attempts: null,
    },
  };
}

export function retryJournal(prior, manifest, approvedManifest, missionManifest, archiveFile, now = new Date()) {
  const resumeState = [...(prior.transitions ?? [])].reverse()
    .find((transition) => !isTerminalShipState(transition.state))?.state ?? 'APPROVED';
  const next = newJournal(manifest, approvedManifest, missionManifest, now, {approvedBy: prior.approved_by ?? null});
  next.approved_at = prior.approved_at;
  for (const field of ['fork', 'ledger', 'pr', 'disclosure', 'envelope']) {
    if (prior[field] !== undefined) next[field] = prior[field];
  }
  next.state = resumeState;
  next.transitions = [{state: resumeState, at: now.toISOString(), reason: 'explicit retry of archived infrastructure failure'}];
  next.prior_attempt = {
    archive_file: archiveFile,
    state: prior.state,
    approved_manifest: prior.approved_manifest,
    mission_manifest: prior.mission_manifest,
    bundle_digest: prior.bundle_digest,
    terminal_reason: prior.terminal_reason ?? null,
  };
  return next;
}

export function readyPackMayStart(manifest, journal, now = new Date()) {
  const expires = Date.parse(manifest.expires_at);
  if (!Number.isFinite(expires)) return false;
  if (now.getTime() < expires) return true;
  return Boolean(journal?.started_at)
    && journal.mission_manifest === manifestDigest([manifest])
    && Date.parse(journal.started_at) < expires;
}

async function transitionJournal(journal, state, actions, reason = null) {
  const at = new Date().toISOString();
  journal.state = state;
  journal.updated_at = at;
  journal.last_error = reason;
  if (isTerminalShipState(state)) journal.terminal_reason = reason;
  journal.transitions = [...(journal.transitions ?? []), {state, at, ...(reason ? {reason} : {})}];
  await actions.save(journal);
}

export async function runShipStateMachine(subject, journal, actions) {
  if (isTerminalShipState(journal.state)) return {...journal, mission_id: subject.manifest.mission_id};
  const execute = async (name, operation) => {
    try { return await operation(); }
    catch (error) {
      if (journal.retry_count < 1 && !actions.deadline?.expired()) {
        journal.retry_count += 1;
        journal.last_error = `${name}: ${error.message}`;
        journal.retry_history = [...(journal.retry_history ?? []), {
          action: name,
          error: error.message,
          at: new Date().toISOString(),
        }];
        await actions.save(journal);
        return operation();
      }
      throw error;
    }
  };
  try {
    if (actions.preflight) await execute('local ledger preflight', actions.preflight);
    if (['APPROVED', 'PRE_PUBLIC_RECHECK'].includes(journal.state)) {
      if (journal.state !== 'PRE_PUBLIC_RECHECK') await transitionJournal(journal, 'PRE_PUBLIC_RECHECK', actions);
      const checked = await actions.prePublicRecheck();
      if (!checked.clean) {
        await transitionJournal(journal, 'ABORTED_STALE', actions, checked.reasons.join('; '));
        return {...journal, mission_id: subject.manifest.mission_id};
      }
      await execute('push', actions.push);
      await transitionJournal(journal, 'PUSHED', actions);
    }
    if (journal.state === 'PUSHED') {
      await execute('prepared receipt ledger pull request', actions.publishPreparedReceipt);
      await transitionJournal(journal, 'PREPARED_RECEIPT_PUBLISHED', actions);
    }
    if (journal.state === 'PREPARED_RECEIPT_PUBLISHED') {
      await execute('attestation', actions.attest);
      await transitionJournal(journal, 'ATTESTED', actions);
    }
    if (journal.state === 'ATTESTED') {
      await execute('canonical receipt HTTP check', actions.confirmReceipt);
      await transitionJournal(journal, 'RECEIPT_AVAILABLE', actions);
    }
    if (['RECEIPT_AVAILABLE', 'PRE_PR_COLLISION_CHECK'].includes(journal.state)) {
      if (journal.state !== 'PRE_PR_COLLISION_CHECK') await transitionJournal(journal, 'PRE_PR_COLLISION_CHECK', actions);
      const checked = await actions.prePrCollisionCheck();
      if (!checked.clean) {
        await execute('not_submitted envelope', actions.publishNotSubmitted);
        await transitionJournal(journal, 'ABORTED_AFTER_PUBLICATION', actions, checked.reasons.join('; '));
        return {...journal, mission_id: subject.manifest.mission_id};
      }
      await execute('pull request', actions.openPr);
      await transitionJournal(journal, 'PR_OPENED', actions);
    }
    if (journal.state === 'PR_OPENED') {
      await execute('guarded PR disclosure sync', actions.syncDisclosure);
      await transitionJournal(journal, 'DISCLOSURE_SYNCED', actions);
    }
    if (journal.state === 'DISCLOSURE_SYNCED') {
      await execute('final envelope ledger pull request', actions.publishFinalEnvelope);
      await transitionJournal(journal, 'FINAL_ENVELOPE_PUBLISHED', actions);
    }
    if (journal.state === 'FINAL_ENVELOPE_PUBLISHED') await transitionJournal(journal, 'SHIPPED', actions);
    return {...journal, mission_id: subject.manifest.mission_id};
  } catch (error) {
    const state = actions.deadline?.expired() || /timed out|deadline/i.test(error.message)
      ? 'ABORTED_BUDGET' : 'FAILED_INFRA_TERMINAL';
    await transitionJournal(journal, state, actions, error.message);
    return {...journal, mission_id: subject.manifest.mission_id};
  }
}

export async function runIndependentBatch(items, worker) {
  const results = [];
  for (const item of items) {
    try { results.push(await worker(item)); }
    catch (error) { results.push({mission_id: item.manifest?.mission_id ?? item.id, state: 'FAILED_INFRA_TERMINAL', terminal_reason: error.message}); }
  }
  return results;
}

async function exists(file) {
  try { await stat(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function must(label, result) {
  if (result.code !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-4).join(' ')}`);
  }
  return result;
}

export function batchManifestDigest(subjects) {
  return manifestDigest(subjects);
}

export function validateApprovedBatch(subjects, approvedDigest) {
  if (!Array.isArray(subjects) || subjects.length < 1 || subjects.length > 3) {
    throw new Error('an approved ship batch must contain one to three missions');
  }
  const repositories = new Set(subjects.map((subject) => subject.repo.toLowerCase()));
  if (repositories.size !== subjects.length) throw new Error('each mission in a ship batch must target a distinct repository');
  for (const subject of subjects) {
    if (canonical(subject.planned_actions) !== canonical(PLANNED_ACTIONS)) {
      throw new Error(`${subject.mission_id} has an unexpected planned action set`);
    }
  }
  const expected = batchManifestDigest(subjects);
  if (approvedDigest !== expected) throw new Error(`batch approval mismatch: expected --approve ${expected}`);
  return subjects;
}

export async function loadJournal(file) {
  let source;
  try { source = await readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try { return JSON.parse(source); } catch (error) {
    throw new Error(`ship journal is corrupt at ${file}: ${error.message}`);
  }
}

export async function saveJournal(file, journal) {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
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

export async function withFileRollback(file, operation) {
  let original = null;
  let existed = true;
  try { original = await readFile(file); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    existed = false;
  }
  try {
    return await operation();
  } catch (error) {
    if (existed) await writeFile(file, original);
    else await rm(file, {force: true});
    throw error;
  }
}

async function archiveTerminalJournal(subject) {
  const journal = subject.journal;
  const archiveDir = path.join(subject.missionDir, 'ship-journal-archive');
  await mkdir(archiveDir, {recursive: true, mode: 0o700});
  const timestamp = String(journal.started_at ?? 'unknown').replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '');
  const digest = String(journal.approved_manifest ?? 'unbound').replace(/^sha256:/, '').slice(0, 12);
  const archiveFile = path.join(archiveDir, `${timestamp}-${digest}.json`);
  const source = await readFile(subject.journalFile);
  try {
    const handle = await open(archiveFile, 'wx', 0o400);
    try { await handle.writeFile(source); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST' || !Buffer.from(await readFile(archiveFile)).equals(source)) throw error;
  }
  return path.relative(subject.missionDir, archiveFile);
}

export function assertJournalBinding(journal, approvedManifest, bundleDigest, missionManifest = null) {
  if (journal.approved_manifest !== approvedManifest) throw new Error('journal manifest binding does not match this approval');
  if (journal.bundle_digest !== bundleDigest) throw new Error('journal bundle binding does not match this ready pack');
  if (missionManifest !== null && journal.mission_manifest !== missionManifest) {
    throw new Error('journal mission-manifest binding does not match this ready pack');
  }
}

function expectedRelease(manifest) {
  const short = manifest.bundle_digest.slice('sha256:'.length, 'sha256:'.length + 12);
  const tag = `run-record-${manifest.mission_id}-${short}`;
  const asset = `${tag}.tar.gz`;
  return {
    tag,
    asset,
    uri: `https://github.com/${VERIFICATION_REPO}/releases/download/${tag}/${asset}`,
  };
}

export function canonicalReceiptUrl(missionId) {
  if (!/^M-[0-9]{3,}$/.test(missionId ?? '')) throw new Error('canonical receipt URL requires a mission id');
  return `https://northset-oss.github.io/verification-pilot/receipts/${missionId}/`;
}

async function loadReadySubject(spec, missionDir, deadline) {
  const ready = path.join(missionDir, 'ready-pack');
  const files = {
    manifest: path.join(ready, 'manifest.json'),
    patch: path.join(ready, 'fix.patch'),
    body: path.join(ready, 'pr_body.md'),
    title: path.join(ready, 'pr_title.txt'),
    issue: path.join(ready, 'issue_snapshot.json'),
    policy: path.join(ready, 'policy_snapshot.json'),
    oracle: path.join(ready, 'oracle.json'),
    publicMission: path.join(ready, 'public-mission'),
    authorRepo: path.join(missionDir, 'author-workspace', 'repo'),
  };
  const manifest = JSON.parse(await readFile(files.manifest, 'utf8'));
  const journalFile = path.join(missionDir, 'ship.journal.json');
  const journal = await loadJournal(journalFile);
  if (manifest.mission_id !== spec.mission_id) throw new Error(`${spec.mission_id} manifest has the wrong mission id`);
  if (manifest.repo !== `${parseCandidate(spec.candidate).owner}/${parseCandidate(spec.candidate).repo}`) {
    throw new Error(`${spec.mission_id} manifest repository does not match its spec`);
  }
  if (manifest.base_commit !== spec.base_commit || manifest.issue_url !== spec.issue_url) {
    throw new Error(`${spec.mission_id} manifest no longer matches its reviewed spec`);
  }
  if (manifest.spec_sha256 !== sha256(Buffer.from(canonical(spec), 'utf8'))) {
    throw new Error(`${spec.mission_id} spec changed after preparation`);
  }
  if (spec.schema_version === 2) {
    if (manifest.schema_version !== 2 || manifest.task_id !== spec.task_id ||
        manifest.attempt_sequence !== spec.attempt_sequence || manifest.work_category !== spec.work_category) {
      throw new Error(`${spec.mission_id} economic identity changed after preparation`);
    }
    const economic = path.join(files.publicMission, 'bundle', 'economic.json');
    if (manifest.economic_sha256 !== sha256(await readFile(economic))) {
      throw new Error(`${spec.mission_id} economic evidence digest changed after preparation`);
    }
  }
  if (!readyPackMayStart(manifest, journal)) throw new Error(`${spec.mission_id} ready pack expired before ship initiation`);
  if (canonical(manifest.planned_actions) !== canonical(PLANNED_ACTIONS)) throw new Error(`${spec.mission_id} manifest has unexpected actions`);
  const [patch, body, title, issue, policy, oracle] = await Promise.all([
    readFile(files.patch), readFile(files.body), readFile(files.title, 'utf8'),
    readFile(files.issue), readFile(files.policy), readFile(files.oracle),
  ]);
  const checks = [
    ['patch', manifest.patch_sha256, sha256(patch)],
    ['PR body', manifest.pr_body_sha256, sha256(body)],
    ['issue snapshot', manifest.issue_snapshot_sha256, sha256(issue)],
    ['policy snapshot', manifest.policy_snapshot_sha256, sha256(policy)],
    ['oracle', manifest.oracle_sha256, sha256(Buffer.from(canonical(JSON.parse(oracle.toString('utf8')))))],
  ];
  for (const [label, expected, actual] of checks) {
    if (expected !== actual) throw new Error(`${spec.mission_id} ${label} digest changed after preparation`);
  }
  if (title.trim() !== manifest.pr_title) throw new Error(`${spec.mission_id} PR title changed after preparation`);
  if (!await exists(files.authorRepo)) throw new Error(`${spec.mission_id} author repository is missing; prepare it again`);
  const tree = await assertPatchCommitBinding(files.authorRepo, manifest.base_commit, manifest.commit_oid, files.patch, {deadline});
  assertBindingChain({patch_sha256: manifest.patch_sha256, tested_tree_oid: tree, commit_oid: manifest.commit_oid});
  if (tree !== manifest.tested_tree_oid) throw new Error(`${spec.mission_id} tested tree no longer matches the manifest`);
  const verified = await must('public bundle verify', await shipRun(deadline, 'node', [BUNDLE_CLI, 'verify', files.publicMission, '--json']));
  const parsed = JSON.parse(verified.stdout);
  if (parsed.bundle_digest !== manifest.bundle_digest) throw new Error(`${spec.mission_id} bundle digest changed after preparation`);
  if (await directoryDigest(files.publicMission) !== manifest.public_mission_sha256) {
    throw new Error(`${spec.mission_id} public mission bytes changed after preparation`);
  }
  return {spec, missionDir, ready, files, manifest, journal, journalFile, deadline};
}

async function ensureCleanPublicRepository(deadline) {
  const status = await must('northset-oss status', await shipGit(deadline, NORTHSET_OSS, 'status', '--porcelain'));
  if (status.stdout.trim()) {
    throw new Error('northset-oss has uncommitted framework changes; review, commit, and push them before shipping a mission');
  }
  await must('northset-oss checkout main', await shipGit(deadline, NORTHSET_OSS, 'switch', 'main'));
  await must('northset-oss pull', await shipGit(deadline, NORTHSET_OSS, 'pull', '--ff-only', 'origin', 'main'));
  for (const required of [
    BUNDLE_CLI,
    path.join(NORTHSET_OSS, 'bin', 'pr-receipt-disclosure.mjs'),
    path.join(NORTHSET_OSS, 'policies', 'pr_receipt_disclosure_policy.json'),
  ]) {
    if (!await exists(required)) throw new Error(`northset-oss is missing required receipt tooling: ${required}`);
  }
}

async function rebuildLedger(deadline) {
  const now = new Date().toISOString();
  await must('ledger build', await run('node', [path.join(NORTHSET_OSS, 'bin', 'ledger.mjs'), 'build',
    '--missions-dir', 'missions', '--out', 'missions/index.json', '--now', now], {cwd: NORTHSET_OSS, deadline, timeoutMs: 60_000}));
  await must('ledger render', await run('node', [path.join(NORTHSET_OSS, 'bin', 'ledger.mjs'), 'render',
    '--index', 'missions/index.json', '--out', 'site/index.html', '--now', now], {cwd: NORTHSET_OSS, deadline, timeoutMs: 60_000}));
}

async function assertOnlyExpectedPublicChanges(allowed, deadline) {
  const status = await must('northset-oss status', await shipGit(deadline, NORTHSET_OSS, 'status', '--porcelain'));
  const unexpected = status.stdout.split('\n').filter(Boolean).filter((line) => {
    const changed = line.slice(3).trim().replace(/^.* -> /, '');
    const expected = allowed.some((entry) => changed === entry || changed.startsWith(`${entry}/`));
    return !expected;
  });
  if (unexpected.length) throw new Error(`northset-oss has unrelated changes: ${unexpected.join('; ')}`);
  return status.stdout.split('\n').filter(Boolean).some((line) => {
    const changed = line.slice(3).trim().replace(/^.* -> /, '');
    return allowed.some((entry) => changed === entry || changed.startsWith(`${entry}/`));
  });
}

export function ledgerChecksRegistered(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (/no checks reported/i.test(output)) return false;
  if (result.code !== 0) {
    throw new Error(`required ledger check discovery failed: ${output || `exit ${result.code}`}`);
  }
  let checks;
  try { checks = JSON.parse(result.stdout); }
  catch { throw new Error('required ledger check discovery returned invalid JSON'); }
  return Array.isArray(checks) && checks.length > 0;
}

export function ledgerCheckOutcome(result) {
  if (!ledgerChecksRegistered(result)) return 'unregistered';
  const checks = JSON.parse(result.stdout);
  const failed = checks.filter((check) => ['fail', 'cancel'].includes(check.bucket));
  if (failed.length) {
    throw new Error(`required ledger checks failed: ${failed.map((check) => `${check.name} (${check.state})`).join(', ')}`);
  }
  if (checks.every((check) => ['pass', 'skipping'].includes(check.bucket))) return 'success';
  return 'pending';
}

async function waitForRequiredLedgerChecks(prUrl, deadline) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await shipRun(deadline, 'gh', [
      'pr', 'checks', prUrl, '--repo', VERIFICATION_REPO, '--required', '--json', 'name,state,bucket',
    ], {timeoutMs: 30_000});
    const outcome = ledgerCheckOutcome(result);
    if (outcome === 'success') return;
    if (deadline?.expired()) throw new Error('ship deadline exhausted while waiting for required ledger checks');
    await delay(Math.min(10_000, deadline?.remainingMs?.() ?? 10_000));
  }
  throw new Error(`required ledger checks did not complete for ${prUrl} within ten minutes`);
}

async function publishLedgerPullRequest(paths, message, marker, {missionId, phase}, deadline) {
  const branch = ledgerBranch(missionId, phase);
  const changed = await assertOnlyExpectedPublicChanges(paths, deadline);
  if (changed) {
    await must('create ledger publication branch', await shipGit(deadline, NORTHSET_OSS, 'switch', '-C', branch));
    await must('stage ledger publication', await shipGit(deadline, NORTHSET_OSS, 'add', ...paths));
    await must('commit ledger publication', await shipGit(deadline, NORTHSET_OSS, 'commit', '-m', message));
    await must('push ledger publication branch', await shipGit(deadline, NORTHSET_OSS, 'push', '-u', 'origin',
      `HEAD:refs/heads/${branch}`));
  }
  const currentBranch = (await must('read current ledger branch', await shipGit(deadline, NORTHSET_OSS,
    'branch', '--show-current'))).stdout.trim();
  if (!changed && currentBranch === branch) {
    await must('recover ledger publication branch push', await shipGit(deadline, NORTHSET_OSS, 'push', '-u', 'origin',
      `HEAD:refs/heads/${branch}`));
  }
  const listed = JSON.parse((await must('find ledger publication pull request', await shipRun(deadline, 'gh', [
    'pr', 'list', '--repo', VERIFICATION_REPO, '--state', 'all', '--head', branch, '--limit', '10',
    '--json', 'number,url,state,headRefName,headRefOid,baseRefName,mergedAt,mergeCommit',
  ]))).stdout);
  let pr = listed.find((item) => item.headRefName === branch && item.baseRefName === 'main') ?? null;
  if (changed && !pr) {
    const created = await must('open ledger publication pull request', await shipRun(deadline, 'gh', [
      'pr', 'create', '--repo', VERIFICATION_REPO, '--base', 'main', '--head', branch,
      '--title', message, '--body', `Publishes the reviewed ${missionId} ${phase} ledger state through required checks.`,
    ]));
    const url = created.stdout.trim().split('\n').findLast((line) => /^https:\/\/github\.com\//.test(line));
    if (!url) throw new Error('ledger PR creation did not return a URL');
    pr = {url, state: 'OPEN'};
  }
  if (!pr) throw new Error(`cannot recover the gated ledger pull request for ${marker}`);
  if (pr.state !== 'MERGED') {
    await waitForRequiredLedgerChecks(pr.url, deadline);
    await must('merge checked ledger pull request', await shipRun(deadline, 'gh', [
      'pr', 'merge', pr.url, '--repo', VERIFICATION_REPO, '--squash', '--delete-branch',
    ]));
  }
  const merged = JSON.parse((await must('verify merged ledger pull request', await shipRun(deadline, 'gh', [
    'pr', 'view', pr.url, '--repo', VERIFICATION_REPO, '--json', 'state,mergedAt,mergeCommit,url',
  ]))).stdout);
  if (merged.state !== 'MERGED' || !/^[0-9a-f]{40}$/i.test(merged.mergeCommit?.oid ?? '')) {
    throw new Error(`ledger pull request ${pr.url} did not merge`);
  }
  const dirty = await must('check ledger after merge', await shipGit(deadline, NORTHSET_OSS, 'status', '--porcelain'));
  if (dirty.stdout.trim()) throw new Error('ledger checkout became dirty after publication commit');
  await must('return ledger checkout to main', await shipGit(deadline, NORTHSET_OSS, 'switch', 'main'));
  await must('update ledger main after merge', await shipGit(deadline, NORTHSET_OSS, 'pull', '--ff-only', 'origin', 'main'));
  const commitSha = merged.mergeCommit.oid;
  const markerCommit = (await must('locate published ledger marker', await shipGit(deadline, NORTHSET_OSS,
    'log', '-1', '--format=%H', '--', marker))).stdout.trim();
  const ancestor = await shipGit(deadline, NORTHSET_OSS, 'merge-base', '--is-ancestor', markerCommit, commitSha);
  if (ancestor.code !== 0) throw new Error(`merged ledger PR does not contain ${marker}`);
  return {commitSha, prUrl: merged.url};
}

export async function preparedDestinationDigest(destination) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'northset-public-recovery-'));
  try {
    const copy = path.join(temporary, 'mission');
    await cp(destination, copy, {recursive: true, verbatimSymlinks: true});
    await rm(path.join(copy, 'publication.json'), {force: true});
    await rm(path.join(copy, 'approval.json'), {force: true});
    const normalizeDirectories = async (directory) => {
      await chmod(directory, 0o700);
      const children = await readdir(directory, {withFileTypes: true});
      await Promise.all(children.filter((child) => child.isDirectory())
        .map((child) => normalizeDirectories(path.join(directory, child.name))));
    };
    await normalizeDirectories(copy);
    return await directoryDigest(copy);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}

async function remotePublicFile(file, ref, deadline) {
  const response = await must('read remote public file', await shipRun(deadline, 'gh', ['api',
    `repos/${VERIFICATION_REPO}/contents/${file}?ref=${encodeURIComponent(ref)}`]));
  const parsed = JSON.parse(response.stdout);
  if (parsed.encoding !== 'base64' || typeof parsed.content !== 'string') throw new Error(`remote ${file} did not return base64 content`);
  return Buffer.from(parsed.content.replaceAll('\n', ''), 'base64');
}

export function preparedPublication(manifest, now = new Date(), overrides = {}) {
  void now;
  return {
    schema_version: 1,
    mission_id: manifest.mission_id,
    state: 'prepared',
    pr_number: null,
    pr_url: null,
    pr_head_oid: null,
    base_branch: null,
    head_drift: false,
    ci_state: null,
    merge_commit_oid: null,
    review_decision: null,
    decision_url: null,
    opened_at: null,
    closed_at: null,
    updated_at: null,
    observed_at: null,
    correction_note: null,
    scope_note: null,
    attestation_uri: null,
    bundle_digest: manifest.bundle_digest,
    release_asset_sha256: null,
    attestation_verified_at: null,
    ...overrides,
  };
}

async function publishPreparedBundle(subject, journal, journalFile, log) {
  const id = subject.manifest.mission_id;
  const {deadline} = subject;
  const destination = path.join(NORTHSET_OSS, 'missions', id);
  const approval = approvalRecord({spec: subject.spec, manifest: subject.manifest, journal});
  if (journal.ledger?.commit_sha) {
    const remote = JSON.parse((await remotePublicFile(`missions/${id}/bundle/bundle.manifest.json`, journal.ledger.commit_sha, deadline)).toString('utf8'));
    if (remote.bundle_digest !== subject.manifest.bundle_digest) throw new Error(`${id} remote public bundle does not match the journal`);
    if (approval !== null) {
      const remoteApproval = JSON.parse((await remotePublicFile(`missions/${id}/approval.json`, journal.ledger.commit_sha, deadline)).toString('utf8'));
      if (canonical(remoteApproval) !== canonical(approval)) throw new Error(`${id} remote approval record does not match the journal`);
    }
    return;
  }
  if (!await exists(destination)) {
    await ensureCleanPublicRepository(deadline);
    await cp(subject.files.publicMission, destination, {recursive: true, verbatimSymlinks: true});
    if (approval !== null) await writeFile(path.join(destination, 'approval.json'), `${JSON.stringify(approval, null, 2)}\n`);
    await writeFile(path.join(destination, 'publication.json'), `${JSON.stringify(preparedPublication(subject.manifest), null, 2)}\n`);
  } else {
    if (await preparedDestinationDigest(destination) !== subject.manifest.public_mission_sha256) {
      throw new Error(`${id} existing public mission does not match the approved bytes`);
    }
    const current = JSON.parse(await readFile(path.join(destination, 'publication.json'), 'utf8'));
    if (current.mission_id !== id || current.bundle_digest !== subject.manifest.bundle_digest || current.pr_url !== null) {
      throw new Error(`${id} existing publication cannot be adopted as the prepared state`);
    }
    const approvalFile = path.join(destination, 'approval.json');
    if (approval === null) {
      if (await exists(approvalFile)) throw new Error(`${id} legacy mission has an unexpected approval record`);
    } else {
      const currentApproval = JSON.parse(await readFile(approvalFile, 'utf8'));
      if (canonical(currentApproval) !== canonical(approval)) throw new Error(`${id} existing approval record does not match the approved journal`);
    }
  }
  await rebuildLedger(deadline);
  const published = await publishLedgerPullRequest(
    ledgerPaths(id), `mission: publish prepared ${id} bundle`,
    `missions/${id}/bundle/bundle.manifest.json`, {missionId: id, phase: 'prepared'}, deadline,
  );
  const commitSha = published.commitSha;
  const remote = JSON.parse((await remotePublicFile(`missions/${id}/bundle/bundle.manifest.json`, commitSha, deadline)).toString('utf8'));
  if (remote.bundle_digest !== subject.manifest.bundle_digest) throw new Error(`${id} recovered public commit has the wrong bundle`);
  if (approval !== null) {
    const remoteApproval = JSON.parse((await remotePublicFile(`missions/${id}/approval.json`, commitSha, deadline)).toString('utf8'));
    if (canonical(remoteApproval) !== canonical(approval)) throw new Error(`${id} recovered public commit has the wrong approval record`);
  }
  journal.ledger = {...(journal.ledger ?? {}), commit_sha: commitSha, prepared_pr_url: published.prUrl};
  await saveJournal(journalFile, journal);
  await log('published the exact prepared bundle; attestation workflow triggered');
}

async function pollWorkflow(headSha, deadline) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (deadline?.expired()) throw new Error('ship deadline exhausted while waiting for attestation');
    const listed = await must('workflow list', await shipRun(deadline, 'gh', ['run', 'list', '--repo', VERIFICATION_REPO,
      '--workflow', WORKFLOW_FILE, '--limit', '20', '--json', 'databaseId,status,conclusion,headSha']));
    const outcome = workflowRunOutcome(JSON.parse(listed.stdout), headSha);
    if (outcome.status === 'success') return outcome.runId;
    if (outcome.status === 'failure') throw new Error(`attestation workflow ${outcome.runId} ended ${outcome.conclusion}`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error('attestation workflow did not complete within ten minutes');
}

export function workflowRunOutcome(runs, headSha) {
  const matching = (Array.isArray(runs) ? runs : []).filter((item) => item.headSha === headSha);
  const success = matching.find((item) => item.status === 'completed' && item.conclusion === 'success');
  if (success) return {status: 'success', runId: success.databaseId};
  if (matching.some((item) => item.status !== 'completed')) return {status: 'pending'};
  const failure = matching.find((item) => item.status === 'completed' && !['success', 'skipped'].includes(item.conclusion));
  if (failure) return {status: 'failure', runId: failure.databaseId, conclusion: failure.conclusion};
  return {status: 'pending'};
}

async function verifyReleasedBundle(subject, journal, journalFile, log) {
  const release = expectedRelease(subject.manifest);
  const {deadline} = subject;
  const runId = journal.ledger?.workflow_run_id ?? await pollWorkflow(journal.ledger.commit_sha, deadline);
  journal.ledger = {...(journal.ledger ?? {}), workflow_run_id: runId};
  await saveJournal(journalFile, journal);
  const root = await mkdtemp(path.join(os.tmpdir(), `${subject.manifest.mission_id}-attestation-`));
  try {
    const asset = path.join(root, release.asset);
    await must('download release asset', await shipRun(deadline, 'gh', ['release', 'download', release.tag, '--repo', VERIFICATION_REPO,
      '--pattern', release.asset, '--dir', root]));
    await must('verify GitHub attestation', await shipRun(deadline, 'gh', ['attestation', 'verify', asset, '--repo', VERIFICATION_REPO,
      '--signer-workflow', `${VERIFICATION_REPO}/.github/workflows/${WORKFLOW_FILE}`]));
    const extract = path.join(root, 'extract');
    await mkdir(extract);
    await must('extract release bundle', await shipRun(deadline, 'tar', ['-xzf', asset, '-C', extract]));
    const bundleRoot = path.join(extract, 'bundle');
    const staged = path.join(root, 'mission');
    await mkdir(staged);
    await cp(bundleRoot, path.join(staged, 'bundle'), {recursive: true, verbatimSymlinks: true});
    await cp(path.join(subject.files.publicMission, 'mission.json'), path.join(staged, 'mission.json'));
    const verified = await must('verify downloaded bundle contents', await shipRun(deadline, 'node', [BUNDLE_CLI, 'verify', staged, '--json']));
    const parsed = JSON.parse(verified.stdout);
    if (parsed.bundle_digest !== subject.manifest.bundle_digest) throw new Error('downloaded attested bundle digest does not match approval');
    journal.ledger = {
      ...journal.ledger,
      release_tag: release.tag,
      attestation_uri: release.uri,
      release_asset_sha256: sha256(await readFile(asset)),
      attestation_verified: true,
      attestation_verified_at: new Date().toISOString(),
    };
    await saveJournal(journalFile, journal);
    await log(`downloaded and verified attested asset ${release.asset}`);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

async function confirmCanonicalReceipt(subject, journal, journalFile, log) {
  const url = canonicalReceiptUrl(subject.manifest.mission_id);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (subject.deadline?.expired()) throw new Error('ship deadline exhausted while waiting for canonical receipt');
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(subject.deadline?.limit(15_000) ?? 15_000),
      });
      if (response.status === 200) {
        journal.ledger = {...(journal.ledger ?? {}), receipt_url: url, receipt_verified_at: new Date().toISOString()};
        await saveJournal(journalFile, journal);
        await log(`canonical receipt returned HTTP 200 at ${url}`);
        return;
      }
    } catch (error) {
      if (attempt === 59) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`canonical receipt did not return HTTP 200: ${url}`);
}

async function ensureForkAndPush(subject, journal, journalFile, log) {
  const {owner, repo} = parseCandidate(subject.spec.candidate);
  const {deadline} = subject;
  const branch = `northset/${subject.manifest.mission_id}`;
  let forkInfo = await shipRun(deadline, 'gh', ['api', `repos/${FORK_OWNER}/${repo}`]);
  if (forkInfo.code !== 0) {
    await must('fork repository', await shipRun(deadline, 'gh', ['repo', 'fork', `${owner}/${repo}`, '--clone=false', '--default-branch-only']));
    forkInfo = await must('read created fork', await shipRun(deadline, 'gh', ['api', `repos/${FORK_OWNER}/${repo}`]));
  }
  assertForkParent(JSON.parse(forkInfo.stdout), `${owner}/${repo}`);
  if (!journal.fork?.oid) {
    const current = await shipGit(deadline, subject.files.authorRepo, 'remote', 'get-url', 'fork');
    if (current.code !== 0) await must('add fork remote', await shipGit(deadline, subject.files.authorRepo, 'remote', 'add', 'fork', `https://github.com/${FORK_OWNER}/${repo}.git`));
    await must('push reviewed commit', await shipGit(deadline, subject.files.authorRepo, 'push', 'fork',
      `${subject.manifest.commit_oid}:refs/heads/${branch}`));
    journal.fork = {repo: `${FORK_OWNER}/${repo}`, branch, oid: subject.manifest.commit_oid};
    await saveJournal(journalFile, journal);
  }
  const remote = await must('read fork branch', await shipRun(deadline, 'gh', ['api', `repos/${FORK_OWNER}/${repo}/git/ref/heads/${branch}`, '--jq', '.object.sha']));
  assertBindingChain({...subject.manifest, pushed_oid: remote.stdout.trim()});
  if (journal.fork.repo !== `${FORK_OWNER}/${repo}` || journal.fork.branch !== branch || journal.fork.oid !== remote.stdout.trim()) {
    throw new Error(`${subject.manifest.mission_id} journal fork evidence does not match GitHub`);
  }
  await log(`fork branch points to reviewed commit ${subject.manifest.commit_oid.slice(0, 12)}`);
  return branch;
}

export function assertForkParent(repository, expectedParent) {
  if (repository?.fork !== true || String(repository?.parent?.full_name ?? '').toLowerCase() !== expectedParent.toLowerCase()) {
    throw new Error(`${repository?.full_name ?? 'existing repository'} is not a fork of ${expectedParent}`);
  }
  return true;
}

async function validateAndRecordPr(subject, pr, journal, journalFile) {
  const approvedBody = (await readFile(subject.files.body, 'utf8')).trimEnd();
  if (pr.title !== subject.manifest.pr_title || pr.body.trimEnd() !== approvedBody || pr.baseRefName !== subject.manifest.base_branch) {
    throw new Error('GitHub stored PR title, body, or base differs from approved bytes');
  }
  assertBindingChain({...subject.manifest, pushed_oid: journal.fork.oid, pr_head_oid: pr.headRefOid});
  journal.pr = {
    number: pr.number,
    url: pr.url,
    head_oid: pr.headRefOid,
    body_sha256: sha256(Buffer.from(pr.body)),
    opened_at: pr.createdAt,
  };
  await saveJournal(journalFile, journal);
  return pr;
}

async function openPullRequest(subject, branch, journal, journalFile, log) {
  const {owner, repo} = parseCandidate(subject.spec.candidate);
  const {deadline} = subject;
  if (journal.pr?.url) {
    const existing = JSON.parse((await must('read existing PR', await shipRun(deadline, 'gh', ['pr', 'view', journal.pr.url,
      '--repo', `${owner}/${repo}`, '--json', 'number,url,headRefOid,baseRefName,title,body,createdAt']))).stdout);
    const approvedBody = (await readFile(subject.files.body, 'utf8')).trimEnd();
    if (existing.title !== subject.manifest.pr_title || existing.body.trimEnd() !== approvedBody || existing.baseRefName !== subject.manifest.base_branch) {
      throw new Error('resumed PR title, body, or base branch differs from approved bytes');
    }
    assertBindingChain({...subject.manifest, pushed_oid: journal.fork.oid, pr_head_oid: existing.headRefOid});
    if (journal.pr.number !== existing.number || journal.pr.head_oid !== existing.headRefOid || journal.pr.body_sha256 !== sha256(Buffer.from(existing.body))) {
      throw new Error('journal PR evidence does not match GitHub');
    }
    return existing.url;
  }
  const recoverable = JSON.parse((await must('find pull request by approved branch', await shipRun(deadline, 'gh', ['pr', 'list',
    '--repo', `${owner}/${repo}`, '--state', 'all', '--head', `${FORK_OWNER}:${branch}`, '--limit', '10',
    '--json', 'number,url,headRefOid,baseRefName,title,body,createdAt']))).stdout)
    .filter((pr) => pr.headRefOid === subject.manifest.commit_oid);
  if (recoverable.length > 1) throw new Error('multiple pull requests match the approved branch and commit');
  if (recoverable.length === 1) {
    const recovered = await validateAndRecordPr(subject, recoverable[0], journal, journalFile);
    await log(`adopted existing exact pull request ${recovered.url}`);
    return recovered.url;
  }
  const created = await must('create pull request', await shipRun(deadline, 'gh', ['pr', 'create', '--repo', `${owner}/${repo}`,
    '--base', subject.manifest.base_branch, '--head', `${FORK_OWNER}:${branch}`,
    '--title', subject.manifest.pr_title, '--body-file', subject.files.body]));
  const url = created.stdout.trim().split('\n').findLast((line) => /^https:\/\/github\.com\//.test(line));
  if (!url) throw new Error('gh pr create did not return a pull request URL');
  const view = JSON.parse((await must('verify pull request', await shipRun(deadline, 'gh', ['pr', 'view', url, '--repo', `${owner}/${repo}`,
    '--json', 'number,url,headRefOid,baseRefName,title,body,createdAt']))).stdout);
  await validateAndRecordPr(subject, view, journal, journalFile);
  await log(`opened ${view.url}`);
  return view.url;
}

async function syncPrDisclosure(subject, journal, journalFile, log) {
  const {deadline} = subject;
  if (journal.disclosure?.verified_at) {
    const recorded = JSON.parse(await readFile(path.join(NORTHSET_OSS, 'missions', subject.manifest.mission_id, 'publication.json'), 'utf8'));
    if (recorded.pr_disclosure?.verified_at !== journal.disclosure.verified_at) {
      throw new Error('local PR disclosure no longer matches the journal');
    }
    return;
  }
  const currentPr = JSON.parse((await must('read pull request for publication', await shipRun(deadline, 'gh', ['pr', 'view', journal.pr.url,
    '--json', 'number,url,state,title,body,headRefOid,baseRefName,createdAt,closedAt,mergedAt,updatedAt,reviewDecision,mergeCommit,statusCheckRollup']))).stdout);
  const approvedBody = (await readFile(subject.files.body, 'utf8')).trimEnd();
  if (currentPr.title !== subject.manifest.pr_title || currentPr.body.trimEnd() !== approvedBody ||
      currentPr.baseRefName !== subject.manifest.base_branch || currentPr.headRefOid !== subject.manifest.commit_oid) {
    throw new Error('pull request drifted before publication envelope was recorded');
  }
  const file = path.join(NORTHSET_OSS, 'missions', subject.manifest.mission_id, 'publication.json');
  const current = JSON.parse(await readFile(file, 'utf8'));
  if (current.pr_url !== null && current.pr_url !== journal.pr.url) throw new Error('existing publication envelope belongs to another pull request');
  const publicMission = JSON.parse(await readFile(path.join(subject.files.publicMission, 'mission.json'), 'utf8'));
  const scopeNote = publicationScopeNote(publicMission);
  const projected = publicationFromPr({
    mission_id: subject.manifest.mission_id,
    patch_commit: subject.manifest.commit_oid,
    attestation_uri: journal.ledger.attestation_uri,
    run_record_bundle_digest: subject.manifest.bundle_digest,
    release_asset_sha256: journal.ledger.release_asset_sha256,
    attestation_verified_at: journal.ledger.attestation_verified_at,
    scope_note: scopeNote,
  }, currentPr, {
    attestation_uri: journal.ledger.attestation_uri,
    bundle_digest: subject.manifest.bundle_digest,
    release_asset_sha256: journal.ledger.release_asset_sha256,
    attestation_verified_at: journal.ledger.attestation_verified_at,
    scope_note: scopeNote,
  });
  const now = new Date().toISOString();
  let synchronizedPublication;
  await withFileRollback(file, async () => {
    await writeFile(file, `${JSON.stringify(projected, null, 2)}\n`);
    const synchronized = await must('guarded PR receipt disclosure sync', await shipRun(deadline, 'node',
      disclosureSyncArgs(NORTHSET_OSS, subject.manifest.mission_id, journal.pr.url, now),
      {cwd: NORTHSET_OSS, timeoutMs: 2 * 60 * 1000}));
    const report = JSON.parse(synchronized.stdout);
    synchronizedPublication = JSON.parse(await readFile(file, 'utf8'));
    if (synchronizedPublication.pr_disclosure?.canonical_url !== canonicalReceiptUrl(subject.manifest.mission_id) ||
        synchronizedPublication.pr_disclosure?.verified_at !== now || report.status !== 'verified') {
      throw new Error('guarded synchronizer did not record verified PR disclosure metadata');
    }
  });
  journal.disclosure = {verified_at: now, canonical_url: synchronizedPublication.pr_disclosure.canonical_url};
  await saveJournal(journalFile, journal);
  await log(`guarded synchronizer verified the exact PR body at ${journal.pr.url}`);
}

export function samePublishedEnvelope(localContents, remoteContents) {
  return Buffer.from(localContents).equals(Buffer.from(remoteContents));
}

async function publishPrEnvelope(subject, journal, journalFile, log) {
  const {deadline} = subject;
  if (journal.envelope?.commit_sha) {
    const remote = await remotePublicFile(`missions/${subject.manifest.mission_id}/publication.json`, journal.envelope.commit_sha, deadline);
    if (sha256(remote) !== journal.envelope.publication_sha256) throw new Error('remote publication envelope does not match the journal');
    return;
  }
  const file = path.join(NORTHSET_OSS, 'missions', subject.manifest.mission_id, 'publication.json');
  const contents = await readFile(file);
  const publication = JSON.parse(contents.toString('utf8'));
  if (publication.pr_url !== journal.pr.url || publication.pr_disclosure?.verified_at !== journal.disclosure?.verified_at) {
    throw new Error('final publication envelope lacks the synchronized PR disclosure');
  }
  const remoteMain = await remotePublicFile(`missions/${subject.manifest.mission_id}/publication.json`, 'main', deadline);
  if (!samePublishedEnvelope(contents, remoteMain)) await rebuildLedger(deadline);
  const published = await publishLedgerPullRequest(
    ledgerPaths(subject.manifest.mission_id), `ledger: record ${subject.manifest.mission_id} pull request`,
    `missions/${subject.manifest.mission_id}/publication.json`,
    {missionId: subject.manifest.mission_id, phase: 'envelope'}, deadline,
  );
  journal.envelope = {
    commit_sha: published.commitSha, ledger_pr_url: published.prUrl,
    publication_sha256: sha256(contents),
  };
  await saveJournal(journalFile, journal);
  await log(samePublishedEnvelope(contents, remoteMain)
    ? 'adopted the already-merged synchronized PR envelope'
    : 'published synchronized PR envelope through required ledger checks');
}

async function publishNotSubmittedEnvelope(subject, journal, journalFile, log, checked) {
  void journal;
  void journalFile;
  await log(`left the canonical receipt in prepared state after collision: ${checked.reasons.join('; ')}`);
}

async function shipOne(subject, approvedManifest, log) {
  const {journalFile} = subject;
  const journal = subject.journal;
  let branch = journal.fork?.branch ?? `northset/${subject.manifest.mission_id}`;
  let collision = null;
  const result = await runShipStateMachine(subject, journal, {
    deadline: subject.deadline,
    save: (next) => saveJournal(journalFile, next),
    preflight: () => ensureCleanPublicRepository(subject.deadline),
    prePublicRecheck: () => recheck(subject.spec, log, {
      mode: 'pre-public', deadline: subject.deadline,
      authorRepo: subject.files.authorRepo, commitOid: subject.manifest.commit_oid,
    }),
    push: async () => { branch = await ensureForkAndPush(subject, journal, journalFile, log); },
    publishPreparedReceipt: () => publishPreparedBundle(subject, journal, journalFile, log),
    attest: () => verifyReleasedBundle(subject, journal, journalFile, log),
    confirmReceipt: () => confirmCanonicalReceipt(subject, journal, journalFile, log),
    prePrCollisionCheck: async () => {
      collision = await recheck(subject.spec, log, {mode: 'pre-pr', deadline: subject.deadline});
      return collision;
    },
    openPr: () => openPullRequest(subject, branch, journal, journalFile, log),
    syncDisclosure: () => syncPrDisclosure(subject, journal, journalFile, log),
    publishFinalEnvelope: () => publishPrEnvelope(subject, journal, journalFile, log),
    publishNotSubmitted: () => publishNotSubmittedEnvelope(subject, journal, journalFile, log, collision),
  });
  return {
    mission_id: subject.manifest.mission_id,
    state: result.state,
    terminal_reason: result.terminal_reason,
    pr_url: journal.pr?.url ?? null,
    attestation_uri: journal.ledger?.attestation_uri ?? null,
    bundle_digest: subject.manifest.bundle_digest,
  };
}

export async function shipBatch(items, {approvedDigest, approvedBy = null, retryInfraTerminal = false, log = async () => {}} = {}) {
  const subjects = [];
  for (const item of items) {
    const deadline = createDeadline(SHIP_BUDGET_MS);
    subjects.push(await loadReadySubject(item.spec, item.missionDir, deadline));
  }
  validateApprovedBatch(subjects.map((subject) => subject.manifest), approvedDigest);
  if (subjects.some((subject) => subject.spec.schema_version === 2) && (typeof approvedBy !== 'string' || !approvedBy.trim())) {
    throw new Error('schema-v2 shipping requires --approved-by <stable-operator-id>');
  }
  // Bind every approved journal before the first outbound action.
  for (const subject of subjects) {
    const missionManifest = manifestDigest([subject.manifest]);
    if (subject.journal === null) {
      subject.journal = newJournal(subject.manifest, approvedDigest, missionManifest, new Date(), {approvedBy});
      await saveJournal(subject.journalFile, subject.journal);
    } else {
      if (subject.journal.schema_version !== 2 || typeof subject.journal.state !== 'string') {
        throw new Error(`${subject.manifest.mission_id} journal predates the finite state machine and cannot be resumed automatically`);
      }
      const disposition = terminalJournalDisposition(subject.journal, approvedDigest, missionManifest, {retryInfraTerminal});
      if (disposition === 'reject') {
        throw new Error(`${subject.manifest.mission_id} terminal journal can restart only with a newly approved changed manifest`);
      }
      if (subject.spec.schema_version === 2 && subject.journal.approved_by !== approvedBy) {
        throw new Error(`${subject.manifest.mission_id} approval actor does not match the existing journal`);
      }
      if (disposition === 'archive-and-retry') {
        const prior = subject.journal;
        const archiveFile = await archiveTerminalJournal(subject);
        subject.journal = retryJournal(
          prior, subject.manifest, approvedDigest, missionManifest, archiveFile,
        );
        await saveJournal(subject.journalFile, subject.journal);
      } else if (disposition === 'archive-and-restart') {
        const prior = subject.journal;
        const archiveFile = await archiveTerminalJournal(subject);
        subject.journal = {
          ...newJournal(subject.manifest, approvedDigest, missionManifest, new Date(), {approvedBy}),
          prior_attempt: {
            archive_file: archiveFile,
            state: prior.state,
            approved_manifest: prior.approved_manifest,
            mission_manifest: prior.mission_manifest,
            bundle_digest: prior.bundle_digest,
            terminal_reason: prior.terminal_reason ?? null,
          },
        };
        await saveJournal(subject.journalFile, subject.journal);
      } else if (disposition === 'terminal') {
        if (subject.journal.bundle_digest !== subject.manifest.bundle_digest) {
          throw new Error(`${subject.manifest.mission_id} terminal journal bundle does not match its unchanged manifest`);
        }
      } else {
        assertJournalBinding(subject.journal, approvedDigest, subject.manifest.bundle_digest, missionManifest);
      }
    }
  }
  return runIndependentBatch(subjects, (subject) =>
    shipOne(subject, approvedDigest, (message) => log(subject.manifest.mission_id, message)));
}

export function reviewDecision(value) {
  return ({APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', REVIEW_REQUIRED: 'review_required'})[value] ?? null;
}

export function stateFor(pr) {
  if (pr.mergedAt) return 'merged';
  return pr.state === 'OPEN' ? 'open' : 'closed_unmerged';
}

export function ciState(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return 'pending';
  const conclusion = (check) => check.conclusion ?? check.state ?? null;
  if (checks.some((check) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion(check)))) return 'failure';
  if (checks.some((check) => (check.status && check.status !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(conclusion(check)))) return 'pending';
  if (checks.every((check) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion(check)))) return 'success';
  return 'pending';
}

export function publicationScopeNote(mission) {
  if (typeof mission?.scope_note === 'string' && mission.scope_note.trim()) return mission.scope_note.trim();
  const limitations = Array.isArray(mission?.limitations) ? mission.limitations : [];
  const specific = limitations.filter((item) => typeof item === 'string' && item.trim())
    .filter((item) => !/^Does not prove (?:code quality|security)$/i.test(item.trim()))
    .filter((item) => !/^Contributor self-run record of Northset's own contribution;/i.test(item.trim()));
  return specific.length ? specific.join(' ') : null;
}

export function publicationAttestationEvidence(mission, previous = null) {
  const fields = ['attestation_uri', 'release_asset_sha256', 'attestation_verified_at'];
  if (previous) {
    const present = fields.filter((field) => previous[field] !== null && previous[field] !== undefined);
    if (present.length === fields.length) return Object.fromEntries(fields.map((field) => [field, previous[field]]));
    if (present.length !== 0) throw new Error('publication requires one complete attestation evidence tuple');
  }
  const present = fields.filter((field) => mission?.[field] !== null && mission?.[field] !== undefined);
  if (present.length !== fields.length) throw new Error('publication requires one complete attestation evidence tuple');
  return Object.fromEntries(fields.map((field) => [field, mission[field]]));
}

async function findMissionPr(mission) {
  const repo = mission.target_repo.replace(/^https:\/\/github\.com\//, '');
  const issueNumber = /\/issues\/([1-9][0-9]*)$/.exec(mission.issue_or_task)?.[1];
  const issueReference = issueNumber ? new RegExp(`(?:^|[^0-9])#${issueNumber}(?:[^0-9]|$)|issues/${issueNumber}(?:[^0-9]|$)`, 'i') : null;
  const listed = await must('list mission PRs', await run('gh', ['pr', 'list', '--repo', repo, '--author', FORK_OWNER,
    '--state', 'all', '--limit', '100', '--json',
    'number,url,state,title,body,headRefOid,baseRefName,createdAt,closedAt,mergedAt,updatedAt,reviewDecision,mergeCommit,statusCheckRollup']));
  const prs = JSON.parse(listed.stdout);
  return prs.find((pr) => pr.headRefOid === mission.patch_commit)
    ?? prs.find((pr) => pr.body?.includes(mission.mission_id) || issueReference?.test(`${pr.title ?? ''}\n${pr.body ?? ''}`))
    ?? null;
}

export function publicationFromPr(mission, pr, previous = null, now = new Date()) {
  const currentReviewDecision = reviewDecision(pr.reviewDecision);
  const attestation = publicationAttestationEvidence(mission, previous);
  const preservedDecisionUrl = previous?.review_decision === currentReviewDecision
    ? previous?.decision_url ?? null
    : null;
  const projected = {
    schema_version: 1,
    mission_id: mission.mission_id,
    state: stateFor(pr),
    pr_number: pr.number,
    pr_url: pr.url,
    pr_head_oid: pr.headRefOid,
    base_branch: pr.baseRefName,
    head_drift: pr.headRefOid !== mission.patch_commit,
    ci_state: ciState(pr.statusCheckRollup),
    merge_commit_oid: pr.mergeCommit?.oid ?? null,
    review_decision: currentReviewDecision,
    decision_url: currentReviewDecision ? preservedDecisionUrl ?? pr.url : null,
    opened_at: pr.createdAt,
    closed_at: pr.mergedAt ?? pr.closedAt,
    updated_at: pr.updatedAt,
    observed_at: now.toISOString(),
    correction_note: mission.mission_id === 'M-015'
      ? 'Correction: compile-typescript was run; the immutable record limitation incorrectly says type-check was not run. The PR later closed without merge.'
      : null,
    scope_note: previous?.scope_note ?? publicationScopeNote(mission),
    bundle_digest: previous?.bundle_digest ?? mission.run_record_bundle_digest,
    ...attestation,
  };
  if (previous?.pr_disclosure) projected.pr_disclosure = previous.pr_disclosure;
  return projected;
}

function publicationComparable(value) {
  if (!value) return null;
  const copy = {...value};
  delete copy.observed_at;
  return copy;
}

export function shouldSyncPublication(previous, next, {disclosureRequired = true} = {}) {
  const disclosureReady = !disclosureRequired || previous?.pr_disclosure?.mode === 'pr_body';
  return !previous || !disclosureReady ||
    canonical(publicationComparable(previous)) !== canonical(publicationComparable(next));
}

async function syncPublication(directory, {dryRun = false, deadline, now = new Date(), policy} = {}) {
  const missionFile = path.join(directory, 'mission.json');
  const mission = JSON.parse(await readFile(missionFile, 'utf8'));
  if (mission.variant !== 'author_contribution') return {mission: false, changed: false};
  if (!policy || !Array.isArray(policy.historical_exempt_mission_ids)) {
    throw new Error('PR disclosure policy with historical exemptions is required for status reconciliation');
  }
  const disclosureRequired = !policy.historical_exempt_mission_ids.includes(mission.mission_id);
  const pr = await findMissionPr(mission);
  if (!pr) return {mission: true, changed: false};
  const file = path.join(directory, 'publication.json');
  let previous = null;
  try { previous = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const next = publicationFromPr(mission, pr, previous, now);
  const attention = next.state === 'open' && (next.review_decision === 'changes_requested' || next.head_drift);
  if (!shouldSyncPublication(previous, next, {disclosureRequired})) {
    return {mission: true, changed: false, attention};
  }
  if (!dryRun) {
    if (disclosureRequired) {
      await withFileRollback(file, async () => {
        await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
        const synchronized = await must('guarded status PR disclosure sync', await shipRun(deadline, 'node',
          disclosureSyncArgs(NORTHSET_OSS, mission.mission_id, pr.url, now.toISOString()),
          {cwd: NORTHSET_OSS, timeoutMs: 2 * 60 * 1000}));
        const report = JSON.parse(synchronized.stdout);
        if (report.status !== 'verified') throw new Error(`${mission.mission_id} PR disclosure status was not verified`);
      });
    } else await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  }
  return {mission: true, changed: true, attention};
}

export async function syncStatus({push = true} = {}) {
  const deadline = createDeadline(SHIP_BUDGET_MS);
  await ensureCleanPublicRepository(deadline);
  const policy = JSON.parse(await readFile(path.join(NORTHSET_OSS, 'policies', 'pr_receipt_disclosure_policy.json'), 'utf8'));
  const entries = await readdir(path.join(NORTHSET_OSS, 'missions'), {withFileTypes: true});
  let missions = 0;
  let changed = false;
  const attention = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const result = await syncPublication(path.join(NORTHSET_OSS, 'missions', entry.name), {deadline, policy});
    if (result.mission) missions += 1;
    changed ||= result.changed;
    if (result.attention) attention.push(entry.name);
  }
  if (!changed) return {changed: false, missions, attention};
  await rebuildLedger(deadline);
  let ledgerPrUrl = null;
  if (push) {
    const published = await publishLedgerPullRequest(
      ['missions', 'missions/index.json', 'site'], 'ledger: reconcile upstream PR status',
      'missions/index.json', {missionId: `status-${Date.now()}`, phase: 'reconcile'}, deadline,
    );
    ledgerPrUrl = published.prUrl;
  }
  return {changed: true, missions, attention, ledger_pr_url: ledgerPrUrl};
}
