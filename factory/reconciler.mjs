import {appendFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';

import {receiptUrlFor} from './receipt-publisher.mjs';

const RECONCILIATION_PRIORITY = 'reconciliation';
const DEFAULT_ATTESTATION_REPOSITORY = 'northset-oss/verification-pilot';
const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function appendDemandRecord(filePath, object) {
  mkdirSync(path.dirname(filePath), {recursive: true});
  appendFileSync(filePath, `${JSON.stringify(object)}\n`);
}

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
    attestation_state: publication.attestation_state ?? null,
    attestation_url: publication.attestation_url ?? null,
  });
}

function eventTime(event) {
  return event?.submitted_at ?? event?.updated_at ?? event?.created_at ?? null;
}

function latestTime(events) {
  return events.map(eventTime).filter(Boolean).sort().at(-1) ?? null;
}

function humanEvent(event) {
  return Boolean(event?.author_login) && String(event?.author_type ?? '').toLowerCase() !== 'bot' &&
    !/\[bot\]$/i.test(String(event.author_login));
}

function maintainerEvent(event) {
  return MAINTAINER_ASSOCIATIONS.has(event?.author_association) && humanEvent(event);
}

function maintainerText(followUp) {
  const events = [
    ...(followUp?.latest_reviews_by_maintainer ?? []),
    ...(followUp?.maintainer_comments ?? []),
    ...(followUp?.maintainer_thread_comments ?? []),
    ...(followUp?.linked_decision_events ?? []),
  ];
  return events.map((event) => String(event?.body ?? '').trim()).filter(Boolean).join('\n');
}

export function reasonCodeFromFollowUp(followUp) {
  const text = maintainerText(followUp);
  if (!text) return 'unknown';
  const ai = String.raw`(?:ai[- ]generated|artificial intelligence|llms?|chatgpt|claude|coding agents?)`;
  const temporaryAiRejection = new RegExp(
    String.raw`(?:\b${ai}\b[^.\n]{0,120}\b(?:bandwidth|reached (?:its|my|the) end)|\b(?:bandwidth|reached (?:its|my|the) end)\b[^.\n]{0,120}\b${ai}\b)`,
    'i',
  );
  if (temporaryAiRejection.test(text)) return 'ai_rejection';
  const rejectBefore = String.raw`(?:do not|don't|cannot|can't|will not|won't|no longer|prohibit(?:s|ed)?|ban(?:s|ned)?|reject(?:s|ed)?|refus(?:e|es|ed)|avoid)`;
  const rejectAfter = String.raw`(?:not (?:allowed|accepted|welcome|permitted)|prohibited|banned|rejected|refused|unwelcome|policy concern)`;
  const aiPolicyConcern = new RegExp(
    String.raw`(?:\b${rejectBefore}\b[^.\n]{0,120}\b${ai}\b|\b${ai}\b[^.\n]{0,120}\b${rejectAfter}\b)`,
    'i',
  );
  if (aiPolicyConcern.test(text)) {
    return 'ai_policy_concern';
  }
  if (/\b(?:duplicate|already (?:fixed|implemented|covered)|another (?:pr|pull request))\b/i.test(text)) {
    return 'duplicate';
  }
  if (/\b(?:not interested|do not want|don't want|not accepting|please (?:do not|don't) submit|won't accept|will not accept|no need for this)\b/i.test(text)) {
    return 'not_wanted';
  }
  if (/\b(?:incorrect|buggy|tests? (?:fail|failing|missing)|not (?:correct|working)|quality|regression|broken)\b/i.test(text)) {
    return 'quality';
  }
  if (/\b(?:stale|outdated|no longer (?:applies|needed)|already resolved)\b/i.test(text)) return 'stale';
  if (/\b(?:out of scope|too broad|scope creep|unrelated|smaller (?:change|pr)|split (?:this|the) pr)\b/i.test(text)) {
    return 'scope';
  }
  return 'other';
}

function externalHumanEvent(event, author) {
  const login = String(event?.author_login ?? '').toLowerCase();
  return Boolean(author) && humanEvent(event) && login !== author;
}

