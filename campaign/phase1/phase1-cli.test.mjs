import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {batchBoardData, directoryDigest, manifestDigest} from '../../core.mjs';
import {buildSpecDraft} from '../../review-issue.mjs';
import {bindReviewSet, createReviewRecord, finalizeReviewedBoard} from '../phase0/approvals.mjs';
import {reviewerIdFromPublicKey} from '../phase0/integrity.mjs';
import {draftFromQualification, parsePhase1Args, recordPrepare} from './phase1-cli.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const oid = (character) => character.repeat(40);

function acceptedReview(overrides = {}) {
  return {
    verdict: 'ACCEPT',
    candidate: 'Owner/Repo#12',
    issue_url: 'https://github.com/Owner/Repo/issues/12',
    base_branch: 'main',
    base_commit: oid('a'),
    task_id: 'TASK-OSS-0123456789ABCDEF',
    tier: 'A',
    executor_profile: 'python',
    test_command: 'python -m pytest tests/test_parser.py -q',
    source_evidence: ['src/parser.py:12 — return tokens[:-1]'],
    process_requirements: ['Use pytest.'],
    invitation_evidence: {
      type: 'label', url: 'https://github.com/Owner/Repo/issues/12', observed_at: '2026-07-17T12:00:00Z',
    },
    acceptance_contract: {
      problem: 'The parser drops the final token.',
      expected_behavior: ['The final token is retained.'],
      non_goals: ['No parser API changes.'],
      design_evidence: [{
        url: 'https://github.com/Owner/Repo/issues/12', author_association: 'MEMBER', summary: 'Maintainer-authored report.',
      }],
    },
    related_prs: [],
    review_id: digest('1'),
    review_prompt_version: 3,
    reviewed_at: '2026-07-17T12:00:00Z',
    qualification_expires_at: '2099-07-17T14:00:00Z',
    evidence_sha256: digest('2'),
    issue_updated_at: '2026-07-17T11:59:00Z',
    requested_model: 'gpt-5.6-sol', actual_model: null,
    reasoning_effort: 'xhigh', service_tier: 'fast',
    ...overrides,
  };
}

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-phase1-cli-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

test('draft-from-qualification uses one existing current ACCEPT and its exact evidence-bound queue policy', async (t) => {
  const root = await temporaryDirectory(t);
  const qualificationFile = path.join(root, 'qualifications.json');
  const queueFile = path.join(root, 'queue.json');
  const draftOut = path.join(root, 'out', 'draft.json');
  const policyOut = path.join(root, 'out', 'policy.json');
  const evidenceKey = digest('9');
  const review = acceptedReview();
  const policy = {schema_version: 2, defaults: {max_open_prs: 1}, marker: 'exact-policy-bytes'};
  await writeFile(qualificationFile, `${JSON.stringify({results: [{
    candidate: review.candidate, evidence_key: evidenceKey, state: 'ACCEPTED', review,
  }]})}\n`);
  await writeFile(queueFile, `${JSON.stringify({queue: [
    {candidate: review.candidate, evidence_key: digest('8'), repository_profile: {repo_policy: {wrong: true}}},
    {candidate: review.candidate, evidence_key: evidenceKey, repository_profile: {repo_policy: policy}},
  ]})}\n`);

  let builderCalls = 0;
  await draftFromQualification({
    qualificationFile, queueFile, candidate: 'owner/repo#12',
    testPath: 'tests/test_parser.py', baseFailureContains: 'test_retains_final_token',
    draftOut, policyOut,
  }, {
    now: () => new Date('2026-07-17T13:00:00Z'),
    buildSpecDraftImpl(value, options) {
      builderCalls += 1;
      assert.deepEqual(value, review);
      return buildSpecDraft(value, options);
    },
  });

  assert.equal(builderCalls, 1);
  const wrapper = JSON.parse(await readFile(draftOut, 'utf8'));
  assert.deepEqual(wrapper.review, review);
  assert.equal(wrapper.spec_draft.oracle.test_paths[0], 'tests/test_parser.py');
  assert.equal(wrapper.spec_draft.oracle.base_failure_contains, 'test_retains_final_token');
  assert.deepEqual(JSON.parse(await readFile(policyOut, 'utf8')), policy);
  assert.equal((await readdir(path.join(root, 'out'))).some((name) => name.includes('.tmp-')), false);
});

