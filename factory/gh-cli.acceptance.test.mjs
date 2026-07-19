import assert from 'node:assert/strict';
import {chmod, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {createGitHubSafety} from './github-safety.mjs';
import {
  GhCliError,
  createGhCliPublisherAdapter,
  createGhCliTransport,
  parseGhResponse,
} from './gh-cli.mjs';

async function temporary(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  t.after(async () => {
    const {rm} = await import('node:fs/promises');
    await rm(directory, {recursive: true, force: true});
  });
  return directory;
}

async function executable(directory, name, source) {
  const filename = path.join(directory, name);
  await writeFile(filename, `#!/usr/bin/env node\n${source}\n`);
  await chmod(filename, 0o700);
  return filename;
}

function structured(body, {status = 200, headers = {'x-ratelimit-remaining': '4999'}} = {}) {
  return {code: status >= 400 ? 1 : 0, status, httpStatus: status, headers, body,
    stdout: JSON.stringify(body), stderr: ''};
}

function fakeTransport({rest, graphql, git, dispatch} = {}) {
  const calls = [];
  const transport = async (request) => {
    calls.push({surface: 'dispatch', request});
    if (request.execute) return request.execute();
    if (dispatch) return dispatch(request);
    throw new Error(`unexpected dispatch ${request.operation}`);
  };
  transport.rest = async (request) => {
    calls.push({surface: 'rest', request: structuredClone(request)});
    return rest(request);
  };
  transport.graphql = async (request) => {
    calls.push({surface: 'graphql', request: structuredClone(request)});
    return graphql(request);
  };
  transport.git = async (args, options) => {
    calls.push({surface: 'git', args: [...args], options: {...options}});
    return git(args, options);
  };
  transport.calls = calls;
  return transport;
}

function apiPr(overrides = {}) {
  return {
    number: 17,
    html_url: 'https://github.com/upstream/project/pull/17',
    state: 'open',
    draft: false,
    title: 'Keep exact title',
    body: 'Exact body with trailing spaces  \n',
    base: {ref: 'main', repo: {full_name: 'upstream/project'}},
    head: {ref: 'northset/m-1001', sha: 'a'.repeat(40), repo: {full_name: 'northset/project'}},
    mergeable: true,
    mergeable_state: 'clean',
    ...overrides,
  };
}

test('H1 parses the final included HTTP response with rate headers and body', () => {
  const result = parseGhResponse({
    code: 0,
    stdout: 'HTTP/2.0 301 Moved Permanently\r\nlocation: /next\r\n\r\n' +
      'HTTP/2.0 200 OK\r\nx-ratelimit-remaining: 4998\r\nx-ratelimit-reset: 9999999999\r\n' +
      'etag: "abc"\r\n\r\n{"ok":true,"oid":"ABCDEF"}\n',
    stderr: '',
  });
  assert.equal(result.httpStatus, 200);
  assert.equal(result.headers['x-ratelimit-remaining'], '4998');
  assert.equal(result.headers.etag, '"abc"');
  assert.equal(result.rateLimit.remaining, 4998);
  assert.equal(result.rateLimit.reset, 9999999999);
  assert.deepEqual(result.body, {ok: true, oid: 'ABCDEF'});
});

test('H2 production transport invokes a fake gh executable and preserves structured response', async (t) => {
  const directory = await temporary(t, 'factory-gh-cli');
  const log = path.join(directory, 'calls.json');
  const fakeGh = await executable(directory, 'fake-gh.mjs', `
    import {writeFile} from 'node:fs/promises';
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    await writeFile(process.env.FAKE_GH_LOG, JSON.stringify({argv: process.argv.slice(2), input}));
    process.stdout.write('HTTP/2.0 200 OK\\r\\nx-ratelimit-limit: 5000\\r\\nx-ratelimit-remaining: 4321\\r\\n\\r\\n');
    process.stdout.write(JSON.stringify({resources: {core: {remaining: 4321}}}));
  `);
  const transport = createGhCliTransport({ghExecutable: fakeGh, env: {...process.env, FAKE_GH_LOG: log}});
  const result = await transport({operation: 'rate_limit_probe', path: '/rate_limit'});
  assert.equal(result.status, 200);
  assert.equal(result.headers['x-ratelimit-remaining'], '4321');
  assert.equal(result.body.resources.core.remaining, 4321);
  const invocation = JSON.parse(await readFile(log, 'utf8'));
  assert.deepEqual(invocation.argv, ['api', '--include', '--method', 'GET', '/rate_limit']);
  assert.equal(invocation.input, '');
});

test('H3 transport bounds timeout and aggregate subprocess output', async (t) => {
  const directory = await temporary(t, 'factory-gh-bounds');
  const slow = await executable(directory, 'slow.mjs', `setTimeout(() => process.stdout.write('late'), 10_000);`);
  const noisy = await executable(directory, 'noisy.mjs', `process.stdout.write('x'.repeat(4096));`);
  const timed = createGhCliTransport({ghExecutable: slow, timeoutMs: 40, maxOutputBytes: 512});
  await assert.rejects(() => timed({operation: 'rate_limit_probe'}),
    (error) => error instanceof GhCliError && error.code === 'ETIMEDOUT' && error.result.timedOut === true);
  const bounded = createGhCliTransport({ghExecutable: noisy, timeoutMs: 2_000, maxOutputBytes: 128});
  await assert.rejects(() => bounded({operation: 'rate_limit_probe'}),
    (error) => error instanceof GhCliError && error.code === 'GH_OUTPUT_LIMIT' &&
      error.result.outputLimited === true && Buffer.byteLength(error.result.stdout) <= 128);
});

test('H3b git clone binds an absolute checkout to the requested base OID', async (t) => {
  const directory = await temporary(t, 'factory-git-clone');
  const log = path.join(directory, 'git-calls.log');
  const fetched = path.join(directory, 'fetched');
  const oid = '9'.repeat(40);
  const fakeGit = await executable(directory, 'fake-git.mjs', `
    import {appendFile, mkdir, writeFile} from 'node:fs/promises';
    import {existsSync} from 'node:fs';
    const args = process.argv.slice(2);
    await appendFile(process.env.FAKE_GIT_LOG, JSON.stringify(args) + '\\n');
    if (args[0] === 'clone') await mkdir(args.at(-1), {recursive: true});
    if (args.includes('rev-parse') && args.at(-1).endsWith('^{commit}') && !existsSync(process.env.FAKE_FETCHED)) {
      process.exit(1);
    }
    if (args.includes('fetch')) await writeFile(process.env.FAKE_FETCHED, 'yes');
    if (args.includes('rev-parse')) process.stdout.write(process.env.FAKE_BASE_OID + '\\n');
  `);
  const destination = path.join(directory, 'checkout');
  const transport = createGhCliTransport({gitExecutable: fakeGit,
    env: {...process.env, FAKE_GIT_LOG: log, FAKE_BASE_OID: oid, FAKE_FETCHED: fetched}});
  const result = await transport({operation: 'git_clone', repository: 'upstream/project',
    destination, base_oid: oid});
  assert.equal(result.repository_path, destination);
  assert.equal(result.base_oid, oid);
  assert.equal(result.head_oid, oid);
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0], ['clone', '--no-tags', '--no-checkout', '--',
    'https://github.com/upstream/project.git', destination]);
  assert.deepEqual(calls[1], ['-C', destination, 'rev-parse', '--verify', `${oid}^{commit}`]);
  assert.deepEqual(calls[2], ['-C', destination, 'fetch', '--no-tags', '--', 'origin', oid]);
  assert.deepEqual(calls[3], ['-C', destination, 'rev-parse', '--verify', `${oid}^{commit}`]);
  assert.deepEqual(calls[4], ['-C', destination, 'checkout', '--detach', oid]);
  assert.deepEqual(calls[5], ['-C', destination, 'rev-parse', '--verify', 'HEAD^{commit}']);
});

