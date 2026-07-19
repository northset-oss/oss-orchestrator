#!/usr/bin/env node

import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {approveBoard, createBoardIfDue, renderBoard} from './board.mjs';
import {openFactoryDb} from './db.mjs';
import {createGhCliPublisherAdapter, createGhCliTransport} from './gh-cli.mjs';
import {createGitHubSafety, resumeGitHub} from './github-safety.mjs';
import {publishBoard} from './publisher.mjs';
import {createReceiptPublisher} from './receipt-publisher.mjs';
import {createSource} from './source.mjs';
import {createCommandDriver, runFactoryCycle} from './worker.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_FILE), '..');

export const FACTORY_DEFAULTS = Object.freeze({
  database: path.join(REPO_ROOT, 'runs', 'factory', 'factory.sqlite'),
  lake: path.join(REPO_ROOT, 'candidate_lake.sqlite'),
  pauseFile: path.join(REPO_ROOT, 'runs', 'factory', 'github-pause.json'),
  workRoot: path.join(REPO_ROOT, 'runs', 'factory', 'work'),
  workerCommand: path.join(REPO_ROOT, 'factory', 'node-worker.mjs'),
  receiptRemote: 'https://github.com/northset-oss/verification-pilot.git',
});

const COMMANDS = new Set(['run', 'board', 'approve', 'publish', 'github-status', 'github-resume']);
const COMMON_VALUE_FLAGS = new Set(['--db', '--pause-file', '--gh-bin']);
const COMMAND_VALUE_FLAGS = Object.freeze({
  run: new Set(['--lake', '--profile', '--workers', '--board-size', '--board-max-age-minutes',
    '--candidate-limit', '--worker-command', '--work-root', '--poll-ms']),
  board: new Set(),
  approve: new Set(['--board', '--ids', '--reject-ids', '--approved-by']),
  publish: new Set(['--board', '--receipt-remote']),
  'github-status': new Set(),
  'github-resume': new Set(['--reason', '--cleared-by']),
});
const COMMAND_BOOLEAN_FLAGS = Object.freeze({
  run: new Set(['--once']),
  board: new Set(),
  approve: new Set(),
  publish: new Set(),
  'github-status': new Set(),
  'github-resume': new Set(),
});

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function positiveInteger(value, flag, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^[1-9][0-9]*$/.test(String(value ?? ''))) throw new Error(`${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${flag} must be an integer from 1 through ${maximum}`);
  }
  return parsed;
}

function nonnegativeNumber(value, flag) {
  if (typeof value !== 'string' || !/^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/.test(value)) {
    throw new Error(`${flag} must be a non-negative number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a non-negative number`);
  return parsed;
}

function nonnegativeInteger(value, flag) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value ?? ''))) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

function commaSeparatedIds(value, flag, {required = false} = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error(`${flag} is required`);
    return [];
  }
  const ids = value.split(',').map((item) => item.trim());
  if (!ids.length || ids.some((id) => !/^M-(?!0+$)[0-9]+$/.test(id))) {
    throw new Error(`${flag} must be a comma-separated list of mission IDs such as M-201,M-202`);
  }
  if (new Set(ids).size !== ids.length) throw new Error(`${flag} contains a duplicate mission ID`);
  return ids;
}

function pathValue(value, fallback) {
  return path.resolve(value ?? fallback);
}

