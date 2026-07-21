import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acquireFactoryRunLock,
  FACTORY_DEFAULTS,
  executeFactoryCli,
  main,
  parseFactoryCliArgs,
} from './cli.mjs';

const BOARD = `sha256:${'a'.repeat(64)}`;

test('run lock rejects a live duplicate, canonicalizes aliases, and releases for reuse', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-run-lock-test-'));
  const realRoot = path.join(root, 'real');
  const aliasRoot = path.join(root, 'alias');
  await mkdir(realRoot);
  await symlink(realRoot, aliasRoot);
  const database = path.join(realRoot, 'factory.sqlite');
  const alias = path.join(aliasRoot, 'factory.sqlite');
  let first;
  let recovered;
  try {
    first = await acquireFactoryRunLock(database);
    await assert.rejects(
      () => acquireFactoryRunLock(alias),
      /already active/,
    );

    await first.release();
    recovered = await acquireFactoryRunLock(alias);
  } finally {
    await recovered?.release();
    await first?.release();
    await rm(root, {recursive: true, force: true});
  }
});

test('run lock creates a missing database parent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-run-lock-parent-test-'));
  let lock;
  try {
    const database = path.join(root, 'missing', 'nested', 'factory.sqlite');
    lock = await acquireFactoryRunLock(database);
    assert.equal(path.basename(lock.path), 'factory.sqlite.run-lock.sqlite');
  } finally {
    await lock?.release();
    await rm(root, {recursive: true, force: true});
  }
});

test('main releases the run lock after success and failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-main-lock-test-'));
  const database = path.join(root, 'factory.sqlite');
  const argv = ['run', '--db', database, '--once'];
  let lock;
  try {
    const successDb = fakeDb({stats: () => ({tasks: 0})});
    const success = await main(argv, {
      env: {},
      stdout: output().stream,
      stderr: output().stream,
      dependencies: baseDependencies(successDb, {
        source: {fill: async () => ({candidates: [], results: [], enqueued: []})},
        createBoard: () => null,
        runCycle: async () => ({claimed: 0, results: []}),
      }),
    });
    assert.equal(success, 0);
    lock = await acquireFactoryRunLock(database);
    await lock.release();
    lock = null;

    const stderr = output();
    const failure = await main(argv, {
      env: {},
      stdout: output().stream,
      stderr: stderr.stream,
      dependencies: baseDependencies(null, {
        openDb: () => { throw new Error('injected open failure'); },
      }),
    });
    assert.equal(failure, 1);
    assert.match(stderr.read(), /injected open failure/);
    lock = await acquireFactoryRunLock(database);
  } finally {
    await lock?.release();
    await rm(root, {recursive: true, force: true});
  }
});

test('standalone reconcile shares the factory run lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-reconcile-lock-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const database = path.join(root, 'factory.sqlite');
  const held = await acquireFactoryRunLock(database);
  t.after(() => held.release());
  const stderr = output();
  const code = await main(['reconcile', '--db', database], {
    env: {}, stdout: output().stream, stderr: stderr.stream,
    dependencies: {openDb: () => assert.fail('locked reconcile must not open the database')},
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /already active/);
});

function output() {
  let value = '';
  return {
    stream: {write(chunk) { value += String(chunk); }},
    read: () => value,
  };
}

function fakeDb(overrides = {}) {
  return {
    closed: false,
    close() { this.closed = true; },
    ...overrides,
  };
}

function baseDependencies(db, overrides = {}) {
  return {
    openDb: () => db,
    transport: async (request) => request.execute?.() ?? {status: 200},
    github: {
      graphql: async () => ({data: {}}),
      deepOverlap: async () => ({clean: true}),
      finalLiveRecheck: async () => ({clean: true}),
    },
    ...overrides,
  };
}

