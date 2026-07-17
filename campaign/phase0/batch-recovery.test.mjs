import assert from 'node:assert/strict';
import test from 'node:test';

import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {runRequiredBatchRehearsals, writeBatchRehearsalReport} from './batch-rehearsal.mjs';

test('25-mission batch rehearsals cover the happy path and every required recovery scenario', async () => {
  const reports = await runRequiredBatchRehearsals();
  assert.equal(reports.length, 11);
  const byName = new Map(reports.map((report) => [report.scenario, report]));

  const happy = byName.get('happy_path_25');
  assert.deepEqual(happy.external_actions, {
    approvals: 1, prepared_ledger_prs: 1, signing_batches: 1, pages_waits: 1,
    upstream_pr_creations: 25, envelope_prs: 1,
  });
  assert.equal(happy.counters.A_SHIPPED_PUBLIC, 25);

  const stale = byName.get('stale_before_publication');
  assert.equal(stale.by_mission['M-001'].outbound_actions, 0);
  assert.equal(stale.by_mission['M-001'].state, 'ABORTED_STALE');

  const ledger = byName.get('prepared_ledger_failure');
  assert.equal(ledger.external_actions.upstream_pr_creations, 0);

  const signing = byName.get('signing_crash_20_of_25');
  assert.equal(signing.first_run.signatures, 20);
  assert.equal(signing.resume.signatures, 5);
  assert.equal(signing.total_unique_signatures, 25);

  const pages = byName.get('pages_delayed');
  assert.equal(pages.before_ready.upstream_pr_creations, 0);
  assert.equal(pages.after_ready.upstream_pr_creations, 25);

  const threeFailed = byName.get('three_pr_creations_fail');
  assert.equal(threeFailed.first_run.shipped, 22);
  assert.equal(threeFailed.resume.shipped, 3);
  assert.equal(threeFailed.duplicate_prs, 0);

  const crashTwelve = byName.get('crash_after_pr_12');
  assert.equal(crashTwelve.first_run.upstream_pr_creations, 12);
  assert.equal(crashTwelve.resume.upstream_pr_creations, 13);
  assert.equal(crashTwelve.remote_adoptions, 12);
  assert.equal(crashTwelve.duplicate_prs, 0);

  const envelope = byName.get('envelope_publication_failure');
  assert.equal(envelope.state, 'ENVELOPE_PENDING_RECOVERY');
  assert.equal(envelope.resume_state, 'SHIPPED');

  const rerun = byName.get('command_rerun_twice');
  assert.equal(rerun.external_actions.upstream_pr_creations, 25);
  assert.equal(rerun.counters.A_SHIPPED_PUBLIC, 25);
  assert.equal(rerun.duplicate_prs, 0);

  assert.equal(byName.get('manifest_mutates_after_review').approval_rejected, true);
  assert.equal(byName.get('review_record_mutates').shipment_rejected, true);

  for (const report of reports) {
    assert.ok(Array.isArray(report.transitions) && report.transitions.length > 0, report.scenario);
    assert.ok(report.external_actions && report.counters, report.scenario);
  }
});

test('batch rehearsal writes a durable deterministic evidence report', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phase0-batch-report-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const result = await writeBatchRehearsalReport(path.join(root, 'report.json'), {
    generatedAt: '2026-07-17T00:00:00.000Z',
  });
  assert.match(result.sha256, /^sha256:[0-9a-f]{64}$/);
  const report = JSON.parse(await readFile(result.file, 'utf8'));
  assert.equal(report.generated_at, '2026-07-17T00:00:00.000Z');
  assert.equal(report.scenario_count, 11);
  assert.equal(report.scenarios[0].scenario, 'happy_path_25');
});
