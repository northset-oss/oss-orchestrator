import {createPrivateKey, createPublicKey} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {batchApprovalDigest, canonical, manifestDigest, sha256, taskIdForCandidate} from '../../core.mjs';
import {bindReviewSet, createBatchApproval, createReviewRecord} from './approvals.mjs';
import {reviewerIdFromPublicKey} from './integrity.mjs';
import {PLANNED_ACTIONS, canonicalReceiptUrl, shipBatch as productionShipBatch} from '../../ship.mjs';

const IDS = Array.from({length: 25}, (_, index) => `M-${String(index + 1).padStart(3, '0')}`);
const APPROVED_AT = '2026-07-17T12:00:00.000Z';

function actionCounts() {
  return {
    approvals: 0,
    prepared_ledger_prs: 0,
    signing_batches: 0,
    pages_waits: 0,
    upstream_pr_creation_attempts: 0,
    upstream_pr_creations: 0,
    remote_pr_validations: 0,
    envelope_prs: 0,
  };
}

function fixtureDigest(id, label) {
  return sha256(Buffer.from(`${id}\0${label}`, 'utf8'));
}

function keyPair(label) {
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const seed = Buffer.from(fixtureDigest('REVIEWER', label).slice('sha256:'.length), 'hex').subarray(0, 32);
  const privateKey = createPrivateKey({key: Buffer.concat([prefix, seed]), format: 'der', type: 'pkcs8'});
  return {privateKey, publicKey: createPublicKey(privateKey)};
}

function fixtureOid(id, label) {
  return fixtureDigest(id, label).slice('sha256:'.length, 'sha256:'.length + 40);
}

function buildReviewedMissions() {
  const primary = keyPair('primary');
  const secondary = keyPair('secondary');
  const primaryId = reviewerIdFromPublicKey(primary.publicKey);
  const secondaryId = reviewerIdFromPublicKey(secondary.publicKey);
  const subjects = IDS.map((id, index) => {
    const repository = `phase0-owner-${index + 1}/phase0-repo-${index + 1}`;
    const candidate = `${repository}#${index + 1}`;
    const spec = {
      schema_version: 2,
      mission_id: id,
      task_id: taskIdForCandidate(candidate),
      attempt_sequence: 1,
      work_category: 'defect_fix',
      candidate,
      target_repo: `https://github.com/${repository}`,
      issue_url: `https://github.com/${repository}/issues/${index + 1}`,
      base_commit: fixtureOid(id, 'base'),
    };
    const reviewable = {
      schema_version: 2,
      mission_id: id,
      task_id: spec.task_id,
      attempt_sequence: spec.attempt_sequence,
      work_category: spec.work_category,
      repo: repository,
      issue_url: spec.issue_url,
      base_branch: 'main',
      base_commit: spec.base_commit,
      commit_oid: fixtureOid(id, 'commit'),
      patch_sha256: fixtureDigest(id, 'patch'),
      pr_body_sha256: fixtureDigest(id, 'body'),
      pr_title: `fix: phase 0 rehearsal ${id}`,
      bundle_digest: fixtureDigest(id, 'bundle'),
      oracle_sha256: fixtureDigest(id, 'oracle'),
      risk_flags: [],
      changed_file_classes: [{path: 'src/fix.mjs', class: 'source'}],
      calibration_ordinal: 21,
      planned_actions: [...PLANNED_ACTIONS],
    };
    const reviewRecords = [primary, secondary].map(({privateKey}) => createReviewRecord(reviewable, {
      privateKey,
      disposition: 'SHIP',
      riskTier: 'GREEN',
      reviewedAt: APPROVED_AT,
    }));
    const manifest = bindReviewSet(reviewable, reviewRecords);
    return {id, spec, manifest, reviewRecords};
  });
  const approvedDigest = batchApprovalDigest(subjects.map(({manifest}) => manifest));
  const signedBatchApproval = createBatchApproval(subjects.map(({manifest}) => manifest), {
    privateKey: primary.privateKey,
    approvedDigest,
    approvedAt: APPROVED_AT,
  });
  const reviewerRoster = {
    keys: new Map([[primaryId, primary.publicKey], [secondaryId, secondary.publicKey]]),
    capabilities: new Map([[primaryId, new Set(['review', 'batch_approve'])], [secondaryId, new Set(['review'])]]),
  };
  return {subjects, approvedDigest, signedBatchApproval, reviewerRoster};
}

