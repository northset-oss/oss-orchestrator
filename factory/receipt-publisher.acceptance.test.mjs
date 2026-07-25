import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {createGitHubSafety} from './github-safety.mjs';
import {
  createReceiptPublisher,
  createReceiptStatusPublisher,
  receiptUrlFor,
  runBounded,
} from './receipt-publisher.mjs';
import {promotionFreePrBody} from './publication-policy.mjs';

function oid(character) {
  return character.repeat(40);
}

function sha(character) {
  return `sha256:${character.repeat(64)}`;
}

function item(id, character, overrides = {}) {
  const timestamp = '2026-07-19T12:00:00.000Z';
  const executedCommands = [{
    phase: 'base_observation', command: 'node --test', network: 'none',
    expected_result: 'failure', result: 'FAIL', expectation_met: true,
    started_at: timestamp, finished_at: timestamp, duration_ms: 0, exit_code: 1,
    output_sha256: sha('1'), stdout_sha256: sha('2'), stderr_sha256: sha('3'),
  }, {
    phase: 'patched_observation', command: 'node --test', network: 'none',
    expected_result: 'success', result: 'PASS', expectation_met: true,
    started_at: timestamp, finished_at: timestamp, duration_ms: 0, exit_code: 0,
    output_sha256: sha('4'), stdout_sha256: sha('5'), stderr_sha256: sha('6'),
  }];
  const receiptUrl = `https://northset-oss.github.io/verification-pilot/receipts/${id}/`;
  const consentScopes = {
    schema_version: 2,
    mission_id: id,
    scopes: {
      contribution_invitation: {
        status: 'granted',
        evidence: {kind: 'public_url', value: 'https://github.com/upstream/project/issues/17'},
        granted_at: timestamp,
        granted_by: 'repository:upstream/project',
      },
      verification_execution_consent: {
        status: 'absent', evidence: null, granted_at: null, granted_by: null,
      },
      receipt_publication_consent: {
        status: 'granted',
        evidence: {kind: 'public_url', value: 'https://github.com/upstream/project/issues/17'},
        granted_at: timestamp,
        granted_by: 'maintainer',
      },
      marketing_reference_consent: {
        status: 'absent', evidence: null, granted_at: null, granted_by: null,
      },
    },
  };
  const manifest = {
    mission_id: id,
    task_id: `TASK-${id}`,
    repository: 'upstream/project',
    issue_number: 17,
    base_oid: oid('a'),
    patch_sha256: sha(character),
    commit_oid: oid(character),
    tested_tree_oid: oid('d'),
    checks: ['node --test', {command: 'npm test', exit_code: 0}],
    pr_body: promotionFreePrBody('Fix the issue.', ['node --test', '[object Object]'], {
      receiptUrl,
    }),
    receipt_visibility: 'public_opt_in',
    consent_scopes: consentScopes,
    receipt_url: receiptUrl,
    planned_actions: ['publish-proof', 'open-upstream-pr'],
    receipt_claim: {type: 'regression_fix', statement: `Verified ${id}`},
    proof: {
      schema_version: 3,
      task_id: `TASK-${id}`,
      repository: 'upstream/project',
      issue_number: 17,
      candidate: 'upstream/project#17',
      base_oid: oid('a'),
      patch_sha256: sha(character),
      commit_oid: oid(character),
      tested_tree_oid: oid('d'),
      checks: ['node --test', {command: 'npm test', exit_code: 0}],
      executed_commands: executedCommands,
      checks_not_run: [{check: 'npm test', reason: 'not executed by the clean verifier'}],
      limitations: ['Only the focused regression command was executed.'],
      verification_started_at: timestamp,
      verification_finished_at: timestamp,
      environment: {image: 'sha256:fixture'},
      base_observation: executedCommands[0],
      patched_observation: executedCommands[1],
      claim: {type: 'regression_fix', statement: `Verified ${id}`},
      receipt_visibility: 'public_opt_in',
      consent_scopes: consentScopes,
      batch_approval_digest: null,
      proof_sha256: sha('f'),
    },
    ...overrides.manifest,
  };
  return {
    mission_id: id,
    commit_oid: manifest.commit_oid,
    patch_sha256: manifest.patch_sha256,
    tested_tree_oid: manifest.tested_tree_oid,
    receipt_claim: manifest.receipt_claim,
    approval_digest: overrides.approval_digest ?? sha('e'),
    manifest,
    ...overrides.item,
  };
}