test('draft-from-qualification fails closed on expired, non-accepted, or evidence-mismatched records', async (t) => {
  const root = await temporaryDirectory(t);
  const qualificationFile = path.join(root, 'qualifications.json');
  const queueFile = path.join(root, 'queue.json');
  const options = {
    qualificationFile, queueFile, candidate: 'Owner/Repo#12', testPath: 'tests/test_parser.py',
    baseFailureContains: 'test_retains_final_token', draftOut: path.join(root, 'draft.json'),
    policyOut: path.join(root, 'policy.json'),
  };
  const review = acceptedReview({qualification_expires_at: '2026-07-17T12:30:00Z'});
  await writeFile(qualificationFile, JSON.stringify({results: [{
    candidate: review.candidate, evidence_key: digest('1'), state: 'CACHED_ACCEPT', review,
  }]}));
  await writeFile(queueFile, JSON.stringify({queue: [{
    candidate: review.candidate, evidence_key: digest('2'), repository_profile: {repo_policy: {schema_version: 1}},
  }]}));
  await assert.rejects(
    draftFromQualification(options, {now: () => new Date('2026-07-17T13:00:00Z')}),
    /expired/i,
  );

  review.qualification_expires_at = '2099-07-17T12:30:00Z';
  await writeFile(qualificationFile, JSON.stringify({results: [{
    candidate: review.candidate, evidence_key: digest('1'), state: 'ACCEPTED', review,
  }]}));
  await assert.rejects(draftFromQualification(options), /matching queue policy/i);

  await writeFile(qualificationFile, JSON.stringify({results: [{
    candidate: review.candidate, evidence_key: digest('1'), state: 'REJECTED_SEMANTIC', review,
  }]}));
  await assert.rejects(draftFromQualification(options), /current ACCEPTED or CACHED_ACCEPT/i);
});

function attempt(overrides = {}) {
  return {
    schema_version: 2,
    mission_id: 'M-100',
    task_id: 'TASK-OSS-0123456789ABCDEF',
    attempt_sequence: 1,
    state: 'READY',
    started_at: '2026-07-17T12:00:00Z',
    updated_at: '2026-07-17T12:30:00Z',
    lane_hours: 0.5,
    timings: [],
    ...overrides,
  };
}

async function readyEvidence(root, value = attempt(), {
  profile = 'python', repoNodeId = 'R_kgDOExample', installCommands = ['python -m pip install -e .'],
  commands = ['python -m pytest tests/test_parser.py -q'],
} = {}) {
  const ready = path.join(root, value.mission_id, 'ready-pack');
  const publicMission = path.join(ready, 'public-mission');
  await mkdir(path.join(publicMission, 'bundle'), {recursive: true});
  await writeFile(path.join(publicMission, 'mission.json'), `${JSON.stringify({
    mission_id: value.mission_id, commands_declared: commands,
  })}\n`);
  await writeFile(path.join(publicMission, 'bundle', 'run_record.json'), `${JSON.stringify({
    schema_version: 2,
    environment: {
      executor_profile: profile,
      container_image_digest: `${profile}@sha256:${'a'.repeat(64)}`,
      install_commands: installCommands,
    },
    commands: commands.map((cmd) => ({cmd, exit_code: 0, duration_ms: 10})),
  })}\n`);
  const bundleDigest = `sha256:${'b'.repeat(64)}`;
  await writeFile(path.join(publicMission, 'bundle', 'bundle.manifest.json'), `${JSON.stringify({
    version: 1, bundle_digest: bundleDigest, files: [],
  })}\n`);
  const manifestFile = path.join(ready, 'manifest.json');
  await writeFile(manifestFile, `${JSON.stringify({
    schema_version: 2,
    mission_id: value.mission_id,
    repo: 'Owner/Repo',
    issue_url: 'https://github.com/Owner/Repo/issues/12',
    pr_title: 'Fix the parser regression',
    commit_oid: oid('c'),
    patch_sha256: digest('3'),
    pr_body_sha256: digest('4'),
    oracle_sha256: digest('5'),
    risk_flags: [],
    changed_file_classes: [],
    calibration_ordinal: 21,
    repository_node_id: repoNodeId,
    bundle_digest: bundleDigest,
    public_mission_sha256: await directoryDigest(publicMission),
  })}\n`);
  return {manifestFile, publicMission};
}

