import {createHash, createPublicKey, sign, verify} from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function publicKeyFor(value) {
  if (value?.type === 'public') return value;
  return createPublicKey(value);
}

export function reviewerIdFromPublicKey(publicKey) {
  const der = publicKeyFor(publicKey).export({type: 'spki', format: 'der'});
  return `reviewer:ed25519:${createHash('sha256').update(der).digest('hex')}`;
}

function unsignedRecord(record) {
  const {signature: _signature, ...unsigned} = record;
  return unsigned;
}

export function signRecord(payload, privateKey, _untrusted = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('signed payload must be an object');
  const publicKey = createPublicKey(privateKey);
  const unsigned = {schema_version: 1, ...payload, reviewer_id: reviewerIdFromPublicKey(publicKey)};
  const signature = sign(null, Buffer.from(canonical(unsigned), 'utf8'), privateKey).toString('base64');
  return {...unsigned, signature};
}

export function verifySignedRecord(record, publicKey) {
  if (record?.reviewer_id !== reviewerIdFromPublicKey(publicKey) || typeof record.signature !== 'string') {
    throw new Error('signed record reviewer identity does not match the verified key');
  }
  const valid = verify(null, Buffer.from(canonical(unsignedRecord(record)), 'utf8'), publicKey, Buffer.from(record.signature, 'base64'));
  if (!valid) throw new Error('signed record signature is invalid');
  return true;
}

export function signedRecordDigest(record) {
  return digest(Buffer.from(canonical(record), 'utf8'));
}

export function reviewableManifestDigest(manifest) {
  const {review_record_sha256: _digest, reviewer_id: _reviewer, reviewer_ids: _reviewers, ...reviewable} = manifest;
  return digest(Buffer.from(canonical(reviewable), 'utf8'));
}

export function bindReviewToManifest(manifest, record) {
  if (record.kind !== 'review' || record.mission_id !== manifest.mission_id) throw new Error('review record does not match the manifest mission');
  if (record.manifest_digest !== reviewableManifestDigest(manifest)) throw new Error('review record does not bind the exact manifest bytes');
  return {...manifest, review_record_sha256: signedRecordDigest(record), reviewer_id: record.reviewer_id};
}

export function verifyManifestReview(manifest, record, roster) {
  if (manifest.review_record_sha256 !== signedRecordDigest(record) || manifest.reviewer_id !== record.reviewer_id) {
    throw new Error('manifest review record binding is invalid');
  }
  const key = roster.get(record.reviewer_id);
  if (!key) throw new Error('reviewer is not in the verified roster');
  verifySignedRecord(record, key);
  const {review_record_sha256: _digest, reviewer_id: _reviewer, reviewer_ids: _reviewers, ...reviewable} = manifest;
  if (record.manifest_digest !== reviewableManifestDigest(reviewable)) throw new Error('review record does not bind the exact manifest');
  return true;
}
