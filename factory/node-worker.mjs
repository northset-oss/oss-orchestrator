#!/usr/bin/env node

import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  CLAIM_TYPES,
  OSS_COMMIT_IDENTITY,
  dependencyCacheKey,
  verifyContribution,
} from './verifier.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const DEFAULT_AUTHOR_IMAGE = process.env.OSS_AUTHOR_IMAGE ?? 'northset-oss-author:0.144.1';
const DEFAULT_MODEL = process.env.OSS_FACTORY_AUTHOR_MODEL ?? 'gpt-5.6-sol';
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const AUTHOR_TIMEOUT_MS = 10 * 60_000;
const SCOUT_TIMEOUT_MS = 90_000;
const VERIFY_TIMEOUT_MS = 10 * 60_000;

export const SCOUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'reason', 'test_command', 'target_files', 'estimated_risk'],
  properties: {
    decision: {type: 'string', enum: ['GO', 'SKIP']},
    reason: {type: 'string'},
    test_command: {type: 'string'},
    install_command: {type: 'string'},
    target_files: {type: 'array', items: {type: 'string'}},
    estimated_risk: {type: 'string', enum: ['GREEN', 'AMBER', 'RED']},
  },
});

export const AUTHOR_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'outcome', 'reason', 'pr_title', 'pr_body', 'summary', 'claim_type',
    'test_command', 'test_only_paths', 'base_failure_contains', 'checks',
  ],
  properties: {
    outcome: {type: 'string', enum: ['PATCH', 'SKIP']},
    reason: {type: 'string'},
    pr_title: {type: 'string'},
    pr_body: {type: 'string'},
    summary: {type: 'string'},
    claim_type: {type: 'string', enum: [...CLAIM_TYPES]},
    test_command: {type: 'string'},
    test_only_paths: {type: 'array', items: {type: 'string'}},
    base_failure_contains: {type: 'string'},
    checks: {type: 'array', items: {type: 'string'}},
  },
});

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function terminate(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

/** A bounded subprocess primitive. It never uses a shell and never forwards stdin or output. */
export function runBounded(command, args, {
  cwd,
  env = process.env,
  input = null,
  timeoutMs = 60_000,
  maxOutputBytes = OUTPUT_LIMIT,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let terminalError = null;
    const abort = (error) => {
      if (terminalError) return;
      terminalError = error;
      terminate(child, 'SIGTERM');
      setTimeout(() => terminate(child, 'SIGKILL'), 2_000).unref();
    };
    const timer = setTimeout(() => abort(new Error(`command timed out after ${timeoutMs}ms`)), timeoutMs);
    const collect = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) abort(new Error(`command exceeded ${maxOutputBytes} output bytes`));
      else target.push(chunk);
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (terminalError) {
        terminalError.code = /timed out/.test(terminalError.message) ? 'ETIMEDOUT' : 'EOUTPUTLIMIT';
        reject(terminalError);
        return;
      }
      resolve({
        code: Number(code ?? 1),
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function mustRun(run, command, args, options = {}, label = command) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
  }
  return result;
}

function safeRelativePaths(paths, label) {
  return [...new Set((paths ?? []).map((item) => String(item)))].map((item) => {
    const normalized = path.posix.normalize(item.replaceAll('\\', '/'));
    if (!item || normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
      throw new Error(`${label} contains an unsafe path: ${item}`);
    }
    return normalized;
  });
}

async function isFile(file) {
  try { return (await stat(file)).isFile(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function resolveNodeCommands(checkout, scout = {}) {
  if (!await isFile(path.join(checkout, 'package.json'))) {
    throw new Error('Node worker requires a root package.json');
  }
  let packageJson;
  try { packageJson = JSON.parse(await readFile(path.join(checkout, 'package.json'), 'utf8')); }
  catch (error) { throw new Error(`cannot parse package.json: ${error.message}`); }
  let installCommand = String(scout.install_command ?? '').trim();
  if (!installCommand) {
    if (await isFile(path.join(checkout, 'pnpm-lock.yaml'))) installCommand = 'corepack pnpm install --frozen-lockfile';
    else if (await isFile(path.join(checkout, 'yarn.lock'))) installCommand = 'corepack yarn install --frozen-lockfile';
    else if (await isFile(path.join(checkout, 'package-lock.json')) ||
      await isFile(path.join(checkout, 'npm-shrinkwrap.json'))) installCommand = 'npm ci --no-audit --no-fund';
    else installCommand = 'npm install --no-package-lock --no-audit --no-fund';
  }
  let testCommand = String(scout.test_command ?? '').trim();
  if (!testCommand) {
    if (typeof packageJson.scripts?.test === 'string') testCommand = 'npm test --';
    else testCommand = 'node --test';
  }
  return {installCommand, testCommand};
}

async function prepareCodexHome(root, sourceHome = process.env.CODEX_HOME ??
  path.join(process.env.HOME ?? '', '.codex')) {
  const authSource = path.join(sourceHome, 'auth.json');
  await access(authSource);
  const codexHome = path.join(root, 'codex-home');
  await mkdir(codexHome, {recursive: true, mode: 0o700});
  await copyFile(authSource, path.join(codexHome, 'auth.json'));
  await writeFile(path.join(codexHome, 'config.toml'), [
    'approval_policy = "never"',
    '[history]',
    'persistence = "none"',
    '[features]',
    'apps = false',
    'memories = false',
    'multi_agent = false',
    '',
  ].join('\n'), {mode: 0o600});
  return codexHome;
}

export function codexDockerArgs({
  checkout,
  codexHome,
  outputRoot,
  schemaFile,
  outputFile,
  image,
  model,
  effort,
  readOnly,
  dependencyMaterial = null,
}) {
  const workspaceSuffix = readOnly ? ',readonly' : '';
  const args = [
    'run', '--rm', '-i', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=512', '--memory=8g', '--cpus=4',
    '--mount', `type=bind,src=${checkout},dst=/workspace${workspaceSuffix}`,
    '--mount', `type=bind,src=${path.join(checkout, '.git')},dst=/workspace/.git,readonly`,
    '--mount', `type=bind,src=${codexHome},dst=/codex-home`,
    '--mount', `type=bind,src=${path.join(codexHome, 'auth.json')},dst=/codex-home/auth.json,readonly`,
    '--mount', `type=bind,src=${outputRoot},dst=/northset-output`,
    '--workdir', '/workspace', '--env', 'HOME=/tmp', '--env', 'CI=true',
    '--env', 'CODEX_HOME=/codex-home', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g',
  ];
  if (readOnly) args.push('--read-only');
  for (const mount of dependencyMaterial?.mounts ?? []) {
    if (mount.readOnly !== true) throw new Error('author dependency material must be read-only');
    args.push('--mount', `type=volume,src=${mount.source},dst=${mount.target},readonly`);
  }
  args.push('--entrypoint', 'codex', image,
    'exec', '--json', '--ephemeral', '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check', '--output-schema', `/northset-output/${path.basename(schemaFile)}`,
    '--output-last-message', `/northset-output/${path.basename(outputFile)}`,
    '--color', 'never', '--model', model,
    '-c', `model_reasoning_effort="${effort}"`, '-c', 'service_tier="fast"', '-C', '/workspace', '-');
  return args;
}

async function defaultCodexRunner({
  checkout,
  schema,
  prompt,
  image,
  model = DEFAULT_MODEL,
  effort,
  readOnly,
  timeoutMs,
  run = runBounded,
  codexHomeSource,
  dependencyMaterial = null,
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-factory-codex-'));
  try {
    const codexHome = await prepareCodexHome(root, codexHomeSource);
    const outputRoot = path.join(root, 'output');
    await mkdir(outputRoot, {mode: 0o700});
    const schemaFile = path.join(outputRoot, 'schema.json');
    const outputFile = path.join(outputRoot, 'result.json');
    await writeFile(schemaFile, JSON.stringify(schema), {mode: 0o600});
    const args = codexDockerArgs({
      checkout, codexHome, outputRoot, schemaFile, outputFile, image, model, effort, readOnly,
      dependencyMaterial,
    });
    await mustRun(run, 'docker', args, {
      input: prompt,
      timeoutMs,
      maxOutputBytes: OUTPUT_LIMIT,
    }, 'Codex container');
    const outputStat = await stat(outputFile);
    if (outputStat.size > 1024 * 1024) throw new Error('Codex structured result exceeded 1048576 bytes');
    const parsed = JSON.parse(await readFile(outputFile, 'utf8'));
    return parsed;
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

function issueText(task) {
  const issue = task.issue_snapshot ?? {};
  return [
    `Repository: ${task.repository}`,
    `Issue: ${task.candidate ?? `${task.repository}#${task.issue_number}`}`,
    `Title: ${issue.title ?? ''}`,
    `Body:\n${issue.body ?? issue.bodyText ?? ''}`,
  ].join('\n\n');
}

function scoutPrompt(task) {
  return `${issueText(task)}

Inspect this checkout read-only. Decide whether this is a small, testable Node contribution suitable
for the standard lane. Select one exact focused test command and likely target files. Do not change
files. SKIP if the issue is unclear, too broad, needs secrets/services, or is Red risk. Return only
the requested structured result. Do not call GitHub or any network service other than the model API.`;
}

function authorPrompt(task, scout, options) {
  const feedback = options.verifierFeedback
    ? `\nThe previous verifier failed exactly as follows. Correct that failure only:\n${options.verifierFeedback}\n`
    : '';
  return `${issueText(task)}

Scout decision: ${JSON.stringify(scout)}
${feedback}
Implement the smallest repository-native direct fix. Work only in this checkout. Do not commit;
the host creates the canonical DCO commit. Do not edit dependencies, lockfiles, CI, releases,
generated output, or pull-request templates. For regression_fix, add or identify a focused
test-only delta that fails on the clean base and report an exact non-empty output marker. For
coverage_addition, report the added test paths; those tests must pass on both base and patched code.
For existing_check_repair or test_infrastructure_fix, the declared existing check must fail on base.
Run the focused check after the fix. If an honest, bounded patch is not possible, return SKIP.
Write a factual PR title/body without claiming maintainer approval, production readiness, guaranteed
correctness, or that checks beyond the reported commands passed. Return only the output-schema JSON.
Never call GitHub.`;
}

function assertScout(result) {
  if (!result || !['GO', 'SKIP'].includes(result.decision)) throw new Error('scout returned an invalid decision');
  if (typeof result.reason !== 'string') throw new Error('scout omitted reason');
  if (result.decision === 'GO' && !String(result.test_command ?? '').trim()) throw new Error('scout omitted test command');
  result.target_files = safeRelativePaths(result.target_files ?? [], 'scout target_files');
  if (!['GREEN', 'AMBER', 'RED'].includes(result.estimated_risk)) throw new Error('scout returned invalid risk');
  return result;
}

function assertAuthor(result) {
  if (!result || !['PATCH', 'SKIP'].includes(result.outcome)) throw new Error('author returned an invalid outcome');
  if (result.outcome === 'SKIP') return result;
  for (const field of ['pr_title', 'pr_body', 'summary', 'test_command']) {
    if (!String(result[field] ?? '').trim()) throw new Error(`author omitted ${field}`);
  }
  if (!CLAIM_TYPES.includes(result.claim_type)) throw new Error(`author returned unsupported claim ${result.claim_type}`);
  result.test_only_paths = safeRelativePaths(result.test_only_paths ?? [], 'author test_only_paths');
  result.checks = (result.checks ?? []).map(String).filter((item) => item.trim());
  if (!result.checks.length) result.checks = [result.test_command];
  if (result.claim_type === 'regression_fix') {
    if (!result.test_only_paths.length) throw new Error('regression fix requires a test-only path');
    if (!String(result.base_failure_contains ?? '').trim()) {
      throw new Error('regression fix requires an exact base failure marker');
    }
  }
  if (result.claim_type === 'coverage_addition' && !result.test_only_paths.length) {
    throw new Error('coverage addition requires a test-only path');
  }
  if (['regression_fix', 'coverage_addition'].includes(result.claim_type) &&
    result.test_only_paths.some((file) => !/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(file))) {
    throw new Error(`${result.claim_type} test-only delta includes a non-test path`);
  }
  return result;
}

async function resolveImage(run, image) {
  const result = await mustRun(run, 'docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {
    timeoutMs: 30_000,
  }, 'author image inspection');
  const digest = result.stdout.trim();
  if (!/^sha256:[0-9a-f]{64}$/i.test(digest)) throw new Error(`author image did not resolve to an immutable digest: ${digest}`);
  return digest.toLowerCase();
}

export function bootstrapDockerArgs({checkout, volume, image, installCommand}) {
  return [
    'run', '--rm', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=512', '--memory=8g', '--cpus=4',
    '--mount', `type=bind,src=${checkout},dst=/workspace,readonly`,
    '--mount', `type=bind,src=${path.join(checkout, '.git')},dst=/workspace/.git,readonly`,
    '--mount', `type=volume,src=${volume},dst=/workspace/node_modules`,
    '--workdir', '/workspace', '--env', 'HOME=/tmp', '--env', 'CI=true',
    '--env', 'npm_config_cache=/tmp/npm', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=2g',
    image, 'sh', '-lc', `${installCommand} && touch /workspace/node_modules/.northset-ready`,
  ];
}

export function runtimeDockerArgs({checkout, volume, image, command}) {
  return [
    'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=512', '--memory=8g', '--cpus=4',
    '--mount', `type=bind,src=${checkout},dst=/workspace,readonly`,
    '--mount', `type=bind,src=${path.join(checkout, '.git')},dst=/workspace/.git,readonly`,
    '--mount', `type=volume,src=${volume},dst=/workspace/node_modules,readonly`,
    '--workdir', '/workspace', '--env', 'HOME=/tmp', '--env', 'CI=true',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=2g',
    image, 'sh', '-lc', command,
  ];
}

async function withVolumeLock(volume, operation, {
  waitMs = 250,
  timeoutMs = INSTALL_TIMEOUT_MS,
} = {}) {
  const lockRoot = path.join(os.tmpdir(), 'northset-factory-volume-locks');
  await mkdir(lockRoot, {recursive: true, mode: 0o700});
  const lock = path.join(lockRoot, `${volume}.lock`);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for dependency volume ${volume}`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  try { return await operation(); }
  finally { await rm(lock, {recursive: true, force: true}); }
}

async function createPatch(run, checkout, paths, destination) {
  const args = ['-C', checkout, 'diff', '--binary', '--full-index', 'HEAD', '--'];
  args.push(...paths);
  const result = await mustRun(run, 'git', args, {timeoutMs: 60_000}, 'test-only patch');
  await writeFile(destination, result.stdout, {mode: 0o600});
  return Buffer.byteLength(result.stdout);
}

function cleanGitEnv() {
  const allowed = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR'];
  const env = Object.fromEntries(allowed.filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]));
  return {
    ...env,
    HOME: os.tmpdir(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: OSS_COMMIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: OSS_COMMIT_IDENTITY.email,
    GIT_COMMITTER_NAME: OSS_COMMIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: OSS_COMMIT_IDENTITY.email,
  };
}

async function canonicalCommit(run, checkout, baseOid, title) {
  const head = (await mustRun(run, 'git', ['-C', checkout, 'rev-parse', 'HEAD'], {
    timeoutMs: 30_000,
  }, 'read author HEAD')).stdout.trim();
  if (head !== baseOid) throw new Error(`author checkout moved from approved base ${baseOid}`);
  await mustRun(run, 'git', ['-C', checkout, 'add', '-A'], {timeoutMs: 60_000}, 'stage author patch');
  const changed = await run('git', ['-C', checkout, 'diff', '--cached', '--quiet', baseOid, '--'], {timeoutMs: 30_000});
  if (changed.code === 0) return null;
  if (changed.code !== 1) throw new Error(`cannot inspect staged author patch: ${changed.stderr.trim()}`);
  await mustRun(run, 'git', [
    '-C', checkout, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-s', '-m', title,
  ], {env: cleanGitEnv(), timeoutMs: 2 * 60_000}, 'canonical DCO commit');
  const commitOid = (await mustRun(run, 'git', ['-C', checkout, 'rev-parse', 'HEAD'], {
    timeoutMs: 30_000,
  }, 'read canonical commit')).stdout.trim();
  const treeOid = (await mustRun(run, 'git', ['-C', checkout, 'rev-parse', 'HEAD^{tree}'], {
    timeoutMs: 30_000,
  }, 'read canonical tree')).stdout.trim();
  const parent = (await mustRun(run, 'git', ['-C', checkout, 'rev-parse', 'HEAD^'], {
    timeoutMs: 30_000,
  }, 'read canonical parent')).stdout.trim();
  if (parent !== baseOid) throw new Error('canonical commit is not a single commit on the approved base');
  return {commitOid, treeOid};
}

async function makeFullPatch(run, checkout, baseOid, commitOid, destination) {
  const result = await mustRun(run, 'git', [
    '-C', checkout, 'diff', '--binary', '--full-index', baseOid, commitOid,
  ], {timeoutMs: 60_000, maxOutputBytes: 64 * 1024 * 1024}, 'canonical patch');
  if (!result.stdout.trim()) throw new Error('author produced an empty patch');
  await writeFile(destination, result.stdout, {mode: 0o600});
  return sha256(Buffer.from(result.stdout));
}

async function detachedBase(run, checkout, baseOid) {
  const root = await mkdtemp(path.join(path.dirname(checkout), '.northset-base-'));
  const target = path.join(root, 'repo');
  try {
    await mustRun(run, 'git', ['clone', '--no-local', '--no-checkout', checkout, target], {
      timeoutMs: 2 * 60_000,
    }, 'base clone');
    await mustRun(run, 'git', ['-C', target, 'checkout', '--detach', baseOid], {
      timeoutMs: 60_000,
    }, 'base checkout');
    return {root, target};
  } catch (error) {
    await rm(root, {recursive: true, force: true});
    throw error;
  }
}

export function createNodeWorker({
  run = runBounded,
  codexRunner = (options) => defaultCodexRunner({...options, run}),
  verifier = verifyContribution,
  image = DEFAULT_AUTHOR_IMAGE,
  model = DEFAULT_MODEL,
  codexHomeSource,
} = {}) {
  async function scout(payload) {
    const result = await codexRunner({
      checkout: payload.checkout,
      schema: SCOUT_SCHEMA,
      prompt: scoutPrompt(payload.task),
      image,
      model,
      effort: payload.effort ?? 'medium',
      readOnly: true,
      timeoutMs: Math.min(Number(payload.timeoutMs ?? SCOUT_TIMEOUT_MS), SCOUT_TIMEOUT_MS),
      codexHomeSource,
    });
    return assertScout(result);
  }

  async function bootstrap(payload) {
    const commands = await resolveNodeCommands(payload.checkout, payload.scout);
    const imageDigest = await resolveImage(run, image);
    const cacheKey = await dependencyCacheKey({
      repositoryNodeId: payload.task.live_state?.repository?.id ??
        payload.task.live_state?.repository_node_id ?? null,
      repository: payload.task.repository,
      profile: 'node',
      executorImageDigest: imageDigest,
      architecture: process.arch,
      installCommands: [commands.installCommand],
      checkout: payload.checkout,
      trustDomain: 'authored',
    });
    const volume = `northset-deps-${cacheKey.slice(-32)}`;
    let reused = false;
    await withVolumeLock(volume, async () => {
      const marker = await run('docker', [
        'run', '--rm', '--network=none',
        '--mount', `type=volume,src=${volume},dst=/deps,readonly`,
        image, 'test', '-f', '/deps/.northset-ready',
      ], {timeoutMs: 30_000});
      reused = marker.code === 0;
      if (reused) return;
      await mustRun(run, 'docker', ['volume', 'create', volume], {timeoutMs: 30_000}, 'dependency volume creation');
      try {
        await mustRun(run, 'docker', bootstrapDockerArgs({
          checkout: payload.checkout,
          volume,
          image,
          installCommand: commands.installCommand,
        }), {timeoutMs: INSTALL_TIMEOUT_MS, maxOutputBytes: OUTPUT_LIMIT}, 'dependency bootstrap');
      } catch (error) {
        await run('docker', ['volume', 'rm', '-f', volume], {timeoutMs: 30_000});
        throw error;
      }
    });
    return {
      cache_key: cacheKey,
      image,
      image_digest: imageDigest,
      install_command: commands.installCommand,
      test_command: commands.testCommand,
      reused,
      mounts: [{source: volume, target: '/workspace/node_modules', readOnly: true}],
    };
  }

  async function author(payload) {
    const result = assertAuthor(await codexRunner({
      checkout: payload.checkout,
      schema: AUTHOR_SCHEMA,
      prompt: authorPrompt(payload.task, payload.scout, payload),
      image,
      model,
      effort: payload.effort ?? 'high',
      readOnly: false,
      timeoutMs: Math.min(Number(payload.timeoutMs ?? AUTHOR_TIMEOUT_MS), AUTHOR_TIMEOUT_MS),
      codexHomeSource,
      dependencyMaterial: payload.dependencyMaterial,
    }));
    if (result.outcome === 'SKIP') return result;
    const artifactRoot = await mkdtemp(path.join(path.dirname(payload.checkout), '.northset-author-'));
    try {
      const testOnlyPatch = path.join(artifactRoot, 'test-only.patch');
      if (result.test_only_paths.length) {
        const bytes = await createPatch(run, payload.checkout, result.test_only_paths, testOnlyPatch);
        if (bytes === 0) throw new Error('declared test-only paths produced an empty base delta');
      } else {
        await writeFile(testOnlyPatch, '', {mode: 0o600});
      }
      const canonical = await canonicalCommit(run, payload.checkout, payload.task.base_oid, result.pr_title);
      if (!canonical) throw new Error('author produced no change');
      const patchFile = path.join(artifactRoot, 'change.patch');
      const patchSha256 = await makeFullPatch(
        run, payload.checkout, payload.task.base_oid, canonical.commitOid, patchFile,
      );
      return {
        ...result,
        base_branch: payload.task.live_state?.repository?.defaultBranch ??
          payload.task.live_state?.default_branch ?? 'main',
        issue_url: `https://github.com/${payload.task.repository}/issues/${payload.task.issue_number}`,
        risk_tier: payload.scout.estimated_risk,
        commit_oid: canonical.commitOid,
        commit_tree_oid: canonical.treeOid,
        patch_file: patchFile,
        patch_sha256: patchSha256,
        test_only_patch_file: testOnlyPatch,
        artifact_root: artifactRoot,
      };
    } catch (error) {
      await rm(artifactRoot, {recursive: true, force: true});
      throw error;
    }
  }

  async function verify(payload) {
    if (!payload.authored?.commit_oid || !payload.authored?.patch_file) {
      throw new Error('verify requires the canonical authored commit and patch');
    }
    const claimType = payload.authored.claim_type;
    if (claimType === 'regression_fix' && !String(payload.authored.base_failure_contains ?? '').trim()) {
      throw new Error('regression fix requires an exact base failure marker');
    }
    const base = await detachedBase(run, payload.checkout, payload.task.base_oid);
    try {
      if (payload.authored.test_only_paths?.length) {
        await mustRun(run, 'git', ['-C', base.target, 'apply', '--binary', payload.authored.test_only_patch_file], {
          timeoutMs: 60_000,
        }, 'apply test-only base delta');
      }
      const dependency = payload.dependencyMaterial;
      if (!dependency?.mounts?.every((mount) => mount.readOnly === true)) {
        throw new Error('verifier dependency volume must be read-only');
      }
      const volume = dependency.mounts[0]?.source;
      if (!volume) throw new Error('verifier requires dependency material');
      const runContainer = async (plan) => run('docker', runtimeDockerArgs({
        checkout: plan.checkout,
        volume,
        image: dependency.image ?? image,
        command: plan.command,
      }), {timeoutMs: VERIFY_TIMEOUT_MS, maxOutputBytes: OUTPUT_LIMIT});
      return await verifier({
        claimType,
        baseCheckout: base.target,
        patchedCheckout: payload.checkout,
        baseCommand: payload.authored.test_command,
        testCommand: payload.authored.test_command,
        baseFailureContains: payload.authored.base_failure_contains,
        baseOid: payload.task.base_oid,
        commitOid: payload.authored.commit_oid,
        commitTreeOid: payload.authored.commit_tree_oid,
        patchFile: payload.authored.patch_file,
        dependencyMaterial: dependency,
        environment: {
          profile: 'node',
          image: dependency.image_digest ?? dependency.image ?? image,
          architecture: process.arch,
          network: 'none',
        },
      }, {runContainer});
    } finally {
      await rm(base.root, {recursive: true, force: true});
    }
  }

  async function reset(payload) {
    const baseOid = payload.task.base_oid;
    await mustRun(run, 'git', ['-C', payload.checkout, 'reset', '--hard', baseOid], {
      timeoutMs: 60_000,
    }, 'reset checkout');
    await mustRun(run, 'git', ['-C', payload.checkout, 'clean', '-fd'], {
      timeoutMs: 60_000,
    }, 'clean checkout');
    if (payload.authored?.artifact_root) {
      const root = path.resolve(payload.authored.artifact_root);
      const expectedParent = path.resolve(path.dirname(payload.checkout));
      if (path.dirname(root) === expectedParent && path.basename(root).startsWith('.northset-author-')) {
        await rm(root, {recursive: true, force: true});
      }
    }
    return {reset: true, base_oid: baseOid};
  }

  return {
    async handle(payload) {
      if (!payload || typeof payload !== 'object') throw new Error('worker input must be a JSON object');
      if (payload.action === 'checkout') {
        throw new Error('node-worker checkout is supplied by the factory checkout provider');
      }
      if (!payload.checkout || !path.isAbsolute(payload.checkout)) {
        throw new Error(`${payload.action ?? 'worker action'} requires an absolute checkout path`);
      }
      if (payload.action === 'scout') return scout(payload);
      if (payload.action === 'bootstrap') return bootstrap(payload);
      if (payload.action === 'author') return author(payload);
      if (payload.action === 'verify') return verify(payload);
      if (payload.action === 'reset') return reset(payload);
      throw new Error(`unsupported worker action ${payload.action}`);
    },
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) throw new Error('node-worker requires one JSON request on stdin');
  return JSON.parse(text);
}

export async function main() {
  try {
    const result = await createNodeWorker().handle(await readStdin());
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  process.exitCode = await main();
}
