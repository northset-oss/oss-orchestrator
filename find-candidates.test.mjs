import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, chmod} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

import {
  candidateKey,
  dedupeAndFilter,
  extractIssueKeys,
  parseCount,
  parseSearchRepos,
  parseSearchLabels,
  parseSearchLimit,
  parseStarsMin,
  parseSearchTerms,
} from './find-candidates.mjs';

test('accepts only a positive integer candidate count', () => {
  assert.equal(parseCount('12'), 12);
  for (const value of ['', '0', '-1', '1.5', 'ten']) {
    assert.throws(() => parseCount(value), /positive integer/);
  }
});

test('uses a ten-star default and validates an explicit repository-star floor', () => {
  assert.equal(parseStarsMin(undefined), 10);
  assert.equal(parseStarsMin('100'), 100);
  assert.throws(() => parseStarsMin('0'), /positive integer/);
});

test('uses the computed search limit and validates an explicit GitHub result cap', () => {
  assert.equal(parseSearchLimit(undefined, 400), 400);
  assert.equal(parseSearchLimit('50', 400), 50);
  assert.throws(() => parseSearchLimit('1001', 400), /at most 1000/);
});

test('uses conservative default labels and parses an explicit expanded label set', () => {
  assert.deepEqual(parseSearchLabels(undefined), ['good first issue', 'help wanted']);
  assert.deepEqual(parseSearchLabels('bug, enhancement,bug, feature request'),
    ['bug', 'enhancement', 'feature request']);
  assert.throws(() => parseSearchLabels(' , '), /at least one label/);
});

test('parses optional high-signal search terms without duplicates', () => {
  assert.deepEqual(parseSearchTerms(undefined), []);
  assert.deepEqual(parseSearchTerms('add tests, regression test,add tests'),
    ['add tests', 'regression test']);
  assert.throws(() => parseSearchTerms(' , '), /at least one term/);
});

test('parses and validates an optional targeted repository list', () => {
  assert.deepEqual(parseSearchRepos(undefined), []);
  assert.deepEqual(parseSearchRepos('owner/repo, other/project,owner/repo'),
    ['owner/repo', 'other/project']);
  assert.throws(() => parseSearchRepos('not-a-repo'), /owner\/repo/);
});

test('extracts issue keys from prior registers and GitHub URLs', () => {
  const keys = extractIssueKeys(`
    owner/repo#12
    https://github.com/other/project/issues/34
    https://github.com/other/project/pull/99
  `);
  assert.deepEqual([...keys].sort(), ['other/project#34', 'owner/repo#12']);
});

test('deduplicates, excludes prior work, filters low-value work, and caps repository concentration', () => {
  const issues = [
    issue('one/repo', 1, 'Small parser bug'),
    issue('one/repo', 1, 'Duplicate'),
    issue('one/repo', 2, 'Second focused bug'),
    issue('one/repo', 3, 'Third focused bug'),
    issue('two/repo', 4, 'Translate the README'),
    issue('three/repo', 5, 'Fix deterministic output'),
    issue('spam/bounties', 6, 'Implement a parser'),
  ];
  const result = dedupeAndFilter(issues, new Set(['one/repo#2']), 1);
  assert.deepEqual(result.candidates.map(candidateKey), ['one/repo#1', 'three/repo#5']);
  assert.equal(result.skippedSeen, 1);
  assert.equal(result.skippedLowValue, 2);
});

test('runs the real command flow against fake gh and reviewer tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'find-candidates-test-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const gh = path.join(bin, 'gh');
  await writeFile(gh, `#!/bin/sh
if [ "$1" = "search" ] && [ "$2" = "prs" ]; then
  echo '[]'
  exit 0
fi
cat <<'JSON'
[
  {"number":1,"title":"Rejected bug","url":"https://github.com/a/one/issues/1","repository":{"nameWithOwner":"a/one"},"labels":[{"name":"good first issue"}],"assignees":[],"updatedAt":"2026-07-12T00:00:00Z"},
  {"number":2,"title":"Accepted bug","url":"https://github.com/b/two/issues/2","repository":{"nameWithOwner":"b/two"},"labels":[{"name":"help wanted"}],"assignees":[],"updatedAt":"2026-07-12T00:00:00Z"},
  {"number":3,"title":"Another accepted bug","url":"https://github.com/c/three/issues/3","repository":{"nameWithOwner":"c/three"},"labels":[{"name":"good first issue"}],"assignees":[],"updatedAt":"2026-07-12T00:00:00Z"}
]
JSON
`);
  await chmod(gh, 0o755);

  const reviewer = path.join(root, 'reviewer.mjs');
  await writeFile(reviewer, `
const key = process.argv[2];
const accept = !key.includes('a/one');
process.stdout.write(JSON.stringify({
  verdict: accept ? 'ACCEPT' : 'REJECT', candidate: key,
  issue_url: 'https://github.com/' + key.replace('#', '/issues/'),
  summary: accept ? 'Suitable.' : 'Not suitable.', reasons: [], checks: {},
  source_evidence: accept ? ['src/file.js:1'] : [],
  test_command: accept ? 'npm test' : null, process_requirements: [], base_commit: 'a'.repeat(40),
  tier: accept ? 'A' : null, executor_profile: accept ? 'node' : null
}));
process.exit(accept ? 0 : 2);
`);

  const output = path.join(root, 'batch.json');
  const history = path.join(root, 'history.jsonl');
  const result = await command(process.execPath, [path.join(import.meta.dirname, 'find-candidates.mjs'), '2'], {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    OSS_FIND_REVIEW_SCRIPT: reviewer,
    OSS_FIND_HISTORY: history,
    OSS_FIND_OUTPUT: output,
    OSS_FIND_EXCLUDE_FILES: '',
    OSS_FIND_CONCURRENCY: '2',
  });

  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.requested, 2);
  assert.equal(report.found, 2);
  assert.equal(report.complete, true);
  assert.deepEqual(report.search_labels, ['good first issue', 'help wanted']);
  assert.deepEqual(report.candidates.map((item) => item.candidate).sort(), ['b/two#2', 'c/three#3']);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), report);
  assert.equal((await readFile(history, 'utf8')).trim().split('\n').length, 3);
});

function issue(repository, number, title, labels = ['good first issue']) {
  return {
    number, title, url: `https://github.com/${repository}/issues/${number}`,
    repository: {nameWithOwner: repository}, labels: labels.map((name) => ({name})),
    assignees: [], updatedAt: '2026-07-12T00:00:00Z',
  };
}

function command(program, args, env) {
  return new Promise((resolve) => {
    const child = spawn(program, args, {env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({code, stdout, stderr}));
  });
}
