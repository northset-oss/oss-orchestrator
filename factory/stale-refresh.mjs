import {access, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildProof} from './verifier.mjs';
import {runBounded} from './node-worker.mjs';
import {receiptUrlFor} from './receipt-publisher.mjs';
import {finalizePrBody} from './worker.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_WORKER = path.join(HERE, 'node-worker.mjs');
const OUTPUT_LIMIT = 4 * 1024 * 1024;

async function mustRun(run, command, args, options, label) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
  }
  return result;
}

async function invokeBundledWorker(payload, {run}) {
  const result = await mustRun(run, process.execPath, [BUNDLED_WORKER], {
    input: `${JSON.stringify(payload)}\n`,
    timeoutMs: 30 * 60_000,
    maxOutputBytes: OUTPUT_LIMIT,
  }, 'stale refresh worker');
  try { return JSON.parse(result.stdout); }
  catch (error) { throw new Error(`stale refresh worker returned invalid JSON: ${error.message}`); }
}

function exactOid(value, label) {
  const oid = String(value ?? '');
  if (!/^[0-9a-f]{40}$/i.test(oid)) throw new Error(`${label} must be an exact commit OID`);
  return oid.toLowerCase();
}

function manifestFor(plan) {
  const manifest = plan?.manifest ?? plan;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('stale refresh requires an approved manifest');
  }
  return manifest;
}

function taskFor(plan, manifest, baseOid) {
  const repository = manifest.repository ?? plan.repository;
  const issueNumber = manifest.issue_number ?? plan.issue_number;
  return {
    task_id: plan.task_id ?? manifest.task_id,
    candidate: manifest.candidate ?? `${repository}#${issueNumber}`,
    repository,
    issue_number: issueNumber,
    base_oid: baseOid,
    live_state: {
      repository: {
        id: manifest.repository_node_id ?? null,
        defaultBranch: manifest.base_branch,
      },
    },
  };
}

function replacementManifest(plan, manifest, artifact, refreshed) {
  const missionId = plan.mission_id ?? manifest.mission_id;
  if (typeof missionId !== 'string' || !missionId) throw new Error('stale refresh requires mission_id');
  if (!refreshed?.verification?.ok) throw new Error('stale refresh worker did not return verified bytes');
  const receiptUrl = receiptUrlFor(missionId, refreshed.commit_oid);
  const previousReceiptUrl = String(manifest.receipt_url ?? '');
  const prBody = String(manifest.pr_body ?? '');
  if (!previousReceiptUrl || !prBody.includes(previousReceiptUrl)) {
    throw new Error('stale refresh requires the approved PR body receipt binding');
  }
  const reboundPrBody = finalizePrBody(prBody.replaceAll(previousReceiptUrl, receiptUrl), missionId, receiptUrl, {
    command: refreshed.verification.patched_observation?.command,
    commitOid: refreshed.commit_oid,
    changedFiles: refreshed.verification.changed_files,
    replaceExisting: prBody.includes(`<!-- northset-receipt:${missionId}:start -->`),
  });
  const next = {
    ...manifest,
    mission_id: missionId,
    task_id: plan.task_id ?? manifest.task_id,
    base_oid: refreshed.base_oid,
    commit_oid: refreshed.commit_oid,
    tested_tree_oid: refreshed.tested_tree_oid,
    patch_sha256: refreshed.patch_sha256,
    repository_path: artifact.repository,
    patch_path: refreshed.patch_file,
    verification_path: path.join(artifact.root, 'verification.json'),
    verification: refreshed.verification,
    changed_files: refreshed.verification.changed_files,
    changed_lines: refreshed.verification.changed_lines,
    branch: `northset/${missionId.toLowerCase()}-r-${refreshed.commit_oid.slice(0, 12)}`,
    receipt_url: receiptUrl,
    pr_body: reboundPrBody,
  };
  const task = taskFor(plan, next, refreshed.base_oid);
  next.proof = buildProof({task, verification: refreshed.verification, manifest: next});
  return next;
}

