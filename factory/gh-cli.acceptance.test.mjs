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
  const oid = '9'.repeat(40);
  const fakeGit = await executable(directory, 'fake-git.mjs', `
    import {appendFile, mkdir} from 'node:fs/promises';
    const args = process.argv.slice(2);
    await appendFile(process.env.FAKE_GIT_LOG, JSON.stringify(args) + '\\n');
    if (args[0] === 'init') await mkdir(args.at(-1), {recursive: true});
    if (args.includes('rev-parse')) process.stdout.write(process.env.FAKE_BASE_OID + '\\n');
  `);
  const destination = path.join(directory, 'checkout');
  const transport = createGhCliTransport({gitExecutable: fakeGit,
    env: {...process.env, FAKE_GIT_LOG: log, FAKE_BASE_OID: oid}});
  const result = await transport({operation: 'git_clone', repository: 'upstream/project',
    destination, base_oid: oid});
  assert.equal(result.repository_path, destination);
  assert.equal(result.base_oid, oid);
  assert.equal(result.head_oid, oid);
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0], ['init', '--quiet', destination]);
  assert.deepEqual(calls[1], ['-C', destination, 'remote', 'add', 'origin',
    'https://github.com/upstream/project.git']);
  assert.deepEqual(calls[2], ['-C', destination, 'fetch', '--no-tags', '--depth=1', '--', 'origin', oid]);
  assert.deepEqual(calls[3], ['-C', destination, 'rev-parse', '--verify', `${oid}^{commit}`]);
  assert.deepEqual(calls[4], ['-C', destination, 'checkout', '--detach', oid]);
  assert.deepEqual(calls[5], ['-C', destination, 'rev-parse', '--verify', 'HEAD^{commit}']);
});

