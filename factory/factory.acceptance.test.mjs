import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {approveBoard, classifyRisk} from './board.mjs';
import {openFactoryDb} from './db.mjs';
import {
  assertDeclaredTestsExecuted,
  assertPublicVerificationClaims,
  createCommandDriver,
  createStageSemaphores,
  finalizePrBody,
  normalizeAuthorEvidence,
  removeWorkTree,
  runFactoryCycle,
  runUntilIdle,
} from './worker.mjs';
import {assertPublicationManifest, PROMOTION_FREE_DISCLOSURE} from './publication-policy.mjs';

async function makeFactory(t, {missionStart = 1000} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oss-factory-'));
  const db = openFactoryDb(path.join(root, 'factory.sqlite'), {missionStart});
  t.after(() => db.close());
  return {root, db};
}

test('rendered UI changes are at least AMBER risk', () => {
  for (const changedPath of [
    'src/ControlPanel.jsx', 'src/view.mjs', 'src/icon.svg', 'src/page.astro', 'src/content.mdx',
    'addon/content/components/conversation/conversationHeader.mjs',
    'src/Header.mjs', 'src/Button.js', 'src/render.mjs', 'src/router.js',
    'src/components/conversation/subject.mjs', 'src/dialog.mjs', 'src/layout.js',
    'src/modal.mjs', 'src/menu.js', 'src/screen.mjs', 'src/widget.js',
    'src/accordion.js', 'src/tabs.mjs', 'src/avatar.js',
  ]) {
    assert.equal(classifyRisk({
      changed_files: [{path: changedPath, class: 'production', lines: 20}],
      changed_lines: 20,
    }), 'AMBER', changedPath);
  }
  assert.equal(classifyRisk({
    changed_files: [{path: 'src/parser.mjs', class: 'production', lines: 20}],
    changed_lines: 20,
  }), 'GREEN');
});

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
      checks_not_run: [],
      limitations: [],
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
    checks_not_run: [{
      check: 'Manual screen-reader verification',
      reason: 'No physical test device was available',
    }],
    limitations: ['Accessibility props were verified without a physical screen reader.'],
    pr_body: '## Summary\n\nFix accessibility metadata.',
  });

  await runFactoryCycle({db, workers: 1, driver, boardPolicy: {minSize: 10}});

  const [ready] = db.listReady({states: ['PENDING'], limit: 1});
  assert.deepEqual(ready.manifest.checks, ['node --test']);
  assert.deepEqual(ready.manifest.proof.checks_not_run, [{
    check: 'Manual screen-reader verification',
    reason: 'No physical test device was available',
  }]);
  assert.deepEqual(ready.manifest.proof.limitations,
    ['Accessibility props were verified without a physical screen reader.']);
  assert.match(ready.manifest.pr_body,
    /Manual checks not run:\n- \[ \] Manual screen-reader verification — not run: No physical test device was available/);
  assert.deepEqual(ready.manifest.risk_warnings,
    ['Manual verification not run: Manual screen-reader verification']);
  assert.match(ready.manifest.pr_body, new RegExp(PROMOTION_FREE_DISCLOSURE));
  assert.match(ready.manifest.pr_body, /Checks:\n- `node --test` — passed/);
  assert.doesNotMatch(ready.manifest.pr_body, /receipt|M-1000|reviewed by Northset/iu);
  assert.equal(ready.manifest.receipt_visibility, 'private_internal');
  assert.equal(ready.manifest.receipt_url, null);
  assert.equal(ready.manifest.consent_scopes.scopes.receipt_publication_consent.status, 'absent');
  assert.match(ready.manifest.branch, /^fix\/fix-issue-1$/);
  assert.throws(() => assertPublicationManifest({
    ...ready.manifest,
    pr_body: '<!-- northset-receipt:M-1000:start -->old<!-- northset-receipt:M-1000:end -->',
  }), /promotion-free disclosure|legacy promotional/);
  const publicUrl = 'https://northset-oss.example/receipts/M-1000/';
  assert.throws(() => assertPublicationManifest({
    ...ready.manifest,
    receipt_visibility: 'public_opt_in',
    receipt_url: publicUrl,
    pr_body: finalizePrBody('Fix issue 1.', 'M-1000', publicUrl, {command: 'node --test'}),
    planned_actions: ['publish-proof', ...ready.manifest.planned_actions],
  }), /explicit receipt_publication_consent/);
});

