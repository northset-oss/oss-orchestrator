import {batchApprovalDigest, batchBoardData, canonical, manifestDigest, sha256} from '../../core.mjs';
import {
  bindReviewToManifest,
  reviewableManifestDigest,
  signRecord,
  verifySignedRecord,
} from './integrity.mjs';

function reviewedManifestEntry(manifest) {
  if (!manifest?.mission_id || !/^sha256:[0-9a-f]{64}$/i.test(manifest.review_record_sha256 ?? '') ||
      (!/^reviewer:ed25519:[0-9a-f]{64}$/i.test(manifest.reviewer_id ?? '') &&
       !Array.isArray(manifest.reviewer_ids))) {
    throw new Error('batch approval requires ordered reviewed manifests');
  }
  return {
    mission_id: manifest.mission_id,
    mission_manifest: manifestDigest([manifest]),
    review_record_sha256: manifest.review_record_sha256,
    reviewer_ids: manifest.reviewer_ids ?? [manifest.reviewer_id],
  };
}

function orderedReviews(records) {
  return [...records].sort((left, right) => left.reviewer_id.localeCompare(right.reviewer_id));
}

function reviewSetDigest(records) {
  return sha256(Buffer.from(canonical(orderedReviews(records)), 'utf8'));
}

function normalizeFounderAdjudications(manifests, values = []) {
  if (!Array.isArray(values)) throw new Error('founder adjudications must be an array');
  const byMission = new Map(manifests.map((manifest) => [manifest.mission_id, manifest]));
  const seen = new Set();
  return values.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`founder adjudications[${index}] must be an object`);
    }
    const manifest = byMission.get(value.mission_id);
    if (!manifest) throw new Error('founder adjudication mission is not in the approved batch');
    if (seen.has(value.mission_id)) throw new Error('founder adjudication mission is duplicated');
    seen.add(value.mission_id);
    if (value.review_event_id !== manifest.review_record_sha256) {
      throw new Error('founder adjudication review event does not match the exact reviewed manifest');
    }
    if (value.decision !== 'SHIP') {
      throw new Error('an approved publication batch may contain only SHIP founder adjudications');
    }
    if (typeof value.rationale !== 'string' || value.rationale.length < 1 || value.rationale.length > 2000 ||
        /[\u0000-\u001f\u007f]/.test(value.rationale)) {
      throw new Error('founder adjudication rationale must be 1-2000 characters without control characters');
    }
    return {
      mission_id: value.mission_id,
      review_event_id: value.review_event_id,
      decision: value.decision,
      rationale: value.rationale,
    };
  });
}

export function createReviewRecord(manifest, {
  privateKey, disposition, riskTier, reviewedAt = new Date().toISOString(), findings = [],
} = {}) {
  if (!['SHIP', 'HOLD'].includes(disposition)) throw new Error('review disposition must be SHIP or HOLD');
  if (!['GREEN', 'AMBER'].includes(riskTier)) throw new Error('review risk tier must be GREEN or AMBER');
  return signRecord({
    kind: 'review', mission_id: manifest.mission_id, manifest_digest: reviewableManifestDigest(manifest),
    disposition, risk_tier: riskTier, findings, reviewed_at: reviewedAt,
  }, privateKey);
}

export function bindReviewSet(manifest, records) {
  if (!Array.isArray(records) || !records.length) throw new Error('review set is required');
  const expected = reviewableManifestDigest(manifest);
  const ids = new Set();
  for (const record of records) {
    if (record.kind !== 'review' || record.mission_id !== manifest.mission_id || record.manifest_digest !== expected) {
      throw new Error('review record does not bind the exact manifest');
    }
    if (ids.has(record.reviewer_id)) throw new Error('review set requires distinct reviewer identities');
    ids.add(record.reviewer_id);
  }
  return {...manifest, review_record_sha256: reviewSetDigest(records), reviewer_ids: [...ids].sort()};
}

