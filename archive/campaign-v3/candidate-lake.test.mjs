import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';

import {
  canonicalCandidate,
  candidateEvidenceKey,
  openCandidateLake,
} from './candidate-lake.mjs';
import {canonical} from './core.mjs';

const oid = (character) => character.repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;
const exec = promisify(execFile);

test('candidate lake preserves display identity and rich imported qualification idempotently', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-lake-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const lake = await openCandidateLake(path.join(root, 'candidate_lake.sqlite'));
  const record = {
    candidate: 'MixedCase/Project#17',
    evidence_sha256: digest('a'),
    review_id: digest('b'),
    reviewed_at: '2026-07-15T12:00:00Z',
    qualification_expires_at: '2026-07-15T14:00:00Z',
    review: {
      verdict: 'ACCEPT', tier: 'A', executor_profile: 'node',
      source_evidence: ['src/parser.ts:17 — return parseToken(input);'],
      acceptance_contract: {problem: 'The parser drops the final token.', expected_behavior: ['Retain it.']},
    },
    provenance: {batch: 3, register: 'qualification-register.jsonl'},
  };

  assert.equal(canonicalCandidate(record.candidate), 'mixedcase/project#17');
  assert.deepEqual(await lake.importQualifications([record], {source: 'batch-3'}), {imported: 1, unchanged: 0});
  assert.deepEqual(await lake.importQualifications([record], {source: 'batch-3'}), {imported: 0, unchanged: 1});

  const stored = await lake.getReview(record.candidate, record.evidence_sha256);
  assert.equal(stored.candidate, 'MixedCase/Project#17');
  assert.deepEqual(stored.result, record);
  assert.deepEqual(stored.provenance, {source: 'batch-3', embedded: record.provenance});
  assert.equal((await lake.stats()).reviews, 1);
});

test('import keys semantic reuse by preflight evidence while retaining the rich qualification digest', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-preflight-key-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const lake = await openCandidateLake(path.join(root, 'candidate_lake.sqlite'));
  const record = {
    candidate: 'Owner/Reusable#8',
    evidence_sha256: digest('a'),
    preflight_evidence_sha256: digest('b'),
    review_id: digest('c'),
    reviewed_at: '2026-07-15T12:00:00Z',
    qualification_expires_at: '2026-07-15T14:00:00Z',
    review: {verdict: 'ACCEPT', tier: 'A', executor_profile: 'node'},
  };
  assert.deepEqual(await lake.importQualifications([record], {source: 'batch-3'}), {imported: 1, unchanged: 0});
  const stored = await lake.getReview(record.candidate, record.preflight_evidence_sha256);
  assert.equal(stored.evidence_key, record.preflight_evidence_sha256);
  assert.equal(stored.result.evidence_sha256, record.evidence_sha256);
  assert.equal(await lake.getReview(record.candidate, record.evidence_sha256), null);
});

test('semantic cache is exact-evidence and expiry bound while live facts refresh independently', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-cache-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const lake = await openCandidateLake(path.join(root, 'candidate_lake.sqlite'));
  const facts = {
    candidate: 'Owner/Repo#4', base_commit: oid('a'), issue_updated_at: '2026-07-15T12:00:00Z',
    labels: ['Good First Issue'], assignees: [], comments_tail_sha256: digest('c'),
    timeline_prs_sha256: digest('d'), repo_policy_sha256: digest('e'),
  };
  const firstKey = candidateEvidenceKey(facts);
  const changedKey = candidateEvidenceKey({...facts, issue_updated_at: '2026-07-15T12:01:00Z'});
  assert.notEqual(firstKey, changedKey);

  await lake.upsertIssue({...facts, title: 'Fix parser bug', state: 'OPEN', profile: 'node'});
  await lake.putReview({
    candidate: facts.candidate, evidence_key: firstKey, verdict: 'REJECT', tier: 'C',
    executor_profile: 'node', review_id: digest('f'), result: {verdict: 'REJECT', reasons: ['bounded reason']},
    reviewed_at: '2026-07-15T12:00:00Z', expires_at: '2026-07-15T14:00:00Z', provenance: {source: 'test'},
  });
  await lake.upsertIssue({...facts, issue_updated_at: '2026-07-15T12:01:00Z', title: 'Fix parser bug', state: 'OPEN', profile: 'node'});

  assert.equal((await lake.getCachedReview(facts.candidate, firstKey, new Date('2026-07-15T13:00:00Z'))).verdict, 'REJECT');
  assert.equal(await lake.getCachedReview(facts.candidate, changedKey, new Date('2026-07-15T13:00:00Z')), null);
  assert.equal(await lake.getCachedReview(facts.candidate, firstKey, new Date('2026-07-15T15:00:00Z')), null);
  assert.equal((await lake.getIssue(facts.candidate)).issue_updated_at, '2026-07-15T12:01:00Z');
});

