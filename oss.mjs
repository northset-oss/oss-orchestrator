#!/usr/bin/env node
// OSS orchestrator v2 — increment 1. `prepare` plans/runs the author + verifier boundary and stops
// at one content-bound review board. `ship` deliberately remains an increment-2 stub.

import {createHash} from 'node:crypto';
import {appendFile, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  OSS_IDENTITY, assertOssCommitIdentity, parseCandidate, pool, prBody, recheck, validateSpecs,
} from './runner.mjs';

const OSS_FILE = fileURLToPath(import.meta.url);
const HERE = path.dirname(OSS_FILE);
const UNRESOLVED_DIGEST = `sha256:${'0'.repeat(64)}`;
const VERIFIER_VERSION = 'oss-prepare-v1';
const DEFAULTS = {
  specsDir: path.join(HERE, 'specs'),
  runsDir: path.join(HERE, 'runs'),
  concurrency: 4,
  only: null,
  dryRun: false,
};

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function changedPath(entry) {
  return typeof entry === 'string' ? entry : entry.path;
}

function isTestPath(file) {
  return /(^|\/)(__tests__|test|tests|spec|specs)(\/|$)/i.test(file)
    || /(?:^|\.)+(?:test|spec)\.[^/]+$/i.test(path.basename(file));
}

function isCheckOrCi(entry) {
  const file = changedPath(entry);
  if (file === 'package.json') return true; // Any script mutation is security-relevant; conservative by design.
  if (/^(?:\.github\/workflows\/|\.circleci\/|\.gitlab-ci\.yml$|azure-pipelines\.yml$)/i.test(file)) return true;
  if (/(^|\/)(?:ci|scripts?)\/(?:check|test|verify|lint)(?:\.|$)/i.test(file)) return true;
  return Boolean(typeof entry === 'object' && (entry.check_script || entry.checkScript));
}

// Pure classification. `changed_files` accepts paths or records with {path}; the latter leaves room
// for callers to carry status/content without allowing author-controlled content to affect the class.
export function classifyChangedFiles(base_file_list, changed_files) {
  const base = new Set(base_file_list.map(changedPath));
  return changed_files.map((entry) => {
    const file = changedPath(entry);
    if (typeof file !== 'string' || !file) throw new Error('changed file must have a non-empty path');
    let fileClass = 'source';
    if (isCheckOrCi(entry)) fileClass = 'check-or-CI-config';
    else if (isTestPath(file)) fileClass = base.has(file) ? 'modified-existing-test' : 'added-test';
    return {path: file, class: fileClass, flagged: ['modified-existing-test', 'check-or-CI-config'].includes(fileClass)};
  }).sort((a, b) => a.path.localeCompare(b.path));
}

// The original verifier bytes are hashed but never embedded. The caller persists its redacted
// rendering separately, preventing redaction from changing the canonical receipt subject.
export function buildReceipt(input) {
  const required = [
    'candidate', 'repo', 'base_commit', 'patch_sha256', 'tested_tree_oid', 'commit_oid',
    'check_command', 'verifier_image_digest', 'dep_material_digest', 'exit',
    'verifier_version', 'changed_file_classes',
  ];
  for (const key of required) if (input[key] === undefined) throw new Error(`receipt missing ${key}`);
  if (input.exit !== 0) throw new Error(`receipt requires verifier exit 0, got ${input.exit}`);
  if (!Object.hasOwn(input, 'output')) throw new Error('receipt requires original verifier output');
  if (!Buffer.isBuffer(input.output) && typeof input.output !== 'string') {
    throw new Error('receipt original verifier output must be a string or Buffer');
  }
  const original = Buffer.isBuffer(input.output) ? input.output : Buffer.from(input.output, 'utf8');
  return {
    schema_version: input.schema_version ?? 1,
    candidate: input.candidate,
    repo: input.repo,
    base_commit: input.base_commit,
    patch_sha256: input.patch_sha256,
    tested_tree_oid: input.tested_tree_oid,
    commit_oid: input.commit_oid,
    check_command: input.check_command,
    verifier_image_digest: input.verifier_image_digest,
    dep_material_digest: input.dep_material_digest,
    exit: input.exit,
    output_sha256: sha256(original),
    verifier_version: input.verifier_version,
    changed_file_classes: input.changed_file_classes,
  };
}