test('parser provides stable paths and strictly validates command-specific arguments', () => {
  const parsed = parseFactoryCliArgs(['run', '--workers', '8', '--board-size', '20'], {env: {}});
  assert.deepEqual({
    database: parsed.database,
    lake: parsed.lake,
    pauseFile: parsed.pauseFile,
    workRoot: parsed.workRoot,
    artifactRoot: parsed.artifactRoot,
    workerCommand: parsed.workerCommand,
    receiptRemote: parsed.receiptRemote,
  }, {
    database: FACTORY_DEFAULTS.database,
    lake: FACTORY_DEFAULTS.lake,
    pauseFile: FACTORY_DEFAULTS.pauseFile,
    workRoot: FACTORY_DEFAULTS.workRoot,
    artifactRoot: FACTORY_DEFAULTS.artifactRoot,
    workerCommand: FACTORY_DEFAULTS.workerCommand,
    receiptRemote: FACTORY_DEFAULTS.receiptRemote,
  });
  assert.equal(parsed.profile, 'node');
  assert.equal(parsed.workers, 8);
  assert.equal(parsed.candidateLimit, 16);
  assert.equal(parsed.boardMaxAgeMinutes, 30);
  assert.equal(parsed.pollMs, 5000);
  assert.equal(parsed.once, false);

  assert.deepEqual(parseFactoryCliArgs([
    'approve', '--board', BOARD, '--ids', 'M-001,M-204', '--reject-ids', 'M-009',
  ], {env: {}}).ids, ['M-001', 'M-204']);
  assert.deepEqual(parseFactoryCliArgs([
    'approve', '--board', BOARD, '--reject-ids', 'M-009',
  ], {env: {}}).ids, []);
  assert.throws(() => parseFactoryCliArgs(['approve', '--board', BOARD], {env: {}}),
    /requires --ids, --reject-ids/);
  assert.throws(() => parseFactoryCliArgs(['run', '--profile', 'python'], {env: {}}), /Node-only/);
  assert.throws(() => parseFactoryCliArgs(['board', '--workers', '4'], {env: {}}), /unknown argument/);
  assert.throws(() => parseFactoryCliArgs(['approve', '--board', BOARD, '--ids', 'M-001,M-001'], {env: {}}),
    /duplicate mission/);
  assert.throws(() => parseFactoryCliArgs(['publish', '--board', 'B-1'], {env: {}}), /sha256/);
  assert.equal(parseFactoryCliArgs([
    'publish', '--board', BOARD, '--repository-open-override', 'M-1046',
  ], {env: {}}).repositoryOpenOverrideMissionId, 'M-1046');
  assert.throws(() => parseFactoryCliArgs([
    'publish', '--board', BOARD, '--repository-open-override', 'M-1046,M-1047',
  ], {env: {}}), /one mission ID/);
  assert.deepEqual(parseFactoryCliArgs([
    'reconcile', '--limit', '17', '--receipt-remote', 'https://example.test/receipts.git',
  ], {env: {}}), {
    command: 'reconcile', database: FACTORY_DEFAULTS.database, pauseFile: FACTORY_DEFAULTS.pauseFile,
    ghBin: 'gh', limit: 17, receiptRemote: 'https://example.test/receipts.git',
  });
  assert.throws(() => parseFactoryCliArgs(['reconcile', '--limit', '0'], {env: {}}), /positive integer/);
  assert.throws(() => parseFactoryCliArgs(['github-resume'], {env: {}}), /--reason is required/);
  assert.equal(parseFactoryCliArgs([
    'github-resume', '--reason', 'reviewed', '--acknowledge-forbidden',
  ], {env: {}}).acknowledgeForbidden, true);
});

