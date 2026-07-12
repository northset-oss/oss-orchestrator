import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertOssCommitIdentity,
  codexConfigText,
  manualShipLines,
  OSS_IDENTITY,
  parseArgs,
  prepareMissionDir,
  resultExitCode,
  safeMissionBase,
  scanNextStepLines,
  selectSpecs,
  timelineApiArgs,
  timelineCrossReferences,
  validateSpecs,
} from './runner.mjs';

function spec(overrides = {}) {
  return {
    mission_id: 'M-010',
    candidate: 'owner/repo#123',
    target_repo: 'https://github.com/owner/repo',
    issue_url: 'https://github.com/owner/repo/issues/123',
    base_commit: 'a'.repeat(40),
    code_prompt: 'Make the smallest tested fix.',
    executor: {
      image: 'node:22-bookworm',
      install_commands: ['npm ci'],
      commands: ['npm test'],
      limits: {},
    },
    ...overrides,
  };
}

test('validates a normal mission spec', () => {
  assert.doesNotThrow(() => validateSpecs([spec()]));
});

test('rejects traversal and duplicate mission IDs', () => {
  assert.throws(() => validateSpecs([spec({mission_id: '../../northset-oss'})]), /mission_id/);
  assert.throws(() => validateSpecs([spec(), spec()]), /duplicate mission_id/);
});

test('requires candidate, issue URL, and target repository to identify the same issue', () => {
  assert.throws(
    () => validateSpecs([spec({target_repo: 'https://github.com/owner/other'})]),
    /target_repo.*candidate/i,
  );
  assert.throws(
    () => validateSpecs([spec({issue_url: 'https://github.com/owner/repo/issues/999'})]),
    /issue_url.*candidate/i,
  );
  assert.throws(
    () => validateSpecs([spec({target_repo: 'https://token@github.com/owner/repo'})]),
    /credentials/i,
  );
});

test('--only selects an exact parsed mission ID rather than a filename prefix', () => {
  const specs = [spec(), spec({mission_id: 'M-0100', candidate: 'owner/repo#124', issue_url: 'https://github.com/owner/repo/issues/124'})];
  assert.deepEqual(selectSpecs(specs, 'M-010'), [specs[0]]);
});

test('mission output must be an immediate child of the output directory', () => {
  const out = '/tmp/oss-orchestrator-runs';
  assert.equal(safeMissionBase(out, 'M-010'), path.join(out, 'M-010'));
  assert.throws(() => safeMissionBase(out, '../escape'), /mission_id/);
});

test('recheck-only preserves completed artifacts; rebuild requires --replace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oss-runner-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const base = path.join(root, 'M-010');
  await mkdir(base);
  const sentinel = path.join(base, 'reviewed-artifact');
  await writeFile(sentinel, 'keep');

  await prepareMissionDir(base, {recheckOnly: true, replace: false});
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');

  await assert.rejects(
    prepareMissionDir(base, {recheckOnly: false, replace: false}),
    /already exists.*--replace/i,
  );

  await prepareMissionDir(base, {recheckOnly: false, replace: true});
  await assert.rejects(access(sentinel));
});

test('FAILED missions make the process fail while SKIP remains an expected result', () => {
  assert.equal(resultExitCode([{state: 'READY'}, {state: 'SKIP'}]), 0);
  assert.equal(resultExitCode([{state: 'READY'}, {state: 'FAILED'}]), 1);
  assert.equal(resultExitCode([{state: 'CLEAN'}], {recheckOnly: true}), 0);
  assert.equal(resultExitCode([{state: 'SKIP'}], {recheckOnly: true}), 1);
});

test('manual handoff pins the exact commit and performs two pre-outbound rechecks', () => {
  const lines = manualShipLines({
    mission_id: 'M-010',
    candidate: 'owner/repo#123',
    dirs: {work: '/tmp/work'},
    patchInfo: {
      baseCommit: 'a'.repeat(40),
      patchCommit: 'b'.repeat(40),
      patchDiffHash: `sha256:${'c'.repeat(64)}`,
    },
    receipt: {bundleDigest: `sha256:${'d'.repeat(64)}`},
  }, {specsDir: '/tmp/custom-specs', outDir: '/tmp/custom-runs'});
  const text = lines.join('\n');
  assert.match(text, /a{40}/);
  assert.match(text, /b{40}/);
  assert.match(text, /sha256:c{64}/);
  assert.match(text, /sha256:d{64}/);
  assert.equal((text.match(/--recheck-only/g) ?? []).length, 2);
  assert.equal((text.match(/--specs/g) ?? []).length, 2);
  assert.equal((text.match(/--out/g) ?? []).length, 2);
  assert.match(text, /b{40}:refs\/heads\/northset\/M-010/);
});

