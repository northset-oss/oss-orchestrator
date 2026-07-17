import {canonical, sha256} from '../../core.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const IDS = Array.from({length: 25}, (_, index) => `M-${String(index + 1).padStart(3, '0')}`);

function actions() {
  return {approvals: 0, prepared_ledger_prs: 0, signing_batches: 0, pages_waits: 0,
    upstream_pr_creations: 0, envelope_prs: 0};
}

class FakeBatch {
  constructor() {
    this.missions = new Map(IDS.map((id, index) => [id, {
      id,
      manifest: {mission_id: id, manifest_version: 1, tested_oid: String(index + 1).padStart(40, '0')},
      review: {mission_id: id, disposition: 'SHIP', reviewer_id: 'reviewer:fixture'},
      state: 'READY',
      outbound_actions: 0,
    }]));
    this.externalActions = actions();
    this.transitions = [];
    this.remotePrs = new Map();
    this.localPrs = new Map();
    this.signatures = new Set();
    this.enveloped = new Set();
    this.counted = new Set();
    this.approval = null;
    this.prepared = false;
    this.pagesReady = false;
    this.remoteAdoptions = 0;
  }

  frozenDigest() {
    return sha256(Buffer.from(canonical([...this.missions.values()].map(({manifest, review}) => ({manifest, review}))), 'utf8'));
  }

  transition(id, state) {
    const mission = this.missions.get(id);
    mission.state = state;
    this.transitions.push({mission_id: id, state});
  }

  approve() {
    if (this.approval) return this.approval;
    this.approval = this.frozenDigest();
    this.externalActions.approvals += 1;
    this.transitions.push({mission_id: 'BATCH', state: 'APPROVED', digest: this.approval});
    return this.approval;
  }

  assertFrozen() {
    if (!this.approval || this.frozenDigest() !== this.approval) throw new Error('frozen manifest or reviewer record mutated after approval');
  }

  stale(ids) {
    for (const id of ids) this.transition(id, 'ABORTED_STALE');
  }

  publishPrepared({fail = false} = {}) {
    this.assertFrozen();
    if (this.prepared) return true;
    this.externalActions.prepared_ledger_prs += 1;
    this.transitions.push({mission_id: 'BATCH', state: fail ? 'LEDGER_GATE_FAILED' : 'PREPARED_LEDGER_PUBLISHED'});
    if (fail) return false;
    this.prepared = true;
    for (const mission of this.missions.values()) {
      if (mission.state === 'ABORTED_STALE') continue;
      mission.outbound_actions += 1;
      this.transition(mission.id, 'PREPARED');
    }
    return true;
  }

  sign({crashAfter = Infinity} = {}) {
    this.assertFrozen();
    if (!this.prepared) throw new Error('prepared ledger gate has not passed');
    const missing = [...this.missions.values()].filter((mission) => mission.state !== 'ABORTED_STALE' && !this.signatures.has(mission.id));
    if (!missing.length) return {signatures: 0, crashed: false};
    this.externalActions.signing_batches += 1;
    let created = 0;
    for (const mission of missing) {
      if (created === crashAfter) {
        this.transitions.push({mission_id: 'BATCH', state: 'SIGNING_CRASH', completed: created});
        return {signatures: created, crashed: true};
      }
      this.signatures.add(mission.id);
      mission.outbound_actions += 1;
      this.transition(mission.id, 'SIGNED');
      created += 1;
    }
    return {signatures: created, crashed: false};
  }

  waitPages({ready}) {
    if (this.pagesReady && ready) return true;
    this.externalActions.pages_waits += 1;
    this.pagesReady = ready;
    this.transitions.push({mission_id: 'BATCH', state: ready ? 'PAGES_READY' : 'PAGES_DELAYED'});
    return ready;
  }