export function parseFactoryCliArgs(argv, {env = process.env} = {}) {
  const values = [...argv];
  const command = values.shift();
  if (!COMMANDS.has(command)) {
    throw new Error('command must be run, board, approve, publish, github-status, or github-resume');
  }
  const allowedValues = new Set([...COMMON_VALUE_FLAGS, ...COMMAND_VALUE_FLAGS[command]]);
  const allowedBooleans = COMMAND_BOOLEAN_FLAGS[command];
  const parsed = new Map();
  for (let index = 0; index < values.length;) {
    const flag = values[index];
    if (!allowedValues.has(flag) && !allowedBooleans.has(flag)) throw new Error(`unknown argument ${flag}`);
    if (parsed.has(flag)) throw new Error(`duplicate argument ${flag}`);
    if (allowedBooleans.has(flag)) {
      parsed.set(flag, true);
      index += 1;
    } else {
      parsed.set(flag, requiredValue(values, index, flag));
      index += 2;
    }
  }

  const common = {
    command,
    database: pathValue(parsed.get('--db') ?? env.OSS_FACTORY_DB, FACTORY_DEFAULTS.database),
    pauseFile: pathValue(parsed.get('--pause-file') ?? env.OSS_FACTORY_PAUSE_FILE, FACTORY_DEFAULTS.pauseFile),
    ghBin: parsed.get('--gh-bin') ?? env.GH_BIN ?? 'gh',
  };

  if (command === 'run') {
    const profile = parsed.get('--profile') ?? 'node';
    if (profile !== 'node') throw new Error('--profile must be node; the production factory is Node-only');
    const workers = positiveInteger(parsed.get('--workers') ?? '8', '--workers', 32);
    const boardSize = positiveInteger(parsed.get('--board-size') ?? '20', '--board-size', 30);
    const candidateLimit = parsed.has('--candidate-limit')
      ? positiveInteger(parsed.get('--candidate-limit'), '--candidate-limit', workers * 4)
      : workers * 2;
    return {
      ...common,
      lake: pathValue(parsed.get('--lake') ?? env.OSS_FACTORY_LAKE, FACTORY_DEFAULTS.lake),
      profile,
      workers,
      boardSize,
      boardMaxAgeMinutes: nonnegativeNumber(
        parsed.get('--board-max-age-minutes') ?? '30', '--board-max-age-minutes'),
      candidateLimit,
      workerCommand: parsed.get('--worker-command') ?? env.OSS_FACTORY_WORKER_COMMAND ??
        FACTORY_DEFAULTS.workerCommand,
      workRoot: pathValue(parsed.get('--work-root') ?? env.OSS_FACTORY_WORK_ROOT, FACTORY_DEFAULTS.workRoot),
      pollMs: nonnegativeInteger(parsed.get('--poll-ms') ?? '5000', '--poll-ms'),
      once: parsed.get('--once') === true,
    };
  }
  if (command === 'approve') {
    const board = parsed.get('--board');
    if (!/^sha256:[a-f0-9]{64}$/.test(board ?? '')) {
      throw new Error('--board must be a sha256:<64 lowercase hex> digest');
    }
    const ids = commaSeparatedIds(parsed.get('--ids'), '--ids', {required: true});
    const rejectedIds = commaSeparatedIds(parsed.get('--reject-ids'), '--reject-ids');
    if (ids.some((id) => rejectedIds.includes(id))) {
      throw new Error('a mission cannot appear in both --ids and --reject-ids');
    }
    return {
      ...common,
      board,
      ids,
      rejectedIds,
      approvedBy: parsed.get('--approved-by') ?? env.OSS_FACTORY_APPROVED_BY ?? 'internal-user:aeziz',
    };
  }
  if (command === 'publish') {
    const board = parsed.get('--board');
    if (!/^sha256:[a-f0-9]{64}$/.test(board ?? '')) {
      throw new Error('--board must be a sha256:<64 lowercase hex> digest');
    }
    return {
      ...common,
      board,
      receiptRemote: parsed.get('--receipt-remote') ?? env.OSS_FACTORY_RECEIPT_REMOTE ??
        FACTORY_DEFAULTS.receiptRemote,
    };
  }
  if (command === 'github-resume') {
    const reason = parsed.get('--reason');
    if (!reason?.trim()) throw new Error('--reason is required for github-resume');
    return {
      ...common,
      reason: reason.trim(),
      clearedBy: parsed.get('--cleared-by') ?? env.OSS_FACTORY_APPROVED_BY ?? 'internal-user:aeziz',
    };
  }
  return common;
}

