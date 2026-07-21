import {spawn} from 'node:child_process';
import path from 'node:path';

import {isClaimText} from './claim-detection.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const OVERLAP_TITLE_STOPWORDS = new Set([
  'add', 'adds', 'adding', 'bug', 'feature', 'fix', 'fixes', 'fixed', 'for', 'from',
  'issue', 'mode', 'modes', 'request', 'support', 'the', 'this', 'with',
]);

function titleTerms(value) {
  return new Set(String(value ?? '').toLowerCase().replaceAll(/#[0-9]+/g, ' ')
    .split(/[^a-z0-9]+/).filter((term) => term.length >= 3 && !OVERLAP_TITLE_STOPWORDS.has(term)));
}

function stronglyOverlappingTitles(issueTitle, pullRequestTitle) {
  const issue = titleTerms(issueTitle);
  const pullRequest = titleTerms(pullRequestTitle);
  if (issue.size < 2 || pullRequest.size < 2) return false;
  const common = [...issue].filter((term) => pullRequest.has(term)).length;
  return common >= 2 && common / Math.min(issue.size, pullRequest.size) >= 0.75;
}

export class GhCliError extends Error {
  constructor(message, code, result = {}) {
    super(message);
    this.name = 'GhCliError';
    this.code = code;
    this.result = result;
    this.httpStatus = result.httpStatus ?? result.status ?? 0;
    this.status = this.httpStatus;
    this.headers = result.headers ?? {};
    this.body = result.body ?? null;
    this.stdout = result.stdout ?? '';
    this.stderr = result.stderr ?? '';
    this.signal = result.signal ?? null;
  }
}

function integerOption(value, fallback, label) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) throw new TypeError(`${label} must be a positive integer`);
  return result;
}

function collect(stream, state, field, child, maximum) {
  stream?.on('data', (chunk) => {
    if (state.done) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (state.bytes + buffer.length > maximum) {
      const remaining = Math.max(0, maximum - state.bytes);
      if (remaining) state[field].push(buffer.subarray(0, remaining));
      state.bytes = maximum;
      state.outputLimited = true;
      child.kill('SIGKILL');
      return;
    }
    state.bytes += buffer.length;
    state[field].push(buffer);
  });
}

function commandResult(state, code, signal) {
  return {
    code: Number.isInteger(code) ? code : null,
    signal: signal ?? null,
    stdout: Buffer.concat(state.stdout).toString('utf8'),
    stderr: Buffer.concat(state.stderr).toString('utf8'),
    timedOut: state.timedOut,
    outputLimited: state.outputLimited,
  };
}

function runSpawn(executable, args, {
  spawnImpl,
  cwd,
  env,
  input = null,
  timeoutMs,
  maxOutputBytes,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const state = {
      stdout: [], stderr: [], bytes: 0, timedOut: false, outputLimited: false, done: false,
    };
    collect(child.stdout, state, 'stdout', child, maxOutputBytes);
    collect(child.stderr, state, 'stderr', child, maxOutputBytes);
    const timer = setTimeout(() => {
      if (state.done) return;
      state.timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      if (state.done) return;
      state.done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (state.done) return;
      state.done = true;
      clearTimeout(timer);
      resolve(commandResult(state, code, signal));
    });
    if (input === null || input === undefined) child.stdin.end();
    else child.stdin.end(typeof input === 'string' || Buffer.isBuffer(input) ? input : JSON.stringify(input));
  });
}

function parseHeaders(lines) {
  const headers = {};
  let previous = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && previous) {
      headers[previous] = `${headers[previous]} ${line.trim()}`;
      continue;
    }
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
    previous = name;
  }
  return headers;
}

function jsonOrText(value) {
  if (!value) return null;
  try { return JSON.parse(value); }
  catch { return value; }
}

function numericHeader(headers, name) {
  if (headers[name] === undefined) return null;
  const value = Number(headers[name]);
  return Number.isFinite(value) ? value : null;
}

export function parseGhResponse(result) {
  const normalized = String(result.stdout ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const statusMatches = [...normalized.matchAll(/^HTTP\/\S+\s+(\d{3})(?:\s+[^\n]*)?\n/gm)];
  let status = 0;
  let headers = {};
  let bodyText = normalized;
  if (statusMatches.length) {
    const match = statusMatches.at(-1);
    status = Number(match[1]);
    const headerStart = match.index + match[0].length;
    const headerEnd = normalized.indexOf('\n\n', headerStart);
    if (headerEnd >= 0) {
      headers = parseHeaders(normalized.slice(headerStart, headerEnd).split('\n'));
      bodyText = normalized.slice(headerEnd + 2);
    }
  } else {
    const fallback = /\bHTTP\s+(\d{3})\b/i.exec(String(result.stderr ?? ''));
    if (fallback) status = Number(fallback[1]);
  }
  const body = jsonOrText(bodyText);
  const resetSeconds = numericHeader(headers, 'x-ratelimit-reset');
  const resetDate = resetSeconds === null ? null : new Date(resetSeconds * 1_000);
  const rateLimit = Object.keys(headers).some((name) => name.startsWith('x-ratelimit-')) ? {
    limit: numericHeader(headers, 'x-ratelimit-limit'),
    remaining: numericHeader(headers, 'x-ratelimit-remaining'),
    used: numericHeader(headers, 'x-ratelimit-used'),
    reset: resetSeconds,
    reset_at: resetDate && Number.isFinite(resetDate.getTime()) ? resetDate.toISOString() : null,
    resource: headers['x-ratelimit-resource'] ?? null,
  } : null;
  return {
    ...result,
    status,
    httpStatus: status,
    headers,
    body,
    bodyText,
    rateLimit,
    message: body && typeof body === 'object' && typeof body.message === 'string'
      ? body.message : String(result.stderr ?? '').trim(),
  };
}

function validRepository(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new TypeError(`invalid GitHub repository ${JSON.stringify(repository)}`);
  }
  return repository;
}

function repositoryParts(repository) {
  const value = validRepository(repository);
  const separator = value.indexOf('/');
  return {owner: value.slice(0, separator), name: value.slice(separator + 1)};
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.length) throw new TypeError(`${label} is required`);
  return value;
}