class ProductionRehearsalAdapter {
  constructor(fixture) {
    this.fixture = fixture;
    this.subjects = new Map(fixture.subjects.map((subject) => [subject.id, subject]));
    this.journals = new Map();
    this.journalIds = new Map(fixture.subjects.map(({id}) => [`/rehearsal/${id}/ship.journal.json`, id]));
    this.approvalRecords = new Map();
    this.preparedLedgers = new Set();
    this.finalEnvelopes = [];
    this.signatures = new Set();
    this.remotePrs = new Map();
    this.enveloped = new Set();
    this.externalActions = actionCounts();
    this.transitions = [];
    this.outboundByMission = new Map(IDS.map((id) => [id, 0]));
    this.seenTransitionCounts = new WeakMap();
    this.staleIds = new Set();
    this.failedPrIds = new Set();
    this.failedPrAttempts = new Set();
    this.ledgerChecksFail = false;
    this.pagesReady = true;
    this.signingCrashAfter = null;
    this.signingCrashConsumed = false;
    this.prCrashAfter = null;
    this.prCrashConsumed = false;
    this.envelopeFails = false;
    this.remoteAdoptions = 0;
    this.signingRuns = [];
    this.productionCounterRuns = [];
    this.reviewEvents = new Map();
    this.reviewAdjudications = new Map();
  }

  operations() {
    return {
      loadReadySubject: this.loadReadySubject.bind(this),
      saveJournal: this.saveJournal.bind(this),
      archiveTerminalJournal: this.archiveTerminalJournal.bind(this),
      writeBatchApproval: this.writeBatchApproval.bind(this),
      runIndependentBatch: this.runIndependentBatch.bind(this),
      prePublicPushForBatch: this.prePublicPushForBatch.bind(this),
      publishPreparedLedgerBatch: this.publishPreparedLedgerBatch.bind(this),
      verifyAttestationBatch: this.verifyAttestationBatch.bind(this),
      waitForCanonicalReceiptsOnce: this.waitForCanonicalReceiptsOnce.bind(this),
      processUpstreamMission: this.processUpstreamMission.bind(this),
      publishFinalEnvelopeBatch: this.publishFinalEnvelopeBatch.bind(this),
      resourceUsageForTask: async () => 0,
      recordDualReviewEvent: this.recordDualReviewEvent.bind(this),
      recordFounderAdjudication: this.recordFounderAdjudication.bind(this),
      loadReviewControl: this.loadReviewControl.bind(this),
      assertReviewControlAllowsPublication: this.assertReviewControlAllowsPublication.bind(this),
    };
  }

  async recordDualReviewEvent({reviewEventId, missionId, signedReviews}) {
    const value = {
      reviewEventId,
      missionId,
      disagreed: new Set(signedReviews.map((record) => record.disposition)).size > 1,
    };
    const existing = this.reviewEvents.get(reviewEventId);
    if (existing && canonical(existing) !== canonical(value)) throw new Error('conflicting rehearsal review-event replay');
    this.reviewEvents.set(reviewEventId, value);
    return {publication_allowed: !value.disagreed};
  }

  async recordFounderAdjudication({reviewEventId, authorityRecordSha256}) {
    this.reviewAdjudications.set(reviewEventId, authorityRecordSha256);
    return {publication_allowed: true};
  }

  async loadReviewControl() {
    return {reviewEvents: this.reviewEvents, reviewAdjudications: this.reviewAdjudications};
  }

  assertReviewControlAllowsPublication(state) {
    const unresolved = [...state.reviewEvents.values()].some((event) =>
      event.disagreed && !state.reviewAdjudications.has(event.reviewEventId));
    if (unresolved) throw new Error('ship/no-ship disagreement requires founder adjudication before publication');
    return true;
  }

  async loadReadySubject(spec, missionDir, deadline) {
    const source = this.subjects.get(spec.mission_id);
    if (!source) throw new Error(`${spec.mission_id} is not in the rehearsal batch`);
    const journalFile = `/rehearsal/${source.id}/ship.journal.json`;
    return {
      spec: source.spec,
      missionDir,
      ready: `${missionDir}/ready-pack`,
      files: {},
      manifest: source.manifest,
      reviewRecords: source.reviewRecords,
      journal: this.journals.get(source.id) ?? null,
      journalFile,
      deadline,
    };
  }

  captureTransitions(id, journal) {
    const seen = this.seenTransitionCounts.get(journal) ?? 0;
    const values = journal.transitions ?? [];
    for (const transition of values.slice(seen)) this.transitions.push({mission_id: id, ...transition});
    this.seenTransitionCounts.set(journal, values.length);
  }

