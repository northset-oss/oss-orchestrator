// oss ship — take a PREPARED, approved mission all the way to the public ledger + a live PR.
// Reuses the PROVEN M-012 flow: build the attestable receipt via northset-oss run-mission.mjs, add it
// to northset-oss (attest CI), fork + push the exact reviewed commit, open the PR. Resumable via a
// per-mission journal; every outbound step is gated behind the founder's ONE manifest-bound approval.
//
// This is owner-built live integration (gh/git/docker/northset-oss) — Codex cannot run these to test.

import {cp, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {
  OSS_IDENTITY, assertOssCommitIdentity, canonical, git, manifestDigest, parseCandidate, prBody, run,
  sha256,
} from './core.mjs';

const NORTHSET_OSS = '/Users/aeziz-local/northset-oss';
const VERIFICATION_REPO = 'northset-oss/verification-pilot';
const FORK_OWNER = 'AysajanE';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }
async function must(label, r) { if (r.code !== 0) throw new Error(`${label} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`); return r; }

// Resumable journal: records which irreversible steps already succeeded so a re-run never repeats them.
async function loadJournal(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; } }
async function saveJournal(file, j) { await writeFile(file, JSON.stringify(j, null, 2)); }

// Reconstruct the run-mission.mjs input (the proven attestable-receipt format) from the lean ready-pack.
function missionInput(spec, receipt, dirs) {
  const {owner} = parseCandidate(spec.candidate);
  return {
    mission: {
      mission_id: spec.mission_id, variant: 'author_contribution', claims_tier: [], grade: null,
      disclosure_label: 'Northset contributed this fix and ran its declared checks. Contributor self-run. Not maintainer verification.',
      funding_source: 'Northset OSS Fund', northset_role: 'worker_runtime_operator',
      external_counterparty: `${owner} maintainers`, target_repo: spec.target_repo, issue_or_task: spec.issue_url,
      consent_artifact: null, repo_policy_snapshot: spec.receipt?.repo_policy_snapshot ?? null,
      worker_identity: {runtime: 'northset-oss executor v0', human_operator: 'aeziz'},
      base_commit: spec.base_commit, patch_commit: receipt.commit_oid, patch_diff_hash: receipt.patch_sha256,
      commands_declared: spec.executor.commands, environment: null,
      run_record_bundle_digest: null, attestation_uri: null,
      maintainer_outcome: {status: 'pending', link: null, decided_at: null},
      payment: {maintainer_payment: 'none', merge_contingent: false},
      limitations: spec.receipt?.limitations ?? [
        'Does not prove code quality', 'Does not prove security',
        'Contributor self-run record of Northset’s own contribution; not the maintainer’s verification.',
        `The declared network-off check runs \`${spec.executor.commands.join(' && ')}\` on ${spec.executor.image} after a disclosed online install. It does not run lint, type-check, or the full upstream CI gates.`,
      ],
    },
    repo_dir: dirs.executorBase, patch_file: dirs.patch, consent_file: null,
    issue_snapshot_file: dirs.snapshot, ci_links_file: null,
    // run-mission.mjs requires the full limits set; lean specs may omit some — fill defaults, spec wins.
    executor: {...spec.executor, limits: {
      cpus: 4, memory_mb: 4096, pids: 1024, wall_clock_seconds_per_command: 1800, output_bytes_per_stream: 2000000,
      ...(spec.executor.limits ?? {}),
    }},
  };
}