function apiPath(repository, suffix) {
  return `/repos/${validRepository(repository)}/${suffix}`;
}

function ensureSuccess(result, operation, allowed = []) {
  if (result.timedOut) throw new GhCliError(`${operation} timed out`, 'GH_COMMAND_TIMEOUT', result);
  if (result.outputLimited) throw new GhCliError(`${operation} exceeded the output limit`, 'GH_OUTPUT_LIMIT', result);
  if (allowed.includes(result.httpStatus)) return result;
  if (result.code !== 0 || result.httpStatus < 200 || result.httpStatus >= 300) {
    const detail = result.body && typeof result.body === 'object' ? result.body.message : result.stderr;
    throw new GhCliError(`${operation} failed${detail ? `: ${String(detail).trim()}` : ''}`,
      'GH_COMMAND_FAILED', result);
  }
  return result;
}

function rawGitResult(result, operation) {
  const detail = String(result.stderr || result.stdout || '');
  const statusMatch = /(?:requested URL returned error:\s*|\bHTTP(?:\/\S+)?\s+)([45][0-9]{2})\b/i.exec(detail);
  const status = result.code === 0 ? 200 : statusMatch ? Number(statusMatch[1]) : 0;
  const structured = {...result, status, httpStatus: status,
    headers: {}, body: null};
  if (result.timedOut) {
    const error = new GhCliError(`${operation} timed out`, 'ETIMEDOUT', structured);
    error.name = 'TimeoutError';
    error.commandCode = 'GIT_COMMAND_TIMEOUT';
    error.infrastructure = true;
    error.transient = true;
    throw error;
  }
  if (result.outputLimited) throw new GhCliError(`${operation} exceeded the output limit`, 'GIT_OUTPUT_LIMIT', structured);
  if (result.code !== 0) {
    const failureDetail = detail.trim() || `exit ${result.code}`;
    const error = new GhCliError(`${operation} failed: ${failureDetail}`, 'GIT_COMMAND_FAILED', structured);
    if (/connection (?:reset|refused|timed out)|could not resolve host|network is unreachable|remote end hung up/i.test(failureDetail)) {
      error.commandCode = error.code;
      error.code = /could not resolve host/i.test(failureDetail) ? 'EAI_AGAIN' : 'ECONNRESET';
      error.infrastructure = true;
      error.transient = true;
    }
    throw error;
  }
  return structured;
}

/**
 * Low-level production executor for the factory GitHub safety queue.
 *
 * Opaque requests emitted by publisher.mjs carry `execute`; the transport runs
 * that closure only after the safety queue admits it. Recovery probes and
 * explicit REST/GraphQL/git operations are interpreted directly.
 */
