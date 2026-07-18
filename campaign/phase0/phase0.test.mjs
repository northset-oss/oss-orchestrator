import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp, readFile, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertProspectiveAmendment,
  loadProtocol,
  protocolFreezeRecord,
  validateProtocol,
  verifyProtocolFreeze,
} from './protocol.mjs';
import {
  CampaignCounter,
  receiptSubjectId,
} from './counters.mjs';
import {
  bindReviewToManifest,
  reviewableManifestDigest,
  reviewerIdFromPublicKey,
  signRecord,
  verifyManifestReview,
  verifySignedRecord,
} from './integrity.mjs';
import {
  assertTaskResourcePolicy,
  assertPhase0Spec,
  clearPersistentProviderThrottle,
  isProviderThrottle,
  loadResourceControl,
  remainingTaskLaneMs,
  ResourceBreakers,
  resourceUsageForTask,
  trustedModelProviderErrorFromCodexJsonl,
  tripPersistentProviderThrottle,
} from './resource-breakers.mjs';
import {
  assertCalibrationState,
  reviewRequirement,
} from './review-policy.mjs';
import {
  createHandoff,
  confirmHandoff,
  verifyHandoff,
} from './handoff.mjs';
import {
  provisionReviewerKey,
} from './keys.mjs';
import {
  bindReviewSet,
  createBatchApproval,
  createReviewApproval,
  createReviewRecord,
  finalizeReviewedBoard,
  verifyReviewedBoard,
  verifyBatchApproval,
  verifyReviewSet,
} from './approvals.mjs';
import {loadReviewerRoster} from './roster.mjs';

const subject = (overrides = {}) => ({
  schema_version: 1,
  variant: 'author_contribution',
  repository_node_id: 'R_kgDOExample',
  pr_number: 42,
  tested_oid: '1'.repeat(40),
  policy_digest: `sha256:${'2'.repeat(64)}`,
  test_mode: 'readonly',
  ...overrides,
});

function keyPair() {
  return generateKeyPairSync('ed25519');
}

test('frozen protocol contains every Phase 0 preregistration decision and rejects retroactive amendments', async () => {
  const protocol = await loadProtocol();
  assert.equal(validateProtocol(protocol), true);
  assert.deepEqual(protocol.units_of_analysis, ['invocation', 'receipt_subject', 'mission_attempt', 'cohort']);
  assert.equal(protocol.counting.subject_identity_fields.length, 7);
  assert.equal(protocol.social_gates['15_to_30'].minimum_positive_constructive, 3);
  assert.equal(protocol.goal_mix.external_unique_receipts_target, 1000);
  assert.equal(protocol.cost_allocation.rate_card_is_observed_expense, false);
  assert.equal(protocol.open_outcome_censoring.silence_is_acceptance, false);
  assert.throws(() => assertProspectiveAmendment(protocol, {
    version: '1.0.1',
    effective_at: '2026-07-16T00:00:00Z',
    decided_at: '2026-07-17T00:00:00Z',
  }), /prospective/i);
});

test('protocol freeze signature binds the exact protocol bytes and verified key roster', async () => {
  const protocol = await loadProtocol();
  const signer = keyPair();
  const record = protocolFreezeRecord(protocol, signer.privateKey);
  const signerId = reviewerIdFromPublicKey(signer.publicKey);
  assert.equal(verifyProtocolFreeze(protocol, record, new Map([[signerId, signer.publicKey]])), true);
  assert.throws(() => verifyProtocolFreeze({...protocol, goal_mix: {...protocol.goal_mix,
    external_unique_receipts_target: 999}}, record, new Map([[signerId, signer.publicKey]])), /digest/i);
});

test('receipt subject identity is typed, stable, and changes only with a bound subject field', () => {
  const first = receiptSubjectId(subject());
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(receiptSubjectId({...subject()}), first);
  assert.notEqual(receiptSubjectId(subject({tested_oid: '3'.repeat(40)})), first);
  assert.throws(() => receiptSubjectId(subject({pr_number: '42'})), /pr_number/i);
});

