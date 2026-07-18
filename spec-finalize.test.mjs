import assert from 'node:assert/strict';
import test from 'node:test';

import {taskIdForCandidate, validateSpec} from './core.mjs';
import {buildSpecDraft, REVIEW_PROMPT_VERSION} from './review-issue.mjs';
import {finalizeSpec} from './spec-finalize.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const oid = (character) => character.repeat(40);

function acceptedReview() {
  return {
    verdict: 'ACCEPT', candidate: 'Owner/Repo#12', issue_url: 'https://github.com/Owner/Repo/issues/12',
    base_branch: 'main', base_commit: oid('a'), task_id: taskIdForCandidate('Owner/Repo#12'),
    tier: 'A', executor_profile: 'python', test_command: 'python -m pytest tests/test_parser.py -q',
    source_evidence: ['src/parser.py:12 — return tokens[:-1]'], process_requirements: ['Use pytest.'],
    invitation_evidence: {type: 'label', url: 'https://github.com/Owner/Repo/issues/12', observed_at: '2026-07-15T12:00:00Z'},
    acceptance_contract: {
      problem: 'The parser drops the final token.', expected_behavior: ['The final token is retained.'],
      non_goals: ['No parser API changes.'], design_evidence: [{url: 'https://github.com/Owner/Repo/issues/12', author_association: 'MEMBER', summary: 'Maintainer-authored report.'}],
    },
    related_prs: [], review_id: digest('1'), review_prompt_version: REVIEW_PROMPT_VERSION,
    reviewed_at: '2026-07-15T12:00:00Z', qualification_expires_at: '2026-07-15T14:00:00Z',
    evidence_sha256: digest('2'), issue_updated_at: '2026-07-15T11:59:00Z',
    requested_model: 'gpt-5.6-sol', actual_model: null, reasoning_effort: 'xhigh', service_tier: 'fast',
  };
}

test('review ACCEPT emits a schema-v2 draft with identity, evidence, oracle and process boundaries', () => {
  const draft = buildSpecDraft(acceptedReview(), {
    testPaths: ['tests/test_parser.py'], baseFailureContains: 'test_retains_final_token',
  });
  assert.equal(draft.schema_version, 2);
  assert.equal(draft.task_id, taskIdForCandidate('Owner/Repo#12'));
  assert.deepEqual(draft.acceptance_criteria, ['The final token is retained.']);
  assert.deepEqual(draft.non_goals, ['No parser API changes.']);
  assert.equal(draft.source_evidence[0], 'src/parser.py:12 — return tokens[:-1]');
  assert.equal(draft.oracle.command, acceptedReview().test_command);
  assert.equal(draft.executor.profile, 'python');
  assert.equal(draft.mission_id, null);
});

test('spec finalization binds mission sequence, policy bytes and registry image deterministically', () => {
  const draft = buildSpecDraft(acceptedReview(), {
    testPaths: ['tests/test_parser.py'], baseFailureContains: 'test_retains_final_token',
  });
  const policy = {
    url: `https://github.com/Owner/Repo/blob/${oid('a')}/CONTRIBUTING.md`,
    checked_at: '2026-07-15T12:00:00Z', ai_policy_summary: 'Contributions are invited.',
    content_sha256: digest('3'),
  };
  const first = finalizeSpec(draft, {missionId: 'M-100', attemptSequence: 2, repoPolicySnapshot: policy});
  const second = finalizeSpec(draft, {missionId: 'M-100', attemptSequence: 2, repoPolicySnapshot: policy});
  assert.deepEqual(first, second);
  assert.equal(first.executor.image, 'python:3.14.5-bookworm');
  assert.equal(first.executor.profile_status, 'pilot');
  assert.equal(first.executor.profile_production_proven, false);
  assert.deepEqual(first.receipt.repo_policy_snapshot, policy);
  assert.equal(first.authoring_mode, 'test_only_then_fix');
  assert.equal(first.qualification.review_prompt_version, REVIEW_PROMPT_VERSION);
  assert.doesNotThrow(() => validateSpec(first));
  assert.throws(() => validateSpec({...first, executor: {...first.executor, profile_production_proven: true}}), /production proof/i);
  assert.throws(() => finalizeSpec(draft, {missionId: 'bad', attemptSequence: 1, repoPolicySnapshot: policy}), /mission/i);
});

test('current reviewer drafts finalize while retained prompt-version 2 qualifications remain compatible', () => {
  const options = {testPaths: ['tests/test_parser.py'], baseFailureContains: 'test_retains_final_token'};
  const policy = {schema_version: 2, defaults: {max_open_prs: 1, daily_pr_cap: 1}};
  const current = finalizeSpec(buildSpecDraft(acceptedReview(), options), {
    missionId: 'M-101', attemptSequence: 1, repoPolicySnapshot: policy,
  });
  assert.equal(current.qualification.review_prompt_version, 4);

  const retainedReview = {...acceptedReview(), review_prompt_version: 2};
  const retained = finalizeSpec(buildSpecDraft(retainedReview, options), {
    missionId: 'M-102', attemptSequence: 1, repoPolicySnapshot: policy,
  });
  assert.equal(retained.qualification.review_prompt_version, 2);
  assert.throws(() => validateSpec({
    ...current,
    qualification: {...current.qualification, review_prompt_version: 5},
  }), /prompt version/i);
});