// Build the attestable receipt locally via the proven run-mission.mjs pipeline (2-phase Docker + bundle).
async function buildAttestableReceipt(spec, receipt, authorRepo, dirs, log) {
  await rm(dirs.executorBase, {recursive: true, force: true});
  await rm(dirs.staging, {recursive: true, force: true});
  await must('clone executor-base', await run('git', ['clone', '--local', '--no-hardlinks', authorRepo, dirs.executorBase]));
  await must('checkout base', await git(dirs.executorBase, 'checkout', '--detach', spec.base_commit));
  await git(dirs.executorBase, 'reset', '--hard', spec.base_commit);
  await run('git', ['-C', dirs.executorBase, 'clean', '-ffdx']);
  await rm(path.join(dirs.executorBase, '.git', 'hooks'), {recursive: true, force: true}).catch(() => {});
  await writeFile(dirs.input, JSON.stringify(missionInput(spec, receipt, dirs), null, 2));
  await log('building attestable receipt (northset-oss run-mission.mjs; Docker; --require-success)…');
  const r = await run('node', [path.join(NORTHSET_OSS, 'bin', 'run-mission.mjs'), dirs.input,
    '--missions-dir', dirs.staging, '--require-success', '--json'], {timeoutMs: 30 * 60 * 1000});
  let parsed = null; try { parsed = JSON.parse(r.stdout); } catch {}
  if (r.code !== 0 || !parsed?.ok) throw new Error(`receipt build failed: ${parsed?.message ?? r.stderr.trim().split('\n').slice(-2).join(' ')}`);
  return parsed; // {missionDir, bundleDigest, ...}
}

// Add the built mission to northset-oss, push (triggers attest CI), wait, verify, record the attestation.
async function publishToLedger(spec, built, dirs, journal, jfile, log) {
  const id = spec.mission_id;
  const oss = (...a) => run('git', ['-C', NORTHSET_OSS, ...a]);
  const now = '2026-07-13T00:00:00Z';
  const rebuild = async () => {
    await must('ledger build', await run('node', [path.join(NORTHSET_OSS, 'bin', 'ledger.mjs'), 'build', '--missions-dir', 'missions', '--out', 'missions/index.json', '--now', now], {cwd: NORTHSET_OSS}));
    await must('ledger render', await run('node', [path.join(NORTHSET_OSS, 'bin', 'ledger.mjs'), 'render', '--index', 'missions/index.json', '--out', 'site/index.html', '--now', now], {cwd: NORTHSET_OSS}));
  };
  if (!journal.mission_pushed) {
    await must('sync northset-oss', await oss('pull', '--ff-only'));
    await rm(path.join(NORTHSET_OSS, 'missions', id), {recursive: true, force: true});
    await cp(path.join(built.missionDir), path.join(NORTHSET_OSS, 'missions', id), {recursive: true});
    await rebuild();
    await must('git add', await oss('add', `missions/${id}`, 'missions/index.json', 'site/index.html'));
    const owner = parseCandidate(spec.candidate).owner;
    await must('mission commit', await oss('commit', '-m', `mission: ${id} author_contribution — ${owner}/${parseCandidate(spec.candidate).repo}#${parseCandidate(spec.candidate).issue} receipt\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`));
    await must('mission push', await oss('push', 'origin', 'main'));
    journal.mission_pushed = true; await saveJournal(jfile, journal);
    await log('mission receipt pushed to northset-oss main — attest CI triggered');
  }
  // wait for the attest workflow on our HEAD
  const headSha = (await oss('rev-parse', 'HEAD')).stdout.trim();
  if (!journal.attested) {
    await log('waiting for attest-bundle CI…');
    const runId = await pollRunFor(headSha, log);
    await must('attest CI', {code: (await run('gh', ['run', 'view', String(runId), '--repo', VERIFICATION_REPO, '--json', 'conclusion', '--jq', '.conclusion==\"success\"'])).stdout.trim() === 'true' ? 0 : 1, stdout: '', stderr: 'attest CI did not succeed'});
    journal.attested = true; await saveJournal(jfile, journal);
  }
  if (!journal.ledger_recorded) {
    const uri = `https://github.com/${VERIFICATION_REPO}/releases/download/run-record-${id}/run-record-${id}.tar.gz`;
    const mjPath = path.join(NORTHSET_OSS, 'missions', id, 'mission.json');
    const mj = JSON.parse(await readFile(mjPath, 'utf8'));
    mj.run_record_bundle_digest = built.bundleDigest; mj.attestation_uri = uri;
    await writeFile(mjPath, JSON.stringify(mj, null, 2));
    await rebuild();
    await must('git add ledger', await oss('add', `missions/${id}/mission.json`, 'missions/index.json', 'site/index.html'));
    await must('ledger commit', await oss('commit', '-m', `ledger: ${id} attested — record the release-asset attestation URL + bundle digest\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`));
    await must('ledger push', await oss('push', 'origin', 'main'));
    journal.ledger_recorded = true; journal.attestation_uri = uri; await saveJournal(jfile, journal);
    await log(`ledger updated — attested receipt live: ${uri}`);
  }
}