export function createGhCliTransport({
  ghExecutable = 'gh',
  gitExecutable = 'git',
  spawnImpl = spawn,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  timeoutMs = integerOption(timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  maxOutputBytes = integerOption(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes');
  if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
  const executionEnv = {...env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0'};

  const run = (executable, args, options = {}) => runSpawn(executable, args, {
    spawnImpl,
    cwd: options.cwd ?? cwd,
    env: executionEnv,
    input: options.input,
    timeoutMs,
    maxOutputBytes,
  });

  const rest = async ({method = 'GET', path: requestPath, body = null}) => {
    requiredString(requestPath, 'REST path');
    const args = ['api', '--include', '--method', String(method).toUpperCase(), requestPath];
    let input = null;
    if (body !== null && body !== undefined) {
      args.push('--input', '-');
      input = `${JSON.stringify(body)}\n`;
    }
    const result = parseGhResponse(await run(ghExecutable, args, {input}));
    if (result.timedOut) {
      const error = new GhCliError('gh api timed out', 'ETIMEDOUT', result);
      error.name = 'TimeoutError';
      throw error;
    }
    if (result.outputLimited) throw new GhCliError('gh api exceeded the output limit', 'GH_OUTPUT_LIMIT', result);
    if (result.code !== 0 && result.httpStatus === 0) {
      throw new GhCliError(`gh api failed: ${result.stderr.trim() || `exit ${result.code}`}`,
        'GH_COMMAND_FAILED', result);
    }
    return result;
  };

  const graphql = async ({query, variables = {}}) => {
    requiredString(query, 'GraphQL query');
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
      throw new TypeError('GraphQL variables must be an object');
    }
    const result = parseGhResponse(await run(ghExecutable,
      ['api', '--include', '--method', 'POST', 'graphql', '--input', '-'],
      {input: `${JSON.stringify({query, variables})}\n`}));
    if (result.timedOut) {
      const error = new GhCliError('gh api graphql timed out', 'ETIMEDOUT', result);
      error.name = 'TimeoutError';
      throw error;
    }
    if (result.outputLimited) throw new GhCliError('gh api graphql exceeded the output limit', 'GH_OUTPUT_LIMIT', result);
    if (result.code !== 0 && result.httpStatus === 0) {
      throw new GhCliError(`gh api graphql failed: ${result.stderr.trim() || `exit ${result.code}`}`,
        'GH_COMMAND_FAILED', result);
    }
    return result;
  };

  const git = async (args, options = {}) => rawGitResult(await run(gitExecutable, args, options),
    options.operation ?? `git ${args[0]}`);

  const transport = async (request = {}) => {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError('GitHub transport request must be an object');
    }
    if (typeof request.execute === 'function') return request.execute();
    switch (request.operation) {
      case 'rate_limit_probe':
        return rest({method: 'GET', path: request.path ?? '/rate_limit'});
      case 'rest':
        return rest(request);
      case 'graphql':
        return graphql(request);
      case 'git_clone': {
        const repository = validRepository(request.repository);
        const destination = requiredString(request.destination, 'clone destination');
        if (!path.isAbsolute(destination)) throw new TypeError('clone destination must be absolute');
        const url = request.url ?? `https://github.com/${repository}.git`;
        if (request.base_oid === undefined || request.base_oid === null) {
          const args = ['clone', '--no-tags', '--no-checkout'];
          if (Number.isInteger(request.depth) && request.depth > 0) args.push('--depth', String(request.depth));
          args.push('--', url, destination);
          const cloned = await git(args, {operation: 'git clone'});
          return {...cloned, repository_path: destination, base_oid: null};
        }
        const baseOid = requiredString(request.base_oid, 'base_oid');
        if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(baseOid)) {
          throw new TypeError('base_oid must be a full commit OID');
        }
        const depth = Number.isInteger(request.depth) && request.depth > 0 ? request.depth : 1;
        const initialized = await git(['init', '--quiet', destination], {operation: 'git init exact base'});
        await git(['-C', destination, 'remote', 'add', 'origin', url], {operation: 'git add origin'});
        await git(['-C', destination, 'fetch', '--no-tags', `--depth=${depth}`, '--', 'origin', baseOid],
          {operation: 'git fetch exact base'});
        const verified = await run(gitExecutable,
          ['-C', destination, 'rev-parse', '--verify', `${baseOid}^{commit}`]);
        const verifiedResult = rawGitResult(verified, 'verify cloned base');
        if (verifiedResult.stdout.trim() !== baseOid) {
          throw new GhCliError(`cloned base resolved to ${verifiedResult.stdout.trim()}, expected ${baseOid}`,
            'CLONED_BASE_MISMATCH', verifiedResult);
        }
        await git(['-C', destination, 'checkout', '--detach', baseOid], {operation: 'checkout exact base'});
        const head = await git(['-C', destination, 'rev-parse', '--verify', 'HEAD^{commit}'],
          {operation: 'verify checked out base'});
        if (head.stdout.trim() !== baseOid) {
          throw new GhCliError(`checked-out HEAD resolved to ${head.stdout.trim()}, expected ${baseOid}`,
            'CHECKED_OUT_BASE_MISMATCH', head);
        }
        return {...initialized, repository_path: destination, base_oid: baseOid, head_oid: baseOid};
      }
      case 'git_fetch': {
        const repositoryPath = requiredString(request.repository_path, 'repository_path');
        const remote = requiredString(request.remote ?? 'origin', 'fetch remote');
        const refspecs = Array.isArray(request.refspecs) ? request.refspecs : [request.refspec].filter(Boolean);
        if (request.depth !== undefined && (!Number.isInteger(request.depth) || request.depth < 1)) {
          throw new TypeError('fetch depth must be a positive integer');
        }
        const args = ['-C', repositoryPath, 'fetch', '--no-tags'];
        if (request.depth !== undefined) args.push(`--depth=${request.depth}`);
        args.push('--', remote, ...refspecs);
        return git(args, {operation: 'git fetch'});
      }
      case 'git_push': {
        const repositoryPath = requiredString(request.repository_path, 'repository_path');
        const remote = requiredString(request.remote, 'push remote');
        const refspec = requiredString(request.refspec, 'push refspec');
        return git(['-C', repositoryPath, 'push', '--porcelain', '--no-force', '--', remote, refspec],
          {operation: 'git push'});
      }
      default:
        throw new TypeError(`unsupported GitHub transport operation ${JSON.stringify(request.operation)}`);
    }
  };
  transport.rest = rest;
  transport.graphql = graphql;
  transport.git = git;
  return transport;
}

function bodyObject(result, operation, allowed = []) {
  ensureSuccess(result, operation, allowed);
  if (!result.body || typeof result.body !== 'object' || Array.isArray(result.body)) {
    throw new GhCliError(`${operation} returned a non-object response`, 'GH_RESPONSE_INVALID', result);
  }
  return result.body;
}

function pullRequest(value, repository) {
  return {
    number: value.number,
    url: value.html_url,
    repository: value.base?.repo?.full_name ?? repository,
    base_branch: value.base?.ref,
    head_branch: value.head?.ref,
    head_oid: value.head?.sha,
    head_repository: value.head?.repo?.full_name ?? null,
    title: value.title,
    body: value.body ?? '',
    state: String(value.state ?? '').toUpperCase(),
    draft: Boolean(value.draft),
    mergeable: value.mergeable ?? null,
    mergeable_state: value.mergeable_state ?? null,
    merged: Boolean(value.merged ?? value.merged_at),
    created_at: value.created_at ?? null,
    updated_at: value.updated_at ?? null,
    closed_at: value.closed_at ?? null,
    merged_at: value.merged_at ?? null,
    merge_commit_oid: value.merge_commit_sha ?? null,
  };
}

function issueNumber(plan) {
  const direct = Number(plan?.issue_number ?? plan?.manifest?.issue_number);
  if (Number.isInteger(direct) && direct > 0) return direct;
  const candidate = String(plan?.task_id ?? plan?.candidate ?? '');
  const match = /#([1-9][0-9]*)$/.exec(candidate);
  if (match) return Number(match[1]);
  throw new TypeError('issue_number is required for final live recheck');
}

function planBaseOid(plan) {
  return plan?.base_oid ?? plan?.base_commit ?? plan?.manifest?.base_oid ?? plan?.manifest?.base_commit ?? null;
}

function recentClaim(comments, northsetLogin, now) {
  const cutoff = now.getTime() - 45 * 24 * 60 * 60 * 1_000;
  return comments.find((comment) => {
    const login = comment?.author?.login;
    const created = Date.parse(comment?.createdAt ?? '');
    return login && login.toLowerCase() !== northsetLogin.toLowerCase() &&
      comment?.author?.__typename !== 'Bot' && !/\[bot\]$/i.test(login) &&
      Number.isFinite(created) && created >= cutoff && isClaimText(comment?.body);
  }) ?? null;
}

const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const STOP_PATTERN = /\b(?:do not|don't|please (?:do not|don't)|stop)\s+(?:submit|open|work|post|create)|\bnot accepting\s+(?:a\s+)?(?:pr|pull request)|\bno\s+(?:pr|pull request)s?\s+(?:please|wanted|accepted)|\bopt(?:ing)?\s+out\b/i;

function maintainerStop(comments) {
  return comments.find((comment) => MAINTAINER_ASSOCIATIONS.has(comment?.authorAssociation) &&
    STOP_PATTERN.test(String(comment?.body ?? ''))) ?? null;
}