test('run fills from the lake once and drains workers with the requested board policy', async () => {
  const db = fakeDb({stats: () => ({ready_items: 1})});
  const stdout = output();
  const calls = [];
  let sourceGithub;
  const source = {
    async fill(options) {
      calls.push({name: 'fill', options});
      await sourceGithub.graphql('query FactoryLivePreflight { viewer { login } }');
      await sourceGithub.deepOverlap({repository: {nameWithOwner: 'owner/repo'}});
      return {
        candidates: [{candidate: 'owner/repo#1'}, {candidate: 'owner/repo#2'}],
        results: [{outcome: 'GO'}, {outcome: 'SKIP'}],
        enqueued: [{task_id: 'T-1'}],
      };
    },
  };
  const driver = {name: 'injected-driver'};
  const result = await executeFactoryCli([
    'run', '--profile', 'node', '--workers', '3', '--board-size', '12',
    '--board-max-age-minutes', '15', '--candidate-limit', '6', '--once',
  ], {
    env: {},
    stdout: stdout.stream,
    dependencies: baseDependencies(db, {
      driver,
      github: {
        graphql: async (query) => { calls.push({name: 'graphql', query}); return {data: {}}; },
        deepOverlap: async (live) => { calls.push({name: 'overlap', live}); return {clean: true}; },
      },
      createSource: (options) => { sourceGithub = options.github; return source; },
      createSafety: () => ({request: async (request) => {
        calls.push({name: 'safety', request});
        return request.execute();
      }}),
      createBoard: () => null,
      runCycle: async (options) => {
        calls.push({name: 'run', options});
        return {claimed: 1, results: [{state: 'READY'}]};
      },
    }),
  });

  assert.equal(calls.filter((call) => call.name === 'fill').length, 1);
  assert.equal(calls[0].options.workers, 3);
  assert.equal(calls[0].options.limit, 6);
  assert.deepEqual(calls.filter((call) => call.name === 'safety').map((call) => call.request.operation),
    ['factory_live_preflight', 'deep_overlap']);
  const runCall = calls.find((call) => call.name === 'run');
  assert.equal(runCall.options.driver, driver);
  assert.deepEqual(runCall.options.boardPolicy, {minSize: 12, maxAgeMinutes: 15});
  assert.deepEqual(result.source, {selected: 2, go: 1, skipped: 1, escalated: 0, enqueued: 1, paused: 0});
  assert.equal(result.iterations, 1);
  assert.equal(result.claimed, 1);
  assert.equal(JSON.parse(stdout.read()).stats.ready_items, 1);
  assert.equal(db.closed, true);
});

test('run uses the production Node worker by default', async () => {
  const db = fakeDb({stats: () => ({tasks: 0})});
  let driverOptions;
  await executeFactoryCli(['run', '--once'], {
    env: {},
    stdout: output().stream,
    dependencies: baseDependencies(db, {
      source: {fill: async () => ({candidates: [], results: [], enqueued: []})},
      createDriver: (options) => { driverOptions = options; return {}; },
      createBoard: () => null,
      runCycle: async () => ({claimed: 0, results: []}),
    }),
  });
  assert.equal(driverOptions.command, FACTORY_DEFAULTS.workerCommand);
  assert.equal(driverOptions.artifactRoot, FACTORY_DEFAULTS.artifactRoot);
  assert.equal(db.closed, true);
});

