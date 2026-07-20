import {receiptUrlFor} from './receipt-publisher.mjs';

const RECONCILIATION_PRIORITY = 'reconciliation';
const DEFAULT_ATTESTATION_REPOSITORY = 'northset-oss/verification-pilot';

function requiredMethod(value, name, label) {
  if (typeof value?.[name] !== 'function') throw new TypeError(`${label}.${name} is required`);
  return value[name].bind(value);
}

function isPaused(error) {
  return error?.code === 'GITHUB_PAUSED' || error?.name === 'GitHubPausedError';
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now() must return a valid time');
  return date.toISOString();
}

function observedAt(pr, publication, now) {
  return pr.updated_at ?? pr.merged_at ?? pr.closed_at ?? pr.created_at ??
    publication.submitted_at ?? timestamp(now());
}

function normalizedPrState(pr) {
  if (pr.merged === true || pr.merged_at) return 'MERGED';
  const state = String(pr.state ?? '').toUpperCase();
  if (!['OPEN', 'CLOSED'].includes(state)) throw new Error(`unsupported pull request state ${JSON.stringify(pr.state)}`);
  return state;
}

function statusFacts(publication) {
  return JSON.stringify({
    pr_head_oid: publication.pr_head_oid ?? null,
    pr_state: publication.pr_state ?? null,
    merged: publication.merged === true,
    ci_state: publication.ci_state ?? null,
    attestation_state: publication.attestation_state ?? null,
    attestation_url: publication.attestation_url ?? null,
  });
}

async function throughSafety(safety, request) {
  return safety.request({priority: RECONCILIATION_PRIORITY, ...request});
}

async function saveFailure(db, missionId, code, error, now) {
  return db.savePublication(missionId, {
    last_error: `${code}: ${message(error)}`,
    last_error_detail: message(error),
  }, {now});
}

function statusItem(publication, observed, mergeCommitOid = null) {
  const commitOid = publication.pushed_oid ?? publication.pr_head_oid;
  return {
    mission_id: publication.mission_id,
    commit_oid: commitOid,
    pr_head_oid: publication.pr_head_oid ?? commitOid,
    merge_commit_oid: mergeCommitOid,
    pr_number: publication.pr_number,
    receipt_url: receiptUrlFor(publication.mission_id, commitOid),
    pr_url: publication.pr_url,
    pr_state: publication.pr_state,
    merged: publication.merged === true,
    ci_state: publication.ci_state ?? null,
    attestation_state: publication.attestation_state,
    attestation_url: publication.attestation_url ?? null,
    observed_at: observed,
  };
}

/**
 * Reconcile a bounded set of already-submitted receipts. This code can only read
 * GitHub and update the receipt status branch; it never creates or closes a PR.
 */
