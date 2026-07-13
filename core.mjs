import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {appendFile, lstat, mkdtemp, readFile, readdir, readlink, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Run a command directly (never through a shell) and resolve its captured result.
export function run(cmd, args, {cwd, env, input, timeoutMs, logPath, label} = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '', err = '';
    const timer = timeoutMs ? setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs) : null;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', async (code) => {
      if (timer) clearTimeout(timer);
      if (logPath) {
        const line = `\n$ ${label ?? `${cmd} ${args.join(' ')}`}\n${out}${err ? `\n[stderr]\n${err}` : ''}\n`;
        await appendFile(logPath, line, {mode: 0o600});
      }
      resolve({code, stdout: out, stderr: err});
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({code: 127, stdout: out, stderr: `${err}\n${error.message}`});
    });
    if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
  });
}

export const git = (cwd, ...args) => run('git', ['-C', cwd, ...args]);

export async function ghJson(args) {
  const result = await run('gh', args);
  if (result.code !== 0) throw new Error(`gh ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return JSON.parse(result.stdout);
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
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
  return [
    '---',
    'AI assistance was used; I reviewed and own this change.',
    '',
    `Northset self-run record for commit \`${commitOid.slice(0, 12)}\`: [${missionId} receipt](https://northset-oss.github.io/verification-pilot/#${missionId}).`,
    'It records the declared checks and published bundle provenance.',
    'Contributor self-run; not maintainer verification.',
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
export const SUPPORTED_PROFILES = ['node'];

function oracleCommandTargets(command, testPaths) {
  if (/[\n;&|`]/.test(command)) throw new Error('oracle.command must be one single focused command');
  const tokens = command.trim().split(/\s+/).map((token) => {
    if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
      return token.slice(1, -1);
    }
    return token;
  });
  return testPaths.every((testPath) => tokens.includes(testPath) || tokens.includes(`./${testPath}`));
}
export function authorEffort(spec) {
  const value = spec?.executor?.reasoning_effort;
  if (value === undefined || value === null) return 'high';
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
  if (spec.schema_version !== 1) throw new Error('schema_version must equal 1');
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
  const q = spec.qualification;
  if (!q || typeof q !== 'object') throw new Error('qualification is required');
  for (const field of ['reviewed_at', 'issue_updated_at']) {
    if (typeof q[field] !== 'string' || !Number.isFinite(Date.parse(q[field]))) throw new Error(`qualification.${field} must be an ISO timestamp`);
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
  const contract = q.acceptance_contract;
  if (!contract || typeof contract.problem !== 'string' || !contract.problem.trim() ||
    !Array.isArray(contract.expected_behavior) || contract.expected_behavior.length === 0 ||
    !Array.isArray(contract.non_goals) || !Array.isArray(contract.design_evidence) || contract.design_evidence.length === 0) {
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
  if (!Array.isArray(q.related_prs) || q.related_prs.some((item) => {
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
  if (spec.oracle.setup_commands !== undefined &&
    (!Array.isArray(spec.oracle.setup_commands) || spec.oracle.setup_commands.length > 3 ||
      !spec.oracle.setup_commands.every((item) => typeof item === 'string' && item.trim() && item.length <= 500 && !/[\n;&|`]/.test(item)))) {
    throw new Error('oracle.setup_commands must contain at most three single deterministic commands');
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

export async function recheck(spec, log, {gh = ghJson, now = () => new Date()} = {}) {
  const {owner, repo, issue: num} = parseCandidate(spec.candidate);
  const repoData = await gh(['api', `repos/${owner}/${repo}`,
    '--jq', '{default_branch,archived,fork,html_url}']);
  const issue = await gh(['api', `repos/${owner}/${repo}/issues/${num}`,
    '--jq', '{number,state,title,html_url,assignees:[.assignees[].login],labels:[.labels[].name],created_at,updated_at,body,author_association,user:.user.login}']);
  const comments = (await gh(['api', `repos/${owner}/${repo}/issues/${num}/comments?per_page=100`, '--paginate', '--slurp'])).flat();
  const defaultRef = await gh(['api', `repos/${owner}/${repo}/git/ref/heads/${repoData.default_branch}`]);
  const defaultHead = defaultRef.object?.sha;
  const allPrs = await gh(['pr', 'list', '--repo', `${owner}/${repo}`, '--state', 'all', '--limit', '500',
    '--json', 'number,title,body,url,state,headRefName,author,updatedAt,closedAt,mergedAt']);
  const openPrs = allPrs.filter((pr) => pr.state === 'OPEN');
  const northsetOpen = openPrs.filter((pr) => pr.author?.login === 'AysajanE');
  let timeline;
  try {
    timeline = timelineCrossReferences(await gh(timelineApiArgs(owner, repo, num)));
  } catch (error) {
    await log(`recheck: timeline check FAILED — ${error.message} (fail-closed → FAILED)`);
    throw new Error(`timeline recheck failed (fail-closed): ${error.message}`);
  }
  const reviewedAt = Date.parse(spec.qualification.reviewed_at);
  const cleared = new Set(spec.qualification.related_prs.filter((item) => item.blocking === false).map((item) => item.url));
  const competingPRs = timeline.filter((item) => item.is_pr && (String(item.state).toLowerCase() === 'open' ||
    !cleared.has(item.source) || (item.created_at && Date.parse(item.created_at) > reviewedAt)));
  const semanticPRs = possibleOverlappingPrs(allPrs, spec).filter((pr) => pr.author?.login !== 'AysajanE');
  const related = new Map(spec.qualification.related_prs.map((item) => [item.url, item]));
  const reopeningChecks = new Map();
  for (const reviewed of spec.qualification.related_prs) {
    if (!reviewed.reopened_by) continue;
    const evidence = await fetchMaintainerEvidence(reviewed.reopened_by, {owner, repo}, gh);
    const livePr = allPrs.find((pr) => pr.url === reviewed.url);
    reopeningChecks.set(reviewed.url, evidence.valid && Boolean(evidence.timestamp) && Boolean(livePr?.closedAt) &&
      Date.parse(evidence.timestamp) > Date.parse(livePr.closedAt));
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
  const invitationStillPresent = invitation.type === 'label'
    ? issue.labels.some((label) => /^(good first issue|help wanted)$/i.test(label))
    : invitation.type === 'assignment'
      ? issue.assignees.includes('AysajanE')
      : invitation.type === 'maintainer_comment'
        ? comments.some((comment) => comment.html_url === invitation.url &&
          ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.author_association))
        : invitationPolicy?.content_sha256 === invitation.content_sha256;
  const designPolicies = new Map();
  for (const item of spec.qualification.acceptance_contract.design_evidence) {
    if (item.author_association !== 'REPOSITORY_POLICY') continue;
    const fetched = await fetchRepositoryPolicy({...item, type: 'repository_policy'}, {owner, repo}, spec.base_commit, gh);
    designPolicies.set(item.url, fetched);
  }
  const designEvidenceStillPresent = (await Promise.all(spec.qualification.acceptance_contract.design_evidence.map(async (item) => {
    if (item.author_association === 'REPOSITORY_POLICY') {
      return designPolicies.get(item.url)?.content_sha256 === item.content_sha256;
    }
    return (await fetchMaintainerEvidence(item, {owner, repo, issue: num}, gh, {allowIssue: true})).valid;
  }))).every(Boolean);
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
  if (defaultHead !== spec.base_commit) reasons.push(`default branch head changed to ${defaultHead}`);
  if (issue.updated_at !== spec.qualification.issue_updated_at) reasons.push(`issue updated at ${issue.updated_at} after qualification`);
  if (!invitationStillPresent) reasons.push('contribution invitation is no longer present');
  if (!designEvidenceStillPresent) reasons.push('maintainer design evidence is no longer present');
  if (!preAuthorNoticeStillPresent) reasons.push('required pre-author notice is no longer present');
  if (competingPRs.length) reasons.push(`competing PR(s): ${competingPRs.map((pr) => `${pr.title} [${pr.state}]`).join('; ')}`);
  if (blockingSemantic.length) reasons.push(`blocking related PR(s): ${blockingSemantic.map((pr) => `${pr.url} [${pr.state}]`).join(', ')}`);
  if (northsetOpen.length) reasons.push(`Northset already has an open PR in ${owner}/${repo}: ${northsetOpen.map((pr) => pr.url).join(', ')}`);
  const policy = await loadRepoPolicy();
  if (policy.cooldowns?.[`${owner}/${repo}`]) reasons.push(`repository cooldown: ${policy.cooldowns[`${owner}/${repo}`].reason}`);
  await log(`recheck: state=${issue.state} invitation=${invitationStillPresent ? 'present' : 'missing'} assignees=${issue.assignees.join(',') || 'none'} crossrefs=${timeline.length} competingPRs=${competingPRs.length} relatedPRs=${blockingSemantic.length} northsetOpen=${northsetOpen.length}`);
  return {snapshot, clean: reasons.length === 0, reasons};
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
    return `${rendered.trimEnd()}\n`;
  }
  return [
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
  ].join('\n');
}

export async function assertPatchCommitBinding(repoDir, baseCommit, commitOid, patchFile) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-patch-binding-'));
  const index = path.join(root, 'index');
  const env = {...process.env, GIT_INDEX_FILE: index, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'};
  try {
    let result = await run('git', ['-C', repoDir, 'read-tree', baseCommit], {env});
    if (result.code !== 0) throw new Error(`cannot read base tree: ${result.stderr.trim()}`);
    result = await run('git', ['-C', repoDir, 'apply', '--cached', '--binary', patchFile], {env});
    if (result.code !== 0) throw new Error(`canonical patch does not apply to base: ${result.stderr.trim()}`);
    const actual = (await run('git', ['-C', repoDir, 'write-tree'], {env})).stdout.trim();
    const expected = (await git(repoDir, 'rev-parse', `${commitOid}^{tree}`)).stdout.trim();
    if (!actual || actual !== expected) throw new Error(`patch-to-commit tree mismatch: ${actual || '(none)'} != ${expected || '(none)'}`);
    return expected;
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}
