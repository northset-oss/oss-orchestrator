import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildxArchiveArgs,
  buildxLoadArgs,
  dockerfilePaths,
  ensureAttestationBuilder,
  validateOciIndex,
  validateRegistry,
  zstdArchiveArgs,
} from './archive-custom-images.mjs';

test('dockerfile inventory includes every tracked custom Dockerfile and excludes lookalikes', () => {
  assert.deepEqual(dockerfilePaths([
    'author-image/Dockerfile',
    'profiles/node/Dockerfile.native',
    'profiles/python/build.Dockerfile',
    'docs/Dockerfile.md',
    'runs/checkout/Dockerfile',
    'README.md',
  ]), [
    'author-image/Dockerfile',
    'profiles/node/Dockerfile.native',
    'profiles/python/build.Dockerfile',
  ]);
});

test('registry validation rejects an unregistered tracked Dockerfile', () => {
  assert.throws(() => validateRegistry({
    root: '/repo',
    trackedFiles: ['author-image/Dockerfile', 'second/Dockerfile'],
    registry: {
      schema_version: 1,
      images: [{
        name: 'author',
        tag: 'northset-oss-author:0.144.1',
        dockerfile: 'author-image/Dockerfile',
        context: 'author-image',
      }],
    },
  }), /registry coverage mismatch.*second\/Dockerfile/);
});

test('registry validation normalizes a complete safe registry', () => {
  assert.deepEqual(validateRegistry({
    root: '/repo',
    trackedFiles: ['author-image/Dockerfile'],
    registry: {
      schema_version: 1,
      images: [{
        name: 'author',
        tag: 'northset-oss-author:0.144.1',
        dockerfile: 'author-image/Dockerfile',
        context: 'author-image',
      }],
    },
  }), [{
    name: 'author',
    tag: 'northset-oss-author:0.144.1',
    dockerfile: 'author-image/Dockerfile',
    context: 'author-image',
    dockerfileAbsolute: '/repo/author-image/Dockerfile',
    contextAbsolute: '/repo/author-image',
  }]);
});

test('OCI build command pulls the base and embeds SBOM and provenance attestations', () => {
  assert.deepEqual(buildxArchiveArgs({
    image: {
      dockerfileAbsolute: '/repo/author-image/Dockerfile',
      contextAbsolute: '/repo/author-image',
    },
    tag: 'northset-phase0/author:seal',
    platform: 'linux/arm64',
    archivePath: '/out/author.oci.tar',
    metadataPath: '/out/author.build-metadata.json',
    builder: 'northset-phase0-archive',
  }), [
    'buildx', 'build', '--builder', 'northset-phase0-archive',
    '--pull', '--platform', 'linux/arm64',
    '--tag', 'northset-phase0/author:seal',
    '--file', '/repo/author-image/Dockerfile',
    '--sbom=true', '--provenance=mode=max',
    '--metadata-file', '/out/author.build-metadata.json',
    '--output', 'type=oci,dest=/out/author.oci.tar',
    '/repo/author-image',
  ]);
});

test('attestation builder is created with the docker-container driver when missing', async () => {
  const calls = [];
  const results = [
    {code: 1, stdout: '', stderr: 'no builder'},
    {code: 0, stdout: 'created', stderr: ''},
    {code: 0, stdout: 'bootstrapped', stderr: ''},
  ];
  const builder = await ensureAttestationBuilder({
    name: 'northset-phase0-archive',
    runImpl: async (command, args) => {
      calls.push([command, args]);
      return results.shift();
    },
  });
  assert.equal(builder, 'northset-phase0-archive');
  assert.deepEqual(calls, [
    ['docker', ['buildx', 'inspect', 'northset-phase0-archive']],
    ['docker', ['buildx', 'create', '--name', 'northset-phase0-archive', '--driver', 'docker-container']],
    ['docker', ['buildx', 'inspect', '--bootstrap', 'northset-phase0-archive']],
  ]);
});

test('engine-load build reuses the attestation builder and emits the Docker image store format', () => {
  assert.deepEqual(buildxLoadArgs({
    image: {
      dockerfileAbsolute: '/repo/author-image/Dockerfile',
      contextAbsolute: '/repo/author-image',
    },
    tag: 'northset-phase0/author:seal',
    platform: 'linux/arm64',
    builder: 'northset-phase0-archive',
  }), [
    'buildx', 'build', '--builder', 'northset-phase0-archive',
    '--pull', '--platform', 'linux/arm64',
    '--tag', 'northset-phase0/author:seal',
    '--file', '/repo/author-image/Dockerfile', '--load',
    '/repo/author-image',
  ]);
});

test('OCI validation requires the image plus SPDX and provenance attestations', () => {
  const imageDigest = `sha256:${'1'.repeat(64)}`;
  const attestationDigest = `sha256:${'2'.repeat(64)}`;
  assert.deepEqual(validateOciIndex({
    layout: {imageLayoutVersion: '1.0.0'},
    index: {manifests: [{digest: imageDigest}]},
    descriptorDigest: imageDigest,
    descriptor: {manifests: [
      {digest: `sha256:${'3'.repeat(64)}`, platform: {os: 'linux', architecture: 'arm64'}},
      {digest: attestationDigest, platform: {os: 'unknown', architecture: 'unknown'}, annotations: {'vnd.docker.reference.type': 'attestation-manifest'}},
    ]},
    attestation: {layers: [
      {annotations: {'in-toto.io/predicate-type': 'https://spdx.dev/Document'}},
      {annotations: {'in-toto.io/predicate-type': 'https://slsa.dev/provenance/v1'}},
    ]},
    platform: 'linux/arm64',
  }), {
    image_manifest_digest: `sha256:${'3'.repeat(64)}`,
    attestation_manifest_digest: attestationDigest,
    predicates: ['https://slsa.dev/provenance/v1', 'https://spdx.dev/Document'],
  });
});

test('Zstandard archive arguments use the portable short options', () => {
  assert.deepEqual(zstdArchiveArgs({input: '/out/author.docker.tar', output: '/out/author.docker.tar.zst'}), [
    '-T0', '-f', '--rm', '-o', '/out/author.docker.tar.zst', '/out/author.docker.tar',
  ]);
});