export function manifestDigest(readyPacks) {
  const subjects = readyPacks.map((pack) => ({
    diff: pack.diff,
    commit_oid: pack.commit_oid,
    receipt_subject: pack.receipt_subject,
    pr_title: pack.pr_title,
    pr_body: pack.pr_body,
    repo: pack.repo,
    planned_actions: pack.planned_actions,
  })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return sha256(Buffer.from(canonical(subjects), 'utf8'));
}

export function assertBindingChain({patch_sha256, tested_tree_oid, commit_oid, pushed_oid, pr_head_oid}) {
  if (!/^sha256:[0-9a-f]{64}$/i.test(patch_sha256 ?? '')) throw new Error('binding chain has invalid patch_sha256');
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(tested_tree_oid ?? '')) throw new Error('binding chain has invalid tested_tree_oid');
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(commit_oid ?? '')) throw new Error('binding chain has invalid commit_oid');
  if (pushed_oid !== undefined && pushed_oid !== commit_oid) {
    throw new Error(`binding mismatch: pushed_oid ${pushed_oid} != commit_oid ${commit_oid}`);
  }
  if (pr_head_oid !== undefined && pr_head_oid !== commit_oid) {
    throw new Error(`binding mismatch: pr_head_oid ${pr_head_oid} != commit_oid ${commit_oid}`);
  }
  if (pushed_oid !== undefined && pr_head_oid !== undefined && pushed_oid !== pr_head_oid) {
    throw new Error(`binding mismatch: pr_head_oid ${pr_head_oid} != pushed_oid ${pushed_oid}`);
  }
  return true;
}

function limits(spec) {
  const configured = spec.executor.limits ?? {};
  return {
    cpus: configured.cpus ?? 2,
    memory: `${configured.memory_mb ?? 4096}m`,
    pids: configured.pids ?? 512,
  };
}

function hardenedDockerArgs(spec, dirs, {verifier = false} = {}) {
  const limit = limits(spec);
  const workspace = verifier ? (dirs.verifierWorkspace ?? dirs.workspace) : (dirs.authorWorkspace ?? dirs.workspace);
  if (!workspace) throw new Error('container workspace path is required');
  const args = ['run', '--rm', '--user', '10001:10001', '--security-opt', 'no-new-privileges',
    '--cap-drop=ALL', '--cpus', String(limit.cpus), '--memory', limit.memory, '--pids-limit', String(limit.pids)];
  if (verifier) args.push('--network=none');
  args.push('--mount', `type=bind,src=${workspace},dst=/workspace`, '--workdir', '/workspace');
  return args;
}

function shellCommand(commands) {
  return commands.map((command) => `(${command})`).join(' && ');
}

function verifierImage(spec) {
  const configured = spec.executor.verifier_image_digest;
  if (configured && /@sha256:[0-9a-f]{64}$/i.test(configured)) return configured;
  return `${spec.executor.image.split('@')[0]}@${UNRESOLVED_DIGEST}`;
}

function authorPlan(spec, dirs) {
  const prompt = [
    `Fix ${spec.issue_url} from base commit ${spec.base_commit}.`,
    spec.code_prompt,
    `Iterate by running this spec-pinned check until it passes: ${spec.executor.commands.join(' && ')}`,
    'Make only the focused fix and tests. Do not commit; the orchestrator commits with DCO after you return.',
  ].join('\n\n');
  const codex = ['codex', 'exec', '--ephemeral', '--model', 'gpt-5.6-sol',
    '-c', 'model_reasoning_effort="xhigh"', '-c', 'service_tier="fast"', prompt];
  const setup = [
    `git clone ${spec.target_repo} /workspace/repo`,
    `git -C /workspace/repo checkout ${spec.base_commit}`,
    `git -C /workspace/repo config user.name '${OSS_IDENTITY.name}'`,
    `git -C /workspace/repo config user.email '${OSS_IDENTITY.email}'`,
    ...spec.executor.install_commands.map((command) => `cd /workspace/repo && ${command}`),
    `cd /workspace/repo && ${codex.map(quoteArg).join(' ')}`,
    `git -C /workspace/repo add -A`,
    `git -C /workspace/repo commit -s -m 'fix: ${spec.candidate}'`,
  ];
  return {docker: ['docker', ...hardenedDockerArgs(spec, dirs), spec.executor.image, 'sh', '-lc', shellCommand(setup)], codex};
}

