import {canonical, sha256} from './db.mjs';

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
  const ready = db.listReady({unboarded: true, states: ['PENDING'], limit: maximum});
  if (!ready.length) return null;
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
}) {
  const board = db.getBoard(digest);
  if (!board) throw new Error(`unknown board ${digest}`);
  const selected = new Set(ids);
  for (const item of board.items) {
    if (selected.has(item.mission_id) && classifyRisk(item.manifest) === 'RED') {
      throw new Error(`${item.mission_id} is Red and cannot be published by the scaled lane`);
    }
  }
  return db.approveBoard(digest, ids, {rejectedIds, approvedBy, now: approvedAt});
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
    lines.push(
      '',
      `## ${item.mission_id} — ${manifest.repository}#${manifest.issue_number}`,
      '',
      `Risk: **${classifyRisk(manifest)}**`,
      '',
      manifest.invitation_summary ?? 'Invitation and occupancy were confirmed by the live preflight.',
      '',
      manifest.summary ?? '(no summary)',
      '',
      `Changed files: ${files.length ? files.map((file) => `\`${file}\``).join(', ') : '(none)'}`,
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
      `Receipt claim: \`${inline(manifest.receipt_claim?.type ?? manifest.receipt_claim)}\``,
      '',
      `Receipt: ${manifest.receipt_url}`,
    );
  }
  lines.push('', 'Approval binds the exact item digests, patches, commits, checks, PR text, targets, and receipt claims shown above.', '');
  return lines.join('\n');
}
