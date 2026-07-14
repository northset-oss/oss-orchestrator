import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as core from './core.mjs';
import * as finder from './find-candidates.mjs';
import * as oss from './oss.mjs';
import * as reviewer from './review-issue.mjs';
import * as ship from './ship.mjs';

const oid = (char) => char.repeat(40);
const digest = (char) => `sha256:${char.repeat(64)}`;

function qualification(overrides = {}) {
  return {
    review_id: digest('1'),
    review_prompt_version: 2,
    reviewed_at: '2026-07-13T12:00:00Z',
    qualification_expires_at: '2026-07-13T14:00:00Z',
    evidence_sha256: digest('2'),
    issue_updated_at: '2026-07-13T11:00:00Z',
    invitation_evidence: {
      type: 'label', url: 'https://github.com/owner/repo/issues/123', observed_at: '2026-07-13T12:00:00Z',
    },
    pre_author_notice_required: false,
    pre_author_notice: null,
    acceptance_contract: {
      problem: 'The parser returns the wrong value for a bounded input.',
      expected_behavior: ['The focused input returns the documented value.'],
      non_goals: ['No public API expansion.'],
      design_evidence: [{
        url: 'https://github.com/owner/repo/issues/123', author_association: 'OWNER', summary: 'Owner-settled behavior.',
      }],
    },
    related_prs: [],
    ...overrides,
  };
}

function spec(overrides = {}) {
  return {
    schema_version: 1,
    mission_id: 'M-017',
    candidate: 'owner/repo#123',
    target_repo: 'https://github.com/owner/repo',
    issue_url: 'https://github.com/owner/repo/issues/123',
    base_branch: 'main',
    base_commit: oid('a'),
    problem_statement: 'The parser returns the wrong value for a bounded input.',
    acceptance_criteria: ['The focused regression passes for that input.'],
    constraints: ['Do not change dependencies or public API.'],
    implementation_hints: [],
    process_requirements: [],
    qualification: qualification(),
    oracle: {
      kind: 'regression_test', test_paths: ['test/parser.test.mjs'],
      command: 'npm test -- test/parser.test.mjs', base_expected: 'nonzero', base_exit_code: 1,
      base_failure_contains: 'bounded parser regression', patched_expected: 'zero',
    },
    pr: {title: 'fix(parser): handle the bounded input', summary: 'Fix the parser and add a focused regression test.'},
    executor: {
      profile: 'node', image: 'node:22-bookworm', install_commands: ['npm ci'],
      commands: ['npm test -- test/parser.test.mjs'], limits: {},
    },
    ...overrides,
  };
}

async function initRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'northset-review-v2-repo-'));
  await core.git(repo, 'init');
  await core.git(repo, 'config', 'user.name', 'Author Agent');
  await core.git(repo, 'config', 'user.email', 'agent@example.com');
  await mkdir(path.join(repo, 'test'));
  await writeFile(path.join(repo, 'src.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(repo, 'test', 'existing.test.mjs'), 'assert.equal(value, 1);\n');
  await core.git(repo, 'add', '.');
  await core.git(repo, 'commit', '-m', 'base');
  return {repo, base: (await core.git(repo, 'rev-parse', 'HEAD')).stdout.trim()};
}

test('global deadline is shared across sequential subprocesses', async () => {
  assert.equal(typeof core.createDeadline, 'function');
  const deadline = core.createDeadline(650);
  const started = Date.now();
  assert.equal((await core.run(process.execPath, ['-e', 'setTimeout(() => {}, 80)'], {deadline, timeoutMs: 500})).code, 0);
  const second = await core.run(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], {deadline, timeoutMs: 1000});
  assert.equal(second.code, 124);
  assert.equal(second.timedOut, true);
  assert.ok(Date.now() - started < 900);
});