test('typed counters dedupe double publication and same-head reruns', () => {
  const counter = new CampaignCounter();
  const common = {invocation_id: 'inv-1', subject: subject(), authorization: 'NORTHSET_AUTHORED'};
  assert.equal(counter.record({...common, outcome: 'A_SHIPPED_PUBLIC'}).receipt_increment, 1);
  assert.equal(counter.record({...common, invocation_id: 'inv-2', outcome: 'A_SHIPPED_PUBLIC'}).receipt_increment, 0);
  assert.equal(counter.record({...common, invocation_id: 'inv-3', outcome: 'A_SHIPPED_PUBLIC'}).receipt_increment, 0);
  assert.equal(counter.snapshot().buckets.A_SHIPPED_PUBLIC, 1);
});

test('typed counters move private verification to public without double counting', () => {
  const counter = new CampaignCounter();
  const common = {subject: subject({variant: 'verification_give'}), authorization: 'MAINTAINER_AUTHORIZED'};
  counter.record({...common, invocation_id: 'inv-private', outcome: 'V_DELIVERED_PRIVATE'});
  const moved = counter.record({...common, invocation_id: 'inv-public', outcome: 'V_PUBLISHED_PUBLIC'});
  assert.equal(moved.receipt_increment, 0);
  assert.equal(moved.bucket_move, true);
  assert.deepEqual(counter.snapshot().buckets, {
    A_SHIPPED_PUBLIC: 0,
    V_DELIVERED_PRIVATE: 0,
    V_PUBLISHED_PUBLIC: 1,
  });
  assert.equal(counter.snapshot().total_external_unique, 1);
});

test('webhook redelivery and duplicate maintainer requests preserve demand but cannot inflate receipts', () => {
  const counter = new CampaignCounter();
  const common = {subject: subject({variant: 'verification_give'}), authorization: 'MAINTAINER_AUTHORIZED'};
  counter.record({...common, invocation_id: 'delivery-1', outcome: 'V_DELIVERED_PRIVATE'});
  const redelivery = counter.record({...common, invocation_id: 'delivery-1', outcome: 'V_DELIVERED_PRIVATE'});
  const duplicateRequest = counter.record({...common, invocation_id: 'delivery-2', outcome: 'V_DELIVERED_PRIVATE'});
  assert.equal(redelivery.invocation_increment, 0);
  assert.equal(duplicateRequest.invocation_increment, 1);
  assert.equal(counter.snapshot().invocations, 2);
  assert.equal(counter.snapshot().total_external_unique, 1);
});

test('failed records, rehearsals, contributor requests, and superseded same-head requests never count', () => {
  const counter = new CampaignCounter();
  const common = {subject: subject(), invocation_id: 'x'};
  counter.record({...common, outcome: 'RUN_RECORD_FAILED', authorization: 'NORTHSET_AUTHORED'});
  counter.record({...common, invocation_id: 'r', outcome: 'R_REHEARSAL', authorization: 'NORTHSET_AUTHORED'});
  counter.record({...common, invocation_id: 'c', outcome: 'V_DELIVERED_PRIVATE', authorization: 'CONTRIBUTOR_REQUESTED'});
  counter.record({...common, invocation_id: 's', outcome: 'SUPERSEDED_WITHOUT_NEW_HEAD', authorization: 'MAINTAINER_AUTHORIZED'});
  assert.equal(counter.snapshot().total_external_unique, 0);
});