test('unrun manual evidence must be structured, nonblank, and honest in PR text', () => {
  const valid = {
    checks_not_run: [{check: 'Manual VoiceOver verification', reason: 'No physical iPhone'}],
    limitations: ['Automated tests cover only accessibility props.'],
    pr_body: 'Adds accessibility metadata.',
  };
  assert.deepEqual(normalizeAuthorEvidence(valid), {
    checks_not_run: [{check: 'Manual VoiceOver verification', reason: 'No physical iPhone'}],
    limitations: ['Automated tests cover only accessibility props.'],
  });
  assert.throws(() => normalizeAuthorEvidence({...valid, checks_not_run: 'none'}),
    /checks_not_run must be an array/);
  assert.throws(() => normalizeAuthorEvidence({
    ...valid,
    checks_not_run: [{check: ' ', reason: 'No device'}],
  }), /nonblank single-line check and reason/);
  assert.throws(() => normalizeAuthorEvidence({
    ...valid,
    checks_not_run: [{check: 'Manual VoiceOver verification\n- [x] injected', reason: 'No device'}],
  }), /single-line check and reason/);
  assert.throws(() => normalizeAuthorEvidence({...valid, limitations: [' ']}),
    /limitations entries must be nonblank single-line/);
  assert.throws(() => normalizeAuthorEvidence({...valid, limitations: ['No device\n- injected']}),
    /limitations entries must be nonblank single-line/);
  for (const checked of [
    '- [x] Manual VoiceOver verification',
    '* [x] Manual VoiceOver verification',
    '- [x] Manual VoiceOver verification.',
    '- [x]  Manual VoiceOver verification',
    '- [x] **Manual VoiceOver verification**',
    '- [x] [Manual VoiceOver verification](https://example.test)',
    '1. [x] Manual VoiceOver verification',
    '- [x] Manual VoiceOver verification!',
    '- [x] <strong>Manual VoiceOver verification</strong>',
    '- [x] Manual VoiceOver verification(done)',
    '- [x] Manual VoiceOver verification✅',
  ]) assert.throws(() => normalizeAuthorEvidence({...valid, pr_body: checked}),
    /contradicts unrun check/);
});

test('manual disclosure remains before a preexisting managed PR footer', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(1));
  const driver = verifiedDriver({verified: 1});
  const author = driver.author;
  driver.author = async (...args) => ({
    ...await author(...args),
    checks_not_run: [{check: 'Manual VoiceOver verification', reason: 'No device'}],
    limitations: ['Physical VoiceOver behavior was not observed.'],
    pr_body: finalizePrBody('## Summary\n\nFix accessibility metadata.', 'M-old', null, {
      command: 'node --test',
    }),
  });

  await runFactoryCycle({db, workers: 1, driver, boardPolicy: {minSize: 10}});

  const [ready] = db.listReady({states: ['PENDING'], limit: 1});
  assert.match(ready.manifest.pr_body,
    /Manual checks not run:\n- \[ \] Manual VoiceOver verification — not run: No device/);
  assert.equal(ready.manifest.pr_body.split(PROMOTION_FREE_DISCLOSURE).length - 1, 1);
});

test('a late repository authoring block skips a queued task before checkout or model work', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(1));
  const reason = 'Maintainer requested no further authored contributions.';
  db.recordInteractionBlock({
    scope: 'repository',
    subject: 'owner1/repo1',
    blockAuthoring: true,
    blockOutreach: true,
    reason,
    reasonCode: 'maintainer_stop',
  });
  let checkoutCalls = 0;
  let scoutCalls = 0;
  const driver = verifiedDriver({verified: 1});
  driver.checkout = async () => { checkoutCalls += 1; return '/must-not-run'; };
  driver.scout = async () => { scoutCalls += 1; return {decision: 'GO'}; };

  const result = await runFactoryCycle({db, workers: 1, driver});
  assert.equal(result.results[0].state, 'SKIPPED');
  assert.equal(result.results[0].reason, reason);
  assert.equal(checkoutCalls, 0);
  assert.equal(scoutCalls, 0);
  assert.equal(db.listTasks({limit: 10})[0].state, 'SKIPPED');
  assert.equal(db.listTasks({limit: 10})[0].last_error, reason);
});