function printJson(stdout, value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function currentBoard(db, createBoard) {
  if (typeof db.getCurrentBoard === 'function') {
    const existing = await db.getCurrentBoard();
    if (existing) return existing;
  }
  if (db.connection?.prepare) {
    const row = db.connection.prepare("SELECT board_id FROM boards WHERE state='OPEN' ORDER BY created_at DESC LIMIT 1").get();
    if (row) return db.getBoard(row.board_id);
  }
  return createBoard(db, {force: true});
}

function sourceSummary(value) {
  return {
    selected: value?.candidates?.length ?? 0,
    go: value?.results?.filter((item) => item.outcome === 'GO').length ?? 0,
    skipped: value?.results?.filter((item) => item.outcome === 'SKIP').length ?? 0,
    escalated: value?.results?.filter((item) => item.outcome === 'ESCALATE').length ?? 0,
    enqueued: value?.enqueued?.length ?? 0,
  };
}

function defaultSleep(milliseconds, signal) {
  if (signal?.aborted || milliseconds === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', done, {once: true});
  });
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  openDb: openFactoryDb,
  createSource,
  createDriver: createCommandDriver,
  runCycle: runFactoryCycle,
  createBoard: createBoardIfDue,
  renderBoard,
  approveBoard,
  publishBoard,
  createTransport: createGhCliTransport,
  createPublisherAdapter: createGhCliPublisherAdapter,
  createReceiptPublisher,
  createSafety: createGitHubSafety,
  resumeGitHub,
});