test('resource breakers enforce attempt, task, exception, receipt flag, and provider-throttle controls', () => {
  assert.throws(() => assertPhase0Spec({schema_version: 1}), /schema_version 2/i);
  assert.equal(assertPhase0Spec({schema_version: 2, task_id: 'TASK-1', attempt_sequence: 1}), true);
  const controls = new ResourceBreakers();
  controls.recordAttempt({task_id: 'TASK-1', model_minutes: 12, lane_hours: 0.2, outcome: 'FAILED_AUTHOR'});
  controls.recordAttempt({task_id: 'TASK-1', model_minutes: 12, lane_hours: 0.2, outcome: 'FAILED_AUTHOR'});
  controls.recordAttempt({task_id: 'TASK-1', model_minutes: 12, lane_hours: 0.2, outcome: 'FAILED_AUTHOR'});
  assert.throws(() => controls.assertCanStart({task_id: 'TASK-1', lane: 'standard'}), /three standard attempts/i);
  assert.throws(() => controls.recordAttempt({task_id: 'TASK-2', model_minutes: 12.01, lane_hours: 0.2}), /12 minutes/i);

  controls.startException({task_id: 'TASK-1', expected_value_note: 'One bounded retry may recover a verified flaky bootstrap.', campaign_tasks: 100});
  assert.throws(() => controls.startException({task_id: 'TASK-2', expected_value_note: 'second', campaign_tasks: 200}), /one active/i);
  assert.throws(() => controls.recordAttempt({task_id: 'TASK-1', lane: 'exception', model_minutes: 12, lane_hours: 4.01}), /4.0 lane-hours/i);
  controls.finishException('TASK-1');

  const flagged = controls.recordReceipt({receipt_subject_id: receiptSubjectId(subject()), lane_hours: 2.01});
  assert.equal(flagged.flagged, true);
  controls.tripSubscriptionThrottle({provider: 'OpenAI', signal: '429'});
  assert.throws(() => controls.assertCanStart({task_id: 'TASK-3', lane: 'standard'}), /founder review/i);
  assert.throws(() => controls.resume(), /signed founder/i);

  assert.equal(assertTaskResourcePolicy({task_id: 'TASK-1', attempt_sequence: 3}, {}), true);
  assert.throws(() => assertTaskResourcePolicy({task_id: 'TASK-1', attempt_sequence: 4}, {}), /exception lane/i);
  assert.equal(assertTaskResourcePolicy({task_id: 'TASK-1', attempt_sequence: 4}, {
    campaign_tasks: 100,
    exception_task_ids: ['TASK-1'],
    active_exception: {task_id: 'TASK-1', expected_value_note: 'One bounded retry has positive expected recovery value.', lane_hours_used: 0},
  }), true);
  assert.throws(() => assertTaskResourcePolicy({task_id: 'TASK-2', attempt_sequence: 1}, {
    provider_pause: {kind: 'PROVIDER_THROTTLED', auto_resume: false},
  }), /founder review/i);
  assert.throws(() => assertTaskResourcePolicy({task_id: 'TASK-2', attempt_sequence: 3}, {
    task_lane_hours_used: 2,
  }), /2.0 lane-hour/i);
  assert.equal(remainingTaskLaneMs({task_id: 'TASK-2', attempt_sequence: 2}, {task_lane_hours_used: 1.5}), 30 * 60 * 1000);
});

test('provider throttle writes a durable no-auto-resume pause', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-resource-control-'));
  t.after(() => import('node:fs/promises').then(({rm}) => rm(root, {recursive: true, force: true})));
  const file = path.join(root, 'resource-control.json');
  await tripPersistentProviderThrottle(file, {
    provider: 'OpenAI', signal: '429', at: '2026-07-17T12:00:00Z',
    gatewayStateDir: path.join(root, 'gateway-state'),
  });
  const control = await loadResourceControl(file);
  assert.deepEqual(control.provider_pause, {
    kind: 'PROVIDER_THROTTLED', provider: 'OpenAI', signal: '429',
    tripped_at: '2026-07-17T12:00:00.000Z',
    incident_id: 'openai-provider-throttle-2026-07-17T12:00:00.000Z',
    auto_resume: false,
  });
  assert.throws(() => assertTaskResourcePolicy({task_id: 'TASK-2', attempt_sequence: 1}, control), /founder review/i);
});

