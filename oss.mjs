#!/usr/bin/env node

// Lean Northset OSS workflow:
//   prepare -> one canonical public bundle + one content-bound review board
//   ship    -> publish exactly those bytes after founder approval
//   status  -> reconcile factual PR outcomes into mutable publication envelopes

import {appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  OSS_IDENTITY,
  assertOssCommitIdentity,
  assertPatchCommitBinding,
  authorEffort,
  canonical,
  createDeadline,
  directoryDigest,
  git,
  manifestDigest,
  parseCandidate,
  pool,
  prBody,
  recheck,
  run,
  sanitizedGitEnv,
  sha256,
  validateSpecs,
} from './core.mjs';

const OSS_FILE = fileURLToPath(import.meta.url);
const HERE = path.dirname(OSS_FILE);
const NORTHSET_OSS = process.env.NORTHSET_OSS_DIR ?? '/Users/aeziz-local/northset-oss';
const RUN_MISSION = path.join(NORTHSET_OSS, 'bin', 'run-mission.mjs');
const BUNDLE_CLI = path.join(NORTHSET_OSS, 'bin', 'bundle.mjs');
const READY_TTL_HOURS = 8;
export const PREPARE_BUDGET_MS = 60 * 60 * 1000;
const AUTHOR_IMAGE = process.env.OSS_AUTHOR_IMAGE ?? 'northset-oss-author:0.144.1';
const DEPENDENCY_CACHE_ROOT = process.env.OSS_DEPENDENCY_CACHE_DIR ?? path.join(HERE, 'cache', 'dependencies');
const DEFAULTS = {
  specsDir: path.join(HERE, 'specs'),
  runsDir: path.join(HERE, 'runs'),
  concurrency: 2,
};

function missionGit(deadline, cwd, ...args) {
  return run('git', ['-C', cwd, ...args], {
    env: sanitizedGitEnv(), deadline, timeoutMs: 2 * 60 * 1000,
  });
}

