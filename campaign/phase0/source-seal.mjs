#!/usr/bin/env node

import {createHash, randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT_FILE = fileURLToPath(import.meta.url);
const MAX_COMMAND_OUTPUT = 128 * 1024 * 1024;
const DEFAULT_OUTPUT = '.phase0-artifacts/2026-07-17/source-seal';

const LOCKFILE_NAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
  'go.sum',
  'mix.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'package.resolved',
  'packages.lock.json',
  'pipfile.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'uv.lock',
  'yarn.lock',
]);

function canonical(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('cannot canonicalize a non-finite number');
  }
  if (value === undefined) throw new Error('cannot canonicalize undefined');
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function command(commandName, args, {cwd, allowFailure = false, encoding = 'utf8'} = {}) {
  try {
    const result = await execFileAsync(commandName, args, {
      cwd,
      encoding,
      maxBuffer: MAX_COMMAND_OUTPUT,
      windowsHide: true,
    });
    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (!allowFailure) throw error;
    return {
      ok: false,
      stdout: error.stdout ?? (encoding === 'utf8' ? '' : Buffer.alloc(0)),
      stderr: error.stderr ?? (encoding === 'utf8' ? '' : Buffer.alloc(0)),
      code: error.code ?? null,
    };
  }
}

async function git(repo, args, options = {}) {
  return command('git', args, {cwd: repo, ...options});
}

function text(result) {
  return String(result.stdout).trim();
}

async function worktreeStatus(repo) {
  const result = await git(repo, ['status', '--porcelain=v2', '--untracked-files=all']);
  return String(result.stdout).trim();
}

function parseTrackedFiles(source) {
  return String(source).split('\0').filter(Boolean).map((record) => {
    const separator = record.indexOf('\t');
    if (separator === -1) throw new Error('git ls-files returned an unexpected record');
    const [mode, oid, stage] = record.slice(0, separator).split(' ');
    if (stage !== '0') throw new Error('the index contains unmerged entries');
    return {path: record.slice(separator + 1), mode, oid};
  }).sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

async function trackedFiles(repo) {
  const result = await git(repo, ['ls-files', '--stage', '-z']);
  return parseTrackedFiles(result.stdout);
}

async function blob(repo, oid) {
  const result = await git(repo, ['cat-file', 'blob', oid], {encoding: 'buffer'});
  return result.stdout;
}

async function fileRecord(repo, tracked, extras = {}) {
  const content = await blob(repo, tracked.oid);
  return {
    path: tracked.path,
    git_mode: tracked.mode,
    git_blob_oid: tracked.oid,
    size_bytes: content.length,
    sha256: sha256(content),
    ...extras,
  };
}

async function jsonFacts(repo, tracked) {
  const content = await blob(repo, tracked.oid);
  try {
    const value = JSON.parse(content.toString('utf8'));
    return {
      schema_version: Number.isInteger(value?.schema_version) ? value.schema_version : null,
      value,
    };
  } catch (error) {
    throw new Error(`${tracked.path} is not valid JSON: ${error.message}`);
  }
}

function isDockerfile(file) {
  const name = path.posix.basename(file).toLowerCase();
  return name === 'dockerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile');
}

function isProfileRegistry(file) {
  const name = path.posix.basename(file).toLowerCase();
  return /^profiles?\.json$/.test(name) || /^profile[-_.]registry\.(?:json|ya?ml|toml)$/.test(name);
}

function isPolicyFile(file) {
  const name = path.posix.basename(file).toLowerCase();
  return /(^|[-_.])policy([-_.]|$)/.test(name) || /(^|\/)polic(?:y|ies)(\/|$)/i.test(file);
}

function isMigrationFile(file) {
  const name = path.posix.basename(file);
  return /(^|\/)(?:migrations?|db\/migrate)(\/|$)/i.test(file) || /^v?[0-9]+[_-].*\.sql$/i.test(name);
}