test('a scout timeout defers retry to a later durable attempt', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(1));
  const driver = verifiedDriver({verified: 1});
  let scoutCalls = 0;
  driver.scout = async () => {
    scoutCalls += 1;
    const error = new Error('worker command timed out after 90000ms');
    error.transient = true;
    throw error;
  };

  const result = await runFactoryCycle({db, workers: 1, driver});

  assert.equal(scoutCalls, 1);
  assert.equal(result.results[0].state, 'FAILED');
  const [task] = db.listTasks({limit: 10});
  assert.equal(task.state, 'FAILED');
  assert.equal(task.last_failure_class, 'infrastructure');
});

test('a late maintainer-user authoring block skips carried work before checkout', async (t) => {
  const {db} = await makeFactory(t);
  const [record] = candidates(1);
  record.live_state.interactionUsers = ['maintainer-one'];
  db.enqueueTasks([record]);
  db.recordInteractionBlock({
    scope: 'user',
    subject: 'maintainer-one',
    blockAuthoring: true,
    blockOutreach: true,
    reason: 'User-specific stop.',
    reasonCode: 'maintainer_stop',
  });
  let checkoutCalls = 0;
  const driver = verifiedDriver({verified: 1});
  driver.checkout = async () => { checkoutCalls += 1; return '/must-not-run'; };

  const result = await runFactoryCycle({db, workers: 1, driver});
  assert.equal(result.results[0].state, 'SKIPPED');
  assert.equal(result.results[0].reason, 'User-specific stop.');
  assert.equal(checkoutCalls, 0);
});

test('an authoring block inserted during preparation stops the model at its final boundary', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(1));
  const reason = 'Maintainer stop arrived while the task was preparing.';
  const driver = verifiedDriver({verified: 1});
  const bootstrap = driver.bootstrap;
  let authorCalls = 0;
  driver.bootstrap = async (...args) => {
    const result = await bootstrap(...args);
    db.recordInteractionBlock({
      scope: 'repository',
      subject: 'owner1/repo1',
      blockAuthoring: true,
      blockOutreach: true,
      reason,
      reasonCode: 'maintainer_stop',
    });
    return result;
  };
  driver.author = async () => {
    authorCalls += 1;
    throw new Error('author must not run after the late block');
  };

  const result = await runFactoryCycle({db, workers: 1, driver});

  assert.equal(result.results[0].state, 'SKIPPED');
  assert.equal(result.results[0].reason, reason);
  assert.equal(authorCalls, 0);
  assert.equal(db.listTasks({limit: 10})[0].state, 'SKIPPED');
  assert.equal(db.listTasks({limit: 10})[0].last_error, reason);
});

test('an authoring block inserted after a transient model failure stops its infrastructure retry', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(1));
  const reason = 'Maintainer stop arrived before the model retry.';
  const driver = verifiedDriver({verified: 1});
  let authorCalls = 0;
  driver.author = async () => {
    authorCalls += 1;
    if (authorCalls === 1) {
      db.recordInteractionBlock({
        scope: 'repository',
        subject: 'owner1/repo1',
        blockAuthoring: true,
        blockOutreach: true,
        reason,
        reasonCode: 'maintainer_stop',
      });
      const error = new Error('temporary model provider failure');
      error.transient = true;
      error.infrastructure = true;
      throw error;
    }
    throw new Error('author retry must not run after the late block');
  };

  const result = await runFactoryCycle({db, workers: 1, driver});

  assert.equal(result.results[0].state, 'SKIPPED');
  assert.equal(result.results[0].reason, reason);
  assert.equal(authorCalls, 1);
  assert.equal(db.listTasks({limit: 10})[0].state, 'SKIPPED');
  assert.equal(db.listTasks({limit: 10})[0].last_error, reason);
});

test('promotion-free footer renders the exact argv command', () => {
  const missionId = 'M-321';
  const receiptUrl = 'https://northset.test/receipts/M-321/';
  const facts = {
    command: ['node', '--test', 'test/value.test.mjs'],
    commitOid: 'abcdef0123456789abcdef0123456789abcdef01',
    changedFiles: [{path: 'src/value.mjs', class: 'production'}],
  };
  const rendered = finalizePrBody('Fix the value.', missionId, receiptUrl, facts);
  assert.match(rendered, /- `node --test test\/value\.test\.mjs` — passed/);
  assert.match(rendered, new RegExp(PROMOTION_FREE_DISCLOSURE));
  assert.doesNotMatch(rendered, /reviewed by Northset|without trusting us/iu);
});