test('H4 semantic REST adapter preserves exact OIDs, title, body, head, and request bytes', async () => {
  const requests = [];
  const transport = fakeTransport({
    rest: async (request) => {
      requests.push(request);
      if (request.path === '/repos/northset/project') {
        return structured({full_name: 'northset/project', fork: true,
          parent: {full_name: 'upstream/project'}});
      }
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
  assert.deepEqual(await github.getFork({repository: 'northset/project',
    upstream_repository: 'upstream/project'}), {
    status: 200, headers: {'x-ratelimit-remaining': '4999'}, found: true,
    repository: 'northset/project', upstream_repository: 'upstream/project',
  });
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

test('publisher adapter creates only the declared fork and rejects an unrelated repository', async () => {
  const requests = [];
  let response = {full_name: 'AysajanE/youtube', fork: true,
    parent: {full_name: 'code-charity/youtube'}};
  const transport = fakeTransport({
    rest: async (request) => { requests.push(request); return structured(response, {status: 202}); },
    graphql: async () => structured({data: {}}),
    git: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport});
  const created = await github.createFork({repository: 'AysajanE/youtube',
    upstream_repository: 'code-charity/youtube'});
  assert.equal(created.repository, 'AysajanE/youtube');
  assert.deepEqual(requests[0], {method: 'POST', path: '/repos/code-charity/youtube/forks', body: null});
  response = {full_name: 'AysajanE/youtube', fork: false};
  await assert.rejects(() => github.getFork({repository: 'AysajanE/youtube',
    upstream_repository: 'code-charity/youtube'}), (error) => error.code === 'FORK_REPOSITORY_MISMATCH');
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
          comments: {pageInfo: {hasPreviousPage: false}, nodes: []},
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
    {clean: true, reason: null, base_oid: baseOid, current_base_oid: baseOid,
      base_changed: false, refreshable: false, cooldown: null, issue_state: 'OPEN'});
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

test('H6b final live recheck recognizes a maintainer opt-out and emits a manual cooldown', async () => {
  const baseOid = 'd'.repeat(40);
  const transport = fakeTransport({
    rest: async () => structured({}),
    graphql: async () => structured({data: {
      repository: {
        nameWithOwner: 'upstream/project', isArchived: false, isFork: false,
        ref: {target: {oid: baseOid}},
        issue: {
          state: 'OPEN', locked: false,
          assignees: {nodes: [{login: 'AysajanE'}], pageInfo: {hasNextPage: false}},
          comments: {pageInfo: {hasPreviousPage: false}, nodes: [{
            body: 'Please do not submit a pull request for this issue.',
            createdAt: '2026-07-19T10:00:00Z', authorAssociation: 'MEMBER',
            author: {login: 'maintainer', __typename: 'User'},
          }]},
          timelineItems: {pageInfo: {hasPreviousPage: false}, nodes: []},
        },
      },
      northset: {issueCount: 0, nodes: []},
    }}),
    git: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport});
  const result = await github.finalLiveRecheck({repository: 'upstream/project', issue_number: 9,
    base_branch: 'main', base_oid: baseOid, branch: 'northset/m-1001', mission_id: 'M-1001'});
  assert.equal(result.clean, false);
  assert.match(result.reason, /maintainer requested no submission/);
  assert.deepEqual(result.cooldown, {reason: 'explicit maintainer stop/opt-out', until: 'manual-release'});
});

test('H7 deep overlap resolves closed history and rejects an open referenced PR', async () => {
  let open = false;
  const transport = fakeTransport({
    rest: async () => structured({}),
    graphql: async ({query}) => {
      assert.match(query, /p0: issueOrPullRequest\(number: 7\)/);
      assert.match(query, /p1: issueOrPullRequest\(number: 12\)/);
      return structured({data: {repository: {
        issue: {timelineItems: {pageInfo: {hasNextPage: false}, nodes: [
          {source: {__typename: 'PullRequest', number: 8, state: 'CLOSED', url: 'closed'}},
        ]}},
        p0: {__typename: 'Issue'},
        p1: {__typename: 'PullRequest', number: 12, state: open ? 'OPEN' : 'MERGED',
          url: 'https://github.com/upstream/project/pull/12'},
      }}});
    },
    git: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport});
  const live = {repository: {nameWithOwner: 'upstream/project'}, issue: {number: 9,
    title: 'Follow issue #7 and PR #12', body: ''}};
  assert.deepEqual(await github.deepOverlap(live), {clean: true, reason: null});
  open = true;
  const blocked = await github.deepOverlap(live);
  assert.equal(blocked.clean, false);
  assert.match(blocked.reason, /pull\/12/);
});

test('H7b deep overlap tolerates only missing textual issue or PR references', async () => {
  const body = {data: {repository: {
    issue: {timelineItems: {pageInfo: {hasNextPage: false}, nodes: []}},
    p0: null,
  }}, errors: [{
    type: 'NOT_FOUND',
    path: ['repository', 'p0'],
    message: 'Could not resolve to an issue or pull request with the number of 1791.',
  }]};
  const transport = fakeTransport({
    rest: async () => structured({}),
    graphql: async () => ({...structured(body), code: 1,
      stderr: 'gh: Could not resolve to an issue or pull request with the number of 1791.\n'}),
    git: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport});
  const live = {repository: {nameWithOwner: 'upstream/project'}, issue: {number: 9,
    title: 'Follow up on #1791', body: ''}};
  assert.deepEqual(await github.deepOverlap(live), {clean: true, reason: null});
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

test('H10 reconciliation adapters read combined CI and GitHub artifact attestation state', async () => {
  const proofDigest = `sha256:${'a'.repeat(64)}`;
  const requests = [];
  const transport = fakeTransport({
    rest: async (request) => {
      requests.push(request);
      if (request.path.endsWith(`/commits/${'b'.repeat(40)}/status`)) {
        return structured({state: 'success', total_count: 3, updated_at: '2026-07-19T13:01:00Z'});
      }
      if (request.path.endsWith(`/commits/${'b'.repeat(40)}/check-runs?per_page=100`)) {
        return structured({total_count: 0, check_runs: []});
      }
      if (request.path.includes('/attestations/')) {
        return structured({attestations: [{
          html_url: 'https://github.com/northset-oss/verification-pilot/attestations/123',
          created_at: '2026-07-19T13:02:00Z',
          bundle: {mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.3'},
        }]});
      }
      throw new Error(`unexpected REST request ${request.path}`);
    },
    graphql: async () => structured({data: {}}),
    git: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport});
  assert.deepEqual(await github.getCommitStatus({repository: 'upstream/project', oid: 'b'.repeat(40)}), {
    status: 200,
    headers: {'x-ratelimit-remaining': '4999'},
    found: true,
    state: 'SUCCESS',
    total_count: 3,
    updated_at: '2026-07-19T13:01:00Z',
  });
  const attestation = await github.getArtifactAttestation({
    repository: 'northset-oss/verification-pilot', subject_digest: proofDigest,
  });
  assert.equal(attestation.found, true);
  assert.equal(attestation.attestation_url,
    'https://github.com/northset-oss/verification-pilot/attestations/123');
  assert.equal(attestation.attested_at, '2026-07-19T13:02:00Z');
  assert.match(requests[2].path, new RegExp(`attestations/sha256%3A${'a'.repeat(64)}$`));
});

test('H10a reconciliation combines GitHub Check Runs with legacy commit statuses', async () => {
  const oid = 'b'.repeat(40);
  const transport = fakeTransport({
    rest: async (request) => {
      if (request.path.endsWith(`/commits/${oid}/status`)) {
        return structured({state: 'success', total_count: 1, statuses: [{
          state: 'success', updated_at: '2026-07-19T13:05:00Z',
        }]});
      }
      if (request.path.endsWith(`/commits/${oid}/check-runs?per_page=100`)) {
        return structured({total_count: 1, check_runs: [{
          status: 'completed', conclusion: 'success', completed_at: '2026-07-19T13:04:00Z',
        }]}, {headers: {'x-ratelimit-remaining': '4988'}});
      }
      throw new Error(`unexpected REST request ${request.path}`);
    },
    graphql: async () => structured({data: {}}),
    git: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport});
  assert.deepEqual(await github.getCommitStatus({repository: 'upstream/project', oid}), {
    status: 200,
    headers: {'x-ratelimit-remaining': '4988'},
    found: true,
    state: 'SUCCESS',
    total_count: 2,
    updated_at: '2026-07-19T13:05:00Z',
  });
});

test('H10b reconciliation reads every Check Runs page before choosing a state', async () => {
  const oid = 'b'.repeat(40);
  const requests = [];
  const transport = fakeTransport({
    rest: async (request) => {
      requests.push(request.path);
      if (request.path.endsWith(`/commits/${oid}/status`)) {
        return structured({state: 'success', total_count: 1});
      }
      if (request.path.endsWith(`/commits/${oid}/check-runs?per_page=100`)) {
        return structured({total_count: 101, check_runs: Array.from({length: 100}, () => ({
          status: 'completed', conclusion: 'success', completed_at: '2026-07-19T13:04:00Z',
        }))});
      }
      if (request.path.endsWith(`/commits/${oid}/check-runs?per_page=100&page=2`)) {
        return structured({total_count: 101, check_runs: [{
          status: 'completed', conclusion: 'failure', completed_at: '2026-07-19T13:06:00Z',
        }]}, {headers: {'x-ratelimit-remaining': '4980'}});
      }
      throw new Error(`unexpected REST request ${request.path}`);
    },
    graphql: async () => structured({data: {}}),
    git: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport});
  assert.deepEqual(await github.getCommitStatus({repository: 'upstream/project', oid}), {
    status: 200,
    headers: {'x-ratelimit-remaining': '4980'},
    found: true,
    state: 'FAILURE',
    total_count: 102,
    updated_at: '2026-07-19T13:06:00Z',
  });
  assert.equal(requests.length, 3);
});

test('H10c primary exhaustion stops before the Check Runs request', async () => {
  let requests = 0;
  const transport = fakeTransport({
    rest: async () => {
      requests += 1;
      return structured({state: 'success', total_count: 1, statuses: [{
        state: 'success', updated_at: '2026-07-19T13:05:00Z',
      }]}, {headers: {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1784490000'}});
    },
    graphql: async () => structured({data: {}}),
    git: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport});
  assert.deepEqual(await github.getCommitStatus({repository: 'upstream/project', oid: 'b'.repeat(40)}), {
    status: 200,
    headers: {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1784490000'},
    found: true,
    state: 'PENDING',
    total_count: 1,
    updated_at: '2026-07-19T13:05:00Z',
  });
  assert.equal(requests, 1);
});

test('H10d primary exhaustion stops before the next Check Runs page', async () => {
  const oid = 'b'.repeat(40);
  let requests = 0;
  const transport = fakeTransport({
    rest: async (request) => {
      requests += 1;
      if (request.path.endsWith('/status')) return structured({state: 'success', total_count: 1});
      if (request.path.endsWith('/check-runs?per_page=100')) {
        return structured({total_count: 101, check_runs: Array.from({length: 100}, () => ({
          status: 'completed', conclusion: 'success', completed_at: '2026-07-19T13:04:00Z',
        }))}, {headers: {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1784490000'}});
      }
      throw new Error(`unexpected REST request ${request.path}`);
    },
    graphql: async () => structured({data: {}}),
    git: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport});
  const result = await github.getCommitStatus({repository: 'upstream/project', oid});
  assert.equal(result.state, 'PENDING');
  assert.equal(result.total_count, 102);
  assert.equal(requests, 2);
});

test('H10e a failed Check Run overrides successful legacy statuses', async () => {
  const oid = 'b'.repeat(40);
  const transport = fakeTransport({
    rest: async (request) => request.path.endsWith('/status')
      ? structured({state: 'success', total_count: 1})
      : structured({total_count: 1, check_runs: [{status: 'completed', conclusion: 'failure'}]}),
    graphql: async () => structured({data: {}}),
    git: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport});
  const result = await github.getCommitStatus({repository: 'upstream/project', oid});
  assert.equal(result.state, 'FAILURE');
  assert.equal(result.total_count, 2);
});

test('H10f a failed status read stops before requesting Check Runs', async () => {
  let requests = 0;
  const transport = fakeTransport({
    rest: async () => {
      requests += 1;
      return structured({message: 'secondary rate limit'}, {status: 403});
    },
    graphql: async () => structured({data: {}}),
    git: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport});
  await assert.rejects(() => github.getCommitStatus({repository: 'upstream/project', oid: 'b'.repeat(40)}),
    (error) => error instanceof GhCliError && error.status === 403);
  assert.equal(requests, 1);
});

test('H11 missing combined status or attestation remains factual and pending', async () => {
  const transport = fakeTransport({
    rest: async () => structured({message: 'Not Found'}, {status: 404}),
    graphql: async () => structured({data: {}}),
    git: async () => ({code: 0, status: 200, httpStatus: 200, stdout: '', stderr: ''}),
  });
  const github = createGhCliPublisherAdapter({transport});
  assert.deepEqual(await github.getCommitStatus({repository: 'upstream/project', oid: 'b'.repeat(40)}), {
    status: 404, headers: {'x-ratelimit-remaining': '4999'}, found: false, state: null,
  });
  assert.deepEqual(await github.getArtifactAttestation({repository: 'northset-oss/verification-pilot',
    subject_digest: `sha256:${'a'.repeat(64)}`}), {
    status: 404, headers: {'x-ratelimit-remaining': '4999'}, found: false,
    attestation_url: null, attested_at: null,
  });
});