async function pollRunFor(headSha, log) {
  for (let i = 0; i < 60; i++) {
    const r = await run('gh', ['run', 'list', '--repo', VERIFICATION_REPO, '--workflow', 'attest-bundle.yml', '--limit', '5',
      '--json', 'databaseId,status,conclusion,headSha', '--jq', `.[] | select(.headSha==\"${headSha}\")`]);
    const line = r.stdout.trim().split('\n').filter(Boolean)[0];
    if (line) {
      const run = JSON.parse(line);
      if (run.status === 'completed') { if (run.conclusion !== 'success') throw new Error(`attest CI ${run.conclusion}`); return run.databaseId; }
    }
    await new Promise((res) => setTimeout(res, 10000));
  }
  throw new Error('attest CI did not complete within timeout');
}

async function forkPushPR(spec, receipt, authorRepo, prBodyFile, journal, jfile, log) {
  const {owner, repo, issue} = parseCandidate(spec.candidate);
  const branch = `northset/${spec.mission_id}`;
  const commit = receipt.commit_oid;
  if (!journal.forked) {
    if ((await run('gh', ['repo', 'view', `${FORK_OWNER}/${repo}`, '--json', 'name'])).code !== 0) {
      await must('fork', await run('gh', ['repo', 'fork', `${owner}/${repo}`, '--clone=false', '--default-branch-only']));
      for (let i = 0; i < 8 && (await run('gh', ['repo', 'view', `${FORK_OWNER}/${repo}`, '--json', 'name'])).code !== 0; i++) await new Promise((r) => setTimeout(r, 3000));
    }
    journal.forked = true; await saveJournal(jfile, journal);
  }
  if (!journal.pushed) {
    await git(authorRepo, 'remote', 'get-url', 'fork').then((r) => r.code === 0 ? null : git(authorRepo, 'remote', 'add', 'fork', `https://github.com/${FORK_OWNER}/${repo}.git`));
    await must('push fork', await git(authorRepo, 'push', 'fork', `${commit}:refs/heads/${branch}`));
    const forkSha = (await run('gh', ['api', `repos/${FORK_OWNER}/${repo}/git/refs/heads/${branch}`, '--jq', '.object.sha'])).stdout.trim();
    if (forkSha !== commit) throw new Error(`fork branch OID ${forkSha} != reviewed ${commit}`);
    journal.pushed = true; await saveJournal(jfile, journal);
    await log(`pushed reviewed commit ${commit.slice(0, 12)} to ${FORK_OWNER}:${branch}`);
  }
  if (!journal.pr_opened) {
    const base = (await run('gh', ['api', `repos/${owner}/${repo}`, '--jq', '.default_branch'])).stdout.trim();
    const title = await prTitle(spec, path.dirname(prBodyFile)); // exact title bound by the manifest
    const created = await must('pr create', await run('gh', ['pr', 'create', '--repo', `${owner}/${repo}`, '--base', base,
      '--head', `${FORK_OWNER}:${branch}`, '--title', title, '--body-file', prBodyFile]));
    const url = created.stdout.trim().split('\n').filter((l) => l.startsWith('http')).pop();
    const view = JSON.parse((await must('pr view', await run('gh', ['pr', 'view', url, '--repo', `${owner}/${repo}`, '--json', 'number,headRefOid,body,url'])).then((r) => r)).stdout);
    if (view.headRefOid !== commit) throw new Error(`opened PR head ${view.headRefOid} != reviewed ${commit}`);
    if (!view.body.includes('northset-oss.github.io/verification-pilot')) throw new Error('opened PR body is missing the receipt footer');
    journal.pr_opened = true; journal.pr_url = view.url; await saveJournal(jfile, journal);
    await log(`PR opened: ${view.url}  (head ${commit.slice(0, 12)} asserted; footer verified on stored body)`);
  }
  return journal.pr_url;
}

