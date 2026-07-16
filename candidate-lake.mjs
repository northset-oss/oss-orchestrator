#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const CANDIDATE_LAKE_SCHEMA_VERSION = 1;

function canonical(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('cannot canonicalize non-finite number');
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sql(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('SQLite value must be finite');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlite(database, source, {json = false, sqliteBin = 'sqlite3'} = {}) {
  return new Promise((resolve, reject) => {
    const args = [...(json ? ['-json'] : []), database];
    const child = spawn(sqliteBin, args, {stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`sqlite3 failed: ${(stderr || stdout).trim() || `exit ${code}`}`));
        return;
      }
      if (!json) {
        resolve(stdout);
        return;
      }
      try { resolve(stdout.trim() ? JSON.parse(stdout) : []); }
      catch (error) { reject(new Error(`sqlite3 returned invalid JSON: ${error.message}`)); }
    });
    child.stdin.end(`.timeout 5000\n${source}\n`);
  });
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
CREATE TABLE IF NOT EXISTS lake_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO lake_meta(key, value) VALUES ('schema_version', '${CANDIDATE_LAKE_SCHEMA_VERSION}')
  ON CONFLICT(key) DO NOTHING;
CREATE TABLE IF NOT EXISTS repositories (
  repo_key TEXT PRIMARY KEY,
  repo_display TEXT NOT NULL,
  stars INTEGER,
  default_branch TEXT,
  default_head TEXT,
  primary_language TEXT,
  license TEXT,
  pushed_at TEXT,
  archived INTEGER,
  fork INTEGER,
  ai_policy_status TEXT,
  ai_policy_url TEXT,
  ai_policy_sha256 TEXT,
  dco_required INTEGER,
  cla_required INTEGER,
  pr_template_kind TEXT,
  test_profile TEXT,
  install_command TEXT,
  focused_test_patterns_json TEXT,
  full_check_commands_json TEXT,
  invitation_label_map_json TEXT,
  last_policy_audit_at TEXT,
  cooldown_until TEXT,
  max_open_prs INTEGER NOT NULL DEFAULT 1,
  daily_pr_cap INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT NOT NULL DEFAULT '{}',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issues (
  candidate_key TEXT PRIMARY KEY,
  candidate_display TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  title TEXT,
  body_excerpt TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  state TEXT,
  assignees_json TEXT NOT NULL DEFAULT '[]',
  comments_count INTEGER,
  updated_at TEXT,
  issue_updated_at TEXT,
  author_association TEXT,
  invitation_kind TEXT,
  profile TEXT,
  base_commit TEXT,
  evidence_key TEXT,
  mechanical_score INTEGER,
  mechanical_reasons_json TEXT NOT NULL DEFAULT '[]',
  last_hydrated_at TEXT,
  raw_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(repo_key) REFERENCES repositories(repo_key)
);
CREATE INDEX IF NOT EXISTS issues_rank_idx ON issues(profile, state, mechanical_score DESC, issue_updated_at DESC);
CREATE TABLE IF NOT EXISTS reviews (
  candidate_key TEXT NOT NULL,
  candidate_display TEXT NOT NULL,
  evidence_key TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('ACCEPT', 'REJECT')),
  tier TEXT,
  executor_profile TEXT,
  review_id TEXT,
  result_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  imported_record_sha256 TEXT NOT NULL,
  PRIMARY KEY(candidate_key, evidence_key),
  FOREIGN KEY(candidate_key) REFERENCES issues(candidate_key)
);
CREATE INDEX IF NOT EXISTS reviews_expiry_idx ON reviews(candidate_key, evidence_key, expires_at);
CREATE TABLE IF NOT EXISTS attempts (
  mission_id TEXT PRIMARY KEY,
  candidate_key TEXT NOT NULL,
  candidate_display TEXT NOT NULL,
  task_id TEXT,
  attempt_sequence INTEGER,
  state TEXT NOT NULL,
  terminal_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(candidate_key) REFERENCES issues(candidate_key)
);
CREATE TABLE IF NOT EXISTS imports (
  import_key TEXT PRIMARY KEY,
  candidate_key TEXT NOT NULL,
  evidence_key TEXT NOT NULL,
  source TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  FOREIGN KEY(candidate_key, evidence_key) REFERENCES reviews(candidate_key, evidence_key)
);
CREATE VIEW IF NOT EXISTS repos AS SELECT * FROM repositories;
`;

export function canonicalCandidate(value) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(String(value ?? ''));
  if (!match) throw new Error(`candidate must be owner/repo#123, got ${JSON.stringify(value)}`);
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}#${match[3]}`;
}

