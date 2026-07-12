import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {
  assertBindingChain, buildReceipt, classifyChangedFiles, manifestDigest, runAuthorContainer,
  runVerifierContainer,
} from './oss.mjs';
import {OSS_IDENTITY, RECEIPT_FOOTER, assertOssCommitIdentity, prBody} from './runner.mjs';

const oid = (char) => char.repeat(40);
const digest = (char) => `sha256:${char.repeat(64)}`;

test('classifyChangedFiles flags modified and deleted existing tests', () => {
  const classes = classifyChangedFiles(
    ['src/index.mjs', 'test/existing.test.mjs', 'spec/deleted_spec.rb'],
    ['src/index.mjs', 'test/existing.test.mjs', 'spec/deleted_spec.rb', 'test/new.test.mjs'],
  );
  assert.deepEqual(classes, [
    {path: 'spec/deleted_spec.rb', class: 'modified-existing-test', flagged: true},
    {path: 'src/index.mjs', class: 'source', flagged: false},
    {path: 'test/existing.test.mjs', class: 'modified-existing-test', flagged: true},
    {path: 'test/new.test.mjs', class: 'added-test', flagged: false},
  ]);
});

test('classifyChangedFiles flags package script and CI/check mutations', () => {
  const classes = classifyChangedFiles(
    ['package.json', '.github/workflows/test.yml', 'scripts/check.mjs'],
    [
      {path: 'package.json', before: {'scripts': {'test': 'npm run unit'}}, after: {'scripts': {'test': 'true'}}},
      '.github/workflows/test.yml',
      'scripts/check.mjs',
    ],
  );
  assert.ok(classes.every((item) => item.class === 'check-or-CI-config' && item.flagged));
});

function receiptInput(overrides = {}) {
  return {
    candidate: 'owner/repo#1', repo: 'owner/repo', base_commit: oid('a'),
    patch_sha256: digest('b'), tested_tree_oid: oid('c'), commit_oid: oid('d'),
    check_command: 'npm test', verifier_image_digest: digest('e'), dep_material_digest: digest('f'),
    exit: 0, output: 'SECRET original bytes', redacted_output: '[REDACTED] original bytes',
    verifier_version: 'oss-prepare-v1', changed_file_classes: [], ...overrides,
  };
}

test('buildReceipt hashes original output while returning redacted output separately', () => {
  const input = receiptInput();
  const receipt = buildReceipt(input);
  const separatelyStoredRedactedOutput = input.redacted_output;
  const expected = `sha256:${createHash('sha256').update('SECRET original bytes').digest('hex')}`;
  assert.equal(receipt.output_sha256, expected);
  assert.equal(separatelyStoredRedactedOutput, '[REDACTED] original bytes');
  assert.equal('output' in receipt, false);
  assert.equal('redacted_output' in receipt, false);
});

test('buildReceipt fails closed without a green verifier and explicit original output', () => {
  assert.throws(() => buildReceipt(receiptInput({exit: 1})), /requires verifier exit 0/);
  const absent = receiptInput();
  delete absent.output;
  assert.throws(() => buildReceipt(absent), /requires original verifier output/);
  assert.doesNotThrow(() => buildReceipt(receiptInput({output: ''})));
});

function readyPack(overrides = {}) {
  return {
    diff: 'diff --git a/x b/x\n+change', commit_oid: oid('d'),
    receipt_subject: buildReceipt(receiptInput()),
    pr_title: 'fix: thing', pr_body: 'body', repo: 'owner/repo',
    planned_actions: ['fork', 'push', 'attest', 'open-pr', 'append-ledger'], ...overrides,
  };
}

test('manifestDigest is order-stable and binds every selected field', () => {
  const a = readyPack();
  const b = readyPack({diff: 'second diff', commit_oid: oid('1')});
  assert.equal(manifestDigest([a, b]), manifestDigest([b, a]));
  for (const [field, replacement] of [
    ['diff', 'mutated'], ['commit_oid', oid('2')], ['receipt_subject', {...a.receipt_subject, exit: 9}],
    ['pr_title', 'mutated'], ['pr_body', 'mutated'], ['repo', 'elsewhere/repo'],
    ['planned_actions', ['push']],
  ]) {
    assert.notEqual(manifestDigest([a]), manifestDigest([{...a, [field]: replacement}]), field);
  }
});

