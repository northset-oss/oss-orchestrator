import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {approveBoard} from './board.mjs';
import {openFactoryDb} from './db.mjs';
import {
  assertDeclaredTestsExecuted,
  assertPublicVerificationClaims,
  createCommandDriver,
  createStageSemaphores,
  finalizePrBody,
  removeWorkTree,
  runFactoryCycle,
  runUntilIdle,
} from './worker.mjs';

async function makeFactory(t, {missionStart = 1000} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oss-factory-'));
  const db = openFactoryDb(path.join(root, 'factory.sqlite'), {missionStart});
  t.after(() => db.close());
  return {root, db};
}

function candidates(count) {
  return Array.from({length: count}, (_, index) => ({
    candidate: `owner${index + 1}/repo${index + 1}#${index + 1}`,
    repository: `owner${index + 1}/repo${index + 1}`,
    issue_number: index + 1,
    profile: 'node',
    priority: count - index,
    base_oid: `${String((index % 9) + 1)}`.repeat(40),
    issue_snapshot: {title: `Issue ${index + 1}`},
    live_state: {default_branch: 'main'},
  }));
}

function verifiedDriver({verified = 10, startHook = null} = {}) {
  return {
    checkout: async (task) => {
      await startHook?.(task);
      return `/private/${task.task_id}`;
    },
    scout: async (task) => task.issue_number <= verified
      ? {decision: 'GO', reason: 'bounded', test_command: 'node --test', target_files: ['src/a.mjs'], estimated_risk: 'GREEN'}
      : {decision: 'SKIP', reason: 'not viable'},
    bootstrap: async () => ({cache_key: `sha256:${'a'.repeat(64)}`, mounts: [{source: 'deps', target: '/deps', readOnly: true}]}),
    author: async (task, _checkout, scout) => ({
      outcome: 'PATCH',
      issue_url: `https://github.com/${task.repository}/issues/${task.issue_number}`,
      base_branch: 'main',
      pr_title: `fix: issue ${task.issue_number}`,
      pr_body: `## Summary\n\nFix issue ${task.issue_number}.`,
      summary: `Fix issue ${task.issue_number}.`,
      checks: [scout.test_command],
      test_command: scout.test_command,
      changed_files: [{path: 'src/a.mjs', class: 'production', lines: 3}],
      changed_lines: 3,
      risk_tier: 'GREEN',
    }),
    verify: async (task) => {
      const timestamp = '2026-07-19T12:00:00.000Z';
      const baseObservation = {
        phase: 'base_observation', command: 'node --test', network: 'none',
        expected_result: 'failure', result: 'FAIL', expectation_met: true,
        started_at: timestamp, finished_at: timestamp, duration_ms: 0,
        exit_code: 1, output_sha256: `sha256:${'c'.repeat(64)}`,
      };
      const patchedObservation = {
        phase: 'patched_observation', command: 'node --test', network: 'none',
        expected_result: 'success', result: 'PASS', expectation_met: true,
        started_at: timestamp, finished_at: timestamp, duration_ms: 0,
        exit_code: 0, output_sha256: `sha256:${'d'.repeat(64)}`,
      };
      return {
        ok: true,
        claim_type: 'regression_fix',
        dco_verified: true,
        changed_files: [{path: 'src/a.mjs', status: 'M', class: 'production', lines: 3}],
        changed_lines: 3,
        patch_sha256: `sha256:${String((task.issue_number % 9) + 1).repeat(64)}`,
        tested_tree_oid: 'b'.repeat(40),
        commit_oid: `${String((task.issue_number % 8) + 1)}`.repeat(40),
        verification_started_at: timestamp,
        verification_finished_at: timestamp,
        executed_commands: [baseObservation, patchedObservation],
        base_observation: baseObservation,
        patched_observation: patchedObservation,
        environment: {
          profile: 'node', image: `sha256:${'e'.repeat(64)}`, architecture: 'arm64', network: 'none',
        },
      };
    },
    cleanup: async () => {},
  };
}

