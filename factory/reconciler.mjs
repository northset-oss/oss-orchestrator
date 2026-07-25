import {receiptUrlFor} from './receipt-publisher.mjs';
import {normalizeConsentScopes} from './publication-policy.mjs';

const RECONCILIATION_PRIORITY = 'reconciliation';
const DEFAULT_ATTESTATION_REPOSITORY = 'northset-oss/verification-pilot';
const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

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
  const ai = String.raw`(?:ai(?:[- ](?:generated|assisted))?|generative ai|artificial intelligence|llms?|chatgpt|claude|coding agents?)`;
  const strongPolicyObjection = new RegExp(
    String.raw`\b${ai}\b[^.!?\n]{0,180}\b(?:ci policy|repository (?:policy|checks)|contribution policy)\b[^.!?\n]{0,100}\b(?:prohibit(?:s|ed)?|reject(?:s|ed)?|forbid(?:s|den)?|disallow(?:s|ed)?)\b`,
    'i',
  );
  if (strongPolicyObjection.test(text)) return 'ai_policy_concern';
  const policyText = text
    .split(/\n|(?<=[.!?])\s+/u)
    .filter((fragment) => {
      const action = String.raw`(?:(?:cannot|can't|will not|won't)\s+|(?:do not|don't)\s+(?:want\s+to\s+)?)(?:accept|merge|take)`;
      const quality = String.raw`(?:tests?|ci|checks?|lint|build|disclosure)`;
      const condition = String.raw`(?:until|unless|while|because|before|due to|when|without)`;
      const qualityCondition = new RegExp(
        String.raw`(?:\b${action}\b[^.!?\n]{0,180}\b${condition}\b[^.!?\n]{0,120}\b${quality}\b|\b${quality}\b[^.!?\n]{0,120}\b${action}\b[^.!?\n]{0,120}\b(?:ai|llm|chatgpt|claude)\b)`,
        'i',
      );
      const separatedQuality = new RegExp(
        String.raw`\b${action}\b[^.!?\n]{0,160}\b${ai}\b[^.!?\n]{0,80}(?:;|\u2014|\s-\s)[^.!?\n]{0,100}\b${quality}\b`,
        'i',
      );
      const temporaryReview = /\b(?:cannot|can't|will not|won't)\s+review\b[^.!?\n]{0,160}\b(?:until|before|after)\b[^.!?\n]{0,100}\b(?:week|time|date|available|back)\b/i;
      return !qualityCondition.test(fragment) && !separatedQuality.test(fragment) &&
        !temporaryReview.test(fragment);
    })
    .join('\n');
  const temporaryAiRejection = new RegExp(
    String.raw`(?:\b${ai}\b[^.\n]{0,120}\b(?:bandwidth|reached (?:its|my|the) end)|\b(?:bandwidth|reached (?:its|my|the) end)\b[^.\n]{0,120}\b${ai}\b)`,
    'i',
  );
  if (temporaryAiRejection.test(text)) return 'ai_rejection';
  const rejectAction = String.raw`(?:accept|allow|permit|welcome|merge|take)(?!\s+(?:the\s+)?(?:claim|idea|argument|notion)\b)`;
  const rejectBefore = String.raw`(?:(?:do(?:es)? not|don't|doesn't|cannot|can't|not able to|unable to|will not|won't|no longer)\s+${rejectAction}|prohibit(?:s|ed)?|ban(?:s|ned)?|reject(?:s|ed)?(?!\s+(?:the\s+)?(?:claim|idea|argument|notion)\b)|refus(?:e|es|ed)|avoid)`;
  const rejectAfter = String.raw`(?:not (?:allowed|accepted|welcome|permitted)|prohibited|forbidden|disallowed|banned|rejected|refused|unwelcome|policy concern|will be (?:closed|rejected))`;
  const withoutContrast = String.raw`(?:(?!\bbut\b)[^.\n]){0,120}`;
  const aiPolicyConcern = new RegExp(
    String.raw`(?:\b${rejectBefore}\b${withoutContrast}\b${ai}\b|\b${ai}\b${withoutContrast}\b${rejectAfter}\b|(?:^|[.!?\n]\s*)no[- ]${ai}\s+(?:contributions?|submissions?|patches?|pull requests?|prs?|changes?)\b|\b(?:have|maintain|enforce|under)\s+(?:a\s+)?no[- ]ai\s+policy\b)`,
    'i',
  );
  if (aiPolicyConcern.test(policyText)) {
    return 'ai_policy_concern';
  }
  if (/\b(?:duplicate|already (?:fixed|implemented|covered)|another (?:pr|pull request))\b/i.test(text)) {
    return 'duplicate';
  }
  if (/\b(?:not interested|do not want|don't want|not accepting|please (?:do not|don't) submit|won't accept|will not accept|no need for this)\b/i.test(policyText)) {
    return 'not_wanted';
  }
  if (/\b(?:incorrect|buggy|tests? (?:(?:are|is) )?(?:fail|failing|missing|pass|passing)|failing tests?|ci (?:is )?(?:fail(?:ing)?|red)|passing checks?|checks? (?:pass|passing|required)|not (?:correct|working)|quality|regression|broken)\b/i.test(text)) {
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

function statusItem(publication, observed, mergeCommitOid = null, commitStatus = null) {
  const commitOid = publication.pushed_oid ?? publication.pr_head_oid;
  const hasConclusiveRecord = Array.isArray(commitStatus?.required_runs);
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
    current_pr_state: publication.pr_state,
    current_merged: publication.merged === true,
    ci_state: hasConclusiveRecord ? publication.ci_state ?? null : null,
    ...(hasConclusiveRecord ? {ci_observation: {
      state: commitStatus.state,
      observed_at: commitStatus.observed_at ?? observed,
      required_runs: commitStatus.required_runs,
    }} : {}),
    attestation_state: publication.attestation_state,
    attestation_url: publication.attestation_url ?? null,
    observed_at: observed,
  };
}

