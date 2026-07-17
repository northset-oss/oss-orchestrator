import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.join(here, 'verify-image-restore.sh');
const credentialNames = [
  'GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'SSH_AUTH_SOCK',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
  'OPENAI_API_KEY', 'CODEX_API_KEY',
];

function credentialFreeEnvironment() {
  const environment = {...process.env};
  for (const name of credentialNames) delete environment[name];
  return environment;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-image-restore-test-'));
  const artifact = path.join(root, 'artifact');
  const author = path.join(artifact, 'author');
  const oci = path.join(root, 'oci');
  await mkdir(author, {recursive: true});
  await mkdir(path.join(oci, 'blobs', 'sha256'), {recursive: true});
  await writeFile(path.join(oci, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}\n');
  await writeFile(path.join(oci, 'index.json'), JSON.stringify({
    schemaVersion: 2,
    manifests: [{digest: `sha256:${'8'.repeat(64)}`, mediaType: 'application/vnd.oci.image.index.v1+json'}],
  }));
  await writeFile(path.join(oci, 'blobs', 'sha256', 'placeholder'), 'blob\n');
  execFileSync('tar', ['-cf', path.join(author, 'author.oci.tar'), '-C', oci, '.']);
  await writeFile(path.join(author, 'author.docker.tar'), 'docker archive fixture\n');
  execFileSync('zstd', ['-q', '--rm', path.join(author, 'author.docker.tar')]);
  await writeFile(path.join(author, 'author.sbom.spdx.json'), JSON.stringify({
    spdxVersion: 'SPDX-2.3',
    packages: [{name: 'codex'}],
  }));
  await writeFile(path.join(author, 'author.build-metadata.json'), JSON.stringify({
    'containerimage.digest': `sha256:${'8'.repeat(64)}`,
  }));

  const fileNames = [
    'author.oci.tar',
    'author.docker.tar.zst',
    'author.sbom.spdx.json',
    'author.build-metadata.json',
  ];
  const files = {};
  for (const name of fileNames) {
    const bytes = await readFile(path.join(author, name));
    files[name] = {path: `author/${name}`, bytes: bytes.length, sha256: digest(bytes)};
  }
  const inventory = {
    schema_version: 1,
    source: {head: 'fixture-head', clean_at_inventory: false},
    platform: 'linux/arm64',
    images: [{
      name: 'author',
      archive_tag: 'northset-phase0/author:fixture',
      platform: 'linux/arm64',
      oci_manifest_digest: `sha256:${'8'.repeat(64)}`,
      loaded_image_id: `sha256:${'3'.repeat(64)}`,
      files: {
        oci_archive: files['author.oci.tar'],
        docker_load_archive: files['author.docker.tar.zst'],
        sbom: files['author.sbom.spdx.json'],
        build_metadata: files['author.build-metadata.json'],
      },
    }],
  };
  await writeFile(path.join(artifact, 'inventory.json'), `${JSON.stringify(inventory)}\n`);
  const checksumNames = ['inventory.json', ...fileNames.map((name) => `author/${name}`)];
  const checksumLines = [];
  for (const name of checksumNames) {
    checksumLines.push(`${digest(await readFile(path.join(artifact, name)))}  ${name}`);
  }
  await writeFile(path.join(artifact, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`);

  const nerdctl = path.join(root, 'nerdctl');
  await writeFile(nerdctl, `#!/bin/sh
case "$1" in
  --version) echo 'nerdctl version fixture' ;;
  load) echo 'Loaded image: northset-phase0/author:fixture' ;;
  image) echo '${'sha256:' + '3'.repeat(64)} linux arm64' ;;
  run) echo 'codex-cli 0.144.1' ;;
  *) exit 2 ;;
esac
`);
  await chmod(nerdctl, 0o755);
  return {root, artifact, nerdctl};
}

test('loads, inspects, and smoke-tests an archive while flagging dirty-source evidence', async () => {
  const {root, artifact, nerdctl} = await fixture();
  const output = path.join(root, 'evidence');
  const result = spawnSync('bash', [verifier, artifact, output, nerdctl], {
    encoding: 'utf8',
    cwd: root,
    env: credentialFreeEnvironment(),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(await readFile(path.join(output, 'image-restore-result.json'), 'utf8'));
  assert.equal(evidence.status, 'passed_baseline_only');
  assert.equal(evidence.checksums_verified, true);
  assert.equal(evidence.oci_layout_verified, true);
  assert.equal(evidence.archive_loaded, true);
  assert.equal(evidence.image_identity_matched, true);
  assert.equal(evidence.network_disabled_smoke_passed, true);
  assert.equal(evidence.completion_eligible, false);
});

test('rejects checksum tampering before runtime load', async () => {
  const {root, artifact, nerdctl} = await fixture();
  await writeFile(path.join(artifact, 'author', 'author.docker.tar.zst'), 'tampered\n');
  const output = path.join(root, 'evidence');
  const result = spawnSync('bash', [verifier, artifact, output, nerdctl], {
    encoding: 'utf8',
    cwd: root,
    env: credentialFreeEnvironment(),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum verification failed/);
});
