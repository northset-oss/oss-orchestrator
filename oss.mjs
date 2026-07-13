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
  directoryDigest,
  git,
  manifestDigest,
  parseCandidate,
  pool,
  prBody,
  recheck,
  run,
  sha256,
  validateSpecs,
} from './core.mjs';

const OSS_FILE = fileURLToPath(import.meta.url);
const HERE = path.dirname(OSS_FILE);
const NORTHSET_OSS = process.env.NORTHSET_OSS_DIR ?? '/Users/aeziz-local/northset-oss';
const RUN_MISSION = path.join(NORTHSET_OSS, 'bin', 'run-mission.mjs');
const BUNDLE_CLI = path.join(NORTHSET_OSS, 'bin', 'bundle.mjs');
const CODEX_PACKAGE = '@openai/codex@0.144.1';
const READY_TTL_HOURS = 8;
const DEFAULTS = {
  specsDir: path.join(HERE, 'specs'),
  runsDir: path.join(HERE, 'runs'),
  concurrency: 2,
};

function changedPath(entry) { return typeof entry === 'string' ? entry : entry.path; }
function isTestPath(file) {
  return /(^|\/)(__tests__|test|tests|spec|specs)(\/|$)/i.test(file)
    || /(?:^|\.)(?:test|spec)\.[^/]+$/i.test(path.basename(file));
}

