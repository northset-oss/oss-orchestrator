import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  evidenceBackstopsResult,
  enforceConservativeVerdict,
  evidenceTruncationReasons,
  findExactOpenPrs,
  hardGateReasons,
  parseIssue,
  possibleSemanticPrs,
  requireReviewModelRunnerSuccess,
  reviewerCandidateEvidenceKey,
  sameRepositoryOpenPrs,
  validatedInvitation,
  validatedRepositoryPolicyEvidence,
  verifierCompatibilityReasons,
} from './review-issue.mjs';
import {canonical, sha256, taskIdForCandidate} from './core.mjs';
import {candidateEvidenceKey} from './candidate-lake.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;

test('review model runner emits only a trusted structured provider-error receipt', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-review-model-status-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const attackerReceipt = path.join(root, 'attacker.json');
  await assert.rejects(() => requireReviewModelRunnerSuccess({
    code: 1,
    stdout: 'HTTP 429 Too Many Requests',
    stderr: 'secondary rate limit; honor Retry-After',
  }, {statusFile: attackerReceipt}), /codex review failed/);
  await assert.rejects(() => readFile(attackerReceipt), {code: 'ENOENT'});

  const trustedReceipt = path.join(root, 'trusted.json');
  await assert.rejects(() => requireReviewModelRunnerSuccess({
    code: 1,
    stdout: [
      JSON.stringify({type: 'item.completed', item: {type: 'agent_message',
        text: 'candidate-controlled HTTP 429 secondary rate limit'}}),
      JSON.stringify({type: 'turn.failed', error: {message: 'transport failed', codexErrorInfo: {
        responseStreamConnectionFailed: {httpStatusCode: 429},
      }}}),
    ].join('\n'),
    stderr: '',
  }, {statusFile: trustedReceipt}), /codex review failed/);
  const receipt = JSON.parse(await readFile(trustedReceipt, 'utf8'));
  assert.equal(receipt.kind, 'MODEL_PROVIDER_ERROR');
  assert.equal(receipt.trusted_model_provider_error.http_status, 429);
});

test('parses a machine key and a clean issue URL', () => {
  assert.deepEqual(parseIssue('owner/repo#123'), {
    owner: 'owner', repo: 'repo', number: 123, key: 'owner/repo#123',
    url: 'https://github.com/owner/repo/issues/123',
  });
  assert.equal(parseIssue('https://github.com/owner/repo/issues/123').key, 'owner/repo#123');
});

test('review prompt requires every maintainer design citation to be a live comment or review URL', async () => {
  const source = await readFile(new URL('./review-issue.mjs', import.meta.url), 'utf8');
  assert.match(source, /Every non-policy design_evidence URL must exactly match either the live issue URL when the evidence packet proves its author association/);
});