test('H4 semantic REST adapter preserves exact OIDs, title, body, head, and request bytes', async () => {
  const requests = [];
  const transport = fakeTransport({
    rest: async (request) => {
      requests.push(request);
      if (request.path.includes('/git/ref/heads/')) {
        return structured({object: {sha: 'B'.repeat(40)}});
      }
      if (request.method === 'GET' && request.path.includes('/pulls?')) return structured([apiPr()]);
      if (request.method === 'POST') return structured(apiPr(), {status: 201});
      if (request.path.endsWith('/pulls/17')) return structured(apiPr());
      throw new Error(`unexpected REST request ${request.path}`);
    },
    graphql: async () => structured({data: {}}),
    git: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport});
  assert.deepEqual(await github.getBranch({repository: 'northset/project', branch: 'northset/m-1001'}), {
    status: 200,
    headers: {'x-ratelimit-remaining': '4999'},
    found: true,
    oid: 'B'.repeat(40),
  });
  const listed = await github.findPullRequests({repository: 'upstream/project',
    fork_repository: 'northset/project', branch: 'northset/m-1001', base_branch: 'main'});
  assert.equal(listed.pull_requests[0].body, 'Exact body with trailing spaces  \n');
  assert.equal(listed.pull_requests[0].head_oid, 'a'.repeat(40));
  const created = await github.createPullRequest({repository: 'upstream/project',
    fork_repository: 'northset/project', branch: 'northset/m-1001', base_branch: 'main',
    head_oid: 'a'.repeat(40), title: 'Keep exact title', body: 'Exact body with trailing spaces  \n'});
  assert.equal(created.title, 'Keep exact title');
  assert.equal(created.body, 'Exact body with trailing spaces  \n');
  const createRequest = requests.find((request) => request.method === 'POST');
  assert.deepEqual(createRequest.body, {
    title: 'Keep exact title', head: 'northset:northset/m-1001', base: 'main',
    body: 'Exact body with trailing spaces  \n', draft: false, maintainer_can_modify: true,
  });
  const readback = await github.getPullRequest({repository: 'upstream/project', number: 17});
  assert.equal(readback.repository, 'upstream/project');
  assert.equal(readback.head_branch, 'northset/m-1001');
  assert.equal(readback.head_oid, 'a'.repeat(40));
});