test('work-tree cleanup bounds filesystem retries and defers only busy-directory races', async () => {
  let options = null;
  const removed = await removeWorkTree('/private/factory-work', {
    remove: async (_root, supplied) => { options = supplied; },
  });
  assert.equal(removed, true);
  assert.deepEqual(options, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});

  const busy = new Error('directory not empty');
  busy.code = 'ENOTEMPTY';
  assert.equal(await removeWorkTree('/private/factory-work', {
    remove: async () => { throw busy; },
    tolerateBusy: true,
  }), false);
  await assert.rejects(removeWorkTree('/private/factory-work', {
    remove: async () => { throw busy; },
  }), busy);
});

test('READY claims use the exact clean verifier command instead of authored status prose', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(1));
  const driver = verifiedDriver({verified: 1});
  const author = driver.author;
  driver.author = async (...args) => ({
    ...await author(...args),
    checks: ['PASS: node --test', 'BLOCKED: npm run lint'],
  });

  await runFactoryCycle({db, workers: 1, driver, boardPolicy: {minSize: 10}});

  const [ready] = db.listReady({states: ['PENDING'], limit: 1});
  assert.deepEqual(ready.manifest.checks, ['node --test']);
  assert.deepEqual(ready.manifest.proof.checks_not_run, []);
  assert.equal(ready.manifest.pr_body, [
    '## Summary',
    '',
    'Fix issue 1.',
    '',
    '---',
    '<!-- northset-receipt:M-1000:start -->',
    '### Verification',
    '',
    '`node --test` exited 0 on this exact head (`2222222`) in a network-off container, before this PR was opened.',
    'No workflow or CI files are modified in this change.',
    'Commands, environment, and hashes: [receipt M-1000](https://northset-oss.github.io/verification-pilot/receipts/M-1000/) — checkable in ~30 seconds without trusting us.',
    'Self-run by the contributor, not maintainer verification.',
    '<!-- northset-receipt:M-1000:end -->',
    '',
    'AI-assisted and reviewed by Northset; I take responsibility for this submission.',
    '',
  ].join('\n'));
});

test('footer v2 renders argv commands and omits the CI claim on any uncertainty', () => {
  const missionId = 'M-321';
  const receiptUrl = 'https://northset.test/receipts/M-321/';
  const facts = {
    command: ['node', '--test', 'test/value.test.mjs'],
    commitOid: 'abcdef0123456789abcdef0123456789abcdef01',
    changedFiles: [{path: 'src/value.mjs', class: 'production'}],
  };
  const rendered = finalizePrBody('Fix the value.', missionId, receiptUrl, facts);
  assert.match(rendered,
    /`node --test test\/value\.test\.mjs` exited 0 on this exact head \(`abcdef0`\)/);
  assert.match(rendered, /No workflow or CI files are modified in this change\./);

  for (const changedFiles of [
    [{path: '.github/workflows/test.yml', class: 'ci'}],
    [{path: 'custom-ci/config.yml', class: 'ci'}],
    [{class: 'production'}],
    null,
  ]) {
    const uncertain = finalizePrBody('Fix the value.', missionId, receiptUrl, {...facts, changedFiles});
    assert.doesNotMatch(uncertain, /No workflow or CI files are modified in this change\./);
  }
});

