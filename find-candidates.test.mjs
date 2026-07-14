import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import test from 'node:test';

import {taskIdForCandidate} from './core.mjs';

import {
  Deadline,
  activeClaimComment,
  buildPreflightQuery,
  buildReviewQueue,
  buildSearchPlan,
  extractIssueKeys,
  filterDiscovered,
  isInvitationLabel,
  isFatalReviewerInfrastructureError,
  loadSeen,
  lowValueReason,
  mechanicalDecision,
  mergeIncludedCandidates,
  normalizeLabel,
  normalizePreflight,
  normalizeRestSearchIssue,
  restSearchQuery,
  parseArgs,
  runBounded,
  scorePreflight,
  validateReview,
} from './find-candidates.mjs';

const oid = (char) => char.repeat(40);

function config(overrides = {}) {
  return {
    requested: 5,
    profile: 'node',
    labels: ['good first issue', 'help wanted'],
    terms: [],
    repositories: [],
    starsMin: 10,
    maxComments: 30,
    maxPushAgeDays: 180,
    minScore: 60,
    maxPerOwner: 2,
    ...overrides,
  };
}

function preflight(overrides = {}) {
  return {
    candidate: 'owner/repo#12',
    repository: {
      name_with_owner: 'owner/repo',
      archived: false,
      fork: false,
      private: false,
      pushed_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      stars: 1000,
      primary_language: 'TypeScript',
      license: 'MIT',
      default_branch: 'main',
      default_head: oid('a'),
    },
    issue: {
      number: 12,
      title: 'Fix parser regression for bounded input',
      url: 'https://github.com/owner/repo/issues/12',
      state: 'OPEN',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: new Date(Date.now() - 86_400_000).toISOString(),
      locked: false,
      author_association: 'MEMBER',
      author: 'maintainer',
      assignees: [],
      labels: ['good first issue', 'help wanted'],
      comments_total: 2,
      recent_comments: [],
      timeline_has_next_page: false,
      cross_referenced_prs: [],
    },
    discovery: {title: 'Fix parser regression', labels: ['good first issue'], updated_at: new Date().toISOString(), comments_count: 2, queries: ['q01']},
    ...overrides,
  };
}

test('accepts a reviewer issue URL whose GitHub owner and repository casing differs', () => {
  const review = {
    verdict: 'ACCEPT',
    candidate: 'thepants999/yellowscribe#9',
    issue_url: 'https://github.com/thepants999/yellowscribe/issues/9',
    tier: 'A',
    executor_profile: 'node',
    base_commit: oid('a'),
    test_command: 'npm test -- parser.test.js',
    source_evidence: ['src/parser.js:10'],
    invitation_evidence: {type: 'label'},
    acceptance_contract: {problem: 'Parser regression.'},
    checks: {open_unassigned: 'PASS'},
    task_id: taskIdForCandidate('thepants999/yellowscribe#9'),
    requested_model: 'gpt-5.6-sol',
    actual_model: null,
    reasoning_effort: 'xhigh',
    service_tier: 'fast',
  };

  assert.equal(validateReview(review, 'ThePants999/Yellowscribe#9', 0, 'node', {
    expectedBaseCommit: oid('a'),
    expectedIssueUrl: 'https://github.com/ThePants999/Yellowscribe/issues/9',
  }), review);
  assert.throws(() => validateReview({...review, task_id: 'TASK-OSS-0000000000000000'}, 'ThePants999/Yellowscribe#9', 0, 'node'), /task ID/);
  assert.throws(() => validateReview({...review, requested_model: ''}, 'ThePants999/Yellowscribe#9', 0, 'node'), /requested model/);
  assert.throws(() => validateReview({...review, reasoning_effort: ''}, 'ThePants999/Yellowscribe#9', 0, 'node'), /reasoning effort/);
  assert.throws(() => validateReview({...review, service_tier: ''}, 'ThePants999/Yellowscribe#9', 0, 'node'), /service tier/);
});