function publicReceiptReconciliation(manifest, publication) {
  const hasPolicyFields = manifest?.receipt_visibility !== undefined ||
    manifest?.consent_scopes !== undefined;
  if (!hasPolicyFields) {
    return typeof publication?.receipt_url === 'string' && publication.receipt_url.length > 0 &&
      /^sha256:[a-f0-9]{64}$/u.test(String(publication.receipt_proof_sha256 ?? ''));
  }
  if (manifest?.receipt_visibility !== 'public_opt_in' ||
      manifest?.consent_scopes?.schema_version !== 2 ||
      manifest?.consent_scopes?.mission_id !== publication?.mission_id) return false;
  try {
    return normalizeConsentScopes(manifest.consent_scopes, {
      missionId: publication.mission_id,
    }).scopes.receipt_publication_consent.status === 'granted';
  } catch {
    return false;
  }
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
  const recordInteractionBlock = requiredMethod(db, 'recordInteractionBlock', 'db');
  const getPullRequest = requiredMethod(github, 'getPullRequest', 'github');
  const getPullRequestFollowUp = requiredMethod(github, 'getPullRequestFollowUp', 'github');
  const getCommitStatus = requiredMethod(github, 'getCommitStatus', 'github');
  if (attestor !== null && typeof attestor !== 'function') throw new TypeError('attestor must be a function');
  if (typeof safety?.request !== 'function') throw new TypeError('safety.request is required');
  if (typeof safety?.releaseRepository !== 'function') throw new TypeError('safety.releaseRepository is required');
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
      const classifiedReason = reasonCodeFromFollowUp(followUp);
      const interactionBlocked = ['ai_policy_concern', 'ai_rejection', 'not_wanted']
        .includes(classifiedReason);
      const reasonCode = rejected || interactionBlocked ? classifiedReason : null;
      if (interactionBlocked) {
        const exactReason = maintainerText(followUp).trim() ||
          `Maintainer rejection classified as ${reasonCode}`;
        await recordInteractionBlock({
          scope: 'repository',
          subject: repository,
          blockAuthoring: true,
          blockOutreach: true,
          reason: exactReason.slice(0, 2_000),
          reasonCode,
          sourceUrl: pr.url ?? publication.pr_url ?? null,
          missionId,
          createdAt: observed,
        });
      }

      const publicReceipt = publicReceiptReconciliation(manifest, publication);
      if (!publicReceipt) {
        if (publication.last_error !== null || publication.last_error_detail !== null) {
          publication = await db.savePublication(missionId, {
            last_error: null,
            last_error_detail: null,
          }, {now: observed});
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
          receipt_visibility: manifest?.receipt_visibility ?? 'private_internal',
          follow_up: followUp,
          follow_up_error: followUpError,
          reason_code: reasonCode,
          interaction_blocked: interactionBlocked,
        });
        continue;
      }

      if (publication.attestation_state !== 'RECEIPT_ATTESTED') {
        try {
          const getArtifactAttestation = attestor === null
            ? requiredMethod(github, 'getArtifactAttestation', 'github') : null;
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
        pendingStatuses.push({
          missionId,
          observed,
          item: statusItem(publication, observed, mergeCommitOid, commitStatus),
        });
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
        interaction_blocked: interactionBlocked,
      });
    } catch (error) {
      if (isPaused(error)) throw error;
      const code = error?.code ?? 'RECONCILIATION_FAILED';
      await saveFailure(db, missionId, code, error, now());
      results.push({mission_id: missionId, state: 'PENDING', code, error: message(error)});
    }
  }

  if (pendingStatuses.length) {
    if (typeof statusPublisher !== 'function') throw new TypeError('statusPublisher is required');
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