const FINAL_RECHECK_QUERY = `query FactoryFinalLiveRecheck(
  $owner: String!, $name: String!, $issue: Int!, $qualifiedBase: String!, $northsetQuery: String!
) {
  repository(owner: $owner, name: $name) {
    nameWithOwner isArchived isFork
    ref(qualifiedName: $qualifiedBase) { target { ... on Commit { oid } } }
    issue(number: $issue) {
      state locked
      labels(first: 50) { nodes { name } }
      assignees(first: 20) { nodes { login } pageInfo { hasNextPage } }
      comments(last: 100) {
        pageInfo { hasPreviousPage }
        nodes { body createdAt authorAssociation author { login __typename } }
      }
      timelineItems(last: 100, itemTypes: [CROSS_REFERENCED_EVENT]) {
        pageInfo { hasPreviousPage }
        nodes {
          ... on CrossReferencedEvent {
            source {
              __typename
              ... on PullRequest {
                number state isDraft headRefName baseRefName headRefOid
                repository { nameWithOwner }
              }
            }
          }
        }
      }
    }
  }
  northset: search(query: $northsetQuery, type: ISSUE, first: 20) {
    issueCount
    nodes {
      ... on PullRequest {
        number state isDraft headRefName baseRefName headRefOid
        repository { nameWithOwner }
      }
    }
  }
}`;

const FOLLOW_UP_QUERY = `query FactoryPullRequestFollowUp($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    owner { login __typename }
    pullRequest(number: $number) {
      number url reviewDecision author { login }
      comments(last: 100) {
        pageInfo { hasPreviousPage }
        nodes { url body createdAt updatedAt authorAssociation author { login __typename } }
      }
      reviews(last: 100) {
        pageInfo { hasPreviousPage }
        nodes {
          url body state submittedAt authorAssociation commit { oid }
          author { login __typename }
        }
      }
      reviewThreads(first: 20) {
        pageInfo { hasNextPage }
        nodes {
          isResolved isOutdated path line originalLine
          comments(last: 20) {
            pageInfo { hasPreviousPage }
            nodes { url body createdAt updatedAt authorAssociation author { login __typename } }
          }
        }
      }
    }
  }
}`;

