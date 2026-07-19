import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bindReviewSet,
  createBatchApproval,
  createReviewRecord,
  verifyBatchApproval,
} from './approvals.mjs';
import {reviewerIdFromPublicKey, signedRecordDigest} from './integrity.mjs';
import {loadReviewControl} from './review-policy.mjs';
import {
  assertReadySubjectReviewBinding,
  enforceReviewControlBeforePublication,
  phase0ReviewControlFileForBatch,
} from '../../ship.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;

function keyPair() {
  return generateKeyPairSync('ed25519');
}

function fixture({dispositions = ['SHIP', 'SHIP'], founderAdjudications = []} = {}) {
  const founder = keyPair();
  const second = keyPair();
  const base = {
    schema_version: 2,
    mission_id: 'M-901',
    patch_sha256: digest('a'),
    risk_flags: [],
    calibration_ordinal: 1,
  };
  const reviewRecords = [founder, second].map((pair, index) => createReviewRecord(base, {
    privateKey: pair.privateKey,
    disposition: dispositions[index],
    riskTier: 'GREEN',
    reviewedAt: `2026-07-17T12:0${index}:00.000Z`,
  }));
  const manifest = bindReviewSet(base, reviewRecords);
  const approvedDigest = digest('c');
  const signedBatchApproval = createBatchApproval([manifest], {
    privateKey: founder.privateKey,
    approvedDigest,
    approvedAt: '2026-07-17T12:05:00.000Z',
    founderAdjudications: founderAdjudications.map((value) => ({
      mission_id: manifest.mission_id,
      review_event_id: manifest.review_record_sha256,
      decision: 'SHIP',
      ...value,
    })),
  });
  const founderId = reviewerIdFromPublicKey(founder.publicKey);
  const roster = new Map([
    [founderId, founder.publicKey],
    [reviewerIdFromPublicKey(second.publicKey), second.publicKey],
  ]);
  verifyBatchApproval(signedBatchApproval, [manifest], approvedDigest, roster, {
    authorizedApprovers: new Set([founderId]),
  });
  const subject = {
    spec: {schema_version: 2, mission_id: manifest.mission_id},
    manifest,
    reviewRecords,
    missionDir: '/rehearsal/M-901',
  };
  assertReadySubjectReviewBinding(subject, roster);
  return {subject, signedBatchApproval};
}

async function controlFile(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-ship-review-control-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return path.join(root, 'review-control.json');
}

test('production review history is canonical across caller-selected runs directories', () => {
  const first = phase0ReviewControlFileForBatch([{missionDir: '/tmp/run-a/M-001'}]);
  const second = phase0ReviewControlFileForBatch([{missionDir: '/tmp/run-b/M-001'}]);
  assert.equal(first, second);
  assert.equal(first, path.resolve(import.meta.dirname, '../..', 'runs/phase0/review-control.json'));
});

test('ship preflight durably records a disagreement and blocks before founder adjudication', async (t) => {
  const stateFile = await controlFile(t);
  const {subject, signedBatchApproval} = fixture({dispositions: ['SHIP', 'HOLD']});

  await assert.rejects(() => enforceReviewControlBeforePublication([subject], signedBatchApproval, {stateFile}),
    /founder adjudication/i);
  const state = await loadReviewControl(stateFile);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].kind, 'DUAL_REVIEW');
  assert.equal(state.events[0].disagreed, true);
});

test('verified signed batch approval resolves the exact disagreement with an authority digest', async (t) => {
  const stateFile = await controlFile(t);
  const {subject, signedBatchApproval} = fixture({
    dispositions: ['SHIP', 'HOLD'],
    founderAdjudications: [{rationale: 'The bounded concern does not block this exact publication.'}],
  });

  const result = await enforceReviewControlBeforePublication([subject], signedBatchApproval, {stateFile});
  assert.equal(result.publication_allowed, true);
  const state = await loadReviewControl(stateFile);
  assert.equal(state.events.length, 2);
  assert.equal(state.events[1].kind, 'FOUNDER_ADJUDICATION');
  assert.equal(state.events[1].authority_record_sha256, signedRecordDigest(signedBatchApproval));
  assert.equal(state.events[1].founder_id, signedBatchApproval.reviewer_id);
});

test('two HOLD dispositions remain unshippable even though they do not disagree', async (t) => {
  const stateFile = await controlFile(t);
  const {subject, signedBatchApproval} = fixture({dispositions: ['HOLD', 'HOLD']});
  await assert.rejects(() => enforceReviewControlBeforePublication([subject], signedBatchApproval, {stateFile}),
    /all signed reviews.*HOLD/i);
});

test('founder adjudication cannot be attached to a unanimous SHIP review set', async (t) => {
  const stateFile = await controlFile(t);
  const {subject, signedBatchApproval} = fixture({
    dispositions: ['SHIP', 'SHIP'],
    founderAdjudications: [{rationale: 'There is no disagreement to adjudicate.'}],
  });
  await assert.rejects(() => enforceReviewControlBeforePublication([subject], signedBatchApproval, {stateFile}),
    /does not match a ship.*hold disagreement/i);
});

