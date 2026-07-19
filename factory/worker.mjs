import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createBoardIfDue, classifyRisk} from './board.mjs';
import {sha256} from './db.mjs';
import {receiptUrlFor} from './receipt-publisher.mjs';
import {buildProof} from './verifier.mjs';

const REMOVE_TREE_OPTIONS = Object.freeze({
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
});

export async function removeWorkTree(root, {
  remove = rm,
  tolerateBusy = false,
} = {}) {
  try {
    await remove(root, REMOVE_TREE_OPTIONS);
    return true;
  } catch (error) {
    if (tolerateBusy && ['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error?.code)) return false;
    throw error;
  }
}

export class Semaphore {
  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('semaphore limit must be positive');
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async run(operation) {
    if (this.active >= this.limit) await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try { return await operation(); }
    finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export function createStageSemaphores({
  preflight = 16,
  clone = 8,
  bootstrap = 3,
  scout = 8,
  author = 8,
  verifier = 4,
} = {}) {
  return {
    preflight: new Semaphore(preflight),
    clone: new Semaphore(clone),
    bootstrap: new Semaphore(bootstrap),
    scout: new Semaphore(scout),
    author: new Semaphore(author),
    verifier: new Semaphore(verifier),
  };
}

async function oneInfrastructureRetry(operation) {
  try { return await operation(); }
  catch (error) {
    if (error?.transient !== true) throw error;
    return operation();
  }
}

function receiptFooter(missionId, receiptUrl) {
  return [
    '---',
    'AI assistance was used. This change was reviewed by Northset, and I accept responsibility for this submission.',
    '',
    `<!-- northset-receipt:${missionId}:start -->`,
    '### Verification',
    '',
    `[Northset proof-of-pass receipt ${missionId}](${receiptUrl})  `,
    'Contributor self-run; not maintainer verification.',
    `<!-- northset-receipt:${missionId}:end -->`,
  ].join('\n');
}

export function finalizePrBody(body, missionId, receiptUrl) {
  let rendered = String(body ?? '')
    .replaceAll('{{MISSION_ID}}', missionId)
    .replaceAll('{{RECEIPT_URL}}', receiptUrl)
    .trimEnd();
  if (!rendered.includes(`<!-- northset-receipt:${missionId}:start -->`)) {
    rendered = `${rendered}\n\n${receiptFooter(missionId, receiptUrl)}`.trim();
  }
  return `${rendered}\n`;
}

export function buildReadyManifest(task, authorResult, verification, missionId) {
  const receiptUrl = receiptUrlFor(missionId, verification.commit_oid);
  const body = finalizePrBody(authorResult.pr_body, missionId, receiptUrl);
  const verifiedCommand = verification.patched_observation?.command ?? authorResult.test_command;
  const manifest = {
    repository: task.repository,
    fork_repository: authorResult.fork_repository ?? task.live_state?.fork_repository ?? null,
    repository_path: authorResult.repository_path ?? null,
    patch_path: authorResult.patch_path ?? null,
    verification_path: authorResult.verification_path ?? null,
    issue_number: task.issue_number,
    issue_url: authorResult.issue_url ?? `https://github.com/${task.repository}/issues/${task.issue_number}`,
    invitation_summary: task.live_state?.invitation_summary ?? 'Live preflight confirmed an invited, unoccupied issue.',
    base_branch: authorResult.base_branch ?? task.live_state?.repository?.defaultBranch ??
      task.live_state?.default_branch ?? 'main',
    branch: authorResult.branch ?? `northset/${missionId.toLowerCase()}`,
    base_oid: task.base_oid,
    patch_sha256: verification.patch_sha256,
    tested_tree_oid: verification.tested_tree_oid,
    commit_oid: verification.commit_oid,
    checks: [verifiedCommand].filter(Boolean),
    test_command: authorResult.test_command,
    install_command: authorResult.install_command ?? null,
    test_only_paths: authorResult.test_only_paths ?? [],
    base_failure_contains: authorResult.base_failure_contains ?? null,
    verification,
    pr_title: authorResult.pr_title,
    pr_body: body,
    summary: authorResult.summary,
    changed_files: verification.changed_files,
    changed_lines: verification.changed_lines,
    risk_tier: authorResult.risk_tier ?? classifyRisk(authorResult),
    risk_warnings: authorResult.risk_warnings ?? [],
    receipt_claim: {
      type: verification.claim_type,
      statement: authorResult.receipt_claim ?? verification.claim_type,
    },
    receipt_url: receiptUrl,
    planned_actions: ['publish-proof', 'push-approved-commit', 'open-upstream-pr', 'verify-pr-readback'],
  };
  manifest.proof = buildProof({task, verification, manifest});
  return manifest;
}

function assertAuthorResult(authored) {
  if (!authored || typeof authored !== 'object') throw new Error('author returned no result');
  if (typeof authored.pr_title !== 'string' || !authored.pr_title.trim()) throw new Error('author omitted PR title');
  if (typeof authored.pr_body !== 'string' || !authored.pr_body.trim()) throw new Error('author omitted PR body');
  const body = `${authored.pr_title}\n${authored.pr_body}`;
  const forbidden = [
    /maintainer[- ]approved/i,
    /production[- ]ready/i,
    /(?:no|zero) vulnerabilities/i,
    /guaranteed? (?:correct|safe|merge)/i,
    /all (?:tests|checks) pass/i,
  ];
  if (forbidden.some((pattern) => pattern.test(body))) {
    throw new Error('PR text contains a prohibited overclaim');
  }
}

function assertVerification(verification) {
  if (!verification?.ok) throw new Error('verifier did not return success');
  if (verification.dco_verified !== true) throw new Error('verifier did not prove DCO identity');
  if (!Array.isArray(verification.changed_files)) throw new Error('verifier did not derive changed files');
  if (!Number.isFinite(Number(verification.changed_lines))) throw new Error('verifier did not derive diffstat');
  for (const field of ['patch_sha256', 'tested_tree_oid', 'commit_oid', 'claim_type']) {
    if (typeof verification[field] !== 'string' || !verification[field]) {
      throw new Error(`verifier omitted ${field}`);
    }
  }
  if (!Array.isArray(verification.executed_commands) || verification.executed_commands.length !== 2) {
    throw new Error('verifier omitted structured base and patched command evidence');
  }
  if (!verification.verification_started_at || !verification.verification_finished_at) {
    throw new Error('verifier omitted verification timing evidence');
  }
  if (!verification.environment || typeof verification.environment !== 'object' ||
      typeof verification.environment.image !== 'string' || !verification.environment.image) {
    throw new Error('verifier omitted exact executor image identity');
  }
  for (const [index, command] of verification.executed_commands.entries()) {
    if (!['base_observation', 'patched_observation'].includes(command?.phase) ||
        (typeof command.command !== 'string' && !Array.isArray(command.command)) ||
        !Number.isInteger(command.exit_code) || typeof command.expectation_met !== 'boolean' ||
        !Number.isFinite(command.duration_ms) || !command.started_at || !command.finished_at) {
      throw new Error(`verifier returned invalid executed command evidence at index ${index}`);
    }
  }
}

export function assertPublicVerificationClaims(authored, verification) {
  const command = verification?.patched_observation?.command;
  if (typeof command !== 'string' || !command.trim()) return;
  const contradictory = /\b(?:could not|couldn't|did not run|was not run|not run|blocked|unavailable|failed to (?:start|run))\b/i;
  const line = String(authored?.pr_body ?? '').split(/\r?\n/)
    .find((candidate) => candidate.includes(command) && contradictory.test(candidate));
  if (line) {
    throw new Error('PR body says the clean verifier command did not run, but its patched observation passed');
  }
}

export function assertDeclaredTestsExecuted(authored, verification) {
  if (!['regression_fix', 'feature_implementation', 'coverage_addition']
    .includes(verification?.claim_type)) return;
  const testPaths = Array.isArray(authored?.test_only_paths) ? authored.test_only_paths : [];
  if (!testPaths.length) return;
  const command = verification?.patched_observation?.command;
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('clean verifier omitted the command that should exercise the declared tests');
  }
  const namesDeclared = testPaths.some((testPath) =>
    command.includes(testPath) || command.includes(path.posix.basename(testPath)));
  const runsRepositorySuite = /(?:^|\s)(?:npm(?:\s+run)?|yarn|pnpm|bun)\s+test(?:\s|$)/.test(command) ||
    /(?:^|\s)node\s+--test\s*$/.test(command.trim());
  if (!namesDeclared && !runsRepositorySuite) {
    throw new Error('clean verifier command must execute a declared test-only path or a repository test suite');
  }
}

async function processClaim(claim, {
  db,
  driver,
  semaphores,
  boardPolicy,
  now,
}) {
  const {task, attempt} = claim;
  const began = now().getTime();
  let checkout = null;
  try {
    checkout = await semaphores.clone.run(() => oneInfrastructureRetry(() => driver.checkout(task, attempt)));
    const scout = await semaphores.scout.run(() => driver.scout(task, checkout, {
      effort: 'medium', timeoutMs: 90_000,
    }));
    if (!scout || scout.decision === 'SKIP') {
      db.finishAttempt(attempt.attempt_id, {
        outcome: 'SKIPPED', failureClass: 'candidate',
        durationMs: now().getTime() - began,
        error: scout?.reason ?? 'scout declined the task', now: now(),
      });
      return {task_id: task.task_id, state: 'SKIPPED', reason: scout?.reason ?? null};
    }
    if (scout.estimated_risk === 'RED') {
      db.finishAttempt(attempt.attempt_id, {
        outcome: 'SKIPPED', failureClass: 'risk',
        durationMs: now().getTime() - began,
        error: 'Scout classified the task as Red; Red work is outside the scaled lane', now: now(),
      });
      return {task_id: task.task_id, state: 'SKIPPED', reason: 'RED'};
    }
    const dependencyMaterial = await semaphores.bootstrap.run(() => oneInfrastructureRetry(
      () => driver.bootstrap(task, checkout, scout, attempt),
    ));
    let feedback = null;
    let lastError = null;
    for (let authorAttempt = 1; authorAttempt <= 2; authorAttempt += 1) {
      try {
        const authored = await semaphores.author.run(() => oneInfrastructureRetry(() =>
          driver.author(task, checkout, scout, {
            attempt: authorAttempt,
            effort: authorAttempt === 1 ? 'high' : (driver.secondEffort ?? 'high'),
            timeoutMs: 10 * 60_000,
            verifierFeedback: feedback,
            dependencyMaterial,
          })));
        if (!authored || authored.outcome === 'SKIP') {
          db.finishAttempt(attempt.attempt_id, {
            outcome: 'SKIPPED', failureClass: 'authoring',
            durationMs: now().getTime() - began,
            error: authored?.reason ?? 'author declined the task', now: now(),
          });
          return {task_id: task.task_id, state: 'SKIPPED', reason: authored?.reason ?? null};
        }
        assertAuthorResult(authored);
        const verification = await semaphores.verifier.run(() => oneInfrastructureRetry(() =>
          driver.verify(task, checkout, scout, authored, {dependencyMaterial})));
        assertVerification(verification);
        assertPublicVerificationClaims(authored, verification);
        assertDeclaredTestsExecuted(authored, verification);
        const artifacts = await driver.persist?.(task, checkout, {
          attempt,
          authored,
          verification,
        }) ?? {};
        const publishable = {
          ...authored,
          ...artifacts,
          install_command: dependencyMaterial?.install_command ?? authored.install_command ?? null,
          changed_files: verification.changed_files,
          changed_lines: verification.changed_lines,
        };
        const riskTier = classifyRisk({
          ...publishable,
          risk_tier: scout.estimated_risk ?? publishable.risk_tier,
          changed_files: verification.changed_files,
          changed_lines: verification.changed_lines,
        });
        if (riskTier === 'RED') {
          db.finishAttempt(attempt.attempt_id, {
            outcome: 'SKIPPED', failureClass: 'risk',
            durationMs: now().getTime() - began,
            patchSha256: verification.patch_sha256,
            commitOid: verification.commit_oid,
            verification,
            error: 'Red work is outside the scaled lane',
            now: now(),
          });
          return {task_id: task.task_id, state: 'SKIPPED', reason: 'RED'};
        }
        const ready = db.finishVerifiedReady(attempt.attempt_id,
          (missionId) => buildReadyManifest(task, publishable, verification, missionId),
          {
            durationMs: now().getTime() - began,
            patchSha256: verification.patch_sha256,
            commitOid: verification.commit_oid,
            verification,
            riskTier,
            now: now(),
          });
        const board = createBoardIfDue(db, {...boardPolicy, now: now()});
        return {task_id: task.task_id, state: 'READY', mission_id: ready.mission_id, board};
      } catch (error) {
        lastError = error;
        feedback = error.message;
        await driver.resetAfterFailure?.(task, checkout, {authorAttempt, error});
      }
    }
    db.finishAttempt(attempt.attempt_id, {
      outcome: 'SKIPPED', failureClass: 'verification',
      durationMs: now().getTime() - began,
      error: lastError?.message ?? 'two author attempts failed', now: now(),
    });
    return {task_id: task.task_id, state: 'SKIPPED', reason: lastError?.message ?? null};
  } catch (error) {
    db.finishAttempt(attempt.attempt_id, {
      outcome: 'FAILED', failureClass: error?.transient ? 'infrastructure' : 'worker',
      durationMs: now().getTime() - began, error: error.message, now: now(),
    });
    return {task_id: task.task_id, state: 'FAILED', reason: error.message};
  } finally {
    await driver.cleanup?.(task, checkout);
  }
}

export async function runFactoryCycle({
  db,
  source = null,
  driver,
  profile = 'node',
  workers = 8,
  queueDepth = workers * 4,
  semaphores = createStageSemaphores({author: workers}),
  boardPolicy = {},
  now = () => new Date(),
} = {}) {
  if (!db || !driver) throw new Error('factory cycle requires db and driver');
  if (profile !== 'node') throw new Error('the production factory currently runs the Node profile only');
  if (!Number.isInteger(workers) || workers < 1 || workers > 32) throw new Error('workers must be 1..32');
  if (source) {
    const fill = source.fill ?? source.run;
    if (typeof fill !== 'function') throw new Error('factory source requires fill()');
    await semaphores.preflight.run(() => fill.call(source, {workers, profile, now: now()}));
  }
  const claims = [];
  for (let index = 0; index < queueDepth; index += 1) {
    const claim = db.claimNextTask({profile, workerId: `factory-${index % workers + 1}`, now: now()});
    if (!claim) break;
    claims.push(claim);
  }
  const results = await Promise.all(claims.map((claim) => processClaim(claim, {
    db, driver, semaphores, boardPolicy, now,
  })));
  return {claimed: claims.length, results, board: createBoardIfDue(db, {...boardPolicy, now: now()})};
}

export async function runUntilIdle(options) {
  const cycles = [];
  while (true) {
    const cycle = await runFactoryCycle(options);
    cycles.push(cycle);
    if (cycle.claimed === 0) return {cycles, stats: options.db.stats()};
  }
}

export async function runContinuously(options, {
  pollMs = 5_000,
  once = false,
  shouldStop = () => false,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!Number.isFinite(pollMs) || pollMs < 0) throw new Error('pollMs must be non-negative');
  const cycles = [];
  let fillSource = true;
  while (!shouldStop()) {
    const cycle = await runFactoryCycle({...options, source: fillSource ? options.source : null});
    fillSource = false;
    cycles.push(cycle);
    if (once) break;
    createBoardIfDue(options.db, {...(options.boardPolicy ?? {}), now: (options.now ?? (() => new Date()))()});
    if (cycle.claimed === 0) await sleep(pollMs);
  }
  return {cycles, stats: options.db.stats()};
}

function terminate(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function runJsonCommand(command, args, payload, {
  cwd = undefined,
  timeoutMs = Number(payload?.timeoutMs ?? 15 * 60_000),
  maxOutputBytes = 4 * 1024 * 1024,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let terminalError = null;
    const abort = (error) => {
      if (terminalError) return;
      terminalError = error;
      terminate(child, 'SIGTERM');
      setTimeout(() => terminate(child, 'SIGKILL'), 2_000).unref();
    };
    const timer = setTimeout(() => abort(new Error(`worker command timed out after ${timeoutMs}ms`)), timeoutMs);
    const collect = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        abort(new Error(`worker command exceeded ${maxOutputBytes} output bytes`));
        return target;
      }
      return target + chunk;
    };
    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (terminalError) {
        terminalError.transient = /timed out/i.test(terminalError.message);
        reject(terminalError);
        return;
      }
      if (code !== 0) {
        const error = new Error(`worker command failed: ${(stderr || stdout).trim() || `exit ${code}`}`);
        error.transient = /temporar|timed out|connection reset|econnreset|etimedout|eai_again|network unreachable|registry[^\n]*(?:unavailable|timeout)|cannot connect to the docker daemon/i
          .test(stderr);
        reject(error);
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`worker command returned invalid JSON: ${error.message}`)); }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

function runBufferedCommand(command, args, {cwd, maxOutputBytes = 64 * 1024 * 1024} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    const stdout = [];
    let stderr = '';
    let bytes = 0;
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) terminate(child, 'SIGKILL');
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (bytes > maxOutputBytes) {
        reject(new Error(`local artifact command exceeded ${maxOutputBytes} output bytes`));
      } else if (code !== 0) {
        reject(new Error(`local artifact command failed: ${stderr.trim() || `exit ${code}`}`));
      } else {
        resolve(Buffer.concat(stdout));
      }
    });
  });
}