  async saveJournal(file, journal) {
    const id = this.journalIds.get(file);
    if (!id) throw new Error(`unexpected rehearsal journal path ${file}`);
    this.captureTransitions(id, journal);
    this.journals.set(id, journal);
  }

  async transition(subject, state, reason = null) {
    const journal = subject.journal;
    const at = new Date(Date.parse(APPROVED_AT) + this.transitions.length * 1000).toISOString();
    journal.state = state;
    journal.updated_at = at;
    journal.last_error = reason;
    if (['FAILED_INFRA_TERMINAL', 'ABORTED_STALE', 'ABORTED_BUDGET'].includes(state)) {
      journal.terminal_reason = reason;
    }
    journal.transitions = [...(journal.transitions ?? []), {state, at, ...(reason ? {reason} : {})}];
    await this.saveJournal(subject.journalFile, journal);
  }

  recordBatchTransition(state, details = {}) {
    this.transitions.push({mission_id: 'BATCH', state, ...details});
  }

  outbound(id) {
    this.outboundByMission.set(id, (this.outboundByMission.get(id) ?? 0) + 1);
  }

  async archiveTerminalJournal(subject) {
    return `ship-journal-archive/${subject.manifest.mission_id}-${this.journals.get(subject.manifest.mission_id).state}.json`;
  }

  async writeBatchApproval(_subjects, record) {
    const digest = record.approved_manifest_digest;
    const current = this.approvalRecords.get(digest);
    if (current && canonical(current) !== canonical(record)) throw new Error('existing rehearsal approval differs');
    if (!current) {
      this.approvalRecords.set(digest, record);
      this.externalActions.approvals += 1;
      this.recordBatchTransition('APPROVED', {digest});
    }
    return record;
  }

  async runIndependentBatch(items, worker) {
    const results = [];
    for (let index = 0; index < items.length; index += 1) results.push(await worker(items[index], index));
    return results;
  }

  async prePublicPushForBatch(subject) {
    const {state} = subject.journal;
    if (!['APPROVED', 'PRE_PUBLIC_RECHECK', 'PUSHED'].includes(state)) return {subject, ok: state === 'PUSHED'};
    if (state === 'APPROVED') await this.transition(subject, 'PRE_PUBLIC_RECHECK');
    if (subject.journal.state === 'PRE_PUBLIC_RECHECK') {
      if (this.staleIds.has(subject.manifest.mission_id)) {
        await this.transition(subject, 'ABORTED_STALE', 'rehearsal pre-public snapshot became stale');
        return {subject, ok: false};
      }
      this.outbound(subject.manifest.mission_id);
      await this.transition(subject, 'PUSHED');
    }
    return {subject, ok: subject.journal.state === 'PUSHED'};
  }

  async publishPreparedLedgerBatch(subjects, approvedDigest) {
    this.externalActions.prepared_ledger_prs += 1;
    if (this.ledgerChecksFail) {
      this.recordBatchTransition('LEDGER_GATE_FAILED', {digest: approvedDigest});
      throw new Error('rehearsal prepared-ledger checks failed');
    }
    this.preparedLedgers.add(approvedDigest);
    this.recordBatchTransition('PREPARED_LEDGER_PUBLISHED', {digest: approvedDigest});
    for (const subject of subjects) {
      this.outbound(subject.manifest.mission_id);
      subject.journal.ledger = {commit_sha: fixtureOid(subject.manifest.mission_id, 'prepared-ledger')};
      await this.transition(subject, 'PREPARED_RECEIPT_PUBLISHED');
    }
    return {accepted: subjects, rejected: [], published: {digest: approvedDigest}};
  }

  async verifyAttestationBatch(subjects) {
    if (!subjects.length) return [];
    const missing = subjects.filter((subject) => !this.signatures.has(subject.manifest.mission_id));
    if (!missing.length) return subjects.map((subject) => ({subject, ok: true}));
    this.externalActions.signing_batches += 1;
    let created = 0;
    for (const subject of missing) {
      if (!this.signingCrashConsumed && this.signingCrashAfter !== null && created === this.signingCrashAfter) {
        this.signingCrashConsumed = true;
        const result = {signatures: created, crashed: true};
        this.signingRuns.push(result);
        this.recordBatchTransition('SIGNING_CRASH', {completed: created});
        throw new Error(`rehearsal process crash after ${created} signatures`);
      }
      const id = subject.manifest.mission_id;
      this.signatures.add(id);
      this.outbound(id);
      this.transitions.push({mission_id: id, state: 'SIGNED'});
      created += 1;
    }
    this.signingRuns.push({signatures: created, crashed: false});
    for (const subject of subjects) await this.transition(subject, 'ATTESTED');
    return subjects.map((subject) => ({subject, ok: true}));
  }