test('assertBindingChain validates subjects and remote commit equality', () => {
  const chain = {patch_sha256: digest('a'), tested_tree_oid: oid('b'), commit_oid: oid('c')};
  assert.equal(assertBindingChain(chain), true);
  assert.equal(assertBindingChain({...chain, pushed_oid: oid('c'), pr_head_oid: oid('c')}), true);
  assert.throws(() => assertBindingChain({...chain, pushed_oid: oid('d')}), /binding mismatch/);
  assert.throws(() => assertBindingChain({...chain, pr_head_oid: oid('d')}), /binding mismatch/);
  assert.throws(() => assertBindingChain({...chain, patch_sha256: 'bad'}), /invalid patch_sha256/);
});

test('reused identity verifier is fail-closed for identity and DCO', () => {
  const body = `detail\n\nSigned-off-by: ${OSS_IDENTITY.name} <${OSS_IDENTITY.email}>`;
  assert.doesNotThrow(() => assertOssCommitIdentity({
    authorEmail: OSS_IDENTITY.email, committerEmail: OSS_IDENTITY.email, body,
  }));
  assert.throws(() => assertOssCommitIdentity({authorEmail: 'wrong@example.com', committerEmail: OSS_IDENTITY.email, body}));
  assert.throws(() => assertOssCommitIdentity({authorEmail: OSS_IDENTITY.email, committerEmail: OSS_IDENTITY.email, body: 'no trailer'}));
});

test('drafted PR body contains the mandatory receipt footer', () => {
  const spec = {
    candidate: 'owner/repo#123', issue_url: 'https://github.com/owner/repo/issues/123',
    executor: {commands: ['npm test']},
  };
  const body = prBody(spec, {changedFiles: ['src/index.mjs']});
  assert.ok(body.includes(RECEIPT_FOOTER));
});

test('dry-run container plans are hardened, separated, pinned, and task-bound', async () => {
  const imageDigest = `node:22-bookworm@${digest('9')}`;
  const spec = {
    candidate: 'owner/repo#123', target_repo: 'https://github.com/owner/repo',
    issue_url: 'https://github.com/owner/repo/issues/123', base_commit: oid('a'),
    code_prompt: 'Fix the focused parser defect and add its regression test.',
    executor: {
      image: 'node:22-bookworm', verifier_image_digest: imageDigest,
      install_commands: ['npm ci'], commands: ['npm test -- parser'],
      limits: {cpus: 3, memory_mb: 2048, pids: 321},
    },
  };
  const dirs = {authorWorkspace: '/runs/M-123/author', verifierWorkspace: '/runs/M-123/verifier'};
  const author = await runAuthorContainer(spec, dirs, {dryRun: true});
  const verifier = await runVerifierContainer(spec, dirs, 'committed patch', {dryRun: true});

  for (const plan of [author.docker, verifier.docker]) {
    assert.ok(plan.includes('--rm'));
    assert.deepEqual(plan.slice(plan.indexOf('--user'), plan.indexOf('--user') + 2), ['--user', '10001:10001']);
    assert.deepEqual(plan.slice(plan.indexOf('--security-opt'), plan.indexOf('--security-opt') + 2), ['--security-opt', 'no-new-privileges']);
    assert.ok(plan.includes('--cap-drop=ALL'));
    assert.deepEqual(plan.slice(plan.indexOf('--cpus'), plan.indexOf('--cpus') + 2), ['--cpus', '3']);
    assert.deepEqual(plan.slice(plan.indexOf('--memory'), plan.indexOf('--memory') + 2), ['--memory', '2048m']);
    assert.deepEqual(plan.slice(plan.indexOf('--pids-limit'), plan.indexOf('--pids-limit') + 2), ['--pids-limit', '321']);
    assert.equal(plan.filter((arg) => arg === '--mount').length, 1);
    assert.equal(plan.includes('-v'), false);
    assert.equal(plan.includes('--volume'), false);
  }
  assert.match(author.docker[author.docker.indexOf('--mount') + 1], /src=\/runs\/M-123\/author,dst=\/workspace$/);
  assert.equal(author.docker.includes('--network=none'), false);
  assert.match(verifier.docker[verifier.docker.indexOf('--mount') + 1], /src=\/runs\/M-123\/verifier,dst=\/workspace$/);
  assert.ok(verifier.docker.includes('--network=none'));
  assert.ok(verifier.docker.includes(imageDigest));
  assert.equal(verifier.check, 'npm test -- parser');
  assert.match(verifier.docker.at(-1), /npm test -- parser/);

  const codexText = author.codex.join(' ');
  assert.match(codexText, /https:\/\/github.com\/owner\/repo\/issues\/123/);
  assert.match(codexText, /focused parser defect/);
  assert.match(codexText, /npm test -- parser/);
});
