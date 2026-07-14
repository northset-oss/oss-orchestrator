import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const digest = (char) => `sha256:${char.repeat(64)}`;
const oid = (char) => char.repeat(40);

function subject(id, repo) {
  return {
    schema_version: 1,
    mission_id: id,
    prepared_at: '2026-07-13T12:00:00Z',
    expires_at: '2026-07-13T20:00:00Z',
    repo,
    issue_url: `https://github.com/${repo}/issues/1`,
    base_branch: 'main',
    base_commit: oid('a'),
    commit_oid: oid('b'),
    patch_sha256: digest('c'),
    tested_tree_oid: oid('d'),
    bundle_digest: digest('e'),
    issue_snapshot_sha256: digest('f'),
    policy_snapshot_sha256: digest('1'),
    oracle_sha256: digest('2'),
    pr_title: 'fix: bounded bug',
    pr_body_sha256: digest('3'),
    planned_actions: [
      'push-reviewed-commit',
      'publish-prepared-receipt-pr', 'wait-prepared-receipt-checks', 'merge-prepared-receipt-pr',
      'verify-attestation', 'confirm-canonical-receipt-http-200', 'recheck-collision',
      'open-approved-upstream-pr', 'sync-guarded-pr-disclosure', 'record-pr-disclosure',
      'rebuild-full-ledger', 'publish-final-envelope-pr', 'wait-final-envelope-checks',
      'merge-final-envelope-pr',
    ],
  };
}

function economicSubject(id, repo) {
  return {
    ...subject(id, repo),
    schema_version: 2,
    task_id: 'TASK-OSS-0123456789ABCDEF',
    attempt_sequence: 1,
    work_category: 'defect_fix',
    economic_sha256: digest('4'),
  };
}

test('ship contract orders two gated ledger PRs around the upstream PR disclosure', async () => {
  const ship = await import('./ship.mjs');
  assert.deepEqual(ship.PLANNED_ACTIONS, subject('M-021', 'one/repo').planned_actions);
  const calls = [];
  const journal = ship.newJournal(subject('M-021', 'one/repo'), digest('a'), digest('b'));
  const actions = {
    deadline: {expired: () => false},
    save: async () => {},
    preflight: async () => calls.push('local-preflight'),
    prePublicRecheck: async () => { calls.push('pre-public'); return {clean: true}; },
    push: async () => calls.push('push'),
    publishPreparedReceipt: async () => calls.push('prepared-ledger-pr'),
    attest: async () => calls.push('attest'),
    confirmReceipt: async () => calls.push('receipt-200'),
    prePrCollisionCheck: async () => { calls.push('collision'); return {clean: true}; },
    openPr: async () => calls.push('upstream-pr'),
    syncDisclosure: async () => calls.push('disclosure-sync'),
    publishFinalEnvelope: async () => calls.push('final-ledger-pr'),
    publishNotSubmitted: async () => calls.push('not-submitted'),
  };
  const result = await ship.runShipStateMachine({manifest: {mission_id: 'M-021'}}, journal, actions);
  assert.equal(result.state, 'SHIPPED');
  assert.deepEqual(calls, [
    'local-preflight', 'pre-public', 'push', 'prepared-ledger-pr', 'attest', 'receipt-200', 'collision',
    'upstream-pr', 'disclosure-sync', 'final-ledger-pr',
  ]);
});

test('approval journal records the explicit human actor and exact approval time', async () => {
  const ship = await import('./ship.mjs');
  const approvedAt = new Date('2026-07-15T11:45:00Z');
  const journal = ship.newJournal(
    economicSubject('M-021', 'one/repo'), digest('a'), digest('b'), approvedAt,
    {approvedBy: 'internal-user:aeziz'},
  );
  assert.equal(journal.approved_by, 'internal-user:aeziz');
  assert.equal(journal.approved_at, approvedAt.toISOString());
  const approval = ship.approvalRecord({
    spec: {
      schema_version: 2,
      mission_id: 'M-021',
      task_id: 'TASK-OSS-0123456789ABCDEF',
      attempt_sequence: 1,
    },
    manifest: economicSubject('M-021', 'one/repo'),
    journal,
  });
  assert.equal(approval.task_id, 'TASK-OSS-0123456789ABCDEF');
  assert.equal(approval.approved_manifest_digest, digest('a'));
  assert.equal(approval.approved_by, 'internal-user:aeziz');
  assert.equal(approval.operational_caps.prepare_wall_seconds, 3600);
  assert.equal(approval.operational_caps.ship_wall_seconds, 3600);
});