  async waitForCanonicalReceiptsOnce(subjects) {
    if (!subjects.length) return;
    this.externalActions.pages_waits += 1;
    if (!this.pagesReady) {
      this.recordBatchTransition('PAGES_DELAYED');
      return;
    }
    this.recordBatchTransition('PAGES_READY');
    for (const subject of subjects) {
      subject.journal.ledger = {
        ...(subject.journal.ledger ?? {}),
        receipt_url: canonicalReceiptUrl(subject.manifest.mission_id),
        receipt_verified_at: APPROVED_AT,
      };
      await this.transition(subject, 'RECEIPT_AVAILABLE');
    }
  }

  expectedRemote(subject) {
    return {
      repository: subject.manifest.repo,
      manifest_digest: manifestDigest([subject.manifest]),
      head_oid: subject.manifest.commit_oid,
      body_sha256: subject.manifest.pr_body_sha256,
    };
  }

  assertExactRemote(subject, remote) {
    const expected = this.expectedRemote(subject);
    for (const [field, value] of Object.entries(expected)) {
      if (remote[field] !== value) throw new Error(`${subject.manifest.mission_id} remote PR ${field} is not exact`);
    }
    this.externalActions.remote_pr_validations += 1;
    this.remoteAdoptions += 1;
    this.transitions.push({mission_id: subject.manifest.mission_id, state: 'REMOTE_PR_VALIDATED'});
  }

  async processUpstreamMission(subject) {
    const id = subject.manifest.mission_id;
    if (subject.journal.state === 'RECEIPT_AVAILABLE') await this.transition(subject, 'PRE_PR_COLLISION_CHECK');
    if (subject.journal.state === 'PRE_PR_COLLISION_CHECK') {
      const remote = this.remotePrs.get(id);
      if (remote) {
        this.assertExactRemote(subject, remote);
        subject.journal.pr = {...remote.pr};
        await this.transition(subject, 'PR_OPENED');
      } else {
        this.externalActions.upstream_pr_creation_attempts += 1;
        this.outbound(id);
        if (this.failedPrIds.has(id) && !this.failedPrAttempts.has(id)) {
          this.failedPrAttempts.add(id);
          await this.transition(subject, 'FAILED_INFRA_TERMINAL', 'rehearsal upstream PR creation failed');
          return {mission_id: id, state: subject.journal.state, counted_receipt: false};
        }
        const number = Number(id.slice(2));
        const pr = {
          number,
          url: `https://github.com/${subject.manifest.repo}/pull/${number}`,
          head_oid: subject.manifest.commit_oid,
          body_sha256: subject.manifest.pr_body_sha256,
        };
        const exact = {...this.expectedRemote(subject), pr};
        this.remotePrs.set(id, exact);
        this.externalActions.upstream_pr_creations += 1;
        if (!this.prCrashConsumed && this.prCrashAfter !== null &&
            this.externalActions.upstream_pr_creations === this.prCrashAfter) {
          this.prCrashConsumed = true;
          this.recordBatchTransition('PR_CREATION_CRASH', {completed: this.prCrashAfter});
          throw new Error(`rehearsal process crash after upstream PR ${this.prCrashAfter}`);
        }
        subject.journal.pr = pr;
        await this.transition(subject, 'PR_OPENED');
      }
    }
    if (subject.journal.state === 'PR_OPENED') await this.transition(subject, 'DISCLOSURE_SYNCED');
    return {mission_id: id, state: subject.journal.state};
  }

  async publishFinalEnvelopeBatch(subjects, approvedDigest) {
    const eligible = subjects.filter((subject) =>
      ['DISCLOSURE_SYNCED', 'FINAL_ENVELOPE_PENDING_RECOVERY'].includes(subject.journal.state));
    if (!eligible.length) return null;
    this.externalActions.envelope_prs += 1;
    if (this.envelopeFails) {
      this.recordBatchTransition('ENVELOPE_PENDING_RECOVERY', {digest: approvedDigest});
      throw new Error('rehearsal final-envelope publication failed');
    }
    this.finalEnvelopes.push({digest: approvedDigest, mission_ids: eligible.map(({manifest}) => manifest.mission_id)});
    this.recordBatchTransition('ENVELOPE_PUBLISHED', {digest: approvedDigest});
    for (const subject of eligible) {
      const id = subject.manifest.mission_id;
      this.enveloped.add(id);
      this.outbound(id);
      await this.transition(subject, 'FINAL_ENVELOPE_PUBLISHED');
      await this.transition(subject, 'SHIPPED');
    }
    return {digest: approvedDigest};
  }