/**
 * Build the moved-base recovery callback consumed by publisher.publishBoard.
 * `fetchBase` receives only the new clone, never the approved durable checkout.
 */
export function createStaleRefresher({
  fetchBase,
  artifactRoot = path.resolve('runs/factory/artifacts'),
  run = runBounded,
  invokeWorker = (payload) => invokeBundledWorker(payload, {run}),
} = {}) {
  if (typeof fetchBase !== 'function') throw new TypeError('stale refresher requires fetchBase');
  if (typeof invokeWorker !== 'function') throw new TypeError('stale refresher requires a worker invoker');
  return async function refreshStale(plan, live) {
    let refreshRoot = null;
    try {
      const manifest = manifestFor(plan);
      const missionId = String(plan?.mission_id ?? manifest.mission_id ?? '');
      if (!/^M-[0-9]+$/.test(missionId)) throw new Error('stale refresh requires a valid mission ID');
      const sourceRepository = path.resolve(manifest.repository_path ?? plan.repository_path ?? '');
      await access(sourceRepository);
      const expectedBaseOid = exactOid(live?.current_base_oid, 'live current_base_oid');
      const missionRoot = path.join(path.resolve(artifactRoot), missionId);
      await mkdir(missionRoot, {recursive: true, mode: 0o700});
      refreshRoot = await mkdtemp(path.join(missionRoot, 'refresh-'));
      const repository = path.join(refreshRoot, 'repo');
      await mustRun(run, 'git', ['clone', '--no-local', '--no-checkout', sourceRepository, repository], {
        timeoutMs: 2 * 60_000,
        maxOutputBytes: OUTPUT_LIMIT,
      }, 'clone approved artifact');
      const fetched = await fetchBase(plan, live, {
        repository_path: repository,
        expected_oid: expectedBaseOid,
      });
      const fetchedOid = exactOid(fetched?.base_oid ?? fetched?.oid ?? expectedBaseOid, 'fetched base OID');
      if (fetchedOid !== expectedBaseOid) {
        throw new Error(`fetched base ${fetchedOid} does not match live base ${expectedBaseOid}`);
      }
      await mustRun(run, 'git', ['-C', repository, 'cat-file', '-e', `${expectedBaseOid}^{commit}`], {
        timeoutMs: 30_000,
        maxOutputBytes: OUTPUT_LIMIT,
      }, 'verify fetched base');
      const patchFile = path.join(refreshRoot, 'change.patch');
      const testOnlyPatchFile = path.join(refreshRoot, 'test-only.patch');
      const task = taskFor(plan, manifest, expectedBaseOid);
      const refreshed = await invokeWorker({
        action: 'refresh',
        task,
        checkout: repository,
        plan: {...plan, manifest},
        new_base_oid: expectedBaseOid,
        patch_file: patchFile,
        test_only_patch_file: testOnlyPatchFile,
      });
      for (const [field, value] of [
        ['base_oid', refreshed?.base_oid],
        ['commit_oid', refreshed?.commit_oid],
        ['tested_tree_oid', refreshed?.tested_tree_oid],
      ]) exactOid(value, `refreshed ${field}`);
      if (refreshed.base_oid !== expectedBaseOid) throw new Error('worker verified a different refreshed base');
      if (!/^sha256:[a-f0-9]{64}$/.test(refreshed.patch_sha256 ?? '')) {
        throw new Error('worker returned an invalid refreshed patch digest');
      }
      await Promise.all([access(repository), access(patchFile)]);
      const next = replacementManifest(plan, manifest, {root: refreshRoot, repository}, {
        ...refreshed,
        patch_file: patchFile,
      });
      await writeFile(next.verification_path, `${JSON.stringify(refreshed.verification, null, 2)}\n`, {
        mode: 0o600,
      });
      return {manifest: next};
    } catch (error) {
      if (refreshRoot) await rm(refreshRoot, {recursive: true, force: true});
      return {reason: error.message};
    }
  };
}