function verifierPlan(spec, dirs) {
  const check = spec.executor.commands.join(' && ');
  const commands = [
    `git -C /workspace/clean checkout --detach ${spec.base_commit}`,
    `git -C /workspace/clean reset --hard ${spec.base_commit}`,
    `git -C /workspace/clean clean -ffdqx`,
    `git -C /workspace/clean apply --index /workspace/fix.patch`,
    `cd /workspace/clean && ${check}`,
  ];
  return {docker: ['docker', ...hardenedDockerArgs(spec, dirs, {verifier: true}), verifierImage(spec),
    'sh', '-lc', shellCommand(commands)], check};
}

export async function runAuthorContainer(spec, dirs, {dryRun = false} = {}) {
  const plan = authorPlan(spec, dirs);
  if (dryRun) return {planned: true, ...plan};
  throw new Error('author Docker/Codex execution boundary requires live validation before enablement');
}

export async function runVerifierContainer(spec, dirs, patch, {dryRun = false} = {}) {
  if (typeof patch !== 'string') throw new Error('verifier requires committed patch bytes');
  const plan = verifierPlan(spec, dirs);
  if (dryRun) return {planned: true, ...plan};
  if (plan.docker.includes(`${spec.executor.image.split('@')[0]}@${UNRESOLVED_DIGEST}`)) {
    throw new Error('verifier_image_digest is not pinned in the mission spec');
  }
  throw new Error('verifier Docker execution boundary requires live validation before enablement');
}

function quoteArg(value) {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${String(value).replaceAll("'", "'\\''")}'`;
}

function commandLine(argv) {
  return argv.map(quoteArg).join(' ');
}

