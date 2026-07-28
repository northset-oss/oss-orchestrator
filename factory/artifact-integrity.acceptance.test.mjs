import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {verifyReadyArtifacts} from './artifact-integrity.mjs';
import {approveBoard, renderBoard} from './board.mjs';
import {runBounded} from './node-worker.mjs';
import {sha256} from './db.mjs';

async function git(args, options = {}) {
  const result = await runBounded('git', args, {timeoutMs: 30_000, ...options});
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function fixture(t, missionId = 'M-1000') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-artifact-integrity-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const repository = path.join(root, 'repo');
  await mkdir(repository);
  await git(['init', '-q', repository]);
  await writeFile(path.join(repository, 'value.mjs'), 'export const value = 1;\n');
  await git(['-C', repository, 'add', '-A']);
  await git(['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '-q', '-m', 'base']);
  const baseOid = await git(['-C', repository, 'rev-parse', 'HEAD']);
  await writeFile(path.join(repository, 'value.mjs'), 'export const value = 2;\n');
  await git(['-C', repository, 'add', '-A']);
  await git(['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '-q', '-m', 'fix']);
  const commitOid = await git(['-C', repository, 'rev-parse', 'HEAD']);
  const testedTreeOid = await git(['-C', repository, 'rev-parse', 'HEAD^{tree}']);
  const patchResult = await runBounded('git', [
    '-C', repository, 'diff', '--binary', '--full-index', baseOid, commitOid,
  ], {timeoutMs: 30_000});
  assert.equal(patchResult.code, 0, patchResult.stderr);
  const patchPath = path.join(root, 'change.patch');
  await writeFile(patchPath, patchResult.stdout);
  return {
    root,
    manifest: {
      mission_id: missionId, repository_path: repository, patch_path: patchPath,
      base_oid: baseOid, commit_oid: commitOid, tested_tree_oid: testedTreeOid,
      patch_sha256: sha256(Buffer.from(patchResult.stdout)),
    },
  };
}

test('durable READY artifacts bind the exact patch, base, commit, and tested tree', async (t) => {
  const {manifest} = await fixture(t);
  const expected = {
    patch_sha256: manifest.patch_sha256,
    base_oid: manifest.base_oid,
    commit_oid: manifest.commit_oid,
    tested_tree_oid: manifest.tested_tree_oid,
  };
  assert.deepEqual(verifyReadyArtifacts(manifest), expected);
  await git(['-C', manifest.repository_path, 'config', 'diff.noprefix', 'true']);
  assert.deepEqual(verifyReadyArtifacts(manifest), expected);
});

test('durable READY artifacts accept the exact canonical seven-character index diff', async (t) => {
  const {manifest} = await fixture(t);
  const compact = await runBounded('git', [
    '-C', manifest.repository_path, 'diff', '--binary', '--abbrev=7',
    manifest.base_oid, manifest.commit_oid,
  ], {timeoutMs: 30_000});
  assert.equal(compact.code, 0, compact.stderr);
  await writeFile(manifest.patch_path, compact.stdout);
  const compactManifest = {...manifest, patch_sha256: sha256(Buffer.from(compact.stdout))};

  assert.deepEqual(verifyReadyArtifacts(compactManifest), {
    patch_sha256: compactManifest.patch_sha256,
    base_oid: manifest.base_oid,
    commit_oid: manifest.commit_oid,
    tested_tree_oid: manifest.tested_tree_oid,
  });
});

test('durable READY artifacts reject a rehashed noncanonical diff', async (t) => {
  const {manifest} = await fixture(t);
  const noPrefix = await runBounded('git', [
    '-C', manifest.repository_path, 'diff', '--binary', '--full-index', '--no-prefix',
    manifest.base_oid, manifest.commit_oid,
  ], {timeoutMs: 30_000});
  assert.equal(noPrefix.code, 0, noPrefix.stderr);
  await writeFile(manifest.patch_path, noPrefix.stdout);
  const rehashed = {...manifest, patch_sha256: sha256(Buffer.from(noPrefix.stdout))};

  assert.throws(() => verifyReadyArtifacts(rehashed), /durable patch bytes do not match/);
});

test('durable READY artifacts bind a commit-pinned PR evidence asset', async (t) => {
  const {manifest} = await fixture(t);
  const repository = manifest.repository_path;
  await git(['-C', repository, 'checkout', '-q', '--detach', manifest.base_oid]);
  const evidencePath = '.github/test-evidence/focused.png';
  await mkdir(path.join(repository, '.github', 'test-evidence'), {recursive: true});
  const evidenceBytes = Buffer.from('fixture-png-bytes');
  await writeFile(path.join(repository, evidencePath), evidenceBytes);
  await git(['-C', repository, 'add', evidencePath]);
  await git(['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '-q', '-m', 'docs: add test evidence']);
  const evidenceCommit = await git(['-C', repository, 'rev-parse', 'HEAD']);
  await git(['-C', repository, 'checkout', '-q', '--detach', manifest.commit_oid]);
  const repositoryName = 'northset/project';
  const evidenceUrl = `https://raw.githubusercontent.com/${repositoryName}/${evidenceCommit}/${evidencePath}`;
  const withEvidence = {
    ...manifest,
    fork_repository: repositoryName,
    branch: 'northset/m-1000',
    pr_body: `Evidence: ${evidenceUrl}\n`,
    evidence_asset: {
      repository: repositoryName,
      branch: 'northset/evidence-m-1000',
      commit_oid: evidenceCommit,
      path: evidencePath,
      sha256: sha256(evidenceBytes),
      url: evidenceUrl,
    },
  };

  const verified = verifyReadyArtifacts(withEvidence);
  assert.deepEqual(verified.evidence_asset, withEvidence.evidence_asset);
  const board = renderBoard({
    board_digest: `sha256:${'f'.repeat(64)}`,
    items: [{mission_id: withEvidence.mission_id, manifest: withEvidence}],
  });
  assert.match(board, new RegExp(`Evidence public action: push .*${withEvidence.evidence_asset.branch}`));
  assert.match(board, new RegExp(withEvidence.evidence_asset.commit_oid));
  assert.match(board, new RegExp(withEvidence.evidence_asset.path.replaceAll('.', '\\.')));
  assert.match(board, new RegExp(withEvidence.evidence_asset.sha256));
  assert.match(board, /public actions/);
  assert.throws(() => verifyReadyArtifacts({
    ...withEvidence,
    evidence_asset: {...withEvidence.evidence_asset, sha256: `sha256:${'0'.repeat(64)}`},
  }), /evidence asset digest/);
  assert.throws(() => verifyReadyArtifacts({
    ...withEvidence,
    evidence_asset: {...withEvidence.evidence_asset, branch: withEvidence.branch},
  }), /evidence and PR branches must be distinct/);

  await git(['-C', repository, 'checkout', '-q', '--detach', manifest.base_oid]);
  await mkdir(path.join(repository, '.github', 'test-evidence'), {recursive: true});
  await writeFile(path.join(repository, evidencePath), evidenceBytes);
  await writeFile(path.join(repository, 'unapproved.txt'), 'extra evidence commit content\n');
  await git(['-C', repository, 'add', evidencePath, 'unapproved.txt']);
  await git(['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '-q', '-m', 'docs: add evidence with extra file']);
  const extraCommit = await git(['-C', repository, 'rev-parse', 'HEAD']);
  await git(['-C', repository, 'checkout', '-q', '--detach', manifest.commit_oid]);
  const extraUrl = `https://raw.githubusercontent.com/${repositoryName}/${extraCommit}/${evidencePath}`;
  assert.throws(() => verifyReadyArtifacts({
    ...withEvidence,
    pr_body: `Evidence: ${extraUrl}\n`,
    evidence_asset: {...withEvidence.evidence_asset, commit_oid: extraCommit, url: extraUrl},
  }), /evidence commit must change exactly the declared asset path/);
});

test('batch approval excludes only the item whose reviewed artifact bytes changed', async (t) => {
  const clean = await fixture(t, 'M-1001');
  const changed = await fixture(t, 'M-1002');
  await writeFile(changed.manifest.patch_path, 'not the reviewed patch\n');
  const digest = `sha256:${'a'.repeat(64)}`;
  let approvedIds;
  const db = {
    getBoard: () => ({
      board_digest: digest,
      items: [clean.manifest, changed.manifest].map((manifest) => ({
        mission_id: manifest.mission_id,
        manifest: {...manifest, risk_tier: 'GREEN', changed_files: [], changed_lines: 0},
      })),
    }),
    approveBoard: (_board, ids) => {
      approvedIds = ids;
      return {approved_mission_ids: ids, rejected_mission_ids: [], invalidated_mission_ids: []};
    },
  };
  const result = approveBoard(db, {board: digest, ids: ['M-1001', 'M-1002']});
  assert.deepEqual(approvedIds, ['M-1001']);
  assert.deepEqual(result.invalidated_mission_ids, ['M-1002']);
  assert.match(result.artifact_errors['M-1002'], /durable patch digest/);
});

test('tampering the reviewed patch or swapping the durable repository is rejected', async (t) => {
  const {root, manifest} = await fixture(t);
  const original = await readFile(manifest.patch_path);
  await writeFile(manifest.patch_path, Buffer.concat([original, Buffer.from('\n# tampered\n')]));
  assert.throws(() => verifyReadyArtifacts(manifest), /durable patch digest/);

  await writeFile(manifest.patch_path, original);
  const unrelated = path.join(root, 'unrelated');
  await mkdir(unrelated);
  await git(['init', '-q', unrelated]);
  assert.throws(() => verifyReadyArtifacts({...manifest, repository_path: unrelated}),
    /durable Git artifact check failed/);
});