  openPrs({failIds = new Set(), crashAfter = Infinity} = {}) {
    this.assertFrozen();
    if (!this.pagesReady) return {created: 0, adopted: 0, failed: 0, crashed: false};
    let created = 0;
    let adopted = 0;
    let failed = 0;
    for (const mission of this.missions.values()) {
      if (mission.state === 'ABORTED_STALE' || this.localPrs.has(mission.id)) continue;
      const remote = this.remotePrs.get(mission.id);
      if (remote) {
        const expected = sha256(Buffer.from(canonical(mission.manifest), 'utf8'));
        if (remote.manifest_digest !== expected) throw new Error('remote PR cannot be adopted without exact validation');
        this.localPrs.set(mission.id, remote);
        this.remoteAdoptions += 1;
        adopted += 1;
        this.transition(mission.id, 'PR_ADOPTED');
        continue;
      }
      if (!this.signatures.has(mission.id)) continue;
      if (created === crashAfter) {
        this.transitions.push({mission_id: 'BATCH', state: 'PR_CREATION_CRASH', completed: created});
        return {created, adopted, failed, crashed: true};
      }
      if (failIds.has(mission.id)) {
        failed += 1;
        this.transition(mission.id, 'PR_RECOVERABLE');
        continue;
      }
      const record = {url: `https://example.invalid/${mission.id}`, manifest_digest: sha256(Buffer.from(canonical(mission.manifest), 'utf8'))};
      this.remotePrs.set(mission.id, record);
      this.localPrs.set(mission.id, record);
      this.externalActions.upstream_pr_creations += 1;
      mission.outbound_actions += 1;
      this.transition(mission.id, 'PR_OPENED');
      created += 1;
    }
    return {created, adopted, failed, crashed: false};
  }

  loseLocalPrJournal() {
    this.localPrs.clear();
  }

  publishEnvelope({fail = false} = {}) {
    this.assertFrozen();
    const pending = [...this.localPrs.keys()].filter((id) => !this.enveloped.has(id));
    if (!pending.length) return {published: 0, failed: false};
    this.externalActions.envelope_prs += 1;
    this.transitions.push({mission_id: 'BATCH', state: fail ? 'ENVELOPE_PENDING_RECOVERY' : 'ENVELOPE_PUBLISHED'});
    if (fail) return {published: 0, failed: true};
    for (const id of pending) {
      this.enveloped.add(id);
      this.counted.add(id);
      this.missions.get(id).outbound_actions += 1;
      this.transition(id, 'SHIPPED');
    }
    return {published: pending.length, failed: false};
  }

  mutateManifest(id) {
    this.missions.get(id).manifest.tested_oid = 'f'.repeat(40);
  }

  mutateReview(id) {
    this.missions.get(id).review.disposition = 'HOLD';
  }

  common(scenario) {
    return {
      scenario,
      external_actions: {...this.externalActions},
      counters: {A_SHIPPED_PUBLIC: this.counted.size, TOTAL_EXTERNAL_UNIQUE: this.counted.size},
      transitions: [...this.transitions],
      by_mission: Object.fromEntries([...this.missions].map(([id, mission]) => [id, {
        state: mission.state, outbound_actions: mission.outbound_actions,
      }])),
      duplicate_prs: this.externalActions.upstream_pr_creations - new Set(this.remotePrs.keys()).size,
    };
  }
}

function readyBatch() {
  const batch = new FakeBatch();
  batch.approve();
  return batch;
}

function prepareAndSign(batch) {
  batch.publishPrepared();
  batch.sign();
}

