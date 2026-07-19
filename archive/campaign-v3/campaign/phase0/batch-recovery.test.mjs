import assert from 'node:assert/strict';
import test from 'node:test';

import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {runRequiredBatchRehearsals, writeBatchRehearsalReport} from './batch-rehearsal.mjs';
import {shipBatch} from '../../ship.mjs';

const ZERO_ACTIONS = {
  approvals: 0,
  prepared_ledger_prs: 0,
  signing_batches: 0,
  pages_waits: 0,
  upstream_pr_creation_attempts: 0,
  upstream_pr_creations: 0,
  remote_pr_validations: 0,
  envelope_prs: 0,
};

const HAPPY_ACTIONS = {
  approvals: 1,
  prepared_ledger_prs: 1,
  signing_batches: 1,
  pages_waits: 1,
  upstream_pr_creation_attempts: 25,
  upstream_pr_creations: 25,
  remote_pr_validations: 0,
  envelope_prs: 1,
};

const HAPPY_TRANSITIONS = {
  APPROVED: 26,
  PRE_PUBLIC_RECHECK: 25,
  PUSHED: 25,
  PREPARED_LEDGER_PUBLISHED: 1,
  PREPARED_RECEIPT_PUBLISHED: 25,
  SIGNED: 25,
  ATTESTED: 25,
  PAGES_READY: 1,
  RECEIPT_AVAILABLE: 25,
  PRE_PR_COLLISION_CHECK: 25,
  PR_OPENED: 25,
  DISCLOSURE_SYNCED: 25,
  ENVELOPE_PUBLISHED: 1,
  FINAL_ENVELOPE_PUBLISHED: 25,
  SHIPPED: 25,
};

function transitionCounts(report) {
  const counts = {};
  for (const transition of report.transitions) counts[transition.state] = (counts[transition.state] ?? 0) + 1;
  return counts;
}

function assertCounters(report, shipped) {
  assert.deepEqual(report.counters, {A_SHIPPED_PUBLIC: shipped, TOTAL_EXTERNAL_UNIQUE: shipped});
}

function assertCounterRuns(report, shippedValues) {
  assert.deepEqual(report.production_counter_runs,
    shippedValues.map((shipped) => ({A_SHIPPED_PUBLIC: shipped, TOTAL_EXTERNAL_UNIQUE: shipped})));
}

