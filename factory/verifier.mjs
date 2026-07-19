import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {canonical, sha256} from './db.mjs';

export const CLAIM_TYPES = Object.freeze([
  'regression_fix',
  'existing_check_repair',
  'coverage_addition',
  'test_infrastructure_fix',
]);

function commandResult(result) {
  return {
    exit_code: Number(result.code ?? result.exit_code),
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
  for (const name of MANIFEST_PATTERNS[profile]) {
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
    node: [{source: volume, target: path.join(checkout, 'node_modules')}],
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

export async function bootstrapDependencies(input, {runContainer}) {
  if (typeof runContainer !== 'function') throw new Error('dependency bootstrap requires a container runner');
  const key = input.cacheKey ?? await dependencyCacheKey(input);
  const plan = dependencyVolumePlan({...input, cacheKey: key});
  const result = await runContainer(plan.bootstrap);
  if (Number(result.code ?? result.exit_code) !== 0) {
    throw new Error(`dependency bootstrap failed: ${String(result.stderr ?? result.stdout ?? '').trim()}`);
  }
  return {cache_key: key, volume: plan.volume, mounts: plan.runtime_mounts};
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

export async function verifyContribution(input, {
  runContainer,
  inspectTree = inspectGitWorktree,
  verifyBinding = assertPatchCommitBinding,
  now = () => new Date(),
} = {}) {
  if (typeof runContainer !== 'function') throw new Error('verification requires a container runner');
  if (!CLAIM_TYPES.includes(input.claimType)) throw new Error(`unsupported contribution claim ${input.claimType}`);
  const mounts = (input.dependencyMaterial?.mounts ?? []).map((mount) => ({...mount, readOnly: true}));
  if (mounts.some((mount) => mount.readOnly !== true)) throw new Error('verification dependency material must be read-only');
  const before = await inspectTree(input.patchedCheckout);
  if (before.status) throw new Error('patched verifier checkout is not clean before verification');
  const baseResult = await runContainer({
    phase: 'base_observation',
    checkout: input.baseCheckout,
    command: input.baseCommand ?? input.testCommand,
    network: false,
    mounts,
    claimType: input.claimType,
  });
  const patchedResult = await runContainer({
    phase: 'patched_observation',
    checkout: input.patchedCheckout,
    command: input.testCommand,
    network: false,
    mounts,
    claimType: input.claimType,
  });
  const baseObservation = commandResult(baseResult);
  const patchedObservation = commandResult(patchedResult);
  assertClaimObservations(input.claimType, baseObservation, patchedObservation);
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
  const patchBytes = await readFile(input.patchFile);
  return {
    ok: true,
    claim_type: input.claimType,
    verified_at: now().toISOString(),
    base_observation: baseObservation,
    patched_observation: patchedObservation,
    patch_sha256: sha256(patchBytes),
    tested_tree_oid: testedTreeOid,
    commit_oid: input.commitOid,
    dependency_cache_key: input.dependencyMaterial?.cache_key ?? null,
    environment: input.environment ?? {},
  };
}

export function buildProof({task, verification, approvalDigest = null, manifest}) {
  if (!verification?.ok) throw new Error('proof requires successful verification');
  const proof = {
    schema_version: 1,
    task_id: task.task_id,
    candidate: task.candidate,
    repository: task.repository,
    issue_number: task.issue_number,
    base_oid: manifest.base_oid,
    patch_sha256: verification.patch_sha256,
    tested_tree_oid: verification.tested_tree_oid,
    commit_oid: verification.commit_oid,
    checks: manifest.checks,
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
      const suffix = mount.readOnly ? ':ro' : '';
      args.push('--mount', `type=volume,src=${mount.source},dst=${mount.target}${suffix}`);
    }
    if (plan.checkout) args.push('--mount', `type=bind,src=${plan.checkout},dst=/workspace`, '--workdir', '/workspace');
    args.push(image, 'sh', '-lc', Array.isArray(plan.command) ? plan.command.join(' && ') : String(plan.command ?? 'true'));
    return execute(docker, args);
  };
}