function parseArgs(argv) {
  if (argv[0] === 'ship') return {command: 'ship'};
  if (argv[0] !== 'prepare') throw new Error('usage: oss prepare [--dry-run] [--only ID] [--concurrency N]');
  const options = {...DEFAULTS, command: 'prepare'};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--only') options.only = argv[++i];
    else if (arg === '--concurrency') options.concurrency = Number(argv[++i]);
    else if (arg === '--specs') options.specsDir = path.resolve(argv[++i]);
    else if (arg === '--runs') options.runsDir = path.resolve(argv[++i]);
    else throw new Error(`unknown arg ${arg}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('--concurrency must be a positive integer');
  return options;
}

function missionDirs(runsDir, id) {
  const base = path.join(runsDir, id);
  return {
    base,
    authorWorkspace: path.join(base, 'author-workspace'),
    verifierWorkspace: path.join(base, 'verifier-workspace'),
    ready: path.join(base, 'ready-pack'),
  };
}

async function prepareMission(spec, options) {
  const dirs = missionDirs(options.runsDir, spec.mission_id);
  await mkdir(dirs.base, {recursive: true, mode: 0o700});
  const log = async (message) => {
    await appendFile(path.join(dirs.base, 'prepare.log'), `[${new Date().toISOString()}] ${message}\n`, {mode: 0o600});
    console.log(`  ${spec.mission_id}  ${message}`);
  };
  try {
    const checked = await recheck(spec, log);
    if (!checked.clean) return {state: 'SKIP', spec, dirs, detail: checked.reasons.join('; ')};
    await Promise.all([
      mkdir(dirs.authorWorkspace, {recursive: true, mode: 0o700}),
      mkdir(dirs.verifierWorkspace, {recursive: true, mode: 0o700}),
    ]);
    const author = await runAuthorContainer(spec, dirs, {dryRun: options.dryRun});
    const verifier = await runVerifierContainer(spec, dirs, '<PLANNED-COMMITTED-PATCH>', {dryRun: options.dryRun});
    if (!options.dryRun) throw new Error('live author/verifier result handling is not enabled');

    const parsed = parseCandidate(spec.candidate);
    const changed = classifyChangedFiles([], []);
    // A dry-run has no verifier result and therefore MUST NOT call buildReceipt or imply that a
    // receipt exists. This is only the exact schema shape that a successful live run would fill.
    const receipt = {
      schema_version: 1,
      candidate: spec.candidate, repo: `${parsed.owner}/${parsed.repo}`, base_commit: spec.base_commit,
      patch_sha256: '<planned:sha256(fix.patch)>', tested_tree_oid: '<planned:tested-tree-oid>',
      commit_oid: '<planned:author-commit-oid>', check_command: verifier.check,
      verifier_image_digest: verifierImage(spec).split('@').at(-1),
      dep_material_digest: '<planned:lockfile-material-digest>', exit: '<planned:must-equal-0>',
      output_sha256: '<planned:sha256(original-verifier-output)>', verifier_version: VERIFIER_VERSION,
      changed_file_classes: changed,
    };
    const title = `fix: ${spec.candidate}`;
    const body = prBody(spec, {changedFiles: []});
    const readyPack = {
      id: spec.mission_id, candidate: spec.candidate, diff: '<planned:fix.patch bytes>',
      diff_path: path.join(dirs.ready, 'fix.patch'), commit_oid: receipt.commit_oid,
      receipt_subject: receipt, receipt_digest: sha256(Buffer.from(canonical(receipt))),
      redacted_output: '<planned:redacted-verifier-output>',
      pr_title: title, pr_body: body, repo: `${parsed.owner}/${parsed.repo}`,
      planned_actions: ['fork', 'push', 'attest', 'open-pr', 'append-ledger'], author, verifier,
      changed_file_classes: changed,
    };
    return {state: 'READY', spec, dirs, readyPack};
  } catch (error) {
    return {state: 'FAILED', spec, dirs, detail: error.message};
  }
}

function printBoard(results) {
  console.log('\nOSS PREPARE — REVIEW BOARD');
  for (const result of results) {
    if (result.state !== 'READY') {
      console.log(`${result.state} ${result.spec.mission_id} ${result.spec.candidate}: ${result.detail}`);
      continue;
    }
    const pack = result.readyPack;
    console.log(`READY ${pack.id} ${pack.candidate}`);
    console.log(`  author docker:   ${commandLine(pack.author.docker)}`);
    console.log(`  codex exec:      ${commandLine(pack.author.codex)}`);
    console.log(`  verifier docker: ${commandLine(pack.verifier.docker)}`);
    console.log(`  pinned check_command: ${pack.receipt_subject.check_command}`);
    console.log(`  diff path: ${pack.diff_path}`);
    console.log(`  green/exit: ${pack.receipt_subject.exit}`);
    console.log(`  receipt digest: ${pack.receipt_digest}`);
    console.log(`  flagged file-classes: ${pack.changed_file_classes.filter((item) => item.flagged).map((item) => item.class).join(', ') || '(planned after author run)'}`);
    console.log(`  PR title: ${pack.pr_title}`);
    console.log(`  planned receipt shape: ${Object.keys(pack.receipt_subject).join(', ')}`);
  }
  const ready = results.filter((result) => result.state === 'READY').map((result) => result.readyPack);
  const digest = manifestDigest(ready);
  const ids = ready.map((pack) => pack.id).join(' ');
  console.log(`manifest_digest: ${digest}`);
  console.log(`oss ship --approve ${digest}${ids ? ` ${ids}` : ''}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'ship') {
    console.log('increment 2, not implemented');
    return;
  }
  const files = (await readdir(options.specsDir)).filter((file) => file.endsWith('.json') && !file.includes('.example.'));
  const specs = [];
  for (const file of files) specs.push(JSON.parse(await readFile(path.join(options.specsDir, file), 'utf8')));
  const selected = options.only ? specs.filter((spec) => spec.mission_id === options.only) : specs;
  if (!selected.length) throw new Error(`no mission spec with mission_id ${options.only}`);
  validateSpecs(selected);
  const results = await pool(selected, options.concurrency, (spec) => prepareMission(spec, options));
  printBoard(results);
  if (results.some((result) => result.state === 'FAILED')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === OSS_FILE) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
