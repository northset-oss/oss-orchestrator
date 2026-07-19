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

function approvalDigestFor(approval, id) {
  const values = value(approval?.item_digests, approval?.approved_item_digests,
    approval?.manifest_digests, {});
  return values && typeof values === 'object' ? values[id] ?? null : null;
}

function manifestFor(item) {
  return item?.manifest && typeof item.manifest === 'object' ? item.manifest : item;
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

async function publishOne(plan, {db, github, safety, now, repositoryState}) {
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
  await checkpoint(db, plan.mission_id, {
    pr_number: stored.number,
    pr_url: stored.url,
    pr_head_oid: stored.head_oid,
    pr_base_branch: stored.base_branch,
    publication_state: 'SUBMITTED',
    attestation_state: 'ATTESTATION_PENDING',
    submitted_at: timestamp(now),
    last_error: null,
    last_error_detail: null,
  }, `${plan.mission_id} submission`);
  await db.updateTaskState(plan.task_id, 'PR_OPENED');
  if (typeof db.setRepositoryState === 'function') {
    const latest = await db.getRepositoryState(plan.repository) ?? {};
    await db.setRepositoryState(plan.repository, {
      open_northset_prs: Number(latest.open_northset_prs ?? 0) + 1,
      opened_today: Number(latest.opened_today ?? 0) + 1,
      last_pr_at: timestamp(now),
    });
  }
  return {mission_id: plan.mission_id, state: 'SUBMITTED', pr_number: stored.number, pr_url: stored.url};
}

export async function publishBoard(boardDigest, {
  db,
  github,
  safety = null,
  liveRecheck,
  receiptPublisher,
  now = () => new Date(),
} = {}) {
  if (!db) throw new TypeError('db is required');
  if (!github) throw new TypeError('github is required');
  if (!safety || typeof safety.request !== 'function') throw new TypeError('GitHub safety queue is required');
  if (typeof liveRecheck !== 'function') throw new TypeError('liveRecheck is required');
  if (typeof receiptPublisher !== 'function') throw new TypeError('receiptPublisher is required');
  const board = await db.getBoard(boardDigest);
  if (!board) throw new Error(`unknown board ${boardDigest}`);
  const actualDigest = value(board.board_digest, board.digest);
  if (actualDigest !== boardDigest) throw new Error('board digest mismatch');
  const approval = await db.getBoardApproval(boardDigest);
  if (!approval) throw new Error('board has no owner approval');
  if (value(approval.board_digest, approval.digest) !== boardDigest) throw new Error('approval board digest mismatch');
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
        (approvedDigest !== null && approvedDigest !== immutableDigest)) {
      results.push(await failItem(db, plan, 'APPROVAL_INVALIDATED',
        'the current READY item no longer matches its immutable approved bytes'));
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

  if (eligible.length) {
    const receipts = await throughSafety(safety, 'git_push', 'publish_receipt_batch', {},
      () => receiptPublisher(eligible.map((plan) => ({...plan}))));
    for (const plan of eligible) {
      const receipt = receiptFor(receipts, plan.mission_id);
      if (!receipt) throw new Error(`receipt publisher omitted ${plan.mission_id}`);
      const receiptUrl = requiredString(value(receipt.receipt_url, receipt.url),
        `${plan.mission_id} published receipt URL`);
      if (receiptUrl !== plan.receipt_url) {
        throw new Error(`${plan.mission_id} receipt publisher returned ${receiptUrl}, expected ${plan.receipt_url}`);
      }
      await db.savePublication(plan.mission_id, {
        mission_id: plan.mission_id,
        task_id: plan.task_id,
        receipt_url: receiptUrl,
        receipt_state: 'PUBLISHED',
        proof_published: true,
      });
    }
  }

  for (const plan of eligible) {
    try {
      const live = await throughSafety(safety, 'read', 'final_live_recheck', {
        repository: plan.repository,
      }, () => liveRecheck(plan));
      if (!live?.clean) {
        results.push(await failItem(db, plan, 'STALE_OR_OCCUPIED',
          live?.reason ?? 'final live recheck was not clean', 'SUPERSEDED'));
        continue;
      }
      results.push(await publishOne(plan, {
        db, github, safety, now,
        repositoryState: live.repository_state ?? await db.getRepositoryState(plan.repository),
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
      return {mission_id: missionIdValue, state: 'SUBMITTED', attestation_state: 'ATTESTATION_PENDING'};
    }
  }
  try {
    const status = await statusPublisher(current);
    current = await db.savePublication(missionIdValue, {
      publication_state: 'SUBMITTED',
      status_state: 'PUBLISHED',
      status_url: value(status?.status_url, status?.url),
      status_error: null,
      last_error: null,
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
