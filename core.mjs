import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {appendFile, lstat, mkdtemp, readFile, readdir, readlink, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_OUTPUT_LIMIT_BYTES = 2_000_000;
export const LIVE_RECHECK_OUTPUT_LIMIT_BYTES = 10_000_000;
const KILL_GRACE_MS = 2_000;
const ACTIVE_CHILDREN = new Set();
let shuttingDown = false;

function installSignalForwarding() {
  if (installSignalForwarding.installed) return;
  installSignalForwarding.installed = true;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const child of ACTIVE_CHILDREN) signalProcessGroup(child, 'SIGTERM');
      setTimeout(() => {
        for (const child of ACTIVE_CHILDREN) signalProcessGroup(child, 'SIGKILL');
        process.exit(signal === 'SIGINT' ? 130 : 143);
      }, KILL_GRACE_MS);
    });
  }
}

export class Deadline {
  constructor(totalMs, {now = () => Date.now()} = {}) {
    if (!Number.isFinite(totalMs) || totalMs <= 0) throw new Error('deadline totalMs must be positive');
    this.totalMs = totalMs;
    this.startedAtMs = now();
    this.endsAtMs = this.startedAtMs + totalMs;
    this.now = now;
  }

  remainingMs() { return Math.max(0, this.endsAtMs - this.now()); }
  limit(phaseMs = Infinity) { return Math.max(0, Math.min(phaseMs, this.remainingMs())); }
  expired() { return this.remainingMs() <= 0; }
}

export function createDeadline(totalMs, options) { return new Deadline(totalMs, options); }

function signalProcessGroup(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

// Run a command directly (never through a shell), with a bounded process tree and output.
export function run(cmd, args, {
  cwd, env, input, timeoutMs, deadline, logPath, label,
  outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
  terminateOnOutputLimit = true,
} = {}) {
  return new Promise((resolve) => {
    const startedAtMs = Date.now();
    installSignalForwarding();
    const effectiveTimeout = deadline ? deadline.limit(timeoutMs ?? Infinity) : timeoutMs;
    if (effectiveTimeout !== undefined && effectiveTimeout <= 0) {
      resolve({code: 124, stdout: '', stderr: 'deadline exhausted before subprocess start', timedOut: true, durationMs: 0});
      return;
    }
    const child = spawn(cmd, args, {
      cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    ACTIVE_CHILDREN.add(child);
    let out = '', err = '';
    let timedOut = false;
    let outputLimitExceeded = false;
    let outputTruncated = false;
    let finished = false;
    let killTimer = null;
    const terminate = (reason) => {
      if (reason === 'timeout') timedOut = true;
      if (reason === 'output') outputLimitExceeded = true;
      signalProcessGroup(child, 'SIGTERM');
      killTimer ??= setTimeout(() => signalProcessGroup(child, 'SIGKILL'), KILL_GRACE_MS);
    };
    const timer = Number.isFinite(effectiveTimeout)
      ? setTimeout(() => terminate('timeout'), effectiveTimeout)
      : null;
    const capture = (current, data, stream) => {
      const bytes = Buffer.from(data);
      const remaining = Math.max(0, outputLimitBytes - Buffer.byteLength(current));
      let next = remaining ? current + bytes.subarray(0, remaining).toString() : current;
      if (bytes.length > remaining) {
        if (terminateOnOutputLimit && !outputLimitExceeded) {
          const diagnostic = `\n[subprocess ${stream} output limit exceeded: ${outputLimitBytes} bytes]\n`;
          if (stream === 'stderr') next = `${next.slice(0, Math.max(0, outputLimitBytes - diagnostic.length))}${diagnostic}`;
          else err += diagnostic;
        } else if (!terminateOnOutputLimit && !outputTruncated) {
          outputTruncated = true;
          const diagnostic = `\n[subprocess ${stream} output truncated at ${outputLimitBytes} bytes]\n`;
          if (stream === 'stderr') next = `${next.slice(0, Math.max(0, outputLimitBytes - diagnostic.length))}${diagnostic}`;
          else err += diagnostic;
        }
        if (terminateOnOutputLimit) terminate('output');
      }
      return next;
    };
    child.stdout.on('data', (data) => { out = capture(out, data, 'stdout'); });
    child.stderr.on('data', (data) => { err = capture(err, data, 'stderr'); });
    child.on('close', async (code) => {
      if (finished) return;
      finished = true;
      ACTIVE_CHILDREN.delete(child);
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      let logError = null;
      if (logPath) {
        const line = `\n$ ${label ?? `${cmd} ${args.join(' ')}`}\n${out}${err ? `\n[stderr]\n${err}` : ''}\n`;
        try { await appendFile(logPath, line, {mode: 0o600}); }
        catch (error) { logError = error.message; }
      }
      resolve({
        code: timedOut ? 124 : outputLimitExceeded ? 125 : (code ?? 1),
        stdout: out, stderr: err, timedOut, outputLimitExceeded, outputTruncated, logError,
        durationMs: Date.now() - startedAtMs,
      });
    });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      ACTIVE_CHILDREN.delete(child);
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        code: 127, stdout: out, stderr: `${err}\n${error.message}`,
        timedOut, outputLimitExceeded, outputTruncated,
        durationMs: Date.now() - startedAtMs,
      });
    });
    child.stdin.on('error', () => {});
    if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
    else child.stdin.end();
  });
}

export function sanitizedGitEnv(extra = {}) {
  return {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...extra};
}

export const git = (cwd, ...args) => run('git', ['-C', cwd, ...args], {env: sanitizedGitEnv()});

