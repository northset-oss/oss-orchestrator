#!/usr/bin/env node

// Lean Northset OSS workflow:
//   prepare -> one canonical public bundle + one content-bound review board
//   ship    -> publish exactly those bytes after founder approval
//   status  -> reconcile factual PR outcomes into mutable publication envelopes

import {appendFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, statfs, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  OSS_IDENTITY,
  PROFILE_REGISTRY,
  assertOssCommitIdentity,
  assertPatchCommitBinding,
  authorEffort,
  batchApprovalDigest,
  batchBoardData,
  canonical,
  createDeadline,
  directoryDigest,
  git,
  manifestDigest,
  parseCandidate,
  pool,
  prBody,
  qualificationSourceEvidencePaths,
  recheck,
  run,
  sanitizedGitEnv,
  sha256,
  validateSpecs,
} from './core.mjs';
import {normalizedPrClaimText, reviewPatch} from './review-patch.mjs';
import {
  assertTaskResourcePolicy,
  assertPhase0Spec,
  attachTrustedModelProviderErrorFromCodexJsonl,
  isProviderThrottle,
  loadResourceControl,
  remainingTaskLaneMs,
  resourceUsageForTask,
  tripPersistentProviderThrottle,
} from './campaign/phase0/resource-breakers.mjs';
import {buildAttemptAttribution, validateAttemptAttribution} from './campaign/phase1/attribution.mjs';
import {
  assertGhRateSafetyAllowsAction,
  resolveGhGatewayStateDir,
} from './gh-gateway.mjs';

const OSS_FILE = fileURLToPath(import.meta.url);
const HERE = path.dirname(OSS_FILE);
const MODEL_RUNNER_RESULT = Symbol('model-runner-result');
const NORTHSET_OSS = process.env.NORTHSET_OSS_DIR ?? '/Users/aeziz-local/northset-oss';
const RUN_MISSION = path.join(NORTHSET_OSS, 'bin', 'run-mission.mjs');
const BUNDLE_CLI = path.join(NORTHSET_OSS, 'bin', 'bundle.mjs');
const READY_TTL_HOURS = 8;
export const PREPARE_BUDGET_MS = 60 * 60 * 1000;
export const AUTHOR_MODEL_ATTEMPT_MS = 12 * 60 * 1000;
export const MAX_ELEVATED_EXISTING_TESTS = 2;
const AUTHOR_IMAGE = process.env.OSS_AUTHOR_IMAGE ?? 'northset-oss-author:0.144.1';
const DEPENDENCY_CACHE_ROOT = process.env.OSS_DEPENDENCY_CACHE_DIR ?? path.join(HERE, 'cache', 'dependencies');
const REPOSITORY_MIRROR_ROOT = process.env.OSS_REPOSITORY_MIRROR_DIR ?? path.join(HERE, 'cache', 'repos');
const DEFAULTS = {
  specsDir: path.join(HERE, 'specs'),
  runsDir: path.join(HERE, 'runs'),
  concurrency: 3,
};
export const WRITABLE_COPY_LIMITATION = 'Declared checks ran in an ephemeral writable copy. The tracked tree matched the approved tree after execution; this detects final-state mutation but does not prove that no transient mutation occurred during the run.';

export function remainingAuthorModelMs(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('elapsed model time must be nonnegative');
  return Math.max(0, Math.floor(AUTHOR_MODEL_ATTEMPT_MS - elapsedMs));
}

function missionGit(deadline, cwd, ...args) {
  return run('git', ['-C', cwd, ...args], {
    env: sanitizedGitEnv(), deadline, timeoutMs: 2 * 60 * 1000,
  });
}

function changedPath(entry) { return typeof entry === 'string' ? entry : entry.path; }
function isTestPath(file) {
  const name = path.basename(file);
  return /(^|\/)(__tests__|test|tests|spec|specs)(\/|$)/i.test(file)
    || /(?:^|\.)(?:test|spec)\.[^/]+$/i.test(name)
    || /^(?:test_.+|.+_test)\.py$/i.test(name)
    || /_test\.go$/i.test(name);
}