test('persistent provider throttle trip and clearance serialize on the gateway lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-resource-gateway-lock-'));
  t.after(() => import('node:fs/promises').then(({rm}) => rm(root, {recursive: true, force: true})));
  const file = path.join(root, 'resource-control.json');
  const gatewayStateDir = path.join(root, 'gateway-state');
  const lockOptions = {testMode: true, timing: {lockPollMs: 1}};
  const {acquireGhGatewayLock} = await import('../../gh-gateway.mjs');

  let release = await acquireGhGatewayLock({stateDir: gatewayStateDir, ...lockOptions});
  let settled = false;
  const trip = tripPersistentProviderThrottle(file, {
    provider: 'GitHub', signal: 'GITHUB_SECONDARY_RATE_LIMIT', gatewayStateDir,
    gatewayLockOptions: lockOptions,
  }).finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  await release();
  await trip;

  release = await acquireGhGatewayLock({stateDir: gatewayStateDir, ...lockOptions});
  settled = false;
  const clear = clearPersistentProviderThrottle(file, {
    founderDecisionId: 'founder-clear-lock-test', gatewayStateDir,
    gatewayLockOptions: lockOptions,
  }).finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  await release();
  await clear;
});

test('provider throttle classification covers GitHub secondary limits without treating permission 403s as throttles', () => {
  const secondaryLimit = {
    status: 403,
    stderr: JSON.stringify({
      documentation_url: 'https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits',
      message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
    }),
  };
  assert.equal(isProviderThrottle(secondaryLimit), true);
  assert.equal(isProviderThrottle({status: 429, message: 'Too Many Requests'}), true);
  assert.equal(isProviderThrottle('Retry-After: 60'), false);
  assert.equal(isProviderThrottle('GitHub rate limit Retry-After: 60'), true);
  assert.equal(isProviderThrottle('we should throttle the worker pool and honor retry-after',
    {source: 'model_runner'}), false);
  assert.equal(isProviderThrottle('403: abuse detection mechanism triggered'), true);
  assert.equal(isProviderThrottle('403: API rate limit exceeded'), true);
  assert.equal(isProviderThrottle('403: API RATE_LIMITED'), true);
  assert.equal(isProviderThrottle('secondary_rate_limit'), true);
  assert.equal(isProviderThrottle('403 Forbidden: rate limit exceeded'), true);
  assert.equal(isProviderThrottle('HTTP 403: Resource not accessible by integration'), false);
  assert.equal(isProviderThrottle('Issue 403 documents rate limit behavior'), false);
  assert.equal(isProviderThrottle('Issue 429 handles an ordinary response'), false);
  assert.equal(isProviderThrottle('The requested URL returned error: 429'), false);
  assert.equal(isProviderThrottle('error: 429'), false);
  assert.equal(isProviderThrottle('The requested URL returned error: 429', {source: 'git_transport'}), true);
  assert.equal(isProviderThrottle('error: 429', {source: 'git_transport'}), true);
});

test('model-runner throttle classification trusts only its structured transport field', () => {
  const attackerText = {
    code: 429,
    status: 429,
    stdout: 'HTTP 429 Too Many Requests',
    stderr: 'You have exceeded a secondary rate limit; honor Retry-After.',
    body: {message: 'provider throttled'},
  };
  assert.equal(isProviderThrottle(attackerText, {source: 'model_runner'}), false);
  assert.equal(isProviderThrottle({
    ...attackerText,
    trusted_model_provider_error: {
      schema_version: 1,
      source: 'model_runner_transport',
      provider: 'OpenAI',
      http_status: 429,
      error_code: 'rate_limit_exceeded',
    },
  }, {source: 'model_runner'}), true);
  assert.equal(isProviderThrottle({
    trusted_model_provider_error: {
      schema_version: 1,
      source: 'candidate_output',
      provider: 'OpenAI',
      http_status: 429,
      error_code: 'rate_limit_exceeded',
    },
  }, {source: 'model_runner'}), false);
  assert.equal(isProviderThrottle({
    trusted_model_provider_error: {
      schema_version: 1,
      source: 'model_runner_transport',
      provider: 'OpenAI',
      http_status: '429',
      error_code: 'not_a_transport_rate_code',
    },
  }, {source: 'model_runner'}), false);
});