async function persistGitArtifact(task, checkout, {attempt, verification}, artifactRoot) {
  const taskRoot = path.resolve(artifactRoot, task.task_id);
  await mkdir(taskRoot, {recursive: true, mode: 0o700});
  const root = await mkdtemp(path.join(taskRoot, `${attempt.attempt_id}-`));
  const repository = path.join(root, 'repo');
  const patchFile = path.join(root, 'change.patch');
  const verificationFile = path.join(root, 'verification.json');
  try {
    await runBufferedCommand('git', ['clone', '--no-local', '--no-checkout', checkout, repository]);
    await runBufferedCommand('git', ['-C', repository, 'checkout', '--detach', verification.commit_oid]);
    const tree = (await runBufferedCommand('git', ['-C', repository, 'rev-parse', `${verification.commit_oid}^{tree}`]))
      .toString('utf8').trim();
    if (tree !== verification.tested_tree_oid) {
      throw new Error(`durable artifact tree ${tree} does not match verified tree ${verification.tested_tree_oid}`);
    }
    const patch = await runBufferedCommand('git', [
      '-C', repository, 'diff', '--binary', '--full-index', task.base_oid, verification.commit_oid,
    ]);
    if (sha256(patch) !== verification.patch_sha256) {
      throw new Error('durable artifact patch does not match the verified patch digest');
    }
    await writeFile(patchFile, patch, {mode: 0o600});
    await writeFile(verificationFile, `${JSON.stringify(verification, null, 2)}\n`, {mode: 0o600});
    return {repository_path: repository, patch_path: patchFile, verification_path: verificationFile};
  } catch (error) {
    await removeWorkTree(root);
    throw error;
  }
}

