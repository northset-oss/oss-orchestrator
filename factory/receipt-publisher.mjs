import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const RECEIPTS_BRANCH = 'receipts';
const DEFAULT_REMOTE_URL = 'https://github.com/northset-oss/verification-pilot.git';
const DEFAULT_WEB_URL = 'https://github.com/northset-oss/verification-pilot';
const DEFAULT_RECEIPT_URL = 'https://northset-oss.github.io/verification-pilot/receipts';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const OID_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MISSION_PATTERN = /^M-(?:\d{3,}|E2[a-c])$/;

export class ReceiptPublisherError extends Error {
  constructor(message, code, detail = {}) {
    super(message);
    this.name = 'ReceiptPublisherError';
    this.code = code;
    this.detail = detail;
  }
}

function positiveInteger(value, fallback, label) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) throw new TypeError(`${label} must be a positive integer`);
  return result;
}

function validMissionId(value) {
  if (typeof value !== 'string' || !MISSION_PATTERN.test(value)) {
    throw new TypeError(`invalid mission_id ${JSON.stringify(value)}`);
  }
  return value;
}

function validOid(value, label) {
  if (typeof value !== 'string' || !OID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase 40-character git OID`);
  }
  return value;
}

function validDigest(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a non-null sha256 digest`);
  }
  return value;
}

function assertJson(value, label, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== 'object') throw new TypeError(`${label} contains a non-JSON value`);
  if (seen.has(value)) throw new TypeError(`${label} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertJson(value[index], `${label}[${index}]`, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} contains a non-plain object`);
    }
    for (const [key, child] of Object.entries(value)) assertJson(child, `${label}.${key}`, seen);
  }
  seen.delete(value);
}

function canonical(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sameJson(left, right) {
  assertJson(left, 'approved value');
  assertJson(right, 'published value');
  return canonical(left) === canonical(right);
}

function requiredJson(value, label) {
  if (value === undefined || value === null) throw new TypeError(`${label} is required`);
  assertJson(value, label);
  return value;
}

function exactValue(item, manifest, key, aliases = []) {
  const keys = [key, ...aliases];
  const itemValue = keys.map((name) => item[name]).find((value) => value !== undefined && value !== null);
  const manifestValue = keys.map((name) => manifest[name]).find((value) => value !== undefined && value !== null);
  if (itemValue !== undefined && itemValue !== null && manifestValue !== undefined && manifestValue !== null &&
      !sameJson(itemValue, manifestValue)) {
    throw new ReceiptPublisherError(`${item.mission_id ?? 'mission'} ${key} differs from the approved manifest`,
      'APPROVED_PROOF_MISMATCH');
  }
  return manifestValue ?? itemValue;
}

function assertExistingProofField(existing, key, expected, missionId) {
  if (existing[key] !== undefined && existing[key] !== null && !sameJson(existing[key], expected)) {
    throw new ReceiptPublisherError(`${missionId} approved proof ${key} differs from the approved manifest`,
      'APPROVED_PROOF_MISMATCH');
  }
}

function nonblank(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function exactKeys(value, required) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key));
}