test('production run routes exact public source checkout through the safety queue', async () => {
  const publicState = () => ({open_northset_prs: 0});
  const db = fakeDb({
    getPublicActionState: publicState,
    recoverWorkingTasks: () => ({recovered: 1, task_ids: ['TASK-1']}),
    stats: () => ({tasks: 1}),
  });
  const requests = [];
  const transportRequests = [];
  let driverOptions;
  let safetyRepositoryState;
  const transport = async (request) => {
    transportRequests.push(request);
    assert.equal(request.operation, 'git_clone');
    return {status: 200, repository_path: request.destination, base_oid: request.base_oid};
  };
  const result = await executeFactoryCli([
    'run', '--worker-command', '/opt/northset/author', '--once',
  ], {
    env: {},
    stdout: output().stream,
    dependencies: baseDependencies(db, {
      transport,
      source: {fill: async () => ({candidates: [], results: [], enqueued: []})},
      createSafety: (options) => {
        safetyRepositoryState = options.repositoryState;
        return {request: async (request) => {
          requests.push(request);
          return request.execute();
        }};
      },
      createDriver: (options) => { driverOptions = options; return {}; },
      createBoard: () => null,
      runCycle: async () => {
        const task = {task_id: 'TASK-1', repository: 'owner/repo', base_oid: '1'.repeat(40)};
        const checkout = await driverOptions.checkoutProvider(
          task, {attempt_id: 'ATTEMPT-1'}, path.resolve('/tmp/factory-test-root'));
        assert.equal(checkout.checkout, path.resolve('/tmp/factory-test-root/repository'));
        return {claimed: 1, results: [{state: 'READY'}]};
      },
    }),
  });
  assert.equal(driverOptions.command, '/opt/northset/author');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].operation, 'checkout_exact_base');
  assert.equal(requests[0].kind, 'read');
  assert.equal(requests[0].repository, 'owner/repo');
  assert.equal(transportRequests.length, 1);
  assert.equal(transportRequests[0].operation, 'git_clone');
  assert.equal(transportRequests[0].base_oid, '1'.repeat(40));
  assert.equal(transportRequests[0].destination, path.resolve('/tmp/factory-test-root/repository'));
  assert.equal(typeof safetyRepositoryState, 'function');
  assert.deepEqual(safetyRepositoryState({repository: 'owner/repo'}), {open_northset_prs: 0});
  assert.equal(result.recovered, 1);
});

test('run remains alive when idle, ticks board age, and stops through the injected signal', async () => {
  const controller = new AbortController();
  const db = fakeDb({stats: () => ({ready_items: 2})});
  let cycles = 0;
  let boardTicks = 0;
  let sleeps = 0;
  const result = await executeFactoryCli(['run', '--poll-ms', '25'], {
    env: {},
    signal: controller.signal,
    stdout: output().stream,
    dependencies: baseDependencies(db, {
      driver: {},
      source: {fill: async () => ({candidates: [], results: [], enqueued: []})},
      createSafety: () => ({request: async () => ({status: 200})}),
      runCycle: async () => {
        cycles += 1;
        return cycles === 1 ? {claimed: 1, results: [{state: 'READY'}]} : {claimed: 0, results: []};
      },
      createBoard: () => { boardTicks += 1; return null; },
      sleep: async (milliseconds, signal) => {
        sleeps += 1;
        assert.equal(milliseconds, 25);
        assert.equal(signal, controller.signal);
        controller.abort();
      },
    }),
  });
  assert.equal(cycles, 2);
  assert.equal(result.source.paused, 0);
  assert.equal(boardTicks, 2);
  assert.equal(sleeps, 1);
  assert.equal(result.stopped, true);
  assert.equal(result.claimed, 1);
  assert.equal(db.closed, true);
});

test('a GitHub pause skips new preflight but still offers queued local work to the cycle', async () => {
  const db = fakeDb({stats: () => ({ready_items: 1})});
  let cycles = 0;
  const paused = new Error('publication paused');
  paused.code = 'GITHUB_PAUSED';
  const result = await executeFactoryCli(['run', '--once'], {
    env: {},
    stdout: output().stream,
    dependencies: baseDependencies(db, {
      driver: {},
      source: {fill: async () => { throw paused; }},
      createBoard: () => null,
      runCycle: async () => {
        cycles += 1;
        return {claimed: 1, results: [{state: 'READY'}]};
      },
    }),
  });
  assert.equal(cycles, 1);
  assert.equal(result.claimed, 1);
  assert.equal(result.source.paused, 1);
  assert.equal(db.closed, true);
});

