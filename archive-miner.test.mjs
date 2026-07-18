import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {gzipSync} from 'node:zlib';

import {
  ARCHIVE_USER_AGENT,
  archiveHourId,
  mineArchives,
  parseArchive,
  parseArgs,
} from './archive-miner.mjs';
import {loadDiscoveryFile} from './find-candidates.mjs';

function issueEvent({
  repo = 'owner/repo', number = 1, action = 'opened', labels = ['good first issue'],
  createdAt = '2026-07-18T00:10:00Z', title = 'Fix parser regression', body = 'Expected and actual output differ in a test.',
} = {}) {
  return {
    type: 'IssuesEvent',
    created_at: createdAt,
    repo: {name: repo},
    payload: {
      action,
      issue: {
        number,
        title,
        body,
        html_url: `https://github.com/${repo}/issues/${number}`,
        labels: labels.map((name) => ({name})),
        assignees: [],
        comments: 1,
        author_association: 'MEMBER',
        locked: false,
        created_at: '2026-07-17T00:00:00Z',
        updated_at: createdAt,
      },
    },
  };
}

async function writeArchive(file, events) {
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, gzipSync(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`));
}

function config(root, overrides = {}) {
  return {
    from: new Date('2026-07-18T00:00:00Z'),
    hours: 1,
    labels: ['good first issue', 'help wanted', 'bug'],
    languages: [],
    outputFile: path.join(root, 'discovery.json'),
    cacheDir: path.join(root, 'cache'),
    lakeFile: path.join(root, 'missing-lake.sqlite'),
    ...overrides,
  };
}

function response(status, events = []) {
  const bytes = gzipSync(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  return {status, ok: status >= 200 && status < 300, arrayBuffer: async () => bytes};
}

test('parses bounded CLI configuration', () => {
  const parsed = parseArgs(['--from', '2026-07-18T03:00:00Z', '--hours', '3', '--out', 'found.json']);
  assert.equal(parsed.hours, 3);
  assert.deepEqual(parsed.labels, ['good first issue', 'help wanted', 'bug']);
  assert.equal(parsed.from.toISOString(), '2026-07-18T03:00:00.000Z');
  assert.throws(() => parseArgs(['--from', '2026-07-18T03:30:00Z', '--hours', '1', '--out', 'x']), /aligned/);
  assert.throws(() => parseArgs(['--from', '2026-07-18T03:00:00Z', '--hours', '49', '--out', 'x']), /cannot exceed/);
});

test('stream parser filters labels and actions and keeps the latest event per issue', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archive-parser-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const file = path.join(root, 'fixture.json.gz');
  await writeArchive(file, [
    issueEvent({title: 'Old title', createdAt: '2026-07-18T00:05:00Z'}),
    issueEvent({action: 'closed', number: 2}),
    issueEvent({number: 3, labels: ['question']}),
    {...issueEvent({number: 4}), type: 'PullRequestEvent'},
    issueEvent({action: 'labeled', title: 'Latest title', createdAt: '2026-07-18T00:40:00Z'}),
    issueEvent({number: 5, action: 'reopened', labels: ['BUG']}),
  ]);

  const parsed = await parseArchive(file, ['good first issue', 'bug']);
  assert.equal(parsed.events_seen, 6);
  assert.equal(parsed.matched_events, 3);
  assert.equal(parsed.candidates.length, 2);
  assert.equal(parsed.candidates.find((item) => item.candidate === 'owner/repo#1').title, 'Latest title');
  assert.ok(parsed.candidates.some((item) => item.candidate === 'owner/repo#5'));
});

test('cached hours skip fetch and missing language enrichment passes candidates through with null language', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archive-cache-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const settings = config(root, {languages: ['Rust']});
  const hour = archiveHourId(settings.from);
  await writeArchive(path.join(settings.cacheDir, `${hour}.json.gz`), [issueEvent()]);
  let fetchCalls = 0;
  const report = await mineArchives(settings, {fetchImpl: async () => { fetchCalls += 1; throw new Error('network forbidden'); }});

  assert.equal(fetchCalls, 0);
  assert.equal(report.state, 'COMPLETE');
  assert.equal(report.manifest.skipped_cached_hours.length, 1);
  assert.equal(report.language_enrichment.available, false);
  assert.equal(report.language_enrichment.filter_applied, false);
  assert.equal(report.unscreened_candidates.length, 1);
  assert.equal(report.unscreened_candidates[0].language, null);
  assert.deepEqual((await loadDiscoveryFile(settings.outputFile)).map((item) => item.key), ['owner/repo#1']);
});

test('available local-lake enrichment applies the optional language filter read-only', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archive-language-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const lake = path.join(root, 'lake.sqlite');
  const created = await command('sqlite3', [lake,
    "CREATE TABLE repositories(repo_key TEXT PRIMARY KEY, primary_language TEXT);" +
    "INSERT INTO repositories VALUES('owner/repo','TypeScript'),('rust/repo','Rust');"], process.env);
  assert.equal(created.code, 0, created.stderr);
  const settings = config(root, {lakeFile: lake, languages: ['Rust']});
  await writeArchive(path.join(settings.cacheDir, `${archiveHourId(settings.from)}.json.gz`), [
    issueEvent(),
    issueEvent({repo: 'rust/repo', number: 2}),
  ]);

  const report = await mineArchives(settings, {fetchImpl: async () => { throw new Error('network forbidden'); }});
  assert.equal(report.language_enrichment.available, true);
  assert.equal(report.language_enrichment.filter_applied, true);
  assert.deepEqual(report.unscreened_candidates.map((item) => [item.candidate, item.language]), [['rust/repo#2', 'Rust']]);
  const mode = await command('sqlite3', ['-readonly', lake, 'PRAGMA query_only;'], process.env);
  assert.equal(mode.code, 0, mode.stderr);
});

test('downloads sequentially with courtesy headers and one 5xx retry, preserving a partial manifest', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archive-failure-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const settings = config(root, {hours: 2});
  const calls = [];
  let clock = 0;
  const statuses = [500, 503, 200];
  const report = await mineArchives(settings, {
    clock: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetchImpl: async (url, options) => {
      calls.push({url, options, at: clock});
      const status = statuses.shift();
      return response(status, status === 200 ? [issueEvent({repo: 'two/repo', number: 2,
        createdAt: '2026-07-18T01:10:00Z'})] : []);
    },
  });

  assert.equal(report.state, 'PARTIAL');
  assert.equal(report.manifest.failed_hours.length, 1);
  assert.equal(report.manifest.failed_hours[0].attempts.length, 2);
  assert.equal(report.manifest.mined_hours.length, 1);
  assert.equal(report.unscreened_candidates[0].candidate, 'two/repo#2');
  assert.equal(calls.length, 3);
  assert.ok(calls.slice(1).every((call, index) => call.at - calls[index].at >= 500));
  assert.ok(calls.every((call) => call.options.headers['User-Agent'] === ARCHIVE_USER_AGENT));
});

test('403 or 429 aborts without attempting later archive hours', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archive-throttle-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const settings = config(root, {hours: 3});
  let calls = 0;
  const report = await mineArchives(settings, {
    fetchImpl: async () => { calls += 1; return response(429); },
  });
  assert.equal(calls, 1);
  assert.equal(report.state, 'PARTIAL_ABORTED');
  assert.equal(report.manifest.abort_reason, 'archive-host-throttle-429');
  assert.equal(report.manifest.unattempted_hours.length, 2);
});

test('body-read failure preserves prior candidates in a written partial manifest', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archive-body-failure-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const settings = config(root, {hours: 2});
  let calls = 0;
  const report = await mineArchives(settings, {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return response(200, [issueEvent()]);
      return {status: 200, ok: true, arrayBuffer: async () => { throw new Error('fixture body interrupted'); }};
    },
  });

  assert.equal(calls, 2);
  assert.equal(report.state, 'PARTIAL');
  assert.equal(report.manifest.mined_hours.length, 1);
  assert.equal(report.manifest.failed_hours.length, 1);
  assert.match(report.manifest.failed_hours[0].error, /body interrupted/);
  assert.deepEqual(report.unscreened_candidates.map((item) => item.candidate), ['owner/repo#1']);
  assert.deepEqual(JSON.parse(await readFile(settings.outputFile, 'utf8')), report);
});

function gatewayTestEnv(root) {
  return {
    OSS_GH_GATEWAY_TEST_MODE: '1',
    OSS_GH_GATEWAY_TEST_MIN_SPACING_MS: '0',
    OSS_GH_GATEWAY_TEST_SEARCH_SPACING_MS: '0',
    OSS_GH_GATEWAY_TEST_MUTATION_SPACING_MS: '0',
    OSS_GH_GATEWAY_TEST_JITTER_MAX_MS: '0',
    OSS_GH_GATEWAY_TEST_LOCK_POLL_MS: '1',
    OSS_GH_GATEWAY_STATE_DIR: path.join(root, 'gh-gateway-state'),
    OSS_GH_REQUEST_LEDGER: path.join(root, 'gh-request-ledger.jsonl'),
    OSS_RESOURCE_CONTROL_FILE: path.join(root, 'resource-control.json'),
    OSS_CAMPAIGN_CONTROL_STATE: path.join(root, 'control-state.json'),
    OSS_GATEWAY_WAVE_ID: 'archive-finder-wave',
    OSS_GATEWAY_WAVE_BUDGET: '20',
  };
}

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

test('finder crawl accepts miner output, performs GraphQL preflight, persists the lake, and makes no search call', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archive-finder-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const settings = config(root);
  await writeArchive(path.join(settings.cacheDir, `${archiveHourId(settings.from)}.json.gz`), [issueEvent()]);
  await mineArchives(settings, {fetchImpl: async () => { throw new Error('network forbidden'); }});

  const bin = path.join(root, 'bin');
  await mkdir(bin);
  const callsFile = path.join(root, 'gh-calls.jsonl');
  const gh = path.join(bin, 'gh');
  await writeFile(gh, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
if (!(args[0] === 'api' && args[1] === 'graphql')) {
  console.error('SEARCH_OR_NON_GRAPHQL_CALL_FORBIDDEN', JSON.stringify(args)); process.exit(17);
}
console.log(JSON.stringify({data:{rateLimit:{cost:1,remaining:4999,resetAt:'2030-01-01T00:00:00Z'},c0:{
  id:'R_repo',owner:{id:'U_owner',login:'owner'},nameWithOwner:'owner/repo',isArchived:false,isFork:false,isPrivate:false,
  pushedAt:'2026-07-17T00:00:00Z',stargazerCount:1000,primaryLanguage:{name:'TypeScript'},licenseInfo:{spdxId:'MIT'},
  defaultBranchRef:{name:'main',target:{oid:'a'.repeat(40)}},issue:{id:'I_issue',number:1,
    title:'Fix parser regression with wrong output',bodyText:'Expected and actual output differ in a deterministic test.',
    url:'https://github.com/owner/repo/issues/1',state:'OPEN',createdAt:'2026-07-17T00:00:00Z',updatedAt:'2026-07-18T00:10:00Z',
    locked:false,authorAssociation:'MEMBER',author:{login:'maintainer'},assignees:{nodes:[]},labels:{nodes:[{name:'good first issue'}]},
    comments:{totalCount:1,nodes:[]},timelineItems:{pageInfo:{hasNextPage:false},nodes:[]}}
}}}));
`);
  await chmod(gh, 0o755);

  const lake = path.join(root, 'candidate-lake.sqlite');
  const result = await command(process.execPath, [path.join(import.meta.dirname, 'find-candidates.mjs'), 'crawl',
    '--profile', 'node', '--count', '10', '--out', lake, '--discovery-file', settings.outputFile,
    '--budget-seconds', '10', '--review-timeout-seconds', '2', '--max-reviews', '1', '--preflight-limit', '10',
    '--history', path.join(root, 'history.jsonl'), '--repo-policy', path.join(root, 'missing-policy.json')], {
    ...process.env,
    ...gatewayTestEnv(root),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    OSS_FIND_EXCLUDE_FILES: '',
  });

  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.command, 'crawl');
  assert.equal(report.discovered, 1);
  assert.equal(report.preflighted, 1);
  const calls = (await readFile(callsFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.ok(calls.every((args) => args[0] === 'api' && args[1] === 'graphql'));
  const query = await command('sqlite3', ['-json', lake,
    "SELECT candidate_display, mechanical_score, evidence_key FROM issues WHERE candidate_key='owner/repo#1';"], process.env);
  assert.equal(query.code, 0, query.stderr);
  const rows = JSON.parse(query.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].candidate_display, 'owner/repo#1');
  assert.ok(rows[0].mechanical_score >= 60);
  assert.match(rows[0].evidence_key, /^sha256:[0-9a-f]{64}$/);
});
