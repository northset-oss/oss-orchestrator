import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(here, 'verify-source-restore.sh');
const sqliteBin = execFileSync('sh', ['-c', 'command -v sqlite3'], {encoding: 'utf8'}).trim();
const credentialNames = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'SSH_AUTH_SOCK',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
  'OPENAI_API_KEY', 'CODEX_API_KEY',
];

function credentialFreeEnvironment(extra = {}) {
  const environment = {...process.env};
  for (const name of credentialNames) delete environment[name];
  return {...environment, ...extra};
}

function git(repo, args) {
  return execFileSync('git', args, {cwd: repo, encoding: 'utf8'}).trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-restore-test-'));
  const repo = path.join(root, 'source');
  const seal = path.join(root, 'seal');
  await mkdir(repo);
  await mkdir(seal);
  await writeFile(path.join(repo, 'profiles.json'), '{"schema_version":1}\n');
  await writeFile(path.join(repo, 'smoke.test.mjs'), [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "test('restored suite ran', () => assert.equal(2 + 2, 4));",
    '',
  ].join('\n'));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Restore Test']);
  git(repo, ['config', 'user.email', 'restore@example.invalid']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'fixture']);
  git(repo, ['bundle', 'create', path.join(seal, 'source.bundle'), '--all']);

  const head = git(repo, ['rev-parse', 'HEAD']);
  const tree = git(repo, ['rev-parse', 'HEAD^{tree}']);
  const bundleSha = execFileSync('shasum', ['-a', '256', path.join(seal, 'source.bundle')], {
    encoding: 'utf8',
  }).split(/\s+/)[0];
  const profileSha = execFileSync('shasum', ['-a', '256', path.join(repo, 'profiles.json')], {
    encoding: 'utf8',
  }).split(/\s+/)[0];
  const manifest = {
    schema_version: 1,
    format: 'northset-phase0-source-seal',
    source_bundle: {artifact: 'source.bundle', sha256: `sha256:${bundleSha}`},
    git: {head_oid: head, head_tree_oid: tree},
    environment: {node: {version: process.version}},
    inventory: {
      lockfiles: [],
      dockerfiles: [],
      profile_registries: [{path: 'profiles.json', sha256: `sha256:${profileSha}`}],
      migration_files: [],
      policy_files: [],
    },
  };
  const manifestPath = path.join(seal, 'seal-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const manifestSha = execFileSync('shasum', ['-a', '256', manifestPath], {encoding: 'utf8'})
    .split(/\s+/)[0];
  await writeFile(path.join(seal, 'seal-manifest.sha256'), `${manifestSha}  seal-manifest.json\n`);
  return {root, seal};
}

test('restores the sealed repository and emits complete evidence', async () => {
  const {root, seal} = await fixture();
  const output = path.join(root, 'restore-evidence');
  const result = spawnSync('bash', [verifier, seal, output, process.execPath, sqliteBin], {
    encoding: 'utf8',
    env: credentialFreeEnvironment(),
    cwd: root,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(await readFile(path.join(output, 'restore-result.json'), 'utf8'));
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.bundle_sha256_match, true);
  assert.equal(evidence.head_oid_match, true);
  assert.equal(evidence.head_tree_oid_match, true);
  assert.equal(evidence.clean_worktree, true);
  assert.equal(evidence.inventory_digest_check, true);
  assert.equal(evidence.node_version_match, true);
  assert.equal(evidence.sqlite_available, true);
  assert.equal(evidence.synthetic_codex_auth_placeholder, true);
  assert.equal(evidence.full_test_suite_passed, true);
});

test('fails before cloning when the source bundle digest is wrong', async () => {
  const {root, seal} = await fixture();
  const manifestPath = path.join(seal, 'seal-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.source_bundle.sha256 = `sha256:${'0'.repeat(64)}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const manifestSha = execFileSync('shasum', ['-a', '256', manifestPath], {encoding: 'utf8'})
    .split(/\s+/)[0];
  await writeFile(path.join(seal, 'seal-manifest.sha256'), `${manifestSha}  seal-manifest.json\n`);

  const output = path.join(root, 'restore-evidence');
  const result = spawnSync('bash', [verifier, seal, output, process.execPath, sqliteBin], {
    encoding: 'utf8',
    env: credentialFreeEnvironment(),
    cwd: root,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bundle digest mismatch/);
});

test('rejects a credential-bearing restore environment without logging its value', async () => {
  const {root, seal} = await fixture();
  const output = path.join(root, 'restore-evidence');
  const secret = 'do-not-print-this-value';
  const result = spawnSync('bash', [verifier, seal, output, process.execPath, sqliteBin], {
    encoding: 'utf8',
    env: credentialFreeEnvironment({GH_TOKEN: secret}),
    cwd: root,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /credential-bearing environment is not permitted: GH_TOKEN/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
});
