import {canonical, sha256} from './db.mjs';
import {verifyReadyArtifacts} from './artifact-integrity.mjs';
import {assertPublicationManifest} from './publication-policy.mjs';

const RED_CLASSES = new Set([
  'dependency', 'lockfile', 'ci', 'security', 'migration', 'release',
  'generated', 'public_api',
]);
const AMBER_CLASSES = new Set(['existing_test', 'build', 'configuration', 'writable_copy']);

export function classifyRisk(manifest) {
  const files = Array.isArray(manifest.changed_files) ? manifest.changed_files : [];
  const classes = new Set(files.map((file) => typeof file === 'string' ? 'production' : file.class));
  const lines = Number(manifest.changed_lines ?? files.reduce((total, file) => total + Number(file.lines ?? 0), 0));
  const warnings = Array.isArray(manifest.risk_warnings) ? manifest.risk_warnings : [];
  if (manifest.risk_tier === 'RED' || [...classes].some((value) => RED_CLASSES.has(value))) return 'RED';
  if (manifest.risk_tier === 'AMBER' || files.length > 5 || lines > 300 || warnings.length ||
      [...classes].some((value) => AMBER_CLASSES.has(value))) return 'AMBER';
  return 'GREEN';
}

export function boardDigest(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) {
    throw new Error('board requires one to thirty READY items');
  }
  const subject = {
    schema_version: 1,
    domain: 'northset-factory-board-v1',
    items: items.map((item, index) => ({
      position: index + 1,
      mission_id: item.mission_id,
      item_digest: item.item_digest,
      manifest_sha256: item.manifest_sha256,
      risk_tier: classifyRisk(item.manifest),
    })),
  };
  return sha256(Buffer.from(canonical(subject), 'utf8'));
}

function ageMs(readyAt, now) {
  const value = Date.parse(readyAt);
  if (!Number.isFinite(value)) throw new Error('READY timestamp is invalid');
  return Math.max(0, now.getTime() - value);
}

function consentSummary(manifest, scopeName) {
  const scope = manifest.consent_scopes?.scopes?.[scopeName] ?? {status: 'absent'};
  const parts = [scope.status ?? 'absent'];
  if (scope.evidence) parts.push(`${scope.evidence.kind}: ${scope.evidence.value}`);
  if (scope.granted_at) parts.push(`granted_at: ${scope.granted_at}`);
  if (scope.granted_by) parts.push(`granted_by: ${scope.granted_by}`);
  return parts.map(inline).join(' | ');
}

export function createBoardIfDue(db, {
  minSize = 10,
  maxAgeMinutes = 30,
  maximum = 30,
  force = false,
  now = new Date(),
} = {}) {
  if (!Number.isInteger(minSize) || minSize < 1 || minSize > maximum) throw new Error('board minSize is invalid');
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 30) throw new Error('board maximum must be 1..30');
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes < 0) throw new Error('board max age is invalid');
  const current = db.getCurrentBoard?.();
  if (current) return current;
  const ready = db.listReady({unboarded: true, states: ['PENDING'], limit: maximum});
  if (!ready.length) return null;
  for (const item of ready) assertPublicationManifest(item.manifest);
  const dueByAge = ageMs(ready[0].ready_at, now) >= maxAgeMinutes * 60_000;
  if (!force && ready.length < minSize && !dueByAge && ready.length < maximum) return null;
  const digest = boardDigest(ready);
  const boardId = `B-${digest.slice('sha256:'.length, 'sha256:'.length + 16).toUpperCase()}`;
  return db.insertBoard({boardId, boardDigest: digest, items: ready, createdAt: now});
}

export function approveBoard(db, {
  board: digest,
  ids,
  rejectedIds = [],
  approvedBy = 'internal-user:aeziz',
  approvedAt = new Date(),
  verifyArtifacts = verifyReadyArtifacts,
}) {
  const board = db.getBoard(digest);
  if (!board) throw new Error(`unknown board ${digest}`);
  const selected = new Set(ids);
  const artifactInvalidated = [];
  for (const item of board.items) {
    if (selected.has(item.mission_id) && classifyRisk(item.manifest) === 'RED') {
      throw new Error(`${item.mission_id} is Red and cannot be published by the scaled lane`);
    }
    if (selected.has(item.mission_id)) {
      try { verifyArtifacts(item.manifest); }
      catch (error) { artifactInvalidated.push({mission_id: item.mission_id, reason: error.message}); }
    }
  }
  const invalidIds = new Set(artifactInvalidated.map((item) => item.mission_id));
  const approvedIds = ids.filter((id) => !invalidIds.has(id));
  if (!approvedIds.length && !rejectedIds.length) {
    throw new Error(`all selected missions failed durable artifact verification: ${artifactInvalidated
      .map((item) => `${item.mission_id}: ${item.reason}`).join('; ')}`);
  }
  const result = db.approveBoard(digest, approvedIds, {rejectedIds, approvedBy, now: approvedAt});
  return {
    ...result,
    invalidated_mission_ids: [...new Set([
      ...(result.invalidated_mission_ids ?? []),
      ...artifactInvalidated.map((item) => item.mission_id),
    ])].sort(),
    artifact_errors: Object.fromEntries(artifactInvalidated.map((item) => [item.mission_id, item.reason])),
  };
}