function classifyRisk(entry, base) {
  const file = changedPath(entry);
  const name = path.basename(file).toLowerCase();
  if (entry.statusCode === 'R') return 'rename';
  if (entry.statusCode === 'C') return 'copy';
  if (entry.statusCode === 'T') return 'type-change';
  if (entry.mode === '160000') return 'submodule';
  if (entry.mode === '120000') return 'symlink';
  if (entry.binary) return 'binary';
  if (/^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|cargo\.lock|poetry\.lock|pipfile\.lock|uv\.lock|go\.(?:sum|work\.sum)|gemfile\.lock|gradle\.lockfile)$/i.test(name)) return 'lockfile';
  if (/^(package\.json|pyproject\.toml|requirements[^/]*\.(?:txt|in)|pipfile|setup\.(?:py|cfg)|cargo\.toml|go\.(?:mod|work)|gemfile|pom\.xml|build\.gradle(?:\.kts)?)$/i.test(name)) return 'dependency-manifest';
  if (/^(dockerfile|compose\.ya?ml)$/i.test(name) || /(^|\/)(?:docker|\.devcontainer)\//i.test(file)) return 'container-config';
  if (/^(?:\.github\/|\.circleci\/|\.gitlab-ci\.yml$|azure-pipelines\.yml$)/i.test(file)) return 'check-or-CI-config';
  if (/(^|\/)(?:vite|webpack|rollup|babel|tsconfig|eslint|prettier|jest|vitest|playwright)(?:\.|\/)/i.test(file)) return 'build-config';
  if (/^(?:makefile|gnumakefile|justfile|cmakelists\.txt|meson\.build|taskfile(?:\.ya?ml)?|turbo\.json|nx\.json|build\.rs|conftest\.py|noxfile\.py|tox\.ini|pytest\.ini|gulpfile\.[^/]+|gruntfile\.[^/]+)$/i.test(name) ||
      /^(?:\.npmrc|\.yarnrc(?:\.ya?ml)?|\.nvmrc|\.node-version|\.python-version|rust-toolchain(?:\.toml)?|ruff\.toml|biome\.json|deno\.jsonc?|\.babelrc(?:\.[^/]*)?|\.eslintrc(?:\.[^/]*)?|\.prettierrc(?:\.[^/]*)?)$/i.test(name) ||
      /\.config\.(?:[cm]?[jt]sx?|json|ya?ml)$/i.test(name)) return 'build-config';
  if (/(^|\/)(?:dist|build|generated|vendor)\//i.test(file) ||
      /(?:^|[._-])generated(?:[._-]|$)|\.g\.[^/]+$|\.pb\.go$/i.test(name)) return 'generated-output';
  if (/(^|\/)(?:fixtures?|snapshots?|__snapshots__)\//i.test(file) || /\.snap$/i.test(file)) return 'snapshot-or-fixture';
  if (file === 'package.json' || /(^|\/)(?:ci|scripts?|tools?)\/(?:build|release|setup|bootstrap|generate|publish|check|test|verify|lint)(?:\.|$)/i.test(file)) return 'check-or-CI-config';
  if (isTestPath(file)) return base.has(file) ? 'modified-existing-test' : 'added-test';
  if (/(^|\/)(?:docs?|documentation)(?:\/|$)/i.test(file) ||
      /(^|\/)(?:examples?|samples?|benchmarks?|config|configs)(?:\/|$)/i.test(file) ||
      /\.(?:md|mdx|rst|adoc|txt)$/i.test(name) ||
      /^(?:readme|contributing|changelog|changes|license|notice|authors|code_of_conduct|security)(?:\.[^/]*)?$/i.test(name)) return 'nonproduction';
  if (/(^|\/)(?:\.changeset|\.vscode|\.idea)(?:\/|$)/i.test(file) ||
      /^(?:\.gitignore|\.gitattributes|\.editorconfig|\.mailmap|\.pre-commit-config\.ya?ml|codeowners|release-please-config\.json|\.releaserc(?:\.[^/]*)?)$/i.test(name)) return 'nonproduction';
  if (/\.d\.(?:ts|mts|cts)$/i.test(name) || /\.pyi$/i.test(name)) return 'nonproduction';
  if (/\.(?:[cm]?[jt]sx?|py|go|rs|vue|svelte|css|scss|sass|less|html?)$/i.test(name)) return 'source';
  return 'nonproduction';
}

export function classifyChangedFiles(baseFileList, changedFiles) {
  const base = new Set(baseFileList.map(changedPath));
  const hard = new Set([
    'dependency-manifest', 'lockfile', 'build-config', 'container-config', 'generated-output',
    'submodule', 'binary', 'symlink', 'check-or-CI-config', 'rename', 'copy', 'type-change', 'nonproduction',
  ]);
  return changedFiles.map((entry) => {
    const file = changedPath(entry);
    if (typeof file !== 'string' || !file) throw new Error('changed file must have a non-empty path');
    const fileClass = classifyRisk(entry, base);
    return {path: file, class: fileClass, flagged: hard.has(fileClass) || fileClass === 'modified-existing-test'};
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export function assertOracleChangedPaths(spec, classes) {
  const byPath = new Map(classes.map((item) => [item.path, item.class]));
  const invalid = spec.oracle.test_paths.filter((testPath) => !['added-test', 'modified-existing-test'].includes(byPath.get(testPath)));
  if (invalid.length) {
    throw new Error(`oracle.test_paths must be newly added or modified existing tests in this patch: ${invalid.join(', ')}`);
  }
}

function limits(spec) {
  const value = spec.executor.limits ?? {};
  return {
    cpus: value.cpus ?? 2,
    memory: `${value.memory_mb ?? 4096}m`,
    pids: value.pids ?? 512,
    wallMs: (value.wall_clock_seconds_per_command ?? 1800) * 1000,
    output: value.output_bytes_per_stream ?? 2_000_000,
  };
}

function quote(value) {
  return /^[A-Za-z0-9_./:=@-]+$/.test(String(value)) ? String(value) : `'${String(value).replaceAll("'", "'\\''")}'`;
}
function shell(commands) { return ['set -e', ...commands].join('\n'); }

function containerName(spec, phase) {
  return `northset-${spec.mission_id.toLowerCase()}-${phase}`;
}

function commonDockerArgs(spec, workspace, image, {
  network = 'bridge', home = '/tmp', workdir = '/workspace/repo', phase = 'run',
  workspaceReadonly = false, protectGit = false,
} = {}) {
  const resource = limits(spec);
  const args = [
    'run', '--rm', '--name', containerName(spec, phase), '--user', '1000:1000', '--network', network,
    '--security-opt', 'no-new-privileges', '--cap-drop=ALL',
    '--cpus', String(resource.cpus), '--memory', resource.memory, '--pids-limit', String(resource.pids),
    '--mount', `type=bind,src=${workspace},dst=/workspace${workspaceReadonly ? ',readonly' : ''}`,
  ];
  if (protectGit) args.push('--mount', `type=bind,src=${path.join(workspace, 'repo', '.git')},dst=/workspace/repo/.git,readonly`);
  args.push('--workdir', workdir, '--env', `HOME=${home}`, '--env', 'CI=true', image);
  return args;
}

export function dependencyBootstrapDockerArgs(spec, workspace, image, cacheDir = null) {
  const cacheExports = cacheDir ? {
    node: [],
    python: [
      'mkdir -p /workspace/.northset/bootstrap-home/.cache/pip /workspace/.northset/bootstrap-home/python-site',
      'if [ -d /northset-cache/pip ]; then cp -a /northset-cache/pip/. /workspace/.northset/bootstrap-home/.cache/pip/; fi',
    ],
    go: [
      'if [ -d /workspace/.northset/bootstrap-home/go/pkg/mod ]; then chmod -R u+w /workspace/.northset/bootstrap-home/go/pkg/mod && rm -rf /workspace/.northset/bootstrap-home/go/pkg/mod; fi',
      'if [ -d /workspace/.northset/bootstrap-home/.cache/go-build ]; then chmod -R u+w /workspace/.northset/bootstrap-home/.cache/go-build && rm -rf /workspace/.northset/bootstrap-home/.cache/go-build; fi',
      'mkdir -p /workspace/.northset/bootstrap-home/go/pkg/mod /workspace/.northset/bootstrap-home/.cache/go-build',
      'if [ -d /northset-cache/go-mod ]; then tar -C /northset-cache/go-mod -cf - . | tar -C /workspace/.northset/bootstrap-home/go/pkg/mod --no-same-owner --no-same-permissions -xf -; chmod -R u+rwX /workspace/.northset/bootstrap-home/go/pkg/mod; fi',
      'if [ -d /northset-cache/go-build ]; then tar -C /northset-cache/go-build -cf - . | tar -C /workspace/.northset/bootstrap-home/.cache/go-build --no-same-owner --no-same-permissions -xf -; chmod -R u+rwX /workspace/.northset/bootstrap-home/.cache/go-build; fi',
    ],
    rust: [
      'mkdir -p /workspace/.northset/bootstrap-home/.cargo/registry /workspace/.northset/bootstrap-home/.cargo/git',
      'if [ -d /northset-cache/cargo/registry ]; then cp -a /northset-cache/cargo/registry/. /workspace/.northset/bootstrap-home/.cargo/registry/; fi',
      'if [ -d /northset-cache/cargo/git ]; then cp -a /northset-cache/cargo/git/. /workspace/.northset/bootstrap-home/.cargo/git/; fi',
    ],
  }[spec.executor.profile] ?? [] : [];
  const commands = [
    'mkdir -p /workspace/.northset/bootstrap-home',
    ...spec.executor.install_commands,
    ...cacheExports,
  ];
  const args = commonDockerArgs(spec, workspace, image, {
    home: '/workspace/.northset/bootstrap-home', phase: 'dependency-bootstrap', protectGit: true,
  });
  if (cacheDir) {
    const cacheEnvironment = {
      node: ['npm_config_cache=/northset-cache/npm', 'PNPM_STORE_DIR=/northset-cache/pnpm', 'YARN_CACHE_FOLDER=/northset-cache/yarn'],
      python: ['PIP_CACHE_DIR=/northset-cache/pip', 'PIP_TARGET=/workspace/.northset/bootstrap-home/python-site',
        'PATH=/workspace/.northset/bootstrap-home/python-site/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
      go: ['GOMODCACHE=/northset-cache/go-mod', 'GOCACHE=/northset-cache/go-build'],
      rust: ['CARGO_HOME=/northset-cache/cargo', 'CARGO_TARGET_DIR=/northset-cache/target'],
    }[spec.executor.profile] ?? [];
    args.splice(args.length - 1, 0, '--mount', `type=bind,src=${cacheDir},dst=/northset-cache`,
      ...cacheEnvironment.flatMap((value) => ['--env', value]));
  }
  return [...args, 'sh', '-c', shell(commands)];
}

function authorPrompt(spec, phase = 'direct_fix') {
  const shared = [
    `Issue: ${spec.issue_url}`,
    `Problem statement: ${spec.problem_statement}`,
    `Acceptance criteria:\n${spec.acceptance_criteria.map((item) => `- ${item}`).join('\n')}`,
    `Constraints:\n${spec.constraints.map((item) => `- ${item}`).join('\n')}`,
    spec.implementation_hints.length
      ? `Optional non-binding implementation hints (validate against current code; do not treat as requirements):\n${spec.implementation_hints.map((item) => `- ${item}`).join('\n')}`
      : 'There are no implementation hints; derive the smallest repository-native fix.',
    spec.process_requirements.length
      ? `Repository process requirements:\n${spec.process_requirements.map((item) => `- ${item}`).join('\n')}`
      : 'No additional repository process requirements were identified.',
    'Do not edit repository pull-request templates or process documentation; the host renders the final PR body after human review.',
    'Do not modify dependencies, lockfiles, CI, release files, generated dependency output, or version numbers. Do not commit; the host creates one canonical DCO commit.',
  ];
  if (phase === 'test_only') return [...shared,
    `This is the test-only phase. Add only the regression test at ${spec.oracle.test_paths.join(', ')}. Do not modify production source. The host will run \`${spec.oracle.command}\` against the base behavior and stop the attempt unless it exits ${spec.oracle.base_exit_code} with marker ${JSON.stringify(spec.oracle.base_failure_contains)}.`,
    'Stop immediately after writing the regression. Do not implement the fix and do not commit.',
  ].join('\n\n');
  if (phase === 'fix_only') return [...shared,
    `The host has independently confirmed that the test-only change fails on the base with marker ${JSON.stringify(spec.oracle.base_failure_contains)}. Keep that regression intact and implement the smallest production fix.`,
    `Run every declared check before finishing: ${spec.executor.commands.join(' && ')}`,
  ].join('\n\n');
  return [...shared,
    `Red/green requirement: first add the regression test at ${spec.oracle.test_paths.join(', ')} and confirm \`${spec.oracle.command}\` fails for the defect; then implement the smallest fix and make it pass.`,
    `Run every declared check before finishing: ${spec.executor.commands.join(' && ')}`,
  ].join('\n\n');
}

export function authorDockerArgs(spec, workspace, image, codexHome, phase = 'direct_fix') {
  const command = [
    `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --model gpt-5.6-sol -c model_reasoning_effort=${quote(authorEffort(spec))} -c service_tier=fast ${quote(authorPrompt(spec, phase))}`,
  ];
  const args = commonDockerArgs(spec, workspace, image, {home: '/tmp', phase: 'author', protectGit: true});
  args.splice(args.length - 1, 0,
    '--mount', `type=bind,src=${codexHome},dst=/codex-home`,
    '--mount', `type=bind,src=${path.join(codexHome, 'auth.json')},dst=/codex-home/auth.json,readonly`,
    '--env', 'CODEX_HOME=/codex-home');
  if (spec.executor.profile === 'python') args.splice(args.length - 1, 0,
    '--env', 'PYTHONPATH=/workspace/.northset/bootstrap-home/python-site',
    '--env', 'PATH=/workspace/.northset/bootstrap-home/python-site/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  return [...args, 'sh', '-c', shell(command)];
}

export function checkDockerArgs(spec, workspace, image, command) {
  const args = commonDockerArgs(spec, workspace, image, {
    network: 'none', phase: 'oracle', workspaceReadonly: true,
  });
  const profileEnvironment = {
    node: ['COREPACK_HOME=/workspace/.northset/bootstrap-home/.cache/node/corepack'],
    python: ['PIP_CACHE_DIR=/workspace/.northset/bootstrap-home/.cache/pip',
      'PYTHONPATH=/workspace/.northset/bootstrap-home/python-site', 'PYTHONDONTWRITEBYTECODE=1',
      'PATH=/workspace/.northset/bootstrap-home/python-site/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
    go: ['GOMODCACHE=/workspace/.northset/bootstrap-home/go/pkg/mod', 'GOCACHE=/tmp/go-build'],
    rust: ['CARGO_HOME=/workspace/.northset/bootstrap-home/.cargo', 'CARGO_TARGET_DIR=/tmp/cargo-target', 'CARGO_NET_OFFLINE=true'],
  }[spec.executor.profile] ?? [];
  const sandboxArgs = [
    ...profileEnvironment.flatMap((value) => ['--env', value]),
    '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=512m',
  ];
  if (spec.oracle.test_paths.some((testPath) => testPath.startsWith('ui/'))) {
    sandboxArgs.push('--tmpfs', '/workspace/repo/ui/node_modules/.vite-temp:rw,exec,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=700');
  }
  args.splice(args.length - 1, 0, ...sandboxArgs);
  return [...args, 'sh', '-c', shell([command])];
}

async function prepareCodexHome(base) {
  const target = path.join(base, 'codex-home');
  await rm(target, {recursive: true, force: true});
  await mkdir(target, {recursive: true, mode: 0o700});
  const source = process.env.CODEX_HOME ?? path.join(process.env.HOME ?? '', '.codex');
  await cp(path.join(source, 'auth.json'), path.join(target, 'auth.json'));
  await writeFile(path.join(target, 'config.toml'),
    'approval_policy = "never"\n[history]\npersistence = "none"\n[features]\napps = false\nmemories = false\nmulti_agent = false\n',
    {mode: 0o600});
  return target;
}

async function resolveAuthorImage(runImpl = run, deadline = null) {
  const inspected = await runImpl('docker', ['image', 'inspect', AUTHOR_IMAGE, '--format', '{{.Id}}'], {
    timeoutMs: 30_000, deadline,
  });
  if (inspected.code !== 0 || !/^sha256:[0-9a-f]{64}$/i.test(inspected.stdout.trim())) {
    throw new Error(`prebuilt author image ${AUTHOR_IMAGE} is missing; run node bin/build-author-image.mjs once`);
  }
  return inspected.stdout.trim();
}

export async function dependencyCacheKey(spec, repo, image, {
  architecture = 'unknown', repositoryNodeId = null, trustDomain = 'authored',
} = {}) {
  if (!['authored', 'foreign'].includes(trustDomain)) throw new Error('cache trust domain must be authored or foreign');
  const names = {
    node: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'],
    python: ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'requirements-test.txt', 'poetry.lock', 'uv.lock'],
    go: ['go.mod', 'go.sum'],
    rust: ['Cargo.toml', 'Cargo.lock'],
  }[spec.executor.profile] ?? [];
  const lockfiles = [];
  for (const name of names) {
    try { lockfiles.push({name, sha256: sha256(await readFile(path.join(repo, name)))}); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const candidate = parseCandidate(spec.candidate);
  const lockfileDigest = sha256(Buffer.from(canonical(lockfiles)));
  const installCommandDigest = sha256(Buffer.from(canonical(spec.executor.install_commands)));
  return sha256(Buffer.from(canonical({
    repository: `${candidate.owner}/${candidate.repo}`.toLowerCase(),
    repository_node_id: repositoryNodeId ?? `legacy:${candidate.owner}/${candidate.repo}`.toLowerCase(),
    profile: spec.executor.profile,
    image_digest: image,
    architecture,
    install_command_digest: installCommandDigest,
    lockfile_digest: lockfileDigest,
    trust_domain: trustDomain,
  })))
    .slice('sha256:'.length);
}

const NODE_NATIVE_DEPENDENCIES = new Set([
  'better-sqlite3', 'bcrypt', 'canvas', 'fsevents', 'node-gyp', 'sharp', 'sqlite3',
]);

export async function detectToolchainClass(profile, repo) {
  if (!['node', 'python'].includes(profile)) return {toolchain_class: null, signals: []};
  const signals = new Set();
  if (profile === 'node') {
    const packageFile = path.join(repo, 'package.json');
    const packageBytes = await readFile(packageFile, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (packageBytes !== null) {
      let packageJson;
      try { packageJson = JSON.parse(packageBytes); } catch { packageJson = {}; }
      if (packageJson.gypfile === true) signals.add('node-gypfile');
      const installScript = ['preinstall', 'install', 'postinstall']
        .map((name) => packageJson.scripts?.[name]).filter(Boolean).join('\n');
      if (/\b(?:node-gyp|prebuild|cmake-js|cargo-cp-artifact)\b/i.test(installScript)) signals.add('node-install-script');
      const dependencies = {...packageJson.dependencies, ...packageJson.optionalDependencies, ...packageJson.devDependencies};
      if (Object.keys(dependencies).some((name) => NODE_NATIVE_DEPENDENCIES.has(name))) signals.add('node-native-dependency');
    }
    if (await lstat(path.join(repo, 'binding.gyp')).then((value) => value.isFile()).catch(() => false)) {
      signals.add('node-binding-gyp');
    }
  } else {
    const metadata = [];
    for (const name of ['pyproject.toml', 'setup.py', 'setup.cfg']) {
      const content = await readFile(path.join(repo, name), 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      metadata.push(content);
    }
    if (/\b(?:maturin|setuptools-rust|rust_extension|cython|ext_modules|Extension\s*\()\b/i.test(metadata.join('\n'))) {
      signals.add('python-extension-metadata');
    }
  }
  const native = signals.size > 0;
  return {toolchain_class: `${profile}-${native ? 'native' : 'pure'}`, signals: [...signals].sort()};
}

export function isNativeToolchainFailure(result) {
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  return /(?:node-gyp|gyp ERR|Python\.h|maturin|Rust compiler|cargo[^\n]*not found|(?:gcc|g\+\+|clang|make)[^\n]*not found|unable to execute[^\n]*(?:gcc|clang))/i.test(output);
}

async function runDocker(runImpl, args, options = {}) {
  const result = await runImpl('docker', args, options);
  if (result.timedOut) {
    const nameIndex = args.indexOf('--name');
    const name = nameIndex >= 0 ? args[nameIndex + 1] : null;
    if (name) await runImpl('docker', ['rm', '-f', name], {timeoutMs: 5_000});
  }
  return result;
}

async function must(label, result) {
  if (result.code !== 0) {
    const kind = result.timedOut ? ' timed out' : result.outputLimitExceeded ? ' exceeded output limit' : '';
    throw new Error(`${label}${kind} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`);
  }
  return result;
}

export async function requireModelRunnerSuccess(label, result) {
  attachTrustedModelProviderErrorFromCodexJsonl(result);
  try {
    return await must(label, result);
  } catch (error) {
    Object.defineProperty(error, MODEL_RUNNER_RESULT, {value: result});
    throw error;
  }
}

async function runModelRunnerDocker(runImpl, args, options) {
  try {
    return attachTrustedModelProviderErrorFromCodexJsonl(await runDocker(runImpl, args, options));
  } catch (error) {
    attachTrustedModelProviderErrorFromCodexJsonl(error);
    Object.defineProperty(error, MODEL_RUNNER_RESULT, {value: error});
    throw error;
  }
}

async function resolveImage(spec, log, deadline) {
  await log(`pulling executor image ${spec.executor.image} before credentials enter the workspace…`);
  await must('docker pull', await run('docker', ['pull', spec.executor.image], {timeoutMs: limits(spec).wallMs, deadline}));
  const inspected = await must('docker image inspect', await run('docker', ['image', 'inspect', spec.executor.image, '--format', '{{json .RepoDigests}}'], {deadline, timeoutMs: 30_000}));
  let digests;
  try { digests = JSON.parse(inspected.stdout.trim()); } catch { throw new Error('docker returned invalid RepoDigests'); }
  const digest = digests?.find((value) => /@sha256:[0-9a-f]{64}$/i.test(value));
  if (!digest) throw new Error(`image ${spec.executor.image} has no immutable repository digest`);
  return digest;
}

async function resolveBatchImage(spec, options, log, deadline) {
  options.imagePromises ??= new Map();
  if (!options.imagePromises.has(spec.executor.image)) {
    options.imagePromises.set(spec.executor.image, (async () => {
      const warmed = options.warmCache?.images?.find((item) => item.image === spec.executor.image);
      if (!warmed) return resolveImage(spec, log, deadline);
      if (!/@sha256:[0-9a-f]{64}$/i.test(warmed.digest ?? '')) throw new Error(`warm manifest has invalid digest for ${spec.executor.image}`);
      const inspected = await must('verify warmed executor image', await run('docker', [
        'image', 'inspect', warmed.digest, '--format', '{{json .RepoDigests}}',
      ], {deadline, timeoutMs: 30_000}));
      const values = JSON.parse(inspected.stdout.trim());
      if (!values.includes(warmed.digest)) throw new Error(`warmed image digest is no longer present locally: ${warmed.digest}`);
      await log(`using warmed immutable executor image ${warmed.digest}`);
      return warmed.digest;
    })());
  }
  return options.imagePromises.get(spec.executor.image);
}

async function resolveImageArchitecture(image, deadline) {
  const inspected = await must('inspect executor image architecture', await run('docker', [
    'image', 'inspect', image, '--format', '{{.Architecture}}',
  ], {deadline, timeoutMs: 30_000}));
  const architecture = inspected.stdout.trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(architecture)) throw new Error('docker returned an invalid image architecture');
  return architecture;
}

export function buildWarmPlan(specs) {
  const images = [];
  const repositories = [];
  const seenImages = new Set();
  const seenRepositories = new Set();
  for (const spec of specs) {
    const imageKey = spec.executor.image;
    if (!seenImages.has(imageKey)) {
      seenImages.add(imageKey);
      images.push({profile: spec.executor.profile, image: spec.executor.image,
        smoke_command: PROFILE_REGISTRY.profiles[spec.executor.profile]?.smoke_command});
    }
    const repository = `${parseCandidate(spec.candidate).owner}/${parseCandidate(spec.candidate).repo}`;
    if (!seenRepositories.has(repository.toLowerCase())) {
      seenRepositories.add(repository.toLowerCase());
      repositories.push({repository, target_repo: spec.target_repo, base_commit: spec.base_commit, spec});
    }
  }
  return {images, repositories};
}

export async function warmBatch(specs, {
  runImpl = run,
  mirrorInitializer = (spec, options) => ensureRepositoryMirror(spec, options),
  statfsImpl = statfs,
  mirrorRoot = REPOSITORY_MIRROR_ROOT,
  deadline = null,
  minimumFreeBytes = 5 * 1024 * 1024 * 1024,
} = {}) {
  validateSpecs(specs);
  const plan = buildWarmPlan(specs);
  const images = [];
  for (const item of plan.images) {
    await must(`warm executor image ${item.image}`, await runImpl('docker', ['pull', item.image], {deadline, timeoutMs: 30 * 60 * 1000}));
    const inspected = await must(`inspect executor image ${item.image}`, await runImpl('docker', ['image', 'inspect', item.image, '--format', '{{json .RepoDigests}}'], {deadline, timeoutMs: 30_000}));
    let values;
    try { values = JSON.parse(inspected.stdout.trim()); } catch { throw new Error(`docker returned invalid RepoDigests for ${item.image}`); }
    const digest = values.find((value) => /@sha256:[0-9a-f]{64}$/i.test(value));
    if (!digest) throw new Error(`image ${item.image} has no immutable repository digest`);
    if (!item.smoke_command) throw new Error(`profile ${item.profile} has no smoke command`);
    await must(`smoke executor image ${item.image}`, await runImpl('docker', [
      'run', '--rm', '--network', 'none', '--read-only', '--security-opt', 'no-new-privileges',
      '--cap-drop=ALL', digest, 'sh', '-c', item.smoke_command,
    ], {deadline, timeoutMs: 60_000}));
    images.push({...item, digest, warmed: true});
  }
  const repositories = [];
  for (const item of plan.repositories) {
    const mirror = await mirrorInitializer(item.spec, {root: mirrorRoot, deadline, runImpl});
    repositories.push({repository: item.repository, base_commit: item.base_commit, mirror});
  }
  await mkdir(mirrorRoot, {recursive: true, mode: 0o700});
  const disk = await statfsImpl(mirrorRoot);
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);
  if (!Number.isFinite(freeBytes) || freeBytes < minimumFreeBytes) {
    throw new Error(`warm disk readiness failed: ${freeBytes} free bytes is below ${minimumFreeBytes}; no data was deleted`);
  }
  return {
    schema_version: 1,
    warmed_at: new Date().toISOString(),
    images,
    repositories,
    disk: {path: mirrorRoot, free_bytes: freeBytes, minimum_free_bytes: minimumFreeBytes, ready: true, data_deleted: false},
  };
}

export async function removeRunWorkspace(workspace, removeImpl = rm) {
  await removeImpl(workspace, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}

export function repositoryMirrorPath(spec, root = REPOSITORY_MIRROR_ROOT) {
  const candidate = parseCandidate(spec.candidate);
  const readable = `${candidate.owner}__${candidate.repo}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
  return path.join(root, `${readable}.git`);
}

async function pathExists(value) {
  try { await stat(value); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function withMirrorLock(lock, deadline, operation) {
  const waitStarted = Date.now();
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (deadline?.expired() || (!deadline && Date.now() - waitStarted >= 2 * 60 * 1000)) {
        throw new Error(`deadline exhausted waiting for repository mirror lock ${lock}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { return await operation(); }
  finally { await rm(lock, {recursive: true, force: true}); }
}

export async function ensureRepositoryMirror(spec, {
  root = REPOSITORY_MIRROR_ROOT, deadline = null, runImpl = run,
} = {}) {
  await mkdir(root, {recursive: true, mode: 0o700});
  const mirror = repositoryMirrorPath(spec, root);
  await withMirrorLock(`${mirror}.lock`, deadline, async () => {
    if (!await pathExists(mirror)) {
      const temporary = `${mirror}.${process.pid}.tmp`;
      await rm(temporary, {recursive: true, force: true});
      await must('initialize repository mirror', await runImpl('git', ['clone', '--mirror', spec.target_repo, temporary], {
        env: sanitizedGitEnv(), deadline, timeoutMs: 2 * 60 * 1000,
      }));
      await rename(temporary, mirror);
    } else {
      await must('refresh repository mirror', await runImpl('git', ['-C', mirror, 'fetch', '--prune', 'origin'], {
        env: sanitizedGitEnv(), deadline, timeoutMs: 2 * 60 * 1000,
      }));
    }
    await must('verify base commit in repository mirror', await runImpl('git', ['-C', mirror, 'cat-file', '-e', `${spec.base_commit}^{commit}`], {
      env: sanitizedGitEnv(), deadline, timeoutMs: 30_000,
    }));
  });
  return mirror;
}

export async function cloneBase(spec, workspace, deadline, {mirrorRoot = REPOSITORY_MIRROR_ROOT, runImpl = run} = {}) {
  await removeRunWorkspace(workspace);
  await mkdir(workspace, {recursive: true, mode: 0o700});
  const repo = path.join(workspace, 'repo');
  const mirror = await ensureRepositoryMirror(spec, {root: mirrorRoot, deadline, runImpl});
  await must('clone target from repository mirror', await runImpl('git', ['clone', '--shared', '--no-checkout', mirror, repo], {
    env: sanitizedGitEnv(), deadline, timeoutMs: 2 * 60 * 1000,
  }));
  await must('bind workspace origin', await runImpl('git', ['-C', repo, 'remote', 'set-url', 'origin', spec.target_repo], {
    env: sanitizedGitEnv(), deadline, timeoutMs: 30_000,
  }));
  const localGit = (...args) => runImpl('git', ['-C', repo, ...args], {
    env: sanitizedGitEnv(), deadline, timeoutMs: 2 * 60 * 1000,
  });
  await must('checkout base', await localGit('checkout', '--detach', spec.base_commit));
  await must('set mission git user name', await localGit('config', 'user.name', OSS_IDENTITY.name));
  await must('set mission git user email', await localGit('config', 'user.email', OSS_IDENTITY.email));
  return repo;
}

export async function cloneStandaloneRepository(source, destination, commit, deadline = null, {runImpl = run} = {}) {
  await rm(destination, {recursive: true, force: true});
  await must('standalone verifier clone', await runImpl('git', [
    'clone', '--no-local', '--no-checkout', source, destination,
  ], {env: sanitizedGitEnv(), deadline, timeoutMs: 2 * 60 * 1000}));
  const localGit = (...args) => runImpl('git', ['-C', destination, ...args], {
    env: sanitizedGitEnv(), deadline, timeoutMs: 2 * 60 * 1000,
  });
  await must('standalone verifier checkout', await localGit('checkout', '--detach', commit));
  await must('standalone verifier reset', await localGit('reset', '--hard', commit));
  await must('standalone verifier clean', await localGit('clean', '-ffdx'));
  // --no-local transfers reachable objects instead of propagating the author's shared
  // alternates chain. Remove any unexpected alternates before proving the clone stands alone.
  await rm(path.join(destination, '.git', 'objects', 'info', 'alternates'), {force: true});
  await must('standalone verifier object check', await localGit('cat-file', '-e', `${commit}^{commit}`));
  const head = (await must('standalone verifier HEAD', await localGit('rev-parse', 'HEAD^{commit}'))).stdout.trim();
  if (head !== commit) throw new Error(`standalone verifier source commit changed: ${head} != ${commit}`);
  const status = await must('standalone verifier repository check', await localGit('status', '--porcelain'));
  if (status.stdout.trim()) throw new Error(`standalone verifier clone is dirty: ${status.stdout.trim()}`);
  return destination;
}

export async function verifyTestOnlyAuthorResult(spec, workspace, image, {
  deadline = null, runImpl = run, log = async () => {}, dependencySnapshot = null,
} = {}) {
  const repo = path.join(workspace, 'repo');
  const head = await must('read test-only author HEAD', await runImpl('git', ['-C', repo, 'rev-parse', 'HEAD'], {
    env: sanitizedGitEnv(), deadline, timeoutMs: 30_000,
  }));
  if (head.stdout.trim() !== spec.base_commit) throw new Error('FAILED_ORACLE_DESIGN: test-only phase must not commit or change history');
  const status = await must('read test-only author changes', await runImpl('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all'], {
    env: sanitizedGitEnv(), deadline, timeoutMs: 30_000,
  }));
  const changed = status.stdout.split('\n').filter(Boolean).map((line) => line.slice(3).trim().replace(/^.* -> /, ''));
  if (!changed.length) throw new Error('FAILED_ORACLE_DESIGN: test-only phase produced no regression');
  const allowed = new Set(spec.oracle.test_paths);
  const unexpected = changed.filter((file) => !allowed.has(file));
  if (unexpected.length || !spec.oracle.test_paths.some((file) => changed.includes(file))) {
    throw new Error(`FAILED_ORACLE_DESIGN: test-only phase may change only oracle.test_paths (${unexpected.join(', ') || 'oracle path missing'})`);
  }
  if (!dependencySnapshot) throw new Error('FAILED_ORACLE_DESIGN: immutable pre-author dependency snapshot is required');
  const redRoot = await mkdtemp(path.join(os.tmpdir(), `${spec.mission_id}-test-only-red-`));
  try {
    const redRepo = path.join(redRoot, 'repo');
    await must('test-only base clone', await runImpl('git', ['clone', '--local', '--no-hardlinks', '--no-checkout', repo, redRepo], {
      env: sanitizedGitEnv(), deadline, timeoutMs: 2 * 60 * 1000,
    }));
    const redGit = (...args) => runImpl('git', ['-C', redRepo, ...args], {
      env: sanitizedGitEnv(), deadline, timeoutMs: 2 * 60 * 1000,
    });
    await must('test-only base checkout', await redGit('checkout', '--detach', spec.base_commit));
    await must('test-only base reset', await redGit('reset', '--hard', spec.base_commit));
    await must('test-only base clean', await redGit('clean', '-ffdx'));
    for (const testPath of spec.oracle.test_paths) {
      const source = path.join(repo, testPath);
      const target = path.join(redRepo, testPath);
      const info = await lstat(source).catch(() => null);
      if (!info?.isFile()) throw new Error(`FAILED_ORACLE_DESIGN: oracle test path is not a regular file: ${testPath}`);
      await mkdir(path.dirname(target), {recursive: true});
      await cp(source, target, {verbatimSymlinks: true});
    }
    await copyDependencySnapshot(spec.executor.profile, dependencySnapshot, redRepo);
    await log('test-only author phase: checking base-red marker against pre-author dependencies before spending the fix phase…');
    const observed = await runDocker(runImpl, checkDockerArgs(spec, redRoot, image, spec.oracle.command), {
      timeoutMs: limits(spec).wallMs, deadline, outputLimitBytes: limits(spec).output,
    });
    const output = `${observed.stdout}\n${observed.stderr}`;
    if (observed.code !== spec.oracle.base_exit_code || !output.includes(spec.oracle.base_failure_contains)) {
      throw new Error(`FAILED_ORACLE_DESIGN: test-only regression did not exit ${spec.oracle.base_exit_code} with marker ${JSON.stringify(spec.oracle.base_failure_contains)}`);
    }
    return {changed_files: changed, base_exit: observed.code, base_failure_observed: true,
      output_sha256: sha256(Buffer.from(output)), dependency_snapshot_sha256: dependencySnapshot.digest};
  } finally {
    await rm(redRoot, {recursive: true, force: true});
  }
}

export async function runAuthorContainer(spec, dirs, {
  dryRun = false, log = async () => {}, image = spec.executor.image, authorImage = null,
  cacheDir = null, cacheKey = null, architecture = 'unknown', toolchainClass = null,
  nativeFallback = null, deadline = null, runImpl = run,
} = {}) {
  const codexHome = dryRun ? '/tmp/northset-codex-home' : await prepareCodexHome(dirs.base);
  const resolvedAuthorImage = authorImage ?? (dryRun ? AUTHOR_IMAGE : await resolveAuthorImage(runImpl, deadline));
  const authoringMode = spec.authoring_mode ?? 'direct_fix';
  const plan = {
    bootstrap: dependencyBootstrapDockerArgs(spec, dirs.authorWorkspace, image, cacheDir),
    author: authorDockerArgs(spec, dirs.authorWorkspace, resolvedAuthorImage, codexHome,
      authoringMode === 'test_only_then_fix' ? 'test_only' : 'direct_fix'),
    authorFix: authoringMode === 'test_only_then_fix'
      ? authorDockerArgs(spec, dirs.authorWorkspace, resolvedAuthorImage, codexHome, 'fix_only') : null,
  };
  if (dryRun) return {planned: true, docker: plan.author, codex: ['codex', authorPrompt(spec)], ...plan};
  const names = ['dependency-bootstrap', 'author'].map((phase) => containerName(spec, phase));
  for (const name of names) await runImpl('docker', ['rm', '-f', name]);
  await log('author phase: credential mounted only after bootstrap…');
  try {
    await log('dependency bootstrap: network on, no Codex executable or credential mounted…');
    let bootstrapRetryCount = 0;
    let effectiveImage = image;
    let effectiveCacheKey = cacheKey;
    let effectiveArchitecture = architecture;
    let effectiveToolchainClass = toolchainClass;
    let toolchainEscalation = null;
    let bootstrap = await runDocker(runImpl, plan.bootstrap, {timeoutMs: limits(spec).wallMs, deadline});
    let bootstrapDurationMs = bootstrap.durationMs ?? 0;
    if (bootstrap.code !== 0 && !bootstrap.timedOut && (!deadline || deadline.remainingMs() > 0)) {
      bootstrapRetryCount = 1;
      if (toolchainClass?.endsWith('-pure') && isNativeToolchainFailure(bootstrap) && nativeFallback) {
        const fallback = await nativeFallback();
        effectiveImage = fallback.image;
        effectiveCacheKey = fallback.cacheKey;
        effectiveArchitecture = fallback.architecture;
        effectiveToolchainClass = fallback.toolchainClass;
        toolchainEscalation = {
          from: toolchainClass, to: fallback.toolchainClass, reason: 'classified_native_toolchain_error',
        };
        await log(`dependency bootstrap: escalating ${toolchainClass} to ${fallback.toolchainClass} after a classified native build error…`);
        plan.bootstrap = dependencyBootstrapDockerArgs(spec, dirs.authorWorkspace, fallback.image, fallback.cacheDir);
      } else {
        await log('dependency bootstrap infrastructure failed; retrying once within the original deadline…');
      }
      bootstrap = await runDocker(runImpl, plan.bootstrap, {timeoutMs: limits(spec).wallMs, deadline});
      bootstrapDurationMs += bootstrap.durationMs ?? 0;
    }
    await must('dependency bootstrap', bootstrap);
    const dependencySnapshot = await snapshotProfileDependencies(spec.executor.profile,
      path.join(dirs.authorWorkspace, 'repo'), path.join(dirs.base, 'dependency-snapshot'));
    await log(`dependency bootstrap snapshot fixed before credentialed authoring: ${dependencySnapshot.digest}`);
    let author = await runModelRunnerDocker(
      runImpl, plan.author, {timeoutMs: AUTHOR_MODEL_ATTEMPT_MS, deadline},
    );
    await requireModelRunnerSuccess(
      authoringMode === 'test_only_then_fix' ? 'test-only author container' : 'author container', author,
    );
    let authorDurationMs = author.durationMs ?? 0;
    if (authoringMode === 'test_only_then_fix') {
      await verifyTestOnlyAuthorResult(spec, dirs.authorWorkspace, effectiveImage, {deadline, runImpl, log, dependencySnapshot});
      const fixTimeoutMs = remainingAuthorModelMs(authorDurationMs);
      if (fixTimeoutMs <= 0) throw new Error('author attempt exhausted its shared 12-minute model budget before the fix-only phase');
      author = await runModelRunnerDocker(runImpl, plan.authorFix, {timeoutMs: fixTimeoutMs, deadline});
      await requireModelRunnerSuccess('fix-only author container', author);
      authorDurationMs += author.durationMs ?? 0;
      if (authorDurationMs > AUTHOR_MODEL_ATTEMPT_MS) {
        throw new Error('author attempt exceeded its shared 12-minute model budget');
      }
    }
    return {
      repoDir: path.join(dirs.authorWorkspace, 'repo'),
      image: effectiveImage,
      architecture: effectiveArchitecture,
      cacheKey: effectiveCacheKey,
      toolchainClass: effectiveToolchainClass,
      toolchainEscalation,
      authorImage: resolvedAuthorImage,
      dependencySnapshot,
      usage: {
        bootstrap_duration_ms: bootstrapDurationMs,
        bootstrap_retry_count: bootstrapRetryCount,
        author_duration_ms: authorDurationMs,
        requested_model: 'gpt-5.6-sol',
        actual_model: null,
        reasoning_effort: authorEffort(spec),
        service_tier: 'fast',
        model_requests: null,
        input_tokens: null,
        cached_input_tokens: null,
        output_tokens: null,
        reasoning_tokens: null,
      },
    };
  } finally {
    for (const name of names) await runImpl('docker', ['rm', '-f', name]);
    await rm(codexHome, {recursive: true, force: true});
  }
}

export async function changedEntries(repo, base, commit, deadline = null) {
  const [names, numstat, baseFiles] = await Promise.all([
    missionGit(deadline, repo, 'diff', '--name-status', '-z', `${base}..${commit}`),
    missionGit(deadline, repo, 'diff', '--numstat', '-z', `${base}..${commit}`),
    missionGit(deadline, repo, 'ls-tree', '-r', '--name-only', base),
  ]);
  const statusParts = names.stdout.split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index < statusParts.length;) {
    const status = statusParts[index++];
    const statusCode = status[0];
    if (statusCode === 'R' || statusCode === 'C') {
      const oldPath = statusParts[index++];
      const file = statusParts[index++];
      entries.push({path: file, oldPath, status, statusCode});
    } else {
      entries.push({path: statusParts[index++], status, statusCode});
    }
  }
  for (const entry of entries) {
    const tree = await missionGit(deadline, repo, 'ls-tree', commit, '--', entry.path);
    const match = /^(\d{6})\s/.exec(tree.stdout);
    // Deleted paths have no entry in the new tree. Their base mode still matters for
    // symlink/submodule risk classification, so fall back to the base tree.
    if (match) entry.mode = match[1];
    else {
      const previous = await missionGit(deadline, repo, 'ls-tree', base, '--', entry.path);
      entry.mode = /^(\d{6})\s/.exec(previous.stdout)?.[1] ?? '000000';
    }
  }
  let lines = 0;
  const numstatParts = numstat.stdout.split('\0');
  for (let index = 0; index < numstatParts.length;) {
    const part = numstatParts[index++];
    if (!part) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(part);
    if (!match) continue;
    let file = match[3];
    let oldPath = null;
    if (!file) {
      oldPath = numstatParts[index++] ?? null;
      file = numstatParts[index++] ?? '';
    }
    const entry = entries.find((item) => item.path === file && (!oldPath || item.oldPath === oldPath));
    if (entry && (match[1] === '-' || match[2] === '-')) entry.binary = true;
    if (match[1] !== '-') lines += Number(match[1]);
    if (match[2] !== '-') lines += Number(match[2]);
  }
  return {entries, lines, baseFiles: baseFiles.stdout.trim().split('\n').filter(Boolean)};
}

export function canonicalCommitArgs(spec) {
  return ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-s', '-m', spec.pr.title];
}

export async function normalizeAuthorResult(spec, repo, ready, deadline = null) {
  const authorHead = (await must('read author HEAD', await missionGit(deadline, repo, 'rev-parse', 'HEAD'))).stdout.trim();
  const dirty = await missionGit(deadline, repo, 'status', '--porcelain', '--untracked-files=all');
  if (authorHead === spec.base_commit && !dirty.stdout.trim()) return {noChange: true};
  const ancestor = await missionGit(deadline, repo, 'merge-base', '--is-ancestor', spec.base_commit, authorHead);
  if (ancestor.code !== 0) throw new Error('author history is not descended from the approved base commit');
  if (authorHead !== spec.base_commit) await must('squash author commits', await missionGit(deadline, repo, 'reset', '--soft', spec.base_commit));
  await must('git add', await missionGit(deadline, repo, 'add', '-A'));
  const staged = await missionGit(deadline, repo, 'diff', '--cached', '--quiet', spec.base_commit, '--');
  if (staged.code === 0) return {noChange: true};
  if (staged.code !== 1) throw new Error(`cannot inspect staged author result: ${staged.stderr.trim()}`);
  const env = sanitizedGitEnv({
    GIT_AUTHOR_NAME: OSS_IDENTITY.name, GIT_AUTHOR_EMAIL: OSS_IDENTITY.email,
    GIT_COMMITTER_NAME: OSS_IDENTITY.name, GIT_COMMITTER_EMAIL: OSS_IDENTITY.email,
  });
  await must('canonical DCO commit', await run('git', ['-C', repo, ...canonicalCommitArgs(spec)], {env, deadline, timeoutMs: 2 * 60 * 1000}));
  const commit = (await missionGit(deadline, repo, 'rev-parse', 'HEAD')).stdout.trim();
  const parents = (await must('canonical parent check', await missionGit(deadline, repo, 'rev-list', '--parents', '-n', '1', commit))).stdout.trim().split(' ');
  if (parents.length !== 2 || parents[1] !== spec.base_commit) {
    throw new Error(`canonical commit must have exactly the approved base ${spec.base_commit} as parent`);
  }
  const identity = await missionGit(deadline, repo, 'show', '-s', '--format=%ae%n%ce%n%b', commit);
  const [authorEmail = '', committerEmail = '', ...body] = identity.stdout.split('\n');
  assertOssCommitIdentity({authorEmail, committerEmail, body: body.join('\n')});
  const patch = await must('canonical patch', await missionGit(deadline, repo, 'diff', '--binary', '--full-index', '--no-ext-diff', `${spec.base_commit}..${commit}`));
  if (!patch.stdout.trim()) return {noChange: true};
  await mkdir(ready, {recursive: true, mode: 0o700});
  const patchFile = path.join(ready, 'fix.patch');
  await writeFile(patchFile, patch.stdout);
  const tree = await assertPatchCommitBinding(repo, spec.base_commit, commit, patchFile, {deadline});
  const changed = await changedEntries(repo, spec.base_commit, commit, deadline);
  if (changed.entries.length > 5) throw new Error(`initial lane allows at most 5 changed files, got ${changed.entries.length}`);
  if (changed.lines > 300) throw new Error(`initial lane allows at most 300 changed lines, got ${changed.lines}`);
  const classes = classifyChangedFiles(changed.baseFiles, changed.entries);
  const permitted = spec.allow_modified_existing_tests === true
    ? ['source', 'added-test', 'modified-existing-test'] : ['source', 'added-test'];
  const allowedNonproduction = new Set(spec.allow_nonproduction_paths ?? []);
  const forbidden = classes.filter((item) => !permitted.includes(item.class) &&
    !(item.class === 'nonproduction' && allowedNonproduction.has(item.path)));
  if (forbidden.length) throw new Error(`initial lane forbids changed class(es): ${forbidden.map((item) => `${item.class}:${item.path}`).join(', ')}`);
  const modifiedTests = classes.filter((item) => item.class === 'modified-existing-test');
  if (modifiedTests.length && spec.allow_modified_existing_tests !== true) {
    throw new Error(`fast lane forbids modified existing tests: ${modifiedTests.map((item) => item.path).join(', ')}`);
  }
  if (modifiedTests.length > MAX_ELEVATED_EXISTING_TESTS) {
    throw new Error(`elevated lane allows at most ${MAX_ELEVATED_EXISTING_TESTS} modified existing tests, got ${modifiedTests.length}`);
  }
  assertOracleChangedPaths(spec, classes);
  if (spec.work_category === 'defect_fix' && !classes.some((item) => item.class === 'source')) {
    throw new Error('defect_fix must modify at least one production-source file');
  }
  if (spec.work_category === 'defect_fix') {
    const evidencePaths = qualificationSourceEvidencePaths(spec, {required: true});
    if (!classes.some((item) => item.class === 'source' && evidencePaths.includes(item.path))) {
      throw new Error('defect_fix production change must touch a qualification source-evidence path');
    }
  }
  if (spec.work_category === 'defect_fix' && !classes.some((item) => item.class === 'added-test') && spec.allow_modified_existing_tests !== true) {
    throw new Error('defect_fix fast lane must add an oracle-bound regression test');
  }
  return {
    noChange: false, commit, tree, patch: patch.stdout, patchFile,
    patchSha: sha256(Buffer.from(patch.stdout)), classes, changedFiles: changed.entries.map((item) => item.path), lines: changed.lines,
  };
}

export async function copyNodeDependencies(fromRepo, toRepo) {
  for (const directory of ['node_modules', '.yarn', path.join('ui', 'node_modules'), path.join('client', 'node_modules')]) {
    await cp(path.join(fromRepo, directory), path.join(toRepo, directory), {recursive: true, verbatimSymlinks: true})
      .catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
  const sourceBootstrap = path.join(path.dirname(fromRepo), '.northset');
  const targetBootstrap = path.join(path.dirname(toRepo), '.northset');
  await mkdir(path.dirname(targetBootstrap), {recursive: true});
  await cp(sourceBootstrap, targetBootstrap, {recursive: true, verbatimSymlinks: true})
    .catch((error) => { if (error.code !== 'ENOENT') throw error; });
  for (const workspaceRoot of ['packages', 'apps']) {
    const entries = await readdir(path.join(fromRepo, workspaceRoot), {withFileTypes: true})
      .catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relative = path.join(workspaceRoot, entry.name, 'node_modules');
      const target = path.join(toRepo, relative);
      await mkdir(path.dirname(target), {recursive: true});
      await cp(path.join(fromRepo, relative), target, {recursive: true, verbatimSymlinks: true})
        .catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

async function copyIfPresent(source, target) {
  await mkdir(path.dirname(target), {recursive: true});
  await cp(source, target, {recursive: true, verbatimSymlinks: true})
    .catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

function safeRelative(value) {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    throw new Error(`unsafe dependency-cache path ${JSON.stringify(value)}`);
  }
  return value;
}

export async function copyProfileDependencies(profile, fromRepo, toRepo) {
  if (!PROFILE_REGISTRY.profiles[profile]) throw new Error(`unknown dependency profile ${profile}`);
  if (profile === 'node') return copyNodeDependencies(fromRepo, toRepo);
  const policy = PROFILE_REGISTRY.profiles[profile].dependency_cache;
  for (const forbidden of policy.never_copy ?? []) {
    if ((policy.workspace_paths ?? []).includes(forbidden)) throw new Error(`${profile} cache policy attempts to copy forbidden ${forbidden}`);
  }
  for (const relative of policy.workspace_paths ?? []) {
    const clean = safeRelative(relative);
    await copyIfPresent(path.join(fromRepo, clean), path.join(toRepo, clean));
  }
  for (const relative of policy.bootstrap_paths ?? []) {
    const clean = safeRelative(relative);
    await copyIfPresent(path.join(path.dirname(fromRepo), clean), path.join(path.dirname(toRepo), clean));
  }
}

async function assertContainedDependencySymlinks(root) {
  async function walk(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name);
      const info = await lstat(file);
      if (info.isDirectory()) await walk(file);
      else if (info.isSymbolicLink()) {
        const target = await readlink(file);
        const resolved = path.resolve(path.dirname(file), target);
        if (path.isAbsolute(target) || (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))) {
          throw new Error(`pre-author dependency snapshot contains an external symlink: ${path.relative(root, file)}`);
        }
      }
    }
  }
  await walk(root);
}

export async function snapshotProfileDependencies(profile, fromRepo, snapshotRoot) {
  if (!PROFILE_REGISTRY.profiles[profile]) throw new Error(`unknown dependency profile ${profile}`);
  const root = path.resolve(snapshotRoot);
  const repo = path.join(root, 'repo');
  await rm(root, {recursive: true, force: true});
  try {
    await mkdir(repo, {recursive: true, mode: 0o700});
    await copyProfileDependencies(profile, fromRepo, repo);
    await assertContainedDependencySymlinks(root);
    return {schema_version: 1, profile, root, repo,
      digest: await directoryDigest(root, {ignoreNames: ['.DS_Store']})};
  } catch (error) {
    await rm(root, {recursive: true, force: true});
    throw error;
  }
}

export async function copyDependencySnapshot(profile, snapshot, toRepo) {
  if (!snapshot || snapshot.profile !== profile || !snapshot.root || !snapshot.repo ||
      !/^sha256:[0-9a-f]{64}$/i.test(snapshot.digest ?? '')) {
    throw new Error(`invalid pre-author dependency snapshot for ${profile}`);
  }
  const before = await directoryDigest(snapshot.root, {ignoreNames: ['.DS_Store']});
  if (before !== snapshot.digest) {
    throw new Error(`pre-author dependency snapshot changed: ${before} != ${snapshot.digest}`);
  }
  await copyProfileDependencies(profile, snapshot.repo, toRepo);
  const after = await directoryDigest(snapshot.root, {ignoreNames: ['.DS_Store']});
  if (after !== snapshot.digest) {
    throw new Error(`pre-author dependency snapshot changed during copy: ${after} != ${snapshot.digest}`);
  }
  return snapshot.digest;
}

export async function assertExpectedTree(repo, commit, deadline = null) {
  const head = (await must('read verifier HEAD', await missionGit(deadline, repo, 'rev-parse', 'HEAD'))).stdout.trim();
  if (head !== commit) throw new Error(`verifier HEAD changed: ${head} != ${commit}`);
  const tracked = await missionGit(deadline, repo, 'status', '--porcelain', '--untracked-files=no');
  if (tracked.stdout.trim()) throw new Error(`verifier mutated the expected tracked tree: ${tracked.stdout.trim()}`);
  return true;
}

async function worktreeFingerprint(repo, deadline) {
  const [unstaged, staged, status] = await Promise.all([
    missionGit(deadline, repo, 'diff', '--binary', '--full-index', '--no-ext-diff'),
    missionGit(deadline, repo, 'diff', '--cached', '--binary', '--full-index', '--no-ext-diff'),
    missionGit(deadline, repo, 'status', '--porcelain', '--untracked-files=all'),
  ]);
  return sha256(Buffer.from(canonical({unstaged: unstaged.stdout, staged: staged.stdout, status: status.stdout})));
}

export async function runDifferentialOracle(spec, dirs, authorRepo, result, image, log, deadline, dependencySnapshot) {
  if (!dependencySnapshot) throw new Error('differential oracle requires an immutable pre-author dependency snapshot');
  const root = await mkdtemp(path.join(os.tmpdir(), `${spec.mission_id}-oracle-`));
  try {
    const repo = path.join(root, 'repo');
    await must('oracle clone', await run('git', ['clone', '--local', '--no-hardlinks', authorRepo, repo], {
      env: sanitizedGitEnv(), deadline, timeoutMs: 2 * 60 * 1000,
    }));
    await must('oracle base checkout', await missionGit(deadline, repo, 'checkout', '--detach', spec.base_commit));
    await missionGit(deadline, repo, 'reset', '--hard', spec.base_commit);
    await missionGit(deadline, repo, 'clean', '-ffdx');
    const testPatch = await must('test-only patch', await missionGit(deadline, authorRepo, 'diff', '--binary', '--full-index', '--no-ext-diff',
      `${spec.base_commit}..${result.commit}`, '--', ...spec.oracle.test_paths));
    if (!testPatch.stdout.trim()) throw new Error('oracle test_paths produced no test-only patch');
    const testPatchFile = path.join(root, 'test-only.patch');
    await writeFile(testPatchFile, testPatch.stdout);
    await must('apply test-only patch', await missionGit(deadline, repo, 'apply', '--binary', testPatchFile));
    await copyDependencySnapshot(spec.executor.profile, dependencySnapshot, repo);
    const baseFingerprint = await worktreeFingerprint(repo, deadline);
    await log('differential oracle: running the test-only patch on the base tree (expected failure)…');
    const observed = await runDocker(run, checkDockerArgs(spec, root, image, spec.oracle.command), {
      timeoutMs: limits(spec).wallMs, deadline, outputLimitBytes: limits(spec).output,
    });
    if (await worktreeFingerprint(repo, deadline) !== baseFingerprint) throw new Error('differential oracle mutated the base test tree');
    if (!Number.isInteger(observed.code) || observed.code === 0) {
      if (observed.code === 0) throw new Error('differential oracle failed: the test-only patch passed on the base tree');
      throw new Error('differential oracle failed: the base regression run did not produce a trustworthy exit code');
    }
    const baseOutput = `${observed.stdout}\n${observed.stderr}`;
    if (observed.code !== spec.oracle.base_exit_code || !baseOutput.includes(spec.oracle.base_failure_contains)) {
      const tail = baseOutput.trim().slice(-2_000);
      throw new Error(
        `differential oracle failed: base exit ${observed.code} (expected ${spec.oracle.base_exit_code}); ` +
        `failure marker observed=${baseOutput.includes(spec.oracle.base_failure_contains)}; output tail: ${tail}`,
      );
    }
    const record = {
      schema_version: 2,
      kind: spec.oracle.kind,
      command: spec.oracle.command,
      base_expected: spec.oracle.base_expected,
      base_exit_expected: spec.oracle.base_exit_code,
      base_exit: observed.code,
      base_observed: true,
      base_failure_contains: spec.oracle.base_failure_contains,
      base_failure_observed: true,
      patched_expected: spec.oracle.patched_expected,
      patched_execution: 'canonical_verifier_pending',
      patched_observed: false,
      base_output_sha256: sha256(Buffer.from(baseOutput)),
      dependency_snapshot_sha256: dependencySnapshot.digest,
      declared_commands: spec.executor.commands,
    };
    const file = path.join(dirs.ready, 'oracle.json');
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
    return {record, file, sha: sha256(Buffer.from(canonical(record)))};
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

export async function completeOracleWithCanonicalVerification(oracle, bundle) {
  const record = {
    ...oracle.record,
    patched_execution: 'fresh_canonical_verifier',
    patched_observed: true,
    declared_commands_executed_once: true,
    canonical_bundle_digest: bundle.bundleDigest,
  };
  await writeFile(oracle.file, `${JSON.stringify(record, null, 2)}\n`);
  return {record, file: oracle.file, sha: sha256(Buffer.from(canonical(record)))};
}

export function buildEconomicInput(spec, {
  missionSha256, issueSnapshotSha256, result, authorUsage, timings,
  totalDurationMs, attempts, issueUrl = spec.issue_url,
}) {
  if (spec.schema_version !== 2) return null;
  const resource = limits(spec);
  const qualification = spec.qualification;
  const productionFiles = result.classes.filter((item) => item.class === 'source').length;
  const testFiles = result.classes.filter((item) => ['added-test', 'modified-existing-test'].includes(item.class)).length;
  return {
    schema_version: 1,
    task: {
      task_id: spec.task_id,
      attempt_id: spec.mission_id,
      attempt_sequence: spec.attempt_sequence,
      work_category: spec.work_category,
      external_demand: {
        source: 'public_github_issue',
        issue_url: issueUrl,
        acceptance_contract_digest: sha256(Buffer.from(canonical(qualification.acceptance_contract), 'utf8')),
        invitation_type: qualification.invitation_evidence.type,
        invitation_url: qualification.invitation_evidence.url,
      },
    },
    funding: {
      program: 'Northset OSS Fund',
      initiative: 'OSS mission experimentation',
      budget_id: null,
      financial_cap: null,
      currency: null,
    },
    attempt_lineage: {
      attempts_total: attempts.length,
      successful_attempt_id: spec.mission_id,
      attempts,
    },
    usage: {
      discovery: {
        finder_run_id: qualification.finder_run_id ?? null,
        candidate_rank: qualification.candidate_rank ?? null,
        elapsed_ms: qualification.finder_elapsed_ms ?? null,
      },
      qualification: {
        review_id: qualification.review_id,
        requested_model: qualification.requested_model,
        actual_model: qualification.actual_model ?? null,
        reasoning_effort: qualification.reasoning_effort,
        service_tier: qualification.service_tier,
        duration_ms: qualification.review_duration_ms ?? null,
        model_requests: qualification.model_requests ?? null,
        input_tokens: qualification.input_tokens ?? null,
        cached_input_tokens: qualification.cached_input_tokens ?? null,
        output_tokens: qualification.output_tokens ?? null,
        reasoning_tokens: qualification.reasoning_tokens ?? null,
      },
      authoring: {
        requested_model: authorUsage.requested_model,
        actual_model: authorUsage.actual_model,
        reasoning_effort: authorUsage.reasoning_effort,
        service_tier: authorUsage.service_tier,
        duration_ms: authorUsage.author_duration_ms,
        bootstrap_duration_ms: authorUsage.bootstrap_duration_ms,
        bootstrap_retry_count: authorUsage.bootstrap_retry_count,
        model_requests: authorUsage.model_requests,
        input_tokens: authorUsage.input_tokens,
        cached_input_tokens: authorUsage.cached_input_tokens,
        output_tokens: authorUsage.output_tokens,
        reasoning_tokens: authorUsage.reasoning_tokens,
      },
      preparation: {
        total_duration_ms: totalDurationMs,
        stages: timings.map((item) => ({stage: item.stage, duration_ms: item.duration_ms})),
      },
      verification: {
        executor_elapsed_ms: null,
        networked_setup_elapsed_ms: null,
        dependency_install_ms: null,
        declared_commands_ms: null,
        unclassified_executor_ms: null,
        cpu_ms: null,
        peak_rss_bytes: null,
        measurement_status: 'partial',
      },
      resource_envelope: {
        cpus: resource.cpus,
        memory_mb: Number.parseInt(resource.memory, 10),
        pids: resource.pids,
        wall_clock_seconds_per_command: Math.round(resource.wallMs / 1000),
        output_bytes_per_stream: resource.output,
      },
    },
    work_scope: {
      files_changed: result.changedFiles.length,
      changed_lines: result.lines,
      production_files: productionFiles,
      test_files: testFiles,
      checks_declared: spec.executor.commands.length,
      checks_not_run: spec.receipt?.checks_not_run ?? [],
    },
    costs: {
      status: 'partial',
      currency: null,
      lines: [{
        component: 'maintainer_payment',
        measurement_class: 'observed_quantity_unpriced',
        quantity: '0',
        unit: 'external_transfer',
        unit_rate: null,
        amount: null,
        currency: null,
        source_refs: [{artifact: 'bundle/mission.json', artifact_sha256: missionSha256, json_pointer: '/payment/maintainer_payment'}],
        rate_card_digest: null,
        allocation_method: null,
        finality: 'final',
        visibility: 'public',
      }],
      known_direct_cost: null,
      allocated_shared_cost: null,
      human_standard_cost: null,
      total_economic_cost: null,
      missing_components: ['model_inference', 'actual_host_compute', 'human_review', 'shared_tooling'],
    },
    completeness: {
      task_identity: 'complete',
      technical_execution: 'complete',
      attempt_lineage: 'complete',
      usage: 'partial',
      cost: 'unpriced',
      external_outcome: 'partial',
      business_value: 'not_observed',
    },
    provenance: {
      spec_sha256: sha256(Buffer.from(canonical(spec), 'utf8')),
      qualification_evidence_sha256: qualification.evidence_sha256,
      issue_snapshot_sha256: issueSnapshotSha256,
    },
  };
}

export function canonicalIssueUrlFromSnapshot(specIssueUrl, issueSnapshotBytes) {
  let snapshot;
  try { snapshot = JSON.parse(issueSnapshotBytes); }
  catch { throw new Error('issue snapshot is not valid JSON'); }
  const canonicalUrl = snapshot?.issue?.html_url;
  if (typeof canonicalUrl !== 'string' || !canonicalUrl) {
    throw new Error('issue snapshot is missing issue.html_url');
  }
  let expected;
  let observed;
  try {
    expected = new URL(specIssueUrl);
    observed = new URL(canonicalUrl);
  } catch {
    throw new Error('issue snapshot issue.html_url is not a valid URL');
  }
  const sameIdentity = expected.protocol === 'https:'
    && observed.protocol === 'https:'
    && expected.hostname.toLowerCase() === 'github.com'
    && observed.hostname.toLowerCase() === 'github.com'
    && expected.pathname.toLowerCase() === observed.pathname.toLowerCase()
    && expected.search === observed.search
    && expected.hash === observed.hash;
  if (!sameIdentity) throw new Error('issue snapshot issue.html_url does not match the mission issue URL');
  return canonicalUrl;
}

export function publicRepoPolicySnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = ['ai_policy_summary', 'checked_at', 'url'];
  if (Object.keys(value).sort().join('\0') !== fields.join('\0')) return null;
  if (!fields.every((field) => typeof value[field] === 'string' && value[field].trim())) return null;
  return value;
}

function publicMissionInput(spec, repoDir, patchFile, issueSnapshotFile, image, result, economicContext = null) {
  const {owner} = parseCandidate(spec.candidate);
  const issueOrTask = economicContext?.issueSnapshotBytes
    ? canonicalIssueUrlFromSnapshot(spec.issue_url, economicContext.issueSnapshotBytes)
    : spec.issue_url;
  const workspaceMode = spec.workspace_mode ?? 'readonly';
  const defaultLimitations = [
    'Does not prove code quality',
    'Does not prove security',
    "Contributor self-run record of Northset's own contribution; not the maintainer's verification.",
    `The declared network-off checks run after a disclosed online dependency install in ${image}.`,
  ];
  if (workspaceMode === 'writable_copy') defaultLimitations.push(WRITABLE_COPY_LIMITATION);
  const declaredLimitations = spec.receipt?.limitations ?? defaultLimitations;
  const limitations = workspaceMode === 'writable_copy' && !declaredLimitations.includes(WRITABLE_COPY_LIMITATION)
    ? [...declaredLimitations, WRITABLE_COPY_LIMITATION] : declaredLimitations;
  const mission = {
      mission_id: spec.mission_id,
      variant: 'author_contribution',
      claims_tier: [],
      grade: null,
      disclosure_label: 'Northset contributed this fix and ran its declared checks. Contributor self-run. Not maintainer verification.',
      funding_source: 'Northset OSS Fund',
      northset_role: 'worker_runtime_operator',
      external_counterparty: `${owner} maintainers`,
      target_repo: spec.target_repo,
      issue_or_task: issueOrTask,
      consent_artifact: null,
      repo_policy_snapshot: publicRepoPolicySnapshot(spec.receipt?.repo_policy_snapshot),
      worker_identity: {runtime: 'northset-oss executor v1', human_operator: 'aeziz'},
      base_commit: spec.base_commit,
      workspace_mode: workspaceMode,
      patch_commit: result.commit,
      patch_diff_hash: result.patchSha,
      commands_declared: spec.executor.commands,
      environment: null,
      run_record_bundle_digest: null,
      attestation_uri: null,
      maintainer_outcome: {status: 'pending', link: null, decided_at: null},
      payment: {maintainer_payment: 'none', merge_contingent: false},
      limitations,
    };
  const input = {
    mission,
    repo_dir: repoDir,
    patch_file: patchFile,
    consent_file: null,
    issue_snapshot_file: issueSnapshotFile,
    ci_links_file: null,
    executor: {
      profile: spec.executor.profile,
      image,
      install_commands: spec.executor.install_commands,
      commands: spec.executor.commands,
      workspace_mode: workspaceMode,
      workspace_write_allowlist: spec.workspace_write_allowlist ?? [],
      limits: {
        cpus: 2, memory_mb: 4096, pids: 512,
        wall_clock_seconds_per_command: 1800, output_bytes_per_stream: 2_000_000,
        ...(spec.executor.limits ?? {}),
      },
    },
  };
  if (spec.schema_version === 2) {
    if (!economicContext?.issueSnapshotBytes) throw new Error('schema-v2 verification requires economic capture context');
    input.economic = buildEconomicInput(spec, {
      ...economicContext,
      issueUrl: issueOrTask,
      missionSha256: sha256(Buffer.from(`${JSON.stringify(mission, null, 2)}\n`)),
      issueSnapshotSha256: sha256(economicContext.issueSnapshotBytes),
    });
  }
  return input;
}

export async function runCanonicalVerifier(spec, dirs, authorRepo, result, image, snapshotFile, log, deadline, economicContext = null) {
  const baseRepo = path.join(dirs.base, 'public-base');
  await cloneStandaloneRepository(authorRepo, baseRepo, spec.base_commit, deadline);
  const staging = path.join(dirs.base, 'prepared-missions');
  await rm(staging, {recursive: true, force: true});
  await mkdir(staging, {recursive: true});
  const input = publicMissionInput(spec, baseRepo, result.patchFile, snapshotFile, image, result, economicContext);
  const inputFile = path.join(dirs.base, 'public-mission-input.json');
  await writeFile(inputFile, `${JSON.stringify(input, null, 2)}\n`);
  await log('canonical verifier: building the final public-ready bundle during prepare…');
  const command = await run('node', [RUN_MISSION, inputFile, '--missions-dir', staging, '--require-success', '--json'],
    {timeoutMs: limits(spec).wallMs * Math.max(2, spec.executor.commands.length + 1), deadline, outputLimitBytes: limits(spec).output});
  let parsed;
  try { parsed = JSON.parse(command.stdout); } catch { parsed = null; }
  if (command.code !== 0 || !parsed?.ok) throw new Error(`canonical verifier failed: ${parsed?.message ?? (command.stderr || command.stdout).trim()}`);
  await must('public bundle verify', await run('node', [BUNDLE_CLI, 'verify', parsed.missionDir], {deadline, timeoutMs: 60_000}));
  const destination = path.join(dirs.ready, 'public-mission');
  await rm(destination, {recursive: true, force: true});
  await cp(parsed.missionDir, destination, {recursive: true, verbatimSymlinks: true});
  return {missionDir: destination, bundleDigest: parsed.bundleDigest};
}

function missionDirs(runsDir, id) {
  const base = path.join(runsDir, id);
  return {base, authorWorkspace: path.join(base, 'author-workspace'), ready: path.join(base, 'ready-pack')};
}

function terminalReasonClass(state) {
  if (state === 'FAILED_ORACLE') return 'verification';
  if (state === 'FAILED_AUTHOR') return 'authoring';
  if (state === 'FAILED_BUDGET') return 'time_budget';
  if (state === 'FAILED_INFRA_TERMINAL') return 'infrastructure';
  if (state === 'STALE') return 'precondition_drift';
  if (state === 'NOCHANGE') return 'no_change';
  if (state === 'DECLINED') return 'human_decline';
  if (state === 'ABORTED_STALE') return 'precondition_drift';
  if (state === 'ABORTED_AFTER_PUBLICATION') return 'collision';
  if (state === 'ABORTED_BUDGET') return 'time_budget';
  return null;
}

export function githubProviderThrottleFailure(error) {
  if (error?.code !== 'GITHUB_PROVIDER_THROTTLED') return null;
  const errorCode = typeof error?.code === 'string' && error.code
    ? error.code
    : 'GITHUB_GATEWAY_TERMINAL';
  const signal = typeof error?.signal === 'string' && error.signal ? error.signal : null;
  return {
    failure_reason_code: 'PROVIDER_THROTTLED',
    terminal_reason_class: 'PROVIDER_THROTTLED',
    retryable: false,
    error_code: errorCode,
    signal,
  };
}

export async function latchPrepareProviderThrottle(error, {
  activeStage,
  resourceControlFile,
  gatewayOptions = {},
} = {}) {
  const gatewayFailure = githubProviderThrottleFailure(error);
  const modelRunnerResult = error?.[MODEL_RUNNER_RESULT] ?? null;
  const modelProviderThrottle = !gatewayFailure && activeStage === 'author' && modelRunnerResult !== null &&
    isProviderThrottle(modelRunnerResult, {source: 'model_runner'});
  if (!gatewayFailure && !modelProviderThrottle) return {gatewayFailure: null, modelProviderThrottle: false};

  const resourceControl = await loadResourceControl(resourceControlFile);
  if (!resourceControl.provider_pause) {
    await tripPersistentProviderThrottle(resourceControlFile, {
      provider: gatewayFailure ? 'GitHub' : 'OpenAI',
      signal: gatewayFailure
        ? (gatewayFailure.signal ?? gatewayFailure.error_code)
        : 'OPENAI_MODEL_RATE_LIMIT',
      at: gatewayFailure ? (error?.tripped_at ?? new Date().toISOString()) : new Date().toISOString(),
      incidentId: gatewayFailure ? (error?.incident_id ?? undefined) : undefined,
      gatewayStateDir: resolveGhGatewayStateDir(gatewayOptions),
    });
  }
  return {gatewayFailure, modelProviderThrottle};
}

const TERMINAL_ATTEMPT_STATES = new Set([
  'STALE', 'NOCHANGE', 'DECLINED', 'FAILED_BUDGET', 'FAILED_AUTHOR',
  'FAILED_ORACLE', 'FAILED_INFRA_TERMINAL',
]);
const TERMINAL_LINEAGE_JOURNAL_STATES = new Set([
  'SHIPPED', 'DECLINED', 'ABORTED_STALE', 'ABORTED_AFTER_PUBLICATION',
  'ABORTED_BUDGET', 'FAILED_INFRA_TERMINAL',
]);

export async function writeAttempt(dirs, spec, state, detail, timings, startedAt, failure = null) {
  const updatedAt = new Date();
  const laneHours = Math.max(0, updatedAt.getTime() - startedAt.getTime()) / 3_600_000;
  const attribution = buildAttemptAttribution({
    qualification: {
      duration_ms: spec.qualification?.review_duration_ms ?? null,
      input_tokens: spec.qualification?.input_tokens ?? null,
      cached_input_tokens: spec.qualification?.cached_input_tokens ?? null,
      output_tokens: spec.qualification?.output_tokens ?? null,
      reasoning_tokens: spec.qualification?.reasoning_tokens ?? null,
    },
    author: {duration_ms: timings.find((item) => item.stage === 'author')?.duration_ms ?? null},
    execution: {wall_ms: Math.max(0, updatedAt.getTime() - startedAt.getTime()), lane_hours: laneHours},
  });
  await writeFile(path.join(dirs.base, 'attempt.json'), `${JSON.stringify({
    schema_version: spec.schema_version === 2 ? 2 : 1,
    ...(spec.schema_version === 2 ? {
      mission_id: spec.mission_id,
      task_id: spec.task_id,
      attempt_sequence: spec.attempt_sequence,
      work_category: spec.work_category,
      terminal_reason_class: failure?.terminal_reason_class ?? terminalReasonClass(state),
      ...(failure ? {
        failure_reason_code: failure.failure_reason_code,
        retryable: failure.retryable,
        error_code: failure.error_code,
        signal: failure.signal,
      } : {}),
    } : {}),
    state,
    profile: spec.executor.profile,
    workspace_mode: spec.workspace_mode ?? 'readonly',
    started_at: startedAt.toISOString(),
    updated_at: updatedAt.toISOString(),
    prepare_duration_ms: Math.max(0, updatedAt.getTime() - startedAt.getTime()),
    lane_hours: laneHours,
    terminal_reason: detail ?? null,
    timings,
    attribution,
    attribution_complete: validateAttemptAttribution(attribution),
  }, null, 2)}\n`);
}

export async function attemptLineageForSpec(runsDir, spec) {
  if (spec.schema_version !== 2) return [];
  const attempts = [];
  const entries = await readdir(runsDir, {withFileTypes: true}).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let record;
    try { record = JSON.parse(await readFile(path.join(runsDir, entry.name, 'attempt.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (record.task_id !== spec.task_id || record.mission_id === spec.mission_id) continue;
    let journal = null;
    try { journal = JSON.parse(await readFile(path.join(runsDir, entry.name, 'ship.journal.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (journal && journal.mission_id !== record.mission_id) {
      throw new Error(`prior attempt ${record.mission_id} has a ship journal for another mission`);
    }
    const state = journal?.state ?? record.state;
    if (journal && !TERMINAL_LINEAGE_JOURNAL_STATES.has(state)) {
      throw new Error(`prior attempt ${record.mission_id} is not terminal (ship state ${state})`);
    }
    if (!journal && !TERMINAL_ATTEMPT_STATES.has(state)) {
      throw new Error(`prior attempt ${record.mission_id} is not terminal (attempt state ${state})`);
    }
    if (state === 'SHIPPED') {
      throw new Error(`task ${spec.task_id} already shipped as ${record.mission_id}; a new attempt is not allowed`);
    }
    attempts.push({
      attempt_id: record.mission_id,
      attempt_sequence: record.attempt_sequence,
      state,
      terminal_reason_class: record.terminal_reason_class ?? terminalReasonClass(state) ?? null,
    });
  }
  attempts.push({
    attempt_id: spec.mission_id,
    attempt_sequence: spec.attempt_sequence,
    state: 'READY',
    terminal_reason_class: null,
  });
  attempts.sort((left, right) => left.attempt_sequence - right.attempt_sequence || left.attempt_id.localeCompare(right.attempt_id));
  const expectedSequences = Array.from({length: spec.attempt_sequence}, (_, index) => index + 1);
  if (attempts.length !== expectedSequences.length ||
      attempts.some((attempt, index) => attempt.attempt_sequence !== expectedSequences[index])) {
    throw new Error(`task attempt lineage must contain one contiguous sequence from 1 through ${spec.attempt_sequence}`);
  }
  return attempts;
}

async function readAttempt(dirs) {
  try { return JSON.parse(await readFile(path.join(dirs.base, 'attempt.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function validateActiveSpecs(specsDir) {
  const files = (await readdir(specsDir, {withFileTypes: true}))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name).sort();
  const specs = [];
  for (const file of files) specs.push(JSON.parse(await readFile(path.join(specsDir, file), 'utf8')));
  validateSpecs(specs);
  return specs;
}

export async function prepareMission(spec, options) {
  const dirs = missionDirs(options.runsDir, spec.mission_id);
  const resourceControlFile = path.join(options.runsDir, 'phase0', 'resource-control.json');
  const startedAt = new Date();
  const timings = [];
  let activeStage = 'initialize';
  const previous = await readAttempt(dirs);
  if (previous?.state) {
    const stable = new Set(['READY', 'STALE', 'NOCHANGE', 'DECLINED', 'FAILED_BUDGET', 'FAILED_AUTHOR', 'FAILED_ORACLE', 'FAILED_INFRA_TERMINAL']);
    const state = stable.has(previous.state) ? previous.state : 'FAILED_INFRA_TERMINAL';
    const detail = `mission ID is already consumed in state ${previous.state}; use a new mission ID`;
    if (state !== previous.state) {
      previous.state = state;
      previous.updated_at = new Date().toISOString();
      previous.terminal_reason = detail;
      await writeFile(path.join(dirs.base, 'attempt.json'), `${JSON.stringify(previous, null, 2)}\n`);
    }
    return {
      state,
      spec,
      detail,
      timings: previous.timings ?? [],
      ...(previous.failure_reason_code ? {
        failure_reason_code: previous.failure_reason_code,
        terminal_reason_class: previous.terminal_reason_class,
        retryable: previous.retryable,
        error_code: previous.error_code,
        signal: previous.signal,
      } : {}),
    };
  }
  const resourceControl = {
    ...(await loadResourceControl(resourceControlFile)),
    task_lane_hours_used: await resourceUsageForTask(options.runsDir, spec.task_id),
  };
  assertPhase0Spec(spec);
  assertTaskResourcePolicy(spec, resourceControl);
  const deadline = createDeadline(Math.min(PREPARE_BUDGET_MS, remainingTaskLaneMs(spec, resourceControl)));
  await rm(dirs.ready, {recursive: true, force: true});
  await mkdir(dirs.base, {recursive: true, mode: 0o700});
  const log = async (message) => {
    await appendFile(path.join(dirs.base, 'prepare.log'), `[${new Date().toISOString()}] ${message}\n`, {mode: 0o600});
    console.log(`  ${spec.mission_id}  ${message}`);
  };
  const stage = async (name, operation) => {
    activeStage = name;
    const began = Date.now();
    try { return await operation(); }
    finally { timings.push({stage: name, duration_ms: Date.now() - began}); }
  };
  try {
    await writeAttempt(dirs, spec, 'QUALIFIED', null, timings, startedAt);
    const prepareRecheck = options.prepareAdapter?.recheck ?? recheck;
    const checked = await stage('prepare_recheck', () => prepareRecheck(spec, log, {mode: 'prepare', deadline}));
    if (!checked.clean) {
      const detail = checked.reasons.join('; ');
      await writeAttempt(dirs, spec, 'STALE', detail, timings, startedAt);
      return {state: 'STALE', spec, detail, timings};
    }
    const repo = await stage('clone', () => cloneBase(spec, dirs.authorWorkspace, deadline));
    const detectedToolchain = await stage('toolchain_classification', () => detectToolchainClass(spec.executor.profile, repo));
    const toolchainClass = spec.executor.toolchain_class ?? detectedToolchain.toolchain_class;
    const toolchainConfig = toolchainClass ? PROFILE_REGISTRY.toolchain_classes?.[toolchainClass] : null;
    const executionSpec = toolchainConfig
      ? {...spec, executor: {...spec.executor, image: toolchainConfig.image, toolchain_class: toolchainClass}}
      : spec;
    const image = await stage('executor_image', () => resolveBatchImage(executionSpec, options, log, deadline));
    const architecture = await stage('executor_architecture', () => resolveImageArchitecture(image, deadline));
    const cacheIdentity = {
      architecture,
      repositoryNodeId: checked.snapshot.repository.node_id,
      trustDomain: 'authored',
    };
    const cacheKey = await dependencyCacheKey(executionSpec, repo, image, cacheIdentity);
    const cacheDir = path.join(DEPENDENCY_CACHE_ROOT, cacheIdentity.trustDomain, cacheKey);
    await mkdir(cacheDir, {recursive: true, mode: 0o700});
    const nativeFallback = toolchainClass?.endsWith('-pure') ? async () => {
      const nativeClass = `${spec.executor.profile}-native`;
      const nativeConfig = PROFILE_REGISTRY.toolchain_classes[nativeClass];
      const nativeSpec = {...spec, executor: {...spec.executor, image: nativeConfig.image, toolchain_class: nativeClass}};
      const nativeImage = await resolveBatchImage(nativeSpec, options, log, deadline);
      const nativeArchitecture = await resolveImageArchitecture(nativeImage, deadline);
      const nativeCacheKey = await dependencyCacheKey(nativeSpec, repo, nativeImage, {
        ...cacheIdentity, architecture: nativeArchitecture,
      });
      const nativeCacheDir = path.join(DEPENDENCY_CACHE_ROOT, cacheIdentity.trustDomain, nativeCacheKey);
      await mkdir(nativeCacheDir, {recursive: true, mode: 0o700});
      return {image: nativeImage, architecture: nativeArchitecture, cacheKey: nativeCacheKey,
        cacheDir: nativeCacheDir, toolchainClass: nativeClass};
    } : null;
    const authorRun = await stage('author', () => runAuthorContainer(executionSpec, dirs, {
      image, log, cacheDir, cacheKey, architecture, toolchainClass, nativeFallback, deadline,
    }));
    const result = await stage('canonical_commit', () => normalizeAuthorResult(spec, repo, dirs.ready, deadline));
    if (result.noChange) {
      await writeAttempt(dirs, spec, 'NOCHANGE', 'author produced no change', timings, startedAt);
      return {state: 'NOCHANGE', spec, detail: 'author produced no change', timings};
    }
    await log(`canonical commit ${result.commit.slice(0, 12)}; ${result.changedFiles.length} files / ${result.lines} changed lines`);
    let oracle = await stage('differential_oracle', () => runDifferentialOracle(
      spec, dirs, repo, result, authorRun.image, log, deadline, authorRun.dependencySnapshot,
    ));

    const snapshotFile = path.join(dirs.ready, 'issue_snapshot.json');
    const policyFile = path.join(dirs.ready, 'policy_snapshot.json');
    const policySnapshot = spec.receipt?.repo_policy_snapshot ?? {};
    await Promise.all([
      writeFile(snapshotFile, `${JSON.stringify(checked.snapshot, null, 2)}\n`),
      writeFile(policyFile, `${JSON.stringify(policySnapshot, null, 2)}\n`),
    ]);
    const issueSnapshotBytes = await readFile(snapshotFile);
    const attempts = await attemptLineageForSpec(options.runsDir, spec);
    const bundle = await stage('canonical_verifier', () => runCanonicalVerifier(
      spec, dirs, repo, result, authorRun.image, snapshotFile, log, deadline,
      spec.schema_version === 2 ? {
        issueSnapshotBytes,
        result,
        authorUsage: authorRun.usage,
        timings: [...timings],
        totalDurationMs: timings.reduce((total, timing) => total + timing.duration_ms, 0),
        attempts,
      } : null,
    ));
    oracle = await stage('oracle_binding', () => completeOracleWithCanonicalVerification(oracle, bundle));
    const body = prBody(spec, {changedFiles: result.changedFiles, commitOid: result.commit});
    const titleFile = path.join(dirs.ready, 'pr_title.txt');
    const bodyFile = path.join(dirs.ready, 'pr_body.md');
    await Promise.all([writeFile(titleFile, `${spec.pr.title}\n`), writeFile(bodyFile, body)]);
    const patchReviewInput = {
      spec,
      classes: result.classes,
      patch_file: 'fix.patch',
      pr_body_file: 'pr_body.md',
    };
    const patchReviewInputFile = path.join(dirs.ready, 'patch-review-input.json');
    await writeFile(patchReviewInputFile, `${JSON.stringify(patchReviewInput, null, 2)}\n`);
    const patchReview = await stage('patch_review', async () => {
      const reviewed = reviewPatch({spec, classes: result.classes, patch: result.patch, prBody: body});
      await writeFile(path.join(dirs.ready, 'patch-review.json'), `${JSON.stringify(reviewed, null, 2)}\n`);
      if (!reviewed.ready) throw new Error(`deterministic patch review blocked READY: ${reviewed.blocking_reasons.join('; ')}`);
      return reviewed;
    });
    const preparedAt = new Date();
    const manifest = {
      schema_version: spec.schema_version === 2 ? 2 : 1,
      mission_id: spec.mission_id,
      ...(spec.schema_version === 2 ? {
        task_id: spec.task_id,
        attempt_sequence: spec.attempt_sequence,
        work_category: spec.work_category,
        calibration_ordinal: spec.calibration_ordinal ?? null,
        economic_sha256: sha256(await readFile(path.join(bundle.missionDir, 'bundle', 'economic.json'))),
      } : {}),
      prepared_at: preparedAt.toISOString(),
      expires_at: new Date(preparedAt.getTime() + READY_TTL_HOURS * 60 * 60 * 1000).toISOString(),
      repo: `${parseCandidate(spec.candidate).owner}/${parseCandidate(spec.candidate).repo}`,
      issue_url: spec.issue_url,
      issue_updated_at: spec.qualification.issue_updated_at,
      base_branch: spec.base_branch,
      base_commit: spec.base_commit,
      commit_oid: result.commit,
      patch_sha256: result.patchSha,
      tested_tree_oid: result.tree,
      bundle_digest: bundle.bundleDigest,
      public_mission_sha256: await directoryDigest(bundle.missionDir),
      spec_sha256: sha256(Buffer.from(canonical(spec), 'utf8')),
      issue_snapshot_sha256: sha256(await readFile(snapshotFile)),
      policy_snapshot_sha256: sha256(await readFile(policyFile)),
      oracle_sha256: oracle.sha,
      patch_review_sha256: sha256(Buffer.from(canonical(patchReview))),
      risk_flags: [
        ...patchReview.risks,
        ...(spec.workspace_mode === 'writable_copy'
          ? [{code: 'workspace-writable-copy', files: spec.workspace_write_allowlist ?? []}] : []),
      ],
      changed_file_classes: result.classes.map((item) => ({path: item.path, class: item.class})),
      pr_title: spec.pr.title,
      pr_body_sha256: sha256(Buffer.from(body)),
      pr_claim_text: normalizedPrClaimText(body),
      executor_image_digest: authorRun.image,
      executor_architecture: authorRun.architecture,
      repository_node_id: checked.snapshot.repository.node_id,
      toolchain_class: authorRun.toolchainClass,
      toolchain_signals: detectedToolchain.signals,
      toolchain_escalation: authorRun.toolchainEscalation,
      cache_trust_domain: 'authored',
      workspace_mode: spec.workspace_mode ?? 'readonly',
      author_image_digest: authorRun.authorImage,
      dependency_cache_key: authorRun.cacheKey,
      dependency_snapshot_sha256: authorRun.dependencySnapshot.digest,
      timings,
      total_duration_ms: Date.now() - startedAt.getTime(),
      planned_actions: [
        'push-reviewed-commit',
        'publish-prepared-ledger-batch', 'wait-prepared-ledger-checks', 'merge-prepared-ledger-batch',
        'verify-batch-attestations', 'wait-pages-readiness-once', 'confirm-individual-receipt-http-200', 'recheck-collision',
        'open-approved-upstream-pr', 'sync-guarded-pr-disclosure', 'record-pr-disclosure',
        'rebuild-full-ledger', 'publish-final-envelope-batch', 'wait-final-envelope-batch-checks',
        'merge-final-envelope-batch',
      ],
    };
    await writeFile(path.join(dirs.ready, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const digest = manifestDigest([manifest]);
    await log(`READY — base red observed, patched checks green, bundle ${bundle.bundleDigest}`);
    await writeAttempt(dirs, spec, 'READY', null, timings, startedAt);
    return {state: 'READY', spec, dirs, manifest, manifestDigest: digest, classes: result.classes};
  } catch (error) {
    const {gatewayFailure} = await latchPrepareProviderThrottle(error, {
      activeStage,
      resourceControlFile,
      gatewayOptions: options.gatewayOptions ?? {},
    });
    const budget = deadline.expired() || /timed out|deadline exhausted/i.test(error.message);
    const state = gatewayFailure ? 'FAILED_INFRA_TERMINAL'
      : budget ? 'FAILED_BUDGET'
      : activeStage === 'author' ? 'FAILED_AUTHOR'
        : ['differential_oracle', 'canonical_verifier', 'oracle_binding', 'patch_review'].includes(activeStage) ? 'FAILED_ORACLE'
          : 'FAILED_INFRA_TERMINAL';
    await writeAttempt(dirs, spec, state, error.message, timings, startedAt, gatewayFailure);
    return {state, spec, detail: error.message, timings, ...(gatewayFailure ?? {})};
  }
}

function markdownCell(value) { return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' '); }

export function buildBatchBoard(results) {
  const readyResults = results.filter((result) => result.state === 'READY');
  if (!readyResults.length) return null;
  if (readyResults.length > 50) throw new Error('one batch board may contain at most 50 READY missions');
  const manifests = readyResults.map((result) => result.manifest);
  const boardData = batchBoardData(manifests);
  const batchDigest = batchApprovalDigest(manifests);
  const failures = results.filter((result) => result.state !== 'READY').map((result) => ({
    mission_id: result.spec.mission_id, candidate: result.spec.candidate, state: result.state, detail: result.detail ?? null,
    ...(result.failure_reason_code ? {
      failure_reason_code: result.failure_reason_code,
      terminal_reason_class: result.terminal_reason_class,
      retryable: result.retryable,
      error_code: result.error_code,
      signal: result.signal,
    } : {}),
  }));
  const machine = {
    schema_version: 1,
    batch_digest: batchDigest,
    ordered_mission_ids: manifests.map((manifest) => manifest.mission_id),
    ...boardData,
    non_ready: failures,
  };
  const lines = [
    '# OSS preparation batch review board', '',
    `Batch digest: \`${batchDigest}\``, '',
    `Missions ready: ${manifests.length}`, '',
    `Changed-file classes: ${Object.entries(boardData.changed_file_class_counts).map(([name, count]) => `${name}=${count}`).join(', ') || 'none'}`, '',
    `Risk flags: ${Object.entries(boardData.risk_counts).map(([name, count]) => `${name}=${count}`).join(', ') || 'none'}`, '',
    '| # | Mission | Repository | Issue | Changed files | Base red | Declared checks | PR title | Normalized PR claim text | Risk |',
    '|---:|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [index, result] of readyResults.entries()) {
    const spec = result.spec;
    lines.push(`| ${index + 1} | ${markdownCell(spec.mission_id)} | ${markdownCell(result.manifest.repo)} | ${markdownCell(spec.issue_url)} | ${markdownCell(result.classes.map((item) => `${item.class}:${item.path}`).join(', '))} | ${markdownCell(spec.oracle.base_failure_contains)} | ${markdownCell(spec.executor.commands.join(' ; '))} | ${markdownCell(spec.pr.title)} | ${markdownCell(result.manifest.pr_claim_text)} | ${markdownCell((result.manifest.risk_flags ?? []).map((risk) => risk.code ?? risk).join(', ') || 'none')} |`);
  }
  if (failures.length) {
    lines.push('', '## Non-ready missions', '');
    for (const failure of failures) lines.push(`- ${failure.mission_id} ${failure.state}: ${failure.detail ?? 'no detail'}`);
  }
  lines.push('', 'Approval binds the ordered manifest bytes, patch hashes, PR-body hashes, risk data, and this board data.', '');
  return {machine, markdown: `${lines.join('\n')}\n`, manifests};
}

export async function writeBatchBoards(results, runsDir, explicitBase = null) {
  const board = buildBatchBoard(results);
  if (!board) return null;
  const short = board.machine.batch_digest.slice('sha256:'.length, 'sha256:'.length + 16);
  const base = explicitBase ? path.resolve(explicitBase) : path.join(runsDir, 'boards', `batch-${short}`);
  const jsonFile = base.endsWith('.json') ? base : `${base}.json`;
  const markdownFile = base.endsWith('.json') ? base.replace(/\.json$/i, '.md') : `${base}.md`;
  await mkdir(path.dirname(jsonFile), {recursive: true, mode: 0o700});
  await Promise.all([
    writeFile(jsonFile, `${JSON.stringify(board.machine, null, 2)}\n`, {mode: 0o600}),
    writeFile(markdownFile, board.markdown, {mode: 0o600}),
  ]);
  return {...board, jsonFile, markdownFile};
}

async function printBoard(results, options) {
  console.log('\nOSS PREPARE — REVIEW BOARD');
  for (const result of results.filter((item) => item.state !== 'READY')) {
    console.log(`${result.state} ${result.spec.mission_id} ${result.spec.candidate}: ${result.detail}`);
  }
  const board = await writeBatchBoards(results, options.runsDir, options.board);
  if (!board) return;
  process.stdout.write(board.markdown);
  console.log(`machine_board: ${board.jsonFile}`);
  console.log(`human_board: ${board.markdownFile}`);
  console.log(`batch_manifest_digest: ${board.machine.batch_digest}`);
  console.log(`node campaign/phase0/phase0-cli.mjs finalize-reviewed-board --board ${board.jsonFile} --runs ${options.runsDir} --out <reviewed-board.json>`);
  console.log('node campaign/phase0/phase0-cli.mjs sign-batch-approval --private <operator-key.pem> --board <reviewed-board.json> --runs ' + `${options.runsDir} --record <signed-batch-approval.json>`);
  console.log('node oss.mjs ship-batch --batch <reviewed-board.json> --approve <reviewed-batch-digest> --approval-record <signed-batch-approval.json>');
}

export function parseOssArgs(argv) {
  const requestedCommand = argv.shift();
  const aliases = {'prepare-batch': 'prepare', 'ship-batch': 'ship'};
  const command = aliases[requestedCommand] ?? requestedCommand;
  if (!['warm', 'prepare', 'decline', 'ship', 'status'].includes(command)) {
    throw new Error('usage: oss <warm|prepare|prepare-batch|decline|ship|ship-batch|status> ...');
  }
  const options = {...DEFAULTS, command, requestedCommand, ids: [], approve: null, approvalRecord: null,
    push: true, applyStatus: false, retryInfraTerminal: false, batch: null, board: null, warmOutput: null,
    warmManifest: null, phase1Runtime: null, minimumFreeBytes: 5 * 1024 * 1024 * 1024};
  while (argv.length) {
    const value = argv.shift();
    if (value === '--approve') options.approve = argv.shift();
    else if (value === '--approval-record') options.approvalRecord = path.resolve(argv.shift());
    else if (value === '--retry-infra-terminal') options.retryInfraTerminal = true;
    else if (value === '--concurrency') options.concurrency = Number(argv.shift());
    else if (value === '--batch' || value === '--batch-manifest') options.batch = path.resolve(argv.shift());
    else if (value === '--board') options.board = path.resolve(argv.shift());
    else if (value === '--warm-output') options.warmOutput = path.resolve(argv.shift());
    else if (value === '--warm-manifest') options.warmManifest = path.resolve(argv.shift());
    else if (value === '--phase1-runtime') options.phase1Runtime = path.resolve(argv.shift());
    else if (value === '--minimum-free-gb') options.minimumFreeBytes = Number(argv.shift()) * 1024 * 1024 * 1024;
    else if (value === '--specs') options.specsDir = path.resolve(argv.shift());
    else if (value === '--runs') options.runsDir = path.resolve(argv.shift());
    else if (value === '--only') options.ids.push(argv.shift());
    else if (value === '--apply') options.applyStatus = true;
    else if (value === '--no-push') options.push = false;
    else if (value.startsWith('--')) throw new Error(`unknown argument ${value}`);
    else options.ids.push(value);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 12) throw new Error('--concurrency must be an integer from 1 to 12');
  if (!Number.isFinite(options.minimumFreeBytes) || options.minimumFreeBytes < 0) throw new Error('--minimum-free-gb must be non-negative');
  if (options.applyStatus && command !== 'status') throw new Error('--apply is valid only for status');
  if (command === 'status') {
    if (options.applyStatus && !options.push) throw new Error('status --apply cannot be combined with --no-push');
    if (!options.applyStatus) options.push = false;
  }
  if (command !== 'status' && !options.ids.length && !options.batch) throw new Error(`${requestedCommand} requires mission ids or --batch <manifest>`);
  if (command === 'ship' && !options.approve) throw new Error('ship requires --approve <batch-digest>');
  if (command === 'ship' && !options.approvalRecord) throw new Error('ship requires --approval-record <signed-batch-approval.json>');
  return options;
}

async function loadSpecs(options) {
  const embedded = [];
  const ids = [...options.ids];
  if (options.batch) {
    const batch = JSON.parse(await readFile(options.batch, 'utf8'));
    if (Array.isArray(batch.specs)) embedded.push(...batch.specs);
    const batchIds = batch.ordered_mission_ids ?? (Array.isArray(batch.missions)
      ? batch.missions.map((mission) => typeof mission === 'string' ? mission : mission.mission_id) : []);
    ids.push(...batchIds);
  }
  const specs = [];
  const seen = new Set();
  for (const spec of embedded) {
    if (!spec?.mission_id || seen.has(spec.mission_id)) continue;
    seen.add(spec.mission_id);
    specs.push(spec);
  }
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  for (const id of uniqueIds) {
    if (seen.has(id)) continue;
    const spec = JSON.parse(await readFile(path.join(options.specsDir, `${id}.json`), 'utf8'));
    seen.add(id);
    specs.push(spec);
  }
  if (specs.length < 1 || specs.length > 50) throw new Error('a local batch must contain one to fifty missions');
  return validateSpecs(specs);
}

async function main() {
  const options = parseOssArgs(process.argv.slice(2));
  if (options.command === 'status') {
    const {syncStatus} = await import('./ship.mjs');
    const result = await syncStatus({apply: options.applyStatus, push: options.push});
    const status = result.applied ? 'updated' : result.changed ? 'changes detected' : 'current';
    console.log(`status: ${status} (${result.missions} contribution records)`);
    for (const mission of result.attention) console.log(`ATTENTION ${mission}: open PR needs a human response or has head drift`);
    return;
  }
  if (options.command === 'prepare' || options.command === 'ship') {
    await assertGhRateSafetyAllowsAction();
  }
  const specs = await loadSpecs(options);
  if (options.warmManifest) options.warmCache = JSON.parse(await readFile(options.warmManifest, 'utf8'));
  if (options.command === 'warm') {
    const warmed = await warmBatch(specs, {minimumFreeBytes: options.minimumFreeBytes});
    const output = options.warmOutput ?? path.join(options.runsDir, 'batch-warm-cache.json');
    await mkdir(path.dirname(output), {recursive: true, mode: 0o700});
    await writeFile(output, `${JSON.stringify(warmed, null, 2)}\n`, {mode: 0o600});
    console.log(`WARM READY: ${warmed.images.length} images, ${warmed.repositories.length} mirrors, ${warmed.disk.free_bytes} free bytes`);
    console.log(`warm_manifest: ${output}`);
    return;
  }
  if (options.command === 'decline') {
    for (const spec of specs) {
      const dirs = missionDirs(options.runsDir, spec.mission_id);
      const attempt = await readAttempt(dirs);
      if (attempt?.state !== 'READY') throw new Error(`${spec.mission_id} is not READY and cannot be declined`);
      attempt.state = 'DECLINED';
      attempt.updated_at = new Date().toISOString();
      attempt.terminal_reason = 'founder declined the prepared mission';
      if (attempt.schema_version === 2) attempt.terminal_reason_class = 'human_decline';
      await writeFile(path.join(dirs.base, 'attempt.json'), `${JSON.stringify(attempt, null, 2)}\n`);
      console.log(`DECLINED ${spec.mission_id}`);
    }
    return;
  }
  if (options.command === 'prepare') {
    const results = await pool(specs, options.concurrency, (spec) => prepareMission(spec, options));
    await printBoard(results, options);
    if (results.some((result) => result.state.startsWith('FAILED'))) process.exitCode = 1;
    return;
  }
  const {shipBatch} = await import('./ship.mjs');
  const {loadReviewerRoster} = await import('./campaign/phase0/roster.mjs');
  const [signedBatchApproval, roster] = await Promise.all([
    readFile(options.approvalRecord, 'utf8').then(JSON.parse),
    loadReviewerRoster(),
  ]);
  const result = await shipBatch(specs.map((spec) => ({spec, missionDir: path.join(options.runsDir, spec.mission_id)})), {
    approvedDigest: options.approve,
    signedBatchApproval,
    reviewerRoster: roster,
    retryInfraTerminal: options.retryInfraTerminal,
    concurrency: options.concurrency,
    log: async (id, message) => console.log(`  ${id}  ${message}`),
  });
  for (const item of result) {
    if (item.state === 'SHIPPED') console.log(`DONE ${item.mission_id}: ${item.pr_url} (${item.attestation_uri})`);
    else console.log(`${item.state} ${item.mission_id}: ${item.terminal_reason ?? 'terminal result'}`);
  }
  if (result.some((item) => item.state !== 'SHIPPED')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === OSS_FILE) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