test('Codex profile denies host reads and disables integrations and network', () => {
  const text = codexConfigText();
  assert.match(text, /default_permissions = "mission-workspace"/);
  assert.match(text, /":root" = "deny"/);
  assert.match(text, /":minimal" = "read"/);
  assert.match(text, /enabled = false/);
  assert.match(text, /web_search = "disabled"/);
  assert.match(text, /apps = false/);
  assert.doesNotMatch(text, /":tmpdir" = "deny"/);
  assert.match(text, /":slash_tmp" = "deny"/);
  assert.doesNotMatch(text, /sandbox_mode/);
});

test('OSS commit identity is the enforced single source of truth', () => {
  assert.equal(OSS_IDENTITY.email, 'aeziz@northset.ai');
  assert.equal(OSS_IDENTITY.name, 'Aysajan Eziz');
});

test('assertOssCommitIdentity fails closed on the host identity or a missing DCO sign-off', () => {
  const good = {
    authorEmail: 'aeziz@northset.ai',
    committerEmail: 'aeziz@northset.ai',
    body: 'Signed-off-by: Aysajan Eziz <aeziz@northset.ai>',
  };
  assert.doesNotThrow(() => assertOssCommitIdentity(good));
  // the exact recurring bug: the clone inherited the host's personal gmail identity
  assert.throws(() => assertOssCommitIdentity({ ...good, authorEmail: 'aysajan1986@gmail.com' }), /identity must be aeziz@northset\.ai/);
  assert.throws(() => assertOssCommitIdentity({ ...good, committerEmail: 'aysajan1986@gmail.com' }), /identity must be aeziz@northset\.ai/);
  // committed without -s
  assert.throws(() => assertOssCommitIdentity({ ...good, body: '' }), /DCO sign-off/);
});

test('--receipt selects the ship pass and refuses flags that would corrupt a scanned mission', () => {
  assert.equal(parseArgs(['--receipt']).receipt, true);
  assert.throws(() => parseArgs(['--receipt', '--recheck-only']), /mutually exclusive/);
  assert.throws(() => parseArgs(['--receipt', '--replace']), /--replace does not apply/);
});

test('scan hands off one per-mission receipt command that pins specs, out, and mission id', () => {
  const coded = [
    {mission_id: 'M-010', candidate: 'owner/repo#123'},
    {mission_id: 'M-011', candidate: 'owner/repo#124'},
  ];
  const text = scanNextStepLines(coded, {specsDir: '/tmp/s', outDir: '/tmp/o'}).join('\n');
  assert.match(text, /--receipt --only 'M-010'/);
  assert.match(text, /--receipt --only 'M-011'/);
  assert.match(text, /--specs '\/tmp\/s'/);
  assert.match(text, /--out '\/tmp\/o'/);
  // exactly one authorization command per approved mission — no batch that could ship an unreviewed diff
  assert.equal((text.match(/--receipt/g) ?? []).length, 2);
});

test('timeline API pagination is slurped into one parseable JSON array', () => {
  const args = timelineApiArgs('owner', 'repo', 123);
  assert.ok(args.includes('--paginate'));
  assert.ok(args.includes('--slurp'));
  assert.ok(!args.includes('--jq'));
  assert.deepEqual(timelineCrossReferences([
    [{event: 'commented'}, {event: 'cross-referenced', source: {issue: {html_url: 'https://example/pr/1', state: 'closed', title: 'one', pull_request: {}}}}],
    [{event: 'cross-referenced', source: {issue: {html_url: 'https://example/pr/2', state: 'open', title: 'two', pull_request: {}}}}],
  ]), [
    {source: 'https://example/pr/1', state: 'closed', title: 'one', is_pr: true},
    {source: 'https://example/pr/2', state: 'open', title: 'two', is_pr: true},
  ]);
});
