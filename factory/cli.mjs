#!/usr/bin/env node

import {mkdir, realpath} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';

import {approveBoard, createBoardIfDue, renderBoard} from './board.mjs';
import {openFactoryDb} from './db.mjs';
import {createGhCliPublisherAdapter, createGhCliTransport} from './gh-cli.mjs';
import {createGitHubSafety, resumeGitHub} from './github-safety.mjs';
import {buildOfferDossier} from './offer-dossier.mjs';
import {publishBoard} from './publisher.mjs';
import {
  createReceiptPublisher,
  createReceiptStatusPublisher,
} from './receipt-publisher.mjs';
import {reconcilePublicationBatch} from './reconciler.mjs';
import {createSource} from './source.mjs';
import {createStaleRefresher} from './stale-refresh.mjs';
import {createCommandDriver, runFactoryCycle} from './worker.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_FILE), '..');

export const FACTORY_DEFAULTS = Object.freeze({
  database: path.join(REPO_ROOT, 'runs', 'factory', 'factory.sqlite'),
  lake: path.join(REPO_ROOT, 'candidate_lake.sqlite'),
  pauseFile: path.join(REPO_ROOT, 'runs', 'factory', 'github-pause.json'),
  workRoot: path.join(REPO_ROOT, 'runs', 'factory', 'work'),
  artifactRoot: path.join(REPO_ROOT, 'runs', 'factory', 'artifacts'),
  workerCommand: path.join(REPO_ROOT, 'factory', 'node-worker.mjs'),
  receiptRemote: 'https://github.com/northset-oss/verification-pilot.git',
});

const COMMANDS = new Set(['run', 'board', 'approve', 'publish', 'reconcile', 'dossier',
  'github-status', 'github-resume']);
const COMMON_VALUE_FLAGS = new Set(['--db', '--pause-file', '--gh-bin']);
const COMMAND_VALUE_FLAGS = Object.freeze({
  run: new Set(['--lake', '--profile', '--workers', '--board-size', '--board-max-age-minutes',
    '--candidate-limit', '--worker-command', '--work-root', '--artifact-root', '--receipt-remote', '--poll-ms']),
  board: new Set(),
  approve: new Set(['--board', '--ids', '--reject-ids', '--approved-by']),
  publish: new Set(['--board', '--receipt-remote', '--artifact-root', '--repository-open-override']),
  reconcile: new Set(['--limit', '--receipt-remote']),
  dossier: new Set(['--limit']),
  'github-status': new Set(),
  'github-resume': new Set(['--reason', '--cleared-by', '--repository']),
});
const COMMAND_BOOLEAN_FLAGS = Object.freeze({
  run: new Set(['--once']),
  board: new Set(),
  approve: new Set(),
  publish: new Set(),
  reconcile: new Set(),
  dossier: new Set(),
  'github-status': new Set(),
  'github-resume': new Set(['--acknowledge-forbidden']),
});