function validTime(value, label) {
  if (!nonblank(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO-8601 time`);
  }
  return value;
}

function validHttpsUrl(value, label, {nullable = false} = {}) {
  if (nullable && value === null) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') throw new Error('not HTTPS');
    return parsed.href;
  } catch {
    throw new TypeError(`${label} must be an HTTPS URL${nullable ? ' or null' : ''}`);
  }
}

function validProofCommand(value) {
  return nonblank(value) || (Array.isArray(value) && value.length > 0 && value.every(nonblank));
}

function assertV2ProofEvidence(proof, missionId) {
  if (proof.schema_version !== 2) return;
  const proofFields = [
    'schema_version', 'mission_id', 'task_id', 'repository', 'issue_number', 'candidate',
    'base_oid', 'patch_sha256', 'commit_oid', 'tested_tree_oid', 'checks', 'claim',
    'batch_approval_digest', 'environment', 'base_observation', 'patched_observation',
    'executed_commands', 'checks_not_run', 'limitations', 'verification_started_at',
    'verification_finished_at',
  ];
  if (!exactKeys(proof, proofFields) || !nonblank(proof.task_id) || !nonblank(proof.repository) ||
      !Number.isInteger(proof.issue_number) || proof.issue_number < 1 || !nonblank(proof.candidate) ||
      !proof.claim || typeof proof.claim !== 'object' || Array.isArray(proof.claim) ||
      !proof.environment || typeof proof.environment !== 'object' || Array.isArray(proof.environment) ||
      !proof.base_observation || typeof proof.base_observation !== 'object' ||
      !proof.patched_observation || typeof proof.patched_observation !== 'object') {
    throw new TypeError(`${missionId} proof v2 has an invalid shape`);
  }
  const commands = proof.executed_commands;
  if (!Array.isArray(commands) || commands.length !== 2) {
    throw new TypeError(`${missionId} proof v2 must contain base and patched executed_commands`);
  }
  const expectedPhases = ['base_observation', 'patched_observation'];
  const commandFields = [
    'phase', 'command', 'network', 'expected_result', 'result', 'expectation_met',
    'started_at', 'finished_at', 'duration_ms', 'exit_code', 'stdout_sha256',
    'stderr_sha256', 'output_sha256',
  ];
  for (const [index, command] of commands.entries()) {
    const label = `${missionId} proof v2 executed_commands[${index}]`;
    if (!exactKeys(command, commandFields) ||
        command.phase !== expectedPhases[index] || !validProofCommand(command.command) ||
        command.network !== 'none' || !['success', 'failure'].includes(command.expected_result) ||
        !['PASS', 'FAIL'].includes(command.result) || typeof command.expectation_met !== 'boolean' ||
        !Number.isInteger(command.exit_code) || !Number.isFinite(command.duration_ms) ||
        command.duration_ms < 0) {
      throw new TypeError(`${label} is malformed`);
    }
    validTime(command.started_at, `${label}.started_at`);
    validTime(command.finished_at, `${label}.finished_at`);
    if (Date.parse(command.finished_at) < Date.parse(command.started_at)) {
      throw new TypeError(`${label} timestamps are reversed`);
    }
    for (const field of ['stdout_sha256', 'stderr_sha256', 'output_sha256']) {
      validDigest(command[field], `${label} ${field}`);
    }
    if ((command.exit_code === 0) !== (command.result === 'PASS') ||
        command.expectation_met !== (command.expected_result === 'success'
          ? command.exit_code === 0 : command.exit_code !== 0)) {
      throw new TypeError(`${label} result does not match its exit code and expectation`);
    }
  }
  if (commands[1].exit_code !== 0 || commands[1].expectation_met !== true) {
    throw new TypeError(`${missionId} proof v2 patched command must be a successful expected pass`);
  }
  if (canonical(proof.base_observation) !== canonical(commands[0]) ||
      canonical(proof.patched_observation) !== canonical(commands[1])) {
    throw new TypeError(`${missionId} proof v2 observations contradict executed_commands`);
  }
  validTime(proof.verification_started_at, `${missionId} proof v2 verification_started_at`);
  validTime(proof.verification_finished_at, `${missionId} proof v2 verification_finished_at`);
  if (Date.parse(proof.verification_finished_at) < Date.parse(proof.verification_started_at)) {
    throw new TypeError(`${missionId} proof v2 verification timestamps are reversed`);
  }
  if (!nonblank(proof.environment.image)) {
    throw new TypeError(`${missionId} proof v2 requires verification timing and executor image identity`);
  }
  if (!Array.isArray(proof.checks_not_run) || proof.checks_not_run.some((entry) =>
    !exactKeys(entry, ['check', 'reason']) ||
    !nonblank(entry.check) || !nonblank(entry.reason))) {
    throw new TypeError(`${missionId} proof v2 checks_not_run must contain nonblank check and reason strings`);
  }
  if (!Array.isArray(proof.limitations) || proof.limitations.some((entry) => !nonblank(entry))) {
    throw new TypeError(`${missionId} proof v2 limitations must contain only nonblank strings`);
  }
}

function proofFor(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('receipt item must be an object');
  const manifest = item.manifest && typeof item.manifest === 'object' && !Array.isArray(item.manifest)
    ? item.manifest : item;
  const missionId = validMissionId(item.mission_id ?? manifest.mission_id);
  if (item.mission_id !== undefined && manifest.mission_id !== undefined &&
      item.mission_id !== manifest.mission_id) {
    throw new ReceiptPublisherError(`${missionId} mission_id differs from the approved manifest`,
      'APPROVED_PROOF_MISMATCH');
  }
  const baseOid = validOid(exactValue(item, manifest, 'base_oid', ['base_commit']), `${missionId} base_oid`);
  const patchSha256 = validDigest(exactValue(item, manifest, 'patch_sha256'), `${missionId} patch_sha256`);
  const commitOid = validOid(exactValue(item, manifest, 'commit_oid', ['patch_commit']), `${missionId} commit_oid`);
  const testedTreeOid = validOid(exactValue(item, manifest, 'tested_tree_oid'), `${missionId} tested_tree_oid`);
  const checks = requiredJson(exactValue(item, manifest, 'checks'), `${missionId} checks`);
  if (!Array.isArray(checks) || checks.length === 0) throw new TypeError(`${missionId} checks must be a non-empty array`);
  const claim = requiredJson(exactValue(item, manifest, 'receipt_claim', ['claim']), `${missionId} claim`);
  if ((typeof claim === 'string' && !claim.trim()) || (typeof claim !== 'string' &&
      (typeof claim !== 'object' || Array.isArray(claim)))) {
    throw new TypeError(`${missionId} claim must be a non-empty string or object`);
  }
  const approvalDigest = validDigest(item.approval_digest ?? item.batch_approval_digest,
    `${missionId} batch approval digest`);

  const approvedProof = manifest.proof && typeof manifest.proof === 'object' && !Array.isArray(manifest.proof)
    ? manifest.proof : {};
  assertJson(approvedProof, `${missionId} approved proof`);
  for (const [key, expected] of Object.entries({
    mission_id: missionId,
    base_oid: baseOid,
    patch_sha256: patchSha256,
    commit_oid: commitOid,
    tested_tree_oid: testedTreeOid,
    checks,
    claim,
  })) assertExistingProofField(approvedProof, key, expected, missionId);
  if (approvedProof.batch_approval_digest !== undefined && approvedProof.batch_approval_digest !== null) {
    assertExistingProofField(approvedProof, 'batch_approval_digest', approvalDigest, missionId);
  }

  const {proof_sha256: _oldProofDigest, batch_approval_digest: _oldApprovalDigest, ...approvedFields} = approvedProof;
  const proof = {
    ...approvedFields,
    schema_version: approvedFields.schema_version ?? 1,
    mission_id: missionId,
    base_oid: baseOid,
    patch_sha256: patchSha256,
    commit_oid: commitOid,
    tested_tree_oid: testedTreeOid,
    checks,
    claim,
    batch_approval_digest: approvalDigest,
  };
  assertJson(proof, `${missionId} proof`);
  assertV2ProofEvidence(proof, missionId);
  const bytes = Buffer.from(`${canonical(proof)}\n`, 'utf8');
  return {missionId, commitOid, approvalDigest, proof, bytes, proofSha256: digest(bytes)};
}

function proofPath(missionId, commitOid) {
  return `receipts/${validMissionId(missionId)}/${validOid(commitOid, 'commit_oid')}/proof.json`;
}

function publicationPath(missionId, commitOid) {
  return `receipts/${validMissionId(missionId)}/${validOid(commitOid, 'commit_oid')}/publication.json`;
}

function currentPath(missionId) {
  return `receipts/${validMissionId(missionId)}/current.json`;
}

export function receiptUrlFor(missionId, commitOid) {
  validOid(commitOid, 'commit_oid');
  return `${DEFAULT_RECEIPT_URL}/${validMissionId(missionId)}/`;
}

function pointerFor(entry) {
  const value = {
    schema_version: 1,
    mission_id: entry.missionId,
    contribution_commit_oid: entry.commitOid,
    proof_sha256: entry.proofSha256,
  };
  return {relativePath: currentPath(entry.missionId), bytes: Buffer.from(`${canonical(value)}\n`, 'utf8')};
}

export function runBounded(command, args, {
  spawnImpl = spawn,
  cwd,
  env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  timeoutMs = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  maxOutputBytes = positiveInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes');
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let done = false;
    let timedOut = false;
    let outputLimited = false;
    const collect = (stream, target) => stream?.on('data', (chunk) => {
      if (done) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxOutputBytes - bytes);
      if (remaining) target.push(buffer.subarray(0, remaining));
      bytes += Math.min(remaining, buffer.length);
      if (buffer.length > remaining) {
        outputLimited = true;
        child.kill('SIGKILL');
      }
    });
    collect(child.stdout, stdout);
    collect(child.stderr, stderr);
    const timer = setTimeout(() => {
      if (done) return;
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        code: Number.isInteger(code) ? code : null,
        signal: signal ?? null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        outputLimited,
      });
    });
  });
}

function gitFailure(operation, result) {
  if (result.timedOut) return new ReceiptPublisherError(`${operation} timed out`, 'RECEIPT_GIT_TIMEOUT', result);
  if (result.outputLimited) {
    return new ReceiptPublisherError(`${operation} exceeded the output limit`, 'RECEIPT_GIT_OUTPUT_LIMIT', result);
  }
  const detail = String(result.stderr || result.stdout || `exit ${result.code}`).trim();
  const error = new ReceiptPublisherError(`${operation} failed: ${detail}`, 'RECEIPT_GIT_FAILED', result);
  const match = /(?:requested URL returned error:\s*|\bHTTP(?:\/\S+)?\s+)([45][0-9]{2})\b/i.exec(detail);
  if (match) {
    error.httpStatus = Number(match[1]);
    error.status = error.httpStatus;
    error.headers = {};
  }
  return error;
}

function commandRunner({run, spawnImpl, timeoutMs, maxOutputBytes, gitExecutable}) {
  const execute = run ?? ((command, args, options) => runBounded(command, args, {
    ...options, spawnImpl, timeoutMs, maxOutputBytes,
  }));
  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  return async function git(args, {cwd, env = {}, allow = [0], operation = args.join(' ')} = {}) {
    const result = await execute(gitExecutable, args, {
      cwd,
      env: {...gitEnv, ...env},
      timeoutMs,
      maxOutputBytes,
      shell: false,
    });
    if (!result || !allow.includes(result.code) || result.timedOut || result.outputLimited) {
      throw gitFailure(operation, result ?? {code: null, stderr: 'runner returned no result'});
    }
    return result;
  };
}

async function exactFileReadback(file, expected, label) {
  const actual = await readFile(file);
  if (!actual.equals(expected)) {
    throw new ReceiptPublisherError(`${label} changed before commit`, 'RECEIPT_PROOF_READBACK_MISMATCH');
  }
}

async function committedReadback(git, checkout, relativePath, expected, ref, label) {
  const result = await git(['-C', checkout, 'show', `${ref}:${relativePath}`], {operation: `${label} committed readback`});
  const actual = Buffer.from(result.stdout, 'utf8');
  if (!actual.equals(expected)) {
    throw new ReceiptPublisherError(`${label} committed bytes do not match`, 'RECEIPT_PROOF_READBACK_MISMATCH');
  }
}

async function existingProof(git, checkout, relativePath) {
  const exists = await git(['-C', checkout, 'cat-file', '-e', `HEAD:${relativePath}`], {
    allow: [0, 128], operation: `inspect existing ${relativePath}`,
  });
  if (exists.code === 128) return null;
  const result = await git(['-C', checkout, 'show', `HEAD:${relativePath}`], {
    operation: `read existing ${relativePath}`,
  });
  return Buffer.from(result.stdout, 'utf8');
}

async function introductionCommit(git, checkout, relativePath) {
  const result = await git(['-C', checkout, 'log', '-1', '--format=%H', '--diff-filter=A',
    'HEAD', '--', relativePath], {operation: `locate receipt batch for ${relativePath}`});
  const oid = result.stdout.trim();
  if (!oid) {
    throw new ReceiptPublisherError(`${relativePath} has no append-only introduction commit`,
      'RECEIPT_ADOPTION_BATCH_MISMATCH');
  }
  return validOid(oid, 'batch_commit_oid');
}

function resultsFor(proofs, batchCommitOid) {
  return Object.fromEntries(proofs.map((entry) => [entry.missionId, {
    mission_id: entry.missionId,
    receipt_url: receiptUrlFor(entry.missionId, entry.commitOid),
    proof_sha256: entry.proofSha256,
    batch_approval_digest: entry.approvalDigest,
    batch_commit_oid: batchCommitOid,
  }]));
}

export function createReceiptPublisher({
  remoteUrl = DEFAULT_REMOTE_URL,
  gitExecutable = 'git',
  run,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  tempRoot = os.tmpdir(),
  authorName = 'Northset Receipt Publisher',
  authorEmail = 'receipts@northset.ai',
  now = () => new Date(),
} = {}) {
  if (typeof remoteUrl !== 'string' || !remoteUrl) throw new TypeError('remoteUrl is required');
  if (typeof gitExecutable !== 'string' || !gitExecutable) throw new TypeError('gitExecutable is required');
  if (run !== undefined && typeof run !== 'function') throw new TypeError('run must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  timeoutMs = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  maxOutputBytes = positiveInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes');
  const git = commandRunner({run, spawnImpl, timeoutMs, maxOutputBytes, gitExecutable});

  return async function receiptPublisher(items) {
    if (!Array.isArray(items) || items.length === 0) throw new TypeError('receiptPublisher requires a non-empty item array');
    const proofs = items.map(proofFor).sort((left, right) => left.missionId.localeCompare(right.missionId));
    if (new Set(proofs.map((entry) => entry.missionId)).size !== proofs.length) {
      throw new ReceiptPublisherError('receipt batch contains duplicate mission IDs', 'DUPLICATE_RECEIPT_MISSION');
    }
    if (new Set(proofs.map((entry) => entry.approvalDigest)).size !== 1) {
      throw new ReceiptPublisherError('receipt batch contains more than one batch approval digest',
        'RECEIPT_APPROVAL_BATCH_MISMATCH');
    }
    const workspace = await mkdtemp(path.join(tempRoot, 'northset-receipts-'));
    const checkout = path.join(workspace, 'ledger');
    try {
      await git(['clone', '--no-checkout', '--origin', 'origin', '--', remoteUrl, checkout], {
        operation: 'clone isolated receipt repository',
      });
      const branch = await git(['-C', checkout, 'show-ref', '--verify', '--quiet',
        `refs/remotes/origin/${RECEIPTS_BRANCH}`], {
        allow: [0, 1], operation: 'inspect remote receipts branch',
      });
      if (branch.code === 0) {
        await git(['-C', checkout, 'checkout', '--detach', `refs/remotes/origin/${RECEIPTS_BRANCH}`], {
          operation: 'checkout remote receipts branch',
        });
      } else {
        await git(['-C', checkout, 'checkout', '--orphan', RECEIPTS_BRANCH], {
          operation: 'create receipts branch',
        });
      }

      const additions = [];
      const pointers = [];
      for (const entry of proofs) {
        const relativePath = proofPath(entry.missionId, entry.commitOid);
        const existing = branch.code === 0 ? await existingProof(git, checkout, relativePath) : null;
        if (existing !== null) {
          if (!existing.equals(entry.bytes)) {
            throw new ReceiptPublisherError(
              `${relativePath} already exists with different immutable proof bytes`,
              'RECEIPT_PROOF_CONFLICT', {path: relativePath});
          }
          continue;
        }
        const file = path.join(checkout, ...relativePath.split('/'));
        await mkdir(path.dirname(file), {recursive: true});
        await writeFile(file, entry.bytes, {flag: 'wx'});
        await exactFileReadback(file, entry.bytes, entry.missionId);
        additions.push({...entry, relativePath});
      }

      if (additions.length !== 0 && additions.length !== proofs.length) {
        throw new ReceiptPublisherError(
          'receipt batch is only partially present; refusing to assign one commit to mixed provenance',
          'RECEIPT_PARTIAL_BATCH',
        );
      }
      for (const entry of proofs) {
        const pointer = pointerFor(entry);
        const existing = branch.code === 0 ? await existingProof(git, checkout, pointer.relativePath) : null;
        if (existing?.equals(pointer.bytes)) continue;
        const file = path.join(checkout, ...pointer.relativePath.split('/'));
        await mkdir(path.dirname(file), {recursive: true});
        await writeFile(file, pointer.bytes);
        await exactFileReadback(file, pointer.bytes, `${entry.missionId} current pointer`);
        pointers.push({...entry, ...pointer});
      }

      if (additions.length === 0 && pointers.length === 0) {
        const commits = new Set();
        for (const entry of proofs) {
          commits.add(await introductionCommit(git, checkout, proofPath(entry.missionId, entry.commitOid)));
        }
        if (commits.size !== 1) {
          throw new ReceiptPublisherError('identical remote proofs were not introduced by one batch commit',
            'RECEIPT_ADOPTION_BATCH_MISMATCH');
        }
        return resultsFor(proofs, [...commits][0]);
      }

      await git(['-C', checkout, 'add', '--',
        ...additions.map((entry) => entry.relativePath),
        ...pointers.map((entry) => entry.relativePath)], {
        operation: 'stage receipt batch',
      });
      const timestamp = now();
      const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
      if (!Number.isFinite(date.getTime())) throw new TypeError('now() must return a valid time');
      const commitEnvDate = date.toISOString();
      await git(['-C', checkout,
        '-c', `user.name=${authorName}`,
        '-c', `user.email=${authorEmail}`,
        '-c', 'core.hooksPath=/dev/null',
        'commit', '-m', additions.length
          ? `Publish receipt batch: ${additions.map((entry) => entry.missionId).join(', ')}`
          : `Publish receipt pointers: ${pointers.map((entry) => entry.missionId).join(', ')}`], {
        operation: 'commit receipt batch',
        cwd: checkout,
        env: {GIT_AUTHOR_DATE: commitEnvDate, GIT_COMMITTER_DATE: commitEnvDate},
      });
      const oidResult = await git(['-C', checkout, 'rev-parse', 'HEAD'], {operation: 'read receipt batch commit'});
      const commitOid = validOid(oidResult.stdout.trim(), 'receipt_commit_oid');
      for (const entry of additions) {
        await committedReadback(git, checkout, entry.relativePath, entry.bytes, commitOid, entry.missionId);
      }
      for (const entry of pointers) {
        await committedReadback(git, checkout, entry.relativePath, entry.bytes, commitOid,
          `${entry.missionId} current pointer`);
      }
      await git(['-C', checkout, '-c', 'core.hooksPath=/dev/null', 'push', '--porcelain',
        'origin', `HEAD:refs/heads/${RECEIPTS_BRANCH}`], {
        operation: 'non-force receipt batch push',
      });
      if (additions.length) return resultsFor(proofs, commitOid);
      const introductionCommits = new Set();
      for (const entry of proofs) {
        introductionCommits.add(await introductionCommit(git, checkout, proofPath(entry.missionId, entry.commitOid)));
      }
      if (introductionCommits.size !== 1) {
        throw new ReceiptPublisherError('existing proofs were not introduced by one batch commit',
          'RECEIPT_ADOPTION_BATCH_MISMATCH');
      }
      return resultsFor(proofs, [...introductionCommits][0]);
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  };
}

function statusFor(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new TypeError('receipt status item must be an object');
  }
  const missionId = validMissionId(item.mission_id);
  const commitOid = validOid(item.commit_oid, `${missionId} commit_oid`);
  const prNumber = Number(item.pr_number);
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new TypeError(`${missionId} pr_number must be positive`);
  for (const field of ['receipt_url', 'pr_url', 'pr_state', 'attestation_state']) {
    if (!nonblank(item[field])) throw new TypeError(`${missionId} ${field} is required`);
  }
  if (item.receipt_url !== receiptUrlFor(missionId, commitOid)) {
    throw new TypeError(`${missionId} receipt_url must be the canonical public ledger URL`);
  }
  validHttpsUrl(item.pr_url, `${missionId} pr_url`);
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(item.pr_state)) {
    throw new TypeError(`${missionId} pr_state is invalid`);
  }
  const merged = item.merged === true;
  if (merged !== (item.pr_state === 'MERGED')) {
    throw new TypeError(`${missionId} merged state is inconsistent`);
  }
  const ciState = item.ci_state ?? null;
  if (ciState !== null && !nonblank(ciState)) throw new TypeError(`${missionId} ci_state is invalid`);
  const prHeadOid = validOid(item.pr_head_oid ?? commitOid, `${missionId} pr_head_oid`);
  const mergeCommitOid = item.merge_commit_oid ?? null;
  if (mergeCommitOid !== null) validOid(mergeCommitOid, `${missionId} merge_commit_oid`);
  if (merged !== (mergeCommitOid !== null)) {
    throw new TypeError(`${missionId} merge_commit_oid is inconsistent with merged state`);
  }
  const attestationUrl = item.attestation_url ?? null;
  validHttpsUrl(attestationUrl, `${missionId} attestation_url`, {nullable: true});
  validTime(item.observed_at, `${missionId} observed_at`);
  const status = {
    schema_version: 2,
    mission_id: missionId,
    contribution_commit_oid: commitOid,
    pr_head_oid: prHeadOid,
    merge_commit_oid: mergeCommitOid,
    receipt_url: item.receipt_url,
    pr_url: item.pr_url,
    pr_number: prNumber,
    pr_state: item.pr_state,
    merged,
    ci_state: ciState,
    attestation_state: item.attestation_state,
    attestation_url: attestationUrl,
    observed_at: item.observed_at,
  };
  assertJson(status, `${missionId} publication status`);
  return {missionId, commitOid, status, bytes: Buffer.from(`${canonical(status)}\n`, 'utf8')};
}

async function latestPathCommit(git, checkout, relativePath) {
  const result = await git(['-C', checkout, 'log', '-1', '--format=%H', 'HEAD', '--', relativePath], {
    operation: `locate latest status commit for ${relativePath}`,
  });
  return validOid(result.stdout.trim(), 'status_commit_oid');
}

/** Publish mutable factual PR/attestation envelopes after upstream submission. */
export function createReceiptStatusPublisher({
  remoteUrl = DEFAULT_REMOTE_URL,
  gitExecutable = 'git',
  run,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  tempRoot = os.tmpdir(),
  authorName = 'Northset Receipt Publisher',
  authorEmail = 'receipts@northset.ai',
  now = () => new Date(),
} = {}) {
  if (typeof remoteUrl !== 'string' || !remoteUrl) throw new TypeError('remoteUrl is required');
  const git = commandRunner({run, spawnImpl, timeoutMs, maxOutputBytes, gitExecutable});
  return async function publishReceiptStatuses(items) {
    if (!Array.isArray(items) || !items.length) return {};
    const statuses = items.map(statusFor).sort((left, right) => left.missionId.localeCompare(right.missionId));
    if (new Set(statuses.map((item) => item.missionId)).size !== statuses.length) {
      throw new ReceiptPublisherError('status batch contains duplicate mission IDs', 'DUPLICATE_STATUS_MISSION');
    }
    const workspace = await mkdtemp(path.join(tempRoot, 'northset-receipt-status-'));
    const checkout = path.join(workspace, 'ledger');
    try {
      await git(['clone', '--no-checkout', '--origin', 'origin', '--', remoteUrl, checkout], {
        operation: 'clone isolated receipt status repository',
      });
      await git(['-C', checkout, 'checkout', '--detach', `refs/remotes/origin/${RECEIPTS_BRANCH}`], {
        operation: 'checkout remote receipts branch for status',
      });
      const changed = [];
      for (const entry of statuses) {
        const proof = proofPath(entry.missionId, entry.commitOid);
        const proofExists = await git(['-C', checkout, 'cat-file', '-e', `HEAD:${proof}`], {
          allow: [0, 128], operation: `verify immutable proof for ${entry.missionId}`,
        });
        if (proofExists.code !== 0) {
          throw new ReceiptPublisherError(`${entry.missionId} immutable proof is missing`,
            'RECEIPT_STATUS_WITHOUT_PROOF');
        }
        const relativePath = publicationPath(entry.missionId, entry.commitOid);
        const existing = await existingProof(git, checkout, relativePath);
        if (existing?.equals(entry.bytes)) continue;
        const file = path.join(checkout, ...relativePath.split('/'));
        await mkdir(path.dirname(file), {recursive: true});
        await writeFile(file, entry.bytes);
        await exactFileReadback(file, entry.bytes, `${entry.missionId} status`);
        changed.push({...entry, relativePath});
      }
      if (changed.length) {
        await git(['-C', checkout, 'add', '--', ...changed.map((entry) => entry.relativePath)], {
          operation: 'stage receipt status batch',
        });
        const timestamp = now();
        const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
        if (!Number.isFinite(date.getTime())) throw new TypeError('now() must return a valid time');
        await git(['-C', checkout,
          '-c', `user.name=${authorName}`,
          '-c', `user.email=${authorEmail}`,
          '-c', 'core.hooksPath=/dev/null',
          'commit', '-m', `Reconcile receipt status: ${changed.map((entry) => entry.missionId).join(', ')}`], {
          operation: 'commit receipt status batch',
          cwd: checkout,
          env: {GIT_AUTHOR_DATE: date.toISOString(), GIT_COMMITTER_DATE: date.toISOString()},
        });
        const head = (await git(['-C', checkout, 'rev-parse', 'HEAD'], {
          operation: 'read receipt status commit',
        })).stdout.trim();
        for (const entry of changed) {
          await committedReadback(git, checkout, entry.relativePath, entry.bytes, head,
            `${entry.missionId} status`);
        }
        await git(['-C', checkout, '-c', 'core.hooksPath=/dev/null', 'push', '--porcelain',
          'origin', `HEAD:refs/heads/${RECEIPTS_BRANCH}`], {
          operation: 'non-force receipt status push',
        });
      }
      const results = {};
      for (const entry of statuses) {
        const relativePath = publicationPath(entry.missionId, entry.commitOid);
        const commitOid = await latestPathCommit(git, checkout, relativePath);
        results[entry.missionId] = {
          mission_id: entry.missionId,
          status_url: `${DEFAULT_WEB_URL}/blob/${RECEIPTS_BRANCH}/${relativePath}`,
          status_commit_oid: commitOid,
        };
      }
      return results;
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  };
}