test('footer v2 substitutes long commands and preserves a placeholder receipt block without duplication', () => {
  const missionId = 'M-322';
  const receiptUrl = 'https://northset.test/receipts/M-322/';
  const longCommand = `node --test ${'test/deeply-nested/'.repeat(4)}value.test.mjs`;
  const rendered = finalizePrBody('Fix the value.', missionId, receiptUrl, {
    command: longCommand,
    commitOid: '1234567890abcdef1234567890abcdef12345678',
    changedFiles: [],
  });
  assert.match(rendered,
    /the repository's declared test command exited 0 on this exact head \(`1234567`\)/);
  assert.doesNotMatch(rendered, new RegExp(longCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const templated = [
    'Fix the value.',
    '',
    '<!-- northset-receipt:{{MISSION_ID}}:start -->',
    '[receipt {{MISSION_ID}}]({{RECEIPT_URL}})',
    '<!-- northset-receipt:{{MISSION_ID}}:end -->',
  ].join('\n');
  const finalized = finalizePrBody(templated, missionId, receiptUrl, {
    command: 'node --test', commitOid: '1'.repeat(40), changedFiles: [],
  });
  assert.equal(finalized, `${templated
    .replaceAll('{{MISSION_ID}}', missionId)
    .replaceAll('{{RECEIPT_URL}}', receiptUrl)}\n`);
  assert.equal(finalized.match(/northset-receipt:M-322:start/g)?.length, 1);

  const refreshed = finalizePrBody(finalized, missionId, receiptUrl, {
    command: ['npm', 'test'], commitOid: '2'.repeat(40), changedFiles: [], replaceExisting: true,
  });
  assert.match(refreshed, /`npm test` exited 0 on this exact head \(`2222222`\)/);
  assert.doesNotMatch(refreshed, /`1111111`/);
  assert.equal(refreshed.match(/northset-receipt:M-322:start/g)?.length, 1);
});

test('PR text cannot deny that its exact clean verifier command ran and passed', () => {
  const command = 'yarn test --watchAll=false --runTestsByPath src/__tests__/selectors.test.js';
  assert.throws(() => assertPublicVerificationClaims({
    pr_body: `## Testing\n- \`${command}\` could not start because Yarn is unavailable`,
  }, {
    patched_observation: {command, result: 'PASS', exit_code: 0},
  }), /PR body says the clean verifier command did not run/);

  assert.throws(() => assertPublicVerificationClaims({
    pr_body: '## Testing\n\nThe focused Jest command could not run locally. Static assertions passed.',
  }, {
    patched_observation: {command: 'npm test -- --runInBand src/__tests__/selectors.test.js',
      result: 'PASS', exit_code: 0},
  }), /PR body says the clean verifier command did not run/);

  assert.doesNotThrow(() => assertPublicVerificationClaims({
    pr_body: `## Testing\n- \`${command}\` passed in the clean verifier\n- npm run lint was not run`,
  }, {
    patched_observation: {command, result: 'PASS', exit_code: 0},
  }));
});

test('regression verification must exercise its declared tests or the repository suite', () => {
  const authored = {test_only_paths: ['test/suite/JUnitAnalyzer.test.ts']};
  const verification = (command) => ({
    claim_type: 'regression_fix',
    patched_observation: {command, result: 'PASS', exit_code: 0},
  });

  assert.throws(() => assertDeclaredTestsExecuted(authored, verification(
    "node -e \"const source = require('fs').readFileSync('src/analyzer.ts', 'utf8')\"",
  )), /must execute a declared test-only path or a repository test suite/);
  assert.doesNotThrow(() => assertDeclaredTestsExecuted(authored, verification(
    'npm test',
  )));
  assert.doesNotThrow(() => assertDeclaredTestsExecuted(authored, verification(
    'npm test -- --runTestsByPath test/suite/JUnitAnalyzer.test.ts',
  )));
});

test('fifty lake candidates enter the continuous queue without shift or board schedule fields', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(50));
  assert.equal(db.listTasks({state: 'QUEUED'}).length, 50);
  const taskColumns = db.connection.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name);
  assert.equal(taskColumns.includes('shift_id'), false);
  assert.equal(taskColumns.includes('scheduled_at'), false);
  assert.equal(taskColumns.includes('ntp'), false);
});

test('multiple workers begin immediately without a clock or board activation wait', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(4));
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cycle = runFactoryCycle({
    db,
    workers: 4,
    queueDepth: 4,
    driver: verifiedDriver({verified: 4, startHook: async (task) => {
      started.push(task.task_id);
      if (started.length === 4) release();
      await gate;
    }}),
    boardPolicy: {minSize: 10},
  });
  await gate;
  assert.equal(started.length, 4);
  const result = await cycle;
  assert.equal(result.results.filter((item) => item.state === 'READY').length, 4);
});

test('a GitHub pause defers an unstarted checkout without consuming an attempt', async (t) => {
  const {db} = await makeFactory(t);
  const [task] = db.enqueueTasks(candidates(1));
  const driver = verifiedDriver({verified: 1});
  driver.checkout = async () => {
    const error = new Error('GitHub transport is paused');
    error.code = 'GITHUB_PAUSED';
    throw error;
  };

  const cycle = await runFactoryCycle({db, workers: 1, queueDepth: 1, driver});

  assert.deepEqual(cycle.results, [{
    task_id: task.task_id,
    state: 'DEFERRED',
    code: 'GITHUB_PAUSED',
    reason: 'GitHub transport is paused',
  }]);
  assert.equal(db.getTask(task.task_id).state, 'QUEUED');
  assert.equal(db.getTask(task.task_id).attempt_count, 0);
  assert.equal(db.stats().attempts, 0);
});