async function inventory(repo, tracked) {
  const lockfiles = [];
  const dockerfiles = [];
  const profileRegistries = [];
  const policyFiles = [];
  const migrationFiles = [];
  const databaseSchemaVersions = [];

  for (const item of tracked) {
    const basename = path.posix.basename(item.path).toLowerCase();
    if (LOCKFILE_NAMES.has(basename)) lockfiles.push(await fileRecord(repo, item));
    if (isDockerfile(item.path)) dockerfiles.push(await fileRecord(repo, item));
    if (isMigrationFile(item.path)) migrationFiles.push(await fileRecord(repo, item));

    if (isProfileRegistry(item.path)) {
      const facts = item.path.toLowerCase().endsWith('.json') ? await jsonFacts(repo, item) : null;
      const profileNames = facts?.value?.profiles && typeof facts.value.profiles === 'object'
        ? Object.keys(facts.value.profiles).sort()
        : [];
      profileRegistries.push(await fileRecord(repo, item, {
        schema_version: facts?.schema_version ?? null,
        profile_names: profileNames,
      }));
    }

    if (isPolicyFile(item.path)) {
      const facts = item.path.toLowerCase().endsWith('.json') ? await jsonFacts(repo, item) : null;
      policyFiles.push(await fileRecord(repo, item, {
        schema_version: facts?.schema_version ?? null,
      }));
    }

    if (/(?:schema|database|candidate-lake|migration)/i.test(item.path)) {
      const content = (await blob(repo, item.oid)).toString('utf8');
      const pattern = /\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*SCHEMA_VERSION)\s*=\s*([0-9]+)\b/g;
      for (const match of content.matchAll(pattern)) {
        databaseSchemaVersions.push({
          path: item.path,
          symbol: match[1],
          version: Number(match[2]),
        });
      }
    }
  }

  databaseSchemaVersions.sort((left, right) =>
    left.path.localeCompare(right.path, 'en') || left.symbol.localeCompare(right.symbol, 'en'));
  return {
    tracked_file_count: tracked.length,
    lockfiles,
    dockerfiles,
    profile_registries: profileRegistries,
    database_schema_versions: databaseSchemaVersions,
    migration_files: migrationFiles,
    policy_files: policyFiles,
  };
}

function parseRefs(source) {
  return String(source).split('\n').filter(Boolean).map((line) => {
    const [ref, oid, objectType] = line.split('\t');
    return {ref, oid, object_type: objectType};
  }).sort((left, right) => left.ref.localeCompare(right.ref, 'en'));
}

async function gitFacts(repo) {
  const head = (await git(repo, ['show', '-s', '--format=%H%n%T%n%P%n%ct', 'HEAD'])).stdout
    .toString().trimEnd().split('\n');
  const fullRef = await git(repo, ['symbolic-ref', '-q', 'HEAD'], {allowFailure: true});
  const refs = parseRefs((await git(repo, [
    'for-each-ref',
    '--format=%(refname)%09%(objectname)%09%(objecttype)',
  ])).stdout);
  return {
    clean_worktree: true,
    clean_check_command: 'git status --porcelain=v2 --untracked-files=all',
    object_format: text(await git(repo, ['rev-parse', '--show-object-format'])),
    head_oid: head[0],
    head_tree_oid: head[1],
    head_parent_oids: head[2] ? head[2].split(' ') : [],
    head_commit_unix_seconds: Number(head[3]),
    head_ref: fullRef.ok ? text(fullRef) : null,
    refs,
  };
}

async function environmentFacts() {
  const gitVersion = text(await command('git', ['--version']));
  const dockerCli = await command('docker', ['--version'], {allowFailure: true});
  const dockerFull = dockerCli.ok
    ? await command('docker', ['version', '--format', '{{json .}}'], {allowFailure: true})
    : {ok: false, stdout: ''};
  let dockerVersion = null;
  if (dockerFull.ok) {
    try { dockerVersion = JSON.parse(text(dockerFull)); }
    catch (error) { throw new Error(`docker version returned invalid JSON: ${error.message}`); }
  }
  return {
    node: {version: process.version},
    git: {version: gitVersion},
    docker: {
      available: dockerCli.ok,
      cli_version: dockerCli.ok ? text(dockerCli) : null,
      engine_version: dockerVersion,
    },
  };
}