  loseRemotePrJournals() {
    for (const id of this.remotePrs.keys()) {
      const journal = this.journals.get(id);
      delete journal.pr;
      delete journal.disclosure;
      journal.state = 'PRE_PR_COLLISION_CHECK';
      journal.transitions = [...journal.transitions, {
        state: 'PRE_PR_COLLISION_CHECK',
        at: new Date(Date.parse(APPROVED_AT) + this.transitions.length * 1000).toISOString(),
        reason: 'rehearsal recovery from lost local PR journal',
      }];
      this.captureTransitions(id, journal);
    }
  }

  counters() {
    const latest = this.productionCounterRuns.at(-1);
    const shipped = latest?.A_SHIPPED_PUBLIC ?? 0;
    return {A_SHIPPED_PUBLIC: shipped, TOTAL_EXTERNAL_UNIQUE: shipped};
  }

  recordProductionResults(results) {
    const shipped = results.filter((result) => result.state === 'SHIPPED' && result.counted_receipt === true).length;
    this.productionCounterRuns.push({A_SHIPPED_PUBLIC: shipped, TOTAL_EXTERNAL_UNIQUE: shipped});
  }

  common(scenario) {
    return {
      scenario,
      production_entrypoint: 'shipBatch',
      external_actions: {...this.externalActions},
      counters: this.counters(),
      production_counter_runs: this.productionCounterRuns.map((value) => ({...value})),
      transitions: this.transitions.map(({at: _at, ...transition}) => transition),
      by_mission: Object.fromEntries(IDS.map((id) => {
        const journal = this.journals.get(id);
        return [id, {
          state: journal?.state ?? 'READY',
          outbound_actions: this.outboundByMission.get(id) ?? 0,
          transition_states: this.transitions.filter((item) => item.mission_id === id).map((item) => item.state),
        }];
      })),
      duplicate_prs: this.externalActions.upstream_pr_creations - this.remotePrs.size,
      ledger_records: {
        approvals: this.approvalRecords.size,
        prepared: this.preparedLedgers.size,
        envelopes: this.finalEnvelopes.length,
      },
    };
  }
}

function readyBatch() {
  const fixture = buildReviewedMissions();
  const adapter = new ProductionRehearsalAdapter(fixture);
  const items = fixture.subjects.map(({id, spec}) => ({spec, missionDir: `/rehearsal/${id}`}));
  return {fixture, adapter, items};
}

async function invoke(batch, shipBatchImpl, options = {}) {
  const results = await shipBatchImpl(batch.items, {
    approvedDigest: batch.fixture.approvedDigest,
    signedBatchApproval: batch.fixture.signedBatchApproval,
    reviewerRoster: batch.fixture.reviewerRoster,
    retryInfraTerminal: options.retryInfraTerminal ?? false,
    concurrency: 1,
    adapter: batch.adapter.operations(),
  });
  batch.adapter.recordProductionResults(results);
  return results;
}