test('Codex JSONL adapter trusts only typed transport failure metadata, never item text', () => {
  assert.equal(trustedModelProviderErrorFromCodexJsonl([
    JSON.stringify({type: 'item.completed', item: {type: 'agent_message',
      text: 'HTTP 429 Too Many Requests; secondary rate limit'}}),
    JSON.stringify({type: 'turn.failed', error: {message: 'candidate quoted HTTP 429'}}),
  ].join('\n')), null);
  assert.deepEqual(trustedModelProviderErrorFromCodexJsonl(JSON.stringify({
    type: 'turn.failed',
    error: {message: 'untrusted display text', codexErrorInfo: {
      httpConnectionFailed: {httpStatusCode: 429},
    }},
  })), {
    schema_version: 1,
    source: 'model_runner_transport',
    provider: 'OpenAI',
    http_status: 429,
    error_code: null,
  });
  assert.equal(trustedModelProviderErrorFromCodexJsonl(JSON.stringify({
    type: 'turn.failed', error: {message: 'no numeric status', codexErrorInfo: 'usageLimitExceeded'},
  })).error_code, 'usage_limit_exceeded');
});

test('persistent provider throttle clearance requires and records a founder decision', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-resource-clearance-'));
  t.after(() => import('node:fs/promises').then(({rm}) => rm(root, {recursive: true, force: true})));
  const file = path.join(root, 'resource-control.json');
  const gatewayStateDir = path.join(root, 'gateway-state');
  await tripPersistentProviderThrottle(file, {
    provider: 'GitHub', signal: 'secondary rate limit', at: '2026-07-18T12:14:00Z', gatewayStateDir,
  });
  await assert.rejects(() => clearPersistentProviderThrottle(file, {gatewayStateDir}), /founder decision/i);
  const clearance = await clearPersistentProviderThrottle(file, {
    founderDecisionId: 'founder-rate-resume-1', at: '2026-07-18T15:00:00Z',
    gatewayStateDir,
  });
  assert.equal(clearance.founder_decision_id, 'founder-rate-resume-1');
  const control = await loadResourceControl(file);
  assert.equal(control.provider_pause, null);
  assert.deepEqual(control.provider_pause_clearances, [clearance]);
});

test('resource usage derives cumulative lane hours from prior task attempt records', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-resource-usage-'));
  t.after(() => import('node:fs/promises').then(({rm}) => rm(root, {recursive: true, force: true})));
  await import('node:fs/promises').then(({mkdir, writeFile}) => Promise.all([
    mkdir(path.join(root, 'M-001'), {recursive: true}),
    mkdir(path.join(root, 'M-002'), {recursive: true}),
  ]).then(() => Promise.all([
    writeFile(path.join(root, 'M-001', 'attempt.json'), JSON.stringify({task_id: 'TASK-1', lane_hours: 0.75})),
    writeFile(path.join(root, 'M-002', 'attempt.json'), JSON.stringify({task_id: 'TASK-1', started_at: '2026-07-17T10:00:00Z', updated_at: '2026-07-17T10:30:00Z'})),
  ])));
  assert.equal(await resourceUsageForTask(root, 'TASK-1'), 1.25);
});

test('review records derive identity from the key, bind exact manifest bytes, and reject CLI identity forgery', () => {
  const reviewer = keyPair();
  const reviewerId = reviewerIdFromPublicKey(reviewer.publicKey);
  const manifest = {mission_id: 'M-200', patch_sha256: `sha256:${'b'.repeat(64)}`};
  const record = signRecord({
    kind: 'review', mission_id: 'M-200', manifest_digest: reviewableManifestDigest(manifest),
    disposition: 'SHIP', risk_tier: 'GREEN', reviewed_at: '2026-07-17T12:00:00Z',
  }, reviewer.privateKey, {claimed_reviewer_id: 'internal-user:forged'});
  assert.equal(record.reviewer_id, reviewerId);
  assert.equal(verifySignedRecord(record, reviewer.publicKey), true);
  const bound = bindReviewToManifest(manifest, record);
  assert.equal(verifyManifestReview(bound, record, new Map([[reviewerId, reviewer.publicKey]])), true);
  assert.throws(() => verifyManifestReview({...bound, review_record_sha256: `sha256:${'0'.repeat(64)}`}, record,
    new Map([[reviewerId, reviewer.publicKey]])), /review record/i);
});

