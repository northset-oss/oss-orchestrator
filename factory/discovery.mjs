import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1_000;
const DISCOVERY_WINDOW_DAYS = 14;
const DEFAULT_TARGET = 64;
const MAX_TARGET = 100;
const LABELS = ['good first issue', 'help wanted'];
const LANGUAGES = [null, 'JavaScript', 'TypeScript'];

export const DISCOVERY_DEFAULT_TARGET = DEFAULT_TARGET;
export const DISCOVERY_MAX_TARGET = MAX_TARGET;

export const DISCOVERY_QUERY = `query FactoryDiscovery($query: String!, $first: Int!) {
  search(query: $query, type: ISSUE, first: $first) {
    nodes {
      __typename
      ... on Issue {
        id number title bodyText url state locked updatedAt authorAssociation
        labels(first: 50) { nodes { name } }
        assignees(first: 20) { nodes { login } }
        repository {
          id nameWithOwner isArchived isFork isPrivate stargazerCount pushedAt
          owner { id login }
          primaryLanguage { name }
          defaultBranchRef { name target { ... on Commit { oid } } }
        }
      }
    }
  }
}`;

function validDate(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} must be a valid Date`);
  }
  return value;
}

function targetValue(value) {
  const target = value ?? DEFAULT_TARGET;
  if (!Number.isInteger(target) || target < 1 || target > MAX_TARGET) {
    throw new TypeError(`target must be an integer from 1 through ${MAX_TARGET}`);
  }
  return target;
}

function normalizedLabel(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function invitationLabel(labels) {
  return (labels ?? []).map((item) => item?.name ?? item).find((label) => {
    const normalized = normalizedLabel(label);
    return normalized.includes('good first issue') || normalized.endsWith('help wanted');
  }) ?? null;
}

function quoted(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

export function discoveryStrata({now = new Date()} = {}) {
  validDate(now, 'now');
  const cutoff = new Date(now.getTime() - DISCOVERY_WINDOW_DAYS * DAY_MS)
    .toISOString().slice(0, 10);
  const common = ['is:issue', 'is:open', 'no:assignee', 'archived:false', 'is:public'];
  const strata = [];
  for (const label of LABELS) {
    for (const language of LANGUAGES) {
      const name = `${normalizedLabel(label).replaceAll(' ', '_')}:${language ?? 'global'}`;
      const parts = [...common, `label:${quoted(label)}`, `updated:>=${cutoff}`];
      if (language) parts.push(`language:${quoted(language)}`);
      strata.push({name, label, language, cutoff, query: parts.join(' ')});
    }
  }
  return strata;
}

function responseData(response, stratum) {
  const payload = response?.body ?? response;
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new Error(`GitHub discovery ${stratum} returned GraphQL errors`);
  }
  const data = payload?.data ?? payload;
  const nodes = data?.search?.nodes;
  if (!Array.isArray(nodes)) throw new Error(`GitHub discovery ${stratum} returned no search nodes`);
  return nodes;
}

function candidateKey(repository, issueNumber) {
  const value = `${repository}#${issueNumber}`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(value)) return null;
  return value.toLowerCase();
}