test('a failed guarded synchronization restores the original publication bytes', async () => {
  const ship = await import('./ship.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-publication-rollback-'));
  const file = path.join(root, 'publication.json');
  await writeFile(file, '{"state":"prepared"}\n');
  await assert.rejects(() => ship.withFileRollback(file, async () => {
    await writeFile(file, '{"state":"open"}\n');
    throw new Error('guarded synchronization failed');
  }), /guarded synchronization failed/);
  assert.equal(await readFile(file, 'utf8'), '{"state":"prepared"}\n');
});

test('prepared destination hashing finishes before its temporary copy is removed', async () => {
  const ship = await import('./ship.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-prepared-digest-'));
  const destination = path.join(root, 'mission');
  await mkdir(path.join(destination, 'bundle'), {recursive: true});
  await chmod(destination, 0o700);
  await chmod(path.join(destination, 'bundle'), 0o700);
  await writeFile(path.join(destination, 'bundle', 'claims_tier.txt'), '');
  await writeFile(path.join(destination, 'publication.json'), '{"state":"prepared"}\n');
  await writeFile(path.join(destination, 'approval.json'), '{"approved_by":"internal-user:operator"}\n');
  const first = await ship.preparedDestinationDigest(destination);
  await chmod(destination, 0o755);
  await chmod(path.join(destination, 'bundle'), 0o755);
  assert.equal(await ship.preparedDestinationDigest(destination), first);
  await writeFile(path.join(destination, 'publication.json'), '{"state":"open"}\n');
  assert.equal(await ship.preparedDestinationDigest(destination), first);
  await writeFile(path.join(destination, 'approval.json'), '{"approved_by":"internal-user:changed"}\n');
  assert.equal(await ship.preparedDestinationDigest(destination), first);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
});

test('ledger check discovery retries only GitHub check-registration lag', async () => {
  const ship = await import('./ship.mjs');
  assert.equal(ship.ledgerChecksRegistered({
    code: 1, stdout: '', stderr: "no checks reported on the 'northset/m-021-prepared' branch",
  }), false);
  assert.equal(ship.ledgerChecksRegistered({
    code: 0, stdout: '[{"name":"test","state":"PENDING"}]\n', stderr: '',
  }), true);
  assert.throws(() => ship.ledgerChecksRegistered({
    code: 1, stdout: '', stderr: 'HTTP 503 from GitHub',
  }), /required ledger check discovery failed: HTTP 503/);
  assert.equal(ship.ledgerCheckOutcome({
    code: 0, stdout: '[{"name":"test","state":"IN_PROGRESS","bucket":"pending"}]', stderr: '',
  }), 'pending');
  assert.equal(ship.ledgerCheckOutcome({
    code: 0, stdout: '[{"name":"test","state":"SUCCESS","bucket":"pass"}]', stderr: '',
  }), 'success');
  assert.throws(() => ship.ledgerCheckOutcome({
    code: 0, stdout: '[{"name":"test","state":"FAILURE","bucket":"fail"}]', stderr: '',
  }), /required ledger checks failed: test \(FAILURE\)/);
});

test('prepared publication is complete but has no PR or pending attestation facts', async () => {
  const ship = await import('./ship.mjs');
  const value = ship.preparedPublication(subject('M-021', 'one/repo'), new Date('2026-07-14T12:00:00Z'));
  assert.deepEqual(value, {
    schema_version: 1, mission_id: 'M-021', state: 'prepared',
    pr_number: null, pr_url: null, pr_head_oid: null, base_branch: null,
    head_drift: false, ci_state: null, merge_commit_oid: null, review_decision: null,
    decision_url: null, opened_at: null, closed_at: null, updated_at: null,
    observed_at: null, correction_note: null, scope_note: null,
    attestation_uri: null, bundle_digest: digest('e'), release_asset_sha256: null,
    attestation_verified_at: null,
  });
});

