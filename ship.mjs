// Ship only an already-prepared, content-bound mission. Preparation owns authoring and
// verification; this module owns the small set of irreversible publication steps.

import {cp, mkdtemp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertBindingChain,
  assertPatchCommitBinding,
  canonical,
  directoryDigest,
  git,
  manifestDigest,
  parseCandidate,
  recheck,
  run,
  sha256,
} from './core.mjs';

const NORTHSET_OSS = process.env.NORTHSET_OSS_DIR ?? '/Users/aeziz-local/northset-oss';
const VERIFICATION_REPO = 'northset-oss/verification-pilot';
const FORK_OWNER = 'AysajanE';
const BUNDLE_CLI = path.join(NORTHSET_OSS, 'bin', 'bundle.mjs');
const WORKFLOW_FILE = 'attest-bundle.yml';
const PLANNED_ACTIONS = [
  'push-reviewed-commit',
  'publish-reviewed-bundle',
  'verify-attestation',
  'open-pr',
  'publish-pr-envelope',
];

async function exists(file) {
  try { await stat(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function must(label, result) {
  if (result.code !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-4).join(' ')}`);
  }
  return result;
}

export function batchManifestDigest(subjects) {
  return manifestDigest(subjects);
}

export function validateApprovedBatch(subjects, approvedDigest) {
  if (!Array.isArray(subjects) || subjects.length < 1 || subjects.length > 3) {
    throw new Error('an approved ship batch must contain one to three missions');
  }
  const repositories = new Set(subjects.map((subject) => subject.repo.toLowerCase()));
  if (repositories.size !== subjects.length) throw new Error('each mission in a ship batch must target a distinct repository');
  for (const subject of subjects) {
    if (canonical(subject.planned_actions) !== canonical(PLANNED_ACTIONS)) {
      throw new Error(`${subject.mission_id} has an unexpected planned action set`);
    }
  }
  const expected = batchManifestDigest(subjects);
  if (approvedDigest !== expected) throw new Error(`batch approval mismatch: expected --approve ${expected}`);
  return subjects;
}

export async function loadJournal(file) {
  let source;
  try { source = await readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try { return JSON.parse(source); } catch (error) {
    throw new Error(`ship journal is corrupt at ${file}: ${error.message}`);
  }
}

export async function saveJournal(file, journal) {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
}

export function assertJournalBinding(journal, approvedManifest, bundleDigest, missionManifest = null) {
  if (journal.approved_manifest !== approvedManifest) throw new Error('journal manifest binding does not match this approval');
  if (journal.bundle_digest !== bundleDigest) throw new Error('journal bundle binding does not match this ready pack');
  if (missionManifest !== null && journal.mission_manifest !== missionManifest) {
    throw new Error('journal mission-manifest binding does not match this ready pack');
  }
}

function expectedRelease(manifest) {
  const short = manifest.bundle_digest.slice('sha256:'.length, 'sha256:'.length + 12);
  const tag = `run-record-${manifest.mission_id}-${short}`;
  const asset = `${tag}.tar.gz`;
  return {
    tag,
    asset,
    uri: `https://github.com/${VERIFICATION_REPO}/releases/download/${tag}/${asset}`,
  };
}

async function loadReadySubject(spec, missionDir) {
  const ready = path.join(missionDir, 'ready-pack');
  const files = {
    manifest: path.join(ready, 'manifest.json'),
    patch: path.join(ready, 'fix.patch'),
    body: path.join(ready, 'pr_body.md'),
    title: path.join(ready, 'pr_title.txt'),
    issue: path.join(ready, 'issue_snapshot.json'),
    policy: path.join(ready, 'policy_snapshot.json'),
    oracle: path.join(ready, 'oracle.json'),
    publicMission: path.join(ready, 'public-mission'),
    authorRepo: path.join(missionDir, 'author-workspace', 'repo'),
  };
  const manifest = JSON.parse(await readFile(files.manifest, 'utf8'));
  if (manifest.mission_id !== spec.mission_id) throw new Error(`${spec.mission_id} manifest has the wrong mission id`);
  if (manifest.repo !== `${parseCandidate(spec.candidate).owner}/${parseCandidate(spec.candidate).repo}`) {
    throw new Error(`${spec.mission_id} manifest repository does not match its spec`);
  }
  if (manifest.base_commit !== spec.base_commit || manifest.issue_url !== spec.issue_url) {
    throw new Error(`${spec.mission_id} manifest no longer matches its reviewed spec`);
  }
  if (manifest.spec_sha256 !== sha256(Buffer.from(canonical(spec), 'utf8'))) {
    throw new Error(`${spec.mission_id} spec changed after preparation`);
  }
  if (new Date(manifest.expires_at).getTime() <= Date.now()) throw new Error(`${spec.mission_id} ready pack expired; prepare it again`);
  if (canonical(manifest.planned_actions) !== canonical(PLANNED_ACTIONS)) throw new Error(`${spec.mission_id} manifest has unexpected actions`);
  const [patch, body, title, issue, policy, oracle] = await Promise.all([
    readFile(files.patch), readFile(files.body), readFile(files.title, 'utf8'),
    readFile(files.issue), readFile(files.policy), readFile(files.oracle),
  ]);
  const checks = [
    ['patch', manifest.patch_sha256, sha256(patch)],
    ['PR body', manifest.pr_body_sha256, sha256(body)],
    ['issue snapshot', manifest.issue_snapshot_sha256, sha256(issue)],
    ['policy snapshot', manifest.policy_snapshot_sha256, sha256(policy)],
    ['oracle', manifest.oracle_sha256, sha256(Buffer.from(canonical(JSON.parse(oracle.toString('utf8')))))],
  ];
  for (const [label, expected, actual] of checks) {
    if (expected !== actual) throw new Error(`${spec.mission_id} ${label} digest changed after preparation`);
  }
  if (title.trim() !== manifest.pr_title) throw new Error(`${spec.mission_id} PR title changed after preparation`);
  if (!await exists(files.authorRepo)) throw new Error(`${spec.mission_id} author repository is missing; prepare it again`);
  const tree = await assertPatchCommitBinding(files.authorRepo, manifest.base_commit, manifest.commit_oid, files.patch);
  assertBindingChain({patch_sha256: manifest.patch_sha256, tested_tree_oid: tree, commit_oid: manifest.commit_oid});
  if (tree !== manifest.tested_tree_oid) throw new Error(`${spec.mission_id} tested tree no longer matches the manifest`);
  const verified = await must('public bundle verify', await run('node', [BUNDLE_CLI, 'verify', files.publicMission, '--json']));
  const parsed = JSON.parse(verified.stdout);
  if (parsed.bundle_digest !== manifest.bundle_digest) throw new Error(`${spec.mission_id} bundle digest changed after preparation`);
  if (await directoryDigest(files.publicMission) !== manifest.public_mission_sha256) {
    throw new Error(`${spec.mission_id} public mission bytes changed after preparation`);
  }
  return {spec, missionDir, ready, files, manifest};
}

async function ensureCleanPublicRepository() {
  const status = await must('northset-oss status', await git(NORTHSET_OSS, 'status', '--porcelain'));
  if (status.stdout.trim()) {
    throw new Error('northset-oss has uncommitted framework changes; review, commit, and push them before shipping a mission');
  }
  await must('northset-oss pull', await git(NORTHSET_OSS, 'pull', '--ff-only', 'origin', 'main'));
}

async function rebuildLedger() {
  const now = new Date().toISOString();
  await must('ledger build', await run('node', [path.join(NORTHSET_OSS, 'bin', 'ledger.mjs'), 'build',
    '--missions-dir', 'missions', '--out', 'missions/index.json', '--now', now], {cwd: NORTHSET_OSS}));
  await must('ledger render', await run('node', [path.join(NORTHSET_OSS, 'bin', 'ledger.mjs'), 'render',
    '--index', 'missions/index.json', '--out', 'site/index.html', '--now', now], {cwd: NORTHSET_OSS}));
}

async function commitPublic(paths, message) {
  await must('northset-oss add', await git(NORTHSET_OSS, 'add', ...paths));
  await must('northset-oss commit', await git(NORTHSET_OSS, 'commit', '-m', message));
  await must('northset-oss push', await git(NORTHSET_OSS, 'push', 'origin', 'main'));
  return (await must('northset-oss head', await git(NORTHSET_OSS, 'rev-parse', 'HEAD'))).stdout.trim();
}

async function assertOnlyExpectedPublicChanges(allowed) {
  const status = await must('northset-oss status', await git(NORTHSET_OSS, 'status', '--porcelain'));
  const unexpected = status.stdout.split('\n').filter(Boolean).filter((line) => {
    const changed = line.slice(3).trim().replace(/^.* -> /, '');
    return !allowed.some((entry) => changed === entry || changed.startsWith(`${entry}/`));
  });
  if (unexpected.length) throw new Error(`northset-oss has unrelated changes: ${unexpected.join('; ')}`);
  return status.stdout.trim() !== '';
}

async function commitOrAdoptPublic(paths, message, marker) {
  let commitSha;
  if (await assertOnlyExpectedPublicChanges(paths)) {
    commitSha = await commitPublic(paths, message);
  } else {
    // A crash can happen after the local commit but before either push or journal persistence.
    await must('northset-oss push recovery', await git(NORTHSET_OSS, 'push', 'origin', 'main'));
    commitSha = (await must('find public commit', await git(NORTHSET_OSS, 'log', '-1', '--format=%H', '--', marker))).stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error(`cannot identify the public commit containing ${marker}`);
  }
  const remoteHead = (await must('read public remote head', await run('gh', ['api',
    `repos/${VERIFICATION_REPO}/git/ref/heads/main`, '--jq', '.object.sha']))).stdout.trim();
  const ancestor = await git(NORTHSET_OSS, 'merge-base', '--is-ancestor', commitSha, remoteHead);
  if (ancestor.code !== 0) throw new Error(`public commit ${commitSha} is not present on ${VERIFICATION_REPO}@main`);
  return commitSha;
}

async function preparedDestinationDigest(destination) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'northset-public-recovery-'));
  try {
    const copy = path.join(temporary, 'mission');
    await cp(destination, copy, {recursive: true, verbatimSymlinks: true});
    await rm(path.join(copy, 'publication.json'), {force: true});
    return directoryDigest(copy);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}