test('discovery refresh invalidates the queue until live mechanical preflight succeeds', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-rank-refresh-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const lake = await openCandidateLake(path.join(root, 'candidate_lake.sqlite'));
  const candidate = 'Owner/Queue#9';
  await lake.upsertRepository({
    repo: 'Owner/Queue', test_profile: 'node', full_check_commands: ['node --test test/queue.test.mjs'],
  });
  await lake.upsertIssue({
    candidate, profile: 'node', state: 'OPEN', evidence_key: digest('8'),
    mechanical_score: 80, mechanical_reasons: [], raw: {candidate},
  });
  assert.equal((await lake.rank({profile: 'node', count: 10})).length, 1);
  await lake.upsertIssue({
    candidate, profile: 'node', state: 'OPEN', clear_evidence: true,
    mechanical_reasons: ['pending live mechanical preflight'], raw: {candidate},
  });
  assert.equal((await lake.getIssue(candidate)).evidence_key, null);
  assert.equal((await lake.rank({profile: 'node', count: 10})).length, 0);
});

test('rank preserves content-bound custom invitation policy for qualification', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-custom-label-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const lake = await openCandidateLake(path.join(root, 'candidate_lake.sqlite'));
  const policy = {defaults: {}, repositories: {'Owner/Custom': {
    invitation_label_map: {'starter-ready': true},
  }}};
  const policySha = `sha256:${createHash('sha256').update(canonical(policy)).digest('hex')}`;
  await lake.upsertRepository({
    repo: 'Owner/Custom', test_profile: 'node', invitation_label_map: {'starter-ready': true},
  });
  const preflight = {
    candidate: 'Owner/Custom#7', repo_policy_sha256: policySha, repo_policy_snapshot: policy,
    repository: {name_with_owner: 'Owner/Custom', default_head: oid('a')},
    issue: {labels: ['starter-ready'], updated_at: '2026-07-15T12:00:00Z'},
  };
  await lake.upsertIssue({
    candidate: preflight.candidate, profile: 'node', state: 'OPEN', evidence_key: digest('9'),
    mechanical_score: 90, mechanical_reasons: [], raw: preflight,
  });
  const [ranked] = await lake.rank({profile: 'node', count: 10});
  assert.deepEqual(ranked.repository_profile.repo_policy, policy);
  assert.equal(ranked.repository_profile.repo_policy_sha256, policySha);
  assert.deepEqual(ranked.repository_profile.invitation_label_map, {'starter-ready': true});
});

test('Batch 3 JSON and JSONL import accepts wrapped records without flattening evidence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-import-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const lake = await openCandidateLake(path.join(root, 'candidate_lake.sqlite'));
  const first = {candidate: 'One/Repo#1', evidence_sha256: digest('1'), review_id: digest('2'),
    reviewed_at: '2026-07-15T12:00:00Z', qualification_expires_at: '2026-07-15T14:00:00Z',
    review: {verdict: 'ACCEPT', tier: 'A', executor_profile: 'node', nested: {complete: ['rich', 'evidence']}}};
  const second = {candidate: 'Two/Repo#2', evidence_sha256: digest('3'), review_id: digest('4'),
    reviewed_at: '2026-07-15T12:00:00Z', qualification_expires_at: '2026-07-15T14:00:00Z',
    review: {verdict: 'REJECT', tier: 'C', executor_profile: 'python', reasons: ['not bounded']}};
  const json = path.join(root, 'batch.json');
  const jsonl = path.join(root, 'batch.jsonl');
  await writeFile(json, `${JSON.stringify({candidates: [first]})}\n`);
  await writeFile(jsonl, `${JSON.stringify(second)}\n`);

  const imported = await lake.importFiles([json, jsonl]);
  assert.deepEqual(imported, {imported: 2, unchanged: 0, files: 2});
  assert.deepEqual((await lake.getReview('one/repo#1', digest('1'))).result.review.nested.complete, ['rich', 'evidence']);
});