function evaluateNode(node, {cutoffMs}) {
  if (node?.__typename !== 'Issue') return {candidate: null, reasons: ['search result is not an issue']};
  const repository = node.repository;
  const candidate = candidateKey(repository?.nameWithOwner, node.number);
  const reasons = [];
  if (!candidate) reasons.push('candidate identity is unavailable');
  if (!node.id) reasons.push('issue node ID is unavailable');
  if (!repository) reasons.push('repository is missing or inaccessible');
  if (!repository?.id) reasons.push('repository node ID is unavailable');
  if (repository?.isPrivate) reasons.push('repository is private');
  if (repository?.isArchived) reasons.push('repository is archived');
  if (repository?.isFork) reasons.push('repository is a fork');
  if (node.state !== 'OPEN') reasons.push(`issue is ${String(node.state ?? 'missing').toLowerCase()}`);
  if (node.locked) reasons.push('issue is locked');
  const assignees = (node.assignees?.nodes ?? []).map((item) => item?.login).filter(Boolean);
  if (assignees.length) reasons.push(`issue is assigned to ${assignees.join(', ')}`);
  const label = invitationLabel(node.labels?.nodes ?? []);
  if (!label) reasons.push('invitation label is missing');
  const language = String(repository?.primaryLanguage?.name ?? '');
  if (!['JavaScript', 'TypeScript'].includes(language)) {
    reasons.push(`repository primary language is ${language || 'unavailable'}, not JavaScript or TypeScript`);
  }
  const defaultOid = repository?.defaultBranchRef?.target?.oid ?? null;
  if (!/^[0-9a-f]{40}$/i.test(defaultOid ?? '')) reasons.push('current default-branch OID is unavailable');
  const updatedMs = Date.parse(node.updatedAt ?? '');
  if (!Number.isFinite(updatedMs) || updatedMs < cutoffMs) {
    reasons.push(`issue was not updated within ${DISCOVERY_WINDOW_DAYS} days`);
  }
  return {candidate, reasons, repository, issue: node, assignees, invitationLabel: label, defaultOid};
}

function score(record) {
  let value = 50;
  const label = normalizedLabel(record.invitationLabel);
  if (label.includes('good first issue')) value += 8;
  if (label.endsWith('help wanted')) value += 6;
  if (record.repository.primaryLanguage?.name === 'TypeScript') value += 4;
  const stars = Number(record.repository.stargazerCount ?? 0);
  if (stars >= 1_000) value += 6;
  else if (stars >= 100) value += 4;
  else if (stars >= 10) value += 2;
  return value;
}