test('parses a bounded default configuration and rejects conflicting or unsafe values', () => {
  const parsed = parseArgs(['20', '--budget-seconds', '900', '--review-timeout-seconds', '240']);
  assert.equal(parsed.requested, 20);
  assert.equal(parsed.maxReviews, 40);
  assert.equal(parsed.preflightLimit, 160);
  assert.equal(parsed.totalBudgetMs, 900_000);
  assert.equal(parsed.reviewTimeoutMs, 240_000);
  assert.throws(() => parseArgs(['5', '--budget-seconds', '60', '--review-timeout-seconds', '61']), /cannot exceed/);
  assert.throws(() => parseArgs(['5', '--concurrency', '13']), /at most 12/);
  assert.throws(() => parseArgs(['5', '--repos', 'not-a-repo']), /owner\/repo/);
  const included = parseArgs(['5', '--include-file', 'first.txt', '--include-file', 'second.md']);
  assert.deepEqual(included.inclusionFiles, [path.resolve('first.txt'), path.resolve('second.md')]);
  const includeOnly = parseArgs(['5', '--include-file', 'first.txt', '--include-only']);
  assert.equal(includeOnly.includeOnly, true);
  assert.throws(() => parseArgs(['5', '--include-only']), /requires at least one --include-file/);
});

test('builds a deterministic, bounded invitation-label search plan', () => {
  const small = buildSearchPlan(config({requested: 5}));
  assert.equal(small.length, 6);
  assert.ok(small.every((query) => ['good first issue', 'help wanted'].includes(query.label)));
  assert.ok(small.some((query) => query.language === 'JavaScript'));
  assert.ok(small.some((query) => query.language === 'TypeScript'));
  const targeted = buildSearchPlan(config({repositories: ['one/repo', 'two/repo']}));
  assert.equal(targeted.length, 2);
  assert.deepEqual(targeted[0].repositories, ['one/repo', 'two/repo']);
});

test('include-only mode uses the supplied corpus without wide GitHub discovery searches', () => {
  assert.deepEqual(buildSearchPlan(config({includeOnly: true})), []);
});

test('include-only live hydration preserves issue body signals for scoring', () => {
  const candidate = {
    key: 'owner/repo#12', title: '', body: '', labels: [], updated_at: null,
    comments_count: 0, discovery_queries: ['include-file'],
  };
  const repository = {
    nameWithOwner: 'owner/repo',
    issue: {
      number: 12, title: 'Fix parser regression', bodyText: 'Expected and actual behavior with a focused test.',
      assignees: {nodes: []}, labels: {nodes: [{name: 'good first issue'}]},
      comments: {totalCount: 0, nodes: []}, timelineItems: {pageInfo: {hasNextPage: false}, nodes: []},
    },
  };

  assert.match(buildPreflightQuery([{owner: 'owner', repo: 'repo', number: 12}]), /\bbodyText\b/);
  const hydrated = normalizePreflight(candidate, repository);
  assert.equal(hydrated.discovery.title, 'Fix parser regression');
  assert.equal(hydrated.discovery.body_excerpt, 'Expected and actual behavior with a focused test.');
  assert.deepEqual(hydrated.discovery.labels, ['good first issue']);
});