async function temporary(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

async function git(args, options = {}) {
  const result = await runBounded('git', args, {timeoutMs: 30_000, maxOutputBytes: 1024 * 1024, ...options});
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function bareRepository(t) {
  const root = await temporary(t, 'factory-receipt-publisher');
  const bare = path.join(root, 'ledger.git');
  const seed = path.join(root, 'seed');
  await git(['init', '--bare', '--quiet', bare]);
  await git(['init', '--quiet', seed]);
  await writeFile(path.join(seed, 'README.md'), '# Receipt ledger fixture\n');
  await git(['-C', seed, 'add', 'README.md']);
  await git(['-C', seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '--quiet', '-m', 'seed']);
  await git(['-C', seed, 'branch', '-M', 'main']);
  await git(['-C', seed, 'remote', 'add', 'origin', bare]);
  await git(['-C', seed, 'push', '--quiet', 'origin', 'main']);
  await git(['--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  return {root, bare};
}

function recordingRunner(calls) {
  return async (command, args, options) => {
    calls.push({command, args: [...args], options: {...options}});
    return runBounded(command, args, options);
  };
}

function concludedCi(state, observedAt) {
  return {
    state,
    observed_at: observedAt,
    required_runs: [{
      name: 'required-test',
      required: true,
      status: 'COMPLETED',
      conclusion: state,
      started_at: '2026-07-19T12:01:00.000Z',
      completed_at: '2026-07-19T12:03:00.000Z',
    }],
  };
}

function replaceClaim(entry, statement) {
  const claim = {type: 'regression_fix', statement};
  entry.receipt_claim = claim;
  entry.manifest.receipt_claim = claim;
  entry.manifest.proof.claim = claim;
  return entry;
}

async function remoteBytes(bare, relativePath) {
  const result = await runBounded('git', ['--git-dir', bare, 'show', `receipts:${relativePath}`], {
    timeoutMs: 30_000, maxOutputBytes: 1024 * 1024,
  });
  assert.equal(result.code, 0, result.stderr);
  return Buffer.from(result.stdout, 'utf8');
}

test('receiptUrlFor uses the canonical public ledger path while validating contribution identity', () => {
  assert.equal(receiptUrlFor('M-1000', oid('a')),
    'https://northset-oss.github.io/verification-pilot/receipts/M-1000/');
  assert.throws(() => receiptUrlFor('../M-1000', oid('a')), /invalid mission_id/);
  assert.throws(() => receiptUrlFor('M-1000', 'bad'), /commit_oid/);
});

test('raw receipt git HTTP 403 reaches the shared GitHub pause', async (t) => {
  const root = await temporary(t, 'factory-receipt-git-403');
  const pauseFile = path.join(root, 'pause.json');
  const publisher = createReceiptPublisher({
    remoteUrl: 'https://github.com/northset-oss/verification-pilot.git',
    tempRoot: root,
    run: async () => ({
      code: 128, signal: null, stdout: '', timedOut: false, outputLimited: false,
      stderr: "fatal: unable to access repository: The requested URL returned error: 403\n",
    }),
  });
  const safety = createGitHubSafety({
    pauseFile,
    governorFile: path.join(root, 'governor.json'),
    transport: async (request) => typeof request.execute === 'function'
      ? request.execute() : {status: 200},
    mutationSpacingMs: 0,
    searchSpacingMs: 0,
  });

  await assert.rejects(() => safety.request({
    priority: 'final_submission', kind: 'git_push', operation: 'publish_receipt_batch',
    execute: () => publisher([item('M-1000', 'b')]),
  }), (error) => error.code === 'GITHUB_PAUSED' && error.pause.kind === 'GITHUB_HTTP_403');
  assert.equal(JSON.parse(await readFile(pauseFile, 'utf8')).kind, 'GITHUB_HTTP_403');
});

test('one non-force batch push publishes deterministic exact proof bytes from an isolated clone', async (t) => {
  const {root, bare} = await bareRepository(t);
  const sibling = path.join(root, 'dirty-sibling');
  await mkdir(sibling);
  await writeFile(path.join(sibling, 'operator-work.txt'), 'must remain untouched\n');
  const calls = [];
  const publisher = createReceiptPublisher({
    remoteUrl: bare,
    run: recordingRunner(calls),
    tempRoot: root,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  });
  const first = item('M-1000', 'b');
  const second = item('M-1001', 'c');
  const result = await publisher([second, first]);

  const pushes = calls.filter((call) => call.args.includes('push'));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].options.shell, false);
  assert.doesNotMatch(pushes[0].args.join(' '), /--force|-f\b/);
  assert.equal(await readFile(path.join(sibling, 'operator-work.txt'), 'utf8'), 'must remain untouched\n');

  for (const entry of [first, second]) {
    const id = entry.mission_id;
    const relativePath = `receipts/${id}/${entry.commit_oid}/proof.json`;
    const bytes = await remoteBytes(bare, relativePath);
    const proof = JSON.parse(bytes);
    assert.equal(proof.mission_id, id);
    assert.equal(proof.base_oid, entry.manifest.base_oid);
    assert.equal(proof.patch_sha256, entry.manifest.patch_sha256);
    assert.equal(proof.commit_oid, entry.manifest.commit_oid);
    assert.equal(proof.tested_tree_oid, entry.manifest.tested_tree_oid);
    assert.deepEqual(proof.checks, entry.manifest.checks);
    assert.equal(proof.schema_version, 3);
    assert.deepEqual(proof.executed_commands, entry.manifest.proof.executed_commands);
    assert.deepEqual(proof.checks_not_run, entry.manifest.proof.checks_not_run);
    assert.deepEqual(proof.limitations, entry.manifest.proof.limitations);
    assert.equal(proof.environment.image, 'sha256:fixture');
    assert.deepEqual(proof.claim, entry.manifest.receipt_claim);
    assert.equal(proof.batch_approval_digest, entry.approval_digest);
    assert.equal(proof.proof_sha256, undefined);
    const pointer = JSON.parse(await remoteBytes(bare, `receipts/${id}/current.json`));
    assert.deepEqual(pointer, {
      contribution_commit_oid: entry.commit_oid,
      mission_id: id,
      proof_sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      schema_version: 1,
    });
    assert.equal(result[id].mission_id, id);
    assert.equal(result[id].receipt_url, receiptUrlFor(id, entry.commit_oid));
    assert.equal(result[id].proof_sha256,
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    assert.match(result[id].batch_commit_oid, /^[a-f0-9]{40}$/);
    assert.equal(result[id].batch_approval_digest, entry.approval_digest);
  }
  assert.equal(result['M-1000'].batch_commit_oid, result['M-1001'].batch_commit_oid);
  assert.equal(await git(['--git-dir', bare, 'rev-list', '--count', 'receipts']), '1');
});

test('a retry adopts identical remotely committed proof files without another push', async (t) => {
  const {root, bare} = await bareRepository(t);
  const calls = [];
  const publisher = createReceiptPublisher({
    remoteUrl: bare, run: recordingRunner(calls), tempRoot: root,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  });
  const batch = [item('M-1000', 'b'), item('M-1001', 'c')];
  const first = await publisher(batch);
  await publisher([item('M-1002', 'd')]);
  const adopted = await publisher(batch);

  assert.deepEqual(adopted, first);
  assert.equal(calls.filter((call) => call.args.includes('push')).length, 2);
  assert.equal(await git(['--git-dir', bare, 'rev-list', '--count', 'receipts']), '2');
});

test('mixed existing and new proofs are rejected instead of receiving false batch provenance', async (t) => {
  const {root, bare} = await bareRepository(t);
  const calls = [];
  const publisher = createReceiptPublisher({
    remoteUrl: bare, run: recordingRunner(calls), tempRoot: root,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  });
  const existing = item('M-1000', 'b');
  await publisher([existing]);
  await assert.rejects(() => publisher([existing, item('M-1001', 'c')]),
    (error) => error.code === 'RECEIPT_PARTIAL_BATCH');
  assert.equal(calls.filter((call) => call.args.includes('push')).length, 1);
  assert.equal(await git(['--git-dir', bare, 'rev-list', '--count', 'receipts']), '1');
});

test('proof v2 publication rejects malformed structured evidence before Git transport', async () => {
  const calls = [];
  const publisher = createReceiptPublisher({
    remoteUrl: '/unused/receipt.git',
    run: async (...args) => { calls.push(args); assert.fail('malformed proof must not reach Git'); },
  });
  const malformedCheck = item('M-1000', 'b');
  malformedCheck.manifest.proof.checks_not_run = [{check: {command: 'npm test'}, reason: 'blocked'}];
  await assert.rejects(() => publisher([malformedCheck]), /checks_not_run.*nonblank check and reason strings/);

  const falsePass = item('M-1001', 'c');
  falsePass.manifest.proof.executed_commands[1] = {
    ...falsePass.manifest.proof.executed_commands[1], exit_code: 1, result: 'PASS',
  };
  await assert.rejects(() => publisher([falsePass]), /result does not match its exit code and expectation/);
  assert.equal(calls.length, 0);
});

test('an existing proof with different approved bytes is rejected and never overwritten', async (t) => {
  const {root, bare} = await bareRepository(t);
  const calls = [];
  const publisher = createReceiptPublisher({
    remoteUrl: bare, run: recordingRunner(calls), tempRoot: root,
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  });
  const original = item('M-1000', 'b');
  await publisher([original]);
  const changed = item('M-1000', 'b', {
    manifest: {
      checks: ['node --test changed'],
      pr_body: promotionFreePrBody('Fix the issue.', ['node --test changed'], {
        receiptUrl: original.manifest.receipt_url,
      }),
      proof: {
        schema_version: 1,
        base_oid: oid('a'), patch_sha256: sha('b'), commit_oid: oid('b'), tested_tree_oid: oid('d'),
        checks: ['node --test changed'], claim: original.manifest.receipt_claim,
      },
    },
  });

  await assert.rejects(() => publisher([changed]), (error) =>
    error.code === 'RECEIPT_PROOF_CONFLICT' && /already exists/.test(error.message));
  assert.equal(calls.filter((call) => call.args.includes('push')).length, 1);
  const bytes = await remoteBytes(bare, `receipts/M-1000/${oid('b')}/proof.json`);
  assert.deepEqual(JSON.parse(bytes).checks, original.manifest.checks);
});

test('stale rebases append a new commit-specific proof and approval digest is mandatory', async (t) => {
  const {root, bare} = await bareRepository(t);
  const publisher = createReceiptPublisher({
    remoteUrl: bare, tempRoot: root, now: () => new Date('2026-07-19T12:00:00.000Z'),
  });
  const original = item('M-1000', 'b');
  await assert.rejects(() => publisher([{...original, approval_digest: null}]), /non-null sha256 digest/);
  await publisher([original]);
  const rebased = item('M-1000', 'c', {
    manifest: {base_oid: oid('e'), tested_tree_oid: oid('f'), proof: null},
  });
  await publisher([rebased]);

  const originalProof = JSON.parse(await remoteBytes(bare, `receipts/M-1000/${oid('b')}/proof.json`));
  const rebasedProof = JSON.parse(await remoteBytes(bare, `receipts/M-1000/${oid('c')}/proof.json`));
  assert.equal(originalProof.commit_oid, oid('b'));
  assert.equal(rebasedProof.commit_oid, oid('c'));
  assert.equal(rebasedProof.base_oid, oid('e'));
  assert.equal(await git(['--git-dir', bare, 'rev-list', '--count', 'receipts']), '2');
});

test('concluded receipt status publishes while an unknown CI field is omitted', async (t) => {
  const {root, bare} = await bareRepository(t);
  const first = item('M-1000', 'b');
  const second = item('M-1001', 'c');
  const proofPublisher = createReceiptPublisher({
    remoteUrl: bare, tempRoot: root, now: () => new Date('2026-07-19T12:00:00.000Z'),
  });
  await proofPublisher([first, second]);
  const proofPaths = [first, second].map((entry) =>
    `receipts/${entry.mission_id}/${entry.commit_oid}/proof.json`);
  const beforeProofs = await Promise.all(proofPaths.map((relativePath) => remoteBytes(bare, relativePath)));

  const calls = [];
  const statusPublisher = createReceiptStatusPublisher({
    remoteUrl: bare,
    run: recordingRunner(calls),
    tempRoot: root,
    now: () => new Date('2026-07-19T12:05:00.000Z'),
  });
  const statuses = [first, second].map((entry, index) => ({
    mission_id: entry.mission_id,
    commit_oid: entry.commit_oid,
    pr_number: 100 + index,
    receipt_url: receiptUrlFor(entry.mission_id, entry.commit_oid),
    pr_url: `https://github.com/upstream/project/pull/${100 + index}`,
    pr_state: index === 0 ? 'OPEN' : 'MERGED',
    merged: index === 1,
    current_pr_state: index === 0 ? 'OPEN' : 'MERGED',
    current_merged: index === 1,
    pr_head_oid: entry.commit_oid,
    merge_commit_oid: index === 1 ? 'd'.repeat(40) : null,
    ci_state: index === 0 ? 'SUCCESS' : null,
    ...(index === 0 ? {
      ci_observation: concludedCi('SUCCESS', '2026-07-19T12:04:00.000Z'),
    } : {}),
    attestation_state: index === 0 ? 'ATTESTATION_PENDING' : 'RECEIPT_ATTESTED',
    attestation_url: index === 0 ? null : 'https://github.com/northset-oss/verification-pilot/attestations/1',
    observed_at: '2026-07-19T12:04:00.000Z',
  }));
  const published = await statusPublisher(statuses.reverse());

  const pushes = calls.filter((call) => call.args.includes('push'));
  assert.equal(pushes.length, 1);
  assert.doesNotMatch(pushes[0].args.join(' '), /--force|-f\b/);
  assert.equal(published['M-1000'].status_commit_oid, published['M-1001'].status_commit_oid);
  for (const [index, entry] of [first, second].entries()) {
    const relativePath = `receipts/${entry.mission_id}/${entry.commit_oid}/publication.json`;
    const bytes = await remoteBytes(bare, relativePath);
    assert.equal(`${JSON.stringify(JSON.parse(bytes))}\n`, bytes.toString('utf8'));
    const status = JSON.parse(bytes);
    assert.equal(status.mission_id, entry.mission_id);
    assert.equal(status.contribution_commit_oid, entry.commit_oid);
    assert.equal(status.pr_head_oid, entry.commit_oid);
    assert.equal(status.merge_commit_oid, index === 1 ? 'd'.repeat(40) : null);
    assert.equal(status.pr_number, 100 + index);
    assert.equal(status.pr_state, index === 0 ? 'OPEN' : 'MERGED');
    assert.equal(status.merged, index === 1);
    if (index === 0) assert.equal(status.ci_state, 'SUCCESS');
    else assert.equal(Object.hasOwn(status, 'ci_state'), false);
    assert.equal(status.attestation_state,
      index === 0 ? 'ATTESTATION_PENDING' : 'RECEIPT_ATTESTED');
    assert.equal(published[entry.mission_id].status_url,
      `https://github.com/northset-oss/verification-pilot/blob/receipts/${relativePath}`);
    assert.deepEqual(await remoteBytes(bare, proofPaths[index]), beforeProofs[index]);
  }

  const adopted = await statusPublisher(statuses);
  assert.deepEqual(adopted, published);
  assert.equal(calls.filter((call) => call.args.includes('push')).length, 1);

  const updatedStatuses = statuses.map((status) => status.mission_id === 'M-1000' ? {
    ...status,
    pr_state: 'CLOSED',
    current_pr_state: 'CLOSED',
    ci_state: 'FAILURE',
    ci_observation: concludedCi('FAILURE', '2026-07-19T12:06:00.000Z'),
    observed_at: '2026-07-19T12:06:00.000Z',
  } : status);
  const updated = await statusPublisher(updatedStatuses);
  assert.notEqual(updated['M-1000'].status_commit_oid, published['M-1000'].status_commit_oid);
  assert.equal(calls.filter((call) => call.args.includes('push')).length, 2);
  const updatedStatus = JSON.parse(await remoteBytes(bare,
    `receipts/M-1000/${first.commit_oid}/publication.json`));
  assert.equal(updatedStatus.pr_state, 'CLOSED');
  assert.equal(updatedStatus.ci_state, 'FAILURE');
  for (const [index, relativePath] of proofPaths.entries()) {
    assert.deepEqual(await remoteBytes(bare, relativePath), beforeProofs[index]);
  }
  assert.equal(await git(['--git-dir', bare, 'rev-list', '--count', 'receipts']), '3');
});

test('doc-kit CI success observed before required workflows concluded is refused before Git', async () => {
  const calls = [];
  const statusPublisher = createReceiptStatusPublisher({run: recordingRunner(calls)});
  await assert.rejects(() => statusPublisher([{
    mission_id: 'M-1000',
    commit_oid: oid('b'),
    pr_number: 901,
    receipt_url: receiptUrlFor('M-1000', oid('b')),
    pr_url: 'https://github.com/nodejs/doc-kit/pull/901',
    pr_state: 'OPEN',
    merged: false,
    current_pr_state: 'OPEN',
    current_merged: false,
    ci_state: 'SUCCESS',
    ci_observation: {
      state: 'SUCCESS',
      observed_at: '2026-07-19T21:55:58.000Z',
      required_runs: [{
        name: 'required Node.js workflows',
        required: true,
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        started_at: '2026-07-21T23:35:00.000Z',
        completed_at: '2026-07-21T23:45:00.000Z',
      }],
    },
    attestation_state: 'RECEIPT_ATTESTED',
    attestation_url: 'https://github.com/northset-oss/verification-pilot/attestations/1',
    observed_at: '2026-07-19T21:55:58.000Z',
  }]), /required runs had not concluded when the status was observed/);
  assert.equal(calls.length, 0);
});

test('receipt proof refuses external agreement or endorsement wording before Git', async () => {
  const calls = [];
  const publisher = createReceiptPublisher({run: recordingRunner(calls)});
  const entry = replaceClaim(item('M-1000', 'b'), 'Upstream CI agreed with the receipt.');
  await assert.rejects(() => publisher([entry]), /external agreement or endorsement language/);
  assert.equal(calls.length, 0);
});

test('receipt status refuses a pr_state that contradicts the currently known state before Git', async () => {
  const calls = [];
  const statusPublisher = createReceiptStatusPublisher({run: recordingRunner(calls)});
  await assert.rejects(() => statusPublisher([{
    mission_id: 'M-1000',
    commit_oid: oid('b'),
    pr_number: 100,
    receipt_url: receiptUrlFor('M-1000', oid('b')),
    pr_url: 'https://github.com/upstream/project/pull/100',
    pr_state: 'OPEN',
    merged: false,
    current_pr_state: 'CLOSED',
    current_merged: false,
    ci_state: null,
    attestation_state: 'ATTESTATION_PENDING',
    attestation_url: null,
    observed_at: '2026-07-19T12:04:00.000Z',
  }]), /pr_state contradicts the currently known PR state/);
  assert.equal(calls.length, 0);
});

test('receipt proof refuses a repository-targeted call to action before Git', async () => {
  const calls = [];
  const publisher = createReceiptPublisher({run: recordingRunner(calls)});
  const entry = replaceClaim(item('M-1000', 'b'), 'Maintain upstream/project? Contact us to request a run.');
  await assert.rejects(() => publisher([entry]), /repository-targeted call to action/);
  assert.equal(calls.length, 0);
});

test('receipt status refuses to publish without its immutable proof', async (t) => {
  const {root, bare} = await bareRepository(t);
  await createReceiptPublisher({remoteUrl: bare, tempRoot: root})([item('M-1001', 'c')]);
  const calls = [];
  const statusPublisher = createReceiptStatusPublisher({
    remoteUrl: bare, run: recordingRunner(calls), tempRoot: root,
  });
  await assert.rejects(() => statusPublisher([{
    mission_id: 'M-1000', commit_oid: oid('b'), pr_number: 100,
    receipt_url: receiptUrlFor('M-1000', oid('b')),
    pr_url: 'https://github.com/upstream/project/pull/100', pr_state: 'OPEN',
    merged: false, current_pr_state: 'OPEN', current_merged: false,
    ci_state: null, attestation_state: 'ATTESTATION_PENDING',
    attestation_url: null, observed_at: '2026-07-19T12:04:00.000Z',
  }]), (error) => error.code === 'RECEIPT_STATUS_WITHOUT_PROOF');
  assert.equal(calls.filter((call) => call.args.includes('push')).length, 0);
});

test('malformed v2 evidence and contradictory publication state fail before Git', async () => {
  const malformed = item('M-1000', 'b');
  malformed.manifest.proof.executed_commands[0].started_at = 'not-a-time';
  const proofCalls = [];
  const proofPublisher = createReceiptPublisher({
    run: recordingRunner(proofCalls),
  });
  await assert.rejects(() => proofPublisher([malformed]), /must be an ISO-8601 time/);
  assert.equal(proofCalls.length, 0);

  const statusCalls = [];
  const statusPublisher = createReceiptStatusPublisher({
    run: recordingRunner(statusCalls),
  });
  await assert.rejects(() => statusPublisher([{
    mission_id: 'M-1000', commit_oid: oid('b'), pr_number: 100,
    receipt_url: receiptUrlFor('M-1000', oid('b')),
    pr_url: 'https://github.com/upstream/project/pull/100', pr_state: 'MERGED',
    merged: false, ci_state: 'SUCCESS', attestation_state: 'RECEIPT_ATTESTED',
    attestation_url: 'https://github.com/northset-oss/verification-pilot/attestations/1',
    observed_at: '2026-07-19T12:04:00.000Z',
  }]), /merged state is inconsistent/);
  assert.equal(statusCalls.length, 0);
});