test('25-mission batch rehearsals cover the happy path and every required recovery scenario', async () => {
  let productionCalls = 0;
  const reports = await runRequiredBatchRehearsals({
    shipBatchImpl: async (...args) => {
      productionCalls += 1;
      return shipBatch(...args);
    },
  });
  assert.equal(productionCalls, 18, 'every first run and recovery must use exported production shipBatch');
  assert.equal(reports.length, 11);
  const byName = new Map(reports.map((report) => [report.scenario, report]));

  const happy = byName.get('happy_path_25');
  assert.deepEqual(happy.external_actions, HAPPY_ACTIONS);
  assertCounters(happy, 25);
  assertCounterRuns(happy, [25]);
  assert.deepEqual(transitionCounts(happy), HAPPY_TRANSITIONS);
  assert.deepEqual(happy.by_mission['M-001'].transition_states, [
    'APPROVED', 'PRE_PUBLIC_RECHECK', 'PUSHED', 'PREPARED_RECEIPT_PUBLISHED', 'SIGNED', 'ATTESTED',
    'RECEIPT_AVAILABLE', 'PRE_PR_COLLISION_CHECK', 'PR_OPENED', 'DISCLOSURE_SYNCED',
    'FINAL_ENVELOPE_PUBLISHED', 'SHIPPED',
  ]);

  const stale = byName.get('stale_before_publication');
  assert.deepEqual(stale.external_actions, {...HAPPY_ACTIONS,
    upstream_pr_creation_attempts: 24, upstream_pr_creations: 24});
  assertCounters(stale, 24);
  assertCounterRuns(stale, [24]);
  assert.deepEqual(transitionCounts(stale), {...HAPPY_TRANSITIONS,
    PUSHED: 24,
    PREPARED_RECEIPT_PUBLISHED: 24,
    SIGNED: 24,
    ATTESTED: 24,
    RECEIPT_AVAILABLE: 24,
    PRE_PR_COLLISION_CHECK: 24,
    PR_OPENED: 24,
    DISCLOSURE_SYNCED: 24,
    FINAL_ENVELOPE_PUBLISHED: 24,
    SHIPPED: 24,
    ABORTED_STALE: 1,
  });
  assert.equal(stale.by_mission['M-001'].outbound_actions, 0);
  assert.equal(stale.by_mission['M-001'].state, 'ABORTED_STALE');
  assert.deepEqual(stale.by_mission['M-001'].transition_states,
    ['APPROVED', 'PRE_PUBLIC_RECHECK', 'ABORTED_STALE']);

  const ledger = byName.get('prepared_ledger_failure');
  assert.deepEqual(ledger.external_actions, {...ZERO_ACTIONS, approvals: 1, prepared_ledger_prs: 1});
  assertCounters(ledger, 0);
  assertCounterRuns(ledger, [0]);
  assert.deepEqual(transitionCounts(ledger), {
    APPROVED: 26, PRE_PUBLIC_RECHECK: 25, PUSHED: 25, LEDGER_GATE_FAILED: 1,
    FAILED_INFRA_TERMINAL: 25,
  });

  const signing = byName.get('signing_crash_20_of_25');
  assert.deepEqual(signing.external_actions, {...HAPPY_ACTIONS, signing_batches: 2});
  assertCounters(signing, 25);
  assertCounterRuns(signing, [25]);
  assert.deepEqual(transitionCounts(signing), {...HAPPY_TRANSITIONS, SIGNING_CRASH: 1});
  assert.equal(signing.first_run.signatures, 20);
  assert.equal(signing.first_run.crashed, true);
  assert.equal(signing.resume.signatures, 5);
  assert.equal(signing.resume.crashed, false);
  assert.equal(signing.total_unique_signatures, 25);

  const pages = byName.get('pages_delayed');
  assert.deepEqual(pages.external_actions, {...HAPPY_ACTIONS, pages_waits: 2});
  assertCounters(pages, 25);
  assertCounterRuns(pages, [0, 25]);
  assert.deepEqual(transitionCounts(pages), {...HAPPY_TRANSITIONS, PAGES_DELAYED: 1});
  assert.equal(pages.before_ready.upstream_pr_creations, 0);
  assert.equal(pages.after_ready.upstream_pr_creations, 25);

  const threeFailed = byName.get('three_pr_creations_fail');
  assert.deepEqual(threeFailed.external_actions, {...HAPPY_ACTIONS,
    upstream_pr_creation_attempts: 28, envelope_prs: 2});
  assertCounters(threeFailed, 25);
  assertCounterRuns(threeFailed, [22, 25]);
  assert.deepEqual(transitionCounts(threeFailed), {...HAPPY_TRANSITIONS,
    PRE_PR_COLLISION_CHECK: 28,
    FAILED_INFRA_TERMINAL: 3,
    ENVELOPE_PUBLISHED: 2,
  });
  assert.equal(threeFailed.first_run.shipped, 22);
  assert.equal(threeFailed.resume.shipped, 3);
  assert.deepEqual(threeFailed.recoverable_mission_ids, ['M-003', 'M-014', 'M-025']);
  assert.equal(threeFailed.duplicate_prs, 0);

  const crashTwelve = byName.get('crash_after_pr_12');
  assert.deepEqual(crashTwelve.external_actions, {...HAPPY_ACTIONS, remote_pr_validations: 12});
  assertCounters(crashTwelve, 25);
  assertCounterRuns(crashTwelve, [25]);
  assert.deepEqual(transitionCounts(crashTwelve), {...HAPPY_TRANSITIONS,
    PRE_PR_COLLISION_CHECK: 37,
    PR_OPENED: 36,
    DISCLOSURE_SYNCED: 36,
    PR_CREATION_CRASH: 1,
    REMOTE_PR_VALIDATED: 12,
  });
  assert.equal(crashTwelve.first_run.upstream_pr_creations, 12);
  assert.equal(crashTwelve.resume.upstream_pr_creations, 13);
  assert.equal(crashTwelve.remote_adoptions, 12);
  assert.equal(crashTwelve.duplicate_prs, 0);
  const lastValidation = crashTwelve.transitions.findLastIndex((item) => item.state === 'REMOTE_PR_VALIDATED');
  const resumedAtThirteen = crashTwelve.transitions.findLastIndex((item) =>
    item.mission_id === 'M-013' && item.state === 'PR_OPENED');
  assert.ok(lastValidation < resumedAtThirteen, 'resume must validate all twelve remote PRs before creating PR 13');

  const envelope = byName.get('envelope_publication_failure');
  assert.deepEqual(envelope.external_actions, {...HAPPY_ACTIONS, envelope_prs: 2});
  assertCounters(envelope, 25);
  assertCounterRuns(envelope, [0, 25]);
  assert.deepEqual(transitionCounts(envelope), {...HAPPY_TRANSITIONS,
    ENVELOPE_PENDING_RECOVERY: 1,
    FINAL_ENVELOPE_PENDING_RECOVERY: 25,
  });
  assert.equal(envelope.state, 'FINAL_ENVELOPE_PENDING_RECOVERY');
  assert.equal(envelope.resume_state, 'SHIPPED');

  const rerun = byName.get('command_rerun_twice');
  assert.deepEqual(rerun.external_actions, HAPPY_ACTIONS);
  assertCounters(rerun, 25);
  assertCounterRuns(rerun, [25, 25, 25]);
  assert.deepEqual(transitionCounts(rerun), HAPPY_TRANSITIONS);
  assert.deepEqual(rerun.rerun_action_delta, ZERO_ACTIONS);
  assert.deepEqual(rerun.ledger_records, {approvals: 1, prepared: 1, envelopes: 1});
  assert.equal(rerun.duplicate_prs, 0);

  const manifestMutation = byName.get('manifest_mutates_after_review');
  assert.deepEqual(manifestMutation.external_actions, ZERO_ACTIONS);
  assertCounters(manifestMutation, 0);
  assertCounterRuns(manifestMutation, []);
  assert.deepEqual(transitionCounts(manifestMutation), {APPROVAL_REJECTED: 1});
  assert.equal(manifestMutation.approval_rejected, true);
  assert.match(manifestMutation.error, /review record does not bind the exact manifest/i);

  const reviewMutation = byName.get('review_record_mutates');
  assert.deepEqual(reviewMutation.external_actions, ZERO_ACTIONS);
  assertCounters(reviewMutation, 0);
  assertCounterRuns(reviewMutation, []);
  assert.deepEqual(transitionCounts(reviewMutation), {SHIPMENT_REJECTED: 1});
  assert.equal(reviewMutation.shipment_rejected, true);
  assert.match(reviewMutation.error, /review record set digest does not match manifest/i);

  for (const report of reports) {
    assert.ok(Array.isArray(report.transitions) && report.transitions.length > 0, report.scenario);
    assert.ok(report.external_actions && report.counters, report.scenario);
    assert.equal(report.production_entrypoint, 'shipBatch', report.scenario);
  }
});

test('batch rehearsal writes a durable deterministic evidence report', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phase0-batch-report-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const result = await writeBatchRehearsalReport(path.join(root, 'report.json'), {
    generatedAt: '2026-07-17T00:00:00.000Z',
  });
  const repeated = await writeBatchRehearsalReport(path.join(root, 'report-repeated.json'), {
    generatedAt: '2026-07-17T00:00:00.000Z',
  });
  assert.match(result.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(repeated.sha256, result.sha256);
  assert.deepEqual(await readFile(repeated.file), await readFile(result.file));
  const report = JSON.parse(await readFile(result.file, 'utf8'));
  assert.equal(report.generated_at, '2026-07-17T00:00:00.000Z');
  assert.equal(report.scenario_count, 11);
  assert.equal(report.production_entrypoint, 'shipBatch');
  assert.equal(report.injected_rehearsal_adapters_only, true);
  assert.equal(report.external_third_party_actions, 0);
  assert.equal(report.scenarios[0].scenario, 'happy_path_25');
});