export function summarizeFollowUp(value) {
  const comments = Array.isArray(value?.comments) ? value.comments : [];
  const reviews = Array.isArray(value?.reviews) ? value.reviews : [];
  const threads = Array.isArray(value?.threads) ? value.threads : [];
  const threadComments = threads.flatMap((thread) => thread.comments ?? []);
  const commentEvents = [...comments, ...threadComments];
  const maintainerReviews = reviews.filter(maintainerEvent);
  const latestByMaintainer = new Map();
  for (const review of [...maintainerReviews].sort((left, right) =>
    String(eventTime(left)).localeCompare(String(eventTime(right))))) {
    latestByMaintainer.set(String(review.author_login).toLowerCase(), review);
  }
  const author = String(value?.author_login ?? '').toLowerCase();
  const allEvents = [...comments, ...reviews, ...threadComments];
  const latestAuthorActivity = latestTime(allEvents.filter((event) =>
    author && String(event?.author_login ?? '').toLowerCase() === author));
  const latestChangeRequest = latestTime(maintainerReviews.filter((review) =>
    review.state === 'CHANGES_REQUESTED'));
  return {
    author_login: value?.author_login ?? null,
    review_decision: value?.review_decision ?? null,
    latest_reviews_by_maintainer: [...latestByMaintainer.values()],
    maintainer_comments: comments.filter(maintainerEvent),
    maintainer_thread_comments: threadComments.filter(maintainerEvent),
    external_comments: commentEvents.filter((event) => externalHumanEvent(event, author)),
    author_comments: comments.filter((event) =>
      author && String(event?.author_login ?? '').toLowerCase() === author),
    unresolved_threads: threads.filter((thread) => thread.is_resolved !== true),
    latest_author_activity_at: latestAuthorActivity,
    latest_maintainer_activity_at: latestTime(allEvents.filter(maintainerEvent)),
    latest_external_activity_at: latestTime(allEvents.filter((event) =>
      externalHumanEvent(event, author))),
    latest_change_request_at: latestChangeRequest,
    author_activity_after_latest_change_request: latestChangeRequest === null ? null
      : latestAuthorActivity !== null && latestAuthorActivity > latestChangeRequest,
    history_truncated: value?.history_truncated === true,
  };
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
  demandDir = 'runs/demand',
  appendDemand = appendDemandRecord,
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
  const recordVerificationProspect = requiredMethod(db, 'recordVerificationProspect', 'db');
  const getPullRequest = requiredMethod(github, 'getPullRequest', 'github');
  const getPullRequestFollowUp = requiredMethod(github, 'getPullRequestFollowUp', 'github');
  const getCommitStatus = requiredMethod(github, 'getCommitStatus', 'github');
  const getArtifactAttestation = attestor === null
    ? requiredMethod(github, 'getArtifactAttestation', 'github') : null;
  if (attestor !== null && typeof attestor !== 'function') throw new TypeError('attestor must be a function');
  if (typeof safety?.request !== 'function') throw new TypeError('safety.request is required');
  if (typeof safety?.releaseRepository !== 'function') throw new TypeError('safety.releaseRepository is required');
  if (typeof statusPublisher !== 'function') throw new TypeError('statusPublisher is required');
  if (typeof appendDemand !== 'function') throw new TypeError('appendDemand must be a function');
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
      let followUp = null;
      let followUpError = null;
      try {
        followUp = summarizeFollowUp(await throughSafety(safety, {
          kind: 'read', operation: 'reconcile_get_pull_request_follow_up', repository, pr_number: prNumber,
          execute: () => getPullRequestFollowUp({repository, number: prNumber}),
        }));
      } catch (error) {
        if (isPaused(error)) throw error;
        followUpError = message(error);
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

      const changesRequested = followUp?.review_decision === 'CHANGES_REQUESTED' ||
        (followUp?.latest_reviews_by_maintainer ?? []).some((review) => review.state === 'CHANGES_REQUESTED');
      const rejected = (prState === 'CLOSED' && publication.merged !== true) || changesRequested;
      const reasonCode = rejected ? reasonCodeFromFollowUp(followUp) : null;
      const verificationProspect = ['ai_policy_concern', 'not_wanted'].includes(reasonCode);
      const demandErrors = [];
      const emitDemand = (file, record) => {
        try { appendDemand(file, record); }
        catch (error) { demandErrors.push(message(error)); }
      };
      if (verificationProspect) {
        await recordVerificationProspect({
          repository,
          owner: repository.split('/')[0],
          reasonCode,
          missionId,
          observedAt: observed,
        });
      }

      if (observation.repository_released) {
        const verification = manifest?.verification ?? {};
        const declaredCheckPassed = verification.ok === true;
        const explicitShadow = manifest?.shadow_acceptance ?? null;
        const wouldRelease = typeof explicitShadow?.would_release === 'boolean'
          ? explicitShadow.would_release : null;
        const bothSides = ['yes', 'no', 'unknown'].includes(explicitShadow?.both_sides_would_accept)
          ? explicitShadow.both_sides_would_accept : 'unknown';
        emitDemand(path.join(demandDir, 'shadow_acceptance.jsonl'), {
          ts: observed,
          mission_id: missionId,
          repo: repository,
          declared_check_passed: declaredCheckPassed,
          would_release: wouldRelease,
          both_sides_would_accept: bothSides,
          human_override: explicitShadow?.human_override === true,
          reason: typeof explicitShadow?.reason === 'string' && explicitShadow.reason.trim()
            ? explicitShadow.reason.trim()
            : 'not_assessed: no pre-agreed payment terms and counterparty responses were recorded',
        });
        if (publication.merged === true) {
          const receiptAvailableBy = publicationBefore.submitted_at ?? null;
          const receiptAt = Date.parse(receiptAvailableBy ?? '');
          const ciAt = Date.parse(commitStatus?.updated_at ?? '');
          const mergedAt = Date.parse(pr.merged_at ?? pr.closed_at ?? observed);
          const noCiRerun = commitStatus?.found !== false && Number.isFinite(ciAt) &&
            Number.isFinite(receiptAt) && ciAt <= receiptAt;
          if (noCiRerun) {
            emitDemand(path.join(demandDir, 'proto_signals.jsonl'), {
              ts: observed,
              mission_id: missionId,
              repo: repository,
              signal: 'merged_without_ci_rerun',
              evidence: {
                ci_found: commitStatus?.found !== false,
                ci_updated_at: commitStatus?.updated_at ?? null,
                receipt_available_by: receiptAvailableBy,
              },
              confidence: 'low',
            });
          }
          const followUpText = maintainerText(followUp);
          if (/\b(?:receipt|verification proof)\b|verification-pilot\/receipts\//i.test(followUpText)) {
            emitDemand(path.join(demandDir, 'proto_signals.jsonl'), {
              ts: observed,
              mission_id: missionId,
              repo: repository,
              signal: 'maintainer_cited_receipt',
              evidence: followUpText.slice(0, 500),
              confidence: 'high',
            });
          }
          if (Number.isFinite(receiptAt) && Number.isFinite(mergedAt) &&
              mergedAt >= receiptAt && mergedAt - receiptAt <= 24 * 60 * 60_000) {
            emitDemand(path.join(demandDir, 'proto_signals.jsonl'), {
              ts: observed,
              mission_id: missionId,
              repo: repository,
              signal: 'fast_merge_after_receipt',
              evidence: {receipt_available_by: receiptAvailableBy, merged_at: pr.merged_at ?? observed},
              confidence: 'med',
            });
          }
        }
      }

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

      if (publication.last_error !== null || publication.last_error_detail !== null) {
        publication = await db.savePublication(missionId, {
          last_error: null,
          last_error_detail: null,
        }, {now: observed});
      }

      const factsChanged = statusFacts(publicationBefore) !== statusFacts(publication);
      if (publicationBefore.status_state !== 'PUBLISHED' || factsChanged) {
        pendingStatuses.push({missionId, observed, item: statusItem(publication, observed, mergeCommitOid)});
      }
      results.push({
        mission_id: missionId,
        pr_url: publication.pr_url,
        pr_head_oid: publication.pr_head_oid,
        pr_state: publication.pr_state,
        merged: publication.merged,
        ci_state: publication.ci_state,
        attestation_state: publication.attestation_state,
        status_state: publication.status_state,
        follow_up: followUp,
        follow_up_error: followUpError,
        reason_code: reasonCode,
        verification_prospect: verificationProspect,
        demand_errors: demandErrors,
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