test('promotion-free footer preserves exact long commands and deletes old receipt markers', () => {
  const missionId = 'M-322';
  const receiptUrl = 'https://northset.test/receipts/M-322/';
  const longCommand = `node --test ${'test/deeply-nested/'.repeat(4)}value.test.mjs`;
  const rendered = finalizePrBody('Fix the value.', missionId, receiptUrl, {
    command: longCommand,
    commitOid: '1234567890abcdef1234567890abcdef12345678',
    changedFiles: [],
  });
  assert.match(rendered, new RegExp(longCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const templated = [
    'Fix the value.',
    '',
    '<!-- northset-receipt:{{MISSION_ID}}:start -->',
    '[receipt {{MISSION_ID}}]({{RECEIPT_URL}})',
    '<!-- northset-receipt:{{MISSION_ID}}:end -->',
  ].join('\n');
  const finalized = finalizePrBody(templated, missionId, null, {
    command: 'node --test', commitOid: '1'.repeat(40), changedFiles: [],
  });
  assert.doesNotMatch(finalized, /northset-receipt|M-322/);
  assert.match(finalized, /- `node --test` — passed/);

  const refreshed = finalizePrBody(finalized, missionId, null, {
    command: ['npm', 'test'], commitOid: '2'.repeat(40), changedFiles: [], replaceExisting: true,
  });
  assert.match(refreshed, /- `npm test` — passed/);
  assert.equal(refreshed.match(/AI assistance was used/g)?.length, 1);
});

test('publication policy rejects incident product, CTA, and external-endorsement phrases', () => {
  const manifest = (summary) => ({
    mission_id: 'M-901',
    receipt_visibility: 'private_internal',
    receipt_url: null,
    consent_scopes: {
      schema_version: 2,
      mission_id: 'M-901',
      scopes: {
        contribution_invitation: {status: 'not_applicable'},
        verification_execution_consent: {status: 'not_applicable'},
        receipt_publication_consent: {status: 'absent'},
        marketing_reference_consent: {status: 'absent'},
      },
    },
    planned_actions: [],
    checks: ['node --test'],
    pr_body: `${summary}\n\n${PROMOTION_FREE_DISCLOSURE}\n\nChecks:\n- \`node --test\` — passed\n`,
  });
  const incidentPhrases = [
    'Upstream CI agreed with the receipt.',
    'Upstream CI disagreed with this receipt.',
    'CI validated this proof-of-pass receipt.',
    'The maintainers endorsed the technical evidence.',
    'The reviewer ratified our receipt.',
    'This contribution was approved by upstream CI.',
    'Request a verification run for your project.',
    'We offer verification to maintainers.',
    'Try the Northset verification product.',
    'Try Northset Verify at https://northset.ai today.',
    'Maintain nodejs/doc-kit?',
    'Use the prefilled email to request a run.',
    'View our public ledger for the result.',
  ];
  for (const phrase of incidentPhrases) {
    assert.throws(() => assertPublicationManifest(manifest(phrase)),
      /contribution-only|legacy promotional/, phrase);
  }
  for (const contributionText of [
    'The parser validated the payload before returning it.',
    'This implements the requested receipt parser behavior.',
    'Approved configuration values are now preserved.',
  ]) {
    assert.equal(assertPublicationManifest(manifest(contributionText)), true);
  }
  const evidence = {
    repository: 'northset/project',
    commit_oid: 'a'.repeat(40),
    path: '.github/test-evidence/result.png',
  };
  evidence.url =
    `https://raw.githubusercontent.com/${evidence.repository}/${evidence.commit_oid}/${evidence.path}`;
  assert.equal(assertPublicationManifest({
    ...manifest(`Evidence: ${evidence.url}`),
    evidence_asset: evidence,
  }), true);
  assert.throws(() => assertPublicationManifest({
    ...manifest(`Evidence: https://raw.githubusercontent.com/northset/other/${evidence.commit_oid}/${evidence.path}`),
    evidence_asset: evidence,
  }), /contribution-only/);
});

test('PR text cannot deny that its exact clean verifier command ran and passed', () => {
  const command = 'yarn test --watchAll=false --runTestsByPath src/__tests__/selectors.test.js';
  const chainedCommand = 'node --test test/junit-analyzer.test.mjs && npm test';
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

  assert.throws(() => assertPublicVerificationClaims({
    pr_body: '## Testing\n- `npm test` could not run because npm execution is blocked in this workspace',
  }, {
    patched_observation: {
      command: chainedCommand,
      result: 'PASS',
      exit_code: 0,
    },
  }), /PR body says the clean verifier command did not run/);

  assert.throws(() => assertPublicVerificationClaims({
    pr_body: '## Testing\nNot run locally: the sandbox denied npm execution with operation not permitted.',
  }, {
    patched_observation: {
      command: 'npm test -- --runInBand __TEST__/hyperaudio-lite.test.js -t "share-link highlight includes first transcript word" && npm run build && npm run test',
      result: 'PASS',
      exit_code: 0,
    },
  }), /PR body says the clean verifier command did not run/);

  assert.throws(() => assertPublicVerificationClaims({
    pr_body: [
      '## Testing',
      'The command and manual VoiceOver testing were not run because the sandbox blocked npm.',
      '- [ ] `npm test` passes',
      '- [ ] `npm run typecheck` passes',
    ].join('\n'),
  }, {
    patched_observation: {
      command: 'npm test -- --runTestsByPath nav.test.tsx && npm test && npm run typecheck',
      result: 'PASS',
      exit_code: 0,
    },
  }), /PR body says the clean verifier command did not run/);

  assert.throws(() => assertPublicVerificationClaims({
    pr_body: [
      '## Testing',
      'The exact command passed in the clean verifier.',
      '- [ ] `npm test` passes',
      '- [x] `npm run typecheck` passes',
    ].join('\n'),
  }, {
    patched_observation: {
      command: 'npm test -- --runTestsByPath nav.test.tsx && npm test && npm run typecheck',
      result: 'PASS',
      exit_code: 0,
    },
  }), /leaves a clean-verifier command unchecked/);

  for (const prBody of [
    '## Testing\nThe command did not complete.',
    '## Testing\nThe command did not pass.',
    '## Testing\nThe command did not succeed.',
    '## Testing\nThe command did not run tests.',
    '## Testing\nThe command did not run browser tests.',
    '## Testing\nCould not complete the command.',
    '## Testing\nThe command timed out.',
    '## Testing\nCommand was not run.',
    '## Testing\nTest command did not run.',
    '## Testing\nVerification command was not run.',
    '## Testing\nRequired command could not complete.',
  ]) {
    assert.throws(() => assertPublicVerificationClaims({
      pr_body: prBody,
    }, {
      patched_observation: {
        command: 'npm test && npm run typecheck',
        result: 'PASS',
        exit_code: 0,
      },
    }), /PR body says the clean verifier command did not run/);
  }

  for (const prBody of [
    '## Testing\nThe command passed. It did not run manual VoiceOver checks; those remain unchecked.',
    '## Testing\nThe command passed.\n- [ ] Verify Windows behavior after running `npm test`.',
    '## Testing\nThe command passed.\n- [ ] `npm test` passes on Windows.',
    '## Testing\nThe command passed.\n- [ ] `npm test` passes in CI.',
    '## Testing\nThe command passed.\n- [ ] `npm test` passes with Node 20.',
    '## Testing\nThe command passed.\n- [ ] Tests pass (`npm test`) against PostgreSQL.',
    '## Testing\nThe command passed.\n- [ ] `npm test` passes in Windows.',
    '## Testing\nThe command passed.\n- [ ] `npm test` passes in GitHub Actions.',
    '## Testing\nThe command passed.\n- [ ] `npm test` passes on Ubuntu.',
    '## Testing\nThe command passed.\n- [ ] `npm test` passes with npm 10.',
    '## Testing\nThe command passed.\n- [ ] `npm test` passes against MongoDB.',
    '## Testing\nThe command passed.\n- [ ] `npm test` passes on Chrome.',
    '## Testing\nThe command passed.\n- [ ] In GitHub Actions, `npm test` passes.',
    '## Testing\nThe command passed.\n- [ ] On Ubuntu, `npm test` passes.',
    '## Testing\nThe command passed.\n- [ ] `npm test` passes for Node 20.',
    '## Testing\nThe command passed.\n- [ ] `npm test` passes inside Docker.',
    '## Testing\nThe command passed.\n- [ ] `npm test` passes within the CI container.',
    '## Testing\nThe command passed.\n- [ ] npm test:e2e passes.',
    '## Testing\nThe command-line parser now preserves failed checks for reporting.',
    '## Testing\nThe command handler returns unavailable when the input file is missing.',
    '## Testing\nThe `command` property records failed child processes.',
    '## Testing\nThe command and failed-input tests were added.',
    '## Testing\nThe command and its failed output were stored for inspection.',
    '## Testing\nThe command and unavailable-file cases were covered.',
    '## Testing\nThe command failed before the fix but now passes.',
    '## Testing\nThe command timed out on the first attempt, then passed.',
    '## Testing\n- [x] `npm test`\n- [x] `npm run typecheck`\n- [ ] Manual QA was not run',
    '## Testing\nExact command: `npm test && npm run typecheck`\n- [ ] Optional browser checks unavailable',
  ]) {
    assert.doesNotThrow(() => assertPublicVerificationClaims({
      pr_body: prBody,
    }, {
      patched_observation: {
        command: 'npm test && npm run typecheck',
        result: 'PASS',
        exit_code: 0,
      },
    }));
  }

  for (const checklist of [
    '- [ ] `npm test` passes locally.',
    '- [ ] `npm test` passed successfully.',
    '- [ ] Tests pass (`npm test`).',
    '- [ ] npm test and npm run typecheck pass.',
    '- [ ] Please ensure `npm test` passes.',
    '- [ ] Verify tests pass (`npm test`).',
    '- [ ] `npm test` passes before submitting.',
    '- [ ] Run `npm test` successfully.',
    '- [ ] `npm test` passes for this PR.',
    '- [ ] `npm test` passes with no failures.',
    '- [ ] `npm test` passes on completion.',
    '- [ ] `npm test` passes using the command above.',
    '- [ ] `npm test` passes inside the verifier.',
    '- [ ] `npm test` passes and optional manual QA completes.',
    '- [ ] `npm test` passes on Windows and `npm run typecheck` passes.',
    '- [ ] `npm test` passes with zero failures.',
    '- [ ] `npm test` passes under normal conditions.',
    '- [ ] `npm test` passes on Windows or `npm run typecheck` passes.',
    '- [ ] Optional docs validation alongside `npm test` passes.',
  ]) {
    assert.throws(() => assertPublicVerificationClaims({
      pr_body: `## Testing\nThe command passed.\n${checklist}`,
    }, {
      patched_observation: {
        command: 'npm test && npm run typecheck',
        result: 'PASS',
        exit_code: 0,
      },
    }), /leaves a clean-verifier command unchecked/);
  }

  for (const prBody of [
    '## Testing\nFull command attempted but blocked because dependencies were unavailable.',
    '## Testing\nThe complete command could not execute locally. Syntax checks passed.',
    '## Testing\nThe entire command did not run.',
    '## Testing\nThe complete command was skipped.',
    '## Testing\nThe complete command failed.',
    '## Testing\nThe sandbox could not run the full command.',
    '## Testing\nThe complete command was unable to run.',
    '## Testing\nThe complete command did not execute.',
    '## Testing\nThe sandbox did not run the full command.',
    '## Testing\nWe skipped the full command.',
    '## Testing\nThe full verification command could not run.',
    '## Testing\nThe complete command could not be executed.',
    '## Testing\nThe command was not run in full.',
    '## Testing\nThe command itself did not run.',
    '## Testing\nThe command still did not run.',
    '## Testing\nThe command was never run.',
    '## Testing\nCould not run this command.',
    '## Testing\nCould not run that command.',
    '## Testing\nUnable to run the command.',
    '## Testing\nThe command did not run, while earlier lint failed but now passes.',
    '## Testing\nThe command also did not run.',
    '## Testing\nThe command was skipped.',
    '## Testing\nThe command was unavailable.',
    '## Testing\nThe command was blocked.',
    "## Testing\nThe command hasn't run.",
    '## Testing\nThe command was not able to run.',
    '## Testing\nThe command cannot run in this sandbox.',
    "## Testing\nThe command can't be run here.",
    '## Testing\nThe command does not run in this sandbox.',
    '## Testing\nThe command is unavailable in this sandbox.',
    '## Testing\nThe command was\nnot run because the sandbox blocked it.',
    '## Testing\nThe exact command\nwas unavailable in the sandbox.',
  ]) {
    assert.throws(() => assertPublicVerificationClaims({
      pr_body: prBody,
    }, {
      patched_observation: {
        command: 'node test/run.mjs && npm test',
        result: 'PASS',
        exit_code: 0,
      },
    }), /PR body says the clean verifier command did not run/);
  }

  for (const prBody of [
    '## Testing\nThe full command output is unavailable, but the command passed.',
    '## Testing\nThe full command passed; npm run lint was not run.',
    '## Testing\nOutput for the full command is unavailable.',
    "## Testing\nThe full command's output is unavailable.",
    '## Testing\nThe full command’s output is unavailable.',
    '## Testing\nThe result of executing the full command is unavailable.',
    '## Testing\nThe full command documentation is unavailable.',
    '## Testing\n`npm test` passed; browser tests were not run.',
    '## Testing\n`npm test` passed, but the optional lint check was unavailable.',
    '## Testing\n`npm test` passed in CI, but optional lint could not run.',
    '## Testing\n`npm test` passed, but could not run optional browser tests.',
    '## Testing\nThe full command initially failed, then passed after installing dependencies.',
    '## Testing\n`npm test` initially failed due to missing dependencies, then passed.',
    '## Testing\nInitially, the full command failed, then passed after installing dependencies.',
    '## Testing\nThe full command initially failed because dependencies were missing, but passed after installing them.',
  ]) {
    assert.doesNotThrow(() => assertPublicVerificationClaims({
      pr_body: prBody,
    }, {
      patched_observation: {
        command: 'node test/run.mjs && npm test',
        result: 'PASS',
        exit_code: 0,
      },
    }));
  }

  for (const prBody of [
    '## Testing\nThe full command output is unavailable because the full command could not run.',
    '## Testing\nOutput for the full command is unavailable because the full command did not run.',
    '## Testing\nThe full command could not execute locally, then syntax checks passed.',
    '## Testing\n`npm test` failed, then the lint check passed.',
    '## Testing\n`npm test` passed previously, but could not run in the clean verifier.',
    '## Testing\n`npm test` passed in CI, but could not run in the clean verifier.',
    '## Testing\n`npm test` passed in CI, but it could not run in the clean verifier.',
  ]) {
    assert.throws(() => assertPublicVerificationClaims({
      pr_body: prBody,
    }, {
      patched_observation: {
        command: 'node test/run.mjs && npm test',
        result: 'PASS',
        exit_code: 0,
      },
    }), /PR body says the clean verifier command did not run/);
  }

  assert.doesNotThrow(() => assertPublicVerificationClaims({
    pr_body: `## Testing\n- \`${chainedCommand}\` passed in the clean verifier\n- npm run lint was not run`,
  }, {
    patched_observation: {command: chainedCommand, result: 'PASS', exit_code: 0},
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

  const signaled = createCommandDriver({
    command: process.execPath,
    args: ['-e', "process.kill(process.pid, 'SIGTERM');"],
    workRoot: root,
  });
  await assert.rejects(() => signaled.scout(candidates(1)[0], root, {}), (error) =>
    error.infrastructure === true && /signal SIGTERM/.test(error.message));
  const noisySignal = createCommandDriver({
    command: process.execPath,
    args: ['-e', "process.stderr.write('cleanup failed'); process.kill(process.pid, 'SIGTERM');"],
    workRoot: root,
  });
  await assert.rejects(() => noisySignal.scout(candidates(1)[0], root, {}), (error) =>
    error.infrastructure === true && /signal SIGTERM: cleanup failed/.test(error.message));
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

test('an interrupted second author preserves the first verifier failure', async (t) => {
  const {db} = await makeFactory(t);
  db.enqueueTasks(candidates(1));
  const driver = verifiedDriver({verified: 1});
  const originalAuthor = driver.author;
  let authors = 0;
  driver.author = async (...args) => {
    authors += 1;
    if (authors === 2) {
      const error = new Error('worker command failed: signal SIGTERM');
      error.infrastructure = true;
      throw error;
    }
    return originalAuthor(...args);
  };
  driver.verify = async () => {
    throw new Error('focused assertion failed');
  };

  await runFactoryCycle({db, workers: 1, driver});

  const [task] = db.listTasks({state: 'FAILED', limit: 1});
  assert.equal(task.last_failure_class, 'infrastructure');
  assert.match(task.last_error, /signal SIGTERM/);
  assert.match(task.last_error, /prior verifier feedback: focused assertion failed/);
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