export function createCommandDriver({
  command,
  args = [],
  workRoot,
  artifactRoot = path.resolve('runs/factory/artifacts'),
  forkOwner = process.env.OSS_FACTORY_FORK_OWNER ?? 'AysajanE',
  checkoutProvider = null,
  verifier,
}) {
  if (!command) throw new Error('command driver requires an executable');
  const roots = new Map();
  return {
    async checkout(task, attempt) {
      const parent = path.resolve(workRoot ?? os.tmpdir());
      await mkdir(parent, {recursive: true, mode: 0o700});
      const root = await mkdtemp(path.join(parent, `northset-${task.task_id.toLowerCase()}-`));
      try {
        const result = checkoutProvider
          ? await checkoutProvider(task, attempt, root)
          : await runJsonCommand(command, args, {action: 'checkout', task, attempt, workdir: root});
        const checkout = path.resolve(result.checkout ?? root);
        const relative = path.relative(root, checkout);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error('worker checkout must remain inside its allocated work root');
        }
        roots.set(checkout, root);
        return checkout;
      } catch (error) {
        await removeWorkTree(root);
        throw error;
      }
    },
    scout: (task, checkout, options) => runJsonCommand(command, args, {action: 'scout', task, checkout, ...options}, {cwd: checkout}),
    bootstrap: (task, checkout, scout, attempt) => runJsonCommand(command, args, {action: 'bootstrap', task, checkout, scout, attempt}, {cwd: checkout}),
    author: async (task, checkout, scout, options) => {
      const result = await runJsonCommand(command, args, {action: 'author', task, checkout, scout, ...options}, {cwd: checkout});
      return {
        ...result,
        fork_repository: result.fork_repository ?? `${forkOwner}/${task.repository.split('/')[1]}`,
      };
    },
    verify: verifier ?? ((task, checkout, scout, authored, options) =>
      runJsonCommand(command, args, {action: 'verify', task, checkout, scout, authored, ...options}, {cwd: checkout})),
    persist: (task, checkout, context) => persistGitArtifact(task, checkout, context, artifactRoot),
    resetAfterFailure: (task, checkout, context) => runJsonCommand(command, args, {action: 'reset', task, checkout, ...context}, {cwd: checkout}),
    cleanup: async (_task, checkout) => {
      const root = roots.get(checkout);
      if (!root) return;
      roots.delete(checkout);
      const removed = await removeWorkTree(root, {tolerateBusy: true});
      if (!removed) process.stderr.write(`factory cleanup deferred for busy work tree ${root}\n`);
    },
  };
}