function inline(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function observation(value) {
  if (!value) return 'not recorded';
  const code = value.exit_code ?? value.code;
  const outcome = code === 0 ? 'passed' : `failed (${code ?? 'unknown'})`;
  return `${outcome}; ${value.output_sha256 ?? value.stdout_sha256 ?? 'output hash unavailable'}`;
}

function artifactLink(label, file) {
  if (typeof file !== 'string' || !file) return `${label} unavailable`;
  return `[${label}](<${file.replaceAll('>', '%3E')}>)`;
}

export function renderBoard(board) {
  if (!board?.items?.length) throw new Error('cannot render an empty board');
  const lines = [
    '# OSS factory READY board',
    '',
    `Board: \`${board.board_digest}\``,
    `READY items: ${board.items.length}`,
    '',
    '| Mission | Repository / issue | Risk | Change | Base | Patched |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const item of board.items) {
    const manifest = item.manifest;
    lines.push(`| ${item.mission_id} | ${inline(manifest.repository)}#${inline(manifest.issue_number)} | ${classifyRisk(manifest)} | ${inline(manifest.summary)} | ${inline(observation(manifest.verification?.base_observation))} | ${inline(observation(manifest.verification?.patched_observation))} |`);
  }
  for (const item of board.items) {
    const manifest = item.manifest;
    const files = (manifest.changed_files ?? []).map((file) => typeof file === 'string' ? file : file.path);
    const evidence = manifest.evidence_asset;
    lines.push(
      '',
      `## ${item.mission_id} — ${manifest.repository}#${manifest.issue_number}`,
      '',
      `Risk: **${classifyRisk(manifest)}**`,
      '',
      `Risk warnings: ${(manifest.risk_warnings ?? []).map(inline).join('; ') || 'none'}`,
      '',
      `Upstream target: \`${manifest.repository}:${manifest.base_branch}\``,
      '',
      `Fork target: \`${manifest.fork_repository}:${manifest.branch}\``,
      '',
      ...(evidence ? [
        `Evidence public action: push \`${inline(evidence.repository)}:${inline(evidence.branch)}\` at \`${inline(evidence.commit_oid)}\` before the PR branch.`,
        '',
        `Evidence asset: \`${inline(evidence.path)}\` — \`${inline(evidence.sha256)}\` — [commit-bound evidence URL](<${String(evidence.url).replaceAll('>', '%3E')}>)`,
        '',
      ] : []),
      manifest.invitation_summary ?? 'Invitation and occupancy were confirmed by the live preflight.',
      '',
      manifest.summary ?? '(no summary)',
      '',
      `Changed files: ${files.length ? files.map((file) => `\`${file}\``).join(', ') : '(none)'}`,
      '',
      `Diffstat: ${Number(manifest.changed_lines ?? 0)} changed lines across ${files.length} files`,
      '',
      `Approved patch: \`${manifest.patch_sha256}\` — ${artifactLink('full diff', manifest.patch_path)}`,
      '',
      `Verification evidence: ${artifactLink('verification log', manifest.verification_path)}`,
      '',
      `Declared checks: ${(manifest.checks ?? []).map((check) => `\`${check}\``).join(', ') || '(none)'}`,
      '',
      `Base observation: ${observation(manifest.verification?.base_observation)}`,
      '',
      `Patched observation: ${observation(manifest.verification?.patched_observation)}`,
      '',
      `PR title: ${manifest.pr_title}`,
      '',
      'PR body:',
      '',
      '```markdown',
      String(manifest.pr_body ?? '').trimEnd(),
      '```',
      '',
      `Receipt claim type: \`${inline(manifest.receipt_claim?.type ?? manifest.receipt_claim)}\``,
      '',
      `Receipt claim: ${inline(manifest.receipt_claim?.statement ?? manifest.receipt_claim)}`,
      '',
      `receipt_visibility: ${manifest.receipt_visibility ?? 'private_internal'}`,
      '',
      `contribution_invitation: ${consentSummary(manifest, 'contribution_invitation')}`,
      '',
      `verification_execution_consent: ${consentSummary(manifest, 'verification_execution_consent')}`,
      '',
      `receipt_publication_consent: ${consentSummary(manifest, 'receipt_publication_consent')}`,
      '',
      `marketing_reference_consent: ${consentSummary(manifest, 'marketing_reference_consent')}`,
      '',
      `Receipt: ${manifest.receipt_url ?? 'private internal artifact'}`,
      '',
      `Issue: ${manifest.issue_url}`,
    );
  }
  lines.push('', 'Approval binds the exact item digests, patches, commits, checks, PR text, targets, public actions, and receipt claims shown above.', '');
  return lines.join('\n');
}