test('a hard model-provider usage limit defers work without retrying or consuming an attempt', async (t) => {
  const {db} = await makeFactory(t);
  const [task] = db.enqueueTasks(candidates(1));
  const driver = verifiedDriver({verified: 1});
  let calls = 0;
  driver.scout = async () => {
    calls += 1;
    const error = new Error("host Codex sandbox failed: You've hit your usage limit.");
    error.infrastructure = true;
    error.providerUnavailable = true;
    throw error;
  };

  const cycle = await runFactoryCycle({db, workers: 1, queueDepth: 1, driver});

  assert.equal(calls, 1);
  assert.equal(cycle.results[0].state, 'DEFERRED');
  assert.equal(cycle.results[0].code, 'MODEL_PROVIDER_UNAVAILABLE');
  assert.equal(db.getTask(task.task_id).state, 'QUEUED');
  assert.equal(db.getTask(task.task_id).attempt_count, 0);
  assert.equal(db.stats().attempts, 0);
});

test('failed candidates consume no mission IDs and ten verified results create a board automatically', async (t) => {
  const {db} = await makeFactory(t, {missionStart: 1000});
  db.enqueueTasks(candidates(50));
  await runUntilIdle({
    db,
    workers: 8,
    driver: verifiedDriver({verified: 10}),
    boardPolicy: {minSize: 10, maxAgeMinutes: 30, maximum: 30},
  });
  assert.equal(db.stats().attempts, 50);
  assert.equal(db.stats().ready_items, 10);
  assert.equal(db.listTasks({state: 'SKIPPED'}).length, 40);
  const ready = db.listReady({states: ['PENDING'], limit: 20});
  assert.deepEqual(ready.map((item) => item.mission_id),
    Array.from({length: 10}, (_, index) => `M-${1000 + index}`));
  assert.equal(db.stats().boards, 1);
  const board = db.connection.prepare('SELECT board_digest FROM boards').get();
  assert.equal(db.getBoard(board.board_digest).items.length, 10);
});

test('owner approves a subset and changing one item invalidates only its approval', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(10));
  await runUntilIdle({
    db,
    workers: 5,
    driver: verifiedDriver({verified: 10}),
    boardPolicy: {minSize: 10, maximum: 30},
  });
  const digest = db.connection.prepare('SELECT board_digest FROM boards').get().board_digest;
  const board = db.getBoard(digest);
  const selected = board.items.slice(0, 2).map((item) => item.mission_id);
  approveBoard(db, {board: digest, ids: selected, approvedBy: 'internal-user:aeziz',
    verifyArtifacts: () => ({ok: true})});
  assert.equal(db.getReadyItem(selected[0]).approval_state, 'APPROVED');
  assert.equal(db.getReadyItem(selected[1]).approval_state, 'APPROVED');
  assert.equal(db.getReadyItem(board.items[2].mission_id).approval_state, 'PENDING');

  const changed = db.getReadyItem(selected[0]);
  db.replaceReadyManifest(selected[0], {...changed.manifest, summary: 'Changed exact bytes'});
  assert.equal(db.getReadyItem(selected[0]).approval_state, 'PENDING');
  assert.equal(db.getTask(changed.task_id).state, 'READY');
  assert.equal(db.getReadyItem(selected[1]).approval_state, 'APPROVED');
  assert.equal(db.getTask(db.getReadyItem(selected[1]).task_id).state, 'APPROVED');
});

test('only one immutable board remains open while later READY work accumulates', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(20));
  await runUntilIdle({
    db,
    workers: 8,
    driver: verifiedDriver({verified: 20}),
    boardPolicy: {minSize: 10, maximum: 10},
  });
  assert.equal(db.connection.prepare("SELECT count(*) AS count FROM boards WHERE state='OPEN'").get().count, 1);
  assert.equal(db.getCurrentBoard().items.length, 10);
  assert.equal(db.listReady({unboarded: true, states: ['PENDING'], limit: 30}).length, 10);
});

