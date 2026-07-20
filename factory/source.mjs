import {spawn} from 'node:child_process';
import path from 'node:path';

import {isClaimText} from './claim-detection.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const DISCOVERY_TTL_MS = 14 * DAY_MS;
const DEFAULT_EXPECTED_MINUTES = 12;

function assertWorkers(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error('workers must be an integer from 1 through 100');
  }
}

function boundedLimit(workers, requested) {
  assertWorkers(workers);
  const defaultLimit = 2 * workers;
  const hardLimit = 4 * workers;
  if (requested === undefined || requested === null) return defaultLimit;
  if (!Number.isInteger(requested) || requested < 1) throw new Error('limit must be a positive integer');
  return Math.min(requested, hardLimit);
}

function sqliteQuery(database, source, {sqliteBin = 'sqlite3'} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(sqliteBin, ['-json', path.resolve(database)], {stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`candidate lake query failed: ${(stderr || stdout).trim() || `exit ${code}`}`));
        return;
      }
      try { resolve(stdout.trim() ? JSON.parse(stdout) : []); }
      catch (error) { reject(new Error(`candidate lake returned invalid JSON: ${error.message}`)); }
    });
    child.stdin.end(`.timeout 5000\n${source}\n`);
  });
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); }
  catch { return fallback; }
}

function canonicalCandidate(value) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(String(value ?? ''));
  if (!match) throw new Error(`invalid candidate ${JSON.stringify(value)}; expected owner/repo#123`);
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}#${match[3]}`;
}