test('invalid extra adjudication is rejected before any durable write and cannot poison a corrected approval', async (t) => {
  const stateFile = await controlFile(t);
  const founder = keyPair();
  const second = keyPair();
  const roster = new Map([
    [reviewerIdFromPublicKey(founder.publicKey), founder.publicKey],
    [reviewerIdFromPublicKey(second.publicKey), second.publicKey],
  ]);
  const makeSubject = (missionId, dispositions) => {
    const base = {schema_version: 2, mission_id: missionId, patch_sha256: digest('a'), risk_flags: [], calibration_ordinal: 1};
    const reviewRecords = [founder, second].map((pair, index) => createReviewRecord(base, {
      privateKey: pair.privateKey,
      disposition: dispositions[index],
      riskTier: 'GREEN',
      reviewedAt: `2026-07-17T12:0${index}:00.000Z`,
    }));
    const manifest = bindReviewSet(base, reviewRecords);
    return {spec: {schema_version: 2, mission_id: missionId}, manifest, reviewRecords, missionDir: `/rehearsal/${missionId}`};
  };
  const mixed = makeSubject('M-903', ['SHIP', 'HOLD']);
  const agreed = makeSubject('M-904', ['SHIP', 'SHIP']);
  for (const subject of [mixed, agreed]) assertReadySubjectReviewBinding(subject, roster);
  const adjudication = (subject, rationale) => ({
    mission_id: subject.manifest.mission_id,
    review_event_id: subject.manifest.review_record_sha256,
    decision: 'SHIP',
    rationale,
  });
  const invalid = createBatchApproval([mixed.manifest, agreed.manifest], {
    privateKey: founder.privateKey,
    approvedDigest: digest('c'),
    approvedAt: '2026-07-17T12:05:00.000Z',
    founderAdjudications: [
      adjudication(mixed, 'The bounded concern does not block this exact publication.'),
      adjudication(agreed, 'This extra adjudication is invalid because the reviews agree.'),
    ],
  });
  await assert.rejects(() => enforceReviewControlBeforePublication([mixed, agreed], invalid, {stateFile}),
    /does not match a ship.*hold disagreement/i);
  assert.equal((await loadReviewControl(stateFile)).events.length, 0);

  const corrected = createBatchApproval([mixed.manifest, agreed.manifest], {
    privateKey: founder.privateKey,
    approvedDigest: digest('c'),
    approvedAt: '2026-07-17T12:06:00.000Z',
    founderAdjudications: [adjudication(mixed, 'The bounded concern does not block this exact publication.')],
  });
  assert.equal((await enforceReviewControlBeforePublication([mixed, agreed], corrected, {stateFile})).publication_allowed, true);
});

test('partially adjudicated disputed batch records disagreements but no founder event before rejection', async (t) => {
  const stateFile = await controlFile(t);
  const founder = keyPair();
  const second = keyPair();
  const makeSubject = (missionId) => {
    const base = {schema_version: 2, mission_id: missionId, patch_sha256: digest('a'), risk_flags: [], calibration_ordinal: 1};
    const reviewRecords = [founder, second].map((pair, index) => createReviewRecord(base, {
      privateKey: pair.privateKey,
      disposition: index === 0 ? 'SHIP' : 'HOLD',
      riskTier: 'GREEN',
      reviewedAt: `2026-07-17T12:0${index}:00.000Z`,
    }));
    const manifest = bindReviewSet(base, reviewRecords);
    return {spec: {schema_version: 2, mission_id: missionId}, manifest, reviewRecords, missionDir: `/rehearsal/${missionId}`};
  };
  const subjects = [makeSubject('M-905'), makeSubject('M-906')];
  const adjudication = (subject) => ({
    mission_id: subject.manifest.mission_id,
    review_event_id: subject.manifest.review_record_sha256,
    decision: 'SHIP',
    rationale: 'The bounded concern does not block this exact publication.',
  });
  const partial = createBatchApproval(subjects.map((subject) => subject.manifest), {
    privateKey: founder.privateKey,
    approvedDigest: digest('c'),
    approvedAt: '2026-07-17T12:05:00.000Z',
    founderAdjudications: [adjudication(subjects[0])],
  });
  await assert.rejects(() => enforceReviewControlBeforePublication(subjects, partial, {stateFile}), /founder adjudication/i);
  const afterPartial = await loadReviewControl(stateFile);
  assert.equal(afterPartial.events.filter((event) => event.kind === 'DUAL_REVIEW').length, 2);
  assert.equal(afterPartial.events.filter((event) => event.kind === 'FOUNDER_ADJUDICATION').length, 0);

  const corrected = createBatchApproval(subjects.map((subject) => subject.manifest), {
    privateKey: founder.privateKey,
    approvedDigest: digest('c'),
    approvedAt: '2026-07-17T12:06:00.000Z',
    founderAdjudications: subjects.map(adjudication),
  });
  assert.equal((await enforceReviewControlBeforePublication(subjects, corrected, {stateFile})).publication_allowed, true);
});
