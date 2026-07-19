import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {verifyReadyArtifacts} from './artifact-integrity.mjs';
import {approveBoard} from './board.mjs';
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
  assert.deepEqual(verifyReadyArtifacts(manifest), {
    patch_sha256: manifest.patch_sha256,
    base_oid: manifest.base_oid,
    commit_oid: manifest.commit_oid,
    tested_tree_oid: manifest.tested_tree_oid,
  });
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