function parseBundleHeads(source) {
  return String(source).split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf(' ');
    if (separator === -1) throw new Error('git bundle list-heads returned an unexpected record');
    return {oid: line.slice(0, separator), ref: line.slice(separator + 1)};
  }).sort((left, right) => left.ref.localeCompare(right.ref, 'en'));
}

function sameGitSnapshot(left, right) {
  return canonical(left) === canonical(right);
}

async function outputMustNotExist(output) {
  try {
    await access(output);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`output path already exists: ${output}`);
}

function outputIsInsideRepo(repo, output) {
  const relative = path.relative(repo, output);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function inRepoOutputIsIgnored(repo, output) {
  const relative = path.relative(repo, output);
  const result = await git(repo, ['check-ignore', '--quiet', '--no-index', '--', relative], {
    allowFailure: true,
  });
  return result.ok;
}

async function loadTestOutputs(testOutputs) {
  if (!Array.isArray(testOutputs) || testOutputs.length === 0) {
    throw new Error('at least one full test-output file is required');
  }
  const loaded = [];
  for (const source of testOutputs) {
    const content = await readFile(path.resolve(source));
    if (content.length === 0) throw new Error('test-output files must not be empty');
    loaded.push(content);
  }
  return loaded;
}

export async function createSourceSeal({repo: requestedRepo, output: requestedOutput, testOutputs}) {
  if (!requestedRepo) throw new Error('repo is required');

  const requestedRepoPath = path.resolve(requestedRepo);
  const repo = await realpath(requestedRepoPath);
  const topLevel = text(await git(repo, ['rev-parse', '--show-toplevel']));
  if (await realpath(topLevel) !== repo) throw new Error('repo must point to the Git worktree root');
  const requestedOutputPath = requestedOutput ? path.resolve(requestedOutput) : null;
  const requestedRelative = requestedOutputPath ? path.relative(requestedRepoPath, requestedOutputPath) : null;
  const output = requestedOutputPath && requestedRelative !== '' &&
    !requestedRelative.startsWith(`..${path.sep}`) && requestedRelative !== '..' && !path.isAbsolute(requestedRelative)
    ? path.join(repo, requestedRelative)
    : (requestedOutputPath ?? path.join(repo, DEFAULT_OUTPUT));
  if (outputIsInsideRepo(repo, output) && !(await inRepoOutputIsIgnored(repo, output))) {
    throw new Error('an output inside the source worktree must be ignored by Git');
  }
  await outputMustNotExist(output);

  const dirty = await worktreeStatus(repo);
  if (dirty) {
    const count = dirty.split('\n').length;
    throw new Error(`worktree is dirty (${count} porcelain record${count === 1 ? '' : 's'}); no artifacts created`);
  }

  const testOutputBuffers = await loadTestOutputs(testOutputs);
  const tracked = await trackedFiles(repo);
  const initialGit = await gitFacts(repo);
  const sourceInventory = await inventory(repo, tracked);
  const environment = await environmentFacts();
  const partial = `${output}.partial-${process.pid}-${randomBytes(6).toString('hex')}`;

  await mkdir(path.dirname(output), {recursive: true, mode: 0o700});
  await mkdir(partial, {mode: 0o700});
  try {
    const bundleArtifact = 'source.bundle';
    const bundlePath = path.join(partial, bundleArtifact);
    await git(repo, ['bundle', 'create', bundlePath, '--all']);
    await git(repo, ['bundle', 'verify', bundlePath]);
    const bundleHeads = parseBundleHeads((await git(repo, ['bundle', 'list-heads', bundlePath])).stdout);
    const headsByRef = new Map(bundleHeads.map((item) => [item.ref, item.oid]));
    const missingRefs = initialGit.refs.filter((item) => headsByRef.get(item.ref) !== item.oid);
    if (missingRefs.length > 0) {
      throw new Error(`source bundle is missing ${missingRefs.length} recorded ref${missingRefs.length === 1 ? '' : 's'}`);
    }

    const bundleContent = await readFile(bundlePath);
    const archivedTestOutputs = [];
    const testOutputDirectory = path.join(partial, 'test-output');
    await mkdir(testOutputDirectory, {mode: 0o700});
    for (const [index, content] of testOutputBuffers.entries()) {
      const name = `test-output-${String(index + 1).padStart(3, '0')}.log`;
      const artifact = path.posix.join('test-output', name);
      await writeFile(path.join(testOutputDirectory, name), content, {mode: 0o600});
      archivedTestOutputs.push({artifact, size_bytes: content.length, sha256: sha256(content)});
    }

    const finalDirty = await worktreeStatus(repo);
    if (finalDirty) throw new Error('worktree changed while the seal was being assembled');
    const finalGit = await gitFacts(repo);
    if (!sameGitSnapshot(initialGit, finalGit)) throw new Error('Git HEAD or refs changed while the seal was being assembled');

    const manifest = {
      schema_version: 1,
      format: 'northset-phase0-source-seal',
      source_bundle: {
        artifact: bundleArtifact,
        command: 'git bundle create source.bundle --all',
        verified: true,
        verification_command: 'git -C <repository> bundle verify <artifact-directory>/source.bundle',
        all_recorded_refs_present: true,
        heads: bundleHeads,
        size_bytes: bundleContent.length,
        sha256: sha256(bundleContent),
      },
      git: initialGit,
      environment,
      inventory: sourceInventory,
      test_outputs: archivedTestOutputs,
      signing: {
        status: 'not_performed',
        intended_form: 'detached signature over the exact seal-manifest.json bytes',
      },
      completion: {
        clean_worktree: true,
        source_bundle_created: true,
        source_bundle_verified: true,
        full_test_output_archived: true,
        source_environment_manifest: true,
        oci_archives: false,
        sbom: false,
        manifest_signed: false,
        encrypted_off_machine_copy: false,
        clean_vm_restore: false,
      },
    };

    const manifestBytes = Buffer.from(`${canonical(manifest)}\n`, 'utf8');
    await writeFile(path.join(partial, 'seal-manifest.json'), manifestBytes, {mode: 0o600});
    await writeFile(
      path.join(partial, 'seal-manifest.sha256'),
      `${sha256(manifestBytes).slice('sha256:'.length)}  seal-manifest.json\n`,
      {mode: 0o600},
    );
    await rename(partial, output);
    return manifest;
  } catch (error) {
    await rm(partial, {recursive: true, force: true});
    throw error;
  }
}

function usage() {
  return [
    'Usage:',
    '  node campaign/phase0/source-seal.mjs --repo <clean-worktree> [--output <new-directory>] \\',
    '    --test-output <full-test-output.log> [--test-output <another.log>]',
    '',
    `Default output: <clean-worktree>/${DEFAULT_OUTPUT}`,
    'An in-worktree output must be ignored by Git; every output directory must be new.',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {repo: process.cwd(), output: null, testOutputs: []};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return {help: true};
    if (argument === '--repo') options.repo = argv[++index];
    else if (argument === '--output') options.output = argv[++index];
    else if (argument === '--test-output') options.testOutputs.push(argv[++index]);
    else throw new Error(`unknown argument: ${argument}`);
    if (!argv[index]) throw new Error(`${argument} requires a value`);
  }
  if (!options.output) options.output = path.join(path.resolve(options.repo), DEFAULT_OUTPUT);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const manifest = await createSourceSeal(options);
  process.stdout.write(`${JSON.stringify({
    artifact_directory: path.resolve(options.output),
    head_oid: manifest.git.head_oid,
    bundle_sha256: manifest.source_bundle.sha256,
    manifest_status: manifest.signing.status,
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  main().catch((error) => {
    process.stderr.write(`source-seal: ${error.message}\n`);
    process.exitCode = 1;
  });
}
