#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {readFile, mkdir, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {run} from '../../core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, '../..');
const defaultRegistry = path.join(here, 'custom-images.json');
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function safeRelative(value, label) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} escapes the repository`);
  }
  return normalized;
}

export function dockerfilePaths(trackedPaths) {
  return [...new Set(trackedPaths.filter((value) => {
    if (typeof value !== 'string' || value.startsWith('runs/')) return false;
    const base = path.posix.basename(value);
    return base === 'Dockerfile'
      || (/^Dockerfile\.[A-Za-z0-9_.-]+$/.test(base) && !/^Dockerfile\.(?:md|rst|txt)$/i.test(base))
      || /^[A-Za-z0-9_.-]+\.Dockerfile$/.test(base);
  }))].sort();
}

export function validateRegistry({root, registry, trackedFiles}) {
  if (!registry || registry.schema_version !== 1 || !Array.isArray(registry.images)) {
    throw new Error('custom image registry must use schema_version 1 and an images array');
  }
  const names = new Set();
  const tags = new Set();
  const dockerfiles = new Set();
  const images = registry.images.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`images[${index}] must be an object`);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(entry.name ?? '')) {
      throw new Error(`images[${index}].name must be a lowercase image slug`);
    }
    if (typeof entry.tag !== 'string' || !entry.tag.includes(':')) {
      throw new Error(`images[${index}].tag must be an explicitly versioned local tag`);
    }
    const dockerfile = safeRelative(entry.dockerfile, `images[${index}].dockerfile`);
    const context = safeRelative(entry.context, `images[${index}].context`);
    if (names.has(entry.name) || tags.has(entry.tag) || dockerfiles.has(dockerfile)) {
      throw new Error(`duplicate image name, tag, or Dockerfile at images[${index}]`);
    }
    names.add(entry.name);
    tags.add(entry.tag);
    dockerfiles.add(dockerfile);
    return {
      name: entry.name,
      tag: entry.tag,
      dockerfile,
      context,
      dockerfileAbsolute: path.resolve(root, dockerfile),
      contextAbsolute: path.resolve(root, context),
    };
  });
  const trackedDockerfiles = dockerfilePaths(trackedFiles);
  const missing = trackedDockerfiles.filter((value) => !dockerfiles.has(value));
  const extra = [...dockerfiles].filter((value) => !trackedDockerfiles.includes(value));
  if (missing.length || extra.length) {
    throw new Error(`registry coverage mismatch; unregistered=${missing.join(',') || 'none'}; not-tracked=${extra.join(',') || 'none'}`);
  }
  return images;
}

export function buildxArchiveArgs({image, tag, platform, archivePath, metadataPath, builder}) {
  return [
    'buildx', 'build', '--builder', builder,
    '--pull', '--platform', platform,
    '--tag', tag,
    '--file', image.dockerfileAbsolute,
    '--sbom=true', '--provenance=mode=max',
    '--metadata-file', metadataPath,
    '--output', `type=oci,dest=${archivePath}`,
    image.contextAbsolute,
  ];
}

export function buildxLoadArgs({image, tag, platform, builder}) {
  return [
    'buildx', 'build', '--builder', builder,
    '--pull', '--platform', platform,
    '--tag', tag,
    '--file', image.dockerfileAbsolute, '--load',
    image.contextAbsolute,
  ];
}

export function zstdArchiveArgs({input, output}) {
  return ['-T0', '-f', '--rm', '-o', output, input];
}

export function validateOciIndex({
  layout, index, descriptorDigest, descriptor, attestation, platform,
}) {
  if (layout?.imageLayoutVersion !== '1.0.0') throw new Error('unsupported OCI image-layout version');
  if (!index?.manifests?.some((item) => item.digest === descriptorDigest)) {
    throw new Error('OCI index does not bind the Buildx descriptor digest');
  }
  const [os, architecture] = platform.split('/');
  const imageManifest = descriptor?.manifests?.find((item) => (
    item.platform?.os === os && item.platform?.architecture === architecture
  ));
  if (!DIGEST.test(imageManifest?.digest ?? '')) throw new Error(`OCI index has no image manifest for ${platform}`);
  const attestationManifest = descriptor.manifests.find((item) => (
    item.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest'
  ));
  if (!DIGEST.test(attestationManifest?.digest ?? '')) throw new Error('OCI index has no attestation manifest');
  const predicates = (attestation?.layers ?? [])
    .map((item) => item.annotations?.['in-toto.io/predicate-type'])
    .filter(Boolean)
    .sort();
  for (const required of ['https://spdx.dev/Document', 'https://slsa.dev/provenance/v1']) {
    if (!predicates.includes(required)) throw new Error(`OCI attestation is missing ${required}`);
  }
  return {
    image_manifest_digest: imageManifest.digest,
    attestation_manifest_digest: attestationManifest.digest,
    predicates,
  };
}

export async function ensureAttestationBuilder({name = 'northset-phase0-archive', runImpl = run} = {}) {
  const inspected = await runImpl('docker', ['buildx', 'inspect', name], {timeoutMs: 30_000});
  if (inspected.code !== 0) {
    const created = await runImpl('docker', [
      'buildx', 'create', '--name', name, '--driver', 'docker-container',
    ], {timeoutMs: 30_000});
    if (created.code !== 0) {
      throw new Error(`cannot create Buildx attestation builder ${name}: ${(created.stderr || created.stdout).trim()}`);
    }
  }
  const bootstrapped = await runImpl('docker', ['buildx', 'inspect', '--bootstrap', name], {timeoutMs: 5 * 60 * 1000});
  if (bootstrapped.code !== 0) {
    throw new Error(`cannot bootstrap Buildx attestation builder ${name}: ${(bootstrapped.stderr || bootstrapped.stdout).trim()}`);
  }
  return name;
}

async function must(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-12).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed (${result.code}):\n${detail}`);
  }
  return result;
}

