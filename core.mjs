import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {appendFile} from 'node:fs/promises';

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
  const subjects = readyPacks.map((pack) => ({
    diff: pack.diff,
    commit_oid: pack.commit_oid,
    receipt_subject: pack.receipt_subject,
    pr_title: pack.pr_title,
    pr_body: pack.pr_body,
    repo: pack.repo,
    planned_actions: pack.planned_actions,
  })).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return sha256(Buffer.from(canonical(subjects), 'utf8'));
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

export const RECEIPT_FOOTER = [
  '---',
  'Disclosure: this change was prepared with AI assistance and reviewed by me before submitting.',
  'I ran the check(s) above in a network-isolated container and published a signed, re-runnable',
  'record of that run, verifiable via GitHub artifact attestation:',
  'https://northset-oss.github.io/verification-pilot/. Contributor self-run, not a maintainer verification.',
].join('\n');

export function parseCandidate(value) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(value ?? '');
  if (!match) throw new Error(`invalid candidate ${JSON.stringify(value)}; expected owner/repo#123`);
  return {owner: match[1], repo: match[2], issue: Number(match[3])};
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
  if (!/^[0-9a-f]{40}$/i.test(spec.base_commit ?? '')) throw new Error('base_commit must be a full 40-character commit SHA');
  if (typeof spec.code_prompt !== 'string' || spec.code_prompt.trim() === '') throw new Error('code_prompt is required');
  if (!spec.executor || typeof spec.executor !== 'object') throw new Error('executor config is required');
  for (const key of ['install_commands', 'commands']) {
    if (!Array.isArray(spec.executor[key]) || !spec.executor[key].every((item) => typeof item === 'string' && item.trim())) {
      throw new Error(`executor.${key} must be an array of non-empty strings`);
    }
  }
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
    }));
}

export async function recheck(spec, log) {
  const {owner, repo, issue: num} = parseCandidate(spec.candidate);
  const issue = await ghJson(['api', `repos/${owner}/${repo}/issues/${num}`,
    '--jq', '{number,state,title,html_url,assignee:.assignee.login,labels:[.labels[].name],created_at,updated_at,body}']);
  let timeline;
  try {
    timeline = timelineCrossReferences(await ghJson(timelineApiArgs(owner, repo, num)));
  } catch (error) {
    await log(`recheck: timeline check FAILED — ${error.message} (fail-closed → FAILED)`);
    throw new Error(`timeline recheck failed (fail-closed): ${error.message}`);
  }
  const competingPRs = timeline.filter((item) => item.is_pr);
  const snapshot = {fetched_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), issue, comments: [], timeline_cross_references: timeline};
  const reasons = [];
  if (issue.state !== 'open') reasons.push(`issue is ${issue.state}`);
  if (issue.assignee) reasons.push(`assigned to ${issue.assignee}`);
  if (competingPRs.length) reasons.push(`competing PR(s): ${competingPRs.map((pr) => `${pr.title} [${pr.state}]`).join('; ')}`);
  await log(`recheck: state=${issue.state} assignee=${issue.assignee ?? 'none'} crossrefs=${timeline.length} competingPRs=${competingPRs.length}`);
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
  return [
    `<!-- PR title — edit to a clear, conventional summary (e.g. "fix(...): ...") before opening. -->`,
    ``,
    `## Summary`,
    ``,
    `<!-- 2–4 sentences: the problem and your fix. Issue: ${spec.issue_url} -->`,
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
    RECEIPT_FOOTER,
    ``,
  ].join('\n');
}