async function completedReviewEvidence(root, manifestFile) {
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const reviewers = Array.from({length: 2}, (_, index) => {
    const keys = generateKeyPairSync('ed25519');
    return {
      ...keys,
      operator: `Reviewer ${index + 1}`,
      reviewerId: reviewerIdFromPublicKey(keys.publicKey),
      publicKeyFile: `reviewer-${index + 1}.pem`,
    };
  });
  const records = reviewers.map(({privateKey}) => createReviewRecord(manifest, {
    privateKey, disposition: 'SHIP', riskTier: 'GREEN', reviewedAt: '2026-07-17T12:40:00Z',
  }));
  const reviewedManifest = bindReviewSet(manifest, records);
  await writeFile(manifestFile, `${JSON.stringify(reviewedManifest, null, 2)}\n`);
  await writeFile(path.join(path.dirname(manifestFile), 'review-records.json'), `${JSON.stringify(records, null, 2)}\n`);

  const reviewedBoardFile = path.join(root, `reviewed-board-${manifest.mission_id}.json`);
  const reviewedBoard = finalizeReviewedBoard({
    ...batchBoardData([reviewedManifest]),
    ordered_mission_ids: [manifest.mission_id],
    batch_digest: digest('7'),
  }, [reviewedManifest]);
  await writeFile(reviewedBoardFile, `${JSON.stringify(reviewedBoard, null, 2)}\n`);

  const rosterDirectory = path.join(root, `roster-${manifest.mission_id}`);
  await mkdir(rosterDirectory, {recursive: true});
  await Promise.all(reviewers.map(({publicKey, publicKeyFile}) => writeFile(
    path.join(rosterDirectory, publicKeyFile),
    publicKey.export({type: 'spki', format: 'pem'}),
  )));
  const reviewerRosterFile = path.join(rosterDirectory, 'reviewers.json');
  await writeFile(reviewerRosterFile, `${JSON.stringify({
    schema_version: 1,
    reviewers: reviewers.map(({operator, reviewerId, publicKeyFile}) => ({
      operator,
      key_status: 'provisioned',
      public_key_file: publicKeyFile,
      reviewer_id: reviewerId,
      capabilities: ['review'],
    })),
  }, null, 2)}\n`);
  return {reviewedBoardFile, reviewerRosterFile, records};
}

test('record-prepare derives READY pilot facts from the content-bound prepare evidence and rejects conflicting replay', async (t) => {
  const root = await temporaryDirectory(t);
  const ledgerFile = path.join(root, 'pilot-ledger.json');
  const readyAttempt = path.join(root, 'ready-attempt.json');
  const ready = attempt();
  await writeFile(readyAttempt, JSON.stringify(ready));
  const evidence = await readyEvidence(root, ready);
  const reviewEvidence = await completedReviewEvidence(root, evidence.manifestFile);
  const options = {ledgerFile, attemptFile: readyAttempt, manifestFile: evidence.manifestFile, ...reviewEvidence};
  const first = await recordPrepare(options);
  assert.equal(first.ledger.events.length, 1);
  assert.equal(first.ledger.events[0].profile, 'python');
  assert.equal(first.ledger.events[0].repo_node_id, 'R_kgDOExample');
  assert.match(first.ledger.events[0].build_config, /^python:sha256:[0-9a-f]{64}$/);
  assert.equal(first.ledger.events[0].full_prepare, true);
  assert.equal(first.ledger.events[0].publication_actions, 0);
  assert.equal(first.ledger.events[0].state, 'READY');
  assert.equal(first.ledger.events[0].lane_hours, 0.5);
  assert.equal(first.snapshot.profiles.python.ready_dry_prepares, 1);

  const replay = await recordPrepare(options);
  assert.equal(replay.event.event_id, first.event.event_id);
  assert.equal(replay.ledger.events.length, 1);

  await writeFile(readyAttempt, JSON.stringify({...ready, lane_hours: 0.75}));
  await assert.rejects(recordPrepare(options), /already has different bytes/i);
});

