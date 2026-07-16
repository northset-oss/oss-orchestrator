#!/usr/bin/env node

import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {candidateEvidenceKey, openCandidateLake} from '../candidate-lake.mjs';
import {batchApprovalDigest, taskIdForCandidate, validateSpec} from '../core.mjs';
import {buildBatchBoard, parseOssArgs} from '../oss.mjs';
import {buildSpecDraft} from '../review-issue.mjs';
import {runFrozenBatchPipeline, runIndependentBatch} from '../ship.mjs';
import {finalizeSpec} from '../spec-finalize.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const oid = (character) => character.repeat(40);

function reviewFixture() {
  return {
    verdict: 'ACCEPT', candidate: 'Fixture/Parser#12', issue_url: 'https://github.com/Fixture/Parser/issues/12',
    base_branch: 'main', base_commit: oid('a'), task_id: taskIdForCandidate('Fixture/Parser#12'),
    summary: 'Retain the final parser token.', tier: 'A', executor_profile: 'node',
    test_command: 'node --test test/parser-regression.test.mjs',
    source_evidence: ['src/parser.mjs:12 — return tokens.slice(0, -1);'],
    process_requirements: ['Use the repository Node test harness.'],
    invitation_evidence: {type: 'label', url: 'https://github.com/Fixture/Parser/issues/12', observed_at: '2026-07-15T12:00:00Z'},
    acceptance_contract: {
      problem: 'The parser drops its final token.', expected_behavior: ['The parser retains its final token.'],
      non_goals: ['No public API changes.'], design_evidence: [{
        url: 'https://github.com/Fixture/Parser/issues/12', author_association: 'MEMBER', summary: 'Maintainer-authored defect report.',
      }],
    },
    related_prs: [], review_id: digest('1'), review_prompt_version: 2,
    reviewed_at: '2026-07-15T12:00:00Z', qualification_expires_at: '2026-07-15T14:00:00Z',
    evidence_sha256: digest('2'), issue_updated_at: '2026-07-15T11:59:00Z',
    requested_model: 'gpt-5.6-sol', actual_model: null, reasoning_effort: 'xhigh', service_tier: 'fast',
  };
}

function manifest(id, repository, character) {
  return {
    schema_version: 2, mission_id: id, task_id: `TASK-OSS-${character.toUpperCase().repeat(16)}`,
    attempt_sequence: 1, work_category: 'defect_fix', repo: repository,
    issue_url: `https://github.com/${repository}/issues/1`, pr_title: `fix: ${character}`,
    patch_sha256: digest(character), pr_body_sha256: digest(character), patch_review_sha256: digest(character),
    risk_flags: [], changed_file_classes: [{path: 'src/parser.mjs', class: 'source'}, {path: 'test/parser.test.mjs', class: 'added-test'}],
    oracle_sha256: digest(character), bundle_digest: digest(character),
  };
}