export async function runRequiredBatchRehearsals({shipBatchImpl = productionShipBatch} = {}) {
  const reports = [];

  {
    const batch = readyBatch();
    await invoke(batch, shipBatchImpl);
    reports.push(batch.adapter.common('happy_path_25'));
  }
  {
    const batch = readyBatch();
    batch.adapter.staleIds.add('M-001');
    await invoke(batch, shipBatchImpl);
    reports.push(batch.adapter.common('stale_before_publication'));
  }
  {
    const batch = readyBatch();
    batch.adapter.ledgerChecksFail = true;
    await invoke(batch, shipBatchImpl);
    reports.push(batch.adapter.common('prepared_ledger_failure'));
  }
  {
    const batch = readyBatch();
    batch.adapter.signingCrashAfter = 20;
    let crash;
    try { await invoke(batch, shipBatchImpl); } catch (error) { crash = error.message; }
    const firstRun = batch.adapter.signingRuns.at(-1);
    batch.adapter.signingCrashAfter = null;
    await invoke(batch, shipBatchImpl);
    reports.push({...batch.adapter.common('signing_crash_20_of_25'), crash,
      first_run: firstRun, resume: batch.adapter.signingRuns.at(-1),
      total_unique_signatures: batch.adapter.signatures.size});
  }
  {
    const batch = readyBatch();
    batch.adapter.pagesReady = false;
    await invoke(batch, shipBatchImpl);
    const before = batch.adapter.externalActions.upstream_pr_creations;
    batch.adapter.pagesReady = true;
    await invoke(batch, shipBatchImpl);
    reports.push({...batch.adapter.common('pages_delayed'),
      before_ready: {upstream_pr_creations: before},
      after_ready: {upstream_pr_creations: batch.adapter.externalActions.upstream_pr_creations - before}});
  }
  {
    const batch = readyBatch();
    for (const id of ['M-003', 'M-014', 'M-025']) batch.adapter.failedPrIds.add(id);
    await invoke(batch, shipBatchImpl);
    const firstShipped = batch.adapter.counters().A_SHIPPED_PUBLIC;
    const beforeResume = batch.adapter.externalActions.upstream_pr_creations;
    await invoke(batch, shipBatchImpl, {retryInfraTerminal: true});
    reports.push({...batch.adapter.common('three_pr_creations_fail'),
      first_run: {shipped: firstShipped},
      resume: {shipped: batch.adapter.externalActions.upstream_pr_creations - beforeResume},
      recoverable_mission_ids: [...batch.adapter.failedPrAttempts].sort()});
  }
  {
    const batch = readyBatch();
    batch.adapter.prCrashAfter = 12;
    let crash;
    try { await invoke(batch, shipBatchImpl); } catch (error) { crash = error.message; }
    const firstCreated = batch.adapter.externalActions.upstream_pr_creations;
    batch.adapter.loseRemotePrJournals();
    batch.adapter.prCrashAfter = null;
    await invoke(batch, shipBatchImpl);
    reports.push({...batch.adapter.common('crash_after_pr_12'), crash,
      first_run: {upstream_pr_creations: firstCreated},
      resume: {upstream_pr_creations: batch.adapter.externalActions.upstream_pr_creations - firstCreated},
      remote_adoptions: batch.adapter.remoteAdoptions});
  }
  {
    const batch = readyBatch();
    batch.adapter.envelopeFails = true;
    await invoke(batch, shipBatchImpl);
    const state = batch.adapter.journals.get('M-001').state;
    batch.adapter.envelopeFails = false;
    await invoke(batch, shipBatchImpl);
    reports.push({...batch.adapter.common('envelope_publication_failure'), state,
      resume_state: batch.adapter.journals.get('M-001').state});
  }
  {
    const batch = readyBatch();
    await invoke(batch, shipBatchImpl);
    const before = {...batch.adapter.externalActions};
    await invoke(batch, shipBatchImpl);
    await invoke(batch, shipBatchImpl);
    const after = batch.adapter.externalActions;
    reports.push({...batch.adapter.common('command_rerun_twice'), rerun_action_delta:
      Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]))});
  }
  {
    const batch = readyBatch();
    batch.adapter.subjects.get('M-001').manifest.patch_sha256 = fixtureDigest('M-001', 'mutated-patch');
    let error = null;
    try { await invoke(batch, shipBatchImpl); } catch (caught) { error = caught.message; }
    batch.adapter.recordBatchTransition('APPROVAL_REJECTED', {error});
    reports.push({...batch.adapter.common('manifest_mutates_after_review'), approval_rejected: Boolean(error), error});
  }
  {
    const batch = readyBatch();
    batch.adapter.subjects.get('M-001').reviewRecords[0].disposition = 'HOLD';
    let error = null;
    try { await invoke(batch, shipBatchImpl); } catch (caught) { error = caught.message; }
    batch.adapter.recordBatchTransition('SHIPMENT_REJECTED', {error});
    reports.push({...batch.adapter.common('review_record_mutates'), shipment_rejected: Boolean(error), error});
  }
  return reports;
}

export async function writeBatchRehearsalReport(file, {generatedAt = new Date().toISOString()} = {}) {
  const scenarios = await runRequiredBatchRehearsals();
  const report = {
    schema_version: 2,
    kind: 'phase0_production_batch_rehearsal',
    generated_at: generatedAt,
    production_entrypoint: 'shipBatch',
    injected_rehearsal_adapters_only: true,
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