test('review and batch approvals are signed, key-derived, and bind ordered reviewed manifests', () => {
  const reviewer = keyPair();
  const roster = new Map([[reviewerIdFromPublicKey(reviewer.publicKey), reviewer.publicKey]]);
  const approvers = new Set([reviewerIdFromPublicKey(reviewer.publicKey)]);
  const first = createReviewApproval({mission_id: 'M-200', patch_sha256: `sha256:${'a'.repeat(64)}`}, {
    privateKey: reviewer.privateKey, disposition: 'SHIP', riskTier: 'GREEN',
    reviewedAt: '2026-07-17T12:00:00Z',
  });
  const second = createReviewApproval({mission_id: 'M-201', patch_sha256: `sha256:${'b'.repeat(64)}`}, {
    privateKey: reviewer.privateKey, disposition: 'SHIP', riskTier: 'AMBER',
    reviewedAt: '2026-07-17T12:01:00Z',
  });
  const record = createBatchApproval([first.manifest, second.manifest], {
    privateKey: reviewer.privateKey, approvedDigest: `sha256:${'c'.repeat(64)}`,
    approvedAt: '2026-07-17T12:02:00Z',
  });
  assert.equal(verifyBatchApproval(record, [first.manifest, second.manifest],
    `sha256:${'c'.repeat(64)}`, roster, {authorizedApprovers: approvers}), true);
  assert.throws(() => verifyBatchApproval(record, [first.manifest, second.manifest],
    `sha256:${'c'.repeat(64)}`, roster, {authorizedApprovers: new Set()}), /not authorized/i);
  assert.throws(() => verifyBatchApproval(record, [second.manifest, first.manifest],
    `sha256:${'c'.repeat(64)}`, roster, {authorizedApprovers: approvers}), /ordered/i);
  assert.throws(() => verifyBatchApproval({...record, approved_manifest_digest: `sha256:${'d'.repeat(64)}`},
    [first.manifest, second.manifest], `sha256:${'c'.repeat(64)}`, roster,
    {authorizedApprovers: approvers}), /digest/i);
  const reviewedBoard = finalizeReviewedBoard({batch_digest: `sha256:${'0'.repeat(64)}`,
    ordered_mission_ids: ['M-200', 'M-201'], missions: [{mission_id: 'M-200', patch_sha256: `sha256:${'f'.repeat(64)}`}]},
  [first.manifest, second.manifest]);
  assert.notEqual(reviewedBoard.batch_digest, `sha256:${'0'.repeat(64)}`);
  assert.equal(reviewedBoard.review_status, 'SIGNED_REVIEWS_BOUND');
  assert.equal(reviewedBoard.reviewed_missions[0].review_record_sha256, first.manifest.review_record_sha256);
  assert.equal(reviewedBoard.missions[0].patch_sha256, first.manifest.patch_sha256);
  assert.equal(verifyReviewedBoard(reviewedBoard, [first.manifest, second.manifest]), true);
  assert.throws(() => verifyReviewedBoard({...reviewedBoard, missions: [{...reviewedBoard.missions[0],
    patch_sha256: `sha256:${'f'.repeat(64)}`}, reviewedBoard.missions[1]]}, [first.manifest, second.manifest]), /displayed board/i);
  assert.throws(() => finalizeReviewedBoard({ordered_mission_ids: ['M-201', 'M-200']},
    [first.manifest, second.manifest]), /order/i);
});