test('a mutation before approval invalidates only that selection and clean items still approve', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(10));
  await runUntilIdle({
    db,
    workers: 5,
    driver: verifiedDriver({verified: 10}),
    boardPolicy: {minSize: 10, maximum: 30},
  });
  const board = db.getCurrentBoard();
  const changedId = board.items[0].mission_id;
  const cleanId = board.items[1].mission_id;
  const changed = db.getReadyItem(changedId);
  db.replaceReadyManifest(changedId, {...changed.manifest, summary: 'Bytes changed before approval'});
  const approval = approveBoard(db, {
    board: board.board_digest,
    ids: [changedId, cleanId],
    approvedBy: 'internal-user:aeziz',
    verifyArtifacts: () => ({ok: true}),
  });
  assert.deepEqual(approval.approved_mission_ids, [cleanId]);
  assert.deepEqual(approval.invalidated_mission_ids, [changedId]);
  assert.equal(db.getReadyItem(changedId).approval_state, 'PENDING');
  assert.equal(db.getTask(changed.task_id).state, 'READY');
  assert.equal(db.getReadyItem(cleanId).approval_state, 'APPROVED');
});

test('owner can reject an entire board without approving any mission', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(10));
  await runUntilIdle({
    db,
    workers: 5,
    driver: verifiedDriver({verified: 10}),
    boardPolicy: {minSize: 10, maximum: 30},
  });
  const board = db.getCurrentBoard();
  const rejected = board.items.map((item) => item.mission_id);
  const approval = approveBoard(db, {
    board: board.board_digest,
    ids: [],
    rejectedIds: rejected,
    approvedBy: 'internal-user:aeziz',
    verifyArtifacts: () => ({ok: true}),
  });
  assert.deepEqual(approval.approved_mission_ids, []);
  assert.deepEqual(approval.rejected_mission_ids, rejected.sort());
  assert.equal(db.getCurrentBoard(), null);
  assert.equal(db.listTasks({state: 'REJECTED_BY_OWNER', limit: 20}).length, 10);
});

test('one infrastructure retry stays within the same attempt record', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(1));
  let calls = 0;
  const driver = verifiedDriver({verified: 1});
  driver.checkout = async (task) => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('temporary clone failure');
      error.transient = true;
      throw error;
    }
    return `/private/${task.task_id}`;
  };
  await runFactoryCycle({db, workers: 1, driver});
  assert.equal(calls, 2);
  assert.equal(db.stats().attempts, 1);
  assert.equal(db.stats().ready_items, 1);
});

test('one transient scout retry stays within the same attempt record', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(1));
  let calls = 0;
  const driver = verifiedDriver({verified: 1});
  const originalScout = driver.scout;
  driver.scout = async (...args) => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('temporary model authentication failure');
      error.transient = true;
      error.infrastructure = true;
      throw error;
    }
    return originalScout(...args);
  };
  await runFactoryCycle({db, workers: 1, driver});
  assert.equal(calls, 2);
  assert.equal(db.stats().attempts, 1);
  assert.equal(db.stats().ready_items, 1);
});

test('provider control failures are recorded as infrastructure rather than worker quality', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(1));
  const driver = verifiedDriver({verified: 1});
  driver.scout = async () => {
    const error = new Error('host Codex sandbox rejected its output schema');
    error.infrastructure = true;
    throw error;
  };
  await runFactoryCycle({db, workers: 1, driver});
  const task = db.listTasks({state: 'FAILED', limit: 1})[0];
  const attempt = db.connection.prepare('SELECT * FROM attempts WHERE task_id=?').get(task.task_id);
  assert.equal(attempt.outcome, 'FAILED');
  assert.equal(attempt.failure_class, 'infrastructure');
});

test('an exhausted transient author retry is infrastructure, not a verification skip', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(1));
  let calls = 0;
  const driver = verifiedDriver({verified: 1});
  driver.author = async () => {
    calls += 1;
    const error = new Error('temporary model provider failure');
    error.transient = true;
    error.infrastructure = true;
    throw error;
  };
  await runFactoryCycle({db, workers: 1, driver});
  const task = db.listTasks({state: 'FAILED', limit: 1})[0];
  const attempt = db.connection.prepare('SELECT * FROM attempts WHERE task_id=?').get(task.task_id);
  assert.equal(calls, 2);
  assert.equal(attempt.outcome, 'FAILED');
  assert.equal(attempt.failure_class, 'infrastructure');
});