export function verifyReviewSet(manifest, records, roster, {minimumReviewers = 1, requireShip = true} = {}) {
  const identities = Array.isArray(records) ? records.map((record) => record.reviewer_id) : [];
  const distinct = new Set(identities);
  if (!Array.isArray(records) || distinct.size !== records.length || distinct.size < minimumReviewers) {
    throw new Error(`review set requires ${minimumReviewers === 2 ? 'two distinct' : minimumReviewers} signed reviewers`);
  }
  if (manifest.review_record_sha256 !== reviewSetDigest(records)) throw new Error('review record set digest does not match manifest');
  const expected = reviewableManifestDigest(manifest);
  for (const record of records) {
    const key = roster.get(record.reviewer_id);
    if (!key) throw new Error('reviewer is not in the verified roster');
    verifySignedRecord(record, key);
    if (record.kind !== 'review' || record.mission_id !== manifest.mission_id || record.manifest_digest !== expected) {
      throw new Error('review record does not bind the exact manifest');
    }
    if (!['SHIP', 'HOLD'].includes(record.disposition)) throw new Error('review disposition must be SHIP or HOLD');
    if (requireShip && record.disposition !== 'SHIP') throw new Error('every shipping review disposition must be SHIP');
  }
  const ids = orderedReviews(records).map((record) => record.reviewer_id);
  if (canonical(manifest.reviewer_ids ?? [manifest.reviewer_id]) !== canonical(ids)) {
    throw new Error('manifest reviewer identities do not match signed review set');
  }
  return true;
}

export function createReviewApproval(manifest, {
  privateKey, disposition, riskTier, reviewedAt = new Date().toISOString(), findings = [],
} = {}) {
  const record = createReviewRecord(manifest, {privateKey, disposition, riskTier, reviewedAt, findings});
  return {record, manifest: bindReviewToManifest(manifest, record)};
}

export function createBatchApproval(manifests, {
  privateKey, approvedDigest, approvedAt = new Date().toISOString(), founderAdjudications = [],
} = {}) {
  if (!Array.isArray(manifests) || !manifests.length) throw new Error('batch approval requires manifests');
  if (!/^sha256:[0-9a-f]{64}$/i.test(approvedDigest ?? '')) throw new Error('batch approval digest is invalid');
  return signRecord({
    kind: 'batch_approval',
    approved_manifest_digest: approvedDigest,
    ordered_missions: manifests.map(reviewedManifestEntry),
    founder_adjudications: normalizeFounderAdjudications(manifests, founderAdjudications),
    approved_at: approvedAt,
  }, privateKey);
}

export function verifyBatchApproval(record, manifests, approvedDigest, roster, {authorizedApprovers} = {}) {
  if (record?.kind !== 'batch_approval') throw new Error('signed record is not a batch approval');
  if (record.approved_manifest_digest !== approvedDigest) throw new Error('batch approval digest does not match');
  const publicKey = roster.get(record.reviewer_id);
  if (!publicKey) throw new Error('batch approver is not in the verified roster');
  if (!(authorizedApprovers instanceof Set) || !authorizedApprovers.has(record.reviewer_id)) {
    throw new Error('reviewer is not authorized to approve publication batches');
  }
  verifySignedRecord(record, publicKey);
  const adjudications = normalizeFounderAdjudications(manifests, record.founder_adjudications ?? []);
  if (canonical(record.founder_adjudications ?? []) !== canonical(adjudications)) {
    throw new Error('founder adjudications are not in canonical approved-batch form');
  }
  const expected = manifests.map(reviewedManifestEntry);
  if (canonical(record.ordered_missions) !== canonical(expected)) {
    throw new Error('batch approval ordered reviewed manifests do not match');
  }
  return true;
}

export function finalizeReviewedBoard(board, manifests) {
  const ids = manifests.map((manifest) => manifest.mission_id);
  if (canonical(board?.ordered_mission_ids) !== canonical(ids)) {
    throw new Error('reviewed manifest order does not match the prepared board order');
  }
  const reviewed = manifests.map(reviewedManifestEntry);
  const rebuilt = batchBoardData(manifests);
  return {
    ...board,
    ...rebuilt,
    pre_review_batch_digest: board.batch_digest ?? null,
    batch_digest: batchApprovalDigest(manifests),
    review_status: 'SIGNED_REVIEWS_BOUND',
    reviewed_missions: reviewed,
  };
}

export function verifyReviewedBoard(board, manifests) {
  const expectedData = batchBoardData(manifests);
  const expected = {
    batch_digest: batchApprovalDigest(manifests),
    ordered_mission_ids: manifests.map((manifest) => manifest.mission_id),
    review_status: 'SIGNED_REVIEWS_BOUND',
    reviewed_missions: manifests.map(reviewedManifestEntry),
    ...expectedData,
  };
  const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, board?.[key]]));
  if (canonical(actual) !== canonical(expected)) {
    throw new Error('displayed board content does not match the exact reviewed manifests');
  }
  return true;
}