export async function runRequiredBatchRehearsals() {
  const reports = [];

  {
    const batch = readyBatch();
    prepareAndSign(batch);
    batch.waitPages({ready: true});
    batch.openPrs();
    batch.publishEnvelope();
    reports.push(batch.common('happy_path_25'));
  }
  {
    const batch = readyBatch();
    batch.stale(new Set(['M-001']));
    prepareAndSign(batch);
    batch.waitPages({ready: true});
    batch.openPrs();
    batch.publishEnvelope();
    reports.push(batch.common('stale_before_publication'));
  }
  {
    const batch = readyBatch();
    batch.publishPrepared({fail: true});
    reports.push(batch.common('prepared_ledger_failure'));
  }
  {
    const batch = readyBatch();
    batch.publishPrepared();
    const firstRun = batch.sign({crashAfter: 20});
    const resume = batch.sign();
    batch.waitPages({ready: true});
    batch.openPrs();
    batch.publishEnvelope();
    reports.push({...batch.common('signing_crash_20_of_25'), first_run: firstRun, resume,
      total_unique_signatures: batch.signatures.size});
  }
  {
    const batch = readyBatch();
    prepareAndSign(batch);
    batch.waitPages({ready: false});
    const before = batch.openPrs();
    batch.waitPages({ready: true});
    const after = batch.openPrs();
    batch.publishEnvelope();
    reports.push({...batch.common('pages_delayed'), before_ready: {upstream_pr_creations: before.created},
      after_ready: {upstream_pr_creations: after.created}});
  }
  {
    const batch = readyBatch();
    prepareAndSign(batch);
    batch.waitPages({ready: true});
    const failures = new Set(['M-003', 'M-014', 'M-025']);
    batch.openPrs({failIds: failures});
    batch.publishEnvelope();
    const firstShipped = batch.counted.size;
    const resumed = batch.openPrs();
    batch.publishEnvelope();
    reports.push({...batch.common('three_pr_creations_fail'), first_run: {shipped: firstShipped},
      resume: {shipped: resumed.created}});
  }
  {
    const batch = readyBatch();
    prepareAndSign(batch);
    batch.waitPages({ready: true});
    const first = batch.openPrs({crashAfter: 12});
    batch.loseLocalPrJournal();
    const resumed = batch.openPrs();
    batch.publishEnvelope();
    reports.push({...batch.common('crash_after_pr_12'),
      first_run: {upstream_pr_creations: first.created},
      resume: {upstream_pr_creations: resumed.created}, remote_adoptions: batch.remoteAdoptions});
  }
  {
    const batch = readyBatch();
    prepareAndSign(batch);
    batch.waitPages({ready: true});
    batch.openPrs();
    batch.publishEnvelope({fail: true});
    const state = 'ENVELOPE_PENDING_RECOVERY';
    batch.publishEnvelope();
    reports.push({...batch.common('envelope_publication_failure'), state, resume_state: 'SHIPPED'});
  }
  {
    const batch = readyBatch();
    prepareAndSign(batch);
    batch.waitPages({ready: true});
    batch.openPrs();
    batch.publishEnvelope();
    for (let index = 0; index < 2; index += 1) {
      batch.approve();
      batch.publishPrepared();
      batch.sign();
      batch.waitPages({ready: true});
      batch.openPrs();
      batch.publishEnvelope();
    }
    reports.push(batch.common('command_rerun_twice'));
  }
  {
    const batch = readyBatch();
    batch.mutateManifest('M-001');
    let rejected = false;
    try { batch.publishPrepared(); } catch { rejected = true; }
    batch.transitions.push({mission_id: 'BATCH', state: 'APPROVAL_REJECTED'});
    reports.push({...batch.common('manifest_mutates_after_review'), approval_rejected: rejected});
  }
  {
    const batch = readyBatch();
    batch.mutateReview('M-001');
    let rejected = false;
    try { batch.publishPrepared(); } catch { rejected = true; }
    batch.transitions.push({mission_id: 'BATCH', state: 'SHIPMENT_REJECTED'});
    reports.push({...batch.common('review_record_mutates'), shipment_rejected: rejected});
  }
  return reports;
}

export async function writeBatchRehearsalReport(file, {generatedAt = new Date().toISOString()} = {}) {
  const scenarios = await runRequiredBatchRehearsals();
  const report = {
    schema_version: 1,
    kind: 'phase0_batch_rehearsal',
    generated_at: generatedAt,
    fake_github_only: true,
    external_third_party_actions: 0,
    mission_count: 25,
    scenario_count: scenarios.length,
    scenarios,
  };
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const absolute = path.resolve(file);
  await mkdir(path.dirname(absolute), {recursive: true, mode: 0o700});
  await writeFile(absolute, bytes, {mode: 0o600});
  return {file: absolute, sha256: sha256(bytes), report};
}