test('import does not turn retryable infrastructure records into semantic rejects', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-import-retryable-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const lake = await openCandidateLake(path.join(root, 'candidate_lake.sqlite'));
  const retryable = {
    candidate: 'Retry/Repo#3',
    evidence_sha256: digest('7'),
    terminal_state: 'REVIEW_TOOL_ERROR',
    reviewed_at: '2026-07-15T12:00:00Z',
    qualification_expires_at: '2026-07-15T14:00:00Z',
    error: 'reviewer quota was unavailable',
  };
  assert.deepEqual(await lake.importQualifications([retryable], {source: 'batch-3'}), {imported: 0, unchanged: 0});
  assert.equal(await lake.getReview(retryable.candidate, retryable.evidence_sha256), null);
  assert.deepEqual((await lake.candidateStates({candidate: retryable.candidate})).map((item) => item.state_class), ['retryable']);
});

test('schema v1 migrates additively without losing existing repository rows', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-migrate-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const database = path.join(root, 'lake.sqlite');
  await exec('sqlite3', [database, `
    CREATE TABLE lake_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO lake_meta VALUES('schema_version','1');
    CREATE TABLE repositories(repo_key TEXT PRIMARY KEY,repo_display TEXT NOT NULL,raw_json TEXT NOT NULL DEFAULT '{}',provenance_json TEXT NOT NULL DEFAULT '{}',updated_at TEXT NOT NULL);
    INSERT INTO repositories(repo_key,repo_display,updated_at) VALUES('owner/repo','Owner/Repo','2026-07-17T00:00:00Z');
  `]);
  const lake = await openCandidateLake(database);
  assert.equal((await lake.stats()).repositories, 1);
  assert.equal((await exec('sqlite3', [database, "SELECT value FROM lake_meta WHERE key='schema_version';"])).stdout.trim(), '2');
});

test('node identities reconcile repository and issue renames while conflicts are quarantined', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-node-id-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const lake = await openCandidateLake(path.join(root, 'lake.sqlite'));
  const common = {profile: 'node', state: 'OPEN', evidence_key: digest('a'), mechanical_reasons: [], observed_at: '2026-07-17T10:00:00Z'};
  await lake.upsertIssue({...common, candidate: 'OldOwner/OldRepo#7', repository: {
    name_with_owner: 'OldOwner/OldRepo', node_id: 'R_repo', owner: {node_id: 'O_owner', login: 'OldOwner'},
  }, issue: {node_id: 'I_issue', number: 7, state: 'OPEN'}});
  await lake.upsertIssue({...common, candidate: 'NewOwner/NewRepo#7', repository: {
    name_with_owner: 'NewOwner/NewRepo', node_id: 'R_repo', owner: {node_id: 'O_owner', login: 'NewOwner'},
  }, issue: {node_id: 'I_issue', number: 7, state: 'OPEN'}});
  assert.deepEqual(await lake.stats(), {repositories: 1, issues: 1, reviews: 0, attempts: 0, retryable_states: 0, quarantined: 0});
  assert.equal((await lake.getIssue('NewOwner/NewRepo#7')).candidate, 'NewOwner/NewRepo#7');
  await assert.rejects(() => lake.upsertRepository({repo: 'NewOwner/NewRepo', node_id: 'R_other'}), /quarantin/i);
  assert.equal((await lake.quarantine()).length, 1);
});