async function remotePublicFile(file, ref) {
  const response = await must('read remote public file', await run('gh', ['api',
    `repos/${VERIFICATION_REPO}/contents/${file}?ref=${encodeURIComponent(ref)}`]));
  const parsed = JSON.parse(response.stdout);
  if (parsed.encoding !== 'base64' || typeof parsed.content !== 'string') throw new Error(`remote ${file} did not return base64 content`);
  return Buffer.from(parsed.content.replaceAll('\n', ''), 'base64');
}

function publication(manifest, overrides = {}) {
  const release = expectedRelease(manifest);
  return {
    schema_version: 1,
    mission_id: manifest.mission_id,
    state: 'prepared',
    pr_number: null,
    pr_url: null,
    pr_head_oid: null,
    base_branch: manifest.base_branch,
    head_drift: false,
    ci_state: null,
    merge_commit_oid: null,
    review_decision: null,
    decision_url: null,
    opened_at: null,
    closed_at: null,
    updated_at: new Date().toISOString(),
    correction_note: null,
    attestation_uri: release.uri,
    bundle_digest: manifest.bundle_digest,
    release_asset_sha256: null,
    ...overrides,
  };
}

async function publishPreparedBundle(subject, journal, journalFile, log) {
  const id = subject.manifest.mission_id;
  const destination = path.join(NORTHSET_OSS, 'missions', id);
  if (journal.ledger?.commit_sha) {
    const remote = JSON.parse((await remotePublicFile(`missions/${id}/bundle/bundle.manifest.json`, journal.ledger.commit_sha)).toString('utf8'));
    if (remote.bundle_digest !== subject.manifest.bundle_digest) throw new Error(`${id} remote public bundle does not match the journal`);
    return;
  }
  if (!await exists(destination)) {
    await ensureCleanPublicRepository();
    await cp(subject.files.publicMission, destination, {recursive: true, verbatimSymlinks: true});
    await writeFile(path.join(destination, 'publication.json'), `${JSON.stringify(publication(subject.manifest), null, 2)}\n`);
  } else {
    if (await preparedDestinationDigest(destination) !== subject.manifest.public_mission_sha256) {
      throw new Error(`${id} existing public mission does not match the approved bytes`);
    }
    const current = JSON.parse(await readFile(path.join(destination, 'publication.json'), 'utf8'));
    if (current.mission_id !== id || current.bundle_digest !== subject.manifest.bundle_digest || current.pr_url !== null) {
      throw new Error(`${id} existing publication cannot be adopted as the prepared state`);
    }
  }
  await rebuildLedger();
  const commitSha = await commitOrAdoptPublic([
    `missions/${id}`, 'missions/index.json', 'site/index.html',
  ], `mission: publish prepared ${id} bundle`, `missions/${id}/bundle/bundle.manifest.json`);
  const remote = JSON.parse((await remotePublicFile(`missions/${id}/bundle/bundle.manifest.json`, commitSha)).toString('utf8'));
  if (remote.bundle_digest !== subject.manifest.bundle_digest) throw new Error(`${id} recovered public commit has the wrong bundle`);
  journal.ledger = {...(journal.ledger ?? {}), commit_sha: commitSha};
  await saveJournal(journalFile, journal);
  await log('published the exact prepared bundle; attestation workflow triggered');
}

