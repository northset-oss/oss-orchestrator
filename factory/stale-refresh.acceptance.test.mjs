import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {createNodeWorker, runBounded} from './node-worker.mjs';
import {receiptUrlFor} from './receipt-publisher.mjs';
import {createStaleRefresher} from './stale-refresh.mjs';

const IMAGE = 'northset-oss-author:test';
const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;

async function temporary(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

async function runGit(args, options = {}) {
  const result = await runBounded('git', args, {timeoutMs: 30_000, ...options});
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function commit(repository, message, {northset = false} = {}) {
  await runGit(['-C', repository, 'add', '-A']);
  const identity = northset
    ? ['-c', 'user.name=Aysajan Eziz', '-c', 'user.email=aeziz@northset.ai']
    : ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test'];
  const args = ['-C', repository, ...identity, 'commit', '-q'];
  if (northset) args.push('-s');
  args.push('-m', message);
  await runGit(args);
  return runGit(['-C', repository, 'rev-parse', 'HEAD']);
}

async function refreshFixture(t) {
  const root = await temporary(t, 'factory-stale-refresh');
  const upstream = path.join(root, 'upstream');
  await mkdir(path.join(upstream, 'src'), {recursive: true});
  await writeFile(path.join(upstream, 'package.json'), `${JSON.stringify({
    name: 'refresh-fixture', private: true, type: 'module', scripts: {test: 'node --test'},
  }, null, 2)}\n`);
  await writeFile(path.join(upstream, 'package-lock.json'), `${JSON.stringify({
    name: 'refresh-fixture', lockfileVersion: 3, requires: true,
    packages: {'': {name: 'refresh-fixture'}},
  }, null, 2)}\n`);
  await writeFile(path.join(upstream, 'src', 'value.mjs'), 'export function value() { return 1; }\n');
  await runGit(['init', '-q', '-b', 'main', upstream]);
  const originalBase = await commit(upstream, 'base');

  const approved = path.join(root, 'approved');
  await runGit(['clone', '-q', '--no-local', upstream, approved]);
  await mkdir(path.join(approved, 'test'));
  await writeFile(path.join(approved, 'test', 'value.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import {value} from '../src/value.mjs';",
    "test('value', () => assert.equal(value(), 2, 'BASE_MARKER_EXPECTED_TWO'));",
    '',
  ].join('\n'));
  await writeFile(path.join(approved, 'src', 'value.mjs'), 'export function value() { return 2; }\n');
  const oldCommit = await commit(approved, 'fix: return expected value', {northset: true});

  await writeFile(path.join(upstream, 'README.md'), '# Unrelated upstream change\n');
  const cleanBase = await commit(upstream, 'docs: add readme');
  await runGit(['-C', upstream, 'checkout', '-q', '-b', 'conflict', originalBase]);
  await writeFile(path.join(upstream, 'src', 'value.mjs'), 'export function value() { return 3; }\n');
  const conflictBase = await commit(upstream, 'refactor: change value differently');
  await runGit(['-C', upstream, 'checkout', '-q', 'main']);

  const receiptUrl = 'https://northset.test/receipts/M-1200/';
  const prBody = `## Summary\n\nReturn the expected value.\n\n${receiptUrl}\n`;
  const manifest = {
    mission_id: 'M-1200', task_id: 'TASK-REFRESH-1',
    repository: 'owner/repo', repository_node_id: 'R_refresh', fork_repository: 'AysajanE/repo',
    repository_path: approved, patch_path: path.join(root, 'old.patch'),
    issue_number: 7, issue_url: 'https://github.com/owner/repo/issues/7',
    base_branch: 'main', branch: 'northset/m-1200', base_oid: originalBase,
    commit_oid: oldCommit, tested_tree_oid: await runGit(['-C', approved, 'rev-parse', 'HEAD^{tree}']),
    patch_sha256: `sha256:${'c'.repeat(64)}`,
    checks: ['node --test test/value.test.mjs'],
    verification: {
      ok: true, claim_type: 'regression_fix', test_command: 'node --test test/value.test.mjs',
      test_only_paths: ['test/value.test.mjs'], base_failure_contains: 'BASE_MARKER_EXPECTED_TWO',
      dependency_install_command: 'npm ci --no-audit --no-fund',
    },
    pr_title: 'fix: return expected value', pr_body: prBody,
    summary: 'Return the expected value.',
    changed_files: [
      {path: 'src/value.mjs', status: 'M', class: 'production', lines: 2},
      {path: 'test/value.test.mjs', status: 'A', class: 'new_test', lines: 4},
    ],
    changed_lines: 6, risk_tier: 'GREEN', risk_warnings: [],
    receipt_claim: {type: 'regression_fix', statement: 'Focused regression failed on base and passed after patch.'},
    receipt_url: receiptUrl,
    planned_actions: ['publish-proof', 'push-approved-commit', 'open-upstream-pr', 'verify-pr-readback'],
    proof: {proof_sha256: `sha256:${'d'.repeat(64)}`},
  };
  await writeFile(manifest.patch_path, (await runBounded('git', [
    '-C', approved, 'diff', '--binary', '--full-index', originalBase, oldCommit,
  ])).stdout);
  return {
    root, upstream, approved, originalBase, oldCommit, cleanBase, conflictBase,
    plan: {mission_id: 'M-1200', task_id: 'TASK-REFRESH-1', manifest},
    manifest,
    artifactRoot: path.join(root, 'artifacts'),
  };
}

function localDockerRun(calls) {
  return async (command, args, options = {}) => {
    if (command !== 'docker') return runBounded(command, args, options);
    calls.push([...args]);
    if (args[0] === 'image') return {code: 0, stdout: `${IMAGE_DIGEST}\n`, stderr: ''};
    if (args.includes('/deps/.northset-ready')) return {code: 0, stdout: '', stderr: ''};
    assert.equal(args[0], 'run');
    const mount = args.find((argument) => typeof argument === 'string' &&
      argument.startsWith('type=bind,src=') && argument.includes(',dst=/workspace,readonly'));
    assert.ok(mount, args.join(' '));
    const checkout = mount.slice('type=bind,src='.length).split(',dst=/workspace,readonly')[0];
    const cleanEnvironment = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !name.startsWith('NODE_TEST')));
    return runBounded('sh', ['-lc', args.at(-1)], {
      cwd: checkout, env: cleanEnvironment,
      timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes,
    });
  };
}