test('record-prepare requires valid signed reviews and a finalized board over the exact prepared manifest', async (t) => {
  const root = await temporaryDirectory(t);
  const ledgerFile = path.join(root, 'pilot-ledger.json');
  const attemptFile = path.join(root, 'attempt.json');
  const value = attempt({mission_id: 'M-102'});
  await writeFile(attemptFile, JSON.stringify(value));
  const evidence = await readyEvidence(root, value);
  const missing = {
    ledgerFile, attemptFile, manifestFile: evidence.manifestFile,
    reviewedBoardFile: path.join(root, 'missing-reviewed-board.json'),
    reviewerRosterFile: path.join(root, 'missing-reviewer-roster.json'),
  };
  await assert.rejects(recordPrepare(missing), /review/i);

  const reviewEvidence = await completedReviewEvidence(root, evidence.manifestFile);
  const options = {ledgerFile, attemptFile, manifestFile: evidence.manifestFile, ...reviewEvidence};
  const board = JSON.parse(await readFile(reviewEvidence.reviewedBoardFile, 'utf8'));
  board.missions[0].patch_sha256 = digest('f');
  await writeFile(reviewEvidence.reviewedBoardFile, JSON.stringify(board));
  await assert.rejects(recordPrepare(options), /reviewed manifests|displayed board|exact/i);

  const refreshed = await completedReviewEvidence(root, evidence.manifestFile);
  const forgedRecords = structuredClone(refreshed.records);
  forgedRecords[0].signature = Buffer.from('forged').toString('base64');
  await writeFile(path.join(path.dirname(evidence.manifestFile), 'review-records.json'), JSON.stringify(forgedRecords));
  await assert.rejects(recordPrepare({
    ledgerFile, attemptFile, manifestFile: evidence.manifestFile, ...refreshed,
  }), /review record set digest|signature/i);
});

test('record-prepare fails closed when a failed attempt has no finalized READY evidence or bundle evidence is tampered', async (t) => {
  const root = await temporaryDirectory(t);
  const ledgerFile = path.join(root, 'pilot-ledger.json');
  const failed = attempt({state: 'FAILED_ORACLE'});
  const failedAttempt = path.join(root, 'failed-attempt.json');
  await writeFile(failedAttempt, JSON.stringify(failed));
  const evidence = await readyEvidence(root, failed, {profile: 'go', repoNodeId: 'R_kgDOGo',
    installCommands: ['go mod download'], commands: ['go test ./...']});
  const failedReview = await completedReviewEvidence(root, evidence.manifestFile);
  await assert.rejects(recordPrepare({
    ledgerFile, attemptFile: failedAttempt, manifestFile: evidence.manifestFile, ...failedReview,
  }), /READY/i);

  const readyAttempt = path.join(root, 'ready-attempt.json');
  const ready = attempt({mission_id: 'M-101'});
  await writeFile(readyAttempt, JSON.stringify(ready));
  const readyPack = await readyEvidence(root, ready);
  const readyReview = await completedReviewEvidence(root, readyPack.manifestFile);
  await writeFile(path.join(readyPack.publicMission, 'mission.json'), JSON.stringify({
    mission_id: ready.mission_id, commands_declared: ['forged check'],
  }));
  await assert.rejects(recordPrepare({
    ledgerFile, attemptFile: readyAttempt, manifestFile: readyPack.manifestFile, ...readyReview,
  }), /digest/i);
});