async function pollWorkflow(headSha) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const listed = await must('workflow list', await run('gh', ['run', 'list', '--repo', VERIFICATION_REPO,
      '--workflow', WORKFLOW_FILE, '--limit', '20', '--json', 'databaseId,status,conclusion,headSha']));
    const runRecord = JSON.parse(listed.stdout).find((item) => item.headSha === headSha);
    if (runRecord?.status === 'completed') {
      if (runRecord.conclusion !== 'success') throw new Error(`attestation workflow ${runRecord.databaseId} ended ${runRecord.conclusion}`);
      return runRecord.databaseId;
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error('attestation workflow did not complete within ten minutes');
}

async function verifyReleasedBundle(subject, journal, journalFile, log) {
  const release = expectedRelease(subject.manifest);
  const runId = journal.ledger?.workflow_run_id ?? await pollWorkflow(journal.ledger.commit_sha);
  journal.ledger = {...(journal.ledger ?? {}), workflow_run_id: runId};
  await saveJournal(journalFile, journal);
  const root = await mkdtemp(path.join(os.tmpdir(), `${subject.manifest.mission_id}-attestation-`));
  try {
    const asset = path.join(root, release.asset);
    await must('download release asset', await run('gh', ['release', 'download', release.tag, '--repo', VERIFICATION_REPO,
      '--pattern', release.asset, '--dir', root]));
    await must('verify GitHub attestation', await run('gh', ['attestation', 'verify', asset, '--repo', VERIFICATION_REPO,
      '--signer-workflow', `${VERIFICATION_REPO}/.github/workflows/${WORKFLOW_FILE}`]));
    const extract = path.join(root, 'extract');
    await mkdir(extract);
    await must('extract release bundle', await run('tar', ['-xzf', asset, '-C', extract]));
    const bundleRoot = path.join(extract, 'bundle');
    const staged = path.join(root, 'mission');
    await mkdir(staged);
    await cp(bundleRoot, path.join(staged, 'bundle'), {recursive: true, verbatimSymlinks: true});
    await cp(path.join(subject.files.publicMission, 'mission.json'), path.join(staged, 'mission.json'));
    const verified = await must('verify downloaded bundle contents', await run('node', [BUNDLE_CLI, 'verify', staged, '--json']));
    const parsed = JSON.parse(verified.stdout);
    if (parsed.bundle_digest !== subject.manifest.bundle_digest) throw new Error('downloaded attested bundle digest does not match approval');
    journal.ledger = {
      ...journal.ledger,
      release_tag: release.tag,
      attestation_uri: release.uri,
      release_asset_sha256: sha256(await readFile(asset)),
      attestation_verified: true,
    };
    await saveJournal(journalFile, journal);
    await log(`downloaded and verified attested asset ${release.asset}`);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

async function ensureForkAndPush(subject, journal, journalFile, log) {
  const {owner, repo} = parseCandidate(subject.spec.candidate);
  const branch = `northset/${subject.manifest.mission_id}`;
  let forkInfo = await run('gh', ['api', `repos/${FORK_OWNER}/${repo}`]);
  if (forkInfo.code !== 0) {
    await must('fork repository', await run('gh', ['repo', 'fork', `${owner}/${repo}`, '--clone=false', '--default-branch-only']));
    forkInfo = await must('read created fork', await run('gh', ['api', `repos/${FORK_OWNER}/${repo}`]));
  }
  assertForkParent(JSON.parse(forkInfo.stdout), `${owner}/${repo}`);
  if (!journal.fork?.oid) {
    const current = await git(subject.files.authorRepo, 'remote', 'get-url', 'fork');
    if (current.code !== 0) await must('add fork remote', await git(subject.files.authorRepo, 'remote', 'add', 'fork', `https://github.com/${FORK_OWNER}/${repo}.git`));
    await must('push reviewed commit', await git(subject.files.authorRepo, 'push', 'fork',
      `${subject.manifest.commit_oid}:refs/heads/${branch}`));
    journal.fork = {repo: `${FORK_OWNER}/${repo}`, branch, oid: subject.manifest.commit_oid};
    await saveJournal(journalFile, journal);
  }
  const remote = await must('read fork branch', await run('gh', ['api', `repos/${FORK_OWNER}/${repo}/git/ref/heads/${branch}`, '--jq', '.object.sha']));
  assertBindingChain({...subject.manifest, pushed_oid: remote.stdout.trim()});
  if (journal.fork.repo !== `${FORK_OWNER}/${repo}` || journal.fork.branch !== branch || journal.fork.oid !== remote.stdout.trim()) {
    throw new Error(`${subject.manifest.mission_id} journal fork evidence does not match GitHub`);
  }
  await log(`fork branch points to reviewed commit ${subject.manifest.commit_oid.slice(0, 12)}`);
  return branch;
}

export function assertForkParent(repository, expectedParent) {
  if (repository?.fork !== true || String(repository?.parent?.full_name ?? '').toLowerCase() !== expectedParent.toLowerCase()) {
    throw new Error(`${repository?.full_name ?? 'existing repository'} is not a fork of ${expectedParent}`);
  }
  return true;
}

async function validateAndRecordPr(subject, pr, journal, journalFile) {
  const approvedBody = (await readFile(subject.files.body, 'utf8')).trimEnd();
  if (pr.title !== subject.manifest.pr_title || pr.body.trimEnd() !== approvedBody || pr.baseRefName !== subject.manifest.base_branch) {
    throw new Error('GitHub stored PR title, body, or base differs from approved bytes');
  }
  assertBindingChain({...subject.manifest, pushed_oid: journal.fork.oid, pr_head_oid: pr.headRefOid});
  journal.pr = {
    number: pr.number,
    url: pr.url,
    head_oid: pr.headRefOid,
    body_sha256: sha256(Buffer.from(pr.body)),
    opened_at: pr.createdAt,
  };
  await saveJournal(journalFile, journal);
  return pr;
}

async function openPullRequest(subject, branch, journal, journalFile, log) {
  const {owner, repo} = parseCandidate(subject.spec.candidate);
  if (journal.pr?.url) {
    const existing = JSON.parse((await must('read existing PR', await run('gh', ['pr', 'view', journal.pr.url,
      '--repo', `${owner}/${repo}`, '--json', 'number,url,headRefOid,baseRefName,title,body,createdAt']))).stdout);
    const approvedBody = (await readFile(subject.files.body, 'utf8')).trimEnd();
    if (existing.title !== subject.manifest.pr_title || existing.body.trimEnd() !== approvedBody || existing.baseRefName !== subject.manifest.base_branch) {
      throw new Error('resumed PR title, body, or base branch differs from approved bytes');
    }
    assertBindingChain({...subject.manifest, pushed_oid: journal.fork.oid, pr_head_oid: existing.headRefOid});
    if (journal.pr.number !== existing.number || journal.pr.head_oid !== existing.headRefOid || journal.pr.body_sha256 !== sha256(Buffer.from(existing.body))) {
      throw new Error('journal PR evidence does not match GitHub');
    }
    return existing.url;
  }
  const recoverable = JSON.parse((await must('find pull request by approved branch', await run('gh', ['pr', 'list',
    '--repo', `${owner}/${repo}`, '--state', 'all', '--head', `${FORK_OWNER}:${branch}`, '--limit', '10',
    '--json', 'number,url,headRefOid,baseRefName,title,body,createdAt']))).stdout)
    .filter((pr) => pr.headRefOid === subject.manifest.commit_oid);
  if (recoverable.length > 1) throw new Error('multiple pull requests match the approved branch and commit');
  if (recoverable.length === 1) {
    const recovered = await validateAndRecordPr(subject, recoverable[0], journal, journalFile);
    await log(`adopted existing exact pull request ${recovered.url}`);
    return recovered.url;
  }
  // This is deliberately the last mutable-world check: no PR is opened if issue intent, overlap,
  // base head, contributor cap, or repository cooldown changed while attestation was running.
  const checked = await recheck(subject.spec, log);
  if (new Date(subject.manifest.expires_at).getTime() <= Date.now()) throw new Error('ready pack expired during attestation; prepare it again');
  if (!checked.clean) throw new Error(`final ship recheck failed: ${checked.reasons.join('; ')}`);
  const created = await must('create pull request', await run('gh', ['pr', 'create', '--repo', `${owner}/${repo}`,
    '--base', subject.manifest.base_branch, '--head', `${FORK_OWNER}:${branch}`,
    '--title', subject.manifest.pr_title, '--body-file', subject.files.body]));
  const url = created.stdout.trim().split('\n').findLast((line) => /^https:\/\/github\.com\//.test(line));
  if (!url) throw new Error('gh pr create did not return a pull request URL');
  const view = JSON.parse((await must('verify pull request', await run('gh', ['pr', 'view', url, '--repo', `${owner}/${repo}`,
    '--json', 'number,url,headRefOid,baseRefName,title,body,createdAt']))).stdout);
  await validateAndRecordPr(subject, view, journal, journalFile);
  await log(`opened ${view.url}`);
  return view.url;
}

async function publishPrEnvelope(subject, journal, journalFile, log) {
  if (journal.envelope?.commit_sha) {
    const remote = await remotePublicFile(`missions/${subject.manifest.mission_id}/publication.json`, journal.envelope.commit_sha);
    if (sha256(remote) !== journal.envelope.publication_sha256) throw new Error('remote publication envelope does not match the journal');
    return;
  }
  const currentPr = JSON.parse((await must('read pull request for publication', await run('gh', ['pr', 'view', journal.pr.url,
    '--json', 'number,url,state,title,body,headRefOid,baseRefName,createdAt,closedAt,mergedAt,updatedAt,reviewDecision,mergeCommit,statusCheckRollup']))).stdout);
  const approvedBody = (await readFile(subject.files.body, 'utf8')).trimEnd();
  if (currentPr.title !== subject.manifest.pr_title || currentPr.body.trimEnd() !== approvedBody ||
      currentPr.baseRefName !== subject.manifest.base_branch || currentPr.headRefOid !== subject.manifest.commit_oid) {
    throw new Error('pull request drifted before publication envelope was recorded');
  }
  const file = path.join(NORTHSET_OSS, 'missions', subject.manifest.mission_id, 'publication.json');
  const current = JSON.parse(await readFile(file, 'utf8'));
  if (current.pr_url !== null && current.pr_url !== journal.pr.url) throw new Error('existing publication envelope belongs to another pull request');
  const projected = publicationFromPr({
    mission_id: subject.manifest.mission_id,
    patch_commit: subject.manifest.commit_oid,
    attestation_uri: journal.ledger.attestation_uri,
    run_record_bundle_digest: subject.manifest.bundle_digest,
  }, currentPr, {
    attestation_uri: journal.ledger.attestation_uri,
    bundle_digest: subject.manifest.bundle_digest,
    release_asset_sha256: journal.ledger.release_asset_sha256,
  });
  const contents = `${JSON.stringify(projected, null, 2)}\n`;
  await writeFile(file, contents);
  await rebuildLedger();
  const commitSha = await commitOrAdoptPublic([
    `missions/${subject.manifest.mission_id}/publication.json`, 'missions/index.json', 'site/index.html',
  ], `ledger: record ${subject.manifest.mission_id} pull request`,
  `missions/${subject.manifest.mission_id}/publication.json`);
  journal.envelope = {commit_sha: commitSha, publication_sha256: sha256(Buffer.from(contents))};
  await saveJournal(journalFile, journal);
  await log('published mutable PR envelope; immutable bundle remains unchanged');
}

async function shipOne(subject, approvedManifest, log) {
  const journalFile = path.join(subject.missionDir, 'ship.journal.json');
  const missionManifest = manifestDigest([subject.manifest]);
  let journal = await loadJournal(journalFile);
  if (journal === null) {
    journal = {
      schema_version: 1,
      mission_id: subject.manifest.mission_id,
      approved_manifest: approvedManifest,
      mission_manifest: missionManifest,
      bundle_digest: subject.manifest.bundle_digest,
    };
    await saveJournal(journalFile, journal);
  } else {
    assertJournalBinding(journal, approvedManifest, subject.manifest.bundle_digest, missionManifest);
  }
  const branch = await ensureForkAndPush(subject, journal, journalFile, log);
  await publishPreparedBundle(subject, journal, journalFile, log);
  await verifyReleasedBundle(subject, journal, journalFile, log);
  const prUrl = await openPullRequest(subject, branch, journal, journalFile, log);
  await publishPrEnvelope(subject, journal, journalFile, log);
  return {
    mission_id: subject.manifest.mission_id,
    pr_url: prUrl,
    attestation_uri: journal.ledger.attestation_uri,
    bundle_digest: subject.manifest.bundle_digest,
  };
}

export async function shipBatch(items, {approvedDigest, log = async () => {}} = {}) {
  const subjects = [];
  for (const item of items) subjects.push(await loadReadySubject(item.spec, item.missionDir));
  validateApprovedBatch(subjects.map((subject) => subject.manifest), approvedDigest);
  const results = [];
  for (const subject of subjects) {
    results.push(await shipOne(subject, approvedDigest, (message) => log(subject.manifest.mission_id, message)));
  }
  return results;
}

export function reviewDecision(value) {
  return ({APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', REVIEW_REQUIRED: 'review_required'})[value] ?? null;
}

export function stateFor(pr) {
  if (pr.mergedAt) return 'merged';
  return pr.state === 'OPEN' ? 'open' : 'closed_unmerged';
}

export function ciState(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return null;
  const conclusion = (check) => check.conclusion ?? check.state ?? null;
  if (checks.some((check) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion(check)))) return 'failure';
  if (checks.some((check) => (check.status && check.status !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(conclusion(check)))) return 'pending';
  if (checks.every((check) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion(check)))) return 'success';
  return 'neutral';
}

async function findMissionPr(mission) {
  const repo = mission.target_repo.replace(/^https:\/\/github\.com\//, '');
  const issueNumber = /\/issues\/([1-9][0-9]*)$/.exec(mission.issue_or_task)?.[1];
  const issueReference = issueNumber ? new RegExp(`(?:^|[^0-9])#${issueNumber}(?:[^0-9]|$)|issues/${issueNumber}(?:[^0-9]|$)`, 'i') : null;
  const listed = await must('list mission PRs', await run('gh', ['pr', 'list', '--repo', repo, '--author', FORK_OWNER,
    '--state', 'all', '--limit', '100', '--json',
    'number,url,state,title,body,headRefOid,baseRefName,createdAt,closedAt,mergedAt,updatedAt,reviewDecision,mergeCommit,statusCheckRollup']));
  const prs = JSON.parse(listed.stdout);
  return prs.find((pr) => pr.headRefOid === mission.patch_commit)
    ?? prs.find((pr) => pr.body?.includes(mission.mission_id) || issueReference?.test(`${pr.title ?? ''}\n${pr.body ?? ''}`))
    ?? null;
}

export function publicationFromPr(mission, pr, previous = null) {
  return {
    schema_version: 1,
    mission_id: mission.mission_id,
    state: stateFor(pr),
    pr_number: pr.number,
    pr_url: pr.url,
    pr_head_oid: pr.headRefOid,
    base_branch: pr.baseRefName,
    head_drift: pr.headRefOid !== mission.patch_commit,
    ci_state: ciState(pr.statusCheckRollup),
    merge_commit_oid: pr.mergeCommit?.oid ?? null,
    review_decision: reviewDecision(pr.reviewDecision),
    decision_url: pr.reviewDecision ? pr.url : null,
    opened_at: pr.createdAt,
    closed_at: pr.mergedAt ?? pr.closedAt,
    updated_at: pr.updatedAt,
    correction_note: mission.mission_id === 'M-015'
      ? 'Correction: compile-typescript was run; the immutable record limitation incorrectly says type-check was not run. The PR later closed without merge.'
      : null,
    attestation_uri: previous?.attestation_uri ?? mission.attestation_uri,
    bundle_digest: previous?.bundle_digest ?? mission.run_record_bundle_digest,
    release_asset_sha256: previous?.release_asset_sha256 ?? null,
  };
}

async function syncPublication(directory, {dryRun = false} = {}) {
  const missionFile = path.join(directory, 'mission.json');
  const mission = JSON.parse(await readFile(missionFile, 'utf8'));
  if (mission.variant !== 'author_contribution') return {mission: false, changed: false};
  const pr = await findMissionPr(mission);
  if (!pr) return {mission: true, changed: false};
  const file = path.join(directory, 'publication.json');
  let previous = null;
  try { previous = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const next = publicationFromPr(mission, pr, previous);
  const attention = next.state === 'open' && (next.review_decision === 'changes_requested' || next.head_drift);
  if (previous && canonical(previous) === canonical(next)) return {mission: true, changed: false, attention};
  if (!dryRun) await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
  return {mission: true, changed: true, attention};
}

export async function syncStatus({push = true} = {}) {
  const status = await must('northset-oss status', await git(NORTHSET_OSS, 'status', '--porcelain'));
  if (status.stdout.trim()) throw new Error('northset-oss must be clean before status reconciliation');
  await must('northset-oss pull', await git(NORTHSET_OSS, 'pull', '--ff-only', 'origin', 'main'));
  const entries = await readdir(path.join(NORTHSET_OSS, 'missions'), {withFileTypes: true});
  let missions = 0;
  let changed = false;
  const attention = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const result = await syncPublication(path.join(NORTHSET_OSS, 'missions', entry.name));
    if (result.mission) missions += 1;
    changed ||= result.changed;
    if (result.attention) attention.push(entry.name);
  }
  if (!changed) return {changed: false, missions, attention};
  await rebuildLedger();
  if (push) {
    await commitPublic(['missions', 'missions/index.json', 'site/index.html'], 'ledger: reconcile upstream PR status');
  }
  return {changed: true, missions, attention};
}