test('a model-provider outage stops the continuous runner after preserving the current claim', async () => {
  const db = fakeDb({stats: () => ({ready_items: 1})});
  let cycles = 0;
  const result = await executeFactoryCli(['run'], {
    env: {},
    stdout: output().stream,
    dependencies: baseDependencies(db, {
      driver: {},
      source: {fill: async () => ({candidates: [], results: [], enqueued: []})},
      createBoard: () => null,
      runCycle: async () => {
        cycles += 1;
        return {claimed: 1, results: [{state: 'DEFERRED', code: 'MODEL_PROVIDER_UNAVAILABLE'}]};
      },
      sleep: async () => { throw new Error('provider outage must not enter a retry loop'); },
    }),
  });
  assert.equal(cycles, 1);
  assert.equal(result.stop_reason, 'MODEL_PROVIDER_UNAVAILABLE');
  assert.equal(result.stopped, false);
  assert.equal(db.closed, true);
});

test('a transient preflight failure still drains queued work and retries on the next iteration', async () => {
  const controller = new AbortController();
  const db = fakeDb({stats: () => ({ready_items: 1})});
  let fills = 0;
  let cycles = 0;
  const transient = new Error('temporary GitHub preflight timeout');
  transient.code = 'ETIMEDOUT';
  const result = await executeFactoryCli(['run', '--poll-ms', '0'], {
    env: {},
    signal: controller.signal,
    stdout: output().stream,
    dependencies: baseDependencies(db, {
      driver: {},
      source: {fill: async () => {
        fills += 1;
        if (fills === 1) throw transient;
        return {candidates: [], results: [], enqueued: []};
      }},
      createBoard: () => null,
      runCycle: async () => {
        cycles += 1;
        if (cycles === 2) controller.abort();
        return {claimed: cycles === 1 ? 1 : 0, results: []};
      },
      sleep: async () => {},
    }),
  });
  assert.equal(fills, 2);
  assert.equal(cycles, 2);
  assert.equal(result.claimed, 1);
  assert.equal(result.source_failures, 1);
  assert.match(result.last_source_error, /temporary GitHub preflight timeout/);
});

test('run performs one bounded asynchronous reconciliation pass without blocking local work', async () => {
  const db = fakeDb({
    listReconciliationCandidates: () => [],
    stats: () => ({ready_items: 1}),
  });
  let statusPublisherOptions;
  let reconciliationOptions;
  let localCycles = 0;
  const statusPublisher = async () => ({});
  const result = await executeFactoryCli([
    'run', '--once', '--receipt-remote', 'https://example.test/receipts.git',
  ], {
    env: {},
    stdout: output().stream,
    dependencies: baseDependencies(db, {
      driver: {},
      source: {fill: async () => ({candidates: [], results: [], enqueued: []})},
      createBoard: () => null,
      createSafety: () => ({request: async (request) => request.execute(), releaseRepository: async () => {}}),
      createReceiptStatusPublisher: (options) => {
        statusPublisherOptions = options;
        return statusPublisher;
      },
      reconcilePublicationBatch: async (options) => {
        reconciliationOptions = options;
        return {processed: 2, results: []};
      },
      runCycle: async () => {
        localCycles += 1;
        return {claimed: 1, results: [{state: 'READY'}]};
      },
    }),
  });
  assert.equal(localCycles, 1);
  assert.deepEqual(statusPublisherOptions, {remoteUrl: 'https://example.test/receipts.git'});
  assert.equal(reconciliationOptions.db, db);
  assert.equal(reconciliationOptions.statusPublisher, statusPublisher);
  assert.equal(reconciliationOptions.limit, 30);
  assert.deepEqual(result.reconciliation, {
    runs: 1, processed: 2, failures: 0, paused: 0, last_error: null,
  });
});