test('record-prepare and CLI parsing reject missing or invalid evidence fields', async (t) => {
  const root = await temporaryDirectory(t);
  const attemptFile = path.join(root, 'attempt.json');
  await writeFile(attemptFile, JSON.stringify(attempt({lane_hours: null})));
  const evidence = await readyEvidence(root, attempt());
  const reviewEvidence = await completedReviewEvidence(root, evidence.manifestFile);
  await assert.rejects(recordPrepare({
    ledgerFile: path.join(root, 'ledger.json'), attemptFile, manifestFile: evidence.manifestFile, ...reviewEvidence,
  }), /lane_hours/i);
  assert.throws(() => parsePhase1Args(['record-prepare', '--ledger', 'ledger.json']), /required/i);
  assert.throws(() => parsePhase1Args([
    'record-prepare', '--ledger', 'ledger.json', '--attempt', 'attempt.json', '--manifest', 'manifest.json',
    '--reviewed-board', 'reviewed-board.json', '--reviewer-roster', 'reviewers.json',
    '--profile', 'go',
  ]), /unknown argument/i);
});

test('record-shipped derives one idempotent shipment credit from the exact counted receipt journal', async (t) => {
  const root = await temporaryDirectory(t);
  const ledgerFile = path.join(root, 'pilot-ledger.json');
  const value = attempt({mission_id: 'M-103'});
  const evidence = await readyEvidence(root, value);
  const manifest = JSON.parse(await readFile(evidence.manifestFile, 'utf8'));
  const journalFile = path.join(root, value.mission_id, 'ship.journal.json');
  const journal = {
    schema_version: 2,
    mission_id: value.mission_id,
    mission_manifest: manifestDigest([manifest]),
    bundle_digest: manifest.bundle_digest,
    verified_patch_sha256: manifest.patch_sha256,
    verified_pr_body_sha256: manifest.pr_body_sha256,
    state: 'SHIPPED',
    updated_at: '2026-07-17T13:30:00Z',
    ledger: {
      receipt_url: `https://northset-oss.github.io/verification-pilot/receipts/${value.mission_id}/`,
      receipt_verified_at: '2026-07-17T13:20:00Z',
    },
    pr: {
      number: 34,
      url: 'https://github.com/Owner/Repo/pull/34',
      head_oid: manifest.commit_oid,
      body_sha256: manifest.pr_body_sha256,
    },
    resource_usage: {measurement_class: 'observed_usage', lane_hours: 0.25},
  };
  await writeFile(journalFile, JSON.stringify(journal));

  const phase1Module = await import('./phase1-cli.mjs');
  assert.equal(typeof phase1Module.recordShipped, 'function');
  const options = {ledgerFile, manifestFile: evidence.manifestFile, journalFile};
  const first = await phase1Module.recordShipped(options);
  assert.equal(first.event.profile, 'python');
  assert.equal(first.event.kind, 'SHIPPED');
  assert.equal(first.event.receipt_subject_id.length, 'sha256:'.length + 64);
  assert.equal(first.event.lane_hours, 0.25);
  assert.equal(first.snapshot.profiles.python.shipped, 1);
  const replay = await phase1Module.recordShipped(options);
  assert.equal(replay.event.event_id, first.event.event_id);
  assert.equal(replay.ledger.events.length, 1);

  await writeFile(journalFile, JSON.stringify({
    ...journal, resource_usage: {measurement_class: 'estimate', lane_hours: 0.25},
  }));
  await assert.rejects(phase1Module.recordShipped(options), /observed_usage/i);
  await writeFile(journalFile, JSON.stringify({
    ...journal, pr: {...journal.pr, url: 'https://github.com/Other/Repo/pull/34'},
  }));
  await assert.rejects(phase1Module.recordShipped(options), /counted contributor receipt/i);
  assert.deepEqual(parsePhase1Args([
    'record-shipped', '--ledger', ledgerFile, '--manifest', evidence.manifestFile, '--journal', journalFile,
  ]), {command: 'record-shipped', ledgerFile, manifestFile: evidence.manifestFile, journalFile});
});