async function sha256File(file) {
  const bytes = await readFile(file);
  return createHash('sha256').update(bytes).digest('hex');
}

async function tarJson(archivePath, member) {
  const result = await must('tar', ['-xOf', archivePath, member], {
    timeoutMs: 2 * 60 * 1000,
    outputLimitBytes: 20_000_000,
    terminateOnOutputLimit: true,
  });
  return {bytes: result.stdout, value: JSON.parse(result.stdout)};
}

async function verifyOciArchive({archivePath, descriptorDigest, platform}) {
  const layout = (await tarJson(archivePath, 'oci-layout')).value;
  const index = (await tarJson(archivePath, 'index.json')).value;
  const descriptorMember = `blobs/sha256/${descriptorDigest.slice('sha256:'.length)}`;
  const descriptorResult = await tarJson(archivePath, descriptorMember);
  const observedDescriptorDigest = `sha256:${createHash('sha256').update(descriptorResult.bytes).digest('hex')}`;
  if (observedDescriptorDigest !== descriptorDigest) {
    throw new Error(`OCI descriptor digest mismatch: expected ${descriptorDigest}, got ${observedDescriptorDigest}`);
  }
  const attestationDescriptor = descriptorResult.value.manifests?.find((item) => (
    item.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest'
  ));
  if (!DIGEST.test(attestationDescriptor?.digest ?? '')) throw new Error('OCI index has no attestation descriptor');
  const attestationMember = `blobs/sha256/${attestationDescriptor.digest.slice('sha256:'.length)}`;
  const attestation = (await tarJson(archivePath, attestationMember)).value;
  return validateOciIndex({
    layout,
    index,
    descriptorDigest,
    descriptor: descriptorResult.value,
    attestation,
    platform,
  });
}

async function fileRecord(root, file) {
  const info = await stat(file);
  return {
    path: path.relative(root, file),
    bytes: info.size,
    sha256: await sha256File(file),
  };
}

function parseArgs(args) {
  let output = null;
  let registry = defaultRegistry;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--output') output = args[++index];
    else if (value === '--registry') registry = args[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!output) throw new Error('usage: node campaign/phase0/archive-custom-images.mjs --output <new-directory>');
  return {output: path.resolve(output), registry: path.resolve(registry)};
}

async function toolRecord(command, args) {
  const result = await must(command, args, {timeoutMs: 30_000});
  return (result.stdout || result.stderr).trim();
}

function slugTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').toLowerCase();
}

