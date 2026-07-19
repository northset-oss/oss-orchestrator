import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {createSourceSeal} from './source-seal.mjs';

function git(repo, args) {
  return execFileSync('git', args, {cwd: repo, encoding: 'utf8'}).trim();
}

async function fixtureRepo({ignoreArtifacts = true} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-source-seal-test-'));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'author-image'), {recursive: true});
  await mkdir(path.join(repo, 'migrations'), {recursive: true});
  await writeFile(path.join(repo, 'profiles.json'), '{"schema_version":1,"profiles":{"node":{}}}\n');
  await writeFile(path.join(repo, 'repo-policy.json'), '{"schema_version":2,"defaults":{}}\n');
  await writeFile(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(path.join(repo, 'author-image', 'Dockerfile'), 'FROM scratch\n');
  await writeFile(path.join(repo, 'candidate-lake.mjs'),
    'export const CANDIDATE_LAKE_SCHEMA_VERSION = 7;\n');
  await writeFile(path.join(repo, 'migrations', '002_add_index.sql'), 'CREATE INDEX example;\n');
  if (ignoreArtifacts) await writeFile(path.join(repo, '.gitignore'), '.phase0-artifacts/\n');
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Seal Test']);
  git(repo, ['config', 'user.email', 'seal-test@example.invalid']);
  git(repo, ['config', 'core.excludesFile', '/dev/null']);
  // Force the complete synthetic fixture into the index even if the operator has a
  // machine-global ignore rule for migration directories.
  git(repo, ['add', '--force', '.']);
  git(repo, ['commit', '-m', 'fixture']);
  const testOutput = path.join(root, 'full-test-output.log');
  await writeFile(testOutput, 'TAP version 13\n1..1\n# pass 1\n');
  return {root, repo, testOutput};
}

test('rejects a dirty worktree before creating artifacts', async (t) => {
  const {root, repo, testOutput} = await fixtureRepo();
  t.after(() => rm(root, {recursive: true, force: true}));
  const output = path.join(repo, '.phase0-artifacts', '2026-07-17', 'source-seal');
  await writeFile(path.join(repo, 'untracked.txt'), 'dirty\n');

  await assert.rejects(
    createSourceSeal({repo, output, testOutputs: [testOutput]}),
    /worktree is dirty/,
  );
  await assert.rejects(stat(output), {code: 'ENOENT'});
});

test('creates a deterministic, verified, unsigned source seal', async (t) => {
  const {root, repo, testOutput} = await fixtureRepo();
  t.after(() => rm(root, {recursive: true, force: true}));
  const first = path.join(repo, '.phase0-artifacts', '2026-07-17', 'seal-a');
  const second = path.join(repo, '.phase0-artifacts', '2026-07-17', 'seal-b');

  const manifestA = await createSourceSeal({repo, output: first, testOutputs: [testOutput]});
  const manifestB = await createSourceSeal({repo, output: second, testOutputs: [testOutput]});

  assert.deepEqual(manifestA, manifestB);
  assert.equal(
    await readFile(path.join(first, 'seal-manifest.json'), 'utf8'),
    await readFile(path.join(second, 'seal-manifest.json'), 'utf8'),
  );
  assert.equal(manifestA.schema_version, 1);
  assert.equal(manifestA.format, 'northset-phase0-source-seal');
  assert.equal(manifestA.git.clean_worktree, true);
  assert.equal(manifestA.git.head_oid, git(repo, ['rev-parse', 'HEAD']));
  assert.equal(manifestA.git.head_ref, 'refs/heads/main');
  assert.equal(git(repo, ['status', '--porcelain=v2']), '');
  assert.equal(manifestA.source_bundle.verified, true);
  assert.match(manifestA.source_bundle.sha256, /^sha256:[0-9a-f]{64}$/);
  execFileSync('git', ['bundle', 'verify', path.join(first, 'source.bundle')], {
    cwd: repo,
    stdio: 'ignore',
  });

  assert.deepEqual(manifestA.inventory.lockfiles.map((item) => item.path), ['package-lock.json']);
  assert.deepEqual(manifestA.inventory.dockerfiles.map((item) => item.path), ['author-image/Dockerfile']);
  assert.deepEqual(manifestA.inventory.profile_registries.map((item) => [item.path, item.schema_version]),
    [['profiles.json', 1]]);
  assert.deepEqual(manifestA.inventory.policy_files.map((item) => [item.path, item.schema_version]),
    [['repo-policy.json', 2]]);
  assert.deepEqual(manifestA.inventory.database_schema_versions,
    [{path: 'candidate-lake.mjs', symbol: 'CANDIDATE_LAKE_SCHEMA_VERSION', version: 7}]);
  assert.deepEqual(manifestA.inventory.migration_files.map((item) => item.path),
    ['migrations/002_add_index.sql']);
  assert.equal(manifestA.test_outputs.length, 1);
  assert.equal(manifestA.test_outputs[0].artifact, 'test-output/test-output-001.log');
  assert.equal(manifestA.signing.status, 'not_performed');
  assert.equal(manifestA.completion.oci_archives, false);
  assert.equal(manifestA.completion.sbom, false);
  assert.equal(manifestA.completion.encrypted_off_machine_copy, false);
  assert.equal(manifestA.completion.clean_vm_restore, false);

  const sidecar = await readFile(path.join(first, 'seal-manifest.sha256'), 'utf8');
  assert.match(sidecar, /^[0-9a-f]{64}  seal-manifest\.json\n$/);
});

test('defaults to the ignored campaign artifact root', async (t) => {
  const {root, repo, testOutput} = await fixtureRepo();
  t.after(() => rm(root, {recursive: true, force: true}));

  await createSourceSeal({repo, testOutputs: [testOutput]});

  const manifest = path.join(repo, '.phase0-artifacts', '2026-07-17', 'source-seal',
    'seal-manifest.json');
  assert.equal((await stat(manifest)).isFile(), true);
  assert.equal(git(repo, ['status', '--porcelain=v2']), '');
});

test('rejects an in-worktree artifact root that Git does not ignore', async (t) => {
  const {root, repo, testOutput} = await fixtureRepo({ignoreArtifacts: false});
  t.after(() => rm(root, {recursive: true, force: true}));
  const output = path.join(repo, '.phase0-artifacts', '2026-07-17', 'source-seal');

  await assert.rejects(
    createSourceSeal({repo, output, testOutputs: [testOutput]}),
    /must be ignored by Git/,
  );
  await assert.rejects(stat(output), {code: 'ENOENT'});
  assert.equal(git(repo, ['status', '--porcelain=v2']), '');
});