test('process-tree timeout terminates a spawned descendant', async () => {
  const parent = [
    "const {spawn}=require('node:child_process')",
    "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
    "require('node:fs').writeSync(1, String(child.pid)+'\\n')",
    "process.on('SIGTERM',()=>{})",
    'setInterval(()=>{},1000)',
  ].join(';');
  const result = await core.run(process.execPath, ['-e', parent], {timeoutMs: 500});
  assert.equal(result.code, 124);
  const childPid = Number(result.stdout.trim().split('\n')[0]);
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { process.kill(childPid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`descendant ${childPid} survived process-group termination`);
});

test('operator termination is forwarded through nested detached subprocess groups', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-signal-forward-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const pidFile = path.join(root, 'child.pid');
  const coreUrl = new URL('./core.mjs', import.meta.url).href;
  const nested = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const wrapperSource = `import {run} from ${JSON.stringify(coreUrl)};run(process.execPath,['-e',${JSON.stringify(nested)}],{timeoutMs:60000});setInterval(()=>{},1000)`;
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', wrapperSource], {stdio: 'ignore'});
  let childPid = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { childPid = Number(await readFile(pidFile, 'utf8')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  wrapper.kill('SIGTERM');
  await new Promise((resolve) => wrapper.once('close', resolve));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { process.kill(childPid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`nested subprocess ${childPid} survived operator termination`);
});

test('excess subprocess output is killed with a bounded diagnostic', async () => {
  const result = await core.run(process.execPath, ['-e', "process.stdout.write('x'.repeat(100000))"], {outputLimitBytes: 1024});
  assert.equal(result.code, 125);
  assert.equal(result.outputLimitExceeded, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 1200);
  assert.match(result.stderr, /output limit/i);
});

test('chatty subprocess output can be truncated without killing a successful command', async () => {
  const result = await core.run(
    process.execPath,
    ['-e', "process.stdout.write('x'.repeat(100000)); process.exit(0)"],
    {outputLimitBytes: 1024, terminateOnOutputLimit: false},
  );
  assert.equal(result.code, 0);
  assert.equal(result.outputLimitExceeded, false);
  assert.equal(result.outputTruncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 1200);
  assert.match(result.stderr, /output truncated/i);
});

test('review and finder expose their finite wall-clock and complexity caps', () => {
  assert.equal(reviewer.REVIEW_BUDGET_MS, 5 * 60 * 1000);
  assert.equal(reviewer.CODEX_OUTPUT_LIMIT_BYTES, 3_500_000);
  assert.equal(reviewer.GITHUB_EVIDENCE_OUTPUT_LIMIT_BYTES, 10_000_000);
  assert.equal(finder.FINDER_VERSION, '2.0.4');
  assert.equal(finder.parseArgs(['1'], {}).totalBudgetMs, 20 * 60 * 1000);
  assert.equal(finder.parseArgs(['1'], {}).maxReviews, 12);
  assert.equal(finder.parseArgs(['20'], {}).maxReviews, 40);
  assert.deepEqual(reviewer.relatedPrPlan(Array.from({length: 12}, (_, index) => ({url: `pr-${index}`}))), {
    considered: Array.from({length: 12}, (_, index) => ({url: `pr-${index}`})),
    hydrate: Array.from({length: 8}, (_, index) => ({url: `pr-${index}`})),
  });
  assert.throws(() => reviewer.relatedPrPlan(Array.from({length: 13}, (_, index) => ({url: `pr-${index}`}))), /12/);
});

test('review evidence packets carry the live observation time', () => {
  const observedAt = '2026-07-14T15:30:00.000Z';
  const packet = reviewer.buildEvidencePacket(
    {key: 'owner/repo#123', url: 'https://github.com/owner/repo/issues/123'},
    oid('a'),
    {issueData: {state: 'OPEN'}},
    observedAt,
  );

  assert.equal(packet.observed_at, observedAt);
  assert.equal(packet.candidate, 'owner/repo#123');
  assert.equal(packet.base_commit, oid('a'));
});

test('qualification metadata is mandatory and mutating oracle setup is forbidden', () => {
  assert.doesNotThrow(() => core.validateSpec(spec()));
  const missing = spec({qualification: qualification()});
  delete missing.qualification.review_id;
  assert.throws(() => core.validateSpec(missing), /review_id/);
  assert.throws(() => core.validateSpec(spec({oracle: {...spec().oracle, setup_commands: ['node generate.mjs']}})), /setup_commands|fast lane/i);
});

test('author commits are squashed into one canonical commit directly on the approved base', async (t) => {
  assert.equal(typeof oss.normalizeAuthorResult, 'function');
  const {repo, base} = await initRepo();
  t.after(() => rm(repo, {recursive: true, force: true}));
  await writeFile(path.join(repo, 'src.mjs'), 'export const value = 2;\n');
  await core.git(repo, 'add', '.');
  await core.git(repo, 'commit', '-m', 'author-created commit');
  await writeFile(path.join(repo, 'test', 'new.test.mjs'), 'assert.equal(value, 2);\n');
  const ready = path.join(repo, '.ready');
  const value = spec({
    base_commit: base,
    oracle: {...spec().oracle, test_paths: ['test/new.test.mjs'], command: 'npm test -- test/new.test.mjs'},
    executor: {...spec().executor, commands: ['npm test -- test/new.test.mjs']},
  });
  const result = await oss.normalizeAuthorResult(value, repo, ready);
  const parents = (await core.git(repo, 'rev-list', '--parents', '-n', '1', result.commit)).stdout.trim().split(' ');
  assert.deepEqual(parents, [result.commit, base]);
  const identity = (await core.git(repo, 'show', '-s', '--format=%ae%n%ce%n%b', result.commit)).stdout;
  assert.match(identity, /aeziz@northset\.ai/);
  assert.match(identity, /Signed-off-by:/);
});

test('history rewritten away from the approved base is rejected', async (t) => {
  const {repo, base} = await initRepo();
  t.after(() => rm(repo, {recursive: true, force: true}));
  await core.git(repo, 'checkout', '--orphan', 'unrelated');
  await core.git(repo, 'rm', '-rf', '.');
  await writeFile(path.join(repo, 'other.txt'), 'unrelated\n');
  await core.git(repo, 'add', '.');
  await core.git(repo, 'commit', '-m', 'unrelated');
  await assert.rejects(() => oss.normalizeAuthorResult(spec({base_commit: base}), repo, path.join(repo, '.ready')), /approved base|ancestor/i);
});

test('dependency and author containers protect nested Git metadata', () => {
  const value = spec();
  for (const args of [
    oss.dependencyBootstrapDockerArgs(value, '/runs/M-017/author-workspace', value.executor.image, '/cache'),
    oss.authorDockerArgs(value, '/runs/M-017/author-workspace', 'sha256:' + '9'.repeat(64), '/secret/codex'),
  ]) {
    assert.ok(args.some((part) => String(part).includes('src=/runs/M-017/author-workspace/repo/.git,dst=/workspace/repo/.git,readonly')));
  }
});

test('rename records retain both paths and cannot masquerade as an added regression', async (t) => {
  const {repo, base} = await initRepo();
  t.after(() => rm(repo, {recursive: true, force: true}));
  await core.git(repo, 'mv', 'test/existing.test.mjs', 'test/renamed.test.mjs');
  await core.git(repo, 'commit', '-m', 'rename test');
  const commit = (await core.git(repo, 'rev-parse', 'HEAD')).stdout.trim();
  const changed = await oss.changedEntries(repo, base, commit);
  assert.equal(changed.entries[0].statusCode, 'R');
  assert.equal(changed.entries[0].oldPath, 'test/existing.test.mjs');
  assert.equal(changed.entries[0].path, 'test/renamed.test.mjs');
  const classes = oss.classifyChangedFiles(changed.baseFiles, changed.entries);
  assert.equal(classes[0].class, 'rename');
  assert.throws(() => oss.assertOracleChangedPaths(spec({oracle: {...spec().oracle, test_paths: ['test/renamed.test.mjs'], command: 'npm test -- test/renamed.test.mjs'}}), classes), /newly added|modified existing/i);
});

test('verifier workspace is read-only and tree mutation checks fail closed', async () => {
  const args = oss.checkDockerArgs(spec(), '/runs/M-017/oracle', 'node@sha256:' + '9'.repeat(64), spec().oracle.command);
  assert.ok(args.some((part) => String(part).includes('src=/runs/M-017/oracle,dst=/workspace,readonly')));
  assert.equal(typeof oss.assertExpectedTree, 'function');
});

test('differential oracle copies immediate npm workspace dependencies', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-workspace-deps-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const from = path.join(root, 'from');
  const to = path.join(root, 'to');
  await mkdir(path.join(from, 'node_modules', 'root-dep'), {recursive: true});
  await mkdir(path.join(from, 'packages', 'core', 'node_modules', 'workspace-dep'), {recursive: true});
  await mkdir(to, {recursive: true});
  await writeFile(path.join(from, 'node_modules', 'root-dep', 'index.js'), 'root\n');
  await writeFile(path.join(from, 'packages', 'core', 'node_modules', 'workspace-dep', 'index.js'), 'workspace\n');

  await oss.copyNodeDependencies(from, to);

  assert.equal(await readFile(path.join(to, 'node_modules', 'root-dep', 'index.js'), 'utf8'), 'root\n');
  assert.equal(await readFile(path.join(to, 'packages', 'core', 'node_modules', 'workspace-dep', 'index.js'), 'utf8'), 'workspace\n');
});

test('ship state machine makes no outbound call after a stale pre-public recheck', async () => {
  const calls = [];
  const journal = ship.newJournal({mission_id: 'M-017', bundle_digest: digest('1')}, digest('2'), digest('3'), new Date('2026-07-13T12:00:00Z'));
  const result = await ship.runShipStateMachine({manifest: {mission_id: 'M-017'}}, journal, {
    save: async () => {},
    prePublicRecheck: async () => ({clean: false, reasons: ['issue closed']}),
    push: async () => calls.push('push'), publishPreparedReceipt: async () => calls.push('publish'),
    attest: async () => calls.push('attest'), confirmReceipt: async () => calls.push('receipt'),
    prePrCollisionCheck: async () => ({clean: true}),
    openPr: async () => calls.push('pr'), syncDisclosure: async () => calls.push('sync'),
    publishFinalEnvelope: async () => calls.push('envelope'),
    publishNotSubmitted: async () => calls.push('not-submitted'),
  });
  assert.equal(result.state, 'ABORTED_STALE');
  assert.deepEqual(calls, []);
});

test('a successful infrastructure retry remains in the append-only ship evidence', async () => {
  const journal = ship.newJournal({mission_id: 'M-017', bundle_digest: digest('1')}, digest('2'), digest('3'), new Date('2026-07-13T12:00:00Z'));
  let pushAttempts = 0;
  const result = await ship.runShipStateMachine({manifest: {mission_id: 'M-017'}}, journal, {
    save: async () => {}, prePublicRecheck: async () => ({clean: true}),
    push: async () => { pushAttempts += 1; if (pushAttempts === 1) throw new Error('fork not ready'); },
    publishPreparedReceipt: async () => {}, attest: async () => {}, confirmReceipt: async () => {},
    prePrCollisionCheck: async () => ({clean: true}), openPr: async () => {},
    syncDisclosure: async () => {}, publishFinalEnvelope: async () => {}, publishNotSubmitted: async () => {},
  });
  assert.equal(result.state, 'SHIPPED');
  assert.equal(result.retry_count, 1);
  assert.deepEqual(result.retry_history.map(({action, error}) => ({action, error})), [
    {action: 'push', error: 'fork not ready'},
  ]);
  assert.match(result.retry_history[0].at, /^2026-|^20[0-9]{2}-/);
  assert.equal(result.last_error, null);
});

test('a post-public collision leaves the receipt prepared and consumes the mission id', async () => {
  const calls = [];
  const journal = ship.newJournal({mission_id: 'M-017', bundle_digest: digest('1')}, digest('2'), digest('3'), new Date('2026-07-13T12:00:00Z'));
  const result = await ship.runShipStateMachine({manifest: {mission_id: 'M-017'}}, journal, {
    save: async () => {}, prePublicRecheck: async () => ({clean: true}),
    push: async () => calls.push('push'), publishPreparedReceipt: async () => calls.push('publish'),
    attest: async () => calls.push('attest'), confirmReceipt: async () => calls.push('receipt'),
    prePrCollisionCheck: async () => ({clean: false, reasons: ['competing PR']}),
    openPr: async () => calls.push('pr'), syncDisclosure: async () => calls.push('sync'),
    publishFinalEnvelope: async () => calls.push('envelope'),
    publishNotSubmitted: async () => calls.push('not-submitted'),
  });
  assert.equal(result.state, 'ABORTED_AFTER_PUBLICATION');
  assert.deepEqual(calls, ['push', 'publish', 'attest', 'receipt', 'not-submitted']);
  assert.equal(ship.isTerminalShipState(result.state), true);
});

test('expiry gates initiation but permits exact-byte journal resumption started before expiry', () => {
  const manifest = {expires_at: '2026-07-13T13:00:00Z'};
  const missionManifest = core.manifestDigest([manifest]);
  const after = new Date('2026-07-13T14:00:00Z');
  assert.equal(ship.readyPackMayStart(manifest, null, after), false);
  assert.equal(ship.readyPackMayStart(manifest, {
    started_at: '2026-07-13T12:30:00Z', mission_manifest: missionManifest,
  }, after), true);
  assert.equal(ship.readyPackMayStart(manifest, {
    started_at: '2026-07-13T13:30:00Z', mission_manifest: missionManifest,
  }, after), false);
  assert.equal(ship.readyPackMayStart(manifest, {
    started_at: '2026-07-13T12:30:00Z', mission_manifest: digest('9'),
  }, after), false);
});

test('normal upstream advancement is allowed at ship when ancestry and mergeability hold', async () => {
  const value = spec();
  const state = {head: oid('b')};
  const gh = async (args) => {
    const joined = args.join(' ');
    if (joined.includes('/comments?')) return [[]];
    if (joined.includes('/timeline?')) return [[]];
    if (joined.startsWith('pr list')) return [];
    if (joined.includes('/git/ref/heads/')) return {object: {sha: state.head}};
    if (joined.includes('/issues/123')) return {
      number: 123, state: 'open', title: 'Parser defect', html_url: value.issue_url,
      assignees: [], labels: ['help wanted'], created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-13T13:00:00Z',
      body: 'body', author_association: 'OWNER', user: {login: 'maintainer'},
    };
    return {default_branch: 'main', archived: false, fork: false, html_url: value.target_repo};
  };
  const result = await core.recheck(value, async () => {}, {
    gh, mode: 'pre-public',
    ancestryCheck: async () => true,
    mergeabilityCheck: async () => true,
    now: () => new Date('2026-07-13T13:00:00Z'),
  });
  assert.equal(result.clean, true);
});

test('one terminal mission does not prevent the next approved mission from running', async () => {
  const seen = [];
  const results = await ship.runIndependentBatch([{id: 'one'}, {id: 'two'}], async (item) => {
    seen.push(item.id);
    if (item.id === 'one') throw new Error('terminal failure');
    return {state: 'SHIPPED'};
  });
  assert.deepEqual(seen, ['one', 'two']);
  assert.equal(results[0].state, 'FAILED_INFRA_TERMINAL');
  assert.equal(results[1].state, 'SHIPPED');
});

test('active specs directory contains only runnable current-schema JSON', async () => {
  assert.equal(typeof oss.validateActiveSpecs, 'function');
  await assert.doesNotReject(() => oss.validateActiveSpecs(path.join(import.meta.dirname, 'specs')));
});