test('builds auditable REST search qualifiers and normalizes REST issue records', () => {
  const query = buildSearchPlan(config({requested: 5}))[0];
  const text = restSearchQuery(query, config({requested: 5}));
  assert.match(text, /is:issue/);
  assert.match(text, /no:assignee/);
  assert.match(text, /label:\"good first issue\"/);
  assert.doesNotMatch(text, /stars:/, 'repository stars are enforced by preflight, not GitHub issue search');
  assert.doesNotMatch(query.query, /stars:/, 'the auditable search plan must match the valid issue-search query');
  const normalized = normalizeRestSearchIssue({
    number: 7, title: 'Fix parser', body: 'body', html_url: 'https://github.com/owner/repo/issues/7',
    repository_url: 'https://api.github.com/repos/owner/repo', labels: [{name: 'good first issue'}],
    assignees: [], updated_at: '2026-07-13T00:00:00Z', created_at: '2026-07-01T00:00:00Z',
    locked: false, comments: 2, author_association: 'MEMBER',
  });
  assert.equal(normalized.repository.nameWithOwner, 'owner/repo');
  assert.equal(normalized.commentsCount, 2);
});

test('normalizes invitation labels and extracts prior issue keys', () => {
  assert.equal(normalizeLabel('E-help-wanted'), 'e help wanted');
  assert.equal(isInvitationLabel('Effort: Good First Issue'), true);
  assert.equal(isInvitationLabel('bug'), false);
  assert.deepEqual([...extractIssueKeys(`owner/repo#12\nhttps://github.com/other/project/issues/34`)].sort(),
    ['other/project#34', 'owner/repo#12']);
});

test('filters unsafe task categories before model review', () => {
  const base = {
    repository: {nameWithOwner: 'owner/repo'},
    title: 'Fix parser bug', labels: [{name: 'good first issue'}], isLocked: false,
  };
  assert.equal(lowValueReason(base), null);
  assert.equal(lowValueReason({...base, title: 'Translate the README'}), 'excluded task type');
  assert.equal(lowValueReason({...base, labels: [{name: 'security'}]}), 'excluded label');
  assert.equal(lowValueReason({...base, repository: {nameWithOwner: 'spam/bounties'}}), 'bounty repository');
});

test('preflight scoring favors a bounded active Node issue and hard gates collision or claims', () => {
  const value = preflight();
  const score = scorePreflight(value, 'node');
  assert.ok(score.total >= 90, JSON.stringify(score));
  assert.equal(mechanicalDecision(value, config()).eligible, true);

  const collision = structuredClone(value);
  collision.issue.cross_referenced_prs = [{state: 'OPEN', repository: 'owner/repo', url: 'https://github.com/owner/repo/pull/9'}];
  assert.match(mechanicalDecision(collision, config()).reasons.join(' '), /cross-referenced/);

  const claimed = structuredClone(value);
  claimed.issue.recent_comments = [{
    author: 'contributor', author_association: 'NONE', created_at: new Date().toISOString(), body: 'I am working on this now.',
  }];
  assert.equal(activeClaimComment(claimed).author, 'contributor');
  assert.match(mechanicalDecision(claimed, config()).reasons.join(' '), /active-claim/);

  const blocked = structuredClone(value);
  blocked.issue.labels.push('security');
  assert.match(mechanicalDecision(blocked, config()).reasons.join(' '), /excluded label/);
});

test('injects exact include keys and exempts only those keys from repository concentration', () => {
  const discovered = [{
    key: 'one/repo#1', owner: 'one', repo: 'repo', number: 1, repository: 'one/repo',
    discovery_score: 100, updated_at: '2026-07-13T00:00:00Z', assignees: [],
    raw_search: {repository: {nameWithOwner: 'one/repo'}, number: 1, title: 'Fix parser bug', labels: [{name: 'good first issue'}]},
  }];
  const merged = mergeIncludedCandidates(discovered, new Set(['one/repo#4', 'two/repo#9']));
  assert.deepEqual(merged.map((item) => item.key).sort(), ['one/repo#1', 'one/repo#4', 'two/repo#9']);

  const candidate = (number) => ({
    key: `one/repo#${number}`, repository: 'one/repo', discovery_score: 100 - number,
    updated_at: '2026-07-13T00:00:00Z', assignees: [],
    raw_search: {repository: {nameWithOwner: 'one/repo'}, number, title: 'Fix parser bug', labels: [{name: 'good first issue'}]},
  });
  const result = filterDiscovered([candidate(1), candidate(2), candidate(3), candidate(4)], {
    seen: new Set(), cooldowns: {}, northsetOpenRepositories: new Set(), preflightLimit: 10,
    included: new Set(['one/repo#4']),
  });
  assert.deepEqual(result.accepted.map((item) => item.key), ['one/repo#4', 'one/repo#1', 'one/repo#2', 'one/repo#3']);
});

test('include-only discovery filtering admits exact keys only while preserving ordinary safety gates', () => {
  const candidate = (key) => {
    const [repository, number] = key.split('#');
    return {
      key, repository, discovery_score: 100, updated_at: '2026-07-13T00:00:00Z', assignees: [],
      raw_search: {repository: {nameWithOwner: repository}, number: Number(number), title: 'Fix parser bug', labels: [{name: 'good first issue'}]},
    };
  };
  const result = filterDiscovered([
    candidate('exact/repo#1'), candidate('bycatch/repo#2'), candidate('seen/repo#3'),
  ], {
    seen: new Set(['seen/repo#3']), cooldowns: {}, northsetOpenRepositories: new Set(), preflightLimit: 10,
    included: new Set(['exact/repo#1', 'seen/repo#3']), includeOnly: true,
  });
  assert.deepEqual(result.accepted.map((item) => item.key), ['exact/repo#1']);
  assert.deepEqual(result.rejected, [
    {candidate: 'seen/repo#3', terminal_state: 'REJECTED_DISCOVERY', reason: 'previously reviewed or excluded'},
    {candidate: 'bycatch/repo#2', terminal_state: 'REJECTED_DISCOVERY', reason: 'not explicitly included'},
  ]);
});

test('history only consumes candidates after a conclusive semantic decision', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'finder-history-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const history = path.join(root, 'history.jsonl');
  const exclusions = path.join(root, 'exclusions.md');
  const records = [
    {event: 'review_started', candidate: 'retry/started#1'},
    {event: 'review_finished', candidate: 'retry/tool-error#2', terminal_state: 'REJECTED_REVIEW_TOOL_ERROR'},
    {event: 'review_finished', candidate: 'retry/timeout#3', terminal_state: 'REJECTED_REVIEW_TIMEOUT'},
    {event: 'review_finished', candidate: 'retry/output-limit#4', terminal_state: 'REJECTED_REVIEW_OUTPUT_LIMIT'},
    {event: 'review_finished', candidate: 'retry/invalid-output#5', terminal_state: 'REJECTED_INVALID_REVIEW_OUTPUT'},
    {event: 'review_finished', candidate: 'done/rejected#6', terminal_state: 'REJECTED_SEMANTIC'},
    {event: 'review_finished', candidate: 'done/accepted#7', terminal_state: 'ACCEPTED'},
    {event: 'batch_disposition', candidate: 'done/selected#8', disposition: 'SELECTED'},
  ];
  await writeFile(history, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  await writeFile(exclusions, '- https://github.com/excluded/repo/issues/9\n');

  const seen = await loadSeen(history, [exclusions]);

  assert.deepEqual([...seen].sort(), [
    'done/accepted#7',
    'done/rejected#6',
    'done/selected#8',
    'excluded/repo#9',
  ]);
});

test('detects fatal reviewer infrastructure failures without classifying candidate semantics', () => {
  assert.equal(isFatalReviewerInfrastructureError("ERROR: You've hit your usage limit. Try again later."), true);
  assert.equal(isFatalReviewerInfrastructureError('authentication required: run codex login'), true);
  assert.equal(isFatalReviewerInfrastructureError('model gpt-5.6-terra is unavailable'), true);
  assert.equal(isFatalReviewerInfrastructureError('repository clone failed for this candidate'), false);
  assert.equal(isFatalReviewerInfrastructureError('review output did not match schema'), false);
});

test('review queue is deterministic and starts with repository-diverse high scores', () => {
  const records = [
    {candidate: 'one/repo#1', repository: {name_with_owner: 'one/repo'}, issue: {updated_at: '2026-07-13T00:00:00Z'}, decision: {eligible: true, score: {total: 100}}},
    {candidate: 'one/repo#2', repository: {name_with_owner: 'one/repo'}, issue: {updated_at: '2026-07-12T00:00:00Z'}, decision: {eligible: true, score: {total: 99}}},
    {candidate: 'two/repo#3', repository: {name_with_owner: 'two/repo'}, issue: {updated_at: '2026-07-11T00:00:00Z'}, decision: {eligible: true, score: {total: 90}}},
  ];
  const queue = buildReviewQueue(records, 3);
  assert.deepEqual(queue.slice(0, 2).map((item) => item.candidate), ['one/repo#1', 'two/repo#3']);
  assert.equal(queue[2].candidate, 'one/repo#2');
});

test('discovery filtering enforces history, cooldown, open-PR, and concentration gates', () => {
  const candidate = (key, score = 10) => {
    const [repository, number] = key.split('#');
    return {
      key, repository, discovery_score: score, updated_at: '2026-07-13T00:00:00Z', assignees: [],
      raw_search: {repository: {nameWithOwner: repository}, number: Number(number), title: 'Fix parser bug', labels: [{name: 'good first issue'}]},
    };
  };
  const result = filterDiscovered([
    candidate('seen/repo#1'), candidate('cool/repo#2'), candidate('open/repo#3'),
    candidate('good/repo#4'), candidate('good/repo#5'), candidate('good/repo#6'), candidate('good/repo#7'),
  ], {
    seen: new Set(['seen/repo#1']),
    cooldowns: {'cool/repo': {reason: 'pause'}},
    northsetOpenRepositories: new Set(['open/repo']),
    preflightLimit: 10,
  });
  assert.deepEqual(result.accepted.map((item) => item.key), ['good/repo#4', 'good/repo#5', 'good/repo#6']);
  assert.equal(result.rejected.length, 4);
});

test('bounded runner enforces output and wall-clock limits', async () => {
  const output = await runBounded(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], {timeoutMs: 5_000, maxOutputBytes: 1000});
  assert.equal(output.outputLimitExceeded, true);
  assert.equal(output.code, 125);

  const deadline = new Deadline(150);
  const timed = await runBounded(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)'], {deadline, timeoutMs: 5_000});
  assert.equal(timed.timedOut, true);
  assert.equal(timed.code, 124);
});