function classifyRisk(entry, base) {
  const file = changedPath(entry);
  const name = path.basename(file).toLowerCase();
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
    'submodule', 'binary', 'symlink', 'check-or-CI-config',
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
  const invalid = spec.oracle.test_paths.filter((testPath) => byPath.get(testPath) !== 'added-test');
  if (invalid.length) {
    throw new Error(`oracle.test_paths must be newly added tests in this patch: ${invalid.join(', ')}`);
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

function commonDockerArgs(spec, workspace, image, {network = 'bridge', home = '/tmp', workdir = '/workspace/repo', phase = 'run'} = {}) {
  const resource = limits(spec);
  return [
    'run', '--rm', '--name', containerName(spec, phase), '--user', '1000:1000', '--network', network,
    '--security-opt', 'no-new-privileges', '--cap-drop=ALL',
    '--cpus', String(resource.cpus), '--memory', resource.memory, '--pids-limit', String(resource.pids),
    '--mount', `type=bind,src=${workspace},dst=/workspace`, '--workdir', workdir,
    '--env', `HOME=${home}`, '--env', 'CI=true', image,
  ];
}

export function codexBootstrapDockerArgs(spec, workspace, image) {
  const commands = [
    'mkdir -p /workspace/home /workspace/codex',
    `npm install --no-audit --no-fund --loglevel=error --prefix /workspace/codex ${CODEX_PACKAGE}`,
  ];
  return [...commonDockerArgs(spec, workspace, image, {
    home: '/workspace/home', workdir: '/workspace', phase: 'codex-bootstrap',
  }), 'sh', '-c', shell(commands)];
}

export function dependencyBootstrapDockerArgs(spec, workspace, image) {
  const commands = [
    'mkdir -p /workspace/.northset/bootstrap-home',
    ...spec.executor.install_commands,
  ];
  return [...commonDockerArgs(spec, workspace, image, {
    home: '/workspace/.northset/bootstrap-home', phase: 'dependency-bootstrap',
  }), 'sh', '-c', shell(commands)];
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
    'Do not modify dependencies, lockfiles, CI, release files, generated dependency output, or version numbers. Do not commit; the host creates one canonical DCO commit.',
  ].join('\n\n');
}

export function authorDockerArgs(spec, workspace, image, codexHome, codexDirectory = '/trusted/codex') {
  const command = [
    'export PATH=/opt/northset-codex/node_modules/.bin:$PATH',
    `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --model gpt-5.6-sol -c model_reasoning_effort=${quote(authorEffort(spec))} -c service_tier=fast ${quote(authorPrompt(spec))}`,
  ];
  const args = commonDockerArgs(spec, workspace, image, {home: '/tmp', phase: 'author'});
  args.splice(args.length - 1, 0,
    '--mount', `type=bind,src=${codexDirectory},dst=/opt/northset-codex,readonly`,
    '--mount', `type=bind,src=${codexHome},dst=/codex-home`,
    '--mount', `type=bind,src=${path.join(codexHome, 'auth.json')},dst=/codex-home/auth.json,readonly`,
    '--env', 'CODEX_HOME=/codex-home');
  return [...args, 'sh', '-c', shell(command)];
}

export function checkDockerArgs(spec, workspace, image, command) {
  const args = commonDockerArgs(spec, workspace, image, {network: 'none', phase: 'oracle'});
  args.splice(args.length - 1, 0,
    '--env', 'COREPACK_HOME=/workspace/.northset/bootstrap-home/.cache/node/corepack',
    '--read-only', '--tmpfs', '/tmp:size=512m');
  return [...args, 'sh', '-c', shell([...(spec.oracle.setup_commands ?? []), command])];
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

async function must(label, result) {
  if (result.code !== 0) throw new Error(`${label} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`);
  return result;
}

async function resolveImage(spec, log) {
  await log(`pulling executor image ${spec.executor.image} before credentials enter the workspace…`);
  await must('docker pull', await run('docker', ['pull', spec.executor.image], {timeoutMs: limits(spec).wallMs}));
  const inspected = await must('docker image inspect', await run('docker', ['image', 'inspect', spec.executor.image, '--format', '{{json .RepoDigests}}']));
  let digests;
  try { digests = JSON.parse(inspected.stdout.trim()); } catch { throw new Error('docker returned invalid RepoDigests'); }
  const digest = digests?.find((value) => /@sha256:[0-9a-f]{64}$/i.test(value));
  if (!digest) throw new Error(`image ${spec.executor.image} has no immutable repository digest`);
  return digest;
}

export async function removeRunWorkspace(workspace, removeImpl = rm) {
  await removeImpl(workspace, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}

async function cloneBase(spec, workspace) {
  await removeRunWorkspace(workspace);
  await mkdir(workspace, {recursive: true, mode: 0o700});
  const repo = path.join(workspace, 'repo');
  await must('clone target', await run('git', ['clone', '--no-checkout', spec.target_repo, repo]));
  await must('checkout base', await git(repo, 'checkout', '--detach', spec.base_commit));
  await git(repo, 'config', 'user.name', OSS_IDENTITY.name);
  await git(repo, 'config', 'user.email', OSS_IDENTITY.email);
  return repo;
}

export async function runAuthorContainer(spec, dirs, {dryRun = false, log = async () => {}, image = spec.executor.image, runImpl = run} = {}) {
  const codexHome = dryRun ? '/tmp/northset-codex-home' : await prepareCodexHome(dirs.base);
  const codexWorkspace = dryRun ? '/runs/trusted-codex' : await mkdtemp(path.join(dirs.base, 'trusted-codex-'));
  const plan = {
    codexBootstrap: codexBootstrapDockerArgs(spec, codexWorkspace, image),
    bootstrap: dependencyBootstrapDockerArgs(spec, dirs.authorWorkspace, image),
    author: authorDockerArgs(spec, dirs.authorWorkspace, image, codexHome, path.join(codexWorkspace, 'codex')),
  };
  if (dryRun) return {planned: true, docker: plan.author, codex: ['codex', authorPrompt(spec)], ...plan};
  const names = ['codex-bootstrap', 'dependency-bootstrap', 'author'].map((phase) => containerName(spec, phase));
  for (const name of names) await runImpl('docker', ['rm', '-f', name]);
  await log('author phase: credential mounted only after bootstrap…');
  try {
    await log('trusted Codex bootstrap: isolated from the repository and credentials…');
    let codexBootstrap = await runImpl('docker', plan.codexBootstrap, {timeoutMs: limits(spec).wallMs});
    const bootstrapError = `${codexBootstrap.stderr ?? ''}\n${codexBootstrap.stdout ?? ''}`;
    if (codexBootstrap.code !== 0 && /invalid mount config[^\n]*bind source path does not exist/i.test(bootstrapError)) {
      await log('trusted Codex bootstrap: recreating transient missing bind source and retrying once…');
      await mkdir(codexWorkspace, {recursive: true, mode: 0o700});
      codexBootstrap = await runImpl('docker', plan.codexBootstrap, {timeoutMs: limits(spec).wallMs});
    }
    await must('Codex bootstrap', codexBootstrap);
    await log('dependency bootstrap: network on, no Codex executable or credential mounted…');
    await must('dependency bootstrap', await runImpl('docker', plan.bootstrap, {timeoutMs: limits(spec).wallMs}));
    await must('author container', await runImpl('docker', plan.author, {timeoutMs: limits(spec).wallMs * 2}));
  } finally {
    for (const name of names) await runImpl('docker', ['rm', '-f', name]);
    await rm(codexHome, {recursive: true, force: true});
    await rm(codexWorkspace, {recursive: true, force: true});
  }
  return {repoDir: path.join(dirs.authorWorkspace, 'repo'), image};
}

export async function changedEntries(repo, base, commit) {
  const [names, numstat, baseFiles] = await Promise.all([
    git(repo, 'diff', '--name-status', '-z', `${base}..${commit}`),
    git(repo, 'diff', '--numstat', '-z', `${base}..${commit}`),
    git(repo, 'ls-tree', '-r', '--name-only', base),
  ]);
  const statusParts = names.stdout.split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index < statusParts.length;) {
    const status = statusParts[index++];
    const file = status.startsWith('R') || status.startsWith('C') ? statusParts[index + 1] : statusParts[index];
    index += status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    entries.push({path: file, status});
  }
  for (const entry of entries) {
    const tree = await git(repo, 'ls-tree', commit, '--', entry.path);
    const match = /^(\d{6})\s/.exec(tree.stdout);
    // Deleted paths have no entry in the new tree. Their base mode still matters for
    // symlink/submodule risk classification, so fall back to the base tree.
    if (match) entry.mode = match[1];
    else {
      const previous = await git(repo, 'ls-tree', base, '--', entry.path);
      entry.mode = /^(\d{6})\s/.exec(previous.stdout)?.[1] ?? '000000';
    }
  }
  let lines = 0;
  for (const part of numstat.stdout.split('\0').filter(Boolean)) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(part);
    if (!match) continue;
    const entry = entries.find((item) => item.path === match[3]);
    if (entry && (match[1] === '-' || match[2] === '-')) entry.binary = true;
    if (match[1] !== '-') lines += Number(match[1]);
    if (match[2] !== '-') lines += Number(match[2]);
  }
  return {entries, lines, baseFiles: baseFiles.stdout.trim().split('\n').filter(Boolean)};
}

export function canonicalCommitArgs(spec) {
  return ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-s', '-m', spec.pr.title];
}

async function normalizeAuthorResult(spec, repo, ready) {
  const dirty = await git(repo, 'status', '--porcelain', '--untracked-files=all');
  if (!dirty.stdout.trim()) return {noChange: true};
  await must('git add', await git(repo, 'add', '-A'));
  const env = {...process.env,
    GIT_AUTHOR_NAME: OSS_IDENTITY.name, GIT_AUTHOR_EMAIL: OSS_IDENTITY.email,
    GIT_COMMITTER_NAME: OSS_IDENTITY.name, GIT_COMMITTER_EMAIL: OSS_IDENTITY.email};
  await must('canonical DCO commit', await run('git', ['-C', repo, ...canonicalCommitArgs(spec)], {env}));
  const commit = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
  const identity = await git(repo, 'show', '-s', '--format=%ae%n%ce%n%b', commit);
  const [authorEmail = '', committerEmail = '', ...body] = identity.stdout.split('\n');
  assertOssCommitIdentity({authorEmail, committerEmail, body: body.join('\n')});
  const patch = await must('canonical patch', await git(repo, 'diff', '--binary', '--full-index', '--no-ext-diff', `${spec.base_commit}..${commit}`));
  if (!patch.stdout.trim()) return {noChange: true};
  await mkdir(ready, {recursive: true, mode: 0o700});
  const patchFile = path.join(ready, 'fix.patch');
  await writeFile(patchFile, patch.stdout);
  const tree = await assertPatchCommitBinding(repo, spec.base_commit, commit, patchFile);
  const changed = await changedEntries(repo, spec.base_commit, commit);
  if (changed.entries.length > 5) throw new Error(`initial lane allows at most 5 changed files, got ${changed.entries.length}`);
  if (changed.lines > 300) throw new Error(`initial lane allows at most 300 changed lines, got ${changed.lines}`);
  const classes = classifyChangedFiles(changed.baseFiles, changed.entries);
  // Tier A is deliberately narrow. Existing-test and snapshot changes require human-led
  // Tier B preparation because they can weaken an oracle or rewrite expected output.
  const forbidden = classes.filter((item) => !['source', 'added-test'].includes(item.class));
  if (forbidden.length) throw new Error(`initial lane forbids changed class(es): ${forbidden.map((item) => `${item.class}:${item.path}`).join(', ')}`);
  assertOracleChangedPaths(spec, classes);
  return {
    noChange: false, commit, tree, patch: patch.stdout, patchFile,
    patchSha: sha256(Buffer.from(patch.stdout)), classes, changedFiles: changed.entries.map((item) => item.path), lines: changed.lines,
  };
}

async function copyNodeDependencies(fromRepo, toRepo) {
  for (const directory of ['node_modules', '.northset']) {
    await cp(path.join(fromRepo, directory), path.join(toRepo, directory), {recursive: true, verbatimSymlinks: true})
      .catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function runDifferentialOracle(spec, dirs, authorRepo, result, image, log) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${spec.mission_id}-oracle-`));
  try {
    const repo = path.join(root, 'repo');
    await must('oracle clone', await run('git', ['clone', '--local', '--no-hardlinks', authorRepo, repo]));
    await must('oracle base checkout', await git(repo, 'checkout', '--detach', spec.base_commit));
    await git(repo, 'reset', '--hard', spec.base_commit);
    await git(repo, 'clean', '-ffdx');
    const testPatch = await must('test-only patch', await git(authorRepo, 'diff', '--binary', '--full-index', '--no-ext-diff',
      `${spec.base_commit}..${result.commit}`, '--', ...spec.oracle.test_paths));
    if (!testPatch.stdout.trim()) throw new Error('oracle test_paths produced no test-only patch');
    const testPatchFile = path.join(root, 'test-only.patch');
    await writeFile(testPatchFile, testPatch.stdout);
    await must('apply test-only patch', await git(repo, 'apply', '--binary', testPatchFile));
    await copyNodeDependencies(authorRepo, repo);
    await log('differential oracle: running the test-only patch on the base tree (expected failure)…');
    const observed = await run('docker', checkDockerArgs(spec, root, image, spec.oracle.command), {timeoutMs: limits(spec).wallMs});
    if (!Number.isInteger(observed.code) || observed.code === 0) {
      if (observed.code === 0) throw new Error('differential oracle failed: the test-only patch passed on the base tree');
      throw new Error('differential oracle failed: the base regression run did not produce a trustworthy exit code');
    }
    const baseOutput = `${observed.stdout}\n${observed.stderr}`;
    if (observed.code !== spec.oracle.base_exit_code || !baseOutput.includes(spec.oracle.base_failure_contains)) {
      throw new Error('differential oracle failed: base exit or defect-specific failure marker did not match the approved oracle');
    }
    await log('differential oracle: running the same focused test on the patched tree (expected success)…');
    const patched = await run('docker', checkDockerArgs(spec, dirs.authorWorkspace, image, spec.oracle.command),
      {timeoutMs: limits(spec).wallMs});
    if (patched.code !== 0) {
      throw new Error(`differential oracle failed: the focused test exited ${patched.code ?? 'without an exit code'} on the patched tree`);
    }
    const record = {
      schema_version: 1,
      kind: spec.oracle.kind,
      setup_commands: spec.oracle.setup_commands ?? [],
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

function publicMissionInput(spec, repoDir, patchFile, issueSnapshotFile, image) {
  const {owner} = parseCandidate(spec.candidate);
  return {
    mission: {
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
      patch_commit: null,
      patch_diff_hash: null,
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
    },
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
}

async function runCanonicalVerifier(spec, dirs, authorRepo, result, image, snapshotFile, log) {
  const baseRepo = path.join(dirs.base, 'public-base');
  await rm(baseRepo, {recursive: true, force: true});
  await must('public base clone', await run('git', ['clone', '--local', '--no-hardlinks', authorRepo, baseRepo]));
  await must('public base checkout', await git(baseRepo, 'checkout', '--detach', spec.base_commit));
  await git(baseRepo, 'reset', '--hard', spec.base_commit);
  await git(baseRepo, 'clean', '-ffdx');
  const staging = path.join(dirs.base, 'prepared-missions');
  await rm(staging, {recursive: true, force: true});
  await mkdir(staging, {recursive: true});
  const input = publicMissionInput(spec, baseRepo, result.patchFile, snapshotFile, image);
  input.mission.patch_commit = result.commit;
  input.mission.patch_diff_hash = result.patchSha;
  const inputFile = path.join(dirs.base, 'public-mission-input.json');
  await writeFile(inputFile, `${JSON.stringify(input, null, 2)}\n`);
  await log('canonical verifier: building the final public-ready bundle during prepare…');
  const command = await run('node', [RUN_MISSION, inputFile, '--missions-dir', staging, '--require-success', '--json'],
    {timeoutMs: limits(spec).wallMs * Math.max(2, spec.executor.commands.length + 1)});
  let parsed;
  try { parsed = JSON.parse(command.stdout); } catch { parsed = null; }
  if (command.code !== 0 || !parsed?.ok) throw new Error(`canonical verifier failed: ${parsed?.message ?? (command.stderr || command.stdout).trim()}`);
  await must('public bundle verify', await run('node', [BUNDLE_CLI, 'verify', parsed.missionDir]));
  const destination = path.join(dirs.ready, 'public-mission');
  await rm(destination, {recursive: true, force: true});
  await cp(parsed.missionDir, destination, {recursive: true, verbatimSymlinks: true});
  return {missionDir: destination, bundleDigest: parsed.bundleDigest};
}

function missionDirs(runsDir, id) {
  const base = path.join(runsDir, id);
  return {base, authorWorkspace: path.join(base, 'author-workspace'), ready: path.join(base, 'ready-pack')};
}

async function prepareMission(spec, options) {
  const dirs = missionDirs(options.runsDir, spec.mission_id);
  await rm(dirs.ready, {recursive: true, force: true});
  await mkdir(dirs.base, {recursive: true, mode: 0o700});
  const log = async (message) => {
    await appendFile(path.join(dirs.base, 'prepare.log'), `[${new Date().toISOString()}] ${message}\n`, {mode: 0o600});
    console.log(`  ${spec.mission_id}  ${message}`);
  };
  try {
    const checked = await recheck(spec, log);
    if (!checked.clean) return {state: 'SKIP', spec, detail: checked.reasons.join('; ')};
    const image = await resolveImage(spec, log);
    const repo = await cloneBase(spec, dirs.authorWorkspace);
    await runAuthorContainer(spec, dirs, {image, log});
    const result = await normalizeAuthorResult(spec, repo, dirs.ready);
    if (result.noChange) return {state: 'NOCHANGE', spec, detail: 'author produced no change'};
    await log(`canonical commit ${result.commit.slice(0, 12)}; ${result.changedFiles.length} files / ${result.lines} changed lines`);
    const oracle = await runDifferentialOracle(spec, dirs, repo, result, image, log);

    const snapshotFile = path.join(dirs.ready, 'issue_snapshot.json');
    const policyFile = path.join(dirs.ready, 'policy_snapshot.json');
    const policySnapshot = spec.receipt?.repo_policy_snapshot ?? {};
    await Promise.all([
      writeFile(snapshotFile, `${JSON.stringify(checked.snapshot, null, 2)}\n`),
      writeFile(policyFile, `${JSON.stringify(policySnapshot, null, 2)}\n`),
    ]);
    const bundle = await runCanonicalVerifier(spec, dirs, repo, result, image, snapshotFile, log);
    const body = prBody(spec, {changedFiles: result.changedFiles, commitOid: result.commit});
    const titleFile = path.join(dirs.ready, 'pr_title.txt');
    const bodyFile = path.join(dirs.ready, 'pr_body.md');
    await Promise.all([writeFile(titleFile, `${spec.pr.title}\n`), writeFile(bodyFile, body)]);
    const preparedAt = new Date();
    const manifest = {
      schema_version: 1,
      mission_id: spec.mission_id,
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
      planned_actions: [
        'push-reviewed-commit', 'publish-reviewed-bundle', 'verify-attestation',
        'open-pr', 'publish-pr-envelope',
      ],
    };
    await writeFile(path.join(dirs.ready, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const digest = manifestDigest([manifest]);
    await log(`READY — base red observed, patched checks green, bundle ${bundle.bundleDigest}`);
    return {state: 'READY', spec, dirs, manifest, manifestDigest: digest, classes: result.classes};
  } catch (error) {
    return {state: 'FAILED', spec, detail: error.message};
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
    console.log(`  changed files: ${result.classes.map((item) => `${item.class}:${item.path}`).join(', ')}`);
    console.log(`  checks not run: ${(spec.receipt?.checks_not_run ?? []).join(', ') || '(see limitations)'}`);
    console.log(`  resolved image: ${result.manifest.executor_image_digest}`);
    console.log(`  public bundle: ${result.manifest.bundle_digest}`);
    console.log(`  diff: ${path.join(result.dirs.ready, 'fix.patch')}`);
    console.log(`  PR title: ${result.manifest.pr_title}`);
    console.log(`  PR body: ${path.join(result.dirs.ready, 'pr_body.md')}`);
  }
  if (!ready.length) return;
  const digest = manifestDigest(ready);
  const ids = ready.map((item) => item.mission_id).join(' ');
  console.log(`batch_manifest_digest: ${digest}`);
  console.log(`node oss.mjs ship --approve ${digest} ${ids}`);
}

function parseArgs(argv) {
  const command = argv.shift();
  if (!['prepare', 'ship', 'status'].includes(command)) throw new Error('usage: oss <prepare|ship|status> ...');
  const options = {...DEFAULTS, command, ids: [], approve: null, push: true};
  while (argv.length) {
    const value = argv.shift();
    if (value === '--approve') options.approve = argv.shift();
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
  if (options.command === 'prepare') {
    const results = await pool(specs, options.concurrency, (spec) => prepareMission(spec, options));
    printBoard(results);
    if (results.some((result) => result.state === 'FAILED')) process.exitCode = 1;
    return;
  }
  const {shipBatch} = await import('./ship.mjs');
  const result = await shipBatch(specs.map((spec) => ({spec, missionDir: path.join(options.runsDir, spec.mission_id)})), {
    approvedDigest: options.approve,
    log: async (id, message) => console.log(`  ${id}  ${message}`),
  });
  for (const item of result) console.log(`DONE ${item.mission_id}: ${item.pr_url} (${item.attestation_uri})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === OSS_FILE) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
