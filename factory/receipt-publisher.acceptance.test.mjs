import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createReceiptPublisher,
  receiptUrlFor,
  runBounded,
} from './receipt-publisher.mjs';

function oid(character) {
  return character.repeat(40);
}

function sha(character) {
  return `sha256:${character.repeat(64)}`;
}

function item(id, character, overrides = {}) {
  const manifest = {
    mission_id: id,
    task_id: `TASK-${id}`,
    repository: 'upstream/project',
    issue_number: 17,
    base_oid: oid('a'),
    patch_sha256: sha(character),
    commit_oid: oid(character),
    tested_tree_oid: oid('d'),
    checks: ['node --test', {command: 'npm test', exit_code: 0}],
    receipt_claim: {type: 'regression_fix', statement: `Verified ${id}`},
    proof: {
      schema_version: 1,
      task_id: `TASK-${id}`,
      repository: 'upstream/project',
      issue_number: 17,
      base_oid: oid('a'),
      patch_sha256: sha(character),
      commit_oid: oid(character),
      tested_tree_oid: oid('d'),
      checks: ['node --test', {command: 'npm test', exit_code: 0}],
      environment: {image: 'sha256:fixture'},
      claim: {type: 'regression_fix', statement: `Verified ${id}`},
      batch_approval_digest: null,
      proof_sha256: sha('f'),
    },
    ...overrides.manifest,
  };
  return {
    mission_id: id,
    commit_oid: manifest.commit_oid,
    patch_sha256: manifest.patch_sha256,
    tested_tree_oid: manifest.tested_tree_oid,
    receipt_claim: manifest.receipt_claim,
    approval_digest: overrides.approval_digest ?? sha('e'),
    manifest,
    ...overrides.item,
  };
}