function candidateParts(value) {
  const canonical = canonicalCandidate(value);
  const match = /^([^/]+)\/([^#]+)#([0-9]+)$/.exec(canonical);
  return {candidate: canonical, owner: match[1], repo: match[2], issueNumber: Number(match[3])};
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function readyPerMinutePriority(mechanicalScore, stats = {}) {
  const score = Number.isFinite(Number(mechanicalScore)) ? Number(mechanicalScore) : 50;
  const priorProbability = clamp(score / 120, 0.08, 0.92);
  const attempts = Math.max(0, Number(stats.attempts ?? stats.attempt_count ?? 0));
  const ready = clamp(Number(stats.ready ?? stats.ready_count ?? 0), 0, attempts);
  const probability = attempts > 0
    ? (ready + 2 * priorProbability) / (attempts + 2)
    : priorProbability;
  const durationMs = Number(stats.average_duration_ms ?? stats.avg_duration_ms);
  const expectedMinutes = Number.isFinite(durationMs) && durationMs > 0
    ? Math.max(1, durationMs / 60_000)
    : DEFAULT_EXPECTED_MINUTES;
  return probability / expectedMinutes;
}

function statsFor(candidate, attemptStats) {
  if (typeof attemptStats === 'function') return attemptStats(candidate) ?? {};
  if (attemptStats instanceof Map) return attemptStats.get(candidate) ?? attemptStats.get(candidate.toLowerCase()) ?? {};
  return attemptStats?.[candidate] ?? attemptStats?.[candidate.toLowerCase()] ?? {};
}

function invitationDetails(row, raw) {
  const labelMap = parseJson(row.invitation_label_map_json, {});
  const customLabels = Object.entries(labelMap)
    .filter(([, enabled]) => enabled === true || enabled?.enabled === true)
    .map(([label]) => label);
  return {
    invitationKind: row.invitation_kind ?? raw.invitation_kind ?? null,
    invitationLabels: customLabels,
    invitationPolicyPresent: Boolean(
      row.invitation_kind === 'repository_policy' ||
      raw.invitation_kind === 'repository_policy' ||
      raw.invitation_evidence?.type === 'repository_policy',
    ),
  };
}

function normalizeLakeRow(row, attemptStats) {
  const parts = candidateParts(row.candidate_display ?? row.candidate ?? row.candidate_key);
  const raw = parseJson(row.raw_json ?? row.raw, {});
  const priority = readyPerMinutePriority(row.mechanical_score, statsFor(parts.candidate, attemptStats));
  return {
    candidate: parts.candidate,
    repository: String(row.repo_display ?? raw.repository?.name_with_owner ?? `${parts.owner}/${parts.repo}`),
    repositoryNodeId: row.repository_node_id ?? raw.repository?.node_id ?? null,
    issueNumber: parts.issueNumber,
    issueNodeId: row.issue_node_id ?? raw.issue?.node_id ?? null,
    profile: 'node',
    mechanicalScore: Number(row.mechanical_score ?? 0),
    priority,
    discoveredAt: row.last_hydrated_at ?? row.updated_at ?? null,
    discovery: raw,
    ...invitationDetails(row, raw),
  };
}

export async function selectCandidates({
  lakePath = 'candidate_lake.sqlite',
  query = (sql) => sqliteQuery(lakePath, sql),
  workers,
  limit,
  excludeCandidates = [],
  attemptStats = {},
  now = new Date(),
} = {}) {
  const selectedLimit = boundedLimit(workers, limit);
  const excluded = new Set(excludeCandidates.map((candidate) => canonicalCandidate(candidate)));
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('now must be a valid Date');
  const cutoff = new Date(now.getTime() - DISCOVERY_TTL_MS).toISOString();
  const rows = await query(`SELECT
    i.candidate_display, i.candidate_key, i.issue_number, i.issue_node_id, i.profile,
    i.state, i.mechanical_score, i.mechanical_reasons_json, i.last_hydrated_at,
    i.invitation_kind, i.raw_json,
    r.repo_display, r.repository_node_id, r.test_profile, r.invitation_label_map_json
  FROM issues i
  JOIN repositories r ON r.repo_key=i.repo_key
  WHERE COALESCE(i.state,'OPEN') IN ('OPEN','open','REVIEWED')
    AND (i.profile='node' OR r.test_profile='node'
      OR (i.profile IS NULL AND r.test_profile IS NULL))
    AND i.mechanical_reasons_json='[]'
    AND i.last_hydrated_at >= '${cutoff.replaceAll("'", "''")}'
  ORDER BY COALESCE(i.mechanical_score,-999999) DESC,
    COALESCE(i.issue_updated_at,'') DESC, i.candidate_key ASC;`);

  return rows
    .filter((row) => {
      const observed = Date.parse(row.last_hydrated_at ?? '');
      const reasons = parseJson(row.mechanical_reasons_json, []);
      const profile = row.profile ?? row.test_profile ?? 'node';
      return profile === 'node' && Array.isArray(reasons) && reasons.length === 0 &&
        Number.isFinite(observed) && observed >= now.getTime() - DISCOVERY_TTL_MS &&
        ['OPEN', 'open', 'REVIEWED', null, undefined].includes(row.state);
    })
    .map((row) => normalizeLakeRow(row, attemptStats))
    .filter((candidate) => !excluded.has(candidate.candidate))
    .sort((left, right) => right.priority - left.priority ||
      right.mechanicalScore - left.mechanicalScore || left.candidate.localeCompare(right.candidate))
    .slice(0, selectedLimit);
}

export function buildPreflightQuery(candidates, {northsetLogin = 'AysajanE'} = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('preflight requires candidates');
  const fields = candidates.map((candidate, index) => {
    const {owner, repo, issueNumber} = candidateParts(candidate.candidate ?? candidate);
    const repository = `${owner}/${repo}`;
    return `
      c${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
        id
        nameWithOwner
        isArchived
        isFork
        defaultBranchRef { name target { ... on Commit { oid } } }
        rootPackage: object(expression: "HEAD:package.json") {
          ... on Blob { byteSize text }
        }
        pnpmWorkspaceYaml: object(expression: "HEAD:pnpm-workspace.yaml") {
          ... on Blob { byteSize }
        }
        pnpmWorkspaceYml: object(expression: "HEAD:pnpm-workspace.yml") {
          ... on Blob { byteSize }
        }
        lernaConfig: object(expression: "HEAD:lerna.json") {
          ... on Blob { byteSize }
        }
        issue(number: ${issueNumber}) {
          id number title bodyText url state locked updatedAt
          assignees(first: 20) { nodes { login } }
          labels(first: 50) { nodes { name } }
          comments(last: 10) {
            nodes { body createdAt authorAssociation author { login __typename } }
          }
          timelineItems(last: 50, itemTypes: [CROSS_REFERENCED_EVENT]) {
            pageInfo { hasPreviousPage }
            nodes {
              ... on CrossReferencedEvent {
                source {
                  __typename
                  ... on PullRequest { number title url state isDraft repository { nameWithOwner } }
                }
              }
            }
          }
        }
      }
      n${index}: search(query: ${JSON.stringify(`repo:${repository} is:pr is:open author:${northsetLogin}`)}, type: ISSUE, first: 1) {
        issueCount
      }`;
  }).join('\n');
  return `query FactoryLivePreflight {${fields}\n}`;
}

function normalizeComment(comment) {
  return {
    author: comment?.author?.login ?? null,
    authorType: comment?.author?.__typename ?? null,
    authorAssociation: comment?.authorAssociation ?? null,
    body: String(comment?.body ?? '').slice(0, 2_000),
    createdAt: comment?.createdAt ?? null,
  };
}

export function normalizePreflight(candidate, data) {
  const repository = data?.repository ?? data?.repo ?? data?.repositoryData ?? null;
  const issue = repository?.issue ?? null;
  const rootPackage = parseJson(repository?.rootPackage?.text, null);
  const workspaces = rootPackage?.workspaces;
  const workspaceLayout = (Array.isArray(workspaces) && workspaces.length > 0) ||
    (workspaces && typeof workspaces === 'object' && Object.keys(workspaces).length > 0) ||
    [repository?.pnpmWorkspaceYaml, repository?.pnpmWorkspaceYml, repository?.lernaConfig]
      .some((item) => Number(item?.byteSize) > 0);
  const yarnBerryLayout = /^yarn@(?:[2-9]|[1-9][0-9]+)(?:\.|$)/i
    .test(String(rootPackage?.packageManager ?? ''));
  const crossReferencedPrs = (issue?.timelineItems?.nodes ?? [])
    .map((event) => event?.source)
    .filter((source) => source?.__typename === 'PullRequest')
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      draft: Boolean(pr.isDraft),
      repository: pr.repository?.nameWithOwner ?? null,
    }));
  return {
    candidate,
    repository: repository ? {
      nodeId: repository.id ?? null,
      nameWithOwner: repository.nameWithOwner ?? candidate.repository,
      archived: Boolean(repository.isArchived),
      fork: Boolean(repository.isFork),
      defaultBranch: repository.defaultBranchRef?.name ?? null,
      defaultOid: repository.defaultBranchRef?.target?.oid ?? null,
      hasRootPackageJson: Number(repository.rootPackage?.byteSize) > 0,
      unsupportedNodeLayout: workspaceLayout
        ? 'multi-package workspaces are outside the single-package Node lane'
        : yarnBerryLayout ? 'Yarn Berry is outside the node_modules dependency lane' : null,
      northsetOpenPrs: Number(data?.northsetOpenPrCount ?? data?.northset?.issueCount ?? 0),
    } : null,
    issue: issue ? {
      nodeId: issue.id ?? null,
      number: issue.number,
      title: issue.title ?? '',
      body: issue.bodyText ?? '',
      url: issue.url ?? null,
      state: issue.state,
      locked: Boolean(issue.locked),
      updatedAt: issue.updatedAt ?? null,
      assignees: (issue.assignees?.nodes ?? []).map((item) => item.login),
      labels: (issue.labels?.nodes ?? []).map((item) => item.name),
      comments: (issue.comments?.nodes ?? []).map(normalizeComment),
      crossReferencedPrs,
      timelineTruncated: Boolean(issue.timelineItems?.pageInfo?.hasPreviousPage),
    } : null,
  };
}