test('fails closed on repeated incomplete GitHub search results before any semantic review', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-finder-incomplete-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const gh = path.join(bin, 'gh');
  await writeFile(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'rate_limit') {
  console.log(JSON.stringify({resources:{search:{remaining:30,reset:2000000000},graphql:{remaining:5000,reset:2000000000}}})); process.exit(0);
}
if (args[0] === 'api' && args.includes('search/issues')) {
  const q = args.find((arg) => arg.startsWith('q='))?.slice(2) || '';
  if (q.includes('is:pr')) console.log(JSON.stringify({total_count:0,incomplete_results:false,items:[]}));
  else console.log(JSON.stringify({total_count:1,incomplete_results:true,items:[]}));
  process.exit(0);
}
console.error('unexpected gh args', args); process.exit(1);
`);
  await chmod(gh, 0o755);
  const marker = path.join(root, 'reviewer-called');
  const reviewer = path.join(root, 'reviewer.mjs');
  await writeFile(reviewer, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'called'); process.exit(1);\n`);
  await chmod(reviewer, 0o755);

  const result = await command(process.execPath, [path.join(import.meta.dirname, 'find-candidates.mjs'), '1',
    '--labels', 'good first issue', '--terms', 'parser', '--budget-seconds', '10', '--review-timeout-seconds', '2',
    '--history', path.join(root, 'history.jsonl'), '--output', path.join(root, 'batch.json'),
    '--audit', path.join(root, 'audit.jsonl'), '--review-script', reviewer,
    '--repo-policy', path.join(root, 'missing-policy.json')], {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /remained incomplete/);
  await assert.rejects(() => readFile(marker), /ENOENT/);
});