async function temporary(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

async function git(args, options = {}) {
  const result = await runBounded('git', args, {timeoutMs: 30_000, maxOutputBytes: 1024 * 1024, ...options});
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function bareRepository(t) {
  const root = await temporary(t, 'factory-receipt-publisher');
  const bare = path.join(root, 'ledger.git');
  const seed = path.join(root, 'seed');
  await git(['init', '--bare', '--quiet', bare]);
  await git(['init', '--quiet', seed]);
  await writeFile(path.join(seed, 'README.md'), '# Receipt ledger fixture\n');
  await git(['-C', seed, 'add', 'README.md']);
  await git(['-C', seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '--quiet', '-m', 'seed']);
  await git(['-C', seed, 'branch', '-M', 'main']);
  await git(['-C', seed, 'remote', 'add', 'origin', bare]);
  await git(['-C', seed, 'push', '--quiet', 'origin', 'main']);
  await git(['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  return {root, bare};
}

function recordingRunner(calls) {
  return async (command, args, options) => {
    calls.push({command, args: [...args], options: {...options}});
    return runBounded(command, args, options);
  };
}

async function remoteBytes(bare, relativePath) {
  const result = await runBounded('git', ['--git-dir', bare, 'show', `receipts:${relativePath}`], {
    timeoutMs: 30_000, maxOutputBytes: 1024 * 1024,
  });
  assert.equal(result.code, 0, result.stderr);
  return Buffer.from(result.stdout, 'utf8');
}

test('receiptUrlFor uses the immutable contribution-commit path', () => {
  assert.equal(receiptUrlFor('M-1000', oid('a')),
    `https://github.com/northset-oss/verification-pilot/blob/receipts/receipts/M-1000/${oid('a')}/proof.json`);
  assert.throws(() => receiptUrlFor('../M-1000', oid('a')), /invalid mission_id/);
});

test('one non-force batch push publishes deterministic exact proof bytes from an isolated clone', async (t) => {
  const {root, bare} = await bareRepository(t);
  const sibling = path.join(root, 'dirty-sibling');
  await mkdir(sibling);
  await writeFile(path.join(sibling, 'operator-work.txt'), 'must remain untouched\n');
  const calls = [];
  const publisher = createReceiptPublisher({
    remoteUrl: bare,
    run: recordingRunner(calls),
    tempRoot: root,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  });
  const first = item('M-1000', 'b');
  const second = item('M-1001', 'c');
  const result = await publisher([second, first]);

  const pushes = calls.filter((call) => call.args.includes('push'));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].options.shell, false);
  assert.doesNotMatch(pushes[0].args.join(' '), /--force|-f\b/);
  assert.equal(await readFile(path.join(sibling, 'operator-work.txt'), 'utf8'), 'must remain untouched\n');

  for (const entry of [first, second]) {
    const id = entry.mission_id;
    const relativePath = `receipts/${id}/${entry.commit_oid}/proof.json`;
    const bytes = await remoteBytes(bare, relativePath);
    const proof = JSON.parse(bytes);
    assert.equal(proof.mission_id, id);
    assert.equal(proof.base_oid, entry.manifest.base_oid);
    assert.equal(proof.patch_sha256, entry.manifest.patch_sha256);
    assert.equal(proof.commit_oid, entry.manifest.commit_oid);
    assert.equal(proof.tested_tree_oid, entry.manifest.tested_tree_oid);
    assert.deepEqual(proof.checks, entry.manifest.checks);
    assert.deepEqual(proof.claim, entry.manifest.receipt_claim);
    assert.equal(proof.batch_approval_digest, entry.approval_digest);
    assert.equal(proof.proof_sha256, undefined);
    assert.equal(result[id].mission_id, id);
    assert.equal(result[id].receipt_url, receiptUrlFor(id, entry.commit_oid));
    assert.equal(result[id].proof_sha256,
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    assert.match(result[id].batch_commit_oid, /^[a-f0-9]{40}$/);
    assert.equal(result[id].batch_approval_digest, entry.approval_digest);
  }
  assert.equal(result['M-1000'].batch_commit_oid, result['M-1001'].batch_commit_oid);
  assert.equal(await git(['--git-dir', bare, 'rev-list', '--count', 'receipts']), '1');
});

test('a retry adopts identical remotely committed proof files without another push', async (t) => {
  const {root, bare} = await bareRepository(t);
  const calls = [];
  const publisher = createReceiptPublisher({
    remoteUrl: bare, run: recordingRunner(calls), tempRoot: root,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  });
  const batch = [item('M-1000', 'b'), item('M-1001', 'c')];
  const first = await publisher(batch);
  await publisher([item('M-1002', 'd')]);
  const adopted = await publisher(batch);

  assert.deepEqual(adopted, first);
  assert.equal(calls.filter((call) => call.args.includes('push')).length, 2);
  assert.equal(await git(['--git-dir', bare, 'rev-list', '--count', 'receipts']), '2');
});

test('an existing proof with different approved bytes is rejected and never overwritten', async (t) => {
  const {root, bare} = await bareRepository(t);
  const calls = [];
  const publisher = createReceiptPublisher({
    remoteUrl: bare, run: recordingRunner(calls), tempRoot: root,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  });
  const original = item('M-1000', 'b');
  await publisher([original]);
  const changed = item('M-1000', 'b', {
    manifest: {
      checks: ['node --test changed'],
      proof: {
        schema_version: 1,
        base_oid: oid('a'), patch_sha256: sha('b'), commit_oid: oid('b'), tested_tree_oid: oid('d'),
        checks: ['node --test changed'], claim: original.manifest.receipt_claim,
      },
    },
  });

  await assert.rejects(() => publisher([changed]), (error) =>
    error.code === 'RECEIPT_PROOF_CONFLICT' && /already exists/.test(error.message));
  assert.equal(calls.filter((call) => call.args.includes('push')).length, 1);
  const bytes = await remoteBytes(bare, `receipts/M-1000/${oid('b')}/proof.json`);
  assert.deepEqual(JSON.parse(bytes).checks, original.manifest.checks);
});

test('stale rebases append a new commit-specific proof and approval digest is mandatory', async (t) => {
  const {root, bare} = await bareRepository(t);
  const publisher = createReceiptPublisher({
    remoteUrl: bare, tempRoot: root, now: () => new Date('2026-07-19T12:00:00.000Z'),
  });
  const original = item('M-1000', 'b');
  await assert.rejects(() => publisher([{...original, approval_digest: null}]), /non-null sha256 digest/);
  await publisher([original]);
  const rebased = item('M-1000', 'c', {
    manifest: {base_oid: oid('e'), tested_tree_oid: oid('f'), proof: null},
  });
  await publisher([rebased]);

  const originalProof = JSON.parse(await remoteBytes(bare, `receipts/M-1000/${oid('b')}/proof.json`));
  const rebasedProof = JSON.parse(await remoteBytes(bare, `receipts/M-1000/${oid('c')}/proof.json`));
  assert.equal(originalProof.commit_oid, oid('b'));
  assert.equal(rebasedProof.commit_oid, oid('c'));
  assert.equal(rebasedProof.base_oid, oid('e'));
  assert.equal(await git(['--git-dir', bare, 'rev-list', '--count', 'receipts']), '2');
});