export async function ghJson(args, options = {}) {
  const result = await run('gh', args, options);
  if (result.code !== 0) throw new Error(`gh ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return JSON.parse(result.stdout);
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function taskIdForCandidate(candidate) {
  if (typeof candidate !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(candidate)) {
    throw new Error('task identity requires an owner/repo#123 candidate key');
  }
  const digest = createHash('sha256')
    .update(`northset-oss-task-v1\0${candidate.toLowerCase()}`)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
  return `TASK-OSS-${digest}`;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function manifestDigest(readyPacks) {
  const subjects = readyPacks.map((pack) => pack.manifest ?? pack)
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return sha256(Buffer.from(canonical(subjects), 'utf8'));
}

export function batchBoardData(manifests) {
  if (!Array.isArray(manifests) || manifests.length < 1 || manifests.length > 50) {
    throw new Error('batch board requires one to fifty ordered mission manifests');
  }
  const missions = manifests.map((manifest, index) => ({
    position: index + 1,
    mission_id: manifest.mission_id,
    repo: manifest.repo,
    issue_url: manifest.issue_url,
    pr_title: manifest.pr_title,
    patch_sha256: manifest.patch_sha256,
    pr_body_sha256: manifest.pr_body_sha256,
    pr_claim_text: manifest.pr_claim_text ?? null,
    patch_review_sha256: manifest.patch_review_sha256 ?? null,
    risk_flags: manifest.risk_flags ?? [],
    changed_file_classes: manifest.changed_file_classes ?? [],
    oracle_sha256: manifest.oracle_sha256,
    bundle_digest: manifest.bundle_digest,
  }));
  const classCounts = {};
  const riskCounts = {};
  for (const mission of missions) {
    for (const item of mission.changed_file_classes) classCounts[item.class] = (classCounts[item.class] ?? 0) + 1;
    for (const risk of mission.risk_flags) {
      const code = typeof risk === 'string' ? risk : risk.code;
      riskCounts[code] = (riskCounts[code] ?? 0) + 1;
    }
  }
  return {
    schema_version: 1,
    mission_count: manifests.length,
    changed_file_class_counts: Object.fromEntries(Object.entries(classCounts).sort()),
    risk_counts: Object.fromEntries(Object.entries(riskCounts).sort()),
    missions,
  };
}

export function batchApprovalDigest(manifests) {
  const board = batchBoardData(manifests);
  const subject = {
    schema_version: 1,
    domain: 'northset-oss-approved-batch-v1',
    ordered_mission_manifests: manifests,
    board,
  };
  return sha256(Buffer.from(canonical(subject), 'utf8'));
}

export async function directoryDigest(root) {
  const entries = [];
  async function walk(directory, prefix = '') {
    const children = (await readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const absolute = path.join(directory, child.name);
      const stats = await lstat(absolute);
      const mode = (stats.mode & 0o7777).toString(8);
      if (stats.isDirectory()) {
        entries.push({path: relative, kind: 'directory', mode});
        await walk(absolute, relative);
      } else if (stats.isSymbolicLink()) {
        entries.push({path: relative, kind: 'symlink', mode, target: await readlink(absolute)});
      } else if (stats.isFile()) {
        entries.push({path: relative, kind: 'file', mode, sha256: sha256(await readFile(absolute))});
      } else {
        throw new Error(`unsupported prepared-file type: ${relative}`);
      }
    }
  }
  await walk(root);
  return sha256(Buffer.from(canonical(entries), 'utf8'));
}

export function assertBindingChain({patch_sha256, tested_tree_oid, commit_oid, pushed_oid, pr_head_oid}) {
  if (!/^sha256:[0-9a-f]{64}$/i.test(patch_sha256 ?? '')) throw new Error('binding chain has invalid patch_sha256');
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(tested_tree_oid ?? '')) throw new Error('binding chain has invalid tested_tree_oid');
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(commit_oid ?? '')) throw new Error('binding chain has invalid commit_oid');
  if (pushed_oid !== undefined && pushed_oid !== commit_oid) {
    throw new Error(`binding mismatch: pushed_oid ${pushed_oid} != commit_oid ${commit_oid}`);
  }
  if (pr_head_oid !== undefined && pr_head_oid !== commit_oid) {
    throw new Error(`binding mismatch: pr_head_oid ${pr_head_oid} != commit_oid ${commit_oid}`);
  }
  if (pushed_oid !== undefined && pr_head_oid !== undefined && pushed_oid !== pr_head_oid) {
    throw new Error(`binding mismatch: pr_head_oid ${pr_head_oid} != pushed_oid ${pushed_oid}`);
  }
  return true;
}

export const OSS_IDENTITY = {name: 'Aysajan Eziz', email: 'aeziz@northset.ai'};

export function assertOssCommitIdentity({authorEmail, committerEmail, body}) {
  if (authorEmail !== OSS_IDENTITY.email || committerEmail !== OSS_IDENTITY.email) {
    throw new Error(
      `OSS commit identity must be ${OSS_IDENTITY.email}, got author=${authorEmail || '(none)'} committer=${committerEmail || '(none)'} — set it per-clone, never rely on the host git identity`,
    );
  }
  const signoff = `Signed-off-by: ${OSS_IDENTITY.name} <${OSS_IDENTITY.email}>`;
  if (!(body ?? '').split('\n').some((line) => line.trim() === signoff)) {
    throw new Error(`OSS commit missing DCO sign-off "${signoff}"`);
  }
}

export function receiptFooter(missionId, commitOid) {
  if (!/^M-[0-9]{3,}$/.test(missionId ?? '')) throw new Error('receipt footer requires a mission id');
  if (!/^[0-9a-f]{40}$/i.test(commitOid ?? '')) throw new Error('receipt footer requires a full commit OID');
  const receiptUrl = `https://northset-oss.github.io/verification-pilot/receipts/${missionId}/`;
  return [
    '---',
    'AI assistance was used; I reviewed and own this change.',
    '',
    `<!-- northset-receipt:${missionId}:start -->`,
    '### Verification',
    '',
    `[Northset proof-of-pass receipt ${missionId}](${receiptUrl})  `,
    'Contributor self-run; not maintainer verification.',
    `<!-- northset-receipt:${missionId}:end -->`,
  ].join('\n');
}

// Kept only as a stable marker for older callers; new PRs must use receiptFooter(id, oid).
export const RECEIPT_FOOTER = 'Contributor self-run; not maintainer verification.';

export function parseCandidate(value) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(value ?? '');
  if (!match) throw new Error(`invalid candidate ${JSON.stringify(value)}; expected owner/repo#123`);
  return {owner: match[1], repo: match[2], issue: Number(match[3])};
}

// The in-container Codex author's reasoning effort. `high` is the default workhorse setting; a
// candidate spec opts up to `xhigh`/`max` only when its complexity warrants it. Single allow-list so
// prepare fails fast on a bad value instead of passing garbage to `codex -c model_reasoning_effort`.
export const AUTHOR_EFFORTS = ['medium', 'high', 'xhigh', 'max'];
export const PROFILE_REGISTRY = JSON.parse(readFileSync(new URL('./profiles.json', import.meta.url), 'utf8'));
export const SUPPORTED_PROFILES = Object.freeze(Object.keys(PROFILE_REGISTRY.profiles));
export const QUALIFICATION_REVIEW_PROMPT_VERSIONS = Object.freeze([2, 3]);

