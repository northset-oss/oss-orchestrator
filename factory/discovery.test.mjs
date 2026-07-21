import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';

import {
  DISCOVERY_MAX_TARGET,
  discoverCandidates,
  discoveryStrata,
} from './discovery.mjs';

const NOW = new Date('2026-07-21T12:00:00.000Z');
const OID = 'a'.repeat(40);

async function temporaryLake(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-discovery-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const lake = path.join(root, 'candidate_lake.sqlite');
  const db = new DatabaseSync(lake);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE repositories(
      repo_key TEXT PRIMARY KEY,repo_display TEXT NOT NULL,stars INTEGER,default_branch TEXT,
      default_head TEXT,primary_language TEXT,license TEXT,pushed_at TEXT,archived INTEGER,fork INTEGER,
      ai_policy_status TEXT,ai_policy_url TEXT,ai_policy_sha256 TEXT,dco_required INTEGER,
      cla_required INTEGER,pr_template_kind TEXT,test_profile TEXT,install_command TEXT,
      focused_test_patterns_json TEXT,full_check_commands_json TEXT,invitation_label_map_json TEXT,
      last_policy_audit_at TEXT,cooldown_until TEXT,max_open_prs INTEGER NOT NULL DEFAULT 1,
      daily_pr_cap INTEGER NOT NULL DEFAULT 1,raw_json TEXT NOT NULL DEFAULT '{}',
      provenance_json TEXT NOT NULL DEFAULT '{}',updated_at TEXT NOT NULL,
      repository_node_id TEXT,owner_node_id TEXT,owner_login TEXT,
      open_northset_prs INTEGER NOT NULL DEFAULT 0,northset_prs_opened_today INTEGER NOT NULL DEFAULT 0,
      slot_observed_at TEXT,slot_expires_at TEXT
    );
    CREATE TABLE issues(
      candidate_key TEXT PRIMARY KEY,candidate_display TEXT NOT NULL,repo_key TEXT NOT NULL,
      issue_number INTEGER NOT NULL,title TEXT,body_excerpt TEXT,labels_json TEXT NOT NULL DEFAULT '[]',
      state TEXT,assignees_json TEXT NOT NULL DEFAULT '[]',comments_count INTEGER,updated_at TEXT,
      issue_updated_at TEXT,author_association TEXT,invitation_kind TEXT,profile TEXT,base_commit TEXT,
      evidence_key TEXT,mechanical_score INTEGER,mechanical_reasons_json TEXT NOT NULL DEFAULT '[]',
      last_hydrated_at TEXT,raw_json TEXT NOT NULL,provenance_json TEXT NOT NULL DEFAULT '{}',
      issue_node_id TEXT,snapshot_expires_at TEXT,
      FOREIGN KEY(repo_key) REFERENCES repositories(repo_key)
    );
  `);
  db.close();
  return lake;
}

function issue(repository, number, overrides = {}) {
  const language = overrides.language ?? 'TypeScript';
  return {
    __typename: 'Issue', id: `I_${repository}_${number}`, number,
    title: overrides.title ?? `Fix regression ${number}`,
    bodyText: 'Expected and actual behavior are documented.',
    url: `https://github.com/${repository}/issues/${number}`,
    state: overrides.state ?? 'OPEN', locked: overrides.locked ?? false,
    updatedAt: overrides.updatedAt ?? '2026-07-20T10:00:00Z', authorAssociation: 'MEMBER',
    labels: {nodes: [{name: overrides.label ?? 'good first issue'}]},
    assignees: {nodes: overrides.assignees ?? []},
    repository: {
      id: `R_${repository}`, nameWithOwner: repository,
      isArchived: false, isFork: false, isPrivate: false,
      stargazerCount: overrides.stars ?? 500, pushedAt: '2026-07-20T00:00:00Z',
      owner: {id: `O_${repository.split('/')[0]}`, login: repository.split('/')[0]},
      primaryLanguage: language ? {name: language} : null,
      defaultBranchRef: {name: 'main', target: {oid: OID}},
    },
  };
}

test('discovery strata are exactly bounded to two labels by three Node scopes in one 14-day window', () => {
  const strata = discoveryStrata({now: NOW});
  assert.equal(strata.length, 6);
  assert.deepEqual(new Set(strata.map((item) => item.language)),
    new Set([null, 'JavaScript', 'TypeScript']));
  assert.deepEqual(new Set(strata.map((item) => item.label)),
    new Set(['good first issue', 'help wanted']));
  for (const stratum of strata) {
    assert.match(stratum.query, /is:issue is:open no:assignee archived:false is:public/);
    assert.match(stratum.query, /updated:>=2026-07-07/);
  }
});

