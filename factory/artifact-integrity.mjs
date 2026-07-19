import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {sha256} from './db.mjs';

function requiredString(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is required`);
  return value;
}

function requiredOid(value, label) {
  const oid = requiredString(value, label).toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error(`${label} must be a full Git OID`);
  return oid;
}

function cleanGitEnvironment() {
  return {
    ...Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR']
      .filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
    HOME: os.tmpdir(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
}

function git(repositoryPath, args, {spawn = spawnSync} = {}) {
  const result = spawn('git', ['-C', repositoryPath, ...args], {
    encoding: null,
    env: cleanGitEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = Buffer.from(result.stderr ?? '').toString('utf8').trim();
    throw new Error(`durable Git artifact check failed: ${detail || `exit ${result.status}`}`);
  }
  return Buffer.from(result.stdout ?? '');
}

/** Rebind mutable review links to the immutable patch, base, commit, and tree before authorization. */
export function verifyReadyArtifacts(manifest, options = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('READY artifact manifest is required');
  }
  const mission = manifest.mission_id ?? 'READY item';
  const rawRepositoryPath = requiredString(manifest.repository_path, `${mission} repository_path`);
  const rawPatchPath = requiredString(manifest.patch_path, `${mission} patch_path`);
  if (!path.isAbsolute(rawRepositoryPath) || !path.isAbsolute(rawPatchPath)) {
    throw new Error(`${mission} durable artifact paths must be absolute`);
  }
  const repositoryPath = path.resolve(rawRepositoryPath);
  const patchPath = path.resolve(rawPatchPath);
  const baseOid = requiredOid(manifest.base_oid, `${mission} base_oid`);
  const commitOid = requiredOid(manifest.commit_oid, `${mission} commit_oid`);
  const treeOid = requiredOid(manifest.tested_tree_oid, `${mission} tested_tree_oid`);
  const expectedPatch = requiredString(manifest.patch_sha256, `${mission} patch_sha256`);
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedPatch)) throw new Error(`${mission} patch_sha256 is invalid`);

  const patch = readFileSync(patchPath);
  const patchDigest = sha256(patch);
  if (patchDigest !== expectedPatch) {
    throw new Error(`${mission} durable patch digest ${patchDigest} does not match ${expectedPatch}`);
  }
  const resolvedCommit = git(repositoryPath, ['rev-parse', '--verify', `${commitOid}^{commit}`], options)
    .toString('utf8').trim().toLowerCase();
  if (resolvedCommit !== commitOid) throw new Error(`${mission} durable commit resolved to ${resolvedCommit}`);
  const resolvedTree = git(repositoryPath, ['rev-parse', `${commitOid}^{tree}`], options)
    .toString('utf8').trim().toLowerCase();
  if (resolvedTree !== treeOid) {
    throw new Error(`${mission} durable tree ${resolvedTree} does not match ${treeOid}`);
  }
  const parents = git(repositoryPath, ['rev-list', '--parents', '-n', '1', commitOid], options)
    .toString('utf8').trim().toLowerCase().split(/\s+/);
  if (parents.length !== 2 || parents[0] !== commitOid || parents[1] !== baseOid) {
    throw new Error(`${mission} durable commit is not exactly one commit on approved base ${baseOid}`);
  }
  const generatedPatch = git(repositoryPath, ['diff', '--binary', '--full-index', baseOid, commitOid], options);
  if (!generatedPatch.equals(patch)) {
    throw new Error(`${mission} durable patch bytes do not match the approved commit diff`);
  }
  return {patch_sha256: patchDigest, base_oid: baseOid, commit_oid: commitOid, tested_tree_oid: treeOid};
}