export async function reconcilePublicationBatch({
  db,
  github,
  safety,
  statusPublisher,
  attestor = null,
  attestationRepository = DEFAULT_ATTESTATION_REPOSITORY,
  limit = 30,
  now = () => new Date(),
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new TypeError('reconciliation limit must be an integer from 1 through 1000');
  }
  const listCandidates = requiredMethod(db, 'listReconciliationCandidates', 'db');
  const getReadyItem = requiredMethod(db, 'getReadyItem', 'db');
  const getPublication = requiredMethod(db, 'getPublication', 'db');
  requiredMethod(db, 'savePublication', 'db');
  const updateTaskState = requiredMethod(db, 'updateTaskState', 'db');
  const recordObservation = requiredMethod(db, 'recordPublicationObservation', 'db');
  const getPullRequest = requiredMethod(github, 'getPullRequest', 'github');
  const getCommitStatus = requiredMethod(github, 'getCommitStatus', 'github');
  const getArtifactAttestation = attestor === null
    ? requiredMethod(github, 'getArtifactAttestation', 'github') : null;
  if (attestor !== null && typeof attestor !== 'function') throw new TypeError('attestor must be a function');
  if (typeof safety?.request !== 'function') throw new TypeError('safety.request is required');
  if (typeof safety?.releaseRepository !== 'function') throw new TypeError('safety.releaseRepository is required');
  if (typeof statusPublisher !== 'function') throw new TypeError('statusPublisher is required');
  if (typeof attestationRepository !== 'string' || !attestationRepository.includes('/')) {
    throw new TypeError('attestationRepository must be owner/name');
  }

  const candidates = await listCandidates({limit});
  const pendingStatuses = [];
  const results = [];

  for (const candidate of candidates) {
    const missionId = candidate.mission_id;
    try {
      const publicationBefore = await getPublication(missionId) ?? candidate;
      const ready = await getReadyItem(missionId);
      const manifest = ready?.manifest ?? ready;
      const repository = manifest?.repository ?? manifest?.repo;
      if (typeof repository !== 'string' || !repository.includes('/')) {
        throw Object.assign(new Error('approved manifest has no repository owner/name'),
          {code: 'RECONCILIATION_MANIFEST_INVALID'});
      }
      const prNumber = Number(publicationBefore.pr_number);
      if (!Number.isInteger(prNumber) || prNumber < 1) {
        throw Object.assign(new Error('submitted publication has no PR number'),
          {code: 'RECONCILIATION_PUBLICATION_INVALID'});
      }

      const pr = await throughSafety(safety, {
        kind: 'read', operation: 'reconcile_get_pull_request', repository, pr_number: prNumber,
        execute: () => getPullRequest({repository, number: prNumber}),
      });
      const returnedNumber = Number(pr?.number ?? pr?.pr_number);
      if (returnedNumber !== prNumber) {
        throw Object.assign(new Error(`pull request number changed from ${prNumber} to ${returnedNumber}`),
          {code: 'RECONCILIATION_PR_MISMATCH'});
      }
      const returnedRepository = pr.repository ?? pr.repo ?? pr.base_repository;
      if (returnedRepository && returnedRepository.toLowerCase() !== repository.toLowerCase()) {
        throw Object.assign(new Error(`pull request repository changed to ${returnedRepository}`),
          {code: 'RECONCILIATION_PR_MISMATCH'});
      }
      const expectedHead = publicationBefore.pushed_oid ?? publicationBefore.pr_head_oid;
      const returnedHead = pr.head_oid ?? pr.head_sha ?? pr.head?.sha;
      if (!expectedHead || !returnedHead) {
        throw Object.assign(new Error(`pull request head does not match stored head ${expectedHead ?? '(missing)'}`),
          {code: 'RECONCILIATION_PR_HEAD_MISMATCH'});
      }
      const prState = normalizedPrState(pr);
      const headDrift = returnedHead.toLowerCase() !== expectedHead.toLowerCase();
      if (headDrift) {
        if (prState !== 'MERGED') {
          throw Object.assign(new Error(`pull request head does not match stored head ${expectedHead}`),
            {code: 'RECONCILIATION_PR_HEAD_MISMATCH'});
        }
        const getPullRequestCommits = requiredMethod(github, 'getPullRequestCommits', 'github');
        const commitList = await throughSafety(safety, {
          kind: 'read', operation: 'reconcile_get_pull_request_commits', repository, pr_number: prNumber,
          execute: () => getPullRequestCommits({repository, number: prNumber}),
        });
        const commits = Array.isArray(commitList) ? commitList : commitList?.commits;
        if (!Array.isArray(commits) || !commits.some((oid) =>
          String(oid).toLowerCase() === expectedHead.toLowerCase())) {
          throw Object.assign(new Error('merged pull request no longer contains the attested contribution commit'),
            {code: 'RECONCILIATION_CONTRIBUTION_MISSING'});
        }
      }
      const mergeCommitOid = prState === 'MERGED'
        ? pr.merge_commit_oid ?? pr.merge_commit_sha ?? null : null;
      if (prState === 'MERGED' && !mergeCommitOid) {
        throw Object.assign(new Error('merged pull request has no merge commit OID'),
          {code: 'RECONCILIATION_MERGE_COMMIT_MISSING'});
      }

      const commitStatus = await throughSafety(safety, {
        kind: 'read', operation: 'reconcile_get_commit_status', repository, oid: returnedHead,
        execute: () => getCommitStatus({repository, oid: returnedHead}),
      });
      const observed = observedAt(pr, publicationBefore, now);
      const observation = await recordObservation(missionId, {
        repository,
        prState,
        merged: pr.merged === true || Boolean(pr.merged_at),
        ciState: commitStatus?.found === false ? null : commitStatus?.state ?? null,
        prHeadOid: returnedHead.toLowerCase(),
        observedAt: observed,
      });
      let publication = observation.publication;
      if (observation.repository_released) await safety.releaseRepository(repository);

      if (publication.attestation_state !== 'RECEIPT_ATTESTED') {
        try {
          const attestation = await throughSafety(safety, {
            kind: 'read', operation: 'reconcile_get_attestation',
            repository: attestationRepository,
            subject_digest: publication.receipt_proof_sha256,
            execute: () => attestor
              ? attestor(publication, {ready, repository: attestationRepository})
              : getArtifactAttestation({
                repository: attestationRepository,
                subject_digest: publication.receipt_proof_sha256,
              }),
          });
          const found = attestation?.found !== false &&
            Boolean(attestation?.attestation_url ?? attestation?.url);
          publication = await db.savePublication(missionId, found ? {
            attestation_state: 'RECEIPT_ATTESTED',
            attestation_url: attestation.attestation_url ?? attestation.url,
            attested_at: attestation.attested_at ?? observed,
            attestation_error: null,
            last_error: null,
            last_error_detail: null,
          } : {
            attestation_state: 'ATTESTATION_PENDING',
            attestation_url: null,
            attested_at: null,
            attestation_error: null,
          }, {now: observed});
          if (found && publication.task_id) {
            await updateTaskState(publication.task_id, 'RECEIPT_ATTESTED', null, {now: observed});
          }
        } catch (error) {
          if (isPaused(error)) throw error;
          publication = await db.savePublication(missionId, {
            attestation_state: 'ATTESTATION_PENDING',
            attestation_error: message(error),
            last_error: `ATTESTATION_PENDING: ${message(error)}`,
            last_error_detail: message(error),
          }, {now: observed});
        }
      }

      const factsChanged = statusFacts(publicationBefore) !== statusFacts(publication);
      if (publicationBefore.status_state !== 'PUBLISHED' || factsChanged) {
        pendingStatuses.push({missionId, observed, item: statusItem(publication, observed, mergeCommitOid)});
      }
      results.push({
        mission_id: missionId,
        pr_state: publication.pr_state,
        merged: publication.merged,
        ci_state: publication.ci_state,
        attestation_state: publication.attestation_state,
        status_state: publication.status_state,
      });
    } catch (error) {
      if (isPaused(error)) throw error;
      const code = error?.code ?? 'RECONCILIATION_FAILED';
      await saveFailure(db, missionId, code, error, now());
      results.push({mission_id: missionId, state: 'PENDING', code, error: message(error)});
    }
  }

  if (pendingStatuses.length) {
    try {
      const published = await throughSafety(safety, {
        kind: 'git_push', operation: 'publish_receipt_status_batch',
        mission_ids: pendingStatuses.map((entry) => entry.missionId),
        execute: () => statusPublisher(pendingStatuses.map((entry) => entry.item)),
      });
      for (const pending of pendingStatuses) {
        const status = published?.[pending.missionId];
        if (!status?.status_url) throw new Error(`status publisher omitted ${pending.missionId}`);
        await db.savePublication(pending.missionId, {
          status_state: 'PUBLISHED',
          status_url: status.status_url,
          status_error: null,
        }, {now: pending.observed});
        const result = results.find((entry) => entry.mission_id === pending.missionId);
        if (result) result.status_state = 'PUBLISHED';
      }
    } catch (error) {
      for (const pending of pendingStatuses) {
        await db.savePublication(pending.missionId, {
          status_state: 'PENDING',
          status_error: message(error),
          last_error: `STATUS_PENDING: ${message(error)}`,
          last_error_detail: message(error),
        }, {now: pending.observed});
        const result = results.find((entry) => entry.mission_id === pending.missionId);
        if (result) result.status_state = 'PENDING';
      }
      if (isPaused(error)) throw error;
    }
  }

  return {processed: candidates.length, results};
}

export function createReconciler(dependencies = {}) {
  return (options = {}) => reconcilePublicationBatch({...dependencies, ...options});
}