test('a paused reconciliation lane is reported but does not stop queued local execution', async () => {
  const db = fakeDb({listReconciliationCandidates: () => [], stats: () => ({ready_items: 1})});
  const paused = Object.assign(new Error('GitHub publication is paused'), {code: 'GITHUB_PAUSED'});
  let localCycles = 0;
  const result = await executeFactoryCli(['run', '--once'], {
    env: {},
    stdout: output().stream,
    dependencies: baseDependencies(db, {
      driver: {},
      source: {fill: async () => ({candidates: [], results: [], enqueued: []})},
      createBoard: () => null,
      createReceiptStatusPublisher: () => async () => ({}),
      reconcilePublicationBatch: async () => { throw paused; },
      runCycle: async () => {
        localCycles += 1;
        return {claimed: 1, results: [{state: 'READY'}]};
      },
    }),
  });
  assert.equal(localCycles, 1);
  assert.equal(result.reconciliation.failures, 1);
  assert.equal(result.reconciliation.paused, 1);
  assert.match(result.reconciliation.last_error, /publication is paused/);
});

test('reconcile runs one bounded pass without creating workers, sources, or boards', async () => {
  const db = fakeDb({listReconciliationCandidates: () => []});
  const stdout = output();
  let statusPublisherOptions;
  let reconciliationOptions;
  const statusPublisher = async () => ({});
  const github = {getPullRequest: async () => ({})};
  const safety = {request: async (request) => request.execute(), releaseRepository: async () => {}};
  const expected = {processed: 1, results: [{mission_id: 'M-001', follow_up: {review_decision: null}}]};
  const result = await executeFactoryCli([
    'reconcile', '--limit', '7', '--receipt-remote', 'https://example.test/receipts.git',
  ], {
    env: {}, stdout: stdout.stream,
    dependencies: baseDependencies(db, {
      github,
      createSafety: () => safety,
      createReceiptStatusPublisher: (options) => {
        statusPublisherOptions = options;
        return statusPublisher;
      },
      createSource: () => assert.fail('reconcile must not create a source'),
      createDriver: () => assert.fail('reconcile must not create a worker driver'),
      createBoard: () => assert.fail('reconcile must not create a board'),
      runCycle: () => assert.fail('reconcile must not run workers'),
      reconcilePublicationBatch: async (options) => {
        reconciliationOptions = options;
        return expected;
      },
    }),
  });
  assert.deepEqual(result, expected);
  assert.deepEqual(JSON.parse(stdout.read()), expected);
  assert.deepEqual(statusPublisherOptions, {remoteUrl: 'https://example.test/receipts.git'});
  assert.equal(reconciliationOptions.db, db);
  assert.equal(reconciliationOptions.github, github);
  assert.equal(reconciliationOptions.safety, safety);
  assert.equal(reconciliationOptions.statusPublisher, statusPublisher);
  assert.equal(reconciliationOptions.limit, 7);
  assert.equal(db.closed, true);
});

test('board displays the current immutable board or creates one from READY items', async () => {
  const board = {board_digest: BOARD, items: [{mission_id: 'M-001'}]};
  const db = fakeDb({getCurrentBoard: async () => board});
  const stdout = output();
  let createCalls = 0;
  const result = await executeFactoryCli(['board'], {
    env: {},
    stdout: stdout.stream,
    dependencies: baseDependencies(db, {
      createBoard: () => { createCalls += 1; },
      renderBoard: (value) => `board ${value.board_digest}`,
    }),
  });
  assert.equal(result, board);
  assert.equal(stdout.read(), `board ${BOARD}\n`);
  assert.equal(createCalls, 0);
  assert.equal(db.closed, true);

  const emptyDb = fakeDb({getCurrentBoard: async () => null});
  const emptyOutput = output();
  await executeFactoryCli(['board'], {
    env: {},
    stdout: emptyOutput.stream,
    dependencies: baseDependencies(emptyDb, {createBoard: () => null}),
  });
  assert.equal(JSON.parse(emptyOutput.read()).board, null);
});