function changedPath(entry) { return typeof entry === 'string' ? entry : entry.path; }
function isTestPath(file) {
  return /(^|\/)(__tests__|test|tests|spec|specs)(\/|$)/i.test(file)
    || /(?:^|\.)(?:test|spec)\.[^/]+$/i.test(path.basename(file));
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
  if (/^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|poetry\.lock|uv\.lock|go\.sum|gemfile\.lock|gradle\.lockfile)$/i.test(name)) return 'lockfile';
  if (/^(package\.json|pyproject\.toml|requirements[^/]*\.txt|cargo\.toml|go\.mod|gemfile|pom\.xml|build\.gradle(?:\.kts)?)$/i.test(name)) return 'dependency-manifest';
  if (/^(dockerfile|compose\.ya?ml)$/i.test(name) || /(^|\/)docker\//i.test(file)) return 'container-config';
  if (/^(?:\.github\/workflows\/|\.circleci\/|\.gitlab-ci\.yml$|azure-pipelines\.yml$)/i.test(file)) return 'check-or-CI-config';
  if (/(^|\/)(?:vite|webpack|rollup|babel|tsconfig|eslint|prettier|jest|vitest|playwright)(?:\.|\/)/i.test(file)) return 'build-config';
  if (/(^|\/)(?:dist|build|generated|vendor)\//i.test(file)) return 'generated-output';
  if (/(^|\/)(?:fixtures?|snapshots?|__snapshots__)\//i.test(file) || /\.snap$/i.test(file)) return 'snapshot-or-fixture';
  if (file === 'package.json' || /(^|\/)(?:ci|scripts?)\/(?:check|test|verify|lint)(?:\.|$)/i.test(file)) return 'check-or-CI-config';
  if (isTestPath(file)) return base.has(file) ? 'modified-existing-test' : 'added-test';
  return 'source';
}

export function classifyChangedFiles(baseFileList, changedFiles) {
  const base = new Set(baseFileList.map(changedPath));
  const hard = new Set([
    'dependency-manifest', 'lockfile', 'build-config', 'container-config', 'generated-output',
    'submodule', 'binary', 'symlink', 'check-or-CI-config', 'rename', 'copy', 'type-change',
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
  const commands = [
    'mkdir -p /workspace/.northset/bootstrap-home',
    ...spec.executor.install_commands,
  ];
  const args = commonDockerArgs(spec, workspace, image, {
    home: '/workspace/.northset/bootstrap-home', phase: 'dependency-bootstrap', protectGit: true,
  });
  if (cacheDir) args.splice(args.length - 1, 0,
    '--mount', `type=bind,src=${cacheDir},dst=/northset-cache`,
    '--env', 'npm_config_cache=/northset-cache/npm',
    '--env', 'PNPM_STORE_DIR=/northset-cache/pnpm',
    '--env', 'YARN_CACHE_FOLDER=/northset-cache/yarn');
  return [...args, 'sh', '-c', shell(commands)];
}

function authorPrompt(spec) {
  return [
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
    `Red/green requirement: first add the regression test at ${spec.oracle.test_paths.join(', ')} and confirm \`${spec.oracle.command}\` fails for the defect; then implement the smallest fix and make it pass.`,
    `Run every declared check before finishing: ${spec.executor.commands.join(' && ')}`,
    'Do not edit repository pull-request templates or process documentation; the host renders the final PR body after human review.',
    'Do not modify dependencies, lockfiles, CI, release files, generated dependency output, or version numbers. Do not commit; the host creates one canonical DCO commit.',
  ].join('\n\n');
}

export function authorDockerArgs(spec, workspace, image, codexHome) {
  const command = [
    `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --model gpt-5.6-sol -c model_reasoning_effort=${quote(authorEffort(spec))} -c service_tier=fast ${quote(authorPrompt(spec))}`,
  ];
  const args = commonDockerArgs(spec, workspace, image, {home: '/tmp', phase: 'author', protectGit: true});
  args.splice(args.length - 1, 0,
    '--mount', `type=bind,src=${codexHome},dst=/codex-home`,
    '--mount', `type=bind,src=${path.join(codexHome, 'auth.json')},dst=/codex-home/auth.json,readonly`,
    '--env', 'CODEX_HOME=/codex-home');
  return [...args, 'sh', '-c', shell(command)];
}

export function checkDockerArgs(spec, workspace, image, command) {
  const args = commonDockerArgs(spec, workspace, image, {
    network: 'none', phase: 'oracle', workspaceReadonly: true,
  });
  args.splice(args.length - 1, 0,
    '--env', 'COREPACK_HOME=/workspace/.northset/bootstrap-home/.cache/node/corepack',
    '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=512m');
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

export async function dependencyCacheKey(spec, repo, image) {
  const names = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];
  const lockfiles = [];
  for (const name of names) {
    try { lockfiles.push({name, sha256: sha256(await readFile(path.join(repo, name)))}); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return sha256(Buffer.from(canonical({image, install_commands: spec.executor.install_commands, lockfiles})))
    .slice('sha256:'.length);
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

export async function removeRunWorkspace(workspace, removeImpl = rm) {
  await removeImpl(workspace, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}

async function cloneBase(spec, workspace, deadline) {
  await removeRunWorkspace(workspace);
  await mkdir(workspace, {recursive: true, mode: 0o700});
  const repo = path.join(workspace, 'repo');
  await must('clone target', await run('git', ['clone', '--no-checkout', spec.target_repo, repo], {
    env: sanitizedGitEnv(), deadline, timeoutMs: 2 * 60 * 1000,
  }));
  await must('checkout base', await missionGit(deadline, repo, 'checkout', '--detach', spec.base_commit));
  await missionGit(deadline, repo, 'config', 'user.name', OSS_IDENTITY.name);
  await missionGit(deadline, repo, 'config', 'user.email', OSS_IDENTITY.email);
  return repo;
}

export async function runAuthorContainer(spec, dirs, {
  dryRun = false, log = async () => {}, image = spec.executor.image, authorImage = null,
  cacheDir = null, deadline = null, runImpl = run,
} = {}) {
  const codexHome = dryRun ? '/tmp/northset-codex-home' : await prepareCodexHome(dirs.base);
  const resolvedAuthorImage = authorImage ?? (dryRun ? AUTHOR_IMAGE : await resolveAuthorImage(runImpl, deadline));
  const plan = {
    bootstrap: dependencyBootstrapDockerArgs(spec, dirs.authorWorkspace, image, cacheDir),
    author: authorDockerArgs(spec, dirs.authorWorkspace, resolvedAuthorImage, codexHome),
  };
  if (dryRun) return {planned: true, docker: plan.author, codex: ['codex', authorPrompt(spec)], ...plan};
  const names = ['dependency-bootstrap', 'author'].map((phase) => containerName(spec, phase));
  for (const name of names) await runImpl('docker', ['rm', '-f', name]);
  await log('author phase: credential mounted only after bootstrap…');
  try {
    await log('dependency bootstrap: network on, no Codex executable or credential mounted…');
    let bootstrapRetryCount = 0;
    let bootstrap = await runDocker(runImpl, plan.bootstrap, {timeoutMs: limits(spec).wallMs, deadline});
    let bootstrapDurationMs = bootstrap.durationMs ?? 0;
    if (bootstrap.code !== 0 && !bootstrap.timedOut && (!deadline || deadline.remainingMs() > 0)) {
      await log('dependency bootstrap infrastructure failed; retrying once within the original deadline…');
      bootstrapRetryCount = 1;
      bootstrap = await runDocker(runImpl, plan.bootstrap, {timeoutMs: limits(spec).wallMs, deadline});
      bootstrapDurationMs += bootstrap.durationMs ?? 0;
    }
    await must('dependency bootstrap', bootstrap);
    const author = await runDocker(runImpl, plan.author, {timeoutMs: limits(spec).wallMs * 2, deadline});
    await must('author container', author);
    return {
      repoDir: path.join(dirs.authorWorkspace, 'repo'),
      image,
      authorImage: resolvedAuthorImage,
      usage: {
        bootstrap_duration_ms: bootstrapDurationMs,
        bootstrap_retry_count: bootstrapRetryCount,
        author_duration_ms: author.durationMs ?? null,
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
  const forbidden = classes.filter((item) => !['source', 'added-test', 'modified-existing-test'].includes(item.class));
  if (forbidden.length) throw new Error(`initial lane forbids changed class(es): ${forbidden.map((item) => `${item.class}:${item.path}`).join(', ')}`);
  const modifiedTests = classes.filter((item) => item.class === 'modified-existing-test');
  if (modifiedTests.length > 1) throw new Error(`initial lane allows at most one modified existing test, got ${modifiedTests.length}`);
  assertOracleChangedPaths(spec, classes);
  return {
    noChange: false, commit, tree, patch: patch.stdout, patchFile,
    patchSha: sha256(Buffer.from(patch.stdout)), classes, changedFiles: changed.entries.map((item) => item.path), lines: changed.lines,
  };
}

export async function copyNodeDependencies(fromRepo, toRepo) {
  for (const directory of ['node_modules', '.yarn']) {
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

export async function runDifferentialOracle(spec, dirs, authorRepo, result, image, log, deadline) {
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
    await copyNodeDependencies(authorRepo, repo);
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
    await log('differential oracle: running the same focused test on the patched tree (expected success)…');
    await assertExpectedTree(authorRepo, result.commit, deadline);
    const patched = await runDocker(run, checkDockerArgs(spec, dirs.authorWorkspace, image, spec.oracle.command),
      {timeoutMs: limits(spec).wallMs, deadline, outputLimitBytes: limits(spec).output});
    await assertExpectedTree(authorRepo, result.commit, deadline);
    if (patched.code !== 0) {
      throw new Error(`differential oracle failed: the focused test exited ${patched.code ?? 'without an exit code'} on the patched tree`);
    }
    const record = {
      schema_version: 1,
      kind: spec.oracle.kind,
      command: spec.oracle.command,
      base_expected: spec.oracle.base_expected,
      base_exit_expected: spec.oracle.base_exit_code,
      base_exit: observed.code,
      base_observed: true,
      base_failure_contains: spec.oracle.base_failure_contains,
      base_failure_observed: true,
      patched_expected: spec.oracle.patched_expected,
      patched_exit: patched.code,
      patched_observed: patched.code === 0,
      base_output_sha256: sha256(Buffer.from(baseOutput)),
      patched_output_sha256: sha256(Buffer.from(`${patched.stdout}\n${patched.stderr}`)),
    };
    const file = path.join(dirs.ready, 'oracle.json');
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
    return {record, file, sha: sha256(Buffer.from(canonical(record)))};
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

export function buildEconomicInput(spec, {
  missionSha256, issueSnapshotSha256, result, authorUsage, timings,
  totalDurationMs, attempts,
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
        issue_url: spec.issue_url,
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

function publicMissionInput(spec, repoDir, patchFile, issueSnapshotFile, image, result, economicContext = null) {
  const {owner} = parseCandidate(spec.candidate);
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
      issue_or_task: spec.issue_url,
      consent_artifact: null,
      repo_policy_snapshot: spec.receipt?.repo_policy_snapshot ?? null,
      worker_identity: {runtime: 'northset-oss executor v1', human_operator: 'aeziz'},
      base_commit: spec.base_commit,
      patch_commit: result.commit,
      patch_diff_hash: result.patchSha,
      commands_declared: spec.executor.commands,
      environment: null,
      run_record_bundle_digest: null,
      attestation_uri: null,
      maintainer_outcome: {status: 'pending', link: null, decided_at: null},
      payment: {maintainer_payment: 'none', merge_contingent: false},
      limitations: spec.receipt?.limitations ?? [
        'Does not prove code quality',
        'Does not prove security',
        "Contributor self-run record of Northset's own contribution; not the maintainer's verification.",
        `The declared network-off checks run after a disclosed online dependency install in ${image}.`,
      ],
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
      missionSha256: sha256(Buffer.from(`${JSON.stringify(mission, null, 2)}\n`)),
      issueSnapshotSha256: sha256(economicContext.issueSnapshotBytes),
    });
  }
  return input;
}

export async function runCanonicalVerifier(spec, dirs, authorRepo, result, image, snapshotFile, log, deadline, economicContext = null) {
  const baseRepo = path.join(dirs.base, 'public-base');
  await rm(baseRepo, {recursive: true, force: true});
  await must('public base clone', await run('git', ['clone', '--local', '--no-hardlinks', authorRepo, baseRepo], {
    env: sanitizedGitEnv(), deadline, timeoutMs: 2 * 60 * 1000,
  }));
  await must('public base checkout', await missionGit(deadline, baseRepo, 'checkout', '--detach', spec.base_commit));
  await missionGit(deadline, baseRepo, 'reset', '--hard', spec.base_commit);
  await missionGit(deadline, baseRepo, 'clean', '-ffdx');
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

const TERMINAL_ATTEMPT_STATES = new Set([
  'STALE', 'NOCHANGE', 'DECLINED', 'FAILED_BUDGET', 'FAILED_AUTHOR',
  'FAILED_ORACLE', 'FAILED_INFRA_TERMINAL',
]);
const TERMINAL_LINEAGE_JOURNAL_STATES = new Set([
  'SHIPPED', 'DECLINED', 'ABORTED_STALE', 'ABORTED_AFTER_PUBLICATION',
  'ABORTED_BUDGET', 'FAILED_INFRA_TERMINAL',
]);

async function writeAttempt(dirs, spec, state, detail, timings, startedAt) {
  await writeFile(path.join(dirs.base, 'attempt.json'), `${JSON.stringify({
    schema_version: spec.schema_version === 2 ? 2 : 1,
    ...(spec.schema_version === 2 ? {
      mission_id: spec.mission_id,
      task_id: spec.task_id,
      attempt_sequence: spec.attempt_sequence,
      work_category: spec.work_category,
      terminal_reason_class: terminalReasonClass(state),
    } : {}),
    state,
    started_at: startedAt.toISOString(),
    updated_at: new Date().toISOString(),
    terminal_reason: detail ?? null,
    timings,
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
      terminal_reason_class: terminalReasonClass(state) ?? record.terminal_reason_class ?? null,
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

async function prepareMission(spec, options) {
  const dirs = missionDirs(options.runsDir, spec.mission_id);
  const deadline = createDeadline(PREPARE_BUDGET_MS);
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
    return {state, spec, detail, timings: previous.timings ?? []};
  }
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
    const checked = await stage('prepare_recheck', () => recheck(spec, log, {mode: 'prepare', deadline}));
    if (!checked.clean) {
      const detail = checked.reasons.join('; ');
      await writeAttempt(dirs, spec, 'STALE', detail, timings, startedAt);
      return {state: 'STALE', spec, detail, timings};
    }
    const image = await stage('executor_image', () => resolveImage(spec, log, deadline));
    const repo = await stage('clone', () => cloneBase(spec, dirs.authorWorkspace, deadline));
    const cacheKey = await dependencyCacheKey(spec, repo, image);
    const cacheDir = path.join(DEPENDENCY_CACHE_ROOT, cacheKey);
    await mkdir(cacheDir, {recursive: true, mode: 0o700});
    const authorRun = await stage('author', () => runAuthorContainer(spec, dirs, {image, log, cacheDir, deadline}));
    const result = await stage('canonical_commit', () => normalizeAuthorResult(spec, repo, dirs.ready, deadline));
    if (result.noChange) {
      await writeAttempt(dirs, spec, 'NOCHANGE', 'author produced no change', timings, startedAt);
      return {state: 'NOCHANGE', spec, detail: 'author produced no change', timings};
    }
    await log(`canonical commit ${result.commit.slice(0, 12)}; ${result.changedFiles.length} files / ${result.lines} changed lines`);
    const oracle = await stage('differential_oracle', () => runDifferentialOracle(spec, dirs, repo, result, image, log, deadline));

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
      spec, dirs, repo, result, image, snapshotFile, log, deadline,
      spec.schema_version === 2 ? {
        issueSnapshotBytes,
        result,
        authorUsage: authorRun.usage,
        timings: [...timings],
        totalDurationMs: timings.reduce((total, timing) => total + timing.duration_ms, 0),
        attempts,
      } : null,
    ));
    const body = prBody(spec, {changedFiles: result.changedFiles, commitOid: result.commit});
    const titleFile = path.join(dirs.ready, 'pr_title.txt');
    const bodyFile = path.join(dirs.ready, 'pr_body.md');
    await Promise.all([writeFile(titleFile, `${spec.pr.title}\n`), writeFile(bodyFile, body)]);
    const preparedAt = new Date();
    const manifest = {
      schema_version: spec.schema_version === 2 ? 2 : 1,
      mission_id: spec.mission_id,
      ...(spec.schema_version === 2 ? {
        task_id: spec.task_id,
        attempt_sequence: spec.attempt_sequence,
        work_category: spec.work_category,
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
      pr_title: spec.pr.title,
      pr_body_sha256: sha256(Buffer.from(body)),
      executor_image_digest: image,
      author_image_digest: authorRun.authorImage,
      dependency_cache_key: cacheKey,
      timings,
      total_duration_ms: Date.now() - startedAt.getTime(),
      planned_actions: [
        'push-reviewed-commit',
        'publish-prepared-receipt-pr', 'wait-prepared-receipt-checks', 'merge-prepared-receipt-pr',
        'verify-attestation', 'confirm-canonical-receipt-http-200', 'recheck-collision',
        'open-approved-upstream-pr', 'sync-guarded-pr-disclosure', 'record-pr-disclosure',
        'rebuild-full-ledger', 'publish-final-envelope-pr', 'wait-final-envelope-checks',
        'merge-final-envelope-pr',
      ],
    };
    await writeFile(path.join(dirs.ready, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const digest = manifestDigest([manifest]);
    await log(`READY — base red observed, patched checks green, bundle ${bundle.bundleDigest}`);
    await writeAttempt(dirs, spec, 'READY', null, timings, startedAt);
    return {state: 'READY', spec, dirs, manifest, manifestDigest: digest, classes: result.classes};
  } catch (error) {
    const budget = deadline.expired() || /timed out|deadline exhausted/i.test(error.message);
    const state = budget ? 'FAILED_BUDGET'
      : activeStage === 'author' ? 'FAILED_AUTHOR'
        : ['differential_oracle', 'canonical_verifier'].includes(activeStage) ? 'FAILED_ORACLE'
          : 'FAILED_INFRA_TERMINAL';
    await writeAttempt(dirs, spec, state, error.message, timings, startedAt);
    return {state, spec, detail: error.message, timings};
  }
}

function printBoard(results) {
  console.log('\nOSS PREPARE — REVIEW BOARD');
  const ready = [];
  for (const result of results) {
    if (result.state !== 'READY') {
      console.log(`${result.state} ${result.spec.mission_id} ${result.spec.candidate}: ${result.detail}`);
      continue;
    }
    ready.push(result.manifest);
    const spec = result.spec;
    console.log(`READY ${spec.mission_id} ${spec.candidate}`);
    console.log(`  invitation: ${spec.qualification.invitation_evidence.type} ${spec.qualification.invitation_evidence.url}`);
    console.log(`  latest maintainer intent: ${spec.qualification.acceptance_contract.design_evidence.map((item) => item.url).join(', ')}`);
    console.log(`  repository process: ${spec.process_requirements.join(' | ') || 'no additional requirements'}`);
    console.log(`  pre-author notice: ${spec.qualification.pre_author_notice?.url ?? 'not required'}`);
    console.log(`  related PR/history: ${spec.qualification.related_prs.length ? spec.qualification.related_prs.map((item) => `${item.state} ${item.url}: ${item.disposition}`).join('; ') : 'clear'}`);
    console.log(`  acceptance criteria: ${spec.acceptance_criteria.join(' | ')}`);
    console.log('  BASE: expected failure observed');
    console.log(`  PATCH: focused test passed (${spec.oracle.command})`);
    console.log(`  PATCH: declared checks passed (${spec.executor.commands.join(' && ')})`);
    console.log(`  changed files: ${result.classes.map((item) => `${item.flagged ? 'RISK ' : ''}${item.class}:${item.path}`).join(', ')}`);
    console.log(`  checks not run: ${(spec.receipt?.checks_not_run ?? []).join(', ') || '(see limitations)'}`);
    console.log(`  resolved image: ${result.manifest.executor_image_digest}`);
    console.log(`  public bundle: ${result.manifest.bundle_digest}`);
    console.log(`  prepare time: ${(result.manifest.total_duration_ms / 1000).toFixed(1)}s`);
    console.log(`  diff: ${path.join(result.dirs.ready, 'fix.patch')}`);
    console.log(`  PR title: ${result.manifest.pr_title}`);
    console.log(`  PR body: ${path.join(result.dirs.ready, 'pr_body.md')}`);
  }
  if (!ready.length) return;
  const digest = manifestDigest(ready);
  const ids = ready.map((item) => item.mission_id).join(' ');
  console.log(`batch_manifest_digest: ${digest}`);
  console.log(`node oss.mjs ship --approve ${digest} --approved-by internal-user:aeziz ${ids}`);
}

function parseArgs(argv) {
  const command = argv.shift();
  if (!['prepare', 'decline', 'ship', 'status'].includes(command)) throw new Error('usage: oss <prepare|decline|ship|status> ...');
  const options = {...DEFAULTS, command, ids: [], approve: null, approvedBy: null, push: true, retryInfraTerminal: false};
  while (argv.length) {
    const value = argv.shift();
    if (value === '--approve') options.approve = argv.shift();
    else if (value === '--approved-by') options.approvedBy = argv.shift();
    else if (value === '--retry-infra-terminal') options.retryInfraTerminal = true;
    else if (value === '--concurrency') options.concurrency = Number(argv.shift());
    else if (value === '--specs') options.specsDir = path.resolve(argv.shift());
    else if (value === '--runs') options.runsDir = path.resolve(argv.shift());
    else if (value === '--only') options.ids.push(argv.shift());
    else if (value === '--no-push') options.push = false;
    else if (value.startsWith('--')) throw new Error(`unknown argument ${value}`);
    else options.ids.push(value);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('--concurrency must be positive');
  if (command !== 'status' && !options.ids.length) throw new Error(`${command} requires one or more mission ids`);
  if (command === 'ship' && !options.approve) throw new Error('ship requires --approve <batch-digest>');
  return options;
}

async function loadSpecs(options) {
  const specs = [];
  for (const id of options.ids) specs.push(JSON.parse(await readFile(path.join(options.specsDir, `${id}.json`), 'utf8')));
  return validateSpecs(specs);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'status') {
    const {syncStatus} = await import('./ship.mjs');
    const result = await syncStatus({push: options.push});
    console.log(`status: ${result.changed ? 'updated' : 'current'} (${result.missions} contribution records)`);
    for (const mission of result.attention) console.log(`ATTENTION ${mission}: open PR needs a human response or has head drift`);
    return;
  }
  const specs = await loadSpecs(options);
  if (options.command === 'ship' && specs.some((spec) => spec.schema_version === 2) && !options.approvedBy) {
    throw new Error('schema-v2 ship requires --approved-by <stable-operator-id>');
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
    printBoard(results);
    if (results.some((result) => result.state.startsWith('FAILED'))) process.exitCode = 1;
    return;
  }
  const {shipBatch} = await import('./ship.mjs');
  const result = await shipBatch(specs.map((spec) => ({spec, missionDir: path.join(options.runsDir, spec.mission_id)})), {
    approvedDigest: options.approve,
    approvedBy: options.approvedBy,
    retryInfraTerminal: options.retryInfraTerminal,
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