test('final publication records observation, attestation, scope, and pending CI when no checks exist', async () => {
  const ship = await import('./ship.mjs');
  const projected = ship.publicationFromPr({
    mission_id: 'M-021', patch_commit: oid('b'), attestation_uri: 'https://example.test/asset',
    run_record_bundle_digest: digest('e'), release_asset_sha256: digest('f'),
    attestation_verified_at: '2026-07-14T12:01:00Z', scope_note: 'Focused verification only.',
  }, {
    number: 21, url: 'https://github.com/one/repo/pull/21', state: 'OPEN',
    headRefOid: oid('b'), baseRefName: 'main', createdAt: '2026-07-14T12:02:00Z',
    closedAt: null, mergedAt: null, updatedAt: '2026-07-14T12:03:00Z',
    reviewDecision: null, mergeCommit: null, statusCheckRollup: [],
  }, null, new Date('2026-07-14T12:04:00Z'));
  assert.equal(projected.ci_state, 'pending');
  assert.equal(projected.observed_at, '2026-07-14T12:04:00.000Z');
  assert.equal(projected.scope_note, 'Focused verification only.');
  assert.equal(projected.release_asset_sha256, digest('f'));
  assert.equal(projected.attestation_verified_at, '2026-07-14T12:01:00Z');
  assert.equal(ship.publicationScopeNote({
    limitations: [
      'Does not prove code quality',
      'The focused regression does not navigate the full application router in a browser.',
      "Contributor self-run record of Northset's own contribution; not the maintainer's verification.",
    ],
  }), 'The focused regression does not navigate the full application router in a browser.');
});

test('publication projection treats attestation evidence as one complete tuple', async () => {
  const ship = await import('./ship.mjs');
  const complete = {
    attestation_uri: 'https://github.com/northset-oss/verification-pilot/releases/download/run-record-M-021-eeeeeeeeeeee/run-record-M-021-eeeeeeeeeeee.tar.gz',
    release_asset_sha256: digest('f'),
    attestation_verified_at: '2026-07-14T12:01:00Z',
  };
  assert.deepEqual(ship.publicationAttestationEvidence(complete, null), complete);
  assert.deepEqual(ship.publicationAttestationEvidence(complete, {
    state: 'prepared', attestation_uri: null, release_asset_sha256: null, attestation_verified_at: null,
  }), complete);
  assert.throws(() => ship.publicationAttestationEvidence({
    ...complete, release_asset_sha256: null, attestation_verified_at: null,
  }, {
    state: 'prepared', attestation_uri: null, release_asset_sha256: null, attestation_verified_at: null,
  }), /complete attestation evidence/i);
});

test('attestation selection prefers success and treats same-head skipped runs as noise', async () => {
  const ship = await import('./ship.mjs');
  const runs = [
    {databaseId: 1, headSha: oid('a'), status: 'completed', conclusion: 'skipped'},
    {databaseId: 2, headSha: oid('a'), status: 'completed', conclusion: 'success'},
  ];
  assert.deepEqual(ship.workflowRunOutcome(runs, oid('a')), {status: 'success', runId: 2});
  assert.deepEqual(ship.workflowRunOutcome(runs.slice(0, 1), oid('a')), {status: 'pending'});
});

test('a changed manifest archives a terminal attempt while the same terminal manifest stays terminal', async () => {
  const ship = await import('./ship.mjs');
  const existing = {
    state: 'FAILED_INFRA_TERMINAL', approved_manifest: digest('a'), mission_manifest: digest('b'),
  };
  assert.equal(ship.terminalJournalDisposition(existing, digest('a'), digest('b')), 'terminal');
  assert.equal(ship.terminalJournalDisposition(
    existing, digest('a'), digest('b'), {retryInfraTerminal: true},
  ), 'archive-and-retry');
  assert.equal(ship.terminalJournalDisposition(existing, digest('c'), digest('d')), 'archive-and-restart');
  assert.equal(ship.terminalJournalDisposition(existing, digest('c'), digest('b')), 'terminal');
  assert.deepEqual(existing, {
    state: 'FAILED_INFRA_TERMINAL', approved_manifest: digest('a'), mission_manifest: digest('b'),
  });
});

test('an explicit infrastructure retry resumes after the last completed state and preserves evidence', async () => {
  const ship = await import('./ship.mjs');
  const prior = {
    ...ship.newJournal(subject('M-021', 'one/repo'), digest('a'), digest('b'), new Date('2026-07-14T12:00:00Z')),
    state: 'FAILED_INFRA_TERMINAL', retry_count: 1, terminal_reason: 'checks lagged',
    transitions: [
      {state: 'APPROVED', at: '2026-07-14T12:00:00Z'},
      {state: 'DISCLOSURE_SYNCED', at: '2026-07-14T12:05:00Z'},
      {state: 'FAILED_INFRA_TERMINAL', at: '2026-07-14T12:06:00Z'},
    ],
    fork: {branch: 'northset/M-021'}, ledger: {commit_sha: oid('c')},
    pr: {url: 'https://github.com/one/repo/pull/21'}, disclosure: {verified_at: '2026-07-14T12:05:00Z'},
  };
  const retried = ship.retryJournal(prior, subject('M-021', 'one/repo'), digest('a'), digest('b'),
    'ship-journal-archive/prior.json', new Date('2026-07-14T12:07:00Z'));
  assert.equal(retried.state, 'DISCLOSURE_SYNCED');
  assert.equal(retried.retry_count, 0);
  assert.deepEqual(retried.pr, prior.pr);
  assert.deepEqual(retried.disclosure, prior.disclosure);
  assert.equal(retried.prior_attempt.archive_file, 'ship-journal-archive/prior.json');
});

