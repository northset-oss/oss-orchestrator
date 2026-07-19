import assert from 'node:assert/strict';
import {access, mkdtemp, readFile, rm, unlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendDualReviewEvent,
  appendFounderAdjudication,
  assertReviewControlAllowsPublication,
  evaluateReviewControl,
  loadReviewControl,
  recordDualReviewEvent,
} from './review-policy.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const indexedDigest = (index) => `sha256:${index.toString(16).padStart(64, '0')}`;
const reviewer = (character) => `reviewer:ed25519:${character.repeat(64)}`;

function dualReview(index, {disagreed = false} = {}) {
  const left = (index % 10).toString(16);
  const right = ((index + 1) % 10).toString(16);
  return {
    review_event_id: indexedDigest(index + 1),
    mission_id: `M-${String(index).padStart(3, '0')}`,
    recorded_at: `2026-07-17T12:${String(index).padStart(2, '0')}:00.000Z`,
    reviews: [
      {reviewer_id: reviewer('a'), disposition: 'SHIP', review_record_sha256: digest(left)},
      {reviewer_id: reviewer('b'), disposition: disagreed ? 'HOLD' : 'SHIP', review_record_sha256: digest(right)},
    ],
  };
}

async function temporaryControl(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-review-control-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return path.join(root, 'review-control.json');
}

test('durable review control persists and duplicate review-event replay is idempotent', async (t) => {
  const file = await temporaryControl(t);
  const event = dualReview(1, {disagreed: true});

  const first = await appendDualReviewEvent(file, event);
  const duplicate = await appendDualReviewEvent(file, event);
  const reloaded = await loadReviewControl(file);

  assert.equal(first.appended, true);
  assert.equal(duplicate.appended, false);
  assert.equal(reloaded.events.length, 1);
  assert.equal(reloaded.events[0].disagreed, true);
  assert.deepEqual(duplicate.result.unresolved_review_event_ids, [event.review_event_id]);
  assert.throws(() => assertReviewControlAllowsPublication(reloaded), /founder adjudication/i);
});

test('shipping API derives durable disagreement from two signed review records', async (t) => {
  const stateFile = await temporaryControl(t);
  const missionId = 'M-SIGNED';
  const common = {schema_version: 1, kind: 'review', mission_id: missionId,
    manifest_digest: digest('9'), risk_tier: 'AMBER', reviewed_at: '2026-07-17T12:00:00.000Z'};
  const signedReviews = [
    {...common, reviewer_id: reviewer('a'), disposition: 'SHIP', findings: [], signature: 'first-signature'},
    {...common, reviewer_id: reviewer('b'), disposition: 'HOLD', findings: ['blocker'], signature: 'second-signature'},
  ];
  const result = await recordDualReviewEvent({
    stateFile, reviewEventId: digest('8'), missionId, signedReviews,
    recordedAt: '2026-07-17T12:05:00.000Z',
  });

  assert.equal(result.appended, true);
  assert.equal(result.unresolved_disagreement, true);
  assert.equal(result.publication_allowed, false);
  assert.equal(result.trailing_review_count, 1);
  assert.match(result.event.reviews[0].review_record_sha256, /^sha256:[0-9a-f]{64}$/);
});

test('same review-event id with different review content is rejected as a conflicting replay', async (t) => {
  const file = await temporaryControl(t);
  const event = dualReview(2);
  await appendDualReviewEvent(file, event);

  await assert.rejects(() => appendDualReviewEvent(file, {
    ...event,
    reviews: [event.reviews[0], {...event.reviews[1], disposition: 'HOLD'}],
  }), /conflicting replay/i);
});

test('integrity validation detects mutated or wrongly chained on-disk history', async (t) => {
  const file = await temporaryControl(t);
  await appendDualReviewEvent(file, dualReview(3));
  await appendDualReviewEvent(file, dualReview(4));

  const mutated = JSON.parse(await readFile(file, 'utf8'));
  mutated.events[0].reviews[0].disposition = 'NO_SHIP';
  await writeFile(file, `${JSON.stringify(mutated, null, 2)}\n`);
  await assert.rejects(() => loadReviewControl(file), /invalid derived|integrity|hash/i);

  const wrongChain = JSON.parse(await readFile(file, 'utf8'));
  wrongChain.events[0].reviews[0].disposition = 'SHIP';
  wrongChain.events[1].previous_hash = digest('f');
  await writeFile(file, `${JSON.stringify(wrongChain, null, 2)}\n`);
  await assert.rejects(() => loadReviewControl(file), /chain|previous_hash/i);
});

test('initialized review control fails closed if its history file is deleted', async (t) => {
  const file = await temporaryControl(t);
  await appendDualReviewEvent(file, dualReview(9));
  await unlink(file);
  await assert.rejects(() => loadReviewControl(file), /initialized.*missing|missing.*initialized/i);
});