async function canonicalDatabasePath(database) {
  const resolved = path.resolve(database);
  try {
    return await realpath(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(path.dirname(resolved), {recursive: true});
    return path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
  }
}

export async function acquireFactoryRunLock(database) {
  const canonical = await canonicalDatabasePath(database);
  const lockPath = `${canonical}.run-lock.sqlite`;
  const connection = new DatabaseSync(lockPath);
  try {
    connection.exec('PRAGMA busy_timeout = 0');
    connection.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    connection.close();
    if (/database is locked/i.test(error.message)) {
      throw new Error(`factory run already active for ${canonical}`);
    }
    throw error;
  }
  let released = false;
  return {
    path: lockPath,
    async release() {
      if (released) return;
      released = true;
      try {
        connection.exec('ROLLBACK');
      } finally {
        connection.close();
      }
    },
  };
}

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
    throw new Error('command must be run, board, approve, publish, reconcile, dossier, github-status, or github-resume');
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
      artifactRoot: pathValue(parsed.get('--artifact-root') ?? env.OSS_FACTORY_ARTIFACT_ROOT,
        FACTORY_DEFAULTS.artifactRoot),
      receiptRemote: parsed.get('--receipt-remote') ?? env.OSS_FACTORY_RECEIPT_REMOTE ??
        FACTORY_DEFAULTS.receiptRemote,
      pollMs: nonnegativeInteger(parsed.get('--poll-ms') ?? '5000', '--poll-ms'),
      once: parsed.get('--once') === true,
    };
  }
  if (command === 'approve') {
    const board = parsed.get('--board');
    if (!/^sha256:[a-f0-9]{64}$/.test(board ?? '')) {
      throw new Error('--board must be a sha256:<64 lowercase hex> digest');
    }
    const ids = commaSeparatedIds(parsed.get('--ids'), '--ids');
    const rejectedIds = commaSeparatedIds(parsed.get('--reject-ids'), '--reject-ids');
    if (!ids.length && !rejectedIds.length) {
      throw new Error('approve requires --ids, --reject-ids, or both');
    }
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
    const repositoryOpenOverrideMissionId = parsed.get('--repository-open-override') ?? null;
    if (repositoryOpenOverrideMissionId !== null &&
        !/^M-(?!0+$)[0-9]+$/.test(repositoryOpenOverrideMissionId)) {
      throw new Error('--repository-open-override must be one mission ID such as M-201');
    }
    return {
      ...common,
      board,
      repositoryOpenOverrideMissionId,
      receiptRemote: parsed.get('--receipt-remote') ?? env.OSS_FACTORY_RECEIPT_REMOTE ??
        FACTORY_DEFAULTS.receiptRemote,
      artifactRoot: pathValue(parsed.get('--artifact-root') ?? env.OSS_FACTORY_ARTIFACT_ROOT,
        FACTORY_DEFAULTS.artifactRoot),
    };
  }
  if (command === 'reconcile') {
    return {
      ...common,
      limit: positiveInteger(parsed.get('--limit') ?? '30', '--limit', 1000),
      receiptRemote: parsed.get('--receipt-remote') ?? env.OSS_FACTORY_RECEIPT_REMOTE ??
        FACTORY_DEFAULTS.receiptRemote,
    };
  }
  if (command === 'dossier') return {...common, limit: positiveInteger(parsed.get('--limit') ?? '30', '--limit', 100)};
  if (command === 'github-resume') {
    const reason = parsed.get('--reason');
    if (!reason?.trim()) throw new Error('--reason is required for github-resume');
    return {
      ...common,
      reason: reason.trim(),
      clearedBy: parsed.get('--cleared-by') ?? env.OSS_FACTORY_APPROVED_BY ?? 'internal-user:aeziz',
      repository: parsed.get('--repository') ?? null,
      acknowledgeForbidden: parsed.get('--acknowledge-forbidden') === true,
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

function recoverableSourceError(error) {
  if (error?.transient === true) return true;
  if (Number(error?.httpStatus ?? error?.status) >= 500) return true;
  return [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETDOWN', 'ENETUNREACH',
    'EHOSTUNREACH', 'GH_COMMAND_TIMEOUT', 'GH_OUTPUT_LIMIT', 'SQLITE_BUSY', 'SQLITE_LOCKED',
  ].includes(String(error?.code ?? '').toUpperCase());
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
  createReceiptStatusPublisher,
  reconcilePublicationBatch,
  createStaleRefresher,
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
    if (options.repository !== null) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
        throw new Error('--repository must be owner/name');
      }
      const db = deps.openDb(options.database);
      try {
        const current = await db.getRepositoryState(options.repository);
        if (!current?.cooldown_reason && !current?.cooldown_until) {
          throw new Error(`${options.repository} has no repository cooldown to clear`);
        }
        const cleared = await db.setRepositoryState(options.repository, {
          cooldown_reason: null,
          cooldown_until: null,
        });
        const result = {
          repository: options.repository,
          cooldown_cleared: true,
          cleared_by: options.clearedBy,
          clear_reason: options.reason,
          repository_state: cleared,
        };
        printJson(stdout, result);
        return result;
      } finally {
        db.close?.();
      }
    }
    const result = await deps.resumeGitHub({
      pauseFile: options.pauseFile,
      reason: options.reason,
      clearedBy: options.clearedBy,
      transport,
      acknowledgeForbidden: options.acknowledgeForbidden,
    });
    printJson(stdout, result);
    return result;
  }

  const db = deps.openDb(options.database);
  try {
    if (options.command === 'dossier') {
      const safety = deps.createSafety({
        pauseFile: options.pauseFile,
        transport: safetyTransport,
        repositoryState: typeof db.getPublicActionState === 'function'
          ? db.getPublicActionState.bind(db) : db,
      });
      const github = dependencies.github ?? deps.createPublisherAdapter({transport});
      const result = await buildOfferDossier({db, github, safety, limit: options.limit});
      stdout.write(result.summary);
      return result;
    }
    if (options.command === 'reconcile') {
      const safety = deps.createSafety({
        pauseFile: options.pauseFile,
        transport: safetyTransport,
        repositoryState: typeof db.getPublicActionState === 'function'
          ? db.getPublicActionState.bind(db) : db,
      });
      const github = dependencies.github ?? deps.createPublisherAdapter({transport});
      const statusPublisher = dependencies.receiptStatusPublisher ?? deps.createReceiptStatusPublisher({
        remoteUrl: options.receiptRemote,
      });
      const result = await deps.reconcilePublicationBatch({
        db,
        github,
        safety,
        statusPublisher,
        limit: options.limit,
      });
      printJson(stdout, result);
      return result;
    }
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
        const result = await safety.request({
          priority: 'live_preflight',
          kind: 'read',
          operation: 'checkout_exact_base',
          repository: task.repository,
          execute: () => transport({
            operation: 'git_clone',
            repository: task.repository,
            destination,
            base_oid: task.base_oid,
            task_id: task.task_id,
            attempt_id: attempt?.attempt_id,
          }),
        });
        if (result?.base_oid !== task.base_oid) {
          throw new Error(`safe checkout returned base ${result?.base_oid ?? 'missing'}, expected ${task.base_oid}`);
        }
        return {checkout: result.repository_path ?? destination};
      };
      const driver = dependencies.driver ?? deps.createDriver({
        command: options.workerCommand,
        workRoot: options.workRoot,
        artifactRoot: options.artifactRoot,
        checkoutProvider,
      });
      const statusPublisher = dependencies.receiptStatusPublisher ?? deps.createReceiptStatusPublisher({
        remoteUrl: options.receiptRemote,
      });
      const recovered = db.recoverWorkingTasks?.() ?? [];
      const boardPolicy = {minSize: options.boardSize, maxAgeMinutes: options.boardMaxAgeMinutes};
      const sourceTotal = {selected: 0, go: 0, skipped: 0, escalated: 0, enqueued: 0, paused: 0};
      let iterations = 0;
      let claimed = 0;
      let completed = 0;
      let sourceFailures = 0;
      let lastSourceError = null;
      let lastCycle = null;
      let stopReason = null;
      const reconciliation = {runs: 0, processed: 0, failures: 0, paused: 0, last_error: null};
      let nextReconciliationAt = 0;
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
          if (error?.code === 'GITHUB_PAUSED') {
            filled = {candidates: [], results: [], enqueued: [], paused: true};
          } else if (recoverableSourceError(error)) {
            sourceFailures += 1;
            lastSourceError = error.message;
            filled = {candidates: [], results: [], enqueued: [], source_error: true};
          } else {
            throw error;
          }
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
        if (lastCycle?.results?.some((item) => item?.code === 'MODEL_PROVIDER_UNAVAILABLE')) {
          stopReason = 'MODEL_PROVIDER_UNAVAILABLE';
          break;
        }
        const reconciliationDue = Date.now() >= nextReconciliationAt;
        if (typeof db.listReconciliationCandidates === 'function' && reconciliationDue) {
          try {
            const reconciled = await deps.reconcilePublicationBatch({
              db,
              github,
              safety,
              statusPublisher,
              limit: 30,
            });
            reconciliation.runs += 1;
            reconciliation.processed += Number(reconciled?.processed ?? 0);
            reconciliation.last_error = null;
          } catch (error) {
            reconciliation.failures += 1;
            reconciliation.last_error = error.message;
            if (error?.code === 'GITHUB_PAUSED') reconciliation.paused += 1;
          } finally {
            nextReconciliationAt = Date.now() + 15 * 60_000;
          }
        }
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
        stop_reason: stopReason,
        source_failures: sourceFailures,
        last_source_error: lastSourceError,
        reconciliation,
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
      const refreshStale = dependencies.refreshStale ?? deps.createStaleRefresher({
        artifactRoot: options.artifactRoot,
        fetchBase: async (plan, live, context) => {
          await safety.request({
            priority: 'final_submission',
            kind: 'read',
            operation: 'refresh_base_fetch',
            repository: plan.repository,
            execute: () => transport({
              operation: 'git_fetch',
              repository_path: context.repository_path,
              remote: `https://github.com/${plan.repository}.git`,
              refspec: `+refs/heads/${plan.base_branch}:refs/remotes/northset-refresh/${plan.base_branch}`,
              depth: 1,
            }),
          });
          return {base_oid: context.expected_oid ?? live.current_base_oid};
        },
      });
      const result = await deps.publishBoard(options.board, {
        db,
        github,
        safety,
        liveRecheck,
        receiptPublisher,
        refreshStale,
        repositoryOpenOverrideMissionId: options.repositoryOpenOverrideMissionId,
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
  const lockingCommand = argv[0] === 'run' || argv[0] === 'reconcile';
  let runLock = null;
  const stop = () => controller.abort();
  if (controller) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  try {
    if (lockingCommand) {
      const runOptions = parseFactoryCliArgs(argv, {env: options.env ?? process.env});
      runLock = await acquireFactoryRunLock(runOptions.database);
    }
    await executeFactoryCli(argv, {...options, signal: options.signal ?? controller?.signal ?? null});
    return 0;
  } catch (error) {
    (options.stderr ?? process.stderr).write(`${error.message}\n`);
    return 1;
  } finally {
    await runLock?.release();
    if (controller) {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  process.exitCode = await main();
}