export function normalizeLabel(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function isInvitationLabel(value) {
  const normalized = normalizeLabel(value);
  return normalized.includes('good first issue') || normalized.endsWith('help wanted');
}

function sourceEvidencePath(entry) {
  if (typeof entry !== 'string' || entry.trim() !== entry) return null;
  const match = /^([^:\r\n]+):([1-9][0-9]*)(?:-([1-9][0-9]*))?(?:\s+—\s+.+)?$/.exec(entry);
  if (!match) return null;
  const file = match[1];
  const segments = file.split('/');
  if (path.posix.isAbsolute(file) || file.includes('\\') || path.posix.normalize(file) !== file ||
      segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  if (match[3] !== undefined && Number(match[3]) < Number(match[2])) return null;
  return file;
}

export function qualificationSourceEvidencePaths(spec, {required = false} = {}) {
  const entries = spec?.qualification?.source_evidence;
  if (entries === undefined && !required) return [];
  if (!Array.isArray(entries) || (required && entries.length === 0)) {
    throw new Error('qualification.source_evidence (qualification source evidence) must be a non-empty array of normalized path:line evidence');
  }
  const paths = entries.map(sourceEvidencePath);
  if (paths.some((file) => file === null)) {
    throw new Error('qualification.source_evidence (qualification source evidence) must contain normalized relative path:line evidence');
  }
  return [...new Set(paths)];
}

function oracleCommandTargets(command, testPaths) {
  const vitestScratchPrefixes = [
    'ln -s /workspace/repo/node_modules /tmp/node_modules && cp vitest.config.ts /tmp/vitest.config.ts && ',
    'ln -s "$PWD/node_modules" /tmp/node_modules && cp vitest.config.ts /tmp/vitest.config.ts && ',
  ];
  const vitestScratchPrefix = vitestScratchPrefixes.find((prefix) => command.startsWith(prefix));
  const focusedCommand = vitestScratchPrefix ? command.slice(vitestScratchPrefix.length) : command;
  if (/[\n;&|`]/.test(focusedCommand)) throw new Error('oracle.command must be one single focused command');
  const tokens = focusedCommand.trim().split(/\s+/).map((token) => {
    if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
      return token.slice(1, -1);
    }
    return token;
  });
  const noncanonicalDirectoryControl = tokens.find((token) =>
    token === '-C' || /^-C(?:=|[^-])/.test(token) || /^--(?:dir|prefix)=/.test(token));
  if (noncanonicalDirectoryControl) {
    throw new Error(`oracle.command directory control ${noncanonicalDirectoryControl} is unsupported; use one canonical --dir PATH or --prefix PATH form`);
  }
  const directoryControlIndexes = tokens
    .map((token, index) => ['--dir', '--prefix'].includes(token) ? index : -1)
    .filter((index) => index >= 0);
  if (directoryControlIndexes.length > 1) {
    throw new Error('oracle.command may use only a single directory control flag');
  }
  const directoryIndex = directoryControlIndexes[0] ?? -1;
  const workingDirectory = directoryIndex >= 0 ? tokens[directoryIndex + 1]?.replace(/^\.\//, '').replace(/\/$/, '') : null;
  const fileNameIndex = tokens.indexOf('--file-name');
  const fileName = fileNameIndex >= 0 ? tokens[fileNameIndex + 1] : null;
  const treeSitterCommand = (tokens[0] === 'tree-sitter' && tokens[1] === 'test')
    || (tokens[0] === 'npx' && tokens[1] === 'tree-sitter' && tokens[2] === 'test');
  if (treeSitterCommand && fileName && tokens.some((token) =>
    token === '-p' || token === '--grammar-path' || /^-p(?:=|[^-])/.test(token) || token.startsWith('--grammar-path='))) {
    throw new Error('oracle.command tree-sitter --file-name shortcut cannot be combined with a grammar path');
  }
  const treeSitterFileNameTarget = typeof fileName === 'string'
    && /^[^/]+$/.test(fileName)
    && testPaths.length === 1
    && treeSitterCommand;
  return testPaths.every((testPath) => {
    if (tokens.includes(testPath) || tokens.includes(`./${testPath}`)) return true;
    if (treeSitterFileNameTarget && testPath === `test/corpus/${fileName}`) return true;
    if (!workingDirectory || workingDirectory.includes('..') || !testPath.startsWith(`${workingDirectory}/`)) return false;
    const relative = testPath.slice(workingDirectory.length + 1);
    return tokens.includes(relative) || tokens.includes(`./${relative}`);
  });
}
export function authorEffort(spec) {
  const value = spec?.executor?.reasoning_effort;
  if (value === undefined || value === null) return 'xhigh';
  if (typeof value !== 'string' || !AUTHOR_EFFORTS.includes(value)) {
    throw new Error(`executor.reasoning_effort must be one of ${AUTHOR_EFFORTS.join(', ')}, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function parseGitHubUrl(value, kind) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${kind} must be an https://github.com URL`); }
  if (url.username || url.password) throw new Error(`${kind} must not contain credentials`);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port || url.search || url.hash) {
    throw new Error(`${kind} must be an https://github.com URL`);
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  return {parts, url};
}

function same(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }

export function repositoryPolicyLocator(evidence, candidate, baseCommit) {
  if (evidence?.type !== 'repository_policy') throw new Error('evidence is not a repository policy');
  let url;
  try { url = new URL(evidence.url); } catch { throw new Error('repository-policy evidence must be a GitHub blob URL'); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' ||
      url.username || url.password || url.port || url.search) {
    throw new Error('repository-policy evidence must be a clean GitHub blob URL');
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  const policyPath = parts.slice(4).join('/');
  if (parts.length < 5 || parts[2] !== 'blob' || !same(parts[0], candidate.owner) ||
      !same(parts[1], candidate.repo) || parts[3] !== baseCommit || !policyPath ||
      path.isAbsolute(policyPath) || policyPath.split('/').includes('..')) {
    throw new Error('repository-policy evidence must identify a file in the candidate repository at the exact base commit');
  }
  if (url.hash && !/^#L[1-9][0-9]*(?:-L[1-9][0-9]*)?$/.test(url.hash)) {
    throw new Error('repository-policy evidence has an invalid line fragment');
  }
  return {owner: candidate.owner, repo: candidate.repo, commit: baseCommit, path: policyPath, url: evidence.url};
}

async function fetchRepositoryPolicy(evidence, candidate, baseCommit, gh) {
  const locator = repositoryPolicyLocator(evidence, candidate, baseCommit);
  const response = await gh(['api', `repos/${candidate.owner}/${candidate.repo}/contents/${locator.path}?ref=${baseCommit}`]);
  if (response?.encoding !== 'base64' || typeof response.content !== 'string') {
    throw new Error('repository-policy evidence did not return base64 file content');
  }
  const bytes = Buffer.from(response.content.replaceAll('\n', ''), 'base64');
  return {...locator, content_sha256: sha256(bytes), content_base64: bytes.toString('base64')};
}

export function maintainerEvidenceEndpoint(value, candidate, {allowIssue = false} = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error('maintainer evidence must be a GitHub comment or review URL'); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' ||
      url.username || url.password || url.port || url.search) {
    throw new Error('maintainer evidence must be a clean GitHub comment or review URL');
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 4 || !same(parts[0], candidate.owner) || !same(parts[1], candidate.repo) ||
      !['issues', 'pull'].includes(parts[2]) || !/^[1-9][0-9]*$/.test(parts[3])) {
    throw new Error('maintainer evidence must belong to the candidate repository');
  }
  if (allowIssue && parts[2] === 'issues' && Number(parts[3]) === candidate.issue && !url.hash) {
    return `repos/${candidate.owner}/${candidate.repo}/issues/${candidate.issue}`;
  }
  let match = /^#issuecomment-([1-9][0-9]*)$/.exec(url.hash);
  if (match) return `repos/${candidate.owner}/${candidate.repo}/issues/comments/${match[1]}`;
  match = /^#discussion_r([1-9][0-9]*)$/.exec(url.hash);
  if (match) return `repos/${candidate.owner}/${candidate.repo}/pulls/comments/${match[1]}`;
  match = /^#pullrequestreview-([1-9][0-9]*)$/.exec(url.hash);
  if (match && parts[2] === 'pull') {
    return `repos/${candidate.owner}/${candidate.repo}/pulls/${parts[3]}/reviews/${match[1]}`;
  }
  throw new Error('maintainer evidence URL must identify a comment or pull-request review');
}

async function fetchMaintainerEvidence(item, candidate, gh, options) {
  const response = await gh(['api', maintainerEvidenceEndpoint(item.url, candidate, options)]);
  const url = response?.html_url ?? response?.url;
  const association = response?.author_association ?? response?.authorAssociation;
  const timestamp = response?.created_at ?? response?.createdAt ?? response?.submitted_at ?? response?.submittedAt;
  return {
    valid: url === item.url && association === item.author_association,
    timestamp,
    user: response?.user?.login ?? response?.author?.login,
  };
}

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('mission spec must be an object');
  if (!/^M-[0-9]{3,}$/.test(spec.mission_id ?? '')) {
    throw new Error(`invalid mission_id ${JSON.stringify(spec.mission_id)}; expected M-010`);
  }
  const candidate = parseCandidate(spec.candidate);
  const target = parseGitHubUrl(spec.target_repo, 'target_repo').parts;
  if (target.length !== 2) throw new Error('target_repo must identify exactly one GitHub repository');
  target[1] = target[1].replace(/\.git$/i, '');
  if (!same(target[0], candidate.owner) || !same(target[1], candidate.repo)) {
    throw new Error('target_repo does not match candidate repository');
  }
  const issue = parseGitHubUrl(spec.issue_url, 'issue_url').parts;
  if (issue.length !== 4 || issue[2] !== 'issues' || !/^[1-9][0-9]*$/.test(issue[3])) {
    throw new Error('issue_url must have the form https://github.com/owner/repo/issues/123');
  }
  if (!same(issue[0], candidate.owner) || !same(issue[1], candidate.repo) || Number(issue[3]) !== candidate.issue) {
    throw new Error('issue_url does not match candidate issue');
  }
  if (Object.hasOwn(spec, 'code_prompt')) throw new Error('legacy code_prompt is forbidden; use the evidence-backed acceptance contract fields');
  if (![1, 2].includes(spec.schema_version)) throw new Error('schema_version must equal 1 or 2');
  const economicFields = ['task_id', 'attempt_sequence', 'work_category'];
  if (spec.schema_version === 2) {
    const expectedTaskId = taskIdForCandidate(spec.candidate);
    if (spec.task_id !== expectedTaskId) throw new Error(`task_id must match candidate identity ${expectedTaskId}`);
    if (!Number.isInteger(spec.attempt_sequence) || spec.attempt_sequence < 1) {
      throw new Error('attempt_sequence must be a positive integer');
    }
    if (!['defect_fix', 'compatibility_fix', 'developer_tooling_fix', 'documentation_fix', 'test_infrastructure_fix'].includes(spec.work_category)) {
      throw new Error('work_category must be a bounded factual OSS work category');
    }
  } else if (economicFields.some((field) => Object.hasOwn(spec, field))) {
    throw new Error('task_id, attempt_sequence, and work_category require schema_version 2');
  }
  if (typeof spec.base_branch !== 'string' || !spec.base_branch.trim()) throw new Error('base_branch is required');
  if (!/^[0-9a-f]{40}$/i.test(spec.base_commit ?? '')) throw new Error('base_commit must be a full 40-character commit SHA');
  for (const field of ['problem_statement']) {
    if (typeof spec[field] !== 'string' || !spec[field].trim()) throw new Error(`${field} is required`);
  }
  for (const field of ['acceptance_criteria', 'constraints', 'implementation_hints']) {
    if (!Array.isArray(spec[field]) || (field !== 'implementation_hints' && spec[field].length === 0) ||
      !spec[field].every((item) => typeof item === 'string' && item.trim())) {
      throw new Error(`${field} must be ${field === 'implementation_hints' ? 'an' : 'a non-empty'} array of strings`);
    }
  }
  if (!Array.isArray(spec.process_requirements) ||
      !spec.process_requirements.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error('process_requirements must be an array of non-empty strings');
  }
  if (spec.receipt?.limitations !== undefined) {
    const limitations = spec.receipt.limitations;
    const baseline = ['Does not prove code quality', 'Does not prove security'];
    if (!Array.isArray(limitations) || !limitations.every((item) => typeof item === 'string' && item.trim()) ||
        !baseline.every((item) => limitations.includes(item))) {
      throw new Error('receipt.limitations must include exact baseline entries "Does not prove code quality" and "Does not prove security"');
    }
  }
  const q = spec.qualification;
  if (!q || typeof q !== 'object') throw new Error('qualification is required');
  if (!/^sha256:[0-9a-f]{64}$/i.test(q.review_id ?? '')) throw new Error('qualification.review_id must be a sha256 digest');
  if (!QUALIFICATION_REVIEW_PROMPT_VERSIONS.includes(q.review_prompt_version)) {
    throw new Error(`qualification.review_prompt_version must be a compatible prompt version (${QUALIFICATION_REVIEW_PROMPT_VERSIONS.join(' or ')})`);
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(q.evidence_sha256 ?? '')) throw new Error('qualification.evidence_sha256 must be a sha256 digest');
  for (const field of ['reviewed_at', 'qualification_expires_at', 'issue_updated_at']) {
    if (typeof q[field] !== 'string' || !Number.isFinite(Date.parse(q[field]))) throw new Error(`qualification.${field} must be an ISO timestamp`);
  }
  if (spec.schema_version === 2) {
    qualificationSourceEvidencePaths(spec, {required: true});
    if (q.finder_run_id !== null && q.finder_run_id !== undefined && !/^[0-9a-f-]{36}$/i.test(q.finder_run_id)) {
      throw new Error('qualification.finder_run_id must be a UUID or null');
    }
    if (q.candidate_rank !== null && q.candidate_rank !== undefined && (!Number.isInteger(q.candidate_rank) || q.candidate_rank < 1)) {
      throw new Error('qualification.candidate_rank must be a positive integer or null');
    }
    for (const field of ['finder_elapsed_ms', 'review_duration_ms']) {
      if (q[field] !== null && q[field] !== undefined && (!Number.isInteger(q[field]) || q[field] < 0)) {
        throw new Error(`qualification.${field} must be a non-negative integer or null`);
      }
    }
    for (const field of ['requested_model', 'reasoning_effort', 'service_tier']) {
      if (typeof q[field] !== 'string' || !q[field].trim()) throw new Error(`qualification.${field} is required for schema_version 2`);
    }
    if (q.actual_model !== null && q.actual_model !== undefined && (typeof q.actual_model !== 'string' || !q.actual_model.trim())) {
      throw new Error('qualification.actual_model must be a non-blank string or null');
    }
  }
  const qualificationLifetime = Date.parse(q.qualification_expires_at) - Date.parse(q.reviewed_at);
  if (qualificationLifetime <= 0 || qualificationLifetime > 2 * 60 * 60 * 1000) {
    throw new Error('qualification TTL must be positive and at most two hours');
  }
  if (!q.invitation_evidence || !['label', 'assignment', 'maintainer_comment', 'repository_policy'].includes(q.invitation_evidence.type) ||
    typeof q.invitation_evidence.url !== 'string' || !Number.isFinite(Date.parse(q.invitation_evidence.observed_at))) {
    throw new Error('qualification.invitation_evidence is incomplete');
  }
  if (typeof q.pre_author_notice_required !== 'boolean') {
    throw new Error('qualification.pre_author_notice_required must be boolean');
  }
  if (q.pre_author_notice_required) {
    if (!q.pre_author_notice || typeof q.pre_author_notice.url !== 'string' ||
        !Number.isFinite(Date.parse(q.pre_author_notice.observed_at))) {
      throw new Error('qualification.pre_author_notice is required before authoring');
    }
    const endpoint = maintainerEvidenceEndpoint(q.pre_author_notice.url, candidate);
    if (!endpoint.includes('/issues/comments/')) throw new Error('qualification.pre_author_notice must be an issue comment');
  } else if (q.pre_author_notice !== null) {
    throw new Error('qualification.pre_author_notice must be null when no notice is required');
  }
  if (q.invitation_evidence.type === 'repository_policy') {
    repositoryPolicyLocator(q.invitation_evidence, candidate, spec.base_commit);
    if (!/^sha256:[0-9a-f]{64}$/i.test(q.invitation_evidence.content_sha256 ?? '')) {
      throw new Error('qualification.invitation_evidence.content_sha256 is required for repository policy evidence');
    }
  }
  if (q.invitation_evidence.type === 'label' &&
      (q.invitation_evidence.label !== undefined || q.invitation_evidence.repo_policy_sha256 !== undefined)) {
    if (typeof q.invitation_evidence.label !== 'string' || !q.invitation_evidence.label.trim() ||
        !/^sha256:[0-9a-f]{64}$/i.test(q.invitation_evidence.repo_policy_sha256 ?? '')) {
      throw new Error('custom invitation label requires its exact label and repository-policy digest');
    }
    const snapshot = spec.receipt?.repo_policy_snapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
        sha256(Buffer.from(canonical(snapshot))) !== q.invitation_evidence.repo_policy_sha256) {
      throw new Error('custom invitation label repository-policy snapshot does not match its digest');
    }
  }
  const contract = q.acceptance_contract;
  if (!contract || typeof contract.problem !== 'string' || !contract.problem.trim() ||
    !Array.isArray(contract.expected_behavior) || contract.expected_behavior.length === 0 ||
    !Array.isArray(contract.non_goals) || !Array.isArray(contract.design_evidence) || contract.design_evidence.length === 0 ||
    contract.design_evidence.length > 4) {
    throw new Error('qualification.acceptance_contract is incomplete');
  }
  if (!contract.design_evidence.every((item) => item && typeof item.url === 'string' &&
    ['OWNER', 'MEMBER', 'COLLABORATOR', 'REPOSITORY_POLICY'].includes(item.author_association) &&
    typeof item.summary === 'string' && item.summary.trim() &&
    (item.author_association !== 'REPOSITORY_POLICY' || /^sha256:[0-9a-f]{64}$/i.test(item.content_sha256 ?? '')))) {
    throw new Error('qualification.acceptance_contract.design_evidence must be maintainer-backed');
  }
  for (const item of contract.design_evidence) {
    if (item.author_association === 'REPOSITORY_POLICY') {
      repositoryPolicyLocator({...item, type: 'repository_policy'}, candidate, spec.base_commit);
    } else maintainerEvidenceEndpoint(item.url, candidate, {allowIssue: true});
  }
  if (!Array.isArray(q.related_prs) || q.related_prs.length > 12 || q.related_prs.some((item) => {
    if (!item || typeof item.url !== 'string' || !['OPEN', 'CLOSED', 'MERGED'].includes(item.state) ||
      !['overlap', 'not_related'].includes(item.relationship) || typeof item.disposition !== 'string') return true;
    if (item.relationship !== 'overlap') return false;
    return item.state !== 'CLOSED' || item.blocking !== false || !item.reopened_by ||
      !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(item.reopened_by.author_association) ||
      typeof item.reopened_by.url !== 'string' || typeof item.reopened_by.summary !== 'string';
  })) {
    throw new Error('qualification.related_prs must clear every overlapping historical attempt');
  }
  for (const item of q.related_prs) {
    if (item.reopened_by) maintainerEvidenceEndpoint(item.reopened_by.url, candidate);
  }
  if (!spec.oracle || spec.oracle.kind !== 'regression_test' || !Array.isArray(spec.oracle.test_paths) ||
    spec.oracle.test_paths.length === 0 || !spec.oracle.test_paths.every((item) => typeof item === 'string' && item.trim() && !path.isAbsolute(item) && !item.includes('..')) ||
    typeof spec.oracle.command !== 'string' || !spec.oracle.command.trim() ||
    spec.oracle.base_expected !== 'nonzero' || !Number.isInteger(spec.oracle.base_exit_code) || spec.oracle.base_exit_code === 0 ||
    typeof spec.oracle.base_failure_contains !== 'string' || !spec.oracle.base_failure_contains.trim() || spec.oracle.base_failure_contains.length > 500 ||
    spec.oracle.patched_expected !== 'zero') {
    throw new Error('oracle must define a regression-test red-to-green contract');
  }
  if (spec.oracle.setup_commands !== undefined) {
    throw new Error('oracle.setup_commands are forbidden in the fast lane; checks must run on the committed tree');
  }
  if (!oracleCommandTargets(spec.oracle.command, spec.oracle.test_paths)) {
    throw new Error('oracle.command must name every oracle.test_paths entry so base red is attributable to the added regression');
  }
  if (!spec.pr || typeof spec.pr.title !== 'string' || !spec.pr.title.trim() || typeof spec.pr.summary !== 'string' || !spec.pr.summary.trim()) {
    throw new Error('pr.title and pr.summary are required');
  }
  if (spec.pr.body_template !== undefined) {
    if (typeof spec.pr.body_template !== 'string' || !spec.pr.body_template.includes('{{RECEIPT_FOOTER}}')) {
      throw new Error('pr.body_template must be a string containing {{RECEIPT_FOOTER}}');
    }
    const unknown = [...spec.pr.body_template.matchAll(/\{\{([A-Z_]+)\}\}/g)]
      .map((match) => match[1]).filter((name) => !['SUMMARY', 'ISSUE_NUMBER', 'CHECKS', 'RECEIPT_FOOTER'].includes(name));
    if (unknown.length) throw new Error(`pr.body_template has unknown placeholder(s): ${unknown.join(', ')}`);
  }
  if (!spec.executor || typeof spec.executor !== 'object') throw new Error('executor config is required');
  for (const key of ['install_commands', 'commands']) {
    if (!Array.isArray(spec.executor[key]) || !spec.executor[key].every((item) => typeof item === 'string' && item.trim())) {
      throw new Error(`executor.${key} must be an array of non-empty strings`);
    }
  }
  if (typeof spec.executor.image !== 'string' || !spec.executor.image.trim()) {
    throw new Error('executor.image is required (the container base image the author + verifier run in)');
  }
  if (!SUPPORTED_PROFILES.includes(spec.executor.profile)) {
    throw new Error(`executor.profile must be one of ${SUPPORTED_PROFILES.join(', ')}`);
  }
  const registeredProfile = PROFILE_REGISTRY.profiles[spec.executor.profile];
  if (spec.executor.profile !== PROFILE_REGISTRY.default_profile) {
    if (spec.executor.image !== registeredProfile.image || spec.executor.profile_status !== registeredProfile.status) {
      throw new Error(`executor ${spec.executor.profile} profile must explicitly use registry image ${registeredProfile.image} with status ${registeredProfile.status}`);
    }
    if (registeredProfile.production_proven !== false) {
      throw new Error(`executor ${spec.executor.profile} profile registry must not overstate production proof`);
    }
    if (spec.executor.profile_production_proven !== undefined &&
        spec.executor.profile_production_proven !== false) {
      throw new Error(`executor ${spec.executor.profile} pilot profile must not claim production proof`);
    }
  }
  if (spec.authoring_mode !== undefined && !['test_only_then_fix', 'direct_fix'].includes(spec.authoring_mode)) {
    throw new Error('authoring_mode must be test_only_then_fix or direct_fix');
  }
  if (spec.allow_modified_existing_tests !== undefined && typeof spec.allow_modified_existing_tests !== 'boolean') {
    throw new Error('allow_modified_existing_tests must be boolean when present');
  }
  if (spec.allow_nonproduction_paths !== undefined) {
    if (!Array.isArray(spec.allow_nonproduction_paths) || spec.allow_nonproduction_paths.length > 2 ||
        !spec.allow_nonproduction_paths.every((item) => typeof item === 'string' && item.trim() &&
          item === path.posix.normalize(item) && !path.posix.isAbsolute(item) && !item.startsWith('../')) ||
        new Set(spec.allow_nonproduction_paths).size !== spec.allow_nonproduction_paths.length) {
      throw new Error('allow_nonproduction_paths must contain at most two unique normalized relative paths');
    }
  }
  if (!spec.executor.commands.includes(spec.oracle.command)) throw new Error('oracle.command must be included in executor.commands');
  authorEffort(spec); // validates the optional executor.reasoning_effort override
  return spec;
}

export function validateSpecs(specs) {
  const ids = new Set();
  const candidates = new Set();
  for (const spec of specs) {
    validateSpec(spec);
    if (ids.has(spec.mission_id)) throw new Error(`duplicate mission_id ${spec.mission_id}`);
    if (candidates.has(spec.candidate.toLowerCase())) throw new Error(`duplicate candidate ${spec.candidate}`);
    ids.add(spec.mission_id);
    candidates.add(spec.candidate.toLowerCase());
  }
  return specs;
}

export function timelineApiArgs(owner, repo, num) {
  return [
    'api', `repos/${owner}/${repo}/issues/${num}/timeline?per_page=100`, '--paginate', '--slurp',
  ];
}

export function timelineCrossReferences(pages) {
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('unexpected paginated timeline response');
  return pages.flat()
    .filter((item) => item?.event === 'cross-referenced' && item?.source?.issue)
    .map((item) => ({
      source: item.source.issue.html_url,
      state: item.source.issue.state,
      title: item.source.issue.title,
      is_pr: item.source.issue.pull_request != null,
      created_at: item.created_at ?? null,
    }));
}

async function loadRepoPolicy() {
  try {
    return JSON.parse(await readFile(new URL('./repo-policy.json', import.meta.url), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {cooldowns: {}};
    throw error;
  }
}

function repositoryPolicyEntry(policy, repository) {
  return Object.entries(policy?.repositories ?? {})
    .find(([key]) => key.toLowerCase() === repository.toLowerCase())?.[1] ?? {};
}

function approvedCustomInvitationLabels(entry) {
  return new Set([
    ...(entry.invitation_labels ?? []),
    ...Object.entries(entry.invitation_label_map ?? {})
      .filter(([, enabled]) => enabled === true)
      .map(([label]) => label),
  ].map(normalizeLabel));
}

function semanticWords(value) {
  const stop = new Set(['about', 'after', 'before', 'could', 'from', 'have', 'into', 'issue', 'should', 'that', 'their', 'there', 'these', 'this', 'using', 'when', 'where', 'with']);
  return [...new Set(String(value ?? '').toLowerCase().match(/[a-z0-9_]{4,}/g) ?? [])].filter((word) => !stop.has(word));
}

export function possibleOverlappingPrs(prs, spec) {
  const issue = parseCandidate(spec.candidate).issue;
  const issueRef = new RegExp(`(?:^|[^0-9])#${issue}(?:[^0-9]|$)|issues/${issue}(?:[^0-9]|$)`, 'i');
  const wanted = semanticWords(spec.problem_statement);
  return prs.filter((pr) => {
    const text = `${pr.title ?? ''}\n${pr.body ?? ''}`;
    if (text.includes(spec.issue_url) || issueRef.test(text)) return true;
    const available = new Set(semanticWords(pr.title));
    const overlap = wanted.filter((word) => available.has(word)).length;
    return wanted.length >= 4 && overlap >= 3 && overlap / wanted.length >= 0.4;
  });
}

export async function recheck(spec, log, options = {}) {
  const mode = options.mode ?? 'prepare';
  if (!['prepare', 'pre-public', 'pre-pr'].includes(mode)) throw new Error(`unknown recheck mode ${mode}`);
  const now = options.now ?? (() => new Date());
  const gh = options.gh ?? ((args) => ghJson(args, {
    deadline: options.deadline,
    timeoutMs: 60_000,
    outputLimitBytes: LIVE_RECHECK_OUTPUT_LIMIT_BYTES,
  }));
  const {owner, repo, issue: num} = parseCandidate(spec.candidate);
  const repositoryKey = `${owner}/${repo}`;
  const policy = options.repoPolicy ?? await loadRepoPolicy();
  const policyEntry = repositoryPolicyEntry(policy, repositoryKey);
  let repoData;
  try {
    repoData = await gh(['api', `repos/${owner}/${repo}`,
      '--jq', '{default_branch,archived,fork,html_url}']);
  } catch (error) {
    await log(`recheck: repository REST metadata failed; retrying through GitHub GraphQL — ${error.message}`);
    repoData = await gh([
      'api', 'graphql',
      '-f', 'query=query($owner:String!, $name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name target{... on Commit{oid}}} isArchived isFork url}}',
      '-F', `owner=${owner}`, '-F', `name=${repo}`,
      '--jq', '.data.repository | {default_branch:.defaultBranchRef.name,default_head:.defaultBranchRef.target.oid,archived:.isArchived,fork:.isFork,html_url:.url}',
    ]);
  }
  const issue = await gh(['api', `repos/${owner}/${repo}/issues/${num}`,
    '--jq', '{number,state,title,html_url,assignees:[.assignees[].login],labels:[.labels[].name],created_at,updated_at,body,author_association,user:.user.login}']);
  let comments;
  try {
    const commentPages = await gh(['api', `repos/${owner}/${repo}/issues/${num}/comments?per_page=100`, '--paginate', '--slurp']);
    comments = Array.isArray(commentPages) ? commentPages.flat() : [];
  } catch (error) {
    await log(`recheck: issue comments REST check failed; retrying through GitHub GraphQL — ${error.message}`);
    const response = await gh([
      'api', 'graphql',
      '-f', 'query=query($owner:String!, $name:String!, $number:Int!){repository(owner:$owner,name:$name){issue(number:$number){comments(last:100){nodes{url authorAssociation createdAt author{login __typename}} pageInfo{hasPreviousPage}}}}}',
      '-F', `owner=${owner}`, '-F', `name=${repo}`, '-F', `number=${num}`,
      '--jq', '{comments:[.data.repository.issue.comments.nodes[]|{html_url:.url,author_association:.authorAssociation,created_at:.createdAt,user:{login:(.author.login//""),type:(.author.__typename//"")}}],truncated:.data.repository.issue.comments.pageInfo.hasPreviousPage}',
    ]);
    if (response?.truncated || !Array.isArray(response?.comments)) throw new Error('issue comments GraphQL fallback was incomplete');
    comments = response.comments;
  }
  const defaultRef = mode === 'pre-pr' ? null
    : repoData.default_head ? null : await gh(['api', `repos/${owner}/${repo}/git/ref/heads/${repoData.default_branch}`]);
  const defaultHead = repoData.default_head ?? defaultRef?.object?.sha ?? null;
  const allPrs = await gh(['pr', 'list', '--repo', `${owner}/${repo}`, '--state', 'all', '--limit', '500',
    '--json', 'number,title,body,url,state,headRefName,author,createdAt,updatedAt,closedAt,mergedAt']);
  const openPrs = allPrs.filter((pr) => pr.state === 'OPEN');
  const northsetOpen = openPrs.filter((pr) => pr.author?.login === 'AysajanE');
  let timeline;
  try {
    timeline = timelineCrossReferences(await gh(timelineApiArgs(owner, repo, num)));
  } catch (error) {
    await log(`recheck: timeline REST check failed; retrying through GitHub GraphQL — ${error.message}`);
    try {
      const response = await gh([
        'api', 'graphql',
        '-f', 'query=query($owner:String!, $name:String!, $number:Int!){repository(owner:$owner,name:$name){issue(number:$number){timelineItems(last:100,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{... on CrossReferencedEvent{createdAt source{__typename ... on PullRequest{url state title} ... on Issue{url state title}}}} pageInfo{hasPreviousPage}}}}}',
        '-F', `owner=${owner}`, '-F', `name=${repo}`, '-F', `number=${num}`,
        '--jq', '{timeline:[.data.repository.issue.timelineItems.nodes[]|select(.source!=null)|{source:.source.url,state:(.source.state|ascii_downcase),title:.source.title,is_pr:(.source.__typename=="PullRequest"),created_at:.createdAt}],truncated:.data.repository.issue.timelineItems.pageInfo.hasPreviousPage}',
      ]);
      if (response?.truncated || !Array.isArray(response?.timeline)) throw new Error('timeline GraphQL fallback was incomplete');
      timeline = response.timeline;
    } catch (fallbackError) {
      await log(`recheck: timeline check FAILED — ${fallbackError.message} (fail-closed → FAILED)`);
      throw new Error(`timeline recheck failed (fail-closed): ${fallbackError.message}`);
    }
  }
  const reviewedAt = Date.parse(spec.qualification.reviewed_at);
  const cleared = new Set(spec.qualification.related_prs.filter((item) => item.blocking === false).map((item) => item.url));
  const competingPRs = timeline.filter((item) => item.is_pr && (String(item.state).toLowerCase() === 'open' ||
    !cleared.has(item.source) || (item.created_at && Date.parse(item.created_at) > reviewedAt)));
  const semanticPRs = possibleOverlappingPrs(allPrs, spec).filter((pr) => pr.author?.login !== 'AysajanE');
  const related = new Map(spec.qualification.related_prs.map((item) => [item.url, item]));
  const reopeningChecks = new Map();
  if (mode !== 'pre-pr') {
    for (const reviewed of spec.qualification.related_prs) {
      if (!reviewed.reopened_by) continue;
      const evidence = await fetchMaintainerEvidence(reviewed.reopened_by, {owner, repo}, gh);
      const livePr = allPrs.find((pr) => pr.url === reviewed.url);
      reopeningChecks.set(reviewed.url, evidence.valid && Boolean(evidence.timestamp) && Boolean(livePr?.closedAt) &&
        Date.parse(evidence.timestamp) > Date.parse(livePr.closedAt));
    }
  }
  const blockingSemantic = semanticPRs.filter((pr) => {
    if (pr.state === 'OPEN' || pr.state === 'MERGED') return true;
    const reviewed = related.get(pr.url);
    return !(reviewed?.state === 'CLOSED' && reviewed.relationship === 'overlap' && reviewed.blocking === false &&
      reviewed.reopened_by && ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(reviewed.reopened_by.author_association) &&
      reopeningChecks.get(reviewed.url) === true);
  });
  const invitation = spec.qualification.invitation_evidence;
  let invitationPolicy = null;
  if (invitation.type === 'repository_policy') {
    invitationPolicy = await fetchRepositoryPolicy(invitation, {owner, repo}, spec.base_commit, gh);
  }
  const customLabelBound = invitation.type === 'label' &&
    typeof invitation.label === 'string' && /^sha256:[0-9a-f]{64}$/i.test(invitation.repo_policy_sha256 ?? '');
  const customLabelStillPresent = customLabelBound &&
    sha256(Buffer.from(canonical(spec.receipt?.repo_policy_snapshot ?? null))) === invitation.repo_policy_sha256 &&
    sha256(Buffer.from(canonical(policy))) === invitation.repo_policy_sha256 &&
    approvedCustomInvitationLabels(policyEntry).has(normalizeLabel(invitation.label)) &&
    issue.labels.includes(invitation.label);
  const invitationStillPresent = invitation.type === 'label'
    ? (customLabelBound ? customLabelStillPresent : issue.labels.some(isInvitationLabel))
    : invitation.type === 'assignment'
      ? issue.assignees.includes('AysajanE')
      : invitation.type === 'maintainer_comment'
        ? comments.some((comment) => comment.html_url === invitation.url &&
          ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.author_association))
        : invitationPolicy?.content_sha256 === invitation.content_sha256;
  const designPolicies = new Map();
  let designEvidenceStillPresent = true;
  if (mode !== 'pre-pr') {
    for (const item of spec.qualification.acceptance_contract.design_evidence) {
      if (item.author_association !== 'REPOSITORY_POLICY') continue;
      const fetched = await fetchRepositoryPolicy({...item, type: 'repository_policy'}, {owner, repo}, spec.base_commit, gh);
      designPolicies.set(item.url, fetched);
    }
    designEvidenceStillPresent = (await Promise.all(spec.qualification.acceptance_contract.design_evidence.map(async (item) => {
      if (item.author_association === 'REPOSITORY_POLICY') {
        return designPolicies.get(item.url)?.content_sha256 === item.content_sha256;
      }
      return (await fetchMaintainerEvidence(item, {owner, repo, issue: num}, gh, {allowIssue: true})).valid;
    }))).every(Boolean);
  }
  let preAuthorNoticeStillPresent = true;
  let preAuthorNotice = null;
  if (spec.qualification.pre_author_notice_required) {
    const evidence = spec.qualification.pre_author_notice;
    const response = await gh(['api', maintainerEvidenceEndpoint(evidence.url, {owner, repo})]);
    preAuthorNotice = {
      url: response?.html_url ?? response?.url,
      user: response?.user?.login ?? response?.author?.login,
      created_at: response?.created_at ?? response?.createdAt,
    };
    preAuthorNoticeStillPresent = preAuthorNotice.url === evidence.url && preAuthorNotice.user === 'AysajanE';
  }
  const fetchedAt = now().toISOString().replace(/\.\d+Z$/, 'Z');
  const snapshot = {fetched_at: fetchedAt, issue, comments, timeline_cross_references: timeline,
    invitation_policy: invitationPolicy,
    design_policies: [...designPolicies.values()],
    pre_author_notice: preAuthorNotice,
    repository: repoData, default_branch_head: defaultHead, pull_requests_reviewed: allPrs};
  const reasons = [];
  if (issue.state !== 'open') reasons.push(`issue is ${issue.state}`);
  if (issue.assignees.some((login) => login !== 'AysajanE')) reasons.push(`assigned to ${issue.assignees.join(', ')}`);
  if (repoData.archived || repoData.fork) reasons.push('repository is archived or a fork');
  if (repoData.default_branch !== spec.base_branch) reasons.push(`default branch changed to ${repoData.default_branch}`);
  if (mode === 'prepare' && defaultHead !== spec.base_commit) reasons.push(`reviewed base is stale; default branch head is ${defaultHead}`);
  if (mode === 'prepare' && Date.parse(spec.qualification.qualification_expires_at) <= now().getTime()) {
    reasons.push(`qualification expired at ${spec.qualification.qualification_expires_at}`);
  }
  if (mode === 'pre-public' && defaultHead && defaultHead !== spec.base_commit) {
    const ancestryCheck = options.ancestryCheck ?? (async () => {
      const comparison = await gh(['api', `repos/${owner}/${repo}/compare/${spec.base_commit}...${defaultHead}`]);
      return ['ahead', 'identical'].includes(comparison?.status) && comparison?.merge_base_commit?.sha === spec.base_commit;
    });
    const mergeabilityCheck = options.mergeabilityCheck ?? (async () => {
      if (!options.authorRepo || !options.commitOid) throw new Error('pre-public mergeability requires the prepared author repository and commit');
      const fetched = await run('git', ['-C', options.authorRepo, 'fetch', '--no-tags', 'origin', defaultHead], {
        env: sanitizedGitEnv(), deadline: options.deadline, timeoutMs: 60_000,
      });
      if (fetched.code !== 0) return false;
      const merged = await run('git', ['-C', options.authorRepo, 'merge-tree', '--write-tree', defaultHead, options.commitOid], {
        env: sanitizedGitEnv(), deadline: options.deadline, timeoutMs: 60_000,
      });
      return merged.code === 0;
    });
    if (!await ancestryCheck(spec.base_commit, defaultHead)) reasons.push('approved base is no longer an ancestor of the default branch');
    else if (!await mergeabilityCheck(defaultHead, options.commitOid)) reasons.push('reviewed commit no longer merges cleanly with the default branch');
  }
  const newExternalComments = comments.filter((comment) => {
    const created = Date.parse(comment.created_at ?? comment.createdAt ?? '');
    const login = comment.user?.login ?? comment.author?.login ?? '';
    const type = comment.user?.type ?? comment.author?.type ?? '';
    return Number.isFinite(created) && created > reviewedAt && login !== 'AysajanE' && type !== 'Bot' && !/\[bot\]$/i.test(login);
  });
  if (newExternalComments.length) reasons.push(`new non-bot external comment after qualification: ${newExternalComments[0].html_url ?? newExternalComments[0].url ?? 'unknown URL'}`);
  if (!invitationStillPresent) reasons.push('contribution invitation is no longer present');
  if (!designEvidenceStillPresent) reasons.push('maintainer design evidence is no longer present');
  if (!preAuthorNoticeStillPresent) reasons.push('required pre-author notice is no longer present');
  if (competingPRs.length) reasons.push(`competing PR(s): ${competingPRs.map((pr) => `${pr.title} [${pr.state}]`).join('; ')}`);
  if (blockingSemantic.length) reasons.push(`blocking related PR(s): ${blockingSemantic.map((pr) => `${pr.url} [${pr.state}]`).join(', ')}`);
  const maxOpenPrs = policyEntry.max_open_prs ?? policy.defaults?.max_open_prs ?? 1;
  const dailyPrCap = policyEntry.daily_pr_cap ?? policy.defaults?.daily_pr_cap ?? 1;
  const today = now().toISOString().slice(0, 10);
  const northsetToday = allPrs.filter((pr) => pr.author?.login === 'AysajanE' && String(pr.createdAt ?? '').slice(0, 10) === today);
  if (northsetOpen.length >= maxOpenPrs) reasons.push(`Northset already has an open PR or reached the open PR cap for ${owner}/${repo} (${northsetOpen.length}/${maxOpenPrs})`);
  if (northsetToday.length >= dailyPrCap) reasons.push(`Northset daily PR cap reached for ${owner}/${repo} (${northsetToday.length}/${dailyPrCap})`);
  const cooldown = Object.entries(policy.cooldowns ?? {}).find(([key]) => key.toLowerCase() === repositoryKey.toLowerCase())?.[1];
  if (cooldown) reasons.push(`repository cooldown: ${cooldown.reason}`);
  await log(`recheck(${mode}): state=${issue.state} invitation=${invitationStillPresent ? 'present' : 'missing'} assignees=${issue.assignees.join(',') || 'none'} commentsAfterQualification=${newExternalComments.length} crossrefs=${timeline.length} competingPRs=${competingPRs.length} relatedPRs=${blockingSemantic.length} northsetOpen=${northsetOpen.length}/${maxOpenPrs} northsetToday=${northsetToday.length}/${dailyPrCap}`);
  return {mode, snapshot, clean: reasons.length === 0, reasons};
}

export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, lane));
  return results;
}