test('valid legacy review history backfills the fail-closed initialization marker', async (t) => {
  const file = await temporaryControl(t);
  await appendDualReviewEvent(file, dualReview(10));
  await unlink(`${file}.initialized`);
  assert.equal((await loadReviewControl(file)).events.length, 1);
  await access(`${file}.initialized`);
  await unlink(file);
  await assert.rejects(() => loadReviewControl(file), /initialized.*missing|missing.*initialized/i);
});

test('review control reclaims only a demonstrably dead lock owner', async (t) => {
  const file = await temporaryControl(t);
  await writeFile(`${file}.lock`, `${JSON.stringify({
    schema_version: 1,
    pid: 99_999_999,
    created_at: '2026-07-17T12:00:00.000Z',
  })}\n`);
  assert.equal((await appendDualReviewEvent(file, dualReview(11))).appended, true);
  await assert.rejects(() => access(`${file}.lock`), /ENOENT/);

  await writeFile(`${file}.lock`, `${JSON.stringify({
    schema_version: 1,
    pid: process.pid,
    created_at: new Date().toISOString(),
  })}\n`);
  await assert.rejects(() => appendDualReviewEvent(file, dualReview(12)), /live process|another writer/i);
  await access(`${file}.lock`);
});

test('exactly 2 of trailing 20 does not pause, while 3 of trailing 20 requires recalibration', async (t) => {
  const twoFile = await temporaryControl(t);
  const threeFile = await temporaryControl(t);

  for (let index = 0; index < 20; index += 1) {
    await appendDualReviewEvent(twoFile, dualReview(index + 10, {disagreed: index < 2}));
    await appendDualReviewEvent(threeFile, dualReview(index + 40, {disagreed: index < 3}));
  }

  const atThreshold = evaluateReviewControl(await loadReviewControl(twoFile));
  const overThreshold = evaluateReviewControl(await loadReviewControl(threeFile));
  assert.equal(atThreshold.trailing_disagreement_count, 2);
  assert.equal(atThreshold.trailing_disagreement_rate, 0.1);
  assert.equal(atThreshold.ramp_paused, false);
  assert.equal(atThreshold.recalibration_required, false);
  assert.equal(overThreshold.trailing_disagreement_count, 3);
  assert.equal(overThreshold.trailing_disagreement_rate, 0.15);
  assert.equal(overThreshold.ramp_paused, true);
  assert.equal(overThreshold.recalibration_required, true);
  assert.equal(overThreshold.status, 'RAMP_PAUSED_RECALIBRATION_REQUIRED');
});

test('founder adjudication resolves publication block but disagreement remains in calibration rate', async (t) => {
  const file = await temporaryControl(t);
  const event = dualReview(7, {disagreed: true});
  await appendDualReviewEvent(file, event);

  const adjudication = {
    adjudication_id: digest('e'),
    review_event_id: event.review_event_id,
    decision: 'SHIP',
    founder_id: reviewer('f'),
    authority_record_sha256: digest('a'),
    rationale: 'The bounded finding does not block this publication.',
    decided_at: '2026-07-17T13:00:00.000Z',
  };
  const resolved = await appendFounderAdjudication(file, adjudication);
  const duplicate = await appendFounderAdjudication(file, adjudication);
  const reloaded = await loadReviewControl(file);
  const result = evaluateReviewControl(reloaded);

  assert.equal(resolved.appended, true);
  assert.equal(duplicate.appended, false);
  assert.equal(reloaded.events.length, 2);
  assert.deepEqual(result.unresolved_review_event_ids, []);
  assert.equal(result.trailing_disagreement_count, 1);
  assert.equal(result.publication_allowed, true);
  assert.equal(assertReviewControlAllowsPublication(reloaded), true);
});

test('review and adjudication inputs fail closed', async (t) => {
  const file = await temporaryControl(t);
  const event = dualReview(8, {disagreed: true});
  await assert.rejects(() => appendDualReviewEvent(file, {
    ...event,
    reviews: [event.reviews[0], {...event.reviews[0]}],
  }), /distinct reviewer/i);
  await appendDualReviewEvent(file, event);
  await assert.rejects(() => appendFounderAdjudication(file, {
    adjudication_id: digest('d'), review_event_id: digest('f'), decision: 'SHIP',
    founder_id: reviewer('f'), authority_record_sha256: digest('a'),
    rationale: 'No matching event.', decided_at: '2026-07-17T13:00:00.000Z',
  }), /unknown review event/i);
  await assert.rejects(() => appendFounderAdjudication(file, {
    adjudication_id: digest('c'), review_event_id: event.review_event_id, decision: 'MAYBE',
    founder_id: reviewer('f'), authority_record_sha256: digest('a'),
    rationale: 'Invalid decision.', decided_at: '2026-07-17T13:00:00.000Z',
  }), /decision/i);
  await assert.rejects(() => appendFounderAdjudication(file, {
    adjudication_id: digest('b'), review_event_id: event.review_event_id, decision: 'SHIP',
    founder_id: reviewer('f'), rationale: 'Missing signed authority digest.', decided_at: '2026-07-17T13:00:00.000Z',
  }), /authority_record_sha256/i);
});