test('qualification import resolves a renamed candidate before writing the imports foreign key', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-import-rename-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const database = path.join(root, 'lake.sqlite');
  const lake = await openCandidateLake(database);
  const common = {profile: 'node', state: 'OPEN', evidence_key: digest('a'), mechanical_reasons: [], observed_at: '2026-07-17T10:00:00Z'};
  await lake.upsertIssue({...common, candidate: 'NewOwner/NewRepo#7', repository: {
    name_with_owner: 'NewOwner/NewRepo', node_id: 'R_repo', owner: {node_id: 'O_owner', login: 'NewOwner'},
  }, issue: {node_id: 'I_issue', number: 7, state: 'OPEN'}});
  await lake.upsertIssue({...common, candidate: 'OldOwner/OldRepo#7', repository: {
    name_with_owner: 'OldOwner/OldRepo', node_id: 'R_repo', owner: {node_id: 'O_owner', login: 'OldOwner'},
  }, issue: {node_id: 'I_issue', number: 7, state: 'OPEN'}});
  const record = {
    candidate: 'OldOwner/OldRepo#7', evidence_sha256: digest('b'), review_id: digest('c'),
    reviewed_at: '2026-07-17T10:00:00Z', qualification_expires_at: '2026-07-17T12:00:00Z',
    review: {verdict: 'ACCEPT', tier: 'A', executor_profile: 'node'},
  };
  assert.deepEqual(await lake.importQualifications([record], {source: 'rename-test'}), {imported: 1, unchanged: 0});
  assert.equal((await lake.getReview('NewOwner/NewRepo#7', digest('b'))).verdict, 'ACCEPT');
  assert.equal((await exec('sqlite3', [database, 'SELECT candidate_key FROM imports;'])).stdout.trim(), 'newowner/newrepo#7');
});

test('rank excludes snapshots older than 48 hours and slot summary applies repo, owner, and cooldown constraints', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-slots-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const lake = await openCandidateLake(path.join(root, 'lake.sqlite'));
  const now = new Date('2026-07-17T12:00:00Z');
  const add = (candidate, repository, issueId, overrides = {}) => lake.upsertIssue({
    candidate, profile: 'node', state: 'OPEN', evidence_key: digest(issueId.at(-1)), mechanical_reasons: [],
    observed_at: overrides.observed_at ?? '2026-07-17T10:00:00Z',
    repository: {name_with_owner: repository, node_id: `R_${repository}`, owner: {login: repository.split('/')[0]},
      max_open_prs: overrides.max_open_prs ?? 1, open_northset_prs: overrides.open_northset_prs ?? 0,
      daily_pr_cap: overrides.daily_pr_cap ?? 1,
      northset_prs_opened_today: overrides.northset_prs_opened_today ?? 0, cooldown_until: overrides.cooldown_until},
    issue: {node_id: issueId, state: 'OPEN', updated_at: '2026-07-17T09:00:00Z'},
  });
  await add('Alpha/One#1', 'Alpha/One', 'I_1', {open_northset_prs: 1});
  await add('Alpha/Two#2', 'Alpha/Two', 'I_2');
  await add('Beta/Cool#3', 'Beta/Cool', 'I_3', {cooldown_until: 'manual-release'});
  await add('Gamma/Many#4', 'Gamma/Many', 'I_4', {max_open_prs: 2, daily_pr_cap: 2});
  await add('Gamma/Many#5', 'Gamma/Many', 'I_5', {max_open_prs: 2, daily_pr_cap: 2});
  await add('Stale/Repo#6', 'Stale/Repo', 'I_6', {observed_at: '2026-07-14T00:00:00Z'});
  assert.deepEqual((await lake.rank({profile: 'node', count: 20, now})).map((item) => item.candidate).sort(),
    ['Alpha/One#1', 'Alpha/Two#2', 'Beta/Cool#3', 'Gamma/Many#4', 'Gamma/Many#5'].sort());
  const slots = await lake.slotSummary({now, dailyRate: 10});
  assert.equal(slots.available_slots, 3);
  assert.equal(slots.occupied_slots, 1);
  assert.equal(slots.cooldown_blocked_repositories, 1);
  assert.equal(slots.fresh_issues, 5);
  assert.equal(slots.fresh_repositories, 4);
  assert.equal(slots.required_slots, 300);
  assert.equal((await lake.slotSummary({now, dailyRate: 20})).required_slots, 600);
});