test('approve records exactly the selected and rejected mission IDs', async () => {
  const db = fakeDb();
  const stdout = output();
  let received;
  const approval = {board_digest: BOARD, approved_mission_ids: ['M-001', 'M-002']};
  const result = await executeFactoryCli([
    'approve', '--board', BOARD, '--ids', 'M-001,M-002', '--reject-ids', 'M-003',
    '--approved-by', 'internal-user:owner',
  ], {
    env: {},
    stdout: stdout.stream,
    dependencies: baseDependencies(db, {
      approveBoard: async (database, options) => { received = {database, options}; return approval; },
    }),
  });
  assert.equal(received.database, db);
  assert.deepEqual(received.options, {
    board: BOARD,
    ids: ['M-001', 'M-002'],
    rejectedIds: ['M-003'],
    approvedBy: 'internal-user:owner',
  });
  assert.equal(result, approval);
  assert.equal(JSON.parse(stdout.read()).board_digest, BOARD);
  assert.equal(db.closed, true);
});

test('publish routes a mission-bound repository-open override to the publisher', async () => {
  const db = fakeDb();
  const stdout = output();
  const events = [];
  const github = {
    async finalLiveRecheck(plan) {
      events.push({name: 'github-recheck', plan});
      return {clean: true};
    },
  };
  const safety = {
    async request(request) {
      events.push({name: 'safety', request});
      return request.execute();
    },
  };
  const receiptPublisher = async (items) => {
    events.push({name: 'receipt', items});
    return {'M-001': {receipt_url: 'https://receipts.test/M-001'}};
  };
  let publicationOptions;
  const result = await executeFactoryCli([
    'publish', '--board', BOARD, '--repository-open-override', 'M-1046',
  ], {
    env: {},
    stdout: stdout.stream,
    dependencies: baseDependencies(db, {
      github,
      receiptPublisher,
      createSafety: () => safety,
      publishBoard: async (digest, options) => {
        publicationOptions = options;
        const plan = {mission_id: 'M-001', repository: 'owner/repo'};
        assert.deepEqual(await options.safety.request({
          priority: 'final_submission',
          kind: 'read',
          operation: 'final_live_recheck',
          repository: plan.repository,
          execute: () => options.liveRecheck(plan),
        }), {clean: true});
        await options.receiptPublisher([plan]);
        return {board_digest: digest, results: [{mission_id: 'M-001', state: 'SUBMITTED'}]};
      },
    }),
  });

  assert.equal(publicationOptions.db, db);
  assert.equal(publicationOptions.github, github);
  assert.equal(publicationOptions.safety, safety);
  assert.equal(publicationOptions.repositoryOpenOverrideMissionId, 'M-1046');
  assert.equal(events[0].name, 'safety');
  assert.equal(events[0].request.priority, 'final_submission');
  assert.equal(events[0].request.kind, 'read');
  assert.equal(events[0].request.operation, 'final_live_recheck');
  assert.deepEqual(events.map((event) => event.name), ['safety', 'github-recheck', 'receipt']);
  assert.equal(result.results[0].state, 'SUBMITTED');
  assert.equal(db.closed, true);
});

test('publish uses the production receipt prepublication adapter by default', async () => {
  const db = fakeDb();
  let receiptOptions;
  let staleOptions;
  let publicationOptions;
  const receiptPublisher = async () => ({commit_oid: '1'.repeat(40)});
  await executeFactoryCli(['publish', '--board', BOARD], {
    env: {},
    stdout: output().stream,
    dependencies: baseDependencies(db, {
      github: {finalLiveRecheck: async () => ({clean: true})},
      createSafety: () => ({request: async (request) => request.execute()}),
      createReceiptPublisher: (options) => {
        receiptOptions = options;
        return receiptPublisher;
      },
      createStaleRefresher: (options) => {
        staleOptions = options;
        return async () => ({reason: 'not exercised'});
      },
      publishBoard: async (_board, options) => {
        publicationOptions = options;
        return {results: []};
      },
    }),
  });
  assert.deepEqual(receiptOptions, {remoteUrl: FACTORY_DEFAULTS.receiptRemote});
  assert.equal(publicationOptions.receiptPublisher, receiptPublisher);
  assert.equal(typeof publicationOptions.refreshStale, 'function');
  assert.equal(staleOptions.artifactRoot, FACTORY_DEFAULTS.artifactRoot);
  assert.equal(db.closed, true);
});