function normalizedLabel(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hasInvitation(candidate, labels) {
  if (candidate.invitationPolicyPresent) return true;
  const approved = new Set((candidate.invitationLabels ?? []).map(normalizedLabel));
  return labels.some((label) => {
    const normalized = normalizedLabel(label);
    return normalized.includes('good first issue') || normalized.endsWith('help wanted') || approved.has(normalized);
  });
}

function recentExternalClaim(comments, northsetLogin, now) {
  const cutoff = now.getTime() - 45 * DAY_MS;
  return comments.find((comment) => {
    const created = Date.parse(comment.createdAt ?? '');
    return comment.author && comment.author.toLowerCase() !== northsetLogin.toLowerCase() &&
      comment.authorType !== 'Bot' && !/\[bot\]$/i.test(comment.author) &&
      Number.isFinite(created) && created >= cutoff && isClaimText(comment.body);
  }) ?? null;
}

export function evaluatePreflight(live, {northsetLogin = 'AysajanE', now = new Date()} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('now must be a valid Date');
  const reasons = [];
  const repository = live.repository;
  const issue = live.issue;
  if (!repository) reasons.push('repository is missing or inaccessible');
  if (!issue) reasons.push('issue is missing or inaccessible');
  if (issue && issue.state !== 'OPEN') reasons.push(`issue is ${String(issue.state).toLowerCase()}`);
  const externalAssignees = (issue?.assignees ?? [])
    .filter((login) => login.toLowerCase() !== northsetLogin.toLowerCase());
  if (externalAssignees.length) reasons.push(`issue is assigned to ${externalAssignees.join(', ')}`);
  if (issue && !hasInvitation(live.candidate, issue.labels)) reasons.push('invitation label or policy is missing');
  if (repository?.archived || repository?.fork) reasons.push('repository is archived or forked');
  if (repository && !repository.hasRootPackageJson) reasons.push('root package.json is missing');
  if (repository?.unsupportedNodeLayout) reasons.push(repository.unsupportedNodeLayout);
  if (repository?.northsetOpenPrs > 0) reasons.push('Northset already has an open PR in the repository');
  const openLinked = (issue?.crossReferencedPrs ?? []).filter((pr) => pr.state === 'OPEN');
  if (openLinked.length) reasons.push(`exact linked open PR exists: ${openLinked.map((pr) => pr.url).join(', ')}`);
  const claim = issue ? recentExternalClaim(issue.comments, northsetLogin, now) : null;
  if (claim) reasons.push(`recent external claimant: ${claim.author}`);
  if (repository && !/^[0-9a-f]{40}$/i.test(repository.defaultOid ?? '')) reasons.push('current default-branch OID is unavailable');

  if (reasons.length) return {outcome: 'SKIP', reasons, liveState: live};
  const ambiguousOverlap = issue.timelineTruncated ||
    (issue.crossReferencedPrs.length > 0 && !openLinked.length) ||
    /\b(?:pull request|pr)\s*#?\d+\b/i.test(`${issue.title}\n${issue.body}`);
  if (ambiguousOverlap) {
    return {outcome: 'ESCALATE', reasons: ['ambiguous pull-request overlap requires one deeper check'], liveState: live};
  }
  return {outcome: 'GO', reasons: [], liveState: live};
}

export async function preflightCandidates(candidates, {
  github,
  workers,
  limit,
  northsetLogin = 'AysajanE',
  now = new Date(),
} = {}) {
  if (!github || typeof github.graphql !== 'function') throw new Error('github.graphql is required');
  const selected = candidates.slice(0, boundedLimit(workers, limit));
  if (!selected.length) return [];
  const query = buildPreflightQuery(selected, {northsetLogin});
  const response = await github.graphql(query);
  const data = response?.data ?? response;
  if (!data || typeof data !== 'object') throw new Error('GitHub preflight returned no data');
  const results = selected.map((candidate, index) => {
    const live = normalizePreflight(candidate, {
      repository: data[`c${index}`] ?? null,
      northset: data[`n${index}`] ?? null,
    });
    return {...evaluatePreflight(live, {northsetLogin, now}), candidate};
  });
  if (typeof github.deepOverlap === 'function') {
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.outcome !== 'ESCALATE') continue;
      const deeper = await github.deepOverlap(result.liveState);
      results[index] = deeper?.clean
        ? {...result, outcome: 'GO', reasons: []}
        : {...result, outcome: 'SKIP', reasons: [deeper?.reason ?? 'deeper overlap review was not clean']};
    }
  }
  return results;
}

