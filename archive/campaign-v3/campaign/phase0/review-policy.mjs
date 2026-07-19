import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, readFile, rename, unlink} from 'node:fs/promises';
import path from 'node:path';

import {signedRecordDigest} from './integrity.mjs';

const CONTROL_ID = 'northset-phase0-dual-review-disagreement';
const CONTROL_SCHEMA_VERSION = 1;
const TRAILING_WINDOW = 20;
const PAUSE_ABOVE_DISAGREEMENT_RATE = 0.1;
const GENESIS_HASH = `sha256:${'0'.repeat(64)}`;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REVIEWER_PATTERN = /^reviewer:ed25519:[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function initializationMarker(file) {
  return `${file}.initialized`;
}

async function markerStatus(file) {
  try {
    const value = await readFile(initializationMarker(file), 'utf8');
    if (value !== `${CONTROL_ID}\n`) throw new Error('review control initialization marker is invalid');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureInitializationMarker(file) {
  const marker = initializationMarker(file);
  try {
    const handle = await open(marker, 'wx', 0o600);
    try {
      await handle.writeFile(`${CONTROL_ID}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await markerStatus(file);
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function withoutEventHash(event) {
  const {event_hash: _eventHash, ...unsigned} = event;
  return unsigned;
}

function eventHash(event) {
  return sha256(Buffer.from(canonical(withoutEventHash(event)), 'utf8'));
}

function assertSafeText(value, field, {max = 200, min = 1} = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} must be a ${min}-${max} character string without control characters`);
  }
  return value;
}

function assertDigest(value, field) {
  if (!SHA256_PATTERN.test(value ?? '')) throw new Error(`${field} must be a sha256 digest`);
  return value.toLowerCase();
}

function assertTimestamp(value, field) {
  if (!ISO_TIMESTAMP_PATTERN.test(value ?? '') || new Date(value).toISOString() !== value) {
    throw new Error(`${field} must be a canonical UTC timestamp with milliseconds`);
  }
  return value;
}

function normalizedDisposition(value, field = 'review disposition') {
  if (value === 'SHIP') return 'SHIP';
  if (value === 'HOLD' || value === 'NO_SHIP') return 'NO_SHIP';
  throw new Error(`${field} must be SHIP, HOLD, or NO_SHIP`);
}

function normalizeReview(review, index) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    throw new Error(`reviews[${index}] must be an object`);
  }
  if (!REVIEWER_PATTERN.test(review.reviewer_id ?? '')) {
    throw new Error(`reviews[${index}].reviewer_id is invalid`);
  }
  return {
    reviewer_id: review.reviewer_id.toLowerCase(),
    disposition: normalizedDisposition(review.disposition, `reviews[${index}].disposition`),
    review_record_sha256: assertDigest(review.review_record_sha256, `reviews[${index}].review_record_sha256`),
  };
}

function normalizeDualReview(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('dual-review event must be an object');
  if (!Array.isArray(input.reviews) || input.reviews.length !== 2) {
    throw new Error('dual-review event requires exactly two reviews');
  }
  const reviews = input.reviews.map(normalizeReview).sort((left, right) => left.reviewer_id.localeCompare(right.reviewer_id));
  if (reviews[0].reviewer_id === reviews[1].reviewer_id) {
    throw new Error('dual-review event requires two distinct reviewer identities');
  }
  return {
    event_id: assertDigest(input.review_event_id, 'review_event_id'),
    mission_id: assertSafeText(input.mission_id, 'mission_id'),
    recorded_at: assertTimestamp(input.recorded_at, 'recorded_at'),
    reviews,
    disagreed: reviews[0].disposition !== reviews[1].disposition,
  };
}

function normalizeAdjudication(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('founder adjudication must be an object');
  if (!REVIEWER_PATTERN.test(input.founder_id ?? '')) throw new Error('founder_id must be a key-derived reviewer identity');
  return {
    event_id: assertDigest(input.adjudication_id, 'adjudication_id'),
    review_event_id: assertDigest(input.review_event_id, 'review_event_id'),
    decision: normalizedDisposition(input.decision, 'founder adjudication decision'),
    founder_id: input.founder_id.toLowerCase(),
    authority_record_sha256: assertDigest(input.authority_record_sha256, 'authority_record_sha256'),
    rationale: assertSafeText(input.rationale, 'rationale', {max: 2000}),
    decided_at: assertTimestamp(input.decided_at, 'decided_at'),
  };
}

function emptyReviewControl() {
  return {
    schema_version: CONTROL_SCHEMA_VERSION,
    control_id: CONTROL_ID,
    policy: {
      trailing_window: TRAILING_WINDOW,
      pause_above_disagreement_rate: PAUSE_ABOVE_DISAGREEMENT_RATE,
    },
    event_count: 0,
    head_hash: GENESIS_HASH,
    events: [],
  };
}

function assertStoredDualReview(event) {
  const normalized = normalizeDualReview({
    review_event_id: event.event_id,
    mission_id: event.mission_id,
    recorded_at: event.recorded_at,
    reviews: event.reviews,
  });
  if (event.disagreed !== normalized.disagreed || canonical(event.reviews) !== canonical(normalized.reviews)) {
    throw new Error(`dual-review event ${event.event_id} has invalid derived disagreement data`);
  }
}

function assertStoredAdjudication(event) {
  const normalized = normalizeAdjudication({
    adjudication_id: event.event_id,
    review_event_id: event.review_event_id,
    decision: event.decision,
    founder_id: event.founder_id,
    authority_record_sha256: event.authority_record_sha256,
    rationale: event.rationale,
    decided_at: event.decided_at,
  });
  if (canonical({
    event_id: event.event_id,
    review_event_id: event.review_event_id,
    decision: event.decision,
    founder_id: event.founder_id,
    authority_record_sha256: event.authority_record_sha256,
    rationale: event.rationale,
    decided_at: event.decided_at,
  }) !== canonical(normalized)) {
    throw new Error(`founder adjudication ${event.event_id} is not normalized`);
  }
}

function validateReviewControl(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('review control must be an object');
  if (state.schema_version !== CONTROL_SCHEMA_VERSION || state.control_id !== CONTROL_ID) {
    throw new Error('review control schema or control_id is invalid');
  }
  if (canonical(state.policy) !== canonical({
    trailing_window: TRAILING_WINDOW,
    pause_above_disagreement_rate: PAUSE_ABOVE_DISAGREEMENT_RATE,
  })) throw new Error('review control policy is invalid');
  if (!Array.isArray(state.events) || state.event_count !== state.events.length) {
    throw new Error('review control event_count does not match history');
  }

  let previousHash = GENESIS_HASH;
  const ids = new Set();
  const reviews = new Map();
  const adjudicated = new Set();
  for (let index = 0; index < state.events.length; index += 1) {
    const event = state.events[index];
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error(`review control event ${index + 1} is invalid`);
    if (event.sequence !== index + 1) throw new Error(`review control event ${index + 1} sequence is invalid`);
    if (event.previous_hash !== previousHash) throw new Error(`review control event ${index + 1} previous_hash breaks the chain`);
    if (ids.has(event.event_id)) throw new Error(`review control event id ${event.event_id} is duplicated`);
    if (event.kind === 'DUAL_REVIEW') {
      assertStoredDualReview(event);
      reviews.set(event.event_id, event);
    } else if (event.kind === 'FOUNDER_ADJUDICATION') {
      assertStoredAdjudication(event);
      const review = reviews.get(event.review_event_id);
      if (!review) throw new Error(`founder adjudication ${event.event_id} references an unknown prior review event`);
      if (!review.disagreed) throw new Error(`founder adjudication ${event.event_id} references an agreed review event`);
      if (adjudicated.has(event.review_event_id)) throw new Error(`review event ${event.review_event_id} has multiple adjudications`);
      adjudicated.add(event.review_event_id);
    } else {
      throw new Error(`review control event ${index + 1} kind is invalid`);
    }
    if (!SHA256_PATTERN.test(event.event_hash ?? '') || event.event_hash !== eventHash(event)) {
      throw new Error(`review control event ${index + 1} integrity hash is invalid`);
    }
    ids.add(event.event_id);
    previousHash = event.event_hash;
  }
  if (state.head_hash !== previousHash) throw new Error('review control head_hash does not match history');
  return state;
}

async function atomicWriteJson(file, value) {
  const directory = path.dirname(file);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await ensureInitializationMarker(file);
    await syncDirectory(directory);
    await rename(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch((unlinkError) => {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    });
    throw error;
  }
}

async function withControlLock(file, operation) {
  if (typeof file !== 'string' || !file) throw new Error('stateFile must be a non-empty path');
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const lockFile = `${file}.lock`;
  let lock;
  for (let attempt = 0; attempt < 2 && !lock; attempt += 1) {
    try {
      lock = await open(lockFile, 'wx', 0o600);
      try {
        await lock.writeFile(`${JSON.stringify({
          schema_version: 1,
          pid: process.pid,
          created_at: new Date().toISOString(),
        })}\n`, 'utf8');
        await lock.sync();
      } catch (writeError) {
        await lock.close().catch(() => {});
        lock = null;
        await unlink(lockFile).catch(() => {});
        throw writeError;
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try {
        owner = JSON.parse(await readFile(lockFile, 'utf8'));
      } catch (readError) {
        throw new Error(`review control lock owner cannot be verified: ${lockFile}: ${readError.message}`);
      }
      if (owner?.schema_version !== 1 || !Number.isInteger(owner.pid) || owner.pid < 1 ||
          !ISO_TIMESTAMP_PATTERN.test(owner.created_at ?? '')) {
        throw new Error(`review control lock owner cannot be verified: ${lockFile}`);
      }
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (signalError) {
        if (signalError.code === 'ESRCH') alive = false;
        else if (signalError.code !== 'EPERM') throw signalError;
      }
      if (alive) throw new Error(`review control is locked by another live process ${owner.pid}: ${lockFile}`);
      await unlink(lockFile);
    }
  }
  if (!lock) throw new Error(`review control lock could not be acquired: ${lockFile}`);
  try {
    return await operation();
  } finally {
    await lock.close();
    await unlink(lockFile);
  }
}

function appendEvent(state, payload) {
  const event = {
    sequence: state.events.length + 1,
    kind: payload.kind,
    ...payload.data,
    previous_hash: state.head_hash,
  };
  event.event_hash = eventHash(event);
  state.events.push(event);
  state.event_count = state.events.length;
  state.head_hash = event.event_hash;
  return event;
}

function sameDualReview(existing, normalized) {
  return existing.mission_id === normalized.mission_id &&
    canonical(existing.reviews) === canonical(normalized.reviews) &&
    existing.disagreed === normalized.disagreed;
}

function sameAdjudication(existing, normalized) {
  return existing.review_event_id === normalized.review_event_id &&
    existing.decision === normalized.decision && existing.founder_id === normalized.founder_id &&
    existing.authority_record_sha256 === normalized.authority_record_sha256 &&
    existing.rationale === normalized.rationale && existing.decided_at === normalized.decided_at;
}

export function reviewRequirement({calibration_ordinal, risk_tier, receipt_subject_id}) {
  if (Number.isInteger(calibration_ordinal) && calibration_ordinal >= 1 && calibration_ordinal <= 20) {
    return {minimum_reviewers: 2, reason: 'CALIBRATION'};
  }
  if (risk_tier === 'AMBER') return {minimum_reviewers: 2, reason: 'AMBER'};
  if (risk_tier !== 'GREEN') throw new Error('risk_tier must be GREEN or AMBER');
  if (!/^sha256:[0-9a-f]{2,64}$/i.test(receipt_subject_id ?? '')) throw new Error('receipt_subject_id is invalid');
  const prefix = receipt_subject_id.slice('sha256:'.length).padEnd(4, '0').slice(0, 4);
  const audited = Number.parseInt(prefix, 16) / 0x10000 < 0.05;
  return {minimum_reviewers: audited ? 2 : 1, reason: audited ? 'GREEN_5_PERCENT_AUDIT' : 'GREEN'};
}

export function assertCalibrationState(reviews, {founder_adjudication = null} = {}) {
  if (!Array.isArray(reviews)) throw new Error('reviews must be an array');
  if (reviews.length === 2 && reviews.every((item) => typeof item.ship === 'boolean') &&
      reviews[0].ship !== reviews[1].ship && !founder_adjudication) {
    throw new Error('ship/no-ship disagreement requires founder adjudication before publication');
  }
  const trailing = reviews.slice(-20);
  if (trailing.length === 20) {
    const disagreements = trailing.filter((item) => item.disagreed === true).length;
    if (disagreements / trailing.length > 0.1) throw new Error('trailing review disagreement is >10%; pause and recalibrate');
  }
  return true;
}

export async function loadReviewControl(file) {
  if (typeof file !== 'string' || !file) throw new Error('stateFile must be a non-empty path');
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    const validated = validateReviewControl(state);
    if (!await markerStatus(file)) {
      await ensureInitializationMarker(file);
      await syncDirectory(path.dirname(file));
    }
    return validated;
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (await markerStatus(file)) throw new Error('review control was initialized but its history file is missing');
      return emptyReviewControl();
    }
    throw error;
  }
}

export function evaluateReviewControl(state) {
  validateReviewControl(state);
  const reviewEvents = state.events.filter((event) => event.kind === 'DUAL_REVIEW');
  const adjudicated = new Set(state.events
    .filter((event) => event.kind === 'FOUNDER_ADJUDICATION')
    .map((event) => event.review_event_id));
  const unresolved = reviewEvents
    .filter((event) => event.disagreed && !adjudicated.has(event.event_id))
    .map((event) => event.event_id);
  const trailing = reviewEvents.slice(-TRAILING_WINDOW);
  const disagreements = trailing.filter((event) => event.disagreed).length;
  const rate = trailing.length ? disagreements / trailing.length : null;
  const complete = trailing.length === TRAILING_WINDOW;
  const rampPaused = complete && rate > PAUSE_ABOVE_DISAGREEMENT_RATE;
  const status = rampPaused
    ? 'RAMP_PAUSED_RECALIBRATION_REQUIRED'
    : unresolved.length ? 'FOUNDER_ADJUDICATION_REQUIRED' : 'READY';
  return {
    status,
    publication_allowed: !rampPaused && unresolved.length === 0,
    ramp_paused: rampPaused,
    recalibration_required: rampPaused,
    unresolved_disagreement: unresolved.length > 0,
    unresolved_review_event_ids: unresolved,
    total_dual_reviews: reviewEvents.length,
    trailing_review_count: trailing.length,
    trailing_window_complete: complete,
    trailing_disagreement_count: disagreements,
    trailing_disagreement_rate: rate,
    pause_above_disagreement_rate: PAUSE_ABOVE_DISAGREEMENT_RATE,
  };
}

export function assertReviewControlAllowsPublication(state) {
  const result = evaluateReviewControl(state);
  if (result.ramp_paused) throw new Error('trailing review disagreement is >10%; ramp is paused and recalibration is required');
  if (result.unresolved_disagreement) {
    throw new Error('ship/no-ship disagreement requires founder adjudication before publication');
  }
  return true;
}

export async function appendDualReviewEvent(stateFile, input) {
  const normalized = normalizeDualReview(input);
  return withControlLock(stateFile, async () => {
    const state = await loadReviewControl(stateFile);
    const existing = state.events.find((event) => event.event_id === normalized.event_id);
    if (existing) {
      if (existing.kind !== 'DUAL_REVIEW' || !sameDualReview(existing, normalized)) {
        throw new Error(`review event ${normalized.event_id} is a conflicting replay`);
      }
      const result = evaluateReviewControl(state);
      return {appended: false, event: existing, result, ...result};
    }
    const event = appendEvent(state, {kind: 'DUAL_REVIEW', data: normalized});
    validateReviewControl(state);
    await atomicWriteJson(stateFile, state);
    const result = evaluateReviewControl(state);
    return {appended: true, event, result, ...result};
  });
}

export async function recordDualReviewEvent({
  stateFile, reviewEventId, missionId, signedReviews, recordedAt = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(signedReviews) || signedReviews.length !== 2) {
    throw new Error('signedReviews must contain exactly two signed review records');
  }
  const reviews = signedReviews.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.kind !== 'review' ||
        record.mission_id !== missionId || typeof record.signature !== 'string' || !record.signature) {
      throw new Error(`signedReviews[${index}] is not a signed review record for ${missionId}`);
    }
    return {
      reviewer_id: record.reviewer_id,
      disposition: record.disposition,
      review_record_sha256: signedRecordDigest(record),
    };
  });
  return appendDualReviewEvent(stateFile, {
    review_event_id: reviewEventId,
    mission_id: missionId,
    recorded_at: recordedAt,
    reviews,
  });
}