test('fatal reviewer quota failure stops the batch and leaves candidates retryable', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-finder-reviewer-quota-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const gh = path.join(bin, 'gh');
  await writeFile(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'rate_limit') {
  console.log(JSON.stringify({resources:{search:{remaining:30,reset:2000000000},graphql:{remaining:5000,reset:2000000000}}})); process.exit(0);
}
if (args[0] === 'api' && args.includes('search/issues')) {
  const q = args.find((arg) => arg.startsWith('q='))?.slice(2) || '';
  if (q.includes('is:pr')) { console.log(JSON.stringify({total_count:0,incomplete_results:false,items:[]})); process.exit(0); }
  const items = ['one', 'two', 'three'].map((repo, index) => ({number:index + 1,title:'Fix parser regression ' + repo,body:'Expected and actual behavior with a test.',html_url:'https://github.com/a/' + repo + '/issues/' + (index + 1),repository_url:'https://api.github.com/repos/a/' + repo,labels:[{name:'good first issue'}],assignees:[],updated_at:'2026-07-13T00:00:00Z',created_at:'2026-07-01T00:00:00Z',locked:false,comments:1,author_association:'MEMBER'}));
  console.log(JSON.stringify({total_count:items.length,incomplete_results:false,items})); process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql') {
  const query = args.find((arg) => arg.startsWith('query='))?.slice(6) || '';
  const regex = /c(\\d+): repository\\(owner: "([^"]+)", name: "([^"]+)"\\)/g;
  const numbers = {one:1,two:2,three:3};
  const data = {rateLimit:{cost:1,remaining:4999,resetAt:'2030-01-01T00:00:00Z'}};
  for (const match of query.matchAll(regex)) {
    const index = match[1], owner = match[2], repo = match[3], number = numbers[repo];
    data['c' + index] = {nameWithOwner:owner + '/' + repo,isArchived:false,isFork:false,isPrivate:false,pushedAt:'2026-07-12T00:00:00Z',stargazerCount:1000,primaryLanguage:{name:'TypeScript'},licenseInfo:{spdxId:'MIT'},defaultBranchRef:{name:'main',target:{oid:'a'.repeat(40)}},issue:{number,title:'Fix parser regression ' + repo,url:'https://github.com/' + owner + '/' + repo + '/issues/' + number,state:'OPEN',createdAt:'2026-07-01T00:00:00Z',updatedAt:'2026-07-13T00:00:00Z',locked:false,authorAssociation:'MEMBER',author:{login:'maintainer'},assignees:{nodes:[]},labels:{nodes:[{name:'good first issue'}]},comments:{totalCount:1,nodes:[]},timelineItems:{pageInfo:{hasNextPage:false},nodes:[]}}};
  }
  console.log(JSON.stringify({data})); process.exit(0);
}
console.error('unexpected gh args', args); process.exit(1);
`);
  await chmod(gh, 0o755);

  const calls = path.join(root, 'review-calls.jsonl');
  const reviewer = path.join(root, 'reviewer.mjs');
  await writeFile(reviewer, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, process.argv[2] + '\\n');
console.error("ERROR: You've hit your usage limit. Try again later.");
process.exit(1);
`);
  await chmod(reviewer, 0o755);

  const history = path.join(root, 'history.jsonl');
  const audit = path.join(root, 'audit.jsonl');
  const result = await command(process.execPath, [path.join(import.meta.dirname, 'find-candidates.mjs'), '3',
    '--labels', 'good first issue', '--budget-seconds', '20', '--review-timeout-seconds', '5',
    '--concurrency', '1', '--max-reviews', '3', '--preflight-limit', '10', '--search-limit', '10',
    '--history', history, '--output', path.join(root, 'batch.json'), '--audit', audit,
    '--review-script', reviewer, '--repo-policy', path.join(root, 'missing-policy.json')], {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, OSS_FIND_EXCLUDE_FILES: '',
  });

  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /semantic reviewer infrastructure failure.*usage limit/s);
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), ['a/one#1']);
  const records = (await readFile(history, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.filter((record) => record.event === 'review_started').length, 1);
  assert.equal(records.filter((record) => record.terminal_state === 'REJECTED_REVIEW_TOOL_ERROR').length, 1);
  assert.deepEqual([...await loadSeen(history, [])], []);
  assert.match(await readFile(audit, 'utf8'), /"event":"run_failed"/);
});

