import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const RECEIPTS_BRANCH = 'receipts';
const DEFAULT_REMOTE_URL = 'https://github.com/northset-oss/verification-pilot.git';
const DEFAULT_WEB_URL = 'https://github.com/northset-oss/verification-pilot';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const OID_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MISSION_PATTERN = /^M-[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
  const bytes = Buffer.from(`${canonical(proof)}\n`, 'utf8');
  return {missionId, commitOid, approvalDigest, proof, bytes, proofSha256: digest(bytes)};
}

function proofPath(missionId, commitOid) {
  return `receipts/${validMissionId(missionId)}/${validOid(commitOid, 'commit_oid')}/proof.json`;
}

export function receiptUrlFor(missionId, commitOid) {
  return `${DEFAULT_WEB_URL}/blob/${RECEIPTS_BRANCH}/${proofPath(missionId, commitOid)}`;
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
  return new ReceiptPublisherError(`${operation} failed: ${detail}`, 'RECEIPT_GIT_FAILED', result);
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

      if (additions.length === 0) {
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

      await git(['-C', checkout, 'add', '--', ...additions.map((entry) => entry.relativePath)], {
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
        'commit', '-m', `Publish receipt batch: ${additions.map((entry) => entry.missionId).join(', ')}`], {
        operation: 'commit receipt batch',
        cwd: checkout,
        env: {GIT_AUTHOR_DATE: commitEnvDate, GIT_COMMITTER_DATE: commitEnvDate},
      });
      const oidResult = await git(['-C', checkout, 'rev-parse', 'HEAD'], {operation: 'read receipt batch commit'});
      const batchCommitOid = validOid(oidResult.stdout.trim(), 'batch_commit_oid');
      for (const entry of additions) {
        await committedReadback(git, checkout, entry.relativePath, entry.bytes, batchCommitOid, entry.missionId);
      }
      await git(['-C', checkout, '-c', 'core.hooksPath=/dev/null', 'push', '--porcelain',
        'origin', `HEAD:refs/heads/${RECEIPTS_BRANCH}`], {
        operation: 'non-force receipt batch push',
      });
      return resultsFor(proofs, batchCommitOid);
    } finally {
      await rm(workspace, {recursive: true, force: true});
    }
  };
}
