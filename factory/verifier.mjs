import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {canonical, sha256} from './db.mjs';

export const CLAIM_TYPES = Object.freeze([
  'regression_fix',
  'feature_implementation',
  'existing_check_repair',
  'coverage_addition',
  'test_infrastructure_fix',
]);
export const OSS_COMMIT_IDENTITY = Object.freeze({name: 'Aysajan Eziz', email: 'aeziz@northset.ai'});

function isoTime(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function commandValue(command) {
  return Array.isArray(command) ? command.map(String) : String(command ?? '');
}

function commandResult(result, {
  phase,
  command,
  expectedResult,
  startedAt,
  finishedAt,
}) {
  const exitCode = Number(result.code ?? result.exit_code);
  return {
    phase,
    command: commandValue(command),
    network: 'none',
    expected_result: expectedResult,
    result: exitCode === 0 ? 'PASS' : 'FAIL',
    expectation_met: expectedResult === 'success' ? exitCode === 0 : exitCode !== 0,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    exit_code: exitCode,
    stdout_sha256: sha256(Buffer.from(String(result.stdout ?? ''))),
    stderr_sha256: sha256(Buffer.from(String(result.stderr ?? ''))),
    output_sha256: sha256(Buffer.from(`${result.stdout ?? ''}\0${result.stderr ?? ''}`, 'utf8')),
  };
}

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({code, stdout, stderr}));
  });
}