test('calibration and Amber manifests require two distinct signed review records', () => {
  const first = keyPair();
  const second = keyPair();
  const roster = new Map([
    [reviewerIdFromPublicKey(first.publicKey), first.publicKey],
    [reviewerIdFromPublicKey(second.publicKey), second.publicKey],
  ]);
  const base = {mission_id: 'CAL-001', patch_sha256: `sha256:${'a'.repeat(64)}`};
  const records = [
    createReviewRecord(base, {privateKey: first.privateKey, disposition: 'SHIP', riskTier: 'AMBER', reviewedAt: '2026-07-17T12:00:00Z'}),
    createReviewRecord(base, {privateKey: second.privateKey, disposition: 'SHIP', riskTier: 'AMBER', reviewedAt: '2026-07-17T12:01:00Z'}),
  ];
  const manifest = bindReviewSet(base, records);
  assert.equal(verifyReviewSet(manifest, records, roster, {minimumReviewers: 2}), true);
  const disputed = [records[0], createReviewRecord(base, {
    privateKey: second.privateKey, disposition: 'HOLD', riskTier: 'AMBER', reviewedAt: '2026-07-17T12:01:00Z',
  })];
  const disputedManifest = bindReviewSet(base, disputed);
  assert.equal(verifyReviewSet(disputedManifest, disputed, roster, {
    minimumReviewers: 2, requireShip: false,
  }), true);
  assert.throws(() => verifyReviewSet(disputedManifest, disputed, roster, {minimumReviewers: 2}), /SHIP/i);
  assert.throws(() => verifyReviewSet(manifest, [records[0]], roster, {minimumReviewers: 2}), /two distinct/i);
  assert.throws(() => verifyReviewSet(manifest, [{...records[0], disposition: 'HOLD'}, records[1]], roster,
    {minimumReviewers: 2}), /digest|signature|SHIP/i);
});

test('signed batch approval binds explicit founder adjudication to the disputed review set', () => {
  const founder = keyPair();
  const reviewer = keyPair();
  const roster = new Map([
    [reviewerIdFromPublicKey(founder.publicKey), founder.publicKey],
    [reviewerIdFromPublicKey(reviewer.publicKey), reviewer.publicKey],
  ]);
  const base = {mission_id: 'CAL-002', patch_sha256: `sha256:${'a'.repeat(64)}`};
  const records = [
    createReviewRecord(base, {privateKey: founder.privateKey, disposition: 'SHIP', riskTier: 'AMBER', reviewedAt: '2026-07-17T12:00:00Z'}),
    createReviewRecord(base, {privateKey: reviewer.privateKey, disposition: 'HOLD', riskTier: 'AMBER', reviewedAt: '2026-07-17T12:01:00Z'}),
  ];
  const manifest = bindReviewSet(base, records);
  const approvedDigest = `sha256:${'c'.repeat(64)}`;
  const approval = createBatchApproval([manifest], {
    privateKey: founder.privateKey,
    approvedDigest,
    approvedAt: '2026-07-17T12:05:00Z',
    founderAdjudications: [{
      mission_id: manifest.mission_id,
      review_event_id: manifest.review_record_sha256,
      decision: 'SHIP',
      rationale: 'The bounded concern does not block this exact publication.',
    }],
  });
  assert.deepEqual(approval.founder_adjudications, [{
    mission_id: manifest.mission_id,
    review_event_id: manifest.review_record_sha256,
    decision: 'SHIP',
    rationale: 'The bounded concern does not block this exact publication.',
  }]);
  assert.equal(verifyBatchApproval(approval, [manifest], approvedDigest, roster, {
    authorizedApprovers: new Set([approval.reviewer_id]),
  }), true);
  assert.throws(() => createBatchApproval([manifest], {
    privateKey: founder.privateKey,
    approvedDigest,
    founderAdjudications: [{
      mission_id: manifest.mission_id,
      review_event_id: `sha256:${'d'.repeat(64)}`,
      decision: 'SHIP',
      rationale: 'Wrong review set.',
    }],
  }), /review event/i);
});

test('tracked reviewer roster verifies provisioned key identities and reports pending operators', async () => {
  const roster = await loadReviewerRoster();
  assert.equal(roster.keys.size, 1);
  assert.equal(roster.keys.has('reviewer:ed25519:fdc0515981b00c89f119610397835a2f03a0cecacae75ebaab454352171f6748'), true);
  assert.equal(roster.capabilities.get('reviewer:ed25519:fdc0515981b00c89f119610397835a2f03a0cecacae75ebaab454352171f6748').has('batch_approve'), true);
  assert.deepEqual(roster.pending, ['Shehide']);
});