function candidateParts(value) {
  const display = String(value);
  const key = canonicalCandidate(display);
  const match = /^([^/]+)\/([^#]+)#([0-9]+)$/.exec(display);
  return {key, display, repoKey: `${match[1]}/${match[2]}`.toLowerCase(), repoDisplay: `${match[1]}/${match[2]}`, number: Number(match[3])};
}

function normalizedList(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value).toLowerCase().trim()).filter(Boolean))].sort();
}

export function candidateEvidenceKey(facts) {
  const candidate = canonicalCandidate(facts.candidate);
  const subject = {
    schema_version: 1,
    candidate,
    executor_profile: facts.profile ?? null,
    base_commit: String(facts.base_commit ?? '').toLowerCase(),
    issue_updated_at: facts.issue_updated_at ?? facts.updated_at ?? null,
    labels: normalizedList(facts.labels),
    assignees: normalizedList(facts.assignees),
    comments_tail_sha256: facts.comments_tail_sha256 ?? null,
    timeline_prs_sha256: facts.timeline_prs_sha256 ?? null,
    repo_policy_sha256: facts.repo_policy_sha256 ?? null,
  };
  return sha256(Buffer.from(`northset-candidate-evidence-v1\0${canonical(subject)}`, 'utf8'));
}

function jsonText(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

function validDigest(value) {
  return /^sha256:[0-9a-f]{64}$/i.test(String(value ?? ''));
}

function qualificationCandidate(record) {
  return record?.candidate ?? record?.qualification?.candidate ?? record?.review?.candidate ?? null;
}

function qualificationEvidenceKey(record) {
  return record?.evidence_key ??
    record?.preflight_evidence_sha256 ??
    record?.qualification?.evidence_key ??
    record?.qualification?.preflight_evidence_sha256 ??
    record?.evidence_sha256 ??
    record?.qualification?.evidence_sha256 ??
    record?.review?.evidence_sha256 ??
    null;
}

function recordsFromJson(value) {
  if (Array.isArray(value)) return value.flatMap(recordsFromJson);
  if (!value || typeof value !== 'object') return [];
  if (qualificationCandidate(value) && validDigest(qualificationEvidenceKey(value))) {
    return [value];
  }
  return Object.values(value).flatMap((item) => item && typeof item === 'object' ? recordsFromJson(item) : []);
}

async function parseImportFile(file) {
  const source = await readFile(file, 'utf8');
  if (file.toLowerCase().endsWith('.jsonl')) {
    const values = [];
    for (const [index, line] of source.split('\n').entries()) {
      if (!line.trim()) continue;
      try { values.push(JSON.parse(line)); }
      catch (error) { throw new Error(`${file}:${index + 1} is invalid JSON: ${error.message}`); }
    }
    return values.flatMap(recordsFromJson);
  }
  try { return recordsFromJson(JSON.parse(source)); }
  catch (error) { throw new Error(`${file} is invalid JSON: ${error.message}`); }
}

function rowReview(row) {
  if (!row) return null;
  return {
    candidate: row.candidate_display,
    evidence_key: row.evidence_key,
    verdict: row.verdict,
    tier: row.tier,
    executor_profile: row.executor_profile,
    review_id: row.review_id,
    result: JSON.parse(row.result_json),
    provenance: JSON.parse(row.provenance_json),
    reviewed_at: row.reviewed_at,
    expires_at: row.expires_at,
  };
}

export async function openCandidateLake(databasePath, {sqliteBin = 'sqlite3'} = {}) {
  const database = path.resolve(databasePath);
  await mkdir(path.dirname(database), {recursive: true, mode: 0o700});
  await sqlite(database, SCHEMA, {sqliteBin});

  const query = (source) => sqlite(database, `PRAGMA foreign_keys=ON;\n${source}`, {json: true, sqliteBin});
  const execute = (source) => sqlite(database, `PRAGMA foreign_keys=ON;\n${source}`, {sqliteBin});
  const versions = await query("SELECT value FROM lake_meta WHERE key='schema_version' LIMIT 1;");
  if (String(versions[0]?.value ?? '') !== String(CANDIDATE_LAKE_SCHEMA_VERSION)) {
    throw new Error(`candidate lake schema version ${versions[0]?.value ?? 'missing'} is unsupported; expected ${CANDIDATE_LAKE_SCHEMA_VERSION}`);
  }

  async function upsertRepository(record) {
    const display = String(record.repo_display ?? record.repo ?? record.name_with_owner ?? record.nameWithOwner ?? '').replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(display)) throw new Error('repository must be owner/repo');
    const key = display.toLowerCase();
    const now = record.observed_at ?? record.updated_at ?? new Date().toISOString();
    await execute(`INSERT INTO repositories(
      repo_key, repo_display, stars, default_branch, default_head, primary_language, license, pushed_at,
      archived, fork, ai_policy_status, ai_policy_url, ai_policy_sha256, dco_required, cla_required,
      pr_template_kind, test_profile, install_command, focused_test_patterns_json, full_check_commands_json,
      invitation_label_map_json, last_policy_audit_at, cooldown_until, max_open_prs, daily_pr_cap,
      raw_json, provenance_json, updated_at
    ) VALUES (
      ${sql(key)}, ${sql(display)}, ${sql(record.stars)}, ${sql(record.default_branch)}, ${sql(record.default_head)},
      ${sql(record.primary_language)}, ${sql(record.license)}, ${sql(record.pushed_at)}, ${sql(record.archived)}, ${sql(record.fork)},
      ${sql(record.ai_policy_status)}, ${sql(record.ai_policy_url)}, ${sql(record.ai_policy_sha256)},
      ${sql(record.dco_required)}, ${sql(record.cla_required)}, ${sql(record.pr_template_kind)}, ${sql(record.test_profile ?? record.profile)},
      ${sql(record.install_command)}, ${sql(jsonText(record.focused_test_patterns, []))}, ${sql(jsonText(record.full_check_commands, []))},
      ${sql(jsonText(record.invitation_label_map, {}))}, ${sql(record.last_policy_audit_at)}, ${sql(record.cooldown_until)},
      ${sql(record.max_open_prs ?? 1)}, ${sql(record.daily_pr_cap ?? 1)}, ${sql(jsonText(record.raw ?? record, {}))},
      ${sql(jsonText(record.provenance, {}))}, ${sql(now)}
    ) ON CONFLICT(repo_key) DO UPDATE SET
      repo_display=excluded.repo_display,
      stars=COALESCE(excluded.stars,repositories.stars),
      default_branch=COALESCE(excluded.default_branch,repositories.default_branch),
      default_head=COALESCE(excluded.default_head,repositories.default_head),
      primary_language=COALESCE(excluded.primary_language,repositories.primary_language),
      license=COALESCE(excluded.license,repositories.license),
      pushed_at=COALESCE(excluded.pushed_at,repositories.pushed_at),
      archived=COALESCE(excluded.archived,repositories.archived), fork=COALESCE(excluded.fork,repositories.fork),
      ai_policy_status=COALESCE(excluded.ai_policy_status,repositories.ai_policy_status),
      ai_policy_url=COALESCE(excluded.ai_policy_url,repositories.ai_policy_url),
      ai_policy_sha256=COALESCE(excluded.ai_policy_sha256,repositories.ai_policy_sha256),
      dco_required=COALESCE(excluded.dco_required,repositories.dco_required),
      cla_required=COALESCE(excluded.cla_required,repositories.cla_required),
      pr_template_kind=COALESCE(excluded.pr_template_kind,repositories.pr_template_kind),
      test_profile=COALESCE(excluded.test_profile,repositories.test_profile),
      install_command=COALESCE(excluded.install_command,repositories.install_command),
      focused_test_patterns_json=CASE WHEN excluded.focused_test_patterns_json='[]' THEN repositories.focused_test_patterns_json ELSE excluded.focused_test_patterns_json END,
      full_check_commands_json=CASE WHEN excluded.full_check_commands_json='[]' THEN repositories.full_check_commands_json ELSE excluded.full_check_commands_json END,
      invitation_label_map_json=CASE WHEN excluded.invitation_label_map_json='{}' THEN repositories.invitation_label_map_json ELSE excluded.invitation_label_map_json END,
      last_policy_audit_at=COALESCE(excluded.last_policy_audit_at,repositories.last_policy_audit_at),
      cooldown_until=COALESCE(excluded.cooldown_until,repositories.cooldown_until),
      max_open_prs=${record.max_open_prs === undefined ? 'repositories.max_open_prs' : 'excluded.max_open_prs'},
      daily_pr_cap=${record.daily_pr_cap === undefined ? 'repositories.daily_pr_cap' : 'excluded.daily_pr_cap'},
      raw_json=excluded.raw_json, provenance_json=excluded.provenance_json, updated_at=excluded.updated_at;`);
    return {repo_key: key, repo_display: display};
  }

  async function upsertIssue(record) {
    const parts = candidateParts(record.candidate);
    await upsertRepository({
      repo: record.repository?.name_with_owner ?? record.repository?.nameWithOwner ?? record.repository ?? parts.repoDisplay,
      ...(record.repository && typeof record.repository === 'object' ? record.repository : {}),
      profile: record.profile,
      provenance: record.provenance,
    });
    const issue = record.issue && typeof record.issue === 'object' ? record.issue : record;
    const labels = issue.labels ?? record.labels ?? [];
    const assignees = issue.assignees ?? record.assignees ?? [];
    const evidenceKey = record.evidence_key ?? (record.base_commit || record.repository?.default_head
      ? candidateEvidenceKey({
        candidate: record.candidate,
        base_commit: record.base_commit ?? record.repository?.default_head,
        issue_updated_at: issue.updated_at ?? record.issue_updated_at,
        labels,
        assignees,
        comments_tail_sha256: record.comments_tail_sha256,
        timeline_prs_sha256: record.timeline_prs_sha256,
        repo_policy_sha256: record.repo_policy_sha256,
        profile: record.profile ?? record.repository?.test_profile,
      }) : null);
    const hydrated = record.last_hydrated_at ?? record.observed_at ?? new Date().toISOString();
    await execute(`INSERT INTO issues(
      candidate_key, candidate_display, repo_key, issue_number, title, body_excerpt, labels_json, state,
      assignees_json, comments_count, updated_at, issue_updated_at, author_association, invitation_kind,
      profile, base_commit, evidence_key, mechanical_score, mechanical_reasons_json, last_hydrated_at,
      raw_json, provenance_json
    ) VALUES (
      ${sql(parts.key)}, ${sql(parts.display)}, ${sql(parts.repoKey)}, ${sql(parts.number)}, ${sql(issue.title ?? record.title)},
      ${sql(String(record.body_excerpt ?? record.discovery?.body_excerpt ?? issue.body_excerpt ?? '').slice(0, 8000))},
      ${sql(jsonText(labels, []))}, ${sql(issue.state ?? record.state)}, ${sql(jsonText(assignees, []))},
      ${sql(issue.comments_total ?? issue.comments_count ?? record.comments_count)}, ${sql(hydrated)},
      ${sql(issue.updated_at ?? record.issue_updated_at)}, ${sql(issue.author_association ?? record.author_association)},
      ${sql(record.invitation_kind)}, ${sql(record.profile ?? record.repository?.test_profile)},
      ${sql(record.base_commit ?? record.repository?.default_head)}, ${sql(evidenceKey)},
      ${sql(record.mechanical_score ?? record.decision?.score?.total)},
      ${sql(jsonText(record.mechanical_reasons ?? record.decision?.reasons, []))}, ${sql(hydrated)},
      ${sql(jsonText(record.raw ?? record, {}))}, ${sql(jsonText(record.provenance, {}))}
    ) ON CONFLICT(candidate_key) DO UPDATE SET
      candidate_display=excluded.candidate_display, repo_key=excluded.repo_key, issue_number=excluded.issue_number,
      title=excluded.title, body_excerpt=excluded.body_excerpt, labels_json=excluded.labels_json,
      state=excluded.state, assignees_json=excluded.assignees_json, comments_count=excluded.comments_count,
      updated_at=excluded.updated_at, issue_updated_at=excluded.issue_updated_at,
      author_association=excluded.author_association, invitation_kind=COALESCE(excluded.invitation_kind,issues.invitation_kind),
      profile=COALESCE(excluded.profile,issues.profile), base_commit=COALESCE(excluded.base_commit,issues.base_commit),
      evidence_key=${record.clear_evidence === true ? 'NULL' : 'COALESCE(excluded.evidence_key,issues.evidence_key)'},
      mechanical_score=COALESCE(excluded.mechanical_score,issues.mechanical_score),
      mechanical_reasons_json=excluded.mechanical_reasons_json, last_hydrated_at=excluded.last_hydrated_at,
      raw_json=excluded.raw_json, provenance_json=excluded.provenance_json;`);
    return {candidate: parts.display, candidate_key: parts.key, evidence_key: evidenceKey};
  }

  async function putReview(record) {
    const parts = candidateParts(record.candidate);
    if (!validDigest(record.evidence_key)) throw new Error('review evidence_key must be a sha256 digest');
    if (!['ACCEPT', 'REJECT'].includes(record.verdict)) throw new Error('review verdict must be ACCEPT or REJECT');
    if (!Number.isFinite(Date.parse(record.reviewed_at ?? ''))) throw new Error('reviewed_at must be an ISO timestamp');
    if (!Number.isFinite(Date.parse(record.expires_at ?? ''))) throw new Error('expires_at must be an ISO timestamp');
    const reviewedAt = new Date(record.reviewed_at).toISOString();
    const expiresAt = new Date(record.expires_at).toISOString();
    const existingIssue = await query(`SELECT candidate_key FROM issues WHERE candidate_key=${sql(parts.key)} LIMIT 1;`);
    if (!existingIssue.length) {
      await upsertIssue({candidate: parts.display, evidence_key: record.evidence_key, profile: record.executor_profile,
        base_commit: record.result?.base_commit, issue_updated_at: record.result?.issue_updated_at,
        raw: record.result, provenance: record.provenance});
    }
    const recordDigest = record.imported_record_sha256 ?? sha256(Buffer.from(canonical(record.result), 'utf8'));
    await execute(`INSERT INTO reviews(
      candidate_key, candidate_display, evidence_key, verdict, tier, executor_profile, review_id,
      result_json, provenance_json, reviewed_at, expires_at, imported_record_sha256
    ) VALUES (
      ${sql(parts.key)}, ${sql(parts.display)}, ${sql(record.evidence_key)}, ${sql(record.verdict)}, ${sql(record.tier)},
      ${sql(record.executor_profile)}, ${sql(record.review_id)}, ${sql(jsonText(record.result, {}))},
      ${sql(jsonText(record.provenance, {}))}, ${sql(reviewedAt)}, ${sql(expiresAt)}, ${sql(recordDigest)}
    ) ON CONFLICT(candidate_key,evidence_key) DO UPDATE SET
      candidate_display=excluded.candidate_display, verdict=excluded.verdict, tier=excluded.tier,
      executor_profile=excluded.executor_profile, review_id=excluded.review_id,
      result_json=excluded.result_json, provenance_json=excluded.provenance_json,
      reviewed_at=excluded.reviewed_at, expires_at=excluded.expires_at,
      imported_record_sha256=excluded.imported_record_sha256;`);
    return getReview(parts.key, record.evidence_key);
  }

  async function getReview(candidate, evidenceKey) {
    const rows = await query(`SELECT * FROM reviews WHERE candidate_key=${sql(canonicalCandidate(candidate))} AND evidence_key=${sql(evidenceKey)} LIMIT 1;`);
    return rowReview(rows[0]);
  }

  async function getCachedReview(candidate, evidenceKey, now = new Date(), {profile = null} = {}) {
    const rows = await query(`SELECT * FROM reviews WHERE candidate_key=${sql(canonicalCandidate(candidate))}
      AND evidence_key=${sql(evidenceKey)} AND expires_at>${sql(now.toISOString())}
      ${profile ? `AND executor_profile=${sql(profile)}` : ''}
      AND verdict IN ('ACCEPT','REJECT') LIMIT 1;`);
    return rowReview(rows[0]);
  }

  async function getIssue(candidate) {
    const rows = await query(`SELECT * FROM issues WHERE candidate_key=${sql(canonicalCandidate(candidate))} LIMIT 1;`);
    if (!rows[0]) return null;
    const row = rows[0];
    return {
      candidate: row.candidate_display,
      candidate_key: row.candidate_key,
      issue_updated_at: row.issue_updated_at,
      evidence_key: row.evidence_key,
      profile: row.profile,
      raw: JSON.parse(row.raw_json),
      provenance: JSON.parse(row.provenance_json),
    };
  }

  async function importQualifications(records, {source = 'qualification-import'} = {}) {
    let imported = 0;
    let unchanged = 0;
    for (const record of records.flatMap(recordsFromJson)) {
      const candidate = qualificationCandidate(record);
      // Finder qualifications carry both the rich qualification digest and the mechanical
      // preflight evidence key. Cache identity must use the latter when present; the complete
      // qualification object (including its own evidence_sha256) remains intact in result_json.
      const evidenceKey = qualificationEvidenceKey(record);
      const review = record.review ?? record.qualification?.review ?? record;
      const terminalVerdicts = {
        ACCEPTED: 'ACCEPT',
        REJECTED_SEMANTIC: 'REJECT',
        REJECTED_DETERMINISTIC: 'REJECT',
      };
      const verdict = review.verdict ?? terminalVerdicts[record.terminal_state] ?? null;
      if (!candidate || !validDigest(evidenceKey) || !['ACCEPT', 'REJECT'].includes(verdict)) continue;
      const reviewedAt = record.reviewed_at ?? review.reviewed_at ?? new Date(0).toISOString();
      const expiresAt = record.qualification_expires_at ?? review.qualification_expires_at
        ?? new Date(Date.parse(reviewedAt) + 2 * 60 * 60 * 1000).toISOString();
      const embedded = record.provenance;
      const provenance = {source, ...(embedded === undefined ? {} : {embedded})};
      const importKey = sha256(Buffer.from(`northset-candidate-import-v1\0${canonical(record)}`, 'utf8'));
      const existingImport = await query(`SELECT import_key FROM imports WHERE import_key=${sql(importKey)} LIMIT 1;`);
      if (existingImport.length) {
        unchanged += 1;
        continue;
      }
      await upsertIssue({
        candidate,
        repository: record.repository ?? review.repository,
        issue: record.issue ?? review.issue,
        profile: review.executor_profile,
        base_commit: record.base_commit ?? review.base_commit,
        evidence_key: evidenceKey,
        issue_updated_at: record.issue_updated_at ?? review.issue_updated_at,
        raw: record,
        provenance,
      });
      await putReview({
        candidate, evidence_key: evidenceKey, verdict, tier: review.tier,
        executor_profile: review.executor_profile, review_id: record.review_id ?? review.review_id,
        result: record, provenance, reviewed_at: reviewedAt, expires_at: expiresAt,
        imported_record_sha256: sha256(Buffer.from(canonical(record), 'utf8')),
      });
      await execute(`INSERT INTO imports(import_key,candidate_key,evidence_key,source,imported_at)
        VALUES (${sql(importKey)},${sql(canonicalCandidate(candidate))},${sql(evidenceKey)},${sql(source)},${sql(new Date().toISOString())});`);
      imported += 1;
    }
    return {imported, unchanged};
  }

  async function importFiles(files) {
    let imported = 0;
    let unchanged = 0;
    for (const file of files) {
      const records = await parseImportFile(file);
      const result = await importQualifications(records, {source: path.resolve(file)});
      imported += result.imported;
      unchanged += result.unchanged;
    }
    return {imported, unchanged, files: files.length};
  }

  async function rank({profile = 'node', count = 100} = {}) {
    if (!Number.isInteger(count) || count < 1 || count > 10_000) throw new Error('rank count must be 1..10000');
    const rows = await query(`SELECT i.*, r.repo_display, r.test_profile, r.install_command,
      r.full_check_commands_json, r.invitation_label_map_json
      FROM issues i JOIN repositories r ON r.repo_key=i.repo_key
      WHERE COALESCE(i.state,'OPEN') IN ('OPEN','open','REVIEWED')
        AND (i.profile=${sql(profile)} OR r.test_profile=${sql(profile)} OR (i.profile IS NULL AND r.test_profile IS NULL))
        AND i.evidence_key IS NOT NULL
        AND i.mechanical_reasons_json='[]'
      ORDER BY COALESCE(i.mechanical_score,-999999) DESC, COALESCE(i.issue_updated_at,'') DESC, i.candidate_key ASC
      LIMIT ${count};`);
    return rows.map((row, index) => {
      const preflight = JSON.parse(row.raw_json);
      const repoPolicy = preflight.repo_policy_snapshot ?? null;
      const repoPolicySha256 = preflight.repo_policy_sha256 ?? null;
      if (repoPolicy !== null && sha256(Buffer.from(canonical(repoPolicy))) !== repoPolicySha256) {
        throw new Error(`candidate ${row.candidate_display} has corrupt repository policy evidence`);
      }
      return {
        rank: index + 1,
        candidate: row.candidate_display,
        evidence_key: row.evidence_key,
        profile: row.profile ?? row.test_profile ?? profile,
        mechanical_score: row.mechanical_score,
        preflight,
        repository_profile: {
          known_test_command: Boolean(row.full_check_commands_json && row.full_check_commands_json !== '[]'),
          install_command: row.install_command,
          commands: JSON.parse(row.full_check_commands_json ?? '[]'),
          invitation_label_map: JSON.parse(row.invitation_label_map_json ?? '{}'),
          repo_policy: repoPolicy,
          repo_policy_sha256: repoPolicySha256,
        },
      };
    });
  }

  async function recordAttempt(record) {
    const parts = candidateParts(record.candidate);
    const existingIssue = await query(`SELECT candidate_key FROM issues WHERE candidate_key=${sql(parts.key)} LIMIT 1;`);
    if (!existingIssue.length) await upsertIssue({candidate: parts.display, raw: {candidate: parts.display}});
    const created = record.created_at ?? new Date().toISOString();
    await execute(`INSERT INTO attempts(mission_id,candidate_key,candidate_display,task_id,attempt_sequence,state,terminal_reason,created_at,updated_at,raw_json)
      VALUES (${sql(record.mission_id)},${sql(parts.key)},${sql(parts.display)},${sql(record.task_id)},${sql(record.attempt_sequence)},
        ${sql(record.state)},${sql(record.terminal_reason)},${sql(created)},${sql(record.updated_at ?? created)},${sql(jsonText(record, {}))})
      ON CONFLICT(mission_id) DO UPDATE SET state=excluded.state,terminal_reason=excluded.terminal_reason,
        updated_at=excluded.updated_at,raw_json=excluded.raw_json;`);
  }

  async function stats() {
    const rows = await query(`SELECT
      (SELECT count(*) FROM repositories) AS repositories,
      (SELECT count(*) FROM issues) AS issues,
      (SELECT count(*) FROM reviews) AS reviews,
      (SELECT count(*) FROM attempts) AS attempts;`);
    return rows[0];
  }

  return {
    database,
    upsertRepository,
    upsertIssue,
    putReview,
    getReview,
    getCachedReview,
    getIssue,
    importQualifications,
    importFiles,
    rank,
    recordAttempt,
    stats,
  };
}

async function main(argv) {
  const command = argv.shift();
  if (!['init', 'import', 'stats'].includes(command)) {
    throw new Error('usage: node candidate-lake.mjs <init|import|stats> --db candidate_lake.sqlite [files...]');
  }
  let database = 'candidate_lake.sqlite';
  const files = [];
  while (argv.length) {
    const value = argv.shift();
    if (value === '--db' || value === '--out') database = argv.shift();
    else if (value.startsWith('--')) throw new Error(`unknown argument ${value}`);
    else files.push(value);
  }
  if (!database) throw new Error('--db requires a path');
  const lake = await openCandidateLake(database);
  if (command === 'import') {
    if (!files.length) throw new Error('import requires one or more JSON/JSONL files');
    process.stdout.write(`${JSON.stringify(await lake.importFiles(files), null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({database: lake.database, ...(await lake.stats())}, null, 2)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`candidate lake error: ${error.message}`);
    process.exitCode = 1;
  });
}