function checkedPrBody(body, missionId) {
  const canonicalReceipt = `https://northset-oss.github.io/verification-pilot/receipts/${missionId}/`;
  const ledgerRoot = 'https://northset-oss.github.io/verification-pilot';
  if (body.split(canonicalReceipt).length - 1 !== 1) {
    throw new Error(`${missionId} canonical receipt URL must appear exactly once in the PR body`);
  }
  if (body.includes(`${ledgerRoot}/#${missionId}`) || body.includes(`${ledgerRoot}#${missionId}`)) {
    throw new Error(`${missionId} PR body contains a legacy receipt URL`);
  }
  for (const marker of [`<!-- northset-receipt:${missionId}:start -->`, `<!-- northset-receipt:${missionId}:end -->`]) {
    if (body.split(marker).length - 1 !== 1) throw new Error(`${missionId} PR body must contain one marked receipt block`);
  }
  if (body.split(ledgerRoot).length - 1 !== 1) {
    throw new Error(`${missionId} PR body must contain only one Northset ledger link`);
  }
  return `${body.trimEnd()}\n`;
}

export function prBody(spec, patchInfo) {
  const num = parseCandidate(spec.candidate).issue;
  const files = (patchInfo.changedFiles ?? []).map((file) => `- \`${file}\``).join('\n') || '- (see fix.patch)';
  const checks = spec.executor.commands.map((command) => `- \`${command}\` — passed in a network-isolated container.`).join('\n');
  if (spec.pr.body_template) {
    const replacements = {
      SUMMARY: spec.pr.summary,
      ISSUE_NUMBER: String(num),
      CHECKS: checks,
      RECEIPT_FOOTER: receiptFooter(spec.mission_id, patchInfo.commitOid),
    };
    const rendered = spec.pr.body_template.replace(/\{\{([A-Z_]+)\}\}/g, (_, name) => replacements[name]);
    if (/\{\{[A-Z_]+\}\}/.test(rendered)) throw new Error('PR body template has an unresolved placeholder');
    return checkedPrBody(rendered, spec.mission_id);
  }
  return checkedPrBody([
    `## Summary`,
    ``,
    spec.pr.summary,
    ``,
    `## Change`,
    ``,
    files,
    ``,
    `### Checks`,
    checks,
    ``,
    `Fixes #${num}`,
    ``,
    receiptFooter(spec.mission_id, patchInfo.commitOid),
    ``,
  ].join('\n'), spec.mission_id);
}