const OPEN_PULL_REQUESTS_QUERY = `query FactoryOpenPullRequests($owner: String!, $name: String!, $limit: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequests(first: $limit, states: OPEN, orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes {
        number title url authorAssociation createdAt updatedAt isCrossRepository mergeable reviewDecision
        author { login }
        reviews(first: 1) { totalCount }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

function followUpActor(value) {
  return {
    author_login: value?.author?.login ?? null,
    author_type: value?.author?.__typename ?? null,
    author_association: value?.authorAssociation ?? null,
  };
}

function followUpComment(value) {
  return {
    ...followUpActor(value),
    url: value?.url ?? null,
    body: value?.body ?? '',
    created_at: value?.createdAt ?? null,
    updated_at: value?.updatedAt ?? null,
  };
}

/** Raw semantic operations. Callers must admit each method through GitHubSafety. */
export function createGhCliPublisherAdapter({
  transport = createGhCliTransport(),
  northsetLogin = 'AysajanE',
  now = () => new Date(),
  forkRemote = (repository) => `https://github.com/${repository}.git`,
} = {}) {
  if (typeof transport !== 'function' || typeof transport.rest !== 'function' ||
      typeof transport.graphql !== 'function' || typeof transport.git !== 'function') {
    throw new TypeError('transport must be created by createGhCliTransport');
  }
  if (typeof northsetLogin !== 'string' || !northsetLogin) throw new TypeError('northsetLogin is required');

  const forkRepository = (result, repository, upstreamRepository, operation) => {
    const body = bodyObject(result, operation);
    const actual = requiredString(body.full_name, `${operation} full_name`);
    const parent = body.parent?.full_name ?? body.source?.full_name ?? null;
    if (actual.toLowerCase() !== validRepository(repository).toLowerCase() || body.fork !== true ||
        typeof parent !== 'string' || parent.toLowerCase() !== validRepository(upstreamRepository).toLowerCase()) {
      throw new GhCliError(
        `${operation} returned ${actual} with parent ${String(parent)}, expected fork ${repository} of ${upstreamRepository}`,
        'FORK_REPOSITORY_MISMATCH', result,
      );
    }
    return {status: result.httpStatus, headers: result.headers, found: true,
      repository: actual, upstream_repository: parent};
  };

  const getFork = async ({repository, upstream_repository: upstreamRepository}) => {
    validRepository(repository);
    validRepository(upstreamRepository);
    const result = await transport.rest({method: 'GET', path: `/repos/${validRepository(repository)}`});
    if (result.httpStatus === 404) return {status: 404, headers: result.headers, found: false};
    return forkRepository(result, repository, upstreamRepository, 'get fork');
  };

  const createFork = async ({repository, upstream_repository: upstreamRepository}) => {
    const fork = repositoryParts(repository);
    const upstream = repositoryParts(upstreamRepository);
    if (fork.name.toLowerCase() !== upstream.name.toLowerCase()) {
      throw new TypeError(`fork repository name ${fork.name} must match upstream name ${upstream.name}`);
    }
    const body = fork.owner.toLowerCase() === northsetLogin.toLowerCase()
      ? null : {organization: fork.owner};
    const result = await transport.rest({method: 'POST', path: apiPath(upstreamRepository, 'forks'), body});
    return forkRepository(result, repository, upstreamRepository, 'create fork');
  };

  const getBranch = async ({repository, branch}) => {
    requiredString(branch, 'branch');
    const result = await transport.rest({method: 'GET',
      path: apiPath(repository, `git/ref/heads/${encodeURIComponent(branch)}`)});
    if (result.httpStatus === 404) return {status: 404, headers: result.headers, found: false};
    const body = bodyObject(result, 'get branch');
    const oid = requiredString(body.object?.sha, 'branch object SHA');
    return {status: result.httpStatus, headers: result.headers, found: true, oid};
  };

  const pushBranch = async ({repository, repository_path: repositoryPath, branch, oid, force = false}) => {
    validRepository(repository);
    if (force !== false) throw new TypeError('factory branch pushes must never force');
    if (!path.isAbsolute(requiredString(repositoryPath, 'repository_path'))) {
      throw new TypeError('repository_path must be absolute');
    }
    requiredString(branch, 'branch');
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(String(oid))) throw new TypeError('oid must be a full commit OID');
    await transport.git(['check-ref-format', `refs/heads/${branch}`], {operation: 'validate branch'});
    const local = await transport.git(['-C', repositoryPath, 'rev-parse', '--verify', `${oid}^{commit}`],
      {operation: 'verify local commit'});
    const resolved = local.stdout.trim();
    if (resolved !== oid) throw new GhCliError(`local commit resolved to ${resolved}, expected ${oid}`,
      'LOCAL_COMMIT_MISMATCH', local);
    const remote = forkRemote(repository);
    const pushed = await transport({operation: 'git_push', repository_path: repositoryPath,
      remote, refspec: `${oid}:refs/heads/${branch}`});
    return {status: pushed.httpStatus, oid, repository, branch};
  };

  const findPullRequests = async ({repository, fork_repository: forkRepository, branch, base_branch: baseBranch}) => {
    const forkOwner = repositoryParts(forkRepository).owner;
    validRepository(repository);
    const query = new URLSearchParams({state: 'all', head: `${forkOwner}:${requiredString(branch, 'branch')}`,
      base: requiredString(baseBranch, 'base_branch'), per_page: '100'});
    const result = await transport.rest({method: 'GET', path: `${apiPath(repository, 'pulls')}?${query}`});
    ensureSuccess(result, 'find pull requests');
    if (!Array.isArray(result.body)) throw new GhCliError('find pull requests returned a non-array response',
      'GH_RESPONSE_INVALID', result);
    return {status: result.httpStatus, headers: result.headers,
      pull_requests: result.body.map((pr) => pullRequest(pr, repository))};
  };

  const findOpenPullRequests = async (repository, {limit = 30} = {}) => {
    const normalizedRepository = validRepository(repository);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('open pull request limit must be an integer from 1 through 100');
    }
    const {owner, name} = repositoryParts(normalizedRepository);
    const result = await transport.graphql({
      query: OPEN_PULL_REQUESTS_QUERY,
      variables: {owner, name, limit},
    });
    const body = bodyObject(result, 'find open pull requests');
    if (Array.isArray(body.errors) && body.errors.length) {
      throw new GhCliError(`find open pull requests failed: ${body.errors.map((item) => item.message).join('; ')}`,
        'GH_GRAPHQL_ERROR', result);
    }
    const repo = body.data?.repository;
    if (!repo || String(repo.nameWithOwner).toLowerCase() !== normalizedRepository.toLowerCase() ||
        !Array.isArray(repo.pullRequests?.nodes)) {
      throw new GhCliError('find open pull requests returned an invalid repository response',
        'GH_RESPONSE_INVALID', result);
    }
    return {
      status: result.httpStatus,
      headers: result.headers,
      owner_login: repo.owner?.login ?? owner,
      owner_type: repo.owner?.__typename ?? null,
      pull_requests: repo.pullRequests.nodes.map((pr) => ({
        number: Number(pr.number),
        title: pr.title,
        url: pr.url,
        author_login: pr.author?.login ?? null,
        author_association: pr.authorAssociation ?? null,
        created_at: pr.createdAt ?? null,
        updated_at: pr.updatedAt ?? null,
        is_cross_repository: pr.isCrossRepository === true,
        mergeable: pr.mergeable ?? null,
        review_decision: pr.reviewDecision ?? null,
        reviewer_count: Number(pr.reviews?.totalCount ?? 0),
        ci_state: pr.commits?.nodes?.at(-1)?.commit?.statusCheckRollup?.state ?? null,
      })),
    };
  };

  const createPullRequest = async ({
    repository, fork_repository: forkRepository, branch, base_branch: baseBranch,
    head_oid: headOid, title, body,
  }) => {
    const forkOwner = repositoryParts(forkRepository).owner;
    validRepository(repository);
    const payload = {
      title: requiredString(title, 'pull request title'),
      head: `${forkOwner}:${requiredString(branch, 'branch')}`,
      base: requiredString(baseBranch, 'base_branch'),
      body: requiredString(body, 'pull request body'),
      draft: false,
      maintainer_can_modify: true,
    };
    const result = await transport.rest({method: 'POST', path: apiPath(repository, 'pulls'), body: payload});
    const pr = pullRequest(bodyObject(result, 'create pull request'), repository);
    if (pr.head_oid !== requiredString(headOid, 'head_oid')) {
      throw new GhCliError(`created PR head ${pr.head_oid} does not match approved ${headOid}`,
        'PR_HEAD_MISMATCH', result);
    }
    return {status: result.httpStatus, headers: result.headers, ...pr};
  };

  const updatePullRequest = async ({repository, number, head_oid: headOid, title, body}) => {
    if (!Number.isInteger(Number(number)) || Number(number) < 1) {
      throw new TypeError('PR number must be positive');
    }
    const payload = {
      title: requiredString(title, 'pull request title'),
      body: requiredString(body, 'pull request body'),
    };
    const result = await transport.rest({method: 'PATCH',
      path: apiPath(repository, `pulls/${Number(number)}`), body: payload});
    const pr = pullRequest(bodyObject(result, 'update pull request'), repository);
    if (pr.head_oid !== requiredString(headOid, 'head_oid')) {
      throw new GhCliError(`updated PR head ${pr.head_oid} does not match approved ${headOid}`,
        'PR_HEAD_MISMATCH', result);
    }
    return {status: result.httpStatus, headers: result.headers, ...pr};
  };

  const getPullRequest = async ({repository, number}) => {
    if (!Number.isInteger(Number(number)) || Number(number) < 1) throw new TypeError('PR number must be positive');
    const result = await transport.rest({method: 'GET', path: apiPath(repository, `pulls/${Number(number)}`)});
    return {status: result.httpStatus, headers: result.headers,
      ...pullRequest(bodyObject(result, 'get pull request'), repository)};
  };

  const getPullRequestFollowUp = async ({repository, number}) => {
    if (!Number.isInteger(Number(number)) || Number(number) < 1) throw new TypeError('PR number must be positive');
    const {owner, name} = repositoryParts(repository);
    const result = await graphql(FOLLOW_UP_QUERY, {owner, name, number: Number(number)});
    const repo = result.data?.repository;
    const pr = repo?.pullRequest;
    if (!pr || Number(pr.number) !== Number(number) ||
        String(repo?.nameWithOwner ?? '').toLowerCase() !== repository.toLowerCase()) {
      throw new GhCliError('pull request follow-up response does not match the requested PR',
        'GH_RESPONSE_INVALID');
    }
    const comments = pr.comments?.nodes ?? [];
    const reviews = (pr.reviews?.nodes ?? []).map((review) => ({
      ...followUpActor(review),
      url: review?.url ?? null,
      body: review?.body ?? '',
      state: review?.state ?? null,
      submitted_at: review?.submittedAt ?? null,
      commit_oid: review?.commit?.oid ?? null,
    }));
    const threads = (pr.reviewThreads?.nodes ?? []).map((thread) => ({
      is_resolved: thread?.isResolved === true,
      is_outdated: thread?.isOutdated === true,
      path: thread?.path ?? null,
      line: thread?.line ?? null,
      original_line: thread?.originalLine ?? null,
      comments: (thread?.comments?.nodes ?? []).map(followUpComment),
      history_truncated: thread?.comments?.pageInfo?.hasPreviousPage === true,
    }));
    return {
      number: Number(pr.number),
      url: pr.url ?? null,
      author_login: pr.author?.login ?? null,
      review_decision: pr.reviewDecision ?? null,
      comments: comments.map(followUpComment),
      reviews,
      threads,
      history_truncated: pr.comments?.pageInfo?.hasPreviousPage === true ||
        pr.reviews?.pageInfo?.hasPreviousPage === true ||
        pr.reviewThreads?.pageInfo?.hasNextPage === true ||
        threads.some((thread) => thread.history_truncated),
    };
  };

  const getPullRequestCommits = async ({repository, number}) => {
    if (!Number.isInteger(Number(number)) || Number(number) < 1) throw new TypeError('PR number must be positive');
    const commits = [];
    for (let page = 1; page <= 3; page += 1) {
      const result = await transport.rest({method: 'GET',
        path: `${apiPath(repository, `pulls/${Number(number)}/commits`)}?per_page=100&page=${page}`});
      ensureSuccess(result, 'get pull request commits');
      if (!Array.isArray(result.body)) {
        throw new GhCliError('get pull request commits returned a non-array response',
          'GH_RESPONSE_INVALID', result);
      }
      for (const commit of result.body) {
        if (typeof commit?.sha !== 'string') {
          throw new GhCliError('get pull request commits returned a commit without an OID',
            'GH_RESPONSE_INVALID', result);
        }
        commits.push(commit.sha.toLowerCase());
      }
      if (result.body.length < 100) return {commits};
    }
    throw new GhCliError('pull request commit list exceeded GitHub maximum page count',
      'GH_RESPONSE_INVALID');
  };

  const getCommitStatus = async ({repository, oid}) => {
    validRepository(repository);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(String(oid ?? ''))) {
      throw new TypeError('commit status oid must be a full commit OID');
    }
    const normalizedOid = String(oid).toLowerCase();
    const statusResult = await transport.rest({method: 'GET', path: apiPath(repository,
      `commits/${normalizedOid}/status`)});
    const statusBody = statusResult.httpStatus === 404
      ? null : bodyObject(statusResult, 'get combined commit status');
    const legacyState = typeof statusBody?.state === 'string' && statusBody.state
      ? statusBody.state.toUpperCase() : null;
    const legacyCount = Number.isInteger(Number(statusBody?.total_count))
      ? Number(statusBody.total_count) : 0;
    const legacyUpdatedAt = [statusBody?.updated_at,
      ...(Array.isArray(statusBody?.statuses) ? statusBody.statuses.map((status) => status?.updated_at) : [])]
      .filter(Boolean).sort().at(-1) ?? null;
    if (Number(statusResult.headers?.['x-ratelimit-remaining']) === 0) {
      return {
        status: statusResult.httpStatus,
        headers: statusResult.headers,
        found: legacyState !== null,
        state: legacyState === null ? null : 'PENDING',
        total_count: legacyCount,
        updated_at: legacyUpdatedAt,
      };
    }
    let checksResult = await transport.rest({method: 'GET', path: apiPath(repository,
      `commits/${normalizedOid}/check-runs?per_page=100`)});
    const checksBody = checksResult.httpStatus === 404
      ? null : bodyObject(checksResult, 'get check runs');
    if (!statusBody && !checksBody) {
      return {status: 404, headers: checksResult.headers, found: false, state: null};
    }
    const checkRuns = Array.isArray(checksBody?.check_runs) ? [...checksBody.check_runs] : [];
    const checkCount = Number.isInteger(Number(checksBody?.total_count))
      ? Number(checksBody.total_count) : checkRuns.length;
    for (let page = 2; checksBody && page <= Math.ceil(checkCount / 100); page += 1) {
      if (Number(checksResult.headers?.['x-ratelimit-remaining']) === 0) break;
      checksResult = await transport.rest({method: 'GET', path: apiPath(repository,
        `commits/${normalizedOid}/check-runs?per_page=100&page=${page}`)});
      const pageBody = bodyObject(checksResult, `get check runs page ${page}`);
      if (Array.isArray(pageBody.check_runs)) checkRuns.push(...pageBody.check_runs);
    }
    const failureConclusions = new Set([
      'ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'STALE', 'STARTUP_FAILURE', 'TIMED_OUT',
    ]);
    const successConclusions = new Set(['NEUTRAL', 'SKIPPED', 'SUCCESS']);
    const checkFailure = checkRuns.some((run) =>
      failureConclusions.has(String(run?.conclusion ?? '').toUpperCase()));
    const checkPending = checkCount > checkRuns.length || checkRuns.some((run) => {
      if (String(run?.status ?? '').toUpperCase() !== 'COMPLETED') return true;
      return !successConclusions.has(String(run?.conclusion ?? '').toUpperCase()) &&
        !failureConclusions.has(String(run?.conclusion ?? '').toUpperCase());
    });
    let state = null;
    if ((legacyCount > 0 && ['ERROR', 'FAILURE'].includes(legacyState)) || checkFailure) {
      state = 'FAILURE';
    } else if ((legacyCount > 0 && legacyState === 'PENDING') || checkPending) {
      state = 'PENDING';
    } else if (legacyCount > 0 || checkCount > 0) {
      state = 'SUCCESS';
    } else {
      state = legacyState;
    }
    const updatedAt = [legacyUpdatedAt,
      ...checkRuns.map((run) => run?.completed_at ?? run?.started_at ?? null)]
      .filter(Boolean).sort().at(-1) ?? null;
    return {
      status: statusBody ? statusResult.httpStatus : checksResult.httpStatus,
      headers: checksResult.headers,
      found: state !== null,
      state,
      total_count: legacyCount + checkCount,
      updated_at: updatedAt,
    };
  };

  const getArtifactAttestation = async ({repository, subject_digest: subjectDigest}) => {
    validRepository(repository);
    if (!/^sha256:[a-f0-9]{64}$/.test(String(subjectDigest ?? ''))) {
      throw new TypeError('attestation subject_digest must be a sha256 digest');
    }
    const suffix = `attestations/${encodeURIComponent(subjectDigest)}`;
    const result = await transport.rest({method: 'GET', path: apiPath(repository, suffix)});
    if (result.httpStatus === 404) {
      return {status: 404, headers: result.headers, found: false, attestation_url: null, attested_at: null};
    }
    const body = bodyObject(result, 'get artifact attestations');
    const attestations = Array.isArray(body.attestations) ? body.attestations : [];
    const attestation = attestations[0] ?? null;
    if (!attestation) {
      return {status: result.httpStatus, headers: result.headers, found: false,
        attestation_url: null, attested_at: null};
    }
    const attestationUrl = attestation.html_url ?? attestation.attestation_url ?? attestation.url ??
      `https://api.github.com/${apiPath(repository, suffix).replace(/^\//, '')}`;
    return {
      status: result.httpStatus,
      headers: result.headers,
      found: true,
      attestation_url: attestationUrl,
      attested_at: attestation.created_at ?? body.created_at ?? null,
      attestation,
    };
  };

  const graphql = async (query, variables = {}) => {
    const result = await transport.graphql({query, variables});
    ensureSuccess(result, 'GraphQL request');
    if (!result.body || typeof result.body !== 'object' || Array.isArray(result.body)) {
      throw new GhCliError('GraphQL returned a non-object response', 'GH_RESPONSE_INVALID', result);
    }
    if (Array.isArray(result.body.errors) && result.body.errors.length) {
      throw new GhCliError(`GraphQL failed: ${result.body.errors.map((item) => item.message).join('; ')}`,
        'GH_GRAPHQL_ERROR', result);
    }
    return result.body;
  };

  const finalLiveRecheck = async (plan) => {
    const repository = validRepository(plan?.repository);
    const {owner, name} = repositoryParts(repository);
    const issue = issueNumber(plan);
    const baseBranch = requiredString(plan?.base_branch ?? plan?.manifest?.base_branch, 'base_branch');
    const expectedBaseOid = planBaseOid(plan);
    if (typeof expectedBaseOid !== 'string' || !expectedBaseOid) {
      return {clean: false, reason: 'approved base OID is missing'};
    }
    const branch = requiredString(plan?.branch ?? plan?.manifest?.branch ??
      `northset/${String(plan?.mission_id ?? '').toLowerCase()}`, 'branch');
    const result = await graphql(FINAL_RECHECK_QUERY, {
      owner, name, issue,
      qualifiedBase: `refs/heads/${baseBranch}`,
      northsetQuery: `repo:${repository} is:pr is:open author:${northsetLogin}`,
    });
    const repo = result.data?.repository;
    const issueState = repo?.issue;
    const reasons = [];
    if (!repo) reasons.push('repository is missing or inaccessible');
    if (repo?.isArchived || repo?.isFork) reasons.push('repository is archived or is a fork');
    if (!issueState) reasons.push('issue is missing or inaccessible');
    if (issueState?.state !== 'OPEN') reasons.push(`issue is ${String(issueState?.state ?? 'missing').toLowerCase()}`);
    if (issueState?.locked) reasons.push('issue is locked');
    const invitationLabels = (issueState?.labels?.nodes ?? []).map((item) => String(item?.name ?? ''));
    const approvedInvitationLabels = new Set((plan?.invitation_labels ?? []).map((label) =>
      String(label).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()));
    const invited = plan?.invitation_policy_present === true || invitationLabels.some((label) => {
      const normalized = label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return normalized.includes('good first issue') || normalized.endsWith('help wanted') ||
        approvedInvitationLabels.has(normalized);
    });
    if (issueState && !invited) reasons.push('invitation label or policy is missing');
    const assignees = issueState?.assignees?.nodes ?? [];
    const externalAssignees = assignees.filter((item) =>
      item.login?.toLowerCase() !== northsetLogin.toLowerCase());
    if (externalAssignees.length || issueState?.assignees?.pageInfo?.hasNextPage) {
      reasons.push(`issue is assigned${externalAssignees.length ? ` to ${externalAssignees.map((item) => item.login).join(', ')}` : ''}`);
    }
    const currentBaseOid = repo?.ref?.target?.oid ?? null;
    const amendment = plan?.amendment;
    const amendmentPr = amendment ? (result.data?.northset?.nodes ?? []).find((item) =>
      item?.repository?.nameWithOwner === repository && Number(item.number) === Number(amendment.number) &&
      item.headRefName === branch) : null;
    const baseChanged = amendment ? false : currentBaseOid !== expectedBaseOid;
    if (amendment && !amendmentPr) {
      reasons.push(`existing amendment PR #${amendment.number} is no longer open on ${branch}`);
    } else if (amendment && amendmentPr.headRefOid !== amendment.head_oid) {
      reasons.push(`existing amendment PR head moved from ${amendment.head_oid} to ${amendmentPr.headRefOid}`);
    } else if (amendment && amendmentPr.baseRefName !== baseBranch) {
      reasons.push(`existing amendment PR base moved from ${baseBranch} to ${amendmentPr.baseRefName}`);
    } else if (baseChanged) {
      reasons.push(`base branch moved from ${expectedBaseOid} to ${currentBaseOid}`);
    }
    if (issueState?.comments?.pageInfo?.hasPreviousPage) reasons.push('issue comment history is truncated');
    if (issueState?.timelineItems?.pageInfo?.hasPreviousPage) reasons.push('issue cross-reference history is truncated');
    const linkedOpen = (issueState?.timelineItems?.nodes ?? []).map((item) => item?.source)
      .filter((item) => item?.__typename === 'PullRequest' && item.state === 'OPEN' &&
        !(item.repository?.nameWithOwner === repository && item.headRefName === branch));
    if (linkedOpen.length) reasons.push(`linked open competing PR exists: ${linkedOpen.map((item) => `#${item.number}`).join(', ')}`);
    const claim = recentClaim(issueState?.comments?.nodes ?? [], northsetLogin, now());
    if (claim) reasons.push(`active external claim by ${claim.author.login}`);
    const stop = maintainerStop(issueState?.comments?.nodes ?? []);
    if (stop) reasons.push(`maintainer requested no submission${stop.author?.login ? `: ${stop.author.login}` : ''}`);
    const northsetPrs = (result.data?.northset?.nodes ?? []).filter((item) =>
      item?.repository?.nameWithOwner === repository && item.headRefName !== branch);
    const repositoryOpenOverride = typeof plan?.mission_id === 'string' &&
      plan?.repositoryOpenOverrideMissionId === plan.mission_id;
    if (!repositoryOpenOverride && (northsetPrs.length || Number(result.data?.northset?.issueCount ?? 0) >
        (result.data?.northset?.nodes ?? []).filter((item) => item?.headRefName === branch).length)) {
      reasons.push('Northset already has another open PR in the repository');
    }
    return {clean: reasons.length === 0, reason: reasons.join('; ') || null,
      base_oid: currentBaseOid, current_base_oid: currentBaseOid,
      base_changed: baseChanged,
      refreshable: baseChanged && reasons.length === 1,
      cooldown: stop ? {reason: 'explicit maintainer stop/opt-out', until: 'manual-release'} : null,
      issue_state: issueState?.state ?? null};
  };

  const deepOverlap = async (liveCandidate) => {
    const repository = validRepository(liveCandidate?.repository?.nameWithOwner ??
      liveCandidate?.candidate?.repository ?? liveCandidate?.repository ?? liveCandidate?.liveState?.repository?.nameWithOwner);
    const number = Number(liveCandidate?.issue?.number ?? liveCandidate?.candidate?.issueNumber ??
      liveCandidate?.issueNumber ?? liveCandidate?.liveState?.issue?.number);
    if (!Number.isInteger(number) || number < 1) throw new TypeError('deep overlap requires issue number');
    const issueTitle = liveCandidate?.issue?.title ?? liveCandidate?.liveState?.issue?.title ?? '';
    const mergedOverlap = (liveCandidate?.issue?.crossReferencedPrs ??
      liveCandidate?.liveState?.issue?.crossReferencedPrs ?? []).find((pullRequest) =>
      pullRequest?.state === 'MERGED' && stronglyOverlappingTitles(issueTitle, pullRequest.title));
    if (mergedOverlap) {
      return {clean: false,
        reason: `merged overlapping PR already implements the issue: ${mergedOverlap.url ?? `#${mergedOverlap.number}`}`};
    }
    const {owner, name} = repositoryParts(repository);
    const knownText = `${liveCandidate?.issue?.title ?? ''}\n${liveCandidate?.issue?.body ?? ''}`;
    const mentioned = [...knownText.matchAll(/(?:^|[^A-Za-z0-9])#([1-9][0-9]*)\b/g)]
      .map((match) => Number(match[1])).filter((value, index, values) => values.indexOf(value) === index).slice(0, 10);
    const mentionedFields = mentioned.map((pr, index) =>
      `p${index}: issueOrPullRequest(number: ${pr}) {
        __typename
        ... on PullRequest { number state isDraft url }
      }`).join('\n');
    const query = `query FactoryDeepOverlap($owner: String!, $name: String!, $issue: Int!) {
      repository(owner: $owner, name: $name) {
        issue(number: $issue) {
          timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT]) {
            pageInfo { hasNextPage }
            nodes {
              ... on CrossReferencedEvent {
                source { __typename ... on PullRequest { number state isDraft url } }
              }
            }
          }
        }
        ${mentionedFields}
      }
    }`;
    let result;
    try {
      result = await graphql(query, {owner, name, issue: number});
    } catch (error) {
      const partial = error?.body;
      const errors = partial?.errors;
      const onlyMissingMentionedNumbers = partial?.data && Array.isArray(errors) && errors.length > 0 &&
        errors.every((item) => item?.type === 'NOT_FOUND' && Array.isArray(item.path) &&
          item.path.length === 2 && item.path[0] === 'repository' && /^p[0-9]+$/.test(item.path[1]));
      if (!onlyMissingMentionedNumbers) throw error;
      result = partial;
    }
    const repo = result.data?.repository;
    const timeline = repo?.issue?.timelineItems;
    if (!repo?.issue) return {clean: false, reason: 'issue is missing or inaccessible'};
    if (timeline?.pageInfo?.hasNextPage) return {clean: false, reason: 'cross-reference history remains truncated'};
    const linked = (timeline?.nodes ?? []).map((item) => item?.source)
      .filter((item) => item?.__typename === 'PullRequest' && item.state === 'OPEN');
    const referenced = mentioned.map((_, index) => repo[`p${index}`])
      .filter((item) => item?.__typename === 'PullRequest' && item.state === 'OPEN');
    const overlaps = [...linked, ...referenced].filter((item, index, values) =>
      values.findIndex((other) => other.number === item.number) === index);
    return overlaps.length ? {clean: false,
      reason: `open overlapping PR exists: ${overlaps.map((item) => item.url ?? `#${item.number}`).join(', ')}`}
      : {clean: true, reason: null};
  };

  return {getFork, createFork, getBranch, pushBranch, findPullRequests, findOpenPullRequests,
    createPullRequest, updatePullRequest,
    getPullRequest, getPullRequestFollowUp,
    getPullRequestCommits, getCommitStatus, getArtifactAttestation, graphql, finalLiveRecheck, deepOverlap};
}