test('bounded discovery routes all six searches through its callback, deduplicates, skips known rows, and writes the lake', async (t) => {
  const lake = await temporaryLake(t);
  const known = issue('Known/Repo', 1, {stars: 10_000});
  const repeated = issue('Fresh/Repeated', 2, {stars: 2_000});
  const second = issue('Fresh/Second', 3, {language: 'JavaScript'});
  const overflow = issue('Fresh/Overflow', 4, {stars: 10});
  const python = issue('Wrong/Python', 5, {language: 'Python'});
  const calls = [];
  const nodes = new Map([
    ['good_first_issue:global', [known, repeated, python]],
    ['good_first_issue:JavaScript', [second, repeated]],
    ['good_first_issue:TypeScript', [known, overflow]],
  ]);
  const search = async (request) => {
    calls.push(request);
    return {body: {data: {search: {nodes: nodes.get(request.stratum.name) ?? []}}}};
  };

  const result = await discoverCandidates({
    lakePath: lake, target: 2, knownCandidates: ['known/repo#1'], search, now: NOW,
  });
  assert.equal(calls.length, 6);
  assert.ok(calls.every((call) => call.variables.first === 100));
  assert.ok(calls.every((call) => call.query.includes('FactoryDiscovery')));
  assert.equal(result.selected, 2);
  assert.equal(result.inserted, 2);
  assert.equal(result.refreshed, 0);
  assert.equal(result.deduplicated_count, 2);
  assert.equal(result.skipped_reason_counts['candidate is already known to factory'], 1);
  assert.equal(result.skipped_reason_counts['repository primary language is Python, not JavaScript or TypeScript'], 1);
  assert.equal(result.skipped_reason_counts['discovery target 2 reached'], 1);

  const db = new DatabaseSync(lake, {readOnly: true});
  const stored = db.prepare(`SELECT candidate_key,profile,mechanical_reasons_json,last_hydrated_at
    FROM issues ORDER BY candidate_key`).all();
  assert.deepEqual(stored.map((row) => row.candidate_key),
    ['fresh/overflow#4', 'fresh/repeated#2']);
  assert.ok(stored.every((row) => row.profile === 'node' && row.mechanical_reasons_json === '[]' &&
    row.last_hydrated_at === NOW.toISOString()));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM repositories').get().count, 2);
  db.close();

  const refreshed = await discoverCandidates({lakePath: lake, target: 2,
    knownCandidates: ['known/repo#1'], search, now: NOW});
  assert.equal(refreshed.inserted, 0);
  assert.equal(refreshed.refreshed, 2);
});

test('a high-score repository flood is capped at two while later repositories fill the target', async (t) => {
  const lake = await temporaryLake(t);
  const flooded = [
    issue('Flooded/Repo', 10, {stars: 20_000}),
    issue('Flooded/Repo', 11, {stars: 20_000}),
    issue('Flooded/Repo', 12, {stars: 20_000}),
    issue('Flooded/Repo', 13, {stars: 20_000}),
  ];
  const later = issue('Later/Repo', 20, {stars: 10});
  let calls = 0;
  const result = await discoverCandidates({
    lakePath: lake,
    target: 3,
    now: NOW,
    search: async () => ({body: {data: {search: {nodes: calls++ === 0 ? [...flooded, later] : []}}}}),
  });

  assert.equal(calls, 6);
  assert.deepEqual(result.candidates.map((item) => item.candidate), [
    'flooded/repo#10', 'flooded/repo#11', 'later/repo#20',
  ]);
  assert.equal(result.skipped_reason_counts['repository discovery cap 2 reached'], 2);
  assert.deepEqual(result.skipped.filter((item) =>
    item.reasons.includes('repository discovery cap 2 reached')).map((item) => item.candidate),
  ['flooded/repo#12', 'flooded/repo#13']);

  const db = new DatabaseSync(lake, {readOnly: true});
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM issues WHERE repo_key='flooded/repo'").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM issues WHERE repo_key='later/repo'").get().count, 1);
  db.close();
});

test('discovery target rejects zero, non-integers, and values above the hard cap before search', async () => {
  for (const target of [0, 1.5, DISCOVERY_MAX_TARGET + 1]) {
    await assert.rejects(() => discoverCandidates({target, search: async () => assert.fail('must not search')}),
      /target must be an integer from 1 through 100/);
  }
});
