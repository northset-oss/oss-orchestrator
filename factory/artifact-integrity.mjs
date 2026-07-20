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

function requiredDigest(value, label) {
  const digest = requiredString(value, label);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} is invalid`);
  return digest;
}

function verifyEvidenceAsset(manifest, repositoryPath, baseOid, options) {
  const asset = manifest.evidence_asset;
  if (asset === undefined || asset === null) return null;
  const mission = manifest.mission_id ?? 'READY item';
  if (typeof asset !== 'object' || Array.isArray(asset)) {
    throw new Error(`${mission} evidence_asset must be an object`);
  }
  const repository = requiredString(asset.repository, `${mission} evidence_asset.repository`);
  if (repository !== manifest.fork_repository ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`${mission} evidence asset must target the approved fork repository`);
  }
  const branch = requiredString(asset.branch, `${mission} evidence_asset.branch`);
  git(repositoryPath, ['check-ref-format', `refs/heads/${branch}`], options);
  if (branch === manifest.branch) throw new Error(`${mission} evidence and PR branches must be distinct`);
  const commitOid = requiredOid(asset.commit_oid, `${mission} evidence_asset.commit_oid`);
  if (commitOid === requiredOid(manifest.commit_oid, `${mission} commit_oid`)) {
    throw new Error(`${mission} evidence and patch commits must be distinct`);
  }
  const assetPath = requiredString(asset.path, `${mission} evidence_asset.path`);
  if (path.isAbsolute(assetPath) || assetPath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${mission} evidence asset path must be a normalized repository-relative path`);
  }
  const expectedSha = requiredDigest(asset.sha256, `${mission} evidence_asset.sha256`);
  const expectedUrl = `https://raw.githubusercontent.com/${repository}/${commitOid}/` +
    assetPath.split('/').map(encodeURIComponent).join('/');
  if (asset.url !== expectedUrl) throw new Error(`${mission} evidence asset URL is not commit-bound`);
  if (!String(manifest.pr_body ?? '').includes(expectedUrl)) {
    throw new Error(`${mission} approved PR body does not reference its evidence asset URL`);
  }
  const parents = git(repositoryPath, ['rev-list', '--parents', '-n', '1', commitOid], options)
    .toString('utf8').trim().toLowerCase().split(/\s+/);
  if (parents.length !== 2 || parents[0] !== commitOid || parents[1] !== baseOid) {
    throw new Error(`${mission} evidence commit is not exactly one commit on approved base ${baseOid}`);
  }
  const changedPaths = git(repositoryPath,
    ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commitOid], options)
    .toString('utf8').split('\0').filter(Boolean);
  if (changedPaths.length !== 1 || changedPaths[0] !== assetPath) {
    throw new Error(`${mission} evidence commit must change exactly the declared asset path`);
  }
  const bytes = git(repositoryPath, ['show', `${commitOid}:${assetPath}`], options);
  const actualSha = sha256(bytes);
  if (actualSha !== expectedSha) {
    throw new Error(`${mission} evidence asset digest ${actualSha} does not match ${expectedSha}`);
  }
  return {repository, branch, commit_oid: commitOid, path: assetPath, sha256: actualSha, url: expectedUrl};
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
  const expectedPatch = requiredDigest(manifest.patch_sha256, `${mission} patch_sha256`);

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
  const evidenceAsset = verifyEvidenceAsset(manifest, repositoryPath, baseOid, options);
  return {
    patch_sha256: patchDigest,
    base_oid: baseOid,
    commit_oid: commitOid,
    tested_tree_oid: treeOid,
    ...(evidenceAsset ? {evidence_asset: evidenceAsset} : {}),
  };
}