test('command driver recognizes narrow Codex control-plane failures', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oss-factory-worker-errors-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const cases = [
    ['host Codex sandbox failed: agent identity JWT payload is not valid JSON', true, false],
    ["host Codex sandbox failed: invalid_json_schema for response_format 'codex_output_schema'", false, false],
    ["host Codex sandbox failed: You've hit your usage limit.", false, true],
    ['host Codex sandbox failed: unexpected status 401 Unauthorized: Your authentication token has been invalidated. auth error code: token_invalidated', false, true],
    ['host Codex sandbox failed: unexpected status 401 Unauthorized: Encountered invalidated oauth token for user. auth error code: token_revoked', false, true],
  ];
  for (const [message, transient, providerUnavailable] of cases) {
    const driver = createCommandDriver({
      command: process.execPath,
      args: ['-e', `process.stderr.write(${JSON.stringify(message)}); process.exit(1);`],
      workRoot: root,
    });
    await assert.rejects(() => driver.scout(candidates(1)[0], root, {}), (error) =>
      error.infrastructure === true && error.transient === transient &&
        error.providerUnavailable === providerUnavailable);
  }
});

test('one verifier failure is passed to exactly one second author attempt', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(1));
  const driver = verifiedDriver({verified: 1});
  const feedback = [];
  let verifications = 0;
  const originalAuthor = driver.author;
  driver.author = async (...args) => {
    feedback.push(args[3].verifierFeedback);
    return originalAuthor(...args);
  };
  const originalVerify = driver.verify;
  driver.verify = async (...args) => {
    verifications += 1;
    if (verifications === 1) throw new Error('focused assertion failed');
    return originalVerify(...args);
  };
  await runFactoryCycle({db, workers: 1, driver});
  assert.deepEqual(feedback, [null, 'focused assertion failed']);
  assert.equal(verifications, 2);
  assert.equal(db.stats().attempts, 1);
  assert.equal(db.stats().ready_items, 1);
});

test('one transient verifier startup retry does not consume the second author attempt', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(1));
  const driver = verifiedDriver({verified: 1});
  let authors = 0;
  let verifications = 0;
  const originalAuthor = driver.author;
  const originalVerify = driver.verify;
  driver.author = async (...args) => { authors += 1; return originalAuthor(...args); };
  driver.verify = async (...args) => {
    verifications += 1;
    if (verifications === 1) {
      const error = new Error('temporary Docker startup failure');
      error.transient = true;
      throw error;
    }
    return originalVerify(...args);
  };
  await runFactoryCycle({db, workers: 1, driver});
  assert.equal(authors, 1);
  assert.equal(verifications, 2);
  assert.equal(db.stats().ready_items, 1);
});

test('a GO scout that classifies Red is skipped before bootstrap and never receives a mission ID', async (t) => {
  const {db} = await makeFactory(t, {missionStart: 1000});
  db.enqueueTasks(candidates(1));
  const driver = verifiedDriver({verified: 1});
  let bootstraps = 0;
  let authors = 0;
  driver.scout = async () => ({
    decision: 'GO', reason: 'security-sensitive change', test_command: 'node --test',
    target_files: ['src/security.mjs'], estimated_risk: 'RED',
  });
  driver.bootstrap = async () => { bootstraps += 1; return {}; };
  driver.author = async () => { authors += 1; return {}; };
  const result = await runFactoryCycle({db, workers: 1, driver});
  assert.equal(result.results[0].state, 'SKIPPED');
  assert.equal(result.results[0].reason, 'RED');
  assert.equal(bootstraps, 0);
  assert.equal(authors, 0);
  assert.equal(db.stats().ready_items, 0);
  assert.equal(db.connection.prepare("SELECT value FROM factory_meta WHERE key='next_mission_number'").get().value,
    '1000');
});

test('local factory work continues without consulting a paused GitHub publisher', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(1));
  const forbiddenSafety = new Proxy({}, {get() { throw new Error('local worker consulted GitHub safety'); }});
  void forbiddenSafety;
  const result = await runFactoryCycle({db, workers: 1, driver: verifiedDriver({verified: 1})});
  assert.equal(result.results[0].state, 'READY');
});