test('a final envelope already merged on main is adopted only when its exact bytes match', async () => {
  const ship = await import('./ship.mjs');
  const publication = Buffer.from('{"state":"open"}\n');
  assert.equal(ship.samePublishedEnvelope(publication, Buffer.from(publication)), true);
  assert.equal(ship.samePublishedEnvelope(publication, Buffer.from('{"state":"prepared"}\n')), false);
});

test('ledger publication stages the whole generated site and never targets main directly', async () => {
  const ship = await import('./ship.mjs');
  assert.deepEqual(ship.ledgerPaths('M-021'), ['missions/M-021', 'missions/index.json', 'site']);
  assert.equal(ship.ledgerBranch('M-021', 'prepared'), 'northset/m-021-prepared');
  assert.notEqual(ship.ledgerBranch('M-021', 'prepared'), 'main');
  assert.deepEqual(ship.disclosureSyncArgs('/ledger', 'M-021', 'https://github.com/one/repo/pull/21', '2026-07-14T12:00:00Z'), [
    '/ledger/bin/pr-receipt-disclosure.mjs', 'sync', '--policy',
    '/ledger/policies/pr_receipt_disclosure_policy.json', '--mission-dir', '/ledger/missions/M-021',
    '--apply', '--confirm-pr-url', 'https://github.com/one/repo/pull/21', '--now',
    '2026-07-14T12:00:00Z', '--json',
  ]);
});

test('batch approval is checked once and enforces the three-distinct-repository cap', async () => {
  const ship = await import('./ship.mjs');
  assert.equal(typeof ship.validateApprovedBatch, 'function');
  const subjects = [subject('M-016', 'one/repo'), subject('M-017', 'two/repo')];
  const digestValue = ship.batchManifestDigest(subjects);
  assert.deepEqual(ship.validateApprovedBatch(subjects, digestValue), subjects);
  assert.throws(() => ship.validateApprovedBatch(subjects, digest('9')), /approval/i);
  assert.throws(() => ship.validateApprovedBatch([...subjects, subject('M-018', 'one/repo')], ship.batchManifestDigest([...subjects, subject('M-018', 'one/repo')])), /repository/i);
  const four = [...subjects, subject('M-018', 'three/repo'), subject('M-019', 'four/repo')];
  assert.throws(() => ship.validateApprovedBatch(four, ship.batchManifestDigest(four)), /three/i);
});

test('journal loading treats only ENOENT as empty and rejects corruption', async () => {
  const ship = await import('./ship.mjs');
  assert.equal(typeof ship.loadJournal, 'function');
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-journal-test-'));
  const file = path.join(root, 'ship.journal.json');
  assert.equal(await ship.loadJournal(file), null);
  await writeFile(file, '{broken');
  await assert.rejects(() => ship.loadJournal(file), /JSON|journal/i);
});

test('journal writes are atomic and bound to the active manifest and bundle', async () => {
  const ship = await import('./ship.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-journal-test-'));
  const file = path.join(root, 'ship.journal.json');
  const journal = {approved_manifest: digest('a'), bundle_digest: digest('b')};
  await ship.saveJournal(file, journal);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), journal);
  assert.doesNotThrow(() => ship.assertJournalBinding(journal, digest('a'), digest('b')));
  assert.throws(() => ship.assertJournalBinding(journal, digest('c'), digest('b')), /manifest/i);
});

test('an existing same-named repository must be the intended upstream fork', async () => {
  const ship = await import('./ship.mjs');
  assert.equal(ship.assertForkParent({
    full_name: 'AysajanE/repo', fork: true, parent: {full_name: 'owner/repo'},
  }, 'owner/repo'), true);
  assert.throws(() => ship.assertForkParent({
    full_name: 'AysajanE/repo', fork: false, parent: null,
  }, 'owner/repo'), /not a fork/i);
  assert.throws(() => ship.assertForkParent({
    full_name: 'AysajanE/repo', fork: true, parent: {full_name: 'another/repo'},
  }, 'owner/repo'), /not a fork/i);
});