test('calibration, Amber dual review, Green audit, disagreement, and trailing disagreement pause are deterministic', () => {
  assert.deepEqual(reviewRequirement({calibration_ordinal: 1, risk_tier: 'GREEN', receipt_subject_id: 'sha256:00'}),
    {minimum_reviewers: 2, reason: 'CALIBRATION'});
  assert.deepEqual(reviewRequirement({calibration_ordinal: 21, risk_tier: 'AMBER', receipt_subject_id: 'sha256:ff'}),
    {minimum_reviewers: 2, reason: 'AMBER'});
  assert.equal(reviewRequirement({calibration_ordinal: 21, risk_tier: 'GREEN', receipt_subject_id: `sha256:${'0'.repeat(64)}`}).minimum_reviewers, 2);
  assert.equal(reviewRequirement({calibration_ordinal: 21, risk_tier: 'GREEN', receipt_subject_id: `sha256:${'f'.repeat(64)}`}).minimum_reviewers, 1);
  assert.throws(() => assertCalibrationState([{ship: true}, {ship: false}], {founder_adjudication: null}), /adjudication/i);
  assert.throws(() => assertCalibrationState(Array.from({length: 20}, (_, index) => ({disagreed: index < 3}))), />10%/i);
});

test('signed handoff requires every operational field and incoming confirmation', () => {
  const outgoing = keyPair();
  const incoming = keyPair();
  const payload = {
    shift_id: '2026-07-17-A', created_at: '2026-07-17T12:00:00Z',
    active_prepares: [], expiring_qualifications: [], expiring_ready_packs: [], pending_boards: [],
    maintainer_comments: [], upstream_ci_failures: [], sev_events: [], budget_remaining: {},
    exception_lane_tasks: [], machine_disk_status: {disk_percent: 10, memory_percent: 20},
  };
  const handoff = createHandoff(payload, outgoing.privateKey);
  const sharedIdentityConfirmation = confirmHandoff(handoff, outgoing.privateKey, '2026-07-17T12:05:00Z');
  assert.equal(verifyHandoff(sharedIdentityConfirmation, new Map([
    [reviewerIdFromPublicKey(outgoing.publicKey), outgoing.publicKey],
  ])), true);
  const confirmed = confirmHandoff(handoff, incoming.privateKey, '2026-07-17T12:05:00Z');
  const roster = new Map([
    [reviewerIdFromPublicKey(outgoing.publicKey), outgoing.publicKey],
    [reviewerIdFromPublicKey(incoming.publicKey), incoming.publicKey],
  ]);
  assert.equal(verifyHandoff(confirmed, roster), true);
  assert.throws(() => createHandoff({...payload, pending_boards: undefined}, outgoing.privateKey), /pending_boards/i);
});

test('reviewer key provisioning is OS-bound, private, key-derived, and idempotent', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-reviewer-key-'));
  t.after(() => import('node:fs/promises').then(({rm}) => rm(root, {recursive: true, force: true})));
  const privateFile = path.join(root, 'private.pem');
  const publicFile = path.join(root, 'public.pem');
  await assert.rejects(() => provisionReviewerKey({
    privateFile, publicFile, expectedOsUser: 'shehide', currentOsUser: 'aeziz-local',
  }), /OS user/i);
  const provisioned = await provisionReviewerKey({
    privateFile, publicFile, expectedOsUser: 'aeziz-local', currentOsUser: 'aeziz-local',
  });
  assert.match(provisioned.reviewer_id, /^reviewer:ed25519:[0-9a-f]{64}$/);
  assert.equal((await stat(privateFile)).mode & 0o777, 0o600);
  assert.match(await readFile(publicFile, 'utf8'), /BEGIN PUBLIC KEY/);
  assert.deepEqual(await provisionReviewerKey({
    privateFile, publicFile, expectedOsUser: 'aeziz-local', currentOsUser: 'aeziz-local',
  }), provisioned);
});