test('review prompt distinguishes the Northset operator notice from a competing claimant', async () => {
  const source = await readFile(new URL('./review-issue.mjs', import.meta.url), 'utf8');
  assert.match(source, /A current AysajanE plan-to-work comment or assignment is Northset's own operator evidence, not a competing claimant/);
});

test('review prompt rejects pure coverage tasks that cannot produce a differential base failure', async () => {
  const source = await readFile(new URL('./review-issue.mjs', import.meta.url), 'utf8');
  assert.match(source, /The proposed regression test must fail against the checked-out base behavior/);
  assert.match(source, /Pure test-coverage work for behavior that already passes is ineligible/);
});

test('review prompt rejects a complete fix that cannot fit the current lane', async () => {
  const source = await readFile(new URL('./review-issue.mjs', import.meta.url), 'utf8');
  assert.match(source, /complete fix, including cleanup required to keep repository checks passing/);
  assert.match(source, /at most five changed files and 300 changed lines/);
});

test('the strengthened reviewer prompt has a new immutable version', async () => {
  const source = await readFile(new URL('./review-issue.mjs', import.meta.url), 'utf8');
  assert.match(source, /export const REVIEW_PROMPT_VERSION = 4/);
  assert.match(source, /review_prompt_version: REVIEW_PROMPT_VERSION/);
});

test('GitHub evidence uses the gateway and bounds pull-request history to one page', async () => {
  const source = await readFile(new URL('./review-issue.mjs', import.meta.url), 'utf8');
  assert.match(source, /command === 'gh'[\s\S]*runGhCommand/);
  assert.match(source, /\['pr', 'list',[\s\S]*?'--limit', '100'/);
  assert.doesNotMatch(source, /'--limit', '500'/);
  assert.doesNotMatch(source, /'--paginate'|'--slurp'/);
});

test('reviewer mechanically rejects evidence beyond the comments or timeline bounds', () => {
  assert.deepEqual(evidenceTruncationReasons({
    issueMeta: {comments: 301},
    evidence_bounds: {timeline: {truncated: false}},
  }), ['evidence_truncated_too_active: issue has 301 comments, above the 300-item evidence bound']);
  assert.deepEqual(evidenceTruncationReasons({
    issueMeta: {comments: 10},
    evidence_bounds: {timeline: {truncated: true}},
  }), ['evidence_truncated_too_active: issue timeline reached the 300-item evidence bound']);
});

test('reviewer live facts recompute the same canonical queued evidence identity', () => {
  const issue = parseIssue('Owner/Repo#12');
  const baseCommit = 'a'.repeat(40);
  const policySha = digest('3');
  const evidence = {
    issueData: {
      updatedAt: '2026-07-15T12:00:00Z',
      labels: [{name: 'Help Wanted'}, {name: 'bug'}],
      assignees: [{login: 'AysajanE'}],
      comments: [{author: {login: 'maintainer'}, authorAssociation: 'MEMBER',
        body: 'Exact bounded behavior.', createdAt: '2026-07-15T11:00:00Z'}],
    },
    timeline: [{event: 'cross-referenced', source: {issue: {
      number: 7, title: 'Prior fix', html_url: 'https://github.com/Owner/Repo/pull/7',
      state: 'open', draft: false, repository_url: 'https://api.github.com/repos/Owner/Repo', pull_request: {},
    }}}],
  };
  const comments = [{author: 'maintainer', author_association: 'MEMBER', body: 'Exact bounded behavior.',
    created_at: '2026-07-15T11:00:00Z'}];
  const prs = [{number: 7, title: 'Prior fix', url: 'https://github.com/Owner/Repo/pull/7', state: 'OPEN',
    draft: false, repository: 'Owner/Repo'}];
  const expected = candidateEvidenceKey({
    candidate: issue.key, profile: 'node', base_commit: baseCommit,
    issue_updated_at: evidence.issueData.updatedAt, labels: ['Help Wanted', 'bug'], assignees: ['AysajanE'],
    comments_tail_sha256: sha256(Buffer.from(canonical(comments))),
    timeline_prs_sha256: sha256(Buffer.from(canonical(prs))), repo_policy_sha256: policySha,
  });
  const actual = reviewerCandidateEvidenceKey(issue, baseCommit, evidence, 'node', policySha);
  assert.equal(actual.evidence_key, expected);
  assert.deepEqual(actual.comments, comments);
  assert.deepEqual(actual.cross_referenced_prs, prs);
});

test('rejects pull-request URLs and credential-bearing URLs', () => {
  assert.throws(() => parseIssue('https://github.com/owner/repo/pull/123'), /issues\/123/);
  assert.throws(() => parseIssue('https://token@github.com/owner/repo/issues/123'), /clean/);
});

test('finds exact issue references without confusing #12 and #123', () => {
  const issue = parseIssue('owner/repo#12');
  const prs = [
    {state: 'OPEN', url: 'https://github.com/owner/repo/pull/1', title: 'fix', body: 'Fixes #12'},
    {state: 'OPEN', url: 'https://github.com/owner/repo/pull/2', title: 'fix #123', body: ''},
    {state: 'CLOSED', url: 'https://github.com/owner/repo/pull/3', title: 'fix #12', body: ''},
  ];
  assert.deepEqual(findExactOpenPrs(prs, issue).map((pr) => pr.url), [prs[0].url]);
});

test('semantic PR matching uses the bounded issue title and catches an exact unlinked implementation', () => {
  const prs = [{
    state: 'OPEN',
    url: 'https://github.com/renovatebot/renovate/pull/44522',
    title: 'fix(manager/dockerfile): handle single-quoted empty ARG default value',
    body: 'Closes a mistyped neighboring issue number.',
  }];
  const matches = possibleSemanticPrs(prs,
    "Renovate doesn't handle single-quoted empty value for Dockerfile's ARG");
  assert.deepEqual(matches.map((pr) => pr.url), [prs[0].url]);
});

test('does not treat an external repository PR as a competing implementation', () => {
  const issue = parseIssue('owner/repo#12');
  const prs = [
    {state: 'OPEN', url: 'https://github.com/owner/repo/pull/9', repositoryUrl: 'https://api.github.com/repos/owner/repo'},
    {state: 'OPEN', url: 'https://github.com/spec/project/pull/10', repositoryUrl: 'https://api.github.com/repos/spec/project'},
  ];
  assert.deepEqual(sameRepositoryOpenPrs(prs, issue).map((pr) => pr.url), [prs[0].url]);
});

test('hard gates reject closed, assigned, archived, and occupied issues', () => {
  const reasons = hardGateReasons({
    issueData: {state: 'CLOSED', assignees: [{login: 'dev'}]},
    repoData: {isArchived: true, isFork: false},
    exactOpenPrs: [{url: 'https://github.com/owner/repo/pull/9'}],
  });
  assert.equal(reasons.length, 4);
  assert.deepEqual(hardGateReasons({
    issueData: {state: 'OPEN', assignees: [{login: 'AysajanE'}]},
    repoData: {isArchived: false, isFork: false},
    exactOpenPrs: [],
  }), []);
});

test('verifier compatibility rejects tracked Git submodules before semantic review', () => {
  const gitIndex = [
    `100644 ${'a'.repeat(40)} 0\tREADME.md`,
    `160000 ${'b'.repeat(40)} 0\tpkg/ui/web`,
  ].join('\n');
  assert.deepEqual(verifierCompatibilityReasons(gitIndex), [
    'Repository contains tracked Git submodules unsupported by the canonical verifier: pkg/ui/web',
  ]);
  assert.deepEqual(verifierCompatibilityReasons(`100644 ${'a'.repeat(40)} 0\tREADME.md\n`), []);
});

function acceptedResult() {
  return {
    verdict: 'ACCEPT', candidate: 'wrong/key#1', issue_url: 'https://wrong', summary: 'Good candidate.',
    reasons: ['All gates passed.'],
    checks: {
      open_unassigned: 'PASS', no_active_claim_or_pr: 'PASS', current_main_gap: 'PASS',
      bounded_scope: 'PASS', deterministic_harness: 'PASS', contribution_policy: 'PASS',
      invitation_signal: 'PASS', design_settled: 'PASS', historical_attempts_clear: 'PASS',
    },
    invitation_evidence: {
      type: 'label', url: 'https://github.com/owner/repo/issues/12',
      observed_at: '2026-07-13T12:00:00Z',
    },
    acceptance_contract: {
      problem: 'Current main has the bounded parser defect.',
      expected_behavior: ['The focused input returns the documented value.'],
      non_goals: ['No public API expansion.'],
      design_evidence: [{
        url: 'https://github.com/owner/repo/issues/12', author_association: 'MEMBER',
        summary: 'Maintainer-backed expected behavior.',
      }],
    },
    related_prs: [],
    source_evidence: ['src/file.ts:10 still lacks the behavior'],
    test_command: 'npm test -- focused.test.ts', process_requirements: [], base_commit: null,
    tier: 'A', executor_profile: 'node',
  };
}

test('keeps a complete ACCEPT but binds identity to the requested issue and commit', () => {
  const issue = parseIssue('owner/repo#12');
  const result = enforceConservativeVerdict(acceptedResult(), issue, 'a'.repeat(40));
  assert.equal(result.verdict, 'ACCEPT');
  assert.equal(result.candidate, issue.key);
  assert.equal(result.base_commit, 'a'.repeat(40));
  assert.equal(result.task_id, taskIdForCandidate(issue.key));
});

test('fails closed when an ACCEPT lacks an exact oracle or source evidence', () => {
  const issue = parseIssue('owner/repo#12');
  const incomplete = acceptedResult();
  incomplete.test_command = null;
  incomplete.source_evidence = [];
  const result = enforceConservativeVerdict(incomplete, issue, 'a'.repeat(40));
  assert.equal(result.verdict, 'REJECT');
  assert.match(result.reasons.join(' '), /test\/build command/);
  assert.match(result.reasons.join(' '), /source evidence/);
});

test('fails closed when invitation, settled design, or PR history evidence is missing', () => {
  const issue = parseIssue('owner/repo#12');
  for (const mutate of [
    (value) => { value.invitation_evidence = null; },
    (value) => { value.acceptance_contract.design_evidence = []; },
    (value) => { value.related_prs = [{url: 'https://github.com/owner/repo/pull/9', state: 'OPEN', relationship: 'overlap', disposition: 'same work'}]; },
    (value) => { value.related_prs = [{url: 'https://github.com/owner/repo/pull/8', state: 'CLOSED', relationship: 'overlap', disposition: 'closed without later maintainer reopening'}]; },
  ]) {
    const value = acceptedResult();
    mutate(value);
    assert.equal(enforceConservativeVerdict(value, issue, 'a'.repeat(40)).verdict, 'REJECT');
  }
});

test('a maintainer-authored issue can settle design without a redundant maintainer comment', () => {
  const result = acceptedResult();
  result.acceptance_contract.design_evidence = [{
    url: 'https://github.com/owner/repo/issues/12',
    author_association: 'OWNER',
    summary: 'The owner-authored issue defines the exact bounded expected behavior.',
  }];
  const evidence = {
    issueData: {url: 'https://github.com/owner/repo/issues/12', author: {login: 'maintainer'}, comments: []},
    issueMeta: {author_association: 'OWNER', user: {login: 'maintainer'}},
    candidateRelatedPrs: [],
  };
  assert.equal(evidenceBackstopsResult(result, evidence), true);
});

test('documented scoped and hyphenated invitation labels survive semantic validation', async () => {
  const issue = parseIssue('owner/repo#12');
  const result = acceptedResult();
  for (const name of [
    'good-first-issue',
    'E-help-wanted',
    'Effort: Good First Issue',
    'Status: Help Wanted',
  ]) {
    const evidence = {
      issueData: {
        url: issue.url,
        labels: [{name}],
        assignees: [],
        comments: [],
      },
      candidateRelatedPrs: [],
    };
    assert.deepEqual(
      await validatedInvitation(result, evidence, '', 'a'.repeat(40), issue),
      result.invitation_evidence,
      name,
    );
  }
});

test('custom invitation label requires the exact content-bound crawl policy', async () => {
  const issue = parseIssue('owner/repo#12');
  const result = acceptedResult();
  const policy = {defaults: {}, repositories: {'Owner/Repo': {
    invitation_label_map: {'starter-ready': true},
  }}};
  const policySha256 = sha256(Buffer.from(canonical(policy)));
  const evidence = {
    issueData: {url: issue.url, labels: [{name: 'starter-ready'}], assignees: [], comments: []},
    candidateRelatedPrs: [],
  };
  const checked = await validatedInvitation(result, evidence, '', 'a'.repeat(40), issue, {
    repoPolicySnapshot: policy, repoPolicySha256: policySha256,
  });
  assert.equal(checked.label, 'starter-ready');
  assert.equal(checked.repo_policy_sha256, policySha256);
  assert.equal(await validatedInvitation(result, evidence, '', 'a'.repeat(40), issue, {
    repoPolicySnapshot: {...policy, repositories: {}}, repoPolicySha256: policySha256,
  }), null);
});

test('repository-policy invitation is pinned to checked-out bytes and source lines', async () => {
  const issue = parseIssue('owner/repo#12');
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-policy-review-'));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'contributing.md'), 'Pick up confirmed bug issues.\n');
  const baseCommit = 'a'.repeat(40);
  const result = acceptedResult();
  result.invitation_evidence = {
    type: 'repository_policy',
    url: `https://github.com/owner/repo/blob/${baseCommit}/docs/contributing.md#L1`,
    observed_at: '2026-07-13T12:00:00Z',
  };
  result.source_evidence.push('docs/contributing.md:1 — confirmed bugs are available.');
  const evidence = {issueData: {labels: [], assignees: [], comments: []}, candidateRelatedPrs: []};
  const checked = await validatedInvitation(result, evidence, root, baseCommit, issue);
  assert.match(checked.content_sha256, /^sha256:[0-9a-f]{64}$/);
  const mutable = structuredClone(result);
  mutable.invitation_evidence.url = 'https://github.com/owner/repo/blob/main/docs/contributing.md#L1';
  assert.equal(await validatedInvitation(mutable, evidence, root, baseCommit, issue), null);
});

test('a separate repository-policy file can independently backstop design evidence', async () => {
  const issue = parseIssue('owner/repo#12');
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-design-policy-review-'));
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'bug-policy.md'), 'Official issues are ready for community work.\n');
  const baseCommit = 'a'.repeat(40);
  const item = {
    url: `https://github.com/owner/repo/blob/${baseCommit}/docs/bug-policy.md#L1`,
    author_association: 'REPOSITORY_POLICY',
    summary: 'Official issues are ready for community work.',
  };
  const checked = await validatedRepositoryPolicyEvidence(item,
    ['docs/bug-policy.md:1 — official issues are ready.'], root, baseCommit, issue);
  assert.match(checked.content_sha256, /^sha256:[0-9a-f]{64}$/);
});