function fetchFrom(upstream) {
  return async (_plan, _live, context) => {
    await runGit(['-C', context.repository_path, 'fetch', '--no-tags', upstream, context.expected_oid]);
    return {base_oid: context.expected_oid};
  };
}

test('S1 clean moved-base refresh keeps the mission and approved artifact while rebuilding verified bytes', async (t) => {
  const fixture = await refreshFixture(t);
  const dockerCalls = [];
  const run = localDockerRun(dockerCalls);
  const worker = createNodeWorker({run, image: IMAGE, codexRunner: async () => assert.fail('refresh must not call a model')});
  const refresher = createStaleRefresher({
    artifactRoot: fixture.artifactRoot,
    run,
    fetchBase: fetchFrom(fixture.upstream),
    invokeWorker: (payload) => worker.handle(payload),
  });
  const approvedHead = await runGit(['-C', fixture.approved, 'rev-parse', 'HEAD']);
  const approvedStatus = await runGit(['-C', fixture.approved, 'status', '--porcelain', '--untracked-files=all']);
  const result = await refresher(fixture.plan, {
    clean: false, refreshable: true, current_base_oid: fixture.cleanBase, reason: 'base moved',
  });
  assert.ok(result.manifest, result.reason);
  const next = result.manifest;
  assert.equal(next.mission_id, 'M-1200');
  assert.equal(next.task_id, 'TASK-REFRESH-1');
  assert.equal(next.base_oid, fixture.cleanBase);
  assert.notEqual(next.commit_oid, fixture.oldCommit);
  assert.equal(await runGit(['-C', next.repository_path, 'rev-parse', 'HEAD^']), fixture.cleanBase);
  assert.equal(await runGit(['-C', next.repository_path, 'status', '--porcelain', '--untracked-files=all']), '');
  assert.equal(next.verification.ok, true);
  assert.equal(next.verification.base_observation.exit_code, 1);
  assert.equal(next.verification.patched_observation.exit_code, 0);
  assert.deepEqual(next.verification.test_only_paths, ['test/value.test.mjs']);
  assert.equal(next.patch_sha256, next.verification.patch_sha256);
  assert.equal(next.tested_tree_oid, next.verification.tested_tree_oid);
  assert.equal(next.verification_path, path.join(path.dirname(next.repository_path), 'verification.json'));
  assert.deepEqual(JSON.parse(await readFile(next.verification_path, 'utf8')), next.verification);
  assert.equal(next.changed_lines, next.verification.changed_lines);
  assert.equal(next.receipt_url, receiptUrlFor('M-1200', next.commit_oid));
  assert.equal(next.pr_body, fixture.manifest.pr_body.replaceAll(
    fixture.manifest.receipt_url, next.receipt_url));
  assert.notEqual(next.branch, fixture.manifest.branch);
  assert.match(next.branch, /^northset\/m-1200-r-[a-f0-9]{12}$/);
  assert.equal(next.proof.base_oid, fixture.cleanBase);
  assert.equal(next.proof.commit_oid, next.commit_oid);
  assert.equal(next.proof.batch_approval_digest, null);
  assert.match(next.proof.proof_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(next.repository_path, fixture.approved);
  assert.equal(await runGit(['-C', fixture.approved, 'rev-parse', 'HEAD']), approvedHead);
  assert.equal(await runGit(['-C', fixture.approved, 'status', '--porcelain', '--untracked-files=all']), approvedStatus);
  assert.equal(dockerCalls.filter((args) => args.includes('/deps/.northset-ready')).length, 1);
  assert.equal(dockerCalls.filter((args) => args.includes('--network=none') &&
    args.some((entry) => String(entry).includes('dst=/workspace,readonly'))).length, 2);
});

test('S2 refresh conflict is recoverable and leaves no replacement artifact or approved mutation', async (t) => {
  const fixture = await refreshFixture(t);
  const run = localDockerRun([]);
  const worker = createNodeWorker({run, image: IMAGE});
  const refresher = createStaleRefresher({
    artifactRoot: fixture.artifactRoot,
    run,
    fetchBase: fetchFrom(fixture.upstream),
    invokeWorker: (payload) => worker.handle(payload),
  });
  const head = await runGit(['-C', fixture.approved, 'rev-parse', 'HEAD']);
  const result = await refresher(fixture.plan, {
    clean: false, refreshable: true, current_base_oid: fixture.conflictBase, reason: 'base moved',
  });
  assert.equal(result.manifest, undefined);
  assert.match(result.reason, /refresh rebase conflict/);
  assert.equal(await runGit(['-C', fixture.approved, 'rev-parse', 'HEAD']), head);
  assert.equal(await runGit(['-C', fixture.approved, 'status', '--porcelain', '--untracked-files=all']), '');
  const missionRoot = path.join(fixture.artifactRoot, 'M-1200');
  assert.deepEqual(await readdir(missionRoot), []);
});

test('S3 refreshed verification failure returns a recoverable reason and removes provisional bytes', async (t) => {
  const fixture = await refreshFixture(t);
  const run = localDockerRun([]);
  const worker = createNodeWorker({
    run,
    image: IMAGE,
    verifier: async () => { throw new Error('focused refreshed verification failed'); },
  });
  const refresher = createStaleRefresher({
    artifactRoot: fixture.artifactRoot,
    run,
    fetchBase: fetchFrom(fixture.upstream),
    invokeWorker: (payload) => worker.handle(payload),
  });
  const result = await refresher(fixture.plan, {
    clean: false, refreshable: true, current_base_oid: fixture.cleanBase, reason: 'base moved',
  });
  assert.equal(result.manifest, undefined);
  assert.match(result.reason, /focused refreshed verification failed/);
  assert.deepEqual(await readdir(path.join(fixture.artifactRoot, 'M-1200')), []);
  assert.equal(await runGit(['-C', fixture.approved, 'rev-parse', 'HEAD']), fixture.oldCommit);
  assert.equal(await runGit(['-C', fixture.approved, 'status', '--porcelain', '--untracked-files=all']), '');
});