function reasonCounts(records) {
  const counts = {};
  for (const record of records) {
    for (const reason of record.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function activeAuthoringBlocks(blocks) {
  const repositories = new Set();
  const owners = new Set();
  for (const block of blocks) {
    if (block?.released_at || block?.block_authoring === false || block?.block_authoring === 0) continue;
    const subject = String(block?.subject ?? '').trim().toLowerCase();
    if (!subject) continue;
    if (block.scope === 'repository') repositories.add(subject);
    if (block.scope === 'owner') owners.add(subject);
  }
  return {repositories, owners};
}

function assertLakeSchema(connection) {
  const tables = new Set(connection.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('repositories','issues','repository_aliases')",
  ).all().map((row) => row.name));
  if (!tables.has('repositories') || !tables.has('issues') || !tables.has('repository_aliases')) {
    throw new Error('candidate lake must contain the existing repositories, issues, and repository_aliases tables');
  }
  const issueColumns = new Set(connection.prepare('PRAGMA table_info(issues)').all().map((row) => row.name));
  for (const column of ['candidate_key', 'candidate_display', 'repo_key', 'mechanical_reasons_json',
    'last_hydrated_at', 'raw_json']) {
    if (!issueColumns.has(column)) throw new Error(`candidate lake issues table is missing ${column}`);
  }
}

function persist(connection, records, {now}) {
  assertLakeSchema(connection);
  connection.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
  try {
    const existingIssue = connection.prepare('SELECT 1 FROM issues WHERE candidate_key=?');
    const repositoryByNodeId = connection.prepare(
      'SELECT repo_key FROM repositories WHERE repository_node_id=? LIMIT 1',
    );
    const repositoryByKey = connection.prepare(
      'SELECT repository_node_id FROM repositories WHERE repo_key=? LIMIT 1',
    );
    const issueByNodeId = connection.prepare(
      'SELECT candidate_key,candidate_display FROM issues WHERE issue_node_id=? LIMIT 1',
    );
    const issueByCandidate = connection.prepare(
      'SELECT issue_node_id,candidate_display FROM issues WHERE candidate_key=? LIMIT 1',
    );
    const retireRepositoryIssues = connection.prepare(
      `UPDATE issues SET state='RENAMED_UNKNOWN',updated_at=?
       WHERE repo_key=? AND lower(candidate_display) GLOB ?`,
    );
    const retireCandidate = connection.prepare(
      "UPDATE issues SET state='RENAMED_UNKNOWN',updated_at=? WHERE candidate_key=?",
    );
    const repositoryAliasStatement = connection.prepare(`INSERT INTO repository_aliases(
      alias_key,repo_key,repository_node_id,observed_at
    ) VALUES(?,?,?,?)
    ON CONFLICT(alias_key) DO UPDATE SET
      repo_key=excluded.repo_key,repository_node_id=excluded.repository_node_id,
      observed_at=excluded.observed_at`);
    const repositoryStatement = connection.prepare(`INSERT INTO repositories(
      repo_key,repo_display,stars,default_branch,default_head,primary_language,pushed_at,archived,fork,
      test_profile,raw_json,provenance_json,updated_at,repository_node_id,owner_node_id,owner_login,
      slot_observed_at,slot_expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(repo_key) DO UPDATE SET
      repo_display=excluded.repo_display,stars=excluded.stars,default_branch=excluded.default_branch,
      default_head=excluded.default_head,primary_language=excluded.primary_language,
      pushed_at=excluded.pushed_at,archived=excluded.archived,fork=excluded.fork,
      test_profile=excluded.test_profile,raw_json=excluded.raw_json,
      provenance_json=excluded.provenance_json,updated_at=excluded.updated_at,
      repository_node_id=excluded.repository_node_id,owner_node_id=excluded.owner_node_id,
      owner_login=excluded.owner_login,slot_observed_at=excluded.slot_observed_at,
      slot_expires_at=excluded.slot_expires_at`);
    const issueStatement = connection.prepare(`INSERT INTO issues(
      candidate_key,candidate_display,repo_key,issue_number,title,body_excerpt,labels_json,state,
      assignees_json,comments_count,updated_at,issue_updated_at,author_association,invitation_kind,
      profile,base_commit,evidence_key,mechanical_score,mechanical_reasons_json,last_hydrated_at,
      raw_json,provenance_json,issue_node_id,snapshot_expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(candidate_key) DO UPDATE SET
      candidate_display=excluded.candidate_display,repo_key=excluded.repo_key,
      issue_number=excluded.issue_number,title=excluded.title,body_excerpt=excluded.body_excerpt,
      labels_json=excluded.labels_json,state=excluded.state,assignees_json=excluded.assignees_json,
      comments_count=excluded.comments_count,updated_at=excluded.updated_at,
      issue_updated_at=excluded.issue_updated_at,author_association=excluded.author_association,
      invitation_kind=excluded.invitation_kind,profile=excluded.profile,base_commit=excluded.base_commit,
      evidence_key=excluded.evidence_key,mechanical_score=excluded.mechanical_score,
      mechanical_reasons_json=excluded.mechanical_reasons_json,
      last_hydrated_at=excluded.last_hydrated_at,raw_json=excluded.raw_json,
      provenance_json=excluded.provenance_json,issue_node_id=excluded.issue_node_id,
      snapshot_expires_at=excluded.snapshot_expires_at`);
    let inserted = 0;
    let refreshed = 0;
    const observedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + DISCOVERY_WINDOW_DAYS * DAY_MS).toISOString();
    for (const record of records) {
      const repository = record.repository;
      const issue = record.issue;
      const repoDisplay = repository.nameWithOwner;
      const repoKey = repoDisplay.toLowerCase();
      const repositoryNodeId = repository.id ?? null;
      const storedRepository = repositoryNodeId ? repositoryByNodeId.get(repositoryNodeId) : null;
      const repoKeyOwner = repositoryByKey.get(repoKey);
      const repoKeyCollision = Boolean(repositoryNodeId && repoKeyOwner &&
        repoKeyOwner.repository_node_id !== repositoryNodeId);
      const storageRepoKey = storedRepository?.repo_key ??
        (repoKeyCollision ? `node:${repositoryNodeId}` : repoKey);
      if (repoKeyCollision) retireRepositoryIssues.run(observedAt, repoKey, `${repoKey}#*`);
      const issueNodeId = issue.id ?? null;
      const storedIssue = issueNodeId ? issueByNodeId.get(issueNodeId) : null;
      const candidateOwner = issueByCandidate.get(record.candidate);
      const candidateCollision = Boolean(issueNodeId && candidateOwner &&
        candidateOwner.issue_node_id !== issueNodeId);
      const storageCandidateKey = storedIssue?.candidate_key ??
        (candidateCollision ? `node:${issueNodeId}` : record.candidate);
      const candidateDisplay = `${repoDisplay}#${issue.number}`;
      if (candidateCollision &&
          String(candidateOwner.candidate_display ?? '').toLowerCase() === candidateDisplay.toLowerCase()) {
        retireCandidate.run(observedAt, record.candidate);
      }
      const alreadyExists = Boolean(storedIssue ||
        (!candidateCollision && existingIssue.get(record.candidate)));
      const provenance = JSON.stringify({source: 'factory_discover', version: 1,
        observed_at: observedAt, strata: [...record.strata].sort()});
      const repositoryRaw = JSON.stringify(repository);
      repositoryStatement.run(
        storageRepoKey, repoDisplay, Number(repository.stargazerCount ?? 0),
        repository.defaultBranchRef?.name ?? null, record.defaultOid,
        repository.primaryLanguage?.name ?? null, repository.pushedAt ?? null,
        repository.isArchived ? 1 : 0, repository.isFork ? 1 : 0, 'node', repositoryRaw,
        provenance, observedAt, repositoryNodeId, repository.owner?.id ?? null,
        repository.owner?.login ?? null, observedAt, expiresAt,
      );
      repositoryAliasStatement.run(repoKey, storageRepoKey, repositoryNodeId, observedAt);
      const raw = JSON.stringify({repository, issue, discovery: {strata: [...record.strata].sort()}});
      issueStatement.run(
        storageCandidateKey, candidateDisplay, storageRepoKey, issue.number, issue.title ?? '',
        String(issue.bodyText ?? '').slice(0, 4_000),
        JSON.stringify((issue.labels?.nodes ?? []).map((item) => item.name)), 'OPEN',
        JSON.stringify(record.assignees), null, issue.updatedAt ?? observedAt,
        issue.updatedAt ?? observedAt, issue.authorAssociation ?? null, 'label', 'node',
        record.defaultOid, null, record.mechanicalScore, '[]', observedAt, raw, provenance,
        issueNodeId, expiresAt,
      );
      if (alreadyExists) refreshed += 1;
      else inserted += 1;
    }
    connection.exec('COMMIT');
    return {inserted, refreshed};
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

export async function discoverCandidates({
  lakePath = 'candidate_lake.sqlite',
  target = DEFAULT_TARGET,
  knownCandidates = [],
  knownIssueNodeIds = [],
  interactionBlocks = [],
  search,
  now = new Date(),
} = {}) {
  target = targetValue(target);
  validDate(now, 'now');
  if (typeof search !== 'function') throw new TypeError('search callback is required');
  if (!Array.isArray(interactionBlocks)) throw new TypeError('interactionBlocks must be an array');
  if (!Array.isArray(knownIssueNodeIds)) throw new TypeError('knownIssueNodeIds must be an array');
  const known = new Set(knownCandidates.map((value) => String(value).toLowerCase()));
  const knownIssues = new Set(knownIssueNodeIds.map((value) => String(value)).filter(Boolean));
  const authoringBlocks = activeAuthoringBlocks(interactionBlocks);
  const cutoffMs = now.getTime() - DISCOVERY_WINDOW_DAYS * DAY_MS;
  const unique = new Map();
  const duplicates = new Map();
  const skipped = [];
  const strata = discoveryStrata({now});
  let searchResults = 0;

  for (const stratum of strata) {
    const response = await search({
      stratum,
      query: DISCOVERY_QUERY,
      variables: {query: stratum.query, first: 100},
    });
    const nodes = responseData(response, stratum.name);
    for (const [index, node] of nodes.entries()) {
      searchResults += 1;
      const evaluated = evaluateNode(node, {cutoffMs});
      if (evaluated.reasons.length) {
        skipped.push({candidate: evaluated.candidate ?? `${stratum.name}[${index}]`,
          reasons: evaluated.reasons, stratum: stratum.name});
        continue;
      }
      const existing = unique.get(evaluated.candidate);
      if (existing) {
        existing.strata.add(stratum.name);
        const duplicate = duplicates.get(evaluated.candidate) ?? {
          candidate: evaluated.candidate, reasons: ['duplicate search result'], occurrences: 1,
        };
        duplicate.occurrences += 1;
        duplicates.set(evaluated.candidate, duplicate);
        continue;
      }
      evaluated.strata = new Set([stratum.name]);
      evaluated.mechanicalScore = score(evaluated);
      unique.set(evaluated.candidate, evaluated);
    }
  }

  const ranked = [...unique.values()].sort((left, right) =>
    right.mechanicalScore - left.mechanicalScore ||
    Date.parse(right.issue.updatedAt ?? '') - Date.parse(left.issue.updatedAt ?? '') ||
    left.candidate.localeCompare(right.candidate));
  const available = [];
  for (const record of ranked) {
    const repository = record.repository.nameWithOwner.toLowerCase();
    const owner = String(record.repository.owner?.login ?? repository.split('/')[0]).toLowerCase();
    if (authoringBlocks.repositories.has(repository)) {
      skipped.push({candidate: record.candidate, reasons: ['repository authoring interaction block'],
        stratum: [...record.strata].sort().join(',')});
    } else if (authoringBlocks.owners.has(owner)) {
      skipped.push({candidate: record.candidate, reasons: ['owner authoring interaction block'],
        stratum: [...record.strata].sort().join(',')});
    } else if (known.has(record.candidate)) {
      skipped.push({candidate: record.candidate, reasons: ['candidate is already known to factory'],
        stratum: [...record.strata].sort().join(',')});
    } else if (knownIssues.has(String(record.issue.id ?? ''))) {
      skipped.push({candidate: record.candidate, reasons: ['issue node is already known to factory'],
        stratum: [...record.strata].sort().join(',')});
    } else {
      available.push(record);
    }
  }
  const selected = [];
  const repositoryCounts = new Map();
  for (const record of available) {
    if (selected.length >= target) {
      skipped.push({candidate: record.candidate, reasons: [`discovery target ${target} reached`],
        stratum: [...record.strata].sort().join(',')});
      continue;
    }
    const repository = record.repository.nameWithOwner.toLowerCase();
    const repositoryCount = repositoryCounts.get(repository) ?? 0;
    if (repositoryCount >= 2) {
      skipped.push({candidate: record.candidate, reasons: ['repository discovery cap 2 reached'],
        stratum: [...record.strata].sort().join(',')});
      continue;
    }
    selected.push(record);
    repositoryCounts.set(repository, repositoryCount + 1);
  }

  const connection = new DatabaseSync(path.resolve(lakePath));
  let persisted;
  try { persisted = persist(connection, selected, {now}); }
  finally { connection.close(); }
  const deduplicated = [...duplicates.values()].sort((left, right) =>
    left.candidate.localeCompare(right.candidate));
  return {
    target,
    window_days: DISCOVERY_WINDOW_DAYS,
    strata_requested: strata.length,
    search_results: searchResults,
    unique_candidates: unique.size,
    selected: selected.length,
    inserted: persisted.inserted,
    refreshed: persisted.refreshed,
    skipped_count: skipped.length,
    deduplicated_count: deduplicated.reduce((sum, item) => sum + item.occurrences - 1, 0),
    skipped_reason_counts: reasonCounts(skipped),
    skipped,
    deduplicated,
    candidates: selected.map((record) => ({candidate: record.candidate,
      mechanical_score: record.mechanicalScore, strata: [...record.strata].sort()})),
  };
}
