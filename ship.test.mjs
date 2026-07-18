import assert from 'node:assert/strict';
import {chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {reviewPatch} from './review-patch.mjs';
import {OSS_IDENTITY, canonical, directoryDigest, ghRequestClass, git, recheck, sha256} from './core.mjs';
import {GitHubThrottleError} from './gh-gateway.mjs';

const digest = (char) => `sha256:${char.repeat(64)}`;
const oid = (char) => char.repeat(40);

test('GitHub command routing classifies reads and mutations and has no direct gh spawn', async () => {
  assert.equal(ghRequestClass(['pr', 'list', '--repo', 'owner/repo']), 'rest_read');
  assert.equal(ghRequestClass(['api', 'graphql', '-f', 'query=query{viewer{login}}']), 'graphql');
  assert.equal(ghRequestClass(['pr', 'create', '--repo', 'owner/repo']), 'mutation');
  const [coreSource, reviewSource, shipSource] = await Promise.all([
    readFile(new URL('./core.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./review-issue.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./ship.mjs', import.meta.url), 'utf8'),
  ]);
  for (const source of [coreSource, reviewSource, shipSource]) {
    assert.doesNotMatch(source, /\brun\(['"]gh['"]/);
  }
  assert.match(shipSource, /download public attestation bundle', await shipRun\(deadline, 'gh'/);
  assert.doesNotMatch(shipSource, /shipGit\([^\n]*'push'/);
  assert.match(coreSource, /\['pr', 'list',[^\n]*'--limit', '100'/);
  assert.doesNotMatch(coreSource, /'--limit', '500'/);
});

test('live recheck never falls back after a gateway throttle stop', async () => {
  const throttle = Object.create(GitHubThrottleError.prototype);
  Object.defineProperty(throttle, 'message', {value: 'secondary rate limit', configurable: true});
  let calls = 0;
  await assert.rejects(() => recheck({candidate: 'owner/repo#1'}, async () => {}, {
    repoPolicy: {repositories: {}},
    gh: async () => {
      calls += 1;
      throw throttle;
    },
  }), (error) => error === throttle);
  assert.equal(calls, 1);
});

test('every outbound git push is authorized and finalized under the gateway lock', async () => {
  const ship = await import('./ship.mjs');
  const events = [];
  const result = await ship.guardedGitPush(null, '/tmp/offline-repo', 'owner/repo', [
    'origin', 'HEAD:refs/heads/test',
  ], {
    withGatewayLock: async (options, operation) => {
      events.push(['lock', options]);
      try { return await operation(); }
      finally { events.push(['unlock']); }
    },
    assertNetworkAllowed: async (options) => events.push(['assert', options]),
    runCommand: async (deadline, commandName, args) => {
      events.push(['run', deadline, commandName, args]);
      return {code: 0, stdout: '', stderr: ''};
    },
    recordTransportResult: async (transport, options) => events.push(['transport', transport, options]),
  });
  assert.equal(result.code, 0);
  assert.deepEqual(events.map(([event]) => event), ['lock', 'assert', 'run', 'transport', 'unlock']);
  assert.equal(events[1][1].gatewayLockHeld, true);
  assert.deepEqual(events[2][3], [
    '-C', '/tmp/offline-repo', 'push', 'origin', 'HEAD:refs/heads/test',
  ]);
  assert.deepEqual(events[3][1], {
    class: 'git_push',
    repoTarget: 'owner/repo',
    result: {code: 0, stdout: '', stderr: ''},
  });
  assert.equal(events[3][2].gatewayLockHeld, true);
  assert.equal(JSON.stringify(events[3]).includes('HEAD:refs/heads/test'), false);
});

test('git push secondary-limit output trips gateway latch, breaker, and campaign incident', async (t) => {
  const ship = await import('./ship.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-ship-push-throttle-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const gatewayOptions = {
    stateDir: path.join(root, 'gateway'),
    resourceControlFile: path.join(root, 'phase0', 'resource-control.json'),
    controlStateFile: path.join(root, 'phase1', 'control-state.json'),
    ledgerFile: path.join(root, 'gh-request-ledger.jsonl'),
    testMode: true,
    now: () => Date.parse('2026-07-18T12:14:00.000Z'),
    timing: {minSpacingMs: 0, searchSpacingMs: 0, mutationSpacingMs: 0, jitterMaxMs: 0},
  };
  const secondaryLimit = await readFile(
    new URL('./campaign/phase1/fixtures/github-secondary-rate-limit-20260718.json', import.meta.url),
    'utf8',
  );

  await assert.rejects(() => ship.guardedGitPush(
    null,
    '/tmp/offline-repo',
    'owner/repo',
    ['origin', 'HEAD:refs/heads/test'],
    {
      gatewayOptions,
      runCommand: async () => ({code: 0, stdout: secondaryLimit, stderr: ''}),
    },
  ), (error) => error?.code === 'GITHUB_PROVIDER_THROTTLED' &&
    error?.signal === 'GITHUB_SECONDARY_RATE_LIMIT');

  const [gateway, resourceControl, campaignControl] = await Promise.all([
    readFile(path.join(gatewayOptions.stateDir, 'state.json'), 'utf8').then(JSON.parse),
    readFile(gatewayOptions.resourceControlFile, 'utf8').then(JSON.parse),
    readFile(gatewayOptions.controlStateFile, 'utf8').then(JSON.parse),
  ]);
  const incident = campaignControl.incidents.find((item) =>
    item.incident_id === gateway.provider_pause.incident_id);
  assert.ok(incident, 'campaign incident must bind to the gateway incident ID');
  assert.equal(gateway.provider_pause.signal, 'GITHUB_SECONDARY_RATE_LIMIT');
  assert.equal(resourceControl.provider_pause.incident_id, gateway.provider_pause.incident_id);
  assert.equal(resourceControl.provider_pause.signal, gateway.provider_pause.signal);
  assert.equal(resourceControl.provider_pause.tripped_at, gateway.provider_pause.tripped_at);
  assert.equal(incident.signal, gateway.provider_pause.signal);
  assert.equal(incident.tripped_at, gateway.provider_pause.tripped_at);
  assert.equal(gateway.pending_incident, null);
  assert.equal(gateway.last_request_at_ms, Date.parse('2026-07-18T12:14:00.000Z'));
});

test('git remote-helper 429 still latches every throttle record when the transport ledger is unwritable', async (t) => {
  const ship = await import('./ship.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-ship-push-ledger-failure-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const gatewayOptions = {
    stateDir: path.join(root, 'gateway'),
    resourceControlFile: path.join(root, 'phase0', 'resource-control.json'),
    controlStateFile: path.join(root, 'phase1', 'control-state.json'),
    ledgerFile: path.join(root, 'unwritable-ledger'),
    testMode: true,
    now: () => Date.parse('2026-07-18T12:15:00.000Z'),
    timing: {minSpacingMs: 0, searchSpacingMs: 0, mutationSpacingMs: 0, jitterMaxMs: 0},
  };
  await mkdir(gatewayOptions.ledgerFile);
  let throttle;
  try {
    await ship.guardedGitPush(
      null,
      '/tmp/offline-repo',
      'owner/repo',
      ['origin', 'HEAD:refs/heads/test'],
      {
        gatewayOptions,
        runCommand: async () => ({
          code: 128,
          stdout: '',
          stderr: 'fatal: unable to access remote: The requested URL returned error: 429',
        }),
      },
    );
  } catch (error) {
    throttle = error;
  }
  assert.ok(throttle instanceof GitHubThrottleError);
  assert.equal(throttle.signal, 'HTTP_429');
  assert.equal(throttle.cause?.code, 'EISDIR');
  const [gateway, resourceControl, campaignControl] = await Promise.all([
    readFile(path.join(gatewayOptions.stateDir, 'state.json'), 'utf8').then(JSON.parse),
    readFile(gatewayOptions.resourceControlFile, 'utf8').then(JSON.parse),
    readFile(gatewayOptions.controlStateFile, 'utf8').then(JSON.parse),
  ]);
  assert.equal(gateway.provider_pause.signal, 'HTTP_429');
  assert.equal(gateway.pending_incident, null);
  assert.equal(resourceControl.provider_pause.incident_id, gateway.provider_pause.incident_id);
  assert.ok(campaignControl.incidents.some((incident) =>
    incident.incident_id === gateway.provider_pause.incident_id));
});

test('ship never retries or aggregates past a terminal GitHub gateway stop', async () => {
  const {runIndependentBatch, runShipStateMachine} = await import('./ship.mjs');
  const throttle = new GitHubThrottleError('GitHub secondary rate limit stopped the gateway');
  let calls = 0;
  const journal = {state: 'APPROVED', retry_count: 0, transitions: []};
  await assert.rejects(() => runShipStateMachine({manifest: {mission_id: 'M-THROTTLE'}}, journal, {
    deadline: {expired: () => false},
    save: async () => {},
    preflight: async () => { calls += 1; throw throttle; },
  }), (error) => error === throttle);
  assert.equal(calls, 1);
  assert.equal(journal.retry_count, 0);
  assert.equal(journal.state, 'APPROVED');

  await assert.rejects(() => runIndependentBatch([{id: 'M-THROTTLE'}], async () => {
    throw throttle;
  }), (error) => error === throttle);
});

test('shipBatch real rate-safety gate cannot be disabled by adapter overrides', async (t) => {
  const {shipBatch} = await import('./ship.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-ship-rate-gate-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const resourceControlFile = path.join(root, 'phase0', 'resource-control.json');
  await mkdir(path.dirname(resourceControlFile), {recursive: true});
  await writeFile(resourceControlFile, `${JSON.stringify({
    schema_version: 1,
    provider_pause: {
      kind: 'PROVIDER_THROTTLED',
      provider: 'GitHub',
      signal: 'GITHUB_SECONDARY_RATE_LIMIT',
      tripped_at: '2026-07-18T12:00:00.000Z',
      auto_resume: false,
    },
    exception_task_ids: [],
    active_exception: null,
  })}\n`);
  let overrideCalls = 0;
  await assert.rejects(() => shipBatch([], {
    adapter: {
      assertGhRateSafetyAllowsAction: async () => {
        overrideCalls += 1;
        return true;
      },
    },
    gatewayOptions: {
      stateDir: path.join(root, 'gateway'),
      resourceControlFile,
      controlStateFile: path.join(root, 'phase1', 'control-state.json'),
      ledgerFile: path.join(root, 'gh-request-ledger.jsonl'),
    },
  }), /persistent provider-throttle breaker is active/i);
  assert.equal(overrideCalls, 0);
});

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
      'publish-prepared-ledger-batch', 'wait-prepared-ledger-checks', 'merge-prepared-ledger-batch',
      'verify-batch-attestations', 'wait-pages-readiness-once', 'confirm-individual-receipt-http-200', 'recheck-collision',
      'open-approved-upstream-pr', 'sync-guarded-pr-disclosure', 'record-pr-disclosure',
      'rebuild-full-ledger', 'publish-final-envelope-batch', 'wait-final-envelope-batch-checks',
      'merge-final-envelope-batch',
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
  assert.equal(approval.batch_approval_record_sha256, null);
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

test('release asset download falls back only for GitHub REST 503', async () => {
  const ship = await import('./ship.mjs');
  assert.equal(ship.releaseAssetUrl('run-record-M-176-abc', 'M-176-abc.tar.gz'),
    'https://github.com/northset-oss/verification-pilot/releases/download/run-record-M-176-abc/M-176-abc.tar.gz');
  assert.equal(ship.shouldFallbackReleaseDownload({code: 1, stdout: '', stderr: 'HTTP 503: 503 Service Unavailable'}), true);
  assert.equal(ship.shouldFallbackReleaseDownload({code: 1, stdout: '', stderr: 'HTTP 404: Not Found'}), false);
  assert.equal(ship.publicAttestationApiUrl('sha256:abc'),
    'https://api.github.com/repos/northset-oss/verification-pilot/attestations/sha256:abc?per_page=30&predicate_type=https%3A%2F%2Fslsa.dev%2Fprovenance%2Fv1');
  assert.equal(ship.decodeSnappyBlock(Buffer.from([
    9,
    8, 97, 98, 99,
    22, 3, 0,
  ])).toString('utf8'), 'abcabcabc');
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
  assert.equal(ship.terminalJournalDisposition(
    existing, digest('c'), digest('b'), {retryInfraTerminal: true},
  ), 'reject');
  assert.deepEqual(existing, {
    state: 'FAILED_INFRA_TERMINAL', approved_manifest: digest('a'), mission_manifest: digest('b'),
  });
});

test('an explicit infrastructure retry resumes after the last completed state and preserves evidence', async () => {
  const ship = await import('./ship.mjs');
  const originalApproval = new Date('2026-07-14T12:00:00Z');
  const prior = {
    ...ship.newJournal(subject('M-021', 'one/repo'), digest('a'), digest('b'), originalApproval,
      {approvedBy: 'internal-user:original'}),
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
    'ship-journal-archive/prior.json', {
      approvedBy: 'internal-user:original', approvedAt: originalApproval,
      retriedAt: new Date('2026-07-14T12:07:00Z'),
    });
  assert.equal(retried.state, 'DISCLOSURE_SYNCED');
  assert.equal(retried.retry_count, 0);
  assert.equal(retried.approved_by, 'internal-user:original');
  assert.equal(retried.approved_at, originalApproval.toISOString());
  assert.equal(retried.started_at, '2026-07-14T12:07:00.000Z');
  assert.deepEqual(retried.pr, prior.pr);
  assert.deepEqual(retried.disclosure, prior.disclosure);
  assert.equal(retried.prior_attempt.archive_file, 'ship-journal-archive/prior.json');
  const currentApproval = new Date('2026-07-14T12:08:00Z');
  const reapproved = ship.retryJournal(prior, subject('M-021', 'one/repo'), digest('c'), digest('b'),
    'ship-journal-archive/reapproved.json', {
      approvedBy: 'internal-user:current', approvedAt: currentApproval,
      retriedAt: new Date('2026-07-14T12:09:00Z'),
    });
  assert.equal(reapproved.approved_manifest, digest('c'));
  assert.equal(reapproved.approved_by, 'internal-user:current');
  assert.equal(reapproved.approved_at, currentApproval.toISOString());
  assert.equal(reapproved.transitions[0].at, '2026-07-14T12:09:00.000Z');
});

test('a final envelope already merged on main is adopted only when its exact bytes match', async () => {
  const ship = await import('./ship.mjs');
  const publication = Buffer.from('{"state":"open"}\n');
  assert.equal(ship.samePublishedEnvelope(publication, Buffer.from(publication)), true);
  assert.equal(ship.samePublishedEnvelope(publication, Buffer.from('{"state":"prepared"}\n')), false);
});

test('an already-merged prepared batch is adopted only from its exact branch', async () => {
  const ship = await import('./ship.mjs');
  const branch = 'northset/batch-0123456789abcdef-prepared';
  const recovered = ship.selectMergedLedgerPublication([
    {headRefName: 'northset/other-prepared', baseRefName: 'main', state: 'MERGED', url: 'https://github.com/northset-oss/verification-pilot/pull/1', mergeCommit: {oid: oid('a')}},
    {headRefName: branch, baseRefName: 'main', state: 'MERGED', url: 'https://github.com/northset-oss/verification-pilot/pull/2', mergeCommit: {oid: oid('b')}},
  ], branch);
  assert.deepEqual(recovered, {
    commitSha: oid('b'),
    prUrl: 'https://github.com/northset-oss/verification-pilot/pull/2',
  });
  assert.equal(ship.selectMergedLedgerPublication([], branch), null);
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

test('batch approval is ordered, configurable to fifty, and preserves repository policy caps', async () => {
  const ship = await import('./ship.mjs');
  assert.equal(typeof ship.validateApprovedBatch, 'function');
  const subjects = [subject('M-016', 'one/repo'), subject('M-017', 'two/repo')];
  const digestValue = ship.batchManifestDigest(subjects);
  assert.deepEqual(ship.validateApprovedBatch(subjects, digestValue), subjects);
  assert.throws(() => ship.validateApprovedBatch(subjects, digest('9')), /approval/i);
  assert.throws(() => ship.validateApprovedBatch([...subjects, subject('M-018', 'one/repo')], ship.batchManifestDigest([...subjects, subject('M-018', 'one/repo')])), /repository/i);
  const four = [...subjects, subject('M-018', 'three/repo'), subject('M-019', 'four/repo')];
  assert.deepEqual(ship.validateApprovedBatch(four, ship.batchManifestDigest(four)), four);
  assert.notEqual(ship.batchManifestDigest(four), ship.batchManifestDigest([...four].reverse()));
  const fifty = Array.from({length: 50}, (_, index) => subject(`M-${String(index + 100).padStart(3, '0')}`, `owner${index}/repo`));
  assert.equal(ship.validateApprovedBatch(fifty, ship.batchManifestDigest(fifty)).length, 50);
  const fiftyOne = [...fifty, subject('M-999', 'overflow/repo')];
  assert.throws(() => ship.validateApprovedBatch(fiftyOne, ship.batchManifestDigest(fiftyOne)), /one to 50|fifty/i);
  assert.equal(ship.configuredShipBatchMaximum({OSS_SHIP_BATCH_MAX: '25'}), 25);
  assert.throws(() => ship.configuredShipBatchMaximum({OSS_SHIP_BATCH_MAX: '51'}), /1 to 50/);
});

test('shipping revalidates patch-review self-digest, file classes, and risk binding', async () => {
  const ship = await import('./ship.mjs');
  const exactPatch = `diff --git a/src/parser.mjs b/src/parser.mjs
index 1111111..2222222 100644
--- a/src/parser.mjs
+++ b/src/parser.mjs
@@ -1 +1 @@
-return tokens.slice(0, -1);
+return tokens;
diff --git a/test/parser.test.mjs b/test/parser.test.mjs
new file mode 100644
--- /dev/null
+++ b/test/parser.test.mjs
@@ -0,0 +1 @@
+test('retains final token', () => {});
`;
  const classes = [{path: 'src/parser.mjs', class: 'source'}, {path: 'test/parser.test.mjs', class: 'added-test'}];
  const body = 'Contributor self-run; not maintainer verification.';
  const review = reviewPatch({
    spec: {
      mission_id: 'M-100', work_category: 'defect_fix', allow_modified_existing_tests: false,
      oracle: {test_paths: ['test/parser.test.mjs'], base_failure_contains: 'retains final token'},
      qualification: {source_evidence: ['src/parser.mjs:1 — return tokens.slice(0, -1);']},
    },
    classes, patch: exactPatch, prBody: body,
  });
  const manifest = {
    patch_sha256: review.patch_sha256,
    pr_body_sha256: review.pr_body_sha256,
    changed_file_classes: review.changed_files,
    risk_flags: review.risks,
  };
  assert.equal(ship.assertPatchReviewBinding(manifest, review), true);
  assert.throws(() => ship.assertPatchReviewBinding({...manifest, risk_flags: [{code: 'hidden'}]}, review), /risks/i);
  assert.throws(() => ship.assertPatchReviewBinding(manifest, {...review, review_digest: digest('9')}), /self-digest/i);
});

test('ship-time policy recomputes exact patch classes instead of trusting a forged stored review', async (t) => {
  const ship = await import('./ship.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-fresh-ship-review-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), {recursive: true});
  await git(repo, 'init');
  await git(repo, 'config', 'user.name', OSS_IDENTITY.name);
  await git(repo, 'config', 'user.email', OSS_IDENTITY.email);
  await writeFile(path.join(repo, 'src', 'parser.mjs'), 'export const parse = () => ["truncated"];\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'base');
  const base = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
  await writeFile(path.join(repo, 'src', 'parser.mjs'), 'export const parse = () => ["retains final token"];\n');
  await mkdir(path.join(repo, 'test'));
  await writeFile(path.join(repo, 'test', 'parser.test.mjs'), "test('retains final token', () => {});\n");
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'fix parser');
  const commit = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
  const patch = (await git(repo, 'diff', '--binary', '--full-index', `${base}..${commit}`)).stdout;
  const body = 'Contributor self-run; not maintainer verification.';
  const valueSpec = {
    mission_id: 'M-100', work_category: 'defect_fix', allow_modified_existing_tests: false,
    base_commit: base,
    oracle: {test_paths: ['test/parser.test.mjs'], base_failure_contains: 'retains final token'},
    qualification: {source_evidence: ['src/parser.mjs:1 — truncated']},
  };
  const valid = reviewPatch({
    spec: valueSpec, patch, prBody: body,
    classes: [{path: 'src/parser.mjs', class: 'source'}, {path: 'test/parser.test.mjs', class: 'added-test'}],
  });
  const forgedSubject = {...valid,
    changed_files: [{path: 'package-lock.json', class: 'lockfile'}],
    production_files: ['src/parser.mjs'], blocking_reasons: [], ready: true,
  };
  const {review_digest: _ignored, ...forgedBytes} = forgedSubject;
  const forged = {...forgedBytes, review_digest: sha256(Buffer.from(canonical(forgedBytes), 'utf8'))};
  const manifest = {
    base_commit: base, commit_oid: commit, patch_sha256: valid.patch_sha256,
    pr_body_sha256: valid.pr_body_sha256, pr_claim_text: body,
    changed_file_classes: forged.changed_files, risk_flags: forged.risks,
  };
  assert.equal(ship.assertPatchReviewBinding(manifest, forged), true);
  await assert.rejects(() => ship.revalidateReadyPatchPolicy({
    spec: valueSpec, manifest: {...manifest, pr_claim_text: 'Different human-board text.'},
    storedReview: valid, patch, prBody: body, authorRepo: repo,
  }), /batch board claim text/i);
  await assert.rejects(() => ship.revalidateReadyPatchPolicy({
    spec: valueSpec, manifest, storedReview: forged, patch, prBody: body, authorRepo: repo,
  }), /fresh deterministic patch review|changed-file classes/i);
});

test('prepared-ledger staging isolates an invalid approval and rolls back a partial commit', async (t) => {
  const ship = await import('./ship.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-transactional-stage-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'missions'), {recursive: true});

  const makeSubject = async (id) => {
    const publicMission = path.join(root, 'prepared', id);
    await mkdir(path.join(publicMission, 'bundle'), {recursive: true});
    await chmod(publicMission, 0o700);
    await chmod(path.join(publicMission, 'bundle'), 0o700);
    await writeFile(path.join(publicMission, 'bundle', 'mission.json'), `${id}\n`);
    const manifest = {...economicSubject(id, `${id.toLowerCase()}/repo`),
      public_mission_sha256: await directoryDigest(publicMission),
    };
    const spec = {schema_version: 2, mission_id: id, task_id: manifest.task_id, attempt_sequence: 1};
    const journal = ship.newJournal(manifest, digest('a'), digest('b'), new Date('2026-07-15T12:00:00Z'),
      {approvedBy: 'internal-user:aeziz'});
    return {spec, manifest, journal, files: {publicMission}};
  };

  const valid = await makeSubject('M-120');
  const invalid = await makeSubject('M-121');
  const invalidDestination = path.join(root, 'missions', 'M-121');
  await cp(invalid.files.publicMission, invalidDestination, {recursive: true});
  await writeFile(path.join(invalidDestination, 'publication.json'), `${JSON.stringify(ship.preparedPublication(invalid.manifest), null, 2)}\n`);
  await writeFile(path.join(invalidDestination, 'approval.json'), '{"approved_by":"forged"}\n');

  const staged = await ship.stagePreparedLedgerBatch([valid, invalid], {root});
  assert.deepEqual(staged.accepted.map((item) => item.manifest.mission_id), ['M-120']);
  assert.deepEqual(staged.rejected.map((item) => item.subject.manifest.mission_id), ['M-121']);
  await readFile(path.join(root, 'missions', 'M-120', 'approval.json'));
  assert.equal((await readFile(path.join(invalidDestination, 'approval.json'), 'utf8')).trim(), '{"approved_by":"forged"}');
  assert.equal((await readdir(path.join(root, 'missions'))).some((name) => name.startsWith('.northset-stage-')), false);

  const first = await makeSubject('M-122');
  const second = await makeSubject('M-123');
  let renames = 0;
  await assert.rejects(() => ship.stagePreparedLedgerBatch([first, second], {
    root,
    renameImpl: async (source, destination) => {
      renames += 1;
      if (renames === 2) throw new Error('representative staging commit failure');
      await rename(source, destination);
    },
  }), /representative staging commit failure/);
  await assert.rejects(() => readFile(path.join(root, 'missions', 'M-122', 'publication.json')), /ENOENT/);
  await assert.rejects(() => readFile(path.join(root, 'missions', 'M-123', 'publication.json')), /ENOENT/);
  assert.equal((await readdir(path.join(root, 'missions'))).some((name) => name.startsWith('.northset-stage-')), false);
});

test('frozen batch pipeline publishes shared gates once and isolates one mission failure', async () => {
  const ship = await import('./ship.mjs');
  const items = ['M-100', 'M-101', 'M-102'].map((id) => ({id, manifest: {mission_id: id}}));
  const calls = [];
  const result = await ship.runFrozenBatchPipeline(items, {
    publishPreparedBatch: async (values) => { calls.push(`prepared:${values.length}`); return {id: 'prepared'}; },
    waitForPagesOnce: async () => { calls.push('pages'); },
    processMission: async (item) => {
      calls.push(`mission:${item.id}`);
      if (item.id === 'M-101') throw new Error('representative upstream failure');
      return {mission_id: item.id, state: 'PR_OPENED'};
    },
    publishFinalBatch: async (_values, missionResults) => {
      calls.push(`final:${missionResults.length}`);
      return {id: 'final'};
    },
  }, {concurrency: 3});
  assert.deepEqual(calls.filter((value) => value.startsWith('prepared')), ['prepared:3']);
  assert.deepEqual(calls.filter((value) => value === 'pages'), ['pages']);
  assert.deepEqual(calls.filter((value) => value.startsWith('final')), ['final:3']);
  assert.equal(result.mission_results[1].state, 'FAILED_INFRA_TERMINAL');
  assert.equal(result.mission_results[0].state, 'PR_OPENED');
  assert.equal(result.mission_results[2].state, 'PR_OPENED');
  assert.deepEqual(calls.filter((value) => value.startsWith('mission:')).sort(), ['mission:M-100', 'mission:M-101', 'mission:M-102']);
});

test('receipt metric requires exact local patch/body proof, public receipt, and upstream PR but not merge', async () => {
  const ship = await import('./ship.mjs');
  const manifest = subject('M-100', 'one/repo');
  const journal = ship.newJournal(manifest, ship.batchManifestDigest([manifest]), digest('a'));
  journal.ledger = {receipt_url: ship.canonicalReceiptUrl('M-100'), receipt_verified_at: '2026-07-15T12:00:00Z'};
  journal.pr = {number: 7, url: 'https://github.com/one/repo/pull/7', head_oid: manifest.commit_oid, body_sha256: manifest.pr_body_sha256};
  assert.equal(ship.contributorReceiptCounted(manifest, journal), true);
  assert.equal(ship.contributorReceiptCounted({...manifest, repo: 'ONE/REPO'}, journal), true);
  assert.equal(ship.contributorReceiptCounted(manifest, {...journal,
    pr: {...journal.pr, url: 'https://github.com/unrelated/repository/pull/7'}}), false);
  assert.equal(ship.contributorReceiptCounted(manifest, {...journal,
    pr: {...journal.pr, url: 'https://github.com/one/repo/pull/8'}}), false);
  assert.equal(ship.contributorReceiptCounted(manifest, {...journal,
    pr: {...journal.pr, url: 'https://github.com/one/repo/issues/7'}}), false);
  assert.equal(ship.contributorReceiptCounted(manifest, {...journal, pr: {...journal.pr, head_oid: oid('9')}}), false);
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