const root = await mkdtemp(path.join(os.tmpdir(), 'verify-scaling-redesign-'));
try {
  const lake = await openCandidateLake(path.join(root, 'candidate_lake.sqlite'));
  const facts = {candidate: 'Fixture/Parser#12', base_commit: oid('a'), issue_updated_at: '2026-07-15T11:59:00Z',
    labels: ['good first issue'], assignees: [], comments_tail_sha256: digest('3'),
    timeline_prs_sha256: digest('4'), repo_policy_sha256: digest('5'), profile: 'node'};
  const firstEvidence = candidateEvidenceKey(facts);
  const qualification = {...reviewFixture(), preflight_evidence_sha256: firstEvidence,
    review: {...reviewFixture(), rich: {source_lines: ['exact'], provenance_chain: [{batch: 3}]}}};
  assert.deepEqual(await lake.importQualifications([qualification], {source: 'batch-3-fixture'}), {imported: 1, unchanged: 0});
  assert.deepEqual(await lake.importQualifications([qualification], {source: 'batch-3-fixture'}), {imported: 0, unchanged: 1});
  assert.deepEqual((await lake.getReview('fixture/parser#12', firstEvidence)).result.review.rich.provenance_chain, [{batch: 3}]);
  assert.equal((await lake.getCachedReview('fixture/parser#12', firstEvidence,
    new Date('2026-07-15T13:00:00Z'), {profile: 'node'})).verdict, 'ACCEPT');

  const changedEvidence = candidateEvidenceKey({...facts, labels: ['good first issue', 'triaged']});
  assert.notEqual(firstEvidence, changedEvidence);
  await lake.upsertIssue({...facts, evidence_key: firstEvidence, title: 'Parser regression', state: 'OPEN', profile: 'node'});
  assert.equal(await lake.getCachedReview(facts.candidate, changedEvidence, new Date('2026-07-15T13:00:00Z')), null);

  const draft = buildSpecDraft(reviewFixture(), {testPaths: ['test/parser-regression.test.mjs'], baseFailureContains: 'retains final parser token'});
  const finalized = finalizeSpec(draft, {missionId: 'M-100', attemptSequence: 1, repoPolicySnapshot: {
    url: `https://github.com/Fixture/Parser/blob/${oid('a')}/CONTRIBUTING.md`, checked_at: '2026-07-15T12:00:00Z',
    ai_policy_summary: 'Contributions are invited.', content_sha256: digest('7'),
  }});
  assert.doesNotThrow(() => validateSpec(finalized));
  assert.equal(finalized.executor.image, 'node:24.16.0-bookworm');

  assert.equal(parseOssArgs(['prepare', 'M-100']).concurrency, 3);
  let active = 0;
  let peak = 0;
  await runIndependentBatch([1, 2, 3, 4, 5, 6], async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value;
  }, {concurrency: 3});
  assert.equal(peak, 3);

  const first = manifest('M-100', 'one/repo', 'a');
  const second = manifest('M-101', 'two/repo', 'b');
  assert.notEqual(batchApprovalDigest([first, second]), batchApprovalDigest([second, first]));
  assert.notEqual(batchApprovalDigest([first]), batchApprovalDigest([{...first, pr_body_sha256: digest('c')}]))
  const board = buildBatchBoard([first, second].map((value) => ({state: 'READY', manifest: value,
    spec: {...finalized, mission_id: value.mission_id, issue_url: value.issue_url, pr: {...finalized.pr, title: value.pr_title}},
    classes: value.changed_file_classes})));
  assert.equal(board.machine.batch_digest, batchApprovalDigest([first, second]));

  const calls = [];
  const batch = await runFrozenBatchPipeline([first, second].map((value) => ({manifest: value})), {
    publishPreparedBatch: async () => { calls.push('prepared'); return {digest: 'prepared'}; },
    waitForPagesOnce: async () => { calls.push('pages'); },
    processMission: async (item) => {
      calls.push(item.manifest.mission_id);
      if (item.manifest.mission_id === 'M-100') throw new Error('fixture mission failure');
      return {mission_id: item.manifest.mission_id, state: 'PR_OPENED'};
    },
    publishFinalBatch: async () => { calls.push('final'); return {digest: 'final'}; },
  }, {concurrency: 2});
  assert.deepEqual(calls.filter((value) => ['prepared', 'pages', 'final'].includes(value)), ['prepared', 'pages', 'final']);
  assert.equal(batch.mission_results[0].state, 'FAILED_INFRA_TERMINAL');
  assert.equal(batch.mission_results[1].state, 'PR_OPENED');

  process.stdout.write(`${JSON.stringify({ok: true, checks: {
    candidate_import_and_cache: true,
    spec_finalization: true,
    prepare_concurrency: peak,
    batch_digest_binding: true,
    independent_mission_failure: true,
  }}, null, 2)}\n`);
} finally {
  await rm(root, {recursive: true, force: true});
}
