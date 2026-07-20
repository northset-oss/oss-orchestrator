import {boardDigest as computeBoardDigest} from './board.mjs';
import {batchApprovalDigest, canonical, readyItemDigest, sha256} from './db.mjs';
import {verifyReadyArtifacts} from './artifact-integrity.mjs';

const FINAL_SUBMISSION = 'final_submission';

export class PublisherCheckpointError extends Error {
  constructor(message, cause) {
    super(message, {cause});
    this.name = 'PublisherCheckpointError';
    this.code = 'PUBLISHER_CHECKPOINT_FAILED';
  }
}

function value(...items) {
  return items.find((item) => item !== undefined && item !== null);
}

function requiredString(input, label) {
  if (typeof input !== 'string' || !input.trim()) throw new Error(`${label} is required`);
  return input;
}

function jsonList(input) {
  if (Array.isArray(input)) return input;
  if (typeof input !== 'string') return [];
  try {
    const parsed = JSON.parse(input);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizePrBody(input) {
  const normalized = requiredString(input, 'approved PR body')
    .replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(/\s+$/u, '');
  return `${normalized}\n`;
}

function boardItems(board) {
  const items = value(board?.items, board?.board_items, board?.missions);
  if (!Array.isArray(items)) throw new Error('board does not contain immutable items');
  return items;
}

function missionId(item) {
  return value(item?.mission_id, item?.missionId, item?.manifest?.mission_id);
}

function itemDigest(item) {
  return value(item?.item_digest, item?.manifest_sha256, item?.manifest_digest,
    item?.digest, item?.manifest?.manifest_sha256);
}

function approvedMissionIds(approval) {
  return jsonList(value(approval?.approved_mission_ids, approval?.approved_ids,
    approval?.approved_ids_json));
}

function rejectedMissionIds(approval) {
  return jsonList(value(approval?.rejected_mission_ids, approval?.rejected_ids,
    approval?.rejected_ids_json));
}

function manifestDigest(manifest) {
  return sha256(Buffer.from(canonical(manifest), 'utf8'));
}

function verifyStoredApproval(board, approval, expectedBoardDigest) {
  for (const item of boardItems(board)) {
    const manifest = manifestFor(item);
    if (manifestDigest(manifest) !== value(item.manifest_sha256, item.manifest_digest) ||
        readyItemDigest(manifest) !== itemDigest(item)) {
      throw new Error(`${missionId(item) ?? 'board item'} immutable board bytes do not match stored digests`);
    }
  }
  if (computeBoardDigest(boardItems(board)) !== expectedBoardDigest) {
    throw new Error('board digest does not match immutable board contents');
  }
  const computedApproval = batchApprovalDigest({
    boardDigest: expectedBoardDigest,
    approvedMissionIds: approvedMissionIds(approval),
    rejectedMissionIds: rejectedMissionIds(approval),
    approvedBy: value(approval.approved_by, approval.approvedBy),
    approvedAt: value(approval.approved_at, approval.approvedAt),
  });
  if (computedApproval !== value(approval.approval_digest, approval.digest)) {
    throw new Error('approval digest does not match the immutable owner decision');
  }
}

function approvalDigestFor(approval, id) {
  const values = value(approval?.item_digests, approval?.approved_item_digests,
    approval?.manifest_digests, {});
  return values && typeof values === 'object' ? values[id] ?? null : null;
}

function manifestFor(item) {
  return item?.manifest && typeof item.manifest === 'object' ? item.manifest : item;
}

function evidenceAssetFor(snapshot, id, forkRepository, prBranch, patchCommit) {
  const asset = snapshot.evidence_asset;
  if (asset === undefined || asset === null) return null;
  if (typeof asset !== 'object' || Array.isArray(asset)) {
    throw new Error(`${id} evidence_asset must be an object`);
  }
  const repository = requiredString(asset.repository, `${id} evidence_asset.repository`);
  if (repository !== forkRepository) throw new Error(`${id} evidence asset must target the approved fork`);
  const branch = requiredString(asset.branch, `${id} evidence_asset.branch`);
  const commitOid = requiredString(asset.commit_oid, `${id} evidence_asset.commit_oid`);
  if (branch === prBranch) throw new Error(`${id} evidence and PR branches must be distinct`);
  if (commitOid === patchCommit) throw new Error(`${id} evidence and patch commits must be distinct`);
  return {
    repository,
    branch,
    commit_oid: commitOid,
    path: requiredString(asset.path, `${id} evidence_asset.path`),
    sha256: requiredString(asset.sha256, `${id} evidence_asset.sha256`),
    url: requiredString(asset.url, `${id} evidence_asset.url`),
  };
}

function exactPlan(ready, immutable) {
  const manifest = manifestFor(ready);
  const snapshot = manifestFor(immutable);
  const id = requiredString(value(missionId(ready), missionId(immutable)), 'mission_id');
  const repository = requiredString(value(snapshot.repository, snapshot.repo, snapshot.target_repository),
    `${id} repository`);
  const forkRepository = requiredString(value(snapshot.fork_repository, snapshot.fork_repo),
    `${id} fork_repository`);
  const repositoryPath = requiredString(value(snapshot.repository_path, manifest.repository_path),
    `${id} repository_path`);
  const baseBranch = requiredString(snapshot.base_branch, `${id} base_branch`);
  const commitOid = requiredString(value(snapshot.commit_oid, snapshot.patch_commit), `${id} commit_oid`);
  const testedTreeOid = requiredString(snapshot.tested_tree_oid,
    `${id} tested_tree_oid`);
  const patchSha256 = requiredString(snapshot.patch_sha256, `${id} patch_sha256`);
  const title = requiredString(value(snapshot.pr_title, snapshot.title),
    `${id} approved PR title`);
  const body = normalizePrBody(value(snapshot.pr_body, snapshot.body));
  const receiptClaim = value(snapshot.receipt_claim, snapshot.receipt_claim_text);
  if ((typeof receiptClaim !== 'string' || !receiptClaim.trim()) &&
      (!receiptClaim || typeof receiptClaim !== 'object' || Array.isArray(receiptClaim))) {
    throw new Error(`${id} receipt claim is required`);
  }
  const branch = requiredString(value(snapshot.branch, `northset/${id.toLowerCase()}`),
    `${id} branch`);
  const receiptUrl = requiredString(snapshot.receipt_url, `${id} receipt_url`);
  const taskId = requiredString(value(immutable.task_id, snapshot.task_id),
    `${id} task_id`);
  const evidenceAsset = evidenceAssetFor(snapshot, id, forkRepository, branch, commitOid);
  return {
    mission_id: id,
    task_id: taskId,
    repository,
    fork_repository: forkRepository,
    repository_path: repositoryPath,
    base_branch: baseBranch,
    commit_oid: commitOid,
    tested_tree_oid: testedTreeOid,
    patch_sha256: patchSha256,
    pr_title: title,
    pr_body: body,
    receipt_claim: receiptClaim,
    receipt_url: receiptUrl,
    branch,
    evidence_asset: evidenceAsset,
    manifest: snapshot,
  };
}

async function throughSafety(safety, kind, operation, metadata, execute) {
  if (safety?.request) {
    return safety.request({
      priority: FINAL_SUBMISSION,
      kind,
      operation,
      ...metadata,
      execute,
    });
  }
  return execute();
}

function githubMethod(github, name) {
  if (typeof github?.[name] !== 'function') throw new TypeError(`github.${name} is required`);
  return github[name].bind(github);
}

function remoteRequest(safety, github, kind, operation, method, payload) {
  const call = githubMethod(github, method);
  return throughSafety(safety, kind, operation, payload, () => call(payload));
}

function foundBranch(result) {
  if (!result || result.found === false || result.exists === false) return null;
  const oid = value(result.oid, result.commit_oid, result.head_oid, result.object?.sha);
  return typeof oid === 'string' && oid ? {...result, oid} : null;
}

function foundFork(result) {
  return Boolean(result && result.found !== false && result.exists !== false);
}

async function ensureFork(plan, {github, safety, sleep, forkPollAttempts, forkPollIntervalMs}) {
  let fork = await remoteRequest(safety, github, 'read', 'get_fork', 'getFork', {
    repository: plan.fork_repository,
    upstream_repository: plan.repository,
  });
  if (foundFork(fork)) return fork;
  await remoteRequest(safety, github, 'mutation', 'create_fork', 'createFork', {
    repository: plan.fork_repository,
    upstream_repository: plan.repository,
  });
  for (let attempt = 1; attempt <= forkPollAttempts; attempt += 1) {
    fork = await remoteRequest(safety, github, 'read', 'get_fork', 'getFork', {
      repository: plan.fork_repository,
      upstream_repository: plan.repository,
    });
    if (foundFork(fork)) return fork;
    if (attempt < forkPollAttempts) await sleep(forkPollIntervalMs);
  }
  const error = new Error(`fork ${plan.fork_repository} was not readable after creation`);
  error.code = 'FORK_NOT_READY';
  throw error;
}

async function ensureEvidenceAsset(plan, {github, safety}) {
  const asset = plan.evidence_asset;
  if (!asset) return null;
  const branchResult = await remoteRequest(safety, github, 'read', 'get_evidence_branch', 'getBranch', {
    repository: asset.repository,
    upstream_repository: plan.repository,
    branch: asset.branch,
  });
  const existing = foundBranch(branchResult);
  if (existing && existing.oid !== asset.commit_oid) {
    return {
      code: 'REMOTE_EVIDENCE_BRANCH_MISMATCH',
      detail: `remote evidence branch ${asset.branch} points to ${existing.oid}, expected ${asset.commit_oid}`,
    };
  }
  if (!existing) {
    const pushed = await remoteRequest(safety, github, 'git_push', 'push_evidence_branch', 'pushBranch', {
      repository: asset.repository,
      upstream_repository: plan.repository,
      branch: asset.branch,
      oid: asset.commit_oid,
      repository_path: plan.repository_path,
      force: false,
    });
    const pushedOid = value(pushed?.oid, pushed?.commit_oid, asset.commit_oid);
    if (pushedOid !== asset.commit_oid) {
      return {
        code: 'PUSHED_EVIDENCE_OID_MISMATCH',
        detail: `evidence push returned ${pushedOid}, expected ${asset.commit_oid}`,
      };
    }
  }
  return null;
}

function pullRequests(result) {
  if (Array.isArray(result)) return result;
  return value(result?.pull_requests, result?.pullRequests, result?.prs, []);
}

function prFields(pr) {
  if (!pr || typeof pr !== 'object') return null;
  return {
    number: Number(value(pr.number, pr.pr_number)),
    url: value(pr.url, pr.html_url, pr.pr_url),
    repository: value(pr.repository, pr.repo, pr.base_repository),
    base_branch: value(pr.base_branch, pr.baseRefName, pr.base?.ref),
    head_branch: value(pr.head_branch, pr.headRefName, pr.head?.ref),
    head_oid: value(pr.head_oid, pr.headRefOid, pr.head?.sha),
    title: pr.title,
    body: typeof pr.body === 'string' ? normalizePrBody(pr.body) : null,
    state: value(pr.state, pr.status_state),
    merged: pr.merged === true,
  };
}

function exactPr(pr, plan) {
  const fields = prFields(pr);
  return fields !== null && Number.isInteger(fields.number) && fields.number > 0 &&
    fields.repository === plan.repository && fields.base_branch === plan.base_branch &&
    fields.head_branch === plan.branch && fields.head_oid === plan.commit_oid &&
    fields.title === plan.pr_title && fields.body === plan.pr_body;
}

function sameHeadCandidate(pr, plan) {
  const fields = prFields(pr);
  return fields !== null && fields.repository === plan.repository &&
    fields.base_branch === plan.base_branch && fields.head_branch === plan.branch;
}

function isPaused(error) {
  return error?.code === 'GITHUB_PAUSED' || error?.code === 'PUBLISHER_CHECKPOINT_FAILED';
}

async function checkpoint(db, id, patch, label) {
  try {
    return await db.savePublication(id, patch);
  } catch (error) {
    throw new PublisherCheckpointError(`${label} could not be checkpointed`, error);
  }
}

async function failItem(db, plan, code, detail, state = 'FAILED') {
  await db.savePublication(plan.mission_id, {
    mission_id: plan.mission_id,
    task_id: plan.task_id,
    publication_state: state,
    last_error: code,
    last_error_detail: detail,
  });
  await db.updateTaskState(plan.task_id, state === 'SUPERSEDED' ? 'SUPERSEDED' : 'FAILED', detail);
  return {mission_id: plan.mission_id, state, code, detail};
}

function cooldownReason(repositoryState, now) {
  if (!repositoryState) return null;
  const reason = value(repositoryState.cooldown_reason, repositoryState.cooldownReason);
  const until = value(repositoryState.cooldown_until, repositoryState.cooldownUntil);
  if (until === 'manual-release') return reason ?? 'repository cooldown requires manual release';
  if (until) {
    const parsed = Date.parse(until);
    const currentValue = now();
    const current = currentValue instanceof Date ? currentValue.getTime() : Number(currentValue);
    if (!Number.isFinite(parsed) || parsed > current) return reason ?? `repository cooldown until ${until}`;
  }
  if (reason && !until) return reason;
  return null;
}

function openPrCapReached(repositoryState) {
  const open = Number(value(repositoryState?.open_northset_prs, repositoryState?.openNorthsetPrs, 0));
  return Number.isFinite(open) && open >= 1;
}

function receiptFor(result, id) {
  if (!result) return null;
  if (Array.isArray(result)) return result.find((item) => missionId(item) === id) ?? null;
  if (result instanceof Map) return result.get(id) ?? null;
  if (result[id]) return result[id];
  if (missionId(result) === id) return result;
  return null;
}

function timestamp(now) {
  const current = now();
  const date = current instanceof Date ? current : new Date(current);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now() must return a valid time');
  return date.toISOString();
}

async function publishOne(plan, {
  db, github, safety, now, repositoryState, sleep, forkPollAttempts, forkPollIntervalMs,
}) {
  const priorPublication = await db.getPublication(plan.mission_id);
  await ensureFork(plan, {github, safety, sleep, forkPollAttempts, forkPollIntervalMs});
  const evidenceFailure = await ensureEvidenceAsset(plan, {github, safety});
  if (evidenceFailure) {
    return failItem(db, plan, evidenceFailure.code, evidenceFailure.detail);
  }
  const branchResult = await remoteRequest(safety, github, 'read', 'get_branch', 'getBranch', {
    repository: plan.fork_repository,
    upstream_repository: plan.repository,
    branch: plan.branch,
  });
  const existingBranch = foundBranch(branchResult);
  if (existingBranch && existingBranch.oid !== plan.commit_oid) {
    return failItem(db, plan, 'REMOTE_BRANCH_MISMATCH',
      `remote branch ${plan.branch} points to ${existingBranch.oid}, expected ${plan.commit_oid}`);
  }
  if (!existingBranch) {
    const pushed = await remoteRequest(safety, github, 'git_push', 'push_branch', 'pushBranch', {
      repository: plan.fork_repository,
      upstream_repository: plan.repository,
      branch: plan.branch,
      oid: plan.commit_oid,
      repository_path: plan.repository_path,
      force: false,
    });
    const pushedOid = value(pushed?.oid, pushed?.commit_oid, plan.commit_oid);
    if (pushedOid !== plan.commit_oid) {
      return failItem(db, plan, 'PUSHED_OID_MISMATCH',
        `push returned ${pushedOid}, expected ${plan.commit_oid}`);
    }
  }
  await checkpoint(db, plan.mission_id, {
    mission_id: plan.mission_id,
    task_id: plan.task_id,
    branch: plan.branch,
    pushed_oid: plan.commit_oid,
    publication_state: 'BRANCH_PUSHED',
  }, `${plan.mission_id} branch push`);

  const listed = await remoteRequest(safety, github, 'read', 'find_pull_requests', 'findPullRequests', {
    repository: plan.repository,
    fork_repository: plan.fork_repository,
    branch: plan.branch,
    base_branch: plan.base_branch,
  });
  const candidates = pullRequests(listed).filter((pr) => sameHeadCandidate(pr, plan));
  const exact = candidates.filter((pr) => exactPr(pr, plan));
  if (exact.length > 1) {
    return failItem(db, plan, 'AMBIGUOUS_EXISTING_PRS',
      `more than one exact pull request exists for ${plan.branch}`);
  }
  if (candidates.length && exact.length === 0) {
    return failItem(db, plan, 'STORED_PR_MISMATCH',
      `an existing pull request for ${plan.branch} has a different title, body, base, or head`);
  }
  let pullRequest = exact[0] ?? null;
  if (!pullRequest) {
    if (openPrCapReached(repositoryState)) {
      return failItem(db, plan, 'PUBLICATION_REPOSITORY_BLOCKED', 'one-open-PR cap reached');
    }
    pullRequest = await remoteRequest(safety, github, 'pr_create', 'create_pull_request', 'createPullRequest', {
      repository: plan.repository,
      owner: plan.repository.split('/')[0],
      fork_repository: plan.fork_repository,
      branch: plan.branch,
      base_branch: plan.base_branch,
      head_oid: plan.commit_oid,
      title: plan.pr_title,
      body: plan.pr_body,
    });
  }
  const provisional = prFields(pullRequest);
  if (!Number.isInteger(provisional?.number) || provisional.number < 1 || typeof provisional.url !== 'string') {
    return failItem(db, plan, 'PR_CREATE_RESPONSE_INVALID', 'pull request creation/adoption did not return identity');
  }
  await checkpoint(db, plan.mission_id, {
    pr_number: provisional.number,
    pr_url: provisional.url,
    publication_state: 'PR_CHECKPOINTED',
  }, `${plan.mission_id} pull request`);

  const readback = await remoteRequest(safety, github, 'read', 'get_pull_request', 'getPullRequest', {
    repository: plan.repository,
    number: provisional.number,
  });
  if (!exactPr(readback, plan)) {
    return failItem(db, plan, 'STORED_PR_MISMATCH',
      'stored pull request title, body, base, repository, or head does not match the approval');
  }
  const stored = prFields(readback);
  const closed = String(stored.state ?? '').toUpperCase() === 'CLOSED';
  const observedAt = timestamp(now);
  const alreadyCounted = priorPublication?.publication_state === 'SUBMITTED' &&
    Number(priorPublication.pr_number) === stored.number && priorPublication.pr_url === stored.url;
  await checkpoint(db, plan.mission_id, {
    pr_number: stored.number,
    pr_url: stored.url,
    pr_head_oid: stored.head_oid,
    pr_base_branch: stored.base_branch,
    pr_state: closed ? (stored.merged ? 'MERGED' : 'CLOSED') : 'OPEN',
    merged: stored.merged === true,
    outcome_recorded_at: closed ? observedAt : null,
    publication_state: 'SUBMITTED',
    attestation_state: 'ATTESTATION_PENDING',
    status_state: 'PENDING',
    submitted_at: observedAt,
    last_error: null,
    last_error_detail: null,
  }, `${plan.mission_id} submission`);
  await db.updateTaskState(plan.task_id, 'PR_OPENED');
  if (!closed && !alreadyCounted && typeof db.setRepositoryState === 'function') {
    const latest = await db.getRepositoryState(plan.repository) ?? {};
    await db.setRepositoryState(plan.repository, {
      open_northset_prs: Number(latest.open_northset_prs ?? 0) + 1,
      opened_today: Number(latest.opened_today ?? 0) + 1,
      last_pr_at: observedAt,
    });
  }
  return {mission_id: plan.mission_id, state: 'SUBMITTED', pr_number: stored.number, pr_url: stored.url,
    pr_state: closed ? (stored.merged ? 'MERGED' : 'CLOSED') : 'OPEN'};
}

export async function publishBoard(boardDigest, {
  db,
  github,
  safety = null,
  liveRecheck,
  receiptPublisher,
  refreshStale = null,
  artifactVerifier = verifyReadyArtifacts,
  now = () => new Date(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  forkPollAttempts = 15,
  forkPollIntervalMs = 1_000,
} = {}) {
  if (!db) throw new TypeError('db is required');
  if (!github) throw new TypeError('github is required');
  if (!safety || typeof safety.request !== 'function') throw new TypeError('GitHub safety queue is required');
  if (typeof liveRecheck !== 'function') throw new TypeError('liveRecheck is required');
  if (typeof receiptPublisher !== 'function') throw new TypeError('receiptPublisher is required');
  if (typeof sleep !== 'function') throw new TypeError('sleep is required');
  if (!Number.isInteger(forkPollAttempts) || forkPollAttempts < 1) {
    throw new TypeError('forkPollAttempts must be a positive integer');
  }
  if (!Number.isFinite(forkPollIntervalMs) || forkPollIntervalMs < 0) {
    throw new TypeError('forkPollIntervalMs must be a non-negative number');
  }
  const board = await db.getBoard(boardDigest);
  if (!board) throw new Error(`unknown board ${boardDigest}`);
  const actualDigest = value(board.board_digest, board.digest);
  if (actualDigest !== boardDigest) throw new Error('board digest mismatch');
  const approval = await db.getBoardApproval(boardDigest);
  if (!approval) throw new Error('board has no owner approval');
  if (value(approval.board_digest, approval.digest) !== boardDigest) throw new Error('approval board digest mismatch');
  verifyStoredApproval(board, approval, boardDigest);
  const approved = approvedMissionIds(approval);
  if (!approved.length) return {board_digest: boardDigest, results: []};
  const immutableById = new Map(boardItems(board).map((item) => [missionId(item), item]));
  const eligible = [];
  const results = [];

  for (const id of approved) {
    const immutable = immutableById.get(id);
    const ready = await db.getReadyItem(id);
    if (!immutable || !ready) {
      results.push({mission_id: id, state: 'FAILED', code: 'APPROVED_ITEM_MISSING'});
      continue;
    }
    const approvedBoardId = value(board.board_id, board.boardId);
    const currentBoardId = value(ready.board_id, ready.boardId);
    if (approvedBoardId && currentBoardId && approvedBoardId !== currentBoardId) {
      results.push({mission_id: id, state: 'SKIPPED', code: 'APPROVAL_SUPERSEDED',
        detail: `the current READY item belongs to corrected board ${currentBoardId}`});
      continue;
    }
    const priorPublication = await db.getPublication(id);
    if (priorPublication?.publication_state === 'SUPERSEDED') {
      results.push({mission_id: id, state: 'SUPERSEDED', code: 'APPROVAL_TERMINAL',
        detail: 'a superseded mission cannot be published under its previous approval'});
      continue;
    }
    if (value(ready.approval_state, 'APPROVED') !== 'APPROVED') {
      results.push({mission_id: id, state: 'FAILED', code: 'ITEM_NOT_APPROVED'});
      continue;
    }
    let plan;
    try { plan = exactPlan(ready, immutable); }
    catch (error) {
      results.push({mission_id: id, state: 'FAILED', code: 'APPROVED_ITEM_INVALID', detail: error.message});
      continue;
    }
    const immutableDigest = itemDigest(immutable);
    const currentDigest = itemDigest(ready);
    const immutableManifestSha = value(immutable.manifest_sha256, immutable.manifest_digest);
    const currentManifestSha = value(ready.manifest_sha256, ready.manifest_digest);
    const approvedDigest = approvalDigestFor(approval, id);
    if (!immutableDigest || immutableDigest !== currentDigest ||
        !immutableManifestSha || immutableManifestSha !== currentManifestSha ||
        readyItemDigest(manifestFor(ready)) !== currentDigest ||
        manifestDigest(manifestFor(ready)) !== currentManifestSha ||
        (approvedDigest !== null && approvedDigest !== immutableDigest)) {
      results.push(await failItem(db, plan, 'APPROVAL_INVALIDATED',
        'the current READY item no longer matches its immutable approved bytes'));
      continue;
    }
    try {
      artifactVerifier(plan.manifest);
    } catch (error) {
      results.push(await failItem(db, plan, 'ARTIFACT_INTEGRITY_FAILED', error.message));
      continue;
    }
    const repoState = await db.getRepositoryState(plan.repository);
    const blocked = cooldownReason(repoState, now);
    if (blocked) {
      results.push(await failItem(db, plan, 'PUBLICATION_REPOSITORY_BLOCKED', blocked));
      continue;
    }
    eligible.push({...plan, approval_digest: approval.approval_digest});
  }

  const clean = [];
  for (const plan of eligible) {
    try {
      const live = await throughSafety(safety, 'read', 'final_live_recheck', {
        repository: plan.repository,
      }, () => liveRecheck(plan));
      if (live?.cooldown && typeof db.setRepositoryState === 'function') {
        await db.setRepositoryState(plan.repository, {
          cooldown_reason: live.cooldown.reason,
          cooldown_until: live.cooldown.until ?? 'manual-release',
        });
      }
      if (!live?.clean) {
        if (live?.refreshable === true && typeof refreshStale === 'function') {
          const refreshed = await refreshStale(plan, live);
          if (!refreshed?.manifest) {
            results.push({mission_id: plan.mission_id, state: 'READY', code: 'REBASE_FAILED',
              detail: refreshed?.reason ?? 'stale refresh did not produce a verified manifest'});
            continue;
          }
          const ready = await db.replaceReadyManifest(plan.mission_id, refreshed.manifest);
          results.push({mission_id: plan.mission_id, state: 'READY', code: 'REAPPROVAL_REQUIRED',
            manifest_sha256: ready.manifest_sha256});
          continue;
        }
        results.push(await failItem(db, plan, 'STALE_OR_OCCUPIED',
          live?.reason ?? 'final live recheck was not clean', 'SUPERSEDED'));
        continue;
      }
      clean.push({plan, repositoryState: live.repository_state ?? await db.getRepositoryState(plan.repository)});
    } catch (error) {
      if (isPaused(error)) throw error;
      results.push(await failItem(db, plan, error.code ?? 'PUBLICATION_FAILED', error.message));
    }
  }

  if (clean.length) {
    const receipts = await throughSafety(safety, 'git_push', 'publish_receipt_batch', {},
      () => receiptPublisher(clean.map(({plan}) => ({...plan}))));
    for (const {plan} of clean) {
      const receipt = receiptFor(receipts, plan.mission_id);
      if (!receipt) throw new Error(`receipt publisher omitted ${plan.mission_id}`);
      const receiptUrl = requiredString(value(receipt.receipt_url, receipt.url),
        `${plan.mission_id} published receipt URL`);
      if (receiptUrl !== plan.receipt_url) {
        throw new Error(`${plan.mission_id} receipt publisher returned ${receiptUrl}, expected ${plan.receipt_url}`);
      }
      const approvalDigest = requiredString(receipt.batch_approval_digest,
        `${plan.mission_id} receipt batch approval digest`);
      if (approvalDigest !== plan.approval_digest) {
        throw new Error(`${plan.mission_id} receipt binds ${approvalDigest}, expected ${plan.approval_digest}`);
      }
      const proofSha256 = requiredString(receipt.proof_sha256,
        `${plan.mission_id} receipt proof_sha256`);
      if (!/^sha256:[a-f0-9]{64}$/.test(proofSha256)) {
        throw new Error(`${plan.mission_id} receipt proof_sha256 is invalid`);
      }
      const batchCommitOid = requiredString(receipt.batch_commit_oid,
        `${plan.mission_id} receipt batch_commit_oid`);
      if (!/^[a-f0-9]{40}$/.test(batchCommitOid)) {
        throw new Error(`${plan.mission_id} receipt batch_commit_oid is invalid`);
      }
      await db.savePublication(plan.mission_id, {
        mission_id: plan.mission_id,
        task_id: plan.task_id,
        receipt_url: receiptUrl,
        receipt_state: 'PUBLISHED',
        proof_published: true,
        receipt_proof_sha256: proofSha256,
        receipt_batch_commit_oid: batchCommitOid,
        receipt_approval_digest: approvalDigest,
      });
    }
  }

  for (const {plan, repositoryState} of clean) {
    try {
      const live = await throughSafety(safety, 'read', 'final_live_recheck', {
        repository: plan.repository,
      }, () => liveRecheck(plan));
      if (live?.cooldown && typeof db.setRepositoryState === 'function') {
        await db.setRepositoryState(plan.repository, {
          cooldown_reason: live.cooldown.reason,
          cooldown_until: live.cooldown.until ?? 'manual-release',
        });
      }
      if (!live?.clean) {
        if (live?.refreshable === true && typeof refreshStale === 'function') {
          const refreshed = await refreshStale(plan, live);
          if (!refreshed?.manifest) {
            results.push({mission_id: plan.mission_id, state: 'READY', code: 'REBASE_FAILED',
              detail: refreshed?.reason ?? 'stale refresh did not produce a verified manifest'});
            continue;
          }
          const ready = await db.replaceReadyManifest(plan.mission_id, refreshed.manifest);
          results.push({mission_id: plan.mission_id, state: 'READY', code: 'REAPPROVAL_REQUIRED',
            manifest_sha256: ready.manifest_sha256});
          continue;
        }
        results.push(await failItem(db, plan, 'STALE_AFTER_RECEIPT',
          live?.reason ?? 'final live recheck was not clean', 'SUPERSEDED'));
        continue;
      }
      results.push(await publishOne(plan, {
        db, github, safety, now,
        repositoryState,
        sleep,
        forkPollAttempts,
        forkPollIntervalMs,
      }));
    } catch (error) {
      if (isPaused(error)) throw error;
      results.push(await failItem(db, plan, error.code ?? 'PUBLICATION_FAILED', error.message));
    }
  }
  return {board_digest: boardDigest, results};
}

export async function reconcileReceipt(missionIdValue, {
  db,
  attestor,
  statusPublisher,
  now = () => new Date(),
} = {}) {
  if (!db) throw new TypeError('db is required');
  if (typeof attestor !== 'function') throw new TypeError('attestor is required');
  if (typeof statusPublisher !== 'function') throw new TypeError('statusPublisher is required');
  const publication = await db.getPublication(missionIdValue);
  if (!publication || !['SUBMITTED', 'PR_OPENED'].includes(value(publication.publication_state, publication.state))) {
    throw new Error(`${missionIdValue} is not in a recoverable submitted state`);
  }
  let current = publication;
  const ready = typeof db.getReadyItem === 'function' ? await db.getReadyItem(missionIdValue) : null;
  const taskId = value(publication.task_id, ready?.task_id, ready?.manifest?.task_id);
  if (publication.attestation_state !== 'RECEIPT_ATTESTED') {
    try {
      const attestation = await attestor(publication);
      current = await db.savePublication(missionIdValue, {
        attestation_state: 'RECEIPT_ATTESTED',
        attestation_url: value(attestation?.attestation_url, attestation?.url),
        attested_at: value(attestation?.attested_at, timestamp(now)),
        attestation_error: null,
        publication_state: 'SUBMITTED',
        last_error: null,
      });
      if (taskId) await db.updateTaskState(taskId, 'RECEIPT_ATTESTED');
    } catch (error) {
      current = await db.savePublication(missionIdValue, {
        publication_state: 'SUBMITTED',
        attestation_state: 'ATTESTATION_PENDING',
        attestation_error: error.message,
        last_error: `ATTESTATION_PENDING: ${error.message}`,
      });
    }
  }
  try {
    const status = await statusPublisher(current);
    current = await db.savePublication(missionIdValue, {
      publication_state: 'SUBMITTED',
      status_state: 'PUBLISHED',
      status_url: value(status?.status_url, status?.url),
      status_error: null,
      last_error: current.attestation_state === 'ATTESTATION_PENDING' ? current.last_error : null,
    });
  } catch (error) {
    current = await db.savePublication(missionIdValue, {
      publication_state: 'SUBMITTED',
      status_state: 'PENDING',
      status_error: error.message,
      last_error: `STATUS_PENDING: ${error.message}`,
    });
    return {mission_id: missionIdValue, state: 'SUBMITTED', status_state: 'PENDING'};
  }
  return {mission_id: missionIdValue, state: 'SUBMITTED', attestation_state: current.attestation_state,
    status_state: current.status_state};
}