test('H5 push verifies exact local commit and uses a non-force exact refspec', async () => {
  const oid = 'c'.repeat(40);
  const transport = fakeTransport({
    rest: async () => structured({}),
    graphql: async () => structured({data: {}}),
    git: async (args) => {
      if (args.includes('rev-parse')) return {code: 0, status: 200, httpStatus: 200, stdout: `${oid}\n`, stderr: ''};
      return {code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''};
    },
    dispatch: async (request) => {
      assert.equal(request.operation, 'git_push');
      assert.equal(request.repository_path, '/tmp/durable-ready-repo');
      assert.equal(request.remote, 'https://github.com/northset/project.git');
      assert.equal(request.refspec, `${oid}:refs/heads/northset/m-1001`);
      return {code: 0, status: 200, httpStatus: 200, stdout: 'ok', stderr: ''};
    },
  });
  const github = createGhCliPublisherAdapter({transport});
  const result = await github.pushBranch({repository: 'northset/project',
    repository_path: '/tmp/durable-ready-repo', branch: 'northset/m-1001', oid, force: false});
  assert.equal(result.oid, oid);
  const commands = transport.calls.filter((call) => call.surface === 'git');
  assert.deepEqual(commands[0].args, ['check-ref-format', 'refs/heads/northset/m-1001']);
  assert.deepEqual(commands[1].args,
    ['-C', '/tmp/durable-ready-repo', 'rev-parse', '--verify', `${oid}^{commit}`]);
  await assert.rejects(() => github.pushBranch({repository: 'northset/project',
    repository_path: '/tmp/durable-ready-repo', branch: 'northset/m-1001', oid, force: true}),
  /must never force/);
});