export async function assertPatchCommitBinding(repoDir, baseCommit, commitOid, patchFile, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-patch-binding-'));
  const index = path.join(root, 'index');
  const env = {...process.env, GIT_INDEX_FILE: index, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'};
  try {
    let result = await run('git', ['-C', repoDir, 'read-tree', baseCommit], {env, ...options, timeoutMs: options.timeoutMs ?? 60_000});
    if (result.code !== 0) throw new Error(`cannot read base tree: ${result.stderr.trim()}`);
    result = await run('git', ['-C', repoDir, 'apply', '--cached', '--binary', patchFile], {env, ...options, timeoutMs: options.timeoutMs ?? 60_000});
    if (result.code !== 0) throw new Error(`canonical patch does not apply to base: ${result.stderr.trim()}`);
    const actual = (await run('git', ['-C', repoDir, 'write-tree'], {env, ...options, timeoutMs: options.timeoutMs ?? 60_000})).stdout.trim();
    const expected = (await run('git', ['-C', repoDir, 'rev-parse', `${commitOid}^{tree}`], {env, ...options, timeoutMs: options.timeoutMs ?? 60_000})).stdout.trim();
    if (!actual || actual !== expected) throw new Error(`patch-to-commit tree mismatch: ${actual || '(none)'} != ${expected || '(none)'}`);
    return expected;
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}