test('github-status is read-only and github-resume performs one injected probe path', async () => {
  const statusOutput = output();
  const status = {paused: true, pause: {kind: 'GITHUB_SECONDARY_RATE_LIMIT'}};
  let safetyOptions;
  const statusResult = await executeFactoryCli(['github-status'], {
    env: {},
    stdout: statusOutput.stream,
    dependencies: {
      transport: async () => assert.fail('status must not call transport'),
      createSafety: (options) => {
        safetyOptions = options;
        return {status: async () => status};
      },
    },
  });
  assert.equal(statusResult, status);
  assert.equal(safetyOptions.pauseFile, FACTORY_DEFAULTS.pauseFile);
  assert.equal(JSON.parse(statusOutput.read()).paused, true);

  const resumeOutput = output();
  let resumeOptions;
  const resumeResult = await executeFactoryCli([
    'github-resume', '--reason', 'founder reviewed cooldown', '--cleared-by', 'internal-user:owner',
    '--acknowledge-forbidden',
  ], {
    env: {},
    stdout: resumeOutput.stream,
    dependencies: {
      transport: async () => ({status: 200}),
      resumeGitHub: async (options) => {
        resumeOptions = options;
        return {paused: false, clear_reason: options.reason};
      },
    },
  });
  assert.equal(resumeOptions.reason, 'founder reviewed cooldown');
  assert.equal(resumeOptions.clearedBy, 'internal-user:owner');
  assert.equal(resumeOptions.acknowledgeForbidden, true);
  assert.equal(typeof resumeOptions.transport, 'function');
  assert.equal(resumeResult.paused, false);

  const repositoryDb = fakeDb({
    getRepositoryState: () => ({
      repository: 'owner/repo', cooldown_reason: 'maintainer opt-out reviewed',
      cooldown_until: 'manual-release',
    }),
    setRepositoryState: (_repository, patch) => ({repository: 'owner/repo', ...patch}),
  });
  const repositoryResult = await executeFactoryCli([
    'github-resume', '--reason', 'founder cleared the reviewed repository cooldown',
    '--repository', 'owner/repo',
  ], {
    env: {}, stdout: output().stream,
    dependencies: {
      openDb: () => repositoryDb,
      transport: async () => assert.fail('repository cooldown release must not call GitHub'),
    },
  });
  assert.equal(repositoryResult.cooldown_cleared, true);
  assert.equal(repositoryResult.repository_state.cooldown_reason, null);
  assert.equal(repositoryDb.closed, true);
});

test('environment paths and command adapters are resolved without shell parsing', () => {
  const parsed = parseFactoryCliArgs(['run'], {
    env: {
      OSS_FACTORY_DB: './tmp/factory.sqlite',
      OSS_FACTORY_LAKE: './tmp/lake.sqlite',
      OSS_FACTORY_PAUSE_FILE: './tmp/pause.json',
      OSS_FACTORY_WORKER_COMMAND: '/opt/northset/worker',
      OSS_FACTORY_ARTIFACT_ROOT: './tmp/artifacts',
      OSS_FACTORY_RECEIPT_REMOTE: 'https://example.test/receipts.git',
    },
  });
  assert.equal(parsed.database, path.resolve('./tmp/factory.sqlite'));
  assert.equal(parsed.lake, path.resolve('./tmp/lake.sqlite'));
  assert.equal(parsed.pauseFile, path.resolve('./tmp/pause.json'));
  assert.equal(parsed.workerCommand, '/opt/northset/worker');
  assert.equal(parsed.artifactRoot, path.resolve('./tmp/artifacts'));
  assert.equal(parsed.receiptRemote, 'https://example.test/receipts.git');
});