export async function executeFactoryCli(argv, {
  dependencies = {},
  env = process.env,
  stdout = process.stdout,
  signal = null,
} = {}) {
  const options = parseFactoryCliArgs(argv, {env});
  const deps = {...DEFAULT_DEPENDENCIES, ...dependencies};
  const transport = dependencies.transport ?? deps.createTransport({ghExecutable: options.ghBin});
  const safetyTransport = (request) => typeof request.execute === 'function'
    ? request.execute()
    : transport(request);

  if (options.command === 'github-status') {
    const safety = deps.createSafety({pauseFile: options.pauseFile, transport: safetyTransport});
    const result = await safety.status();
    printJson(stdout, result);
    return result;
  }
  if (options.command === 'github-resume') {
    const result = await deps.resumeGitHub({
      pauseFile: options.pauseFile,
      reason: options.reason,
      clearedBy: options.clearedBy,
      transport,
    });
    printJson(stdout, result);
    return result;
  }

  const db = deps.openDb(options.database);
  try {
    if (options.command === 'run') {
      const safety = deps.createSafety({
        pauseFile: options.pauseFile,
        transport: safetyTransport,
        repositoryState: typeof db.getPublicActionState === 'function'
          ? db.getPublicActionState.bind(db) : db,
      });
      const github = dependencies.github ?? deps.createPublisherAdapter({transport});
      const queuedGithub = {
        graphql: (query) => safety.request({
          priority: 'live_preflight',
          kind: 'read',
          operation: 'factory_live_preflight',
          query,
          execute: () => github.graphql(query),
        }),
        deepOverlap: (live) => safety.request({
          priority: 'live_preflight',
          kind: 'read',
          operation: 'deep_overlap',
          repository: live?.repository?.nameWithOwner,
          execute: () => github.deepOverlap(live),
        }),
      };
      const source = dependencies.source ?? deps.createSource({
        lakePath: options.lake,
        db,
        github: queuedGithub,
      });
      const checkoutProvider = async (task, attempt, allocatedRoot) => {
        if (typeof task?.base_oid !== 'string' || !task.base_oid) {
          throw new Error(`${task?.task_id ?? 'task'} cannot clone without an exact base OID`);
        }
        const destination = path.join(allocatedRoot, 'repository');
        const result = await transport({
          operation: 'git_clone',
          repository: task.repository,
          destination,
          base_oid: task.base_oid,
          task_id: task.task_id,
          attempt_id: attempt?.attempt_id,
        });
        if (result?.base_oid !== task.base_oid) {
          throw new Error(`safe checkout returned base ${result?.base_oid ?? 'missing'}, expected ${task.base_oid}`);
        }
        return {checkout: result.repository_path ?? destination};
      };
      const driver = dependencies.driver ?? deps.createDriver({
        command: options.workerCommand,
        workRoot: options.workRoot,
        checkoutProvider,
      });
      const recovered = db.recoverWorkingTasks?.() ?? [];
      const boardPolicy = {minSize: options.boardSize, maxAgeMinutes: options.boardMaxAgeMinutes};
      const sourceTotal = {selected: 0, go: 0, skipped: 0, escalated: 0, enqueued: 0, paused: 0};
      let iterations = 0;
      let claimed = 0;
      let completed = 0;
      let lastCycle = null;
      while (!signal?.aborted) {
        let filled;
        try {
          filled = await source.fill({
            workers: options.workers,
            limit: options.candidateLimit,
            profile: options.profile,
            now: new Date(),
          });
        } catch (error) {
          if (error?.code !== 'GITHUB_PAUSED') throw error;
          filled = {candidates: [], results: [], enqueued: [], paused: true};
        }
        const summary = sourceSummary(filled);
        for (const key of ['selected', 'go', 'skipped', 'escalated', 'enqueued']) {
          sourceTotal[key] += summary[key];
        }
        if (filled?.paused) sourceTotal.paused += 1;
        lastCycle = await deps.runCycle({
          db,
          driver,
          profile: options.profile,
          workers: options.workers,
          boardPolicy,
        });
        iterations += 1;
        claimed += Number(lastCycle?.claimed ?? 0);
        completed += lastCycle?.results?.length ?? 0;
        deps.createBoard(db, boardPolicy);
        if (options.once) break;
        if (Number(lastCycle?.claimed ?? 0) === 0 && summary.enqueued === 0) {
          await (dependencies.sleep ?? defaultSleep)(options.pollMs, signal);
        }
      }
      const result = {
        source: sourceTotal,
        recovered: Array.isArray(recovered)
          ? recovered.length : Number(recovered?.recovered ?? recovered ?? 0),
        iterations,
        claimed,
        completed,
        stopped: signal?.aborted === true,
        last_cycle: lastCycle,
        stats: db.stats?.() ?? null,
      };
      printJson(stdout, result);
      return result;
    }
    if (options.command === 'board') {
      const board = await currentBoard(db, deps.createBoard);
      if (!board) {
        const result = {board: null, message: 'No READY items are available.'};
        printJson(stdout, result);
        return result;
      }
      const rendered = deps.renderBoard(board);
      stdout.write(rendered);
      if (!rendered.endsWith('\n')) stdout.write('\n');
      return board;
    }
    if (options.command === 'approve') {
      const result = await deps.approveBoard(db, {
        board: options.board,
        ids: options.ids,
        rejectedIds: options.rejectedIds,
        approvedBy: options.approvedBy,
      });
      printJson(stdout, result);
      return result;
    }
    if (options.command === 'publish') {
      const safety = deps.createSafety({
        pauseFile: options.pauseFile,
        transport: safetyTransport,
        repositoryState: typeof db.getPublicActionState === 'function'
          ? db.getPublicActionState.bind(db) : db,
      });
      const github = dependencies.github ?? deps.createPublisherAdapter({
        transport,
      });
      const liveRecheck = dependencies.liveRecheck ?? github.finalLiveRecheck.bind(github);
      const receiptPublisher = dependencies.receiptPublisher ?? deps.createReceiptPublisher({
        remoteUrl: options.receiptRemote,
      });
      const result = await deps.publishBoard(options.board, {
        db,
        github,
        safety,
        liveRecheck,
        receiptPublisher,
      });
      printJson(stdout, result);
      return result;
    }
    throw new Error(`unsupported command ${options.command}`);
  } finally {
    db.close?.();
  }
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const controller = !options.signal && argv[0] === 'run' ? new AbortController() : null;
  const stop = () => controller.abort();
  if (controller) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  try {
    await executeFactoryCli(argv, {...options, signal: options.signal ?? controller?.signal ?? null});
    return 0;
  } catch (error) {
    (options.stderr ?? process.stderr).write(`${error.message}\n`);
    return 1;
  } finally {
    if (controller) {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  process.exitCode = await main();
}