export async function enqueueCandidates(results, {db} = {}) {
  if (!db || typeof db.enqueueTasks !== 'function') throw new Error('db.enqueueTasks is required');
  const tasks = results.filter((result) => result.outcome === 'GO').map((result) => {
    const candidate = result.candidate;
    const live = result.liveState;
    return {
      candidate: candidate.candidate,
      repository: live.repository.nameWithOwner ?? candidate.repository,
      repository_node_id: live.repository.nodeId ?? candidate.repositoryNodeId,
      issue_number: live.issue.number ?? candidate.issueNumber,
      issue_node_id: live.issue.nodeId ?? candidate.issueNodeId,
      profile: 'node',
      priority: candidate.priority,
      state: 'QUEUED',
      base_oid: live.repository.defaultOid,
      live_state: live,
      issue_snapshot: live.issue,
    };
  });
  return db.enqueueTasks(tasks);
}

export function createSource({lakePath = 'candidate_lake.sqlite', query, db, github, northsetLogin = 'AysajanE'} = {}) {
  const lakeQuery = query ?? ((sql) => sqliteQuery(lakePath, sql));
  return {
    select: (options) => selectCandidates({
      ...options,
      lakePath,
      query: lakeQuery,
      attemptStats: options?.attemptStats ?? db?.candidateAttemptStats?.() ?? {},
    }),
    preflight: (candidates, options) => preflightCandidates(candidates, {
      ...options, github, northsetLogin: options?.northsetLogin ?? northsetLogin,
    }),
    enqueue: (results) => enqueueCandidates(results, {db}),
    async fill(options) {
      const targetDepth = boundedLimit(options.workers, options.limit);
      const known = typeof db?.listTasks === 'function'
        ? await db.listTasks({profile: options.profile ?? 'node', limit: 100_000})
        : [];
      const active = known.filter((task) => ['QUEUED', 'WORKING'].includes(task.state)).length;
      const available = Math.max(0, targetDepth - active);
      if (available === 0) return {candidates: [], results: [], enqueued: []};
      const candidates = await this.select({
        ...options,
        limit: available,
        excludeCandidates: known.map((task) => task.candidate),
      });
      const results = await this.preflight(candidates, options);
      await db?.recordPreflightOutcomes?.(results, {now: options.now});
      const enqueued = await this.enqueue(results);
      return {candidates, results, enqueued};
    },
  };
}
