import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createBoardIfDue, classifyRisk} from './board.mjs';

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

function receiptFooter(missionId) {
  const receiptUrl = `https://northset-oss.github.io/verification-pilot/receipts/${missionId}/`;
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

export function finalizePrBody(body, missionId) {
  const receiptUrl = `https://northset-oss.github.io/verification-pilot/receipts/${missionId}/`;
  let rendered = String(body ?? '')
    .replaceAll('{{MISSION_ID}}', missionId)
    .replaceAll('{{RECEIPT_URL}}', receiptUrl)
    .trimEnd();
  if (!rendered.includes(`<!-- northset-receipt:${missionId}:start -->`)) {
    rendered = `${rendered}\n\n${receiptFooter(missionId)}`.trim();
  }
  return `${rendered}\n`;
}

function defaultManifest(task, authorResult, verification, missionId) {
  const receiptUrl = `https://northset-oss.github.io/verification-pilot/receipts/${missionId}/`;
  const body = finalizePrBody(authorResult.pr_body, missionId);
  return {
    repository: task.repository,
    fork_repository: authorResult.fork_repository ?? task.live_state?.fork_repository ?? null,
    issue_number: task.issue_number,
    issue_url: authorResult.issue_url ?? `https://github.com/${task.repository}/issues/${task.issue_number}`,
    invitation_summary: task.live_state?.invitation_summary ?? 'Live preflight confirmed an invited, unoccupied issue.',
    base_branch: authorResult.base_branch ?? task.live_state?.default_branch ?? 'main',
    base_oid: task.base_oid,
    patch_sha256: verification.patch_sha256,
    tested_tree_oid: verification.tested_tree_oid,
    commit_oid: verification.commit_oid,
    checks: authorResult.checks ?? [authorResult.test_command].filter(Boolean),
    verification,
    pr_title: authorResult.pr_title,
    pr_body: body,
    summary: authorResult.summary,
    changed_files: authorResult.changed_files ?? [],
    changed_lines: authorResult.changed_lines ?? 0,
    risk_tier: authorResult.risk_tier ?? classifyRisk(authorResult),
    risk_warnings: authorResult.risk_warnings ?? [],
    receipt_claim: {
      type: verification.claim_type,
      statement: authorResult.receipt_claim ?? verification.claim_type,
    },
    receipt_url: receiptUrl,
    proof: authorResult.proof ?? null,
    planned_actions: ['publish-proof', 'push-approved-commit', 'open-upstream-pr', 'verify-pr-readback'],
  };
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
    const dependencyMaterial = await semaphores.bootstrap.run(() => oneInfrastructureRetry(
      () => driver.bootstrap(task, checkout, scout, attempt),
    ));
    let feedback = null;
    let lastError = null;
    for (let authorAttempt = 1; authorAttempt <= 2; authorAttempt += 1) {
      try {
        const authored = await semaphores.author.run(() => driver.author(task, checkout, scout, {
          attempt: authorAttempt,
          effort: authorAttempt === 1 ? 'high' : (driver.secondEffort ?? 'high'),
          timeoutMs: 10 * 60_000,
          verifierFeedback: feedback,
          dependencyMaterial,
        }));
        if (!authored || authored.outcome === 'SKIP') {
          db.finishAttempt(attempt.attempt_id, {
            outcome: 'SKIPPED', failureClass: 'authoring',
            durationMs: now().getTime() - began,
            error: authored?.reason ?? 'author declined the task', now: now(),
          });
          return {task_id: task.task_id, state: 'SKIPPED', reason: authored?.reason ?? null};
        }
        const verification = await semaphores.verifier.run(() => driver.verify(task, checkout, scout, authored, {
          dependencyMaterial,
        }));
        db.finishAttempt(attempt.attempt_id, {
          outcome: 'VERIFIED', durationMs: now().getTime() - began,
          patchSha256: verification.patch_sha256,
          commitOid: verification.commit_oid,
          verification, now: now(),
        });
        const riskTier = authored.risk_tier ?? classifyRisk(authored);
        if (riskTier === 'RED') {
          db.updateTaskState(task.task_id, 'SKIPPED', 'Red work is outside the scaled lane', {now: now()});
          return {task_id: task.task_id, state: 'SKIPPED', reason: 'RED'};
        }
        const ready = db.promoteVerified(attempt.attempt_id,
          (missionId) => defaultManifest(task, authored, verification, missionId),
          {riskTier, now: now()});
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
  if (source) await semaphores.preflight.run(() => source.run({workers, profile, now: now()}));
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

function runJsonCommand(command, args, payload, {cwd = undefined} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const error = new Error(`worker command failed: ${(stderr || stdout).trim() || `exit ${code}`}`);
        error.transient = /temporar|timed out|connection reset/i.test(stderr);
        reject(error);
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`worker command returned invalid JSON: ${error.message}`)); }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

export function createCommandDriver({command, args = [], workRoot, verifier}) {
  if (!command) throw new Error('command driver requires an executable');
  return {
    async checkout(task, attempt) {
      const root = await mkdtemp(path.join(workRoot ?? os.tmpdir(), `northset-${task.task_id.toLowerCase()}-`));
      const result = await runJsonCommand(command, args, {action: 'checkout', task, attempt, workdir: root});
      return result.checkout ?? root;
    },
    scout: (task, checkout, options) => runJsonCommand(command, args, {action: 'scout', task, checkout, ...options}, {cwd: checkout}),
    bootstrap: (task, checkout, scout, attempt) => runJsonCommand(command, args, {action: 'bootstrap', task, checkout, scout, attempt}, {cwd: checkout}),
    author: (task, checkout, scout, options) => runJsonCommand(command, args, {action: 'author', task, checkout, scout, ...options}, {cwd: checkout}),
    verify: verifier ?? ((task, checkout, scout, authored, options) =>
      runJsonCommand(command, args, {action: 'verify', task, checkout, scout, authored, ...options}, {cwd: checkout})),
    resetAfterFailure: (task, checkout, context) => runJsonCommand(command, args, {action: 'reset', task, checkout, ...context}, {cwd: checkout}),
    cleanup: async (_task, checkout) => { if (checkout) await rm(path.dirname(checkout), {recursive: true, force: true}); },
  };
}