// The PR title is a first-class, author-editable ready-pack file so the manifest binds the EXACT title
// that gets opened (not a derived one). Default keeps things working before finalization.
async function prTitle(spec, ready) {
  try { return (await readFile(path.join(ready, 'pr_title.txt'), 'utf8')).trim(); } catch { return `fix: ${spec.candidate}`; }
}

// The manifest digest binds exactly what will ship (R5). `oss ship --approve <digest>` must name it.
async function manifestOf(spec, ready) {
  const receipt = JSON.parse(await readFile(path.join(ready, 'receipt.json'), 'utf8'));
  const subject = {
    diff: await readFile(path.join(ready, 'fix.patch'), 'utf8'), commit_oid: receipt.commit_oid,
    receipt_subject: receipt, pr_title: await prTitle(spec, ready), pr_body: await readFile(path.join(ready, 'pr_body.md'), 'utf8'),
    repo: receipt.repo, planned_actions: ['fork', 'push', 'attest', 'open-pr', 'append-ledger'],
  };
  return {receipt, manifest: manifestDigest([subject])};
}

// Entry point. missionDir = the prepared runs/<id> dir (has ready-pack/ + author-workspace/repo).
// buildOnly: build the attestable receipt locally and STOP (reversible; prints the manifest to approve).
export async function shipOne(missionDir, spec, {approvedDigest, buildOnly = false, log}) {
  const ready = path.join(missionDir, 'ready-pack');
  const authorRepo = path.join(missionDir, 'author-workspace', 'repo');
  if (!await exists(authorRepo)) throw new Error(`author repo missing at ${authorRepo} — re-run prepare`);
  const {receipt, manifest} = await manifestOf(spec, ready);
  // Outbound requires the founder's ONE approval of exactly this ready-pack's manifest digest.
  if (!buildOnly && approvedDigest !== manifest) {
    throw new Error(`ship requires --approve ${manifest} (got ${approvedDigest ?? 'none'}) — review the ready-pack and approve exactly this`);
  }
  const prBodyFile = path.join(ready, 'pr_body.md');
  const dirs = {
    executorBase: path.join(missionDir, 'executor-base'), staging: path.join(missionDir, 'missions'),
    patch: path.join(ready, 'fix.patch'), input: path.join(missionDir, 'input.json'),
    snapshot: path.join(missionDir, 'issue_snapshot.json'),
  };
  if (!await exists(dirs.snapshot)) await writeFile(dirs.snapshot, JSON.stringify({fetched_at: null, note: 'issue snapshot rebuilt at ship'}, null, 2));
  const jfile = path.join(missionDir, 'ship.journal.json');
  const journal = await loadJournal(jfile);

  let built = journal.built;
  if (!built) { built = await buildAttestableReceipt(spec, receipt, authorRepo, dirs, log); journal.built = built; await saveJournal(jfile, journal); }
  if (buildOnly) { await log(`receipt built (bundle ${built.bundleDigest}). Approve with:  --approve ${manifest}`); return {manifest, bundle_digest: built.bundleDigest, build_only: true}; }

  await publishToLedger(spec, built, dirs, journal, jfile, log);
  const prUrl = await forkPushPR(spec, receipt, authorRepo, prBodyFile, journal, jfile, log);
  return {pr_url: prUrl, attestation_uri: journal.attestation_uri, bundle_digest: built.bundleDigest};
}