test('runs the full finder against fake GitHub and reviewer tools with one review per candidate', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-finder-flow-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const gh = path.join(bin, 'gh');
  await writeFile(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'rate_limit') {
  console.log(JSON.stringify({resources:{search:{remaining:30,reset:2000000000},graphql:{remaining:5000,reset:2000000000}}}));
  process.exit(0);
}
if (args[0] === 'api' && args.includes('search/issues')) {
  const q = args.find((arg) => arg.startsWith('q='))?.slice(2) || '';
  if (q.includes('is:pr')) { console.log(JSON.stringify({total_count:0,incomplete_results:false,items:[]})); process.exit(0); }
  const items = [
    {number:1,title:'Fix parser regression one',body:'Expected and actual behavior with a test.',html_url:'https://github.com/a/one/issues/1',repository_url:'https://api.github.com/repos/a/one',labels:[{name:'good first issue'}],assignees:[],updated_at:'2026-07-13T00:00:00Z',created_at:'2026-07-01T00:00:00Z',locked:false,comments:1,author_association:'MEMBER'},
    {number:2,title:'Fix parser regression two',body:'Expected and actual behavior with a test.',html_url:'https://github.com/b/two/issues/2',repository_url:'https://api.github.com/repos/b/two',labels:[{name:'help wanted'}],assignees:[],updated_at:'2026-07-13T00:00:00Z',created_at:'2026-07-01T00:00:00Z',locked:false,comments:1,author_association:'MEMBER'},
    {number:3,title:'Fix parser regression three',body:'Expected and actual behavior with a test.',html_url:'https://github.com/c/three/issues/3',repository_url:'https://api.github.com/repos/c/three',labels:[{name:'good first issue'}],assignees:[],updated_at:'2026-07-13T00:00:00Z',created_at:'2026-07-01T00:00:00Z',locked:false,comments:1,author_association:'OWNER'},
    {number:4,title:'Fix parser regression four',body:'Expected and actual behavior with a test.',html_url:'https://github.com/d/four/issues/4',repository_url:'https://api.github.com/repos/d/four',labels:[{name:'help wanted'}],assignees:[],updated_at:'2026-07-13T00:00:00Z',created_at:'2026-07-01T00:00:00Z',locked:false,comments:1,author_association:'OWNER'}
  ];
  console.log(JSON.stringify({total_count:items.length,incomplete_results:false,items})); process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql') {
  const query = args.find((arg) => arg.startsWith('query='))?.slice(6) || '';
  const regex = /c(\\d+): repository\\(owner: "([^"]+)", name: "([^"]+)"\\)/g;
  const data = {rateLimit:{cost:1,remaining:4999,resetAt:'2030-01-01T00:00:00Z'}};
  for (const match of query.matchAll(regex)) {
    const index = match[1], owner = match[2], repo = match[3];
    const number = ({one:1,two:2,three:3,four:4})[repo] || 1;
    data['c' + index] = {
      nameWithOwner: owner + '/' + repo, isArchived:false, isFork:false, isPrivate:false,
      pushedAt:'2026-07-12T00:00:00Z', stargazerCount:1000, primaryLanguage:{name:'TypeScript'}, licenseInfo:{spdxId:'MIT'},
      defaultBranchRef:{name:'main',target:{oid:'a'.repeat(40)}},
      issue:{number,title:'Fix parser regression ' + repo,url:'https://github.com/' + owner + '/' + repo + '/issues/' + number,state:'OPEN',createdAt:'2026-07-01T00:00:00Z',updatedAt:'2026-07-13T00:00:00Z',locked:false,authorAssociation:'MEMBER',author:{login:'maintainer'},assignees:{nodes:[]},labels:{nodes:[{name:'good first issue'}]},comments:{totalCount:1,nodes:[]},timelineItems:{pageInfo:{hasNextPage:false},nodes:[]}}
    };
  }
  console.log(JSON.stringify({data})); process.exit(0);
}
console.error('unexpected gh args', args); process.exit(1);
`);
  await chmod(gh, 0o755);

  const calls = path.join(root, 'review-calls.jsonl');
  const reviewer = path.join(root, 'reviewer.mjs');
  await writeFile(reviewer, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
const key = process.argv[2];
appendFileSync(${JSON.stringify(calls)}, key + '\\n');
const accept = !key.startsWith('a/');
const issue = Number(key.split('#')[1]);
const review = {
  verdict: accept ? 'ACCEPT' : 'REJECT', candidate:key, issue_url:'https://github.com/' + key.replace('#','/issues/'),
  summary: accept ? 'Bounded suitable issue.' : 'Rejected.', reasons: accept ? [] : ['Not suitable.'],
  checks:{open_unassigned:'PASS',no_active_claim_or_pr:'PASS',current_main_gap:'PASS',bounded_scope:'PASS',deterministic_harness:'PASS',contribution_policy:'PASS',invitation_signal:'PASS',design_settled:'PASS',historical_attempts_clear:'PASS'},
  invitation_evidence:{type:'label',url:'https://github.com/' + key.replace('#','/issues/'),observed_at:'2026-07-13T12:00:00Z'},
  acceptance_contract:{problem:'Bounded parser bug.',expected_behavior:['Correct value.'],non_goals:['No API change.'],design_evidence:[{url:'https://github.com/' + key.replace('#','/issues/'),author_association:'MEMBER',summary:'Maintainer-backed issue.'}]},
  related_prs:[],source_evidence:['src/file.ts:10'],test_command:'npm test -- test/focused.test.ts',process_requirements:[],base_commit:'a'.repeat(40),executor_profile:'node',tier:'A'
  ,task_id:(await import(${JSON.stringify(new URL('./core.mjs', import.meta.url).href)})).taskIdForCandidate(key),requested_model:'gpt-5.6-sol',reasoning_effort:'xhigh',service_tier:'fast'
};
console.log(JSON.stringify(review)); process.exit(accept ? 0 : 2);
`);
  await chmod(reviewer, 0o755);

  const output = path.join(root, 'batch.json');
  const audit = path.join(root, 'batch.audit.jsonl');
  const history = path.join(root, 'history.jsonl');
  const result = await command(process.execPath, [path.join(import.meta.dirname, 'find-candidates.mjs'), '2',
    '--budget-seconds', '20', '--review-timeout-seconds', '5', '--concurrency', '2', '--max-reviews', '4',
    '--preflight-limit', '10', '--search-limit', '10', '--history', history, '--output', output, '--audit', audit,
    '--review-script', reviewer, '--repo-policy', path.join(root, 'missing-policy.json')], {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    OSS_FIND_EXCLUDE_FILES: '',
  });

  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.state, 'COMPLETE');
  assert.equal(report.found, 2);
  assert.equal(report.candidates.length, 2);
  for (const candidate of report.candidates) {
    assert.match(candidate.task_id, /^TASK-OSS-[0-9A-F]{16}$/);
    assert.equal(candidate.finder_run_id, report.run_id);
    assert.ok(candidate.candidate_rank >= 1);
    assert.equal(candidate.reviewer_model, 'gpt-5.6-sol');
    assert.equal(candidate.reviewer_effort, 'xhigh');
  }
  assert.equal(new Set(report.candidates.map((item) => item.repository.name_with_owner)).size, 2);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), report);
  assert.ok((await readFile(audit, 'utf8')).includes('semantic_review_finished'));

  const reviewed = (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean);
  const counts = new Map();
  for (const key of reviewed) counts.set(key, (counts.get(key) ?? 0) + 1);
  assert.ok([...counts.values()].every((count) => count === 1), JSON.stringify([...counts]));

  const historyLines = (await readFile(history, 'utf8')).trim().split('\n').map(JSON.parse);
  const starts = historyLines.filter((line) => line.event === 'review_started');
  assert.equal(starts.length, reviewed.length);
  assert.equal(new Set(starts.map((line) => line.candidate)).size, starts.length);
});

function command(program, args, env) {
  return new Promise((resolve) => {
    const child = spawn(program, args, {env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({code, stdout, stderr}));
  });
}