async function fileDigest(file) {
  try { return sha256(await readFile(file)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

const MANIFEST_PATTERNS = {
  node: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'],
  python: ['pyproject.toml', 'poetry.lock', 'uv.lock', 'requirements.txt', 'requirements-dev.txt', 'requirements-test.txt'],
  go: ['go.mod', 'go.sum'],
  rust: ['Cargo.toml', 'Cargo.lock'],
};

async function manifestNames(checkout, profile) {
  const names = [...MANIFEST_PATTERNS[profile]];
  if (profile === 'python') {
    const entries = await readdir(checkout, {withFileTypes: true});
    for (const entry of entries) {
      if (entry.isFile() && /^requirements.*\.txt$/i.test(entry.name)) names.push(entry.name);
    }
  }
  return [...new Set(names)].sort();
}

export async function dependencyCacheKey({
  repositoryNodeId,
  repository,
  profile,
  executorImageDigest,
  architecture,
  installCommands,
  checkout,
  trustDomain = 'authored',
}) {
  if (!repositoryNodeId && !repository) throw new Error('dependency key requires repository identity');
  if (!MANIFEST_PATTERNS[profile]) throw new Error(`unsupported dependency profile ${profile}`);
  if (!['authored', 'foreign'].includes(trustDomain)) throw new Error('dependency trust domain must be authored or foreign');
  const manifests = [];
  for (const name of await manifestNames(checkout, profile)) {
    const digest = await fileDigest(path.join(checkout, name));
    if (digest) manifests.push({path: name, sha256: digest});
  }
  const subject = {
    schema_version: 1,
    repository_node_id: repositoryNodeId ?? `legacy:${repository.toLowerCase()}`,
    profile,
    executor_image_digest: executorImageDigest,
    architecture,
    install_command_digest: sha256(Buffer.from(canonical(installCommands ?? []), 'utf8')),
    dependency_manifest_digest: sha256(Buffer.from(canonical(manifests), 'utf8')),
    trust_domain: trustDomain,
  };
  return sha256(Buffer.from(`northset-dependency-material-v1\0${canonical(subject)}`, 'utf8'));
}

export function dependencyVolumePlan({cacheKey, checkout, profile, installCommands = []}) {
  if (!/^sha256:[0-9a-f]{64}$/.test(String(cacheKey ?? ''))) throw new Error('dependency volume requires a cache key');
  const volume = `northset-deps-${cacheKey.slice(-32)}`;
  const targets = {
    node: [{source: volume, target: '/workspace/node_modules'}],
    python: [{source: volume, target: '/opt/northset/venv'}],
    go: [{source: volume, target: '/go/pkg/mod'}],
    rust: [{source: volume, target: '/usr/local/cargo/registry'}],
  }[profile];
  if (!targets) throw new Error(`unsupported dependency profile ${profile}`);
  return {
    cache_key: cacheKey,
    volume,
    bootstrap: {
      phase: 'dependency_bootstrap',
      commands: installCommands,
      network: true,
      mounts: targets.map((mount) => ({...mount, readOnly: false})),
    },
    runtime_mounts: targets.map((mount) => ({...mount, readOnly: true})),
  };
}

export async function bootstrapDependencies(input, {runContainer, volumeExists = async () => false}) {
  if (typeof runContainer !== 'function') throw new Error('dependency bootstrap requires a container runner');
  const key = input.cacheKey ?? await dependencyCacheKey(input);
  const plan = dependencyVolumePlan({...input, cacheKey: key});
  const reused = await volumeExists(plan.volume);
  if (!reused) {
    const result = await runContainer(plan.bootstrap);
    if (Number(result.code ?? result.exit_code) !== 0) {
      throw new Error(`dependency bootstrap failed: ${String(result.stderr ?? result.stdout ?? '').trim()}`);
    }
  }
  return {cache_key: key, volume: plan.volume, mounts: plan.runtime_mounts, reused};
}

export async function inspectGitWorktree(checkout) {
  const status = await execute('git', ['-C', checkout, 'status', '--porcelain=v1', '--untracked-files=all']);
  if (status.code !== 0) throw new Error(`cannot inspect verifier worktree: ${status.stderr.trim()}`);
  const tree = await execute('git', ['-C', checkout, 'rev-parse', 'HEAD^{tree}']);
  if (tree.code !== 0) throw new Error(`cannot inspect verifier tree: ${tree.stderr.trim()}`);
  return {tree_oid: tree.stdout.trim(), status: status.stdout};
}

export async function assertPatchCommitBinding({repoDir, baseOid, commitOid, patchFile}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-patch-binding-'));
  const index = path.join(root, 'index');
  const env = {...process.env, GIT_INDEX_FILE: index, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'};
  try {
    let result = await execute('git', ['-C', repoDir, 'read-tree', baseOid], {env});
    if (result.code !== 0) throw new Error(`cannot read base tree: ${result.stderr.trim()}`);
    result = await execute('git', ['-C', repoDir, 'apply', '--cached', '--binary', patchFile], {env});
    if (result.code !== 0) throw new Error(`canonical patch does not apply to base: ${result.stderr.trim()}`);
    const actual = await execute('git', ['-C', repoDir, 'write-tree'], {env});
    const expected = await execute('git', ['-C', repoDir, 'rev-parse', `${commitOid}^{tree}`], {env});
    if (actual.code !== 0 || expected.code !== 0 || actual.stdout.trim() !== expected.stdout.trim()) {
      throw new Error(`patch/tree/commit binding mismatch: ${actual.stdout.trim() || '(none)'} != ${expected.stdout.trim() || '(none)'}`);
    }
    return expected.stdout.trim();
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

function assertClaimObservations(claimType, base, patched) {
  if (!CLAIM_TYPES.includes(claimType)) throw new Error(`unsupported contribution claim ${claimType}`);
  if (patched.exit_code !== 0) throw new Error('patched observation must pass');
  if (claimType === 'coverage_addition') {
    if (base.exit_code !== 0) throw new Error('coverage addition must pass on base and patched code');
    return;
  }
  if (base.exit_code === 0) throw new Error(`${claimType} requires a failing base observation`);
}

function classifyPath(file, status) {
  const normalized = file.toLowerCase();
  const name = path.basename(normalized);
  if (/^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(name)) return 'lockfile';
  if (/^(?:package\.json|pyproject\.toml|requirements.*\.txt|go\.mod|go\.sum|cargo\.toml|cargo\.lock)$/.test(name)) {
    return 'dependency';
  }
  if (normalized.startsWith('.github/') || /(?:^|\/)(?:ci|workflows?)(?:\/|$)/.test(normalized)) return 'ci';
  if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/.test(normalized)) {
    return status === 'A' ? 'new_test' : 'existing_test';
  }
  if (/(?:^|\/)(?:dist|build|generated|vendor)(?:\/|$)/.test(normalized)) return 'generated';
  return 'production';
}

export async function inspectChangedFiles(repoDir, baseOid, commitOid) {
  const names = await execute('git', [
    '-C', repoDir, 'diff', '--name-status', '-z', '--no-renames', baseOid, commitOid,
  ]);
  if (names.code !== 0) throw new Error(`cannot classify changed files: ${names.stderr.trim()}`);
  const parts = names.stdout.split('\0').filter(Boolean);
  const changed = [];
  for (let index = 0; index < parts.length; index += 2) {
    const status = parts[index];
    const file = parts[index + 1];
    if (!file) throw new Error('changed-file record is malformed');
    changed.push({path: file, status, class: classifyPath(file, status), lines: 0});
  }
  const numstat = await execute('git', ['-C', repoDir, 'diff', '--numstat', '--no-renames', baseOid, commitOid]);
  if (numstat.code !== 0) throw new Error(`cannot compute diffstat: ${numstat.stderr.trim()}`);
  const byPath = new Map(changed.map((item) => [item.path, item]));
  let total = 0;
  for (const line of numstat.stdout.split('\n').filter(Boolean)) {
    const [added, removed, ...fileParts] = line.split('\t');
    const file = fileParts.join('\t');
    const item = byPath.get(file);
    if (!item) continue;
    if (added === '-' || removed === '-') {
      item.class = 'generated';
      item.lines = 0;
    } else {
      item.lines = Number(added) + Number(removed);
      total += item.lines;
    }
  }
  return {files: changed, changed_lines: total};
}

export async function assertDcoIdentity(repoDir, commitOid, identity = OSS_COMMIT_IDENTITY) {
  const result = await execute('git', ['-C', repoDir, 'show', '-s', '--format=%an%x00%ae%x00%ce%x00%B', commitOid]);
  if (result.code !== 0) throw new Error(`cannot inspect commit identity: ${result.stderr.trim()}`);
  const [authorName, authorEmail, committerEmail, ...bodyParts] = result.stdout.split('\0');
  const body = bodyParts.join('\0');
  if (authorName !== identity.name || authorEmail !== identity.email || committerEmail !== identity.email) {
    throw new Error(`commit identity must be ${identity.name} <${identity.email}>`);
  }
  const signoff = `Signed-off-by: ${identity.name} <${identity.email}>`;
  if (!body.split('\n').some((line) => line.trim() === signoff)) {
    throw new Error(`commit is missing DCO sign-off ${signoff}`);
  }
  return true;
}

export async function verifyContribution(input, {
  runContainer,
  inspectTree = inspectGitWorktree,
  verifyBinding = assertPatchCommitBinding,
  verifyDco = assertDcoIdentity,
  inspectChanges = inspectChangedFiles,
  now = () => new Date(),
} = {}) {
  if (typeof runContainer !== 'function') throw new Error('verification requires a container runner');
  if (!CLAIM_TYPES.includes(input.claimType)) throw new Error(`unsupported contribution claim ${input.claimType}`);
  const mounts = (input.dependencyMaterial?.mounts ?? []).map((mount) => ({...mount, readOnly: true}));
  if (mounts.some((mount) => mount.readOnly !== true)) throw new Error('verification dependency material must be read-only');
  const before = await inspectTree(input.patchedCheckout);
  if (before.status) throw new Error('patched verifier checkout is not clean before verification');
  const verificationStartedAt = isoTime(now(), 'verification start');
  const baseStartedAt = isoTime(now(), 'base observation start');
  const baseCommand = input.baseCommand ?? input.testCommand;
  const baseResult = await runContainer({
    phase: 'base_observation',
    checkout: input.baseCheckout,
    command: baseCommand,
    network: false,
    mounts,
    claimType: input.claimType,
  });
  const baseFinishedAt = isoTime(now(), 'base observation finish');
  const patchedStartedAt = isoTime(now(), 'patched observation start');
  const patchedResult = await runContainer({
    phase: 'patched_observation',
    checkout: input.patchedCheckout,
    command: input.testCommand,
    network: false,
    mounts,
    claimType: input.claimType,
  });
  const patchedFinishedAt = isoTime(now(), 'patched observation finish');
  const baseObservation = commandResult(baseResult, {
    phase: 'base_observation',
    command: baseCommand,
    expectedResult: input.claimType === 'coverage_addition' ? 'success' : 'failure',
    startedAt: baseStartedAt,
    finishedAt: baseFinishedAt,
  });
  const patchedObservation = commandResult(patchedResult, {
    phase: 'patched_observation',
    command: input.testCommand,
    expectedResult: 'success',
    startedAt: patchedStartedAt,
    finishedAt: patchedFinishedAt,
  });
  assertClaimObservations(input.claimType, baseObservation, patchedObservation);
  if (['regression_fix', 'feature_implementation'].includes(input.claimType)) {
    if (typeof input.baseFailureContains !== 'string' || !input.baseFailureContains.trim()) {
      throw new Error(`${input.claimType} requires an exact base failure marker`);
    }
    const output = `${baseResult.stdout ?? ''}\n${baseResult.stderr ?? ''}`;
    if (!output.includes(input.baseFailureContains)) {
      throw new Error('base observation did not contain the declared failure marker');
    }
  }
  const after = await inspectTree(input.patchedCheckout);
  if (after.status || before.tree_oid !== after.tree_oid) {
    throw new Error('tracked source changed during final verification');
  }
  const testedTreeOid = await verifyBinding({
    repoDir: input.patchedCheckout,
    baseOid: input.baseOid,
    commitOid: input.commitOid,
    patchFile: input.patchFile,
  });
  if (testedTreeOid !== input.commitTreeOid && input.commitTreeOid !== undefined) {
    throw new Error('verified tree differs from the declared commit tree');
  }
  await verifyDco(input.patchedCheckout, input.commitOid, input.dcoIdentity ?? OSS_COMMIT_IDENTITY);
  const changes = await inspectChanges(input.patchedCheckout, input.baseOid, input.commitOid);
  const patchBytes = await readFile(input.patchFile);
  const verificationFinishedAt = isoTime(now(), 'verification finish');
  return {
    ok: true,
    claim_type: input.claimType,
    verification_started_at: verificationStartedAt,
    verification_finished_at: verificationFinishedAt,
    verified_at: verificationFinishedAt,
    executed_commands: [baseObservation, patchedObservation],
    base_observation: baseObservation,
    patched_observation: patchedObservation,
    patch_sha256: sha256(patchBytes),
    tested_tree_oid: testedTreeOid,
    commit_oid: input.commitOid,
    dependency_cache_key: input.dependencyMaterial?.cache_key ?? null,
    dco_verified: true,
    changed_files: changes.files,
    changed_lines: changes.changed_lines,
    environment: input.environment ?? {},
  };
}

function checkCommand(check) {
  if (typeof check === 'string') return check.trim();
  if (check && typeof check === 'object' && !Array.isArray(check)) {
    return typeof check.command === 'string' ? check.command.trim() : '';
  }
  return '';
}

function readableCheck(check) {
  const command = checkCommand(check);
  if (command) return command;
  if (typeof check === 'string') throw new Error('declared check must be nonblank');
  const rendered = canonical(check);
  if (typeof rendered !== 'string' || !rendered.trim()) {
    throw new Error('declared check must be representable as nonblank canonical JSON');
  }
  return rendered;
}

function proofChecksNotRun(manifest, verification) {
  const executed = new Set((verification.executed_commands ?? []).map((entry) =>
    canonical(commandValue(entry.command))));
  const explicit = Array.isArray(manifest.checks_not_run) ? manifest.checks_not_run : [];
  const inferred = (Array.isArray(manifest.checks) ? manifest.checks : [])
    .filter((check) => {
      const command = checkCommand(check);
      return !command || !executed.has(canonical(commandValue(command)));
    })
    .map((check) => ({check: readableCheck(check), reason: 'not executed by the clean verifier'}));
  const seen = new Set();
  return [...explicit, ...inferred].filter((entry) => {
    const key = canonical(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildProof({task, verification, approvalDigest = null, manifest}) {
  if (!verification?.ok) throw new Error('proof requires successful verification');
  if (!Array.isArray(verification.executed_commands) || verification.executed_commands.length !== 2) {
    throw new Error('proof requires structured base and patched command evidence');
  }
  const limitations = [
    ...(Array.isArray(verification.limitations) ? verification.limitations : []),
    ...(Array.isArray(manifest.limitations) ? manifest.limitations : []),
  ];
  const proof = {
    schema_version: 2,
    task_id: task.task_id,
    candidate: task.candidate,
    repository: task.repository,
    issue_number: task.issue_number,
    base_oid: manifest.base_oid,
    patch_sha256: verification.patch_sha256,
    tested_tree_oid: verification.tested_tree_oid,
    commit_oid: verification.commit_oid,
    checks: manifest.checks,
    executed_commands: verification.executed_commands,
    checks_not_run: proofChecksNotRun(manifest, verification),
    limitations,
    verification_started_at: verification.verification_started_at,
    verification_finished_at: verification.verification_finished_at,
    environment: verification.environment,
    base_observation: verification.base_observation,
    patched_observation: verification.patched_observation,
    claim: manifest.receipt_claim,
    batch_approval_digest: approvalDigest,
  };
  return {...proof, proof_sha256: sha256(Buffer.from(canonical(proof), 'utf8'))};
}

export function createDockerRunner({docker = 'docker', image}) {
  if (!image) throw new Error('Docker runner requires an image digest');
  return async function runContainer(plan) {
    const args = ['run', '--rm', '--cap-drop=ALL', '--security-opt=no-new-privileges'];
    if (plan.network === false) args.push('--network=none');
    for (const mount of plan.mounts ?? []) {
      const suffix = mount.readOnly ? ',readonly' : '';
      args.push('--mount', `type=volume,src=${mount.source},dst=${mount.target}${suffix}`);
    }
    if (plan.checkout) {
      const suffix = plan.checkoutReadOnly === false ? '' : ',readonly';
      args.push('--mount', `type=bind,src=${plan.checkout},dst=/workspace${suffix}`, '--workdir', '/workspace');
    }
    args.push(image, 'sh', '-lc', Array.isArray(plan.command) ? plan.command.join(' && ') : String(plan.command ?? 'true'));
    return execute(docker, args);
  };
}