export async function appendFounderAdjudication(stateFile, input) {
  const normalized = normalizeAdjudication(input);
  return withControlLock(stateFile, async () => {
    const state = await loadReviewControl(stateFile);
    const existing = state.events.find((event) => event.event_id === normalized.event_id);
    if (existing) {
      if (existing.kind !== 'FOUNDER_ADJUDICATION' || !sameAdjudication(existing, normalized)) {
        throw new Error(`founder adjudication ${normalized.event_id} is a conflicting replay`);
      }
      const result = evaluateReviewControl(state);
      return {appended: false, event: existing, result, ...result};
    }
    const review = state.events.find((event) => event.kind === 'DUAL_REVIEW' && event.event_id === normalized.review_event_id);
    if (!review) throw new Error(`founder adjudication references unknown review event ${normalized.review_event_id}`);
    if (!review.disagreed) throw new Error('founder adjudication may resolve only a ship/no-ship disagreement');
    if (state.events.some((event) => event.kind === 'FOUNDER_ADJUDICATION' && event.review_event_id === review.event_id)) {
      throw new Error(`review event ${review.event_id} is already adjudicated`);
    }
    const event = appendEvent(state, {kind: 'FOUNDER_ADJUDICATION', data: normalized});
    validateReviewControl(state);
    await atomicWriteJson(stateFile, state);
    const result = evaluateReviewControl(state);
    return {appended: true, event, result, ...result};
  });
}

export async function recordFounderAdjudication({stateFile, adjudicationId, reviewEventId, decision,
  founderId, authorityRecordSha256, rationale, decidedAt} = {}) {
  return appendFounderAdjudication(stateFile, {
    adjudication_id: adjudicationId,
    review_event_id: reviewEventId,
    decision,
    founder_id: founderId,
    authority_record_sha256: authorityRecordSha256,
    rationale,
    decided_at: decidedAt,
  });
}