test('H6 final live recheck accepts unchanged clean state and explains concrete collisions', async () => {
  const baseOid = 'd'.repeat(40);
  let response = {
    data: {
      repository: {
        nameWithOwner: 'upstream/project', isArchived: false, isFork: false,
        ref: {target: {oid: baseOid}},
        issue: {
          state: 'OPEN', locked: false,
          assignees: {nodes: [], pageInfo: {hasNextPage: false}},
          comments: {nodes: []},
          timelineItems: {pageInfo: {hasPreviousPage: false}, nodes: []},
        },
      },
      northset: {issueCount: 0, nodes: []},
    },
  };
  const transport = fakeTransport({
    rest: async () => structured({}),
    graphql: async ({query, variables}) => {
      assert.match(query, /FactoryFinalLiveRecheck/);
      assert.equal(variables.qualifiedBase, 'refs/heads/main');
      return structured(response);
    },
    git: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport, now: () => new Date('2026-07-19T12:00:00Z')});
  const plan = {repository: 'upstream/project', issue_number: 9, base_branch: 'main', base_oid: baseOid,
    branch: 'northset/m-1001', mission_id: 'M-1001'};
  assert.deepEqual(await github.finalLiveRecheck(plan),
    {clean: true, reason: null, base_oid: baseOid, issue_state: 'OPEN'});
  response = structuredClone(response);
  response.data.repository.ref.target.oid = 'e'.repeat(40);
  response.data.repository.issue.assignees.nodes = [{login: 'someone'}];
  response.data.repository.issue.comments.nodes = [{body: 'I will work on this',
    createdAt: '2026-07-19T10:00:00Z', author: {login: 'contributor', __typename: 'User'}}];
  response.data.repository.issue.timelineItems.nodes = [{source: {__typename: 'PullRequest', number: 44,
    state: 'OPEN', headRefName: 'feature', repository: {nameWithOwner: 'someone/project'}}}];
  response.data.northset = {issueCount: 1, nodes: [{repository: {nameWithOwner: 'upstream/project'},
    headRefName: 'another-northset-branch'}]};
  const blocked = await github.finalLiveRecheck(plan);
  assert.equal(blocked.clean, false);
  assert.match(blocked.reason, /assigned to someone/);
  assert.match(blocked.reason, /base branch moved/);
  assert.match(blocked.reason, /linked open competing PR exists: #44/);
  assert.match(blocked.reason, /active external claim by contributor/);
  assert.match(blocked.reason, /another open PR/);
});

test('H7 deep overlap resolves closed history and rejects an open referenced PR', async () => {
  let open = false;
  const transport = fakeTransport({
    rest: async () => structured({}),
    graphql: async ({query}) => {
      assert.match(query, /p0: pullRequest\(number: 12\)/);
      return structured({data: {repository: {
        issue: {timelineItems: {pageInfo: {hasNextPage: false}, nodes: [
          {source: {__typename: 'PullRequest', number: 8, state: 'CLOSED', url: 'closed'}},
        ]}},
        p0: {number: 12, state: open ? 'OPEN' : 'MERGED', url: 'https://github.com/upstream/project/pull/12'},
      }}});
    },
    git: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport});
  const live = {repository: {nameWithOwner: 'upstream/project'}, issue: {number: 9,
    title: 'Follow PR #12', body: ''}};
  assert.deepEqual(await github.deepOverlap(live), {clean: true, reason: null});
  open = true;
  const blocked = await github.deepOverlap(live);
  assert.equal(blocked.clean, false);
  assert.match(blocked.reason, /pull\/12/);
});

test('H8 safety governor wraps semantic actions and recognizes structured CLI throttles', async (t) => {
  const directory = await temporary(t, 'factory-gh-safety');
  const pauseFile = path.join(directory, 'pause.json');
  let calls = 0;
  const transport = fakeTransport({
    rest: async () => {
      calls += 1;
      return calls === 1 ? structured({object: {sha: 'f'.repeat(40)}})
        : structured({message: 'You have exceeded a secondary rate limit.'}, {
          status: 403, headers: {'retry-after': '60'},
        });
    },
    graphql: async () => structured({data: {}}),
    git: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport});
  const safety = createGitHubSafety({pauseFile, transport, mutationSpacingMs: 0, searchSpacingMs: 0});
  const branch = await safety.request({priority: 'final_submission', kind: 'read', operation: 'get_branch',
    execute: () => github.getBranch({repository: 'northset/project', branch: 'northset/m-1001'})});
  assert.equal(branch.oid, 'f'.repeat(40));
  await assert.rejects(() => safety.request({priority: 'final_submission', kind: 'read',
    operation: 'get_branch', execute: () => github.getBranch({repository: 'northset/project', branch: 'other'})}),
  (error) => error.code === 'GITHUB_PAUSED');
  const pause = JSON.parse(await readFile(pauseFile, 'utf8'));
  assert.equal(pause.paused, true);
  assert.equal(pause.kind, 'GITHUB_RETRY_AFTER');
});

test('H9 commit and PR head mismatches fail instead of silently changing approved bytes', async () => {
  const oid = '1'.repeat(40);
  const transport = fakeTransport({
    rest: async () => structured(apiPr({head: {ref: 'northset/m-1001', sha: '2'.repeat(40),
      repo: {full_name: 'northset/project'}}}), {status: 201}),
    graphql: async () => structured({data: {}}),
    git: async (args) => ({code: 0, status: 200, httpStatus: 200,
      stdout: args.includes('rev-parse') ? `${'3'.repeat(40)}\n` : '', stderr: ''}),
    dispatch: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport});
  await assert.rejects(() => github.pushBranch({repository: 'northset/project', repository_path: '/tmp/repo',
    branch: 'northset/m-1001', oid, force: false}),
  (error) => error instanceof GhCliError && error.code === 'LOCAL_COMMIT_MISMATCH');
  await assert.rejects(() => github.createPullRequest({repository: 'upstream/project',
    fork_repository: 'northset/project', branch: 'northset/m-1001', base_branch: 'main',
    head_oid: oid, title: 'Keep exact title', body: 'Exact body\n'}),
  (error) => error instanceof GhCliError && error.code === 'PR_HEAD_MISMATCH');
});