test('status projection records closed state, CI, merge/head evidence, and the M-015 correction', async () => {
  const ship = await import('./ship.mjs');
  const mission = {
    mission_id: 'M-015', patch_commit: oid('a'),
    attestation_uri: 'https://github.com/northset-oss/verification-pilot/releases/x',
    run_record_bundle_digest: digest('b'),
    release_asset_sha256: digest('c'),
    attestation_verified_at: '2026-07-13T00:00:00Z',
  };
  const projected = ship.publicationFromPr(mission, {
    number: 9, url: 'https://github.com/owner/repo/pull/9', state: 'CLOSED',
    headRefOid: oid('c'), baseRefName: 'main', createdAt: '2026-07-12T00:00:00Z',
    closedAt: '2026-07-13T00:00:00Z', mergedAt: null, updatedAt: '2026-07-13T00:00:00Z',
    reviewDecision: 'CHANGES_REQUESTED', mergeCommit: null,
    statusCheckRollup: [{status: 'COMPLETED', conclusion: 'FAILURE'}],
  });
  assert.equal(projected.state, 'closed_unmerged');
  assert.equal(projected.ci_state, 'failure');
  assert.equal(projected.review_decision, 'changes_requested');
  assert.equal(projected.head_drift, true);
  assert.match(projected.correction_note, /compile-typescript was run/);
  assert.equal(ship.ciState([{__typename: 'StatusContext', state: 'SUCCESS'}]), 'success');
  assert.equal(ship.ciState([{__typename: 'CheckRun', status: 'COMPLETED', conclusion: 'STALE'}]), 'pending');
});

test('status reconciliation preserves direct decision evidence while the decision is unchanged', async () => {
  const ship = await import('./ship.mjs');
  const prUrl = 'https://github.com/owner/repo/pull/9';
  const decisionUrl = `${prUrl}#pullrequestreview-123`;
  const mission = {
    mission_id: 'M-020', patch_commit: oid('a'),
    attestation_uri: 'https://github.com/northset-oss/verification-pilot/releases/x',
    run_record_bundle_digest: digest('b'), release_asset_sha256: digest('c'),
    attestation_verified_at: '2026-07-13T00:00:00Z',
  };
  const pr = {
    number: 9, url: prUrl, state: 'OPEN', headRefOid: oid('a'), baseRefName: 'main',
    createdAt: '2026-07-12T00:00:00Z', closedAt: null, mergedAt: null,
    updatedAt: '2026-07-13T00:00:00Z', reviewDecision: 'CHANGES_REQUESTED',
    mergeCommit: null, statusCheckRollup: [],
  };
  const unchanged = ship.publicationFromPr(mission, pr, {
    review_decision: 'changes_requested', decision_url: decisionUrl,
  });
  assert.equal(unchanged.decision_url, decisionUrl);

  const changed = ship.publicationFromPr(mission, {...pr, reviewDecision: 'APPROVED'}, {
    review_decision: 'changes_requested', decision_url: decisionUrl,
  });
  assert.equal(changed.decision_url, prUrl);
});

test('status reconciliation resynchronizes disclosure when upstream state changes', async () => {
  const ship = await import('./ship.mjs');
  const previous = {
    state: 'open', observed_at: '2026-07-14T12:00:00Z',
    pr_disclosure: {schema_version: 1, required: true, mode: 'pr_body', canonical_url: 'x', verified_at: '2026-07-14T12:00:00Z'},
  };
  assert.equal(ship.shouldSyncPublication(previous, {...previous, observed_at: '2026-07-14T12:01:00Z'}), false);
  assert.equal(ship.shouldSyncPublication(previous, {...previous, state: 'merged', observed_at: '2026-07-14T12:01:00Z'}), true);
  assert.equal(ship.shouldSyncPublication({...previous, pr_disclosure: undefined}, previous), true);
  assert.equal(ship.shouldSyncPublication(
    {...previous, pr_disclosure: undefined},
    {...previous, pr_disclosure: undefined, observed_at: '2026-07-14T12:01:00Z'},
    {disclosureRequired: false},
  ), false);
  assert.equal(ship.shouldSyncPublication(
    {...previous, pr_disclosure: undefined},
    {...previous, pr_disclosure: undefined, state: 'merged', observed_at: '2026-07-14T12:01:00Z'},
    {disclosureRequired: false},
  ), true);
});

test('ship budget covers the two ledger gates, attestation, and Pages deployment', async () => {
  const ship = await import('./ship.mjs');
  assert.equal(ship.SHIP_BUDGET_MS, 60 * 60 * 1000);
});