export async function archiveCustomImages({root = defaultRoot, output, registryPath = defaultRegistry}) {
  await mkdir(path.dirname(output), {recursive: true});
  await mkdir(output);

  const trackedResult = await must('git', ['-C', root, 'ls-files', '-z'], {timeoutMs: 30_000});
  const trackedFiles = trackedResult.stdout.split('\0').filter(Boolean);
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const images = validateRegistry({root, registry, trackedFiles});
  if (!images.length) throw new Error('custom image registry is empty');

  const head = (await must('git', ['-C', root, 'rev-parse', 'HEAD'], {timeoutMs: 30_000})).stdout.trim();
  const status = (await must('git', ['-C', root, 'status', '--porcelain=v2'], {timeoutMs: 30_000})).stdout;
  const dockerArchitecture = (await must('docker', ['info', '--format', '{{.Architecture}}'], {timeoutMs: 30_000})).stdout.trim();
  const architecture = {aarch64: 'arm64', x86_64: 'amd64'}[dockerArchitecture] ?? dockerArchitecture;
  if (!/^[a-z0-9_]+$/.test(architecture)) throw new Error(`unsupported Docker architecture: ${dockerArchitecture}`);
  const platform = `linux/${architecture}`;
  const createdAt = new Date().toISOString();
  const sealSlug = slugTimestamp(new Date(createdAt));
  const tools = {
    node: await toolRecord('node', ['--version']),
    git: await toolRecord('git', ['--version']),
    docker: JSON.parse(await toolRecord('docker', ['version', '--format', '{{json .}}'])),
    buildx: await toolRecord('docker', ['buildx', 'version']),
    scout: await toolRecord('docker', ['scout', 'version']),
    zstd: await toolRecord('zstd', ['--version']),
  };
  const builder = await ensureAttestationBuilder();
  const records = [];

  for (const image of images) {
    const imageDir = path.join(output, image.name);
    await mkdir(imageDir);
    const archivePath = path.join(imageDir, `${image.name}.oci.tar`);
    const dockerTarPath = path.join(imageDir, `${image.name}.docker.tar`);
    const dockerArchivePath = `${dockerTarPath}.zst`;
    const metadataPath = path.join(imageDir, `${image.name}.build-metadata.json`);
    const buildLog = path.join(imageDir, `${image.name}.build.log`);
    const engineBuildLog = path.join(imageDir, `${image.name}.engine-build.log`);
    const sbomPath = path.join(imageDir, `${image.name}.sbom.spdx.json`);
    const archiveTag = `northset-phase0/${image.name}:${sealSlug}`;
    const dockerfileBytes = await readFile(image.dockerfileAbsolute);

    await must('docker', buildxArchiveArgs({
      image, tag: archiveTag, platform, archivePath, metadataPath, builder,
    }), {
      timeoutMs: 30 * 60 * 1000,
      logPath: buildLog,
      outputLimitBytes: 10_000_000,
      terminateOnOutputLimit: false,
    });
    const buildMetadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const buildDigest = buildMetadata['containerimage.digest'];
    if (!DIGEST.test(buildDigest ?? '')) throw new Error(`build metadata has no immutable image digest for ${image.name}`);
    const ociVerification = await verifyOciArchive({archivePath, descriptorDigest: buildDigest, platform});

    // Docker Engine does not load OCI-layout tarballs. Reuse the same BuildKit cache to emit
    // its native image-store format, then save and reload that format as the restore proof.
    await must('docker', buildxLoadArgs({image, tag: archiveTag, platform, builder}), {
      timeoutMs: 30 * 60 * 1000,
      logPath: engineBuildLog,
      outputLimitBytes: 10_000_000,
      terminateOnOutputLimit: false,
    });
    await must('docker', ['image', 'save', '--output', dockerTarPath, archiveTag], {
      timeoutMs: 10 * 60 * 1000,
    });
    await must('zstd', zstdArchiveArgs({input: dockerTarPath, output: dockerArchivePath}), {
      timeoutMs: 10 * 60 * 1000,
      outputLimitBytes: 10_000_000,
      terminateOnOutputLimit: false,
    });
    // Removing only the run-unique tag makes the subsequent inspection proof depend on load.
    await must('docker', ['image', 'rm', archiveTag], {timeoutMs: 2 * 60 * 1000});
    const loadResult = await must('docker', ['image', 'load', '--input', dockerArchivePath], {
      timeoutMs: 10 * 60 * 1000,
    });
    const inspectResult = await must('docker', ['image', 'inspect', archiveTag, '--format', '{{json .}}'], {timeoutMs: 30_000});
    const inspected = JSON.parse(inspectResult.stdout);
    if (!DIGEST.test(inspected.Id ?? '') || inspected.Os !== 'linux' || inspected.Architecture !== architecture) {
      throw new Error(`loaded image inspection mismatch for ${image.name}`);
    }
    const smoke = await must('docker', [
      'run', '--rm', '--network', 'none', '--entrypoint', 'codex', archiveTag, '--version',
    ], {timeoutMs: 60_000});
    await must('docker', [
      'scout', 'sbom', '--format', 'spdx', '--output', sbomPath, `local://${archiveTag}`,
    ], {timeoutMs: 10 * 60 * 1000, outputLimitBytes: 10_000_000, terminateOnOutputLimit: false});
    JSON.parse(await readFile(sbomPath, 'utf8'));

    const verificationPath = path.join(imageDir, `${image.name}.load-verification.json`);
    await writeFile(verificationPath, `${JSON.stringify({
      archive_loaded: true,
      archive_format_loaded: 'Docker image archive compressed with Zstandard',
      archive_tag: archiveTag,
      docker_load_output: `${loadResult.stdout}${loadResult.stderr}`.trim(),
      image_id: inspected.Id,
      os: inspected.Os,
      architecture: inspected.Architecture,
      size_bytes: inspected.Size,
      oci_layout_validated: true,
      oci_layout_engine_loadable: false,
      oci_verification: ociVerification,
      smoke_command: `docker run --rm --network none --entrypoint codex ${archiveTag} --version`,
      smoke_output: smoke.stdout.trim(),
      limitation: 'Local Docker-native archive load/inspect/smoke verification only. The attested OCI layout was structurally validated because Docker Engine does not load OCI-layout tarballs. This is not the required clean-VM restore test.',
    }, null, 2)}\n`, {mode: 0o600});

    records.push({
      name: image.name,
      source_tag: image.tag,
      archive_tag: archiveTag,
      dockerfile: image.dockerfile,
      context: image.context,
      dockerfile_sha256: createHash('sha256').update(dockerfileBytes).digest('hex'),
      platform,
      oci_manifest_digest: buildDigest,
      loaded_image_id: inspected.Id,
      files: {
        oci_archive: await fileRecord(output, archivePath),
        docker_load_archive: await fileRecord(output, dockerArchivePath),
        sbom: await fileRecord(output, sbomPath),
        build_metadata: await fileRecord(output, metadataPath),
        build_log: await fileRecord(output, buildLog),
        engine_build_log: await fileRecord(output, engineBuildLog),
        load_verification: await fileRecord(output, verificationPath),
      },
    });
  }

  const inventoryPath = path.join(output, 'inventory.json');
  await writeFile(inventoryPath, `${JSON.stringify({
    schema_version: 1,
    created_at: createdAt,
    source: {
      repository: root,
      head,
      status_porcelain_v2: status,
      clean_at_inventory: status === '',
    },
    tracked_custom_dockerfiles: dockerfilePaths(trackedFiles),
    registry: path.relative(root, registryPath),
    platform,
    tools,
    images: records,
    verification_scope: 'Attested OCI layouts were structurally validated. Docker-native archives were loaded into the local Docker engine, inspected, and smoke-tested without network access. Clean-VM restore remains a separate Phase 0.1 gate.',
  }, null, 2)}\n`, {mode: 0o600});

  const files = [inventoryPath];
  for (const record of records) {
    for (const value of Object.values(record.files)) files.push(path.join(output, value.path));
  }
  const checksumLines = [];
  for (const file of files.sort()) {
    checksumLines.push(`${await sha256File(file)}  ${path.relative(output, file)}`);
  }
  await writeFile(path.join(output, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`, {mode: 0o600});
  return {output, inventoryPath, records};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {output, registry} = parseArgs(process.argv.slice(2));
    const result = await archiveCustomImages({output, registryPath: registry});
    console.log(`Archived ${result.records.length} custom image(s) at ${result.output}`);
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
