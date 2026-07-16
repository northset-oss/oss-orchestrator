#!/usr/bin/env node

import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical, qualificationSourceEvidencePaths, sha256} from './core.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);

export const FAST_LANE_BLOCKED_CLASSES = new Set([
  'dependency-manifest', 'lockfile', 'build-config', 'container-config', 'generated-output',
  'submodule', 'binary', 'symlink', 'check-or-CI-config', 'rename', 'copy', 'type-change',
  'snapshot-or-fixture', 'nonproduction',
]);

function parsePatchPath(value, prefix) {
  let normalized = value.trim();
  if (normalized.startsWith('"')) {
    try { normalized = JSON.parse(normalized); } catch { return null; }
  }
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : null;
}

function auditedPatchPaths(patch) {
  const sections = [];
  let current = null;
  for (const line of String(patch).split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) sections.push(current);
      current = {oldPath: null, newPath: null, addedLines: []};
      continue;
    }
    if (!current) continue;
    if (current.oldPath === null && line.startsWith('--- ')) {
      current.oldPath = line === '--- /dev/null' ? null : parsePatchPath(line.slice(4), 'a/');
    } else if (current.newPath === null && line.startsWith('+++ ')) {
      current.newPath = line === '+++ /dev/null' ? null : parsePatchPath(line.slice(4), 'b/');
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      current.addedLines.push(line.slice(1));
    }
  }
  if (current) sections.push(current);
  return {
    complete: sections.length > 0 && sections.every((item) => item.oldPath !== null || item.newPath !== null),
    paths: sections.map((item) => item.newPath ?? item.oldPath).filter(Boolean),
    sections,
  };
}

function patchAddsToPaths(audited, text, paths) {
  if (!text) return false;
  const allowed = new Set(paths);
  return audited.sections.some((section) =>
    allowed.has(section.newPath ?? section.oldPath) &&
    section.addedLines.some((line) => line.includes(text)));
}

export function normalizedPrClaimText(body) {
  return String(body ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function lintPrOverclaims(body) {
  const text = normalizedPrClaimText(body);
  const findings = [];
  if (/\b(?:verified|reviewed|approved)\s+by\s+(?:the\s+)?maintainers?\b|\bmaintainer[- ]approved\b|\bmaintainers?\s+(?:have\s+)?(?:approved|verified|reviewed)\b/i.test(text)) {
    findings.push('maintainer approval or verification overclaim');
  }
  if (/\b(?:has|received|earned|with)\s+(?:the\s+)?maintainer(?:'s|s'?)?\s+(?:approval|verification|sign[- ]off)\b/i.test(text)) {
    findings.push('maintainer approval or verification overclaim');
  }
  if (/\b(?:this\s+)?(?:fix|change|patch|implementation)\s+(?:is|was|has been)\s+approved\b/i.test(text)) {
    findings.push('unscoped approval overclaim');
  }
  if (/\bproduction[- ]ready\b|\bready\s+for\s+production\b|\b(?:safe|suitable|approved|validated)\s+for\s+production\b/i.test(text)) {
    findings.push('production readiness overclaim');
  }
  const securityClaim = /\b(?:is|are|remains?|now|fully|proven|guaranteed)\s+secure\b|\bsecurity[- ](?:verified|approved|reviewed|proven|guaranteed)\b|\bsecurity\s+(?:is|was|has been)\s+(?:improved|enhanced|strengthened|verified|proven|guaranteed)\b|\b(?:improves?|enhances?|strengthens?|ensures?|guarantees?)\s+(?:the\s+)?security\b|\bno\s+(?:known\s+)?vulnerabilit(?:y|ies)\b|\bvulnerabilit(?:y|ies)[- ]free\b|\bfree\s+(?:of|from)\s+vulnerabilit(?:y|ies)\b|\bvulnerabilit(?:y|ies)\s+(?:is|are|was|were|has been|have been)\s+(?:fixed|resolved|eliminated|removed)\b|\b(?:fixes?|resolves?|eliminates?|prevents?|removes?)\s+(?:all\s+|any\s+|a\s+|the\s+)?(?:security\s+(?:issues?|risks?)|vulnerabilit(?:y|ies))\b/i;
  if (securityClaim.test(text)) findings.push('security or vulnerability overclaim');
  if (/\b(?:high|production|excellent|good)[- ]quality\b|\bquality[- ](?:verified|approved|proven|guaranteed)\b|\b(?:improves?|enhances?|ensures?|guarantees?)\s+(?:the\s+)?(?:code\s+)?quality\b|\b(?:code\s+)?quality\s+(?:is|was|has been)\s+(?:high|good|excellent|improved|verified|proven|approved|guaranteed)\b/i.test(text)) {
    findings.push('code quality overclaim');
  }
  if (/\b(?:is|are|now|fully|proven|guaranteed)\s+correct\b|\bcorrectness[- ](?:verified|approved|proven|guaranteed)\b|\bcorrectness\s+(?:is|was|has been)\s+(?:verified|approved|proven|guaranteed|established)\b|\b(?:proves?|ensures?|guarantees?|verifies?|establishes?)\s+(?:the\s+)?correctness\b|\b(?:fix|patch|change|implementation|code|behavior|result)\s+(?:is|was|has been)\s+(?:fully\s+)?correct\b|\bcorrectly\s+(?:fixes?|handles?|implements?|resolves?)\b|\b(?:works?|behaves?)\s+correctly\b/i.test(text)) {
    findings.push('correctness overclaim');
  }
  if (/\b(?:will|shall|should|is going to|guaranteed to|expected to|likely to)\s+(?:be\s+)?merge(?:d)?\b|\b(?:will|shall|expected to|likely to)\s+be\s+accepted\b|\bmaintainers?\s+(?:will|shall|should)\s+(?:accept|merge)\b|\bready\s+to\s+merge\b|\bguaranteed\s+(?:acceptance|merge)\b|\b(?:merge|acceptance)\s+is\s+guaranteed\b|\bwill\s+land\b/i.test(text)) {
    findings.push('merge prediction overclaim');
  }
  if (/\ball\s+(?:checks|tests|CI)\s+(?:pass|passed|are passing)\b/i.test(text) &&
      !/all\s+declared\s+(?:checks|tests)/i.test(text)) {
    findings.push('unscoped all-checks-pass overclaim');
  }
  if (/\bfully\s+tested\b|\bcomplete(?:ly)?\s+verified\b/i.test(text)) findings.push('unbounded verification overclaim');
  return findings;
}

export function reviewPatch({spec, classes, patch, prBody}) {
  if (!spec || typeof spec !== 'object') throw new Error('patch review requires a mission spec');
  if (!Array.isArray(classes) || !classes.length) throw new Error('patch review requires changed-file classes');
  if (typeof patch !== 'string' || !patch.trim()) throw new Error('patch review requires exact patch bytes');
  const blocking = [];
  const risks = [];
  const classPaths = classes.map((item) => item?.path);
  if (classPaths.some((file) => typeof file !== 'string' || !file.trim()) ||
      new Set(classPaths).size !== classPaths.length) {
    blocking.push('changed-file classes must contain one unique non-empty path per file');
  }
  const audited = auditedPatchPaths(patch);
  if (!audited.complete) {
    blocking.push('patch file boundaries could not be audited deterministically');
  } else {
    const expected = [...new Set(audited.paths)].sort();
    const supplied = [...new Set(classPaths)].sort();
    if (canonical(expected) !== canonical(supplied)) {
      blocking.push(`changed-file classes do not match exact patch paths: patch=${expected.join(', ')} classes=${supplied.join(', ')}`);
    }
  }

  const blocked = classes.filter((item) => FAST_LANE_BLOCKED_CLASSES.has(item.class));
  if (blocked.length) {
    blocking.push(`fast lane forbids ${blocked.map((item) => `${item.class}:${item.path}`).join(', ')}`);
  }
  const modifiedTests = classes.filter((item) => item.class === 'modified-existing-test');
  if (modifiedTests.length && spec.allow_modified_existing_tests !== true) {
    blocking.push(`fast lane forbids modified existing tests unless the spec explicitly elevates them: ${modifiedTests.map((item) => item.path).join(', ')}`);
  } else if (modifiedTests.length) {
    risks.push({code: 'modified-existing-test-elevated', files: modifiedTests.map((item) => item.path)});
  }
  if (/^GIT binary patch$/m.test(patch) || /^new file mode 120000$/m.test(patch) || /^rename (?:from|to) /m.test(patch)) {
    blocking.push('patch bytes contain binary, symlink, or rename metadata');
  }

  const production = classes.filter((item) => item.class === 'source');
  if (spec.work_category === 'defect_fix' && production.length === 0) {
    blocking.push('defect fix must change at least one production source file');
  }
  const oracleClasses = new Map(classes.map((item) => [item.path, item.class]));
  const missingOracle = (spec.oracle?.test_paths ?? []).filter((file) => !['added-test', 'modified-existing-test'].includes(oracleClasses.get(file)));
  if (missingOracle.length) blocking.push(`oracle regression paths are not changed tests: ${missingOracle.join(', ')}`);
  if (!(spec.oracle?.test_paths ?? []).some((file) => oracleClasses.get(file) === 'added-test') && modifiedTests.length === 0) {
    blocking.push('patch does not add an oracle-bound regression test');
  }
  const marker = spec.oracle?.base_failure_contains;
  if (typeof marker !== 'string' || !marker.trim() ||
      !patchAddsToPaths(audited, marker, spec.oracle?.test_paths ?? [])) {
    blocking.push('oracle failure marker is not present in added lines of an oracle test path');
  }

  let evidencePaths = [];
  try {
    evidencePaths = qualificationSourceEvidencePaths(spec, {required: spec.work_category === 'defect_fix'});
  } catch (error) {
    blocking.push(error.message);
  }
  if (spec.work_category === 'defect_fix' && production.length &&
      !production.some((item) => evidencePaths.includes(item.path))) {
    blocking.push('production change does not touch any source-evidence path');
  }

  if (modifiedTests.length && /^-.*\b(?:assert|expect|should|must)\b/im.test(patch)) {
    blocking.push('modified existing test removes an assertion-like line');
  }
  const overclaims = lintPrOverclaims(prBody);
  blocking.push(...overclaims.map((finding) => `PR body: ${finding}`));

  const review = {
    schema_version: 1,
    mission_id: spec.mission_id,
    ready: blocking.length === 0,
    blocking_reasons: blocking,
    risks,
    changed_files: classes.map(({path: file, class: fileClass}) => ({path: file, class: fileClass})),
    production_files: production.map((item) => item.path),
    oracle_test_paths: spec.oracle?.test_paths ?? [],
    patch_sha256: sha256(Buffer.from(patch)),
    pr_body_sha256: sha256(Buffer.from(String(prBody ?? ''))),
  };
  return {...review, review_digest: sha256(Buffer.from(canonical(review), 'utf8'))};
}

async function loadInput(value) {
  const resolved = path.resolve(value);
  const info = await stat(resolved);
  const file = info.isDirectory() ? path.join(resolved, 'patch-review-input.json') : resolved;
  const input = JSON.parse(await readFile(file, 'utf8'));
  if (input.patch_file) input.patch = await readFile(path.resolve(path.dirname(file), input.patch_file), 'utf8');
  if (input.pr_body_file) input.prBody = await readFile(path.resolve(path.dirname(file), input.pr_body_file), 'utf8');
  return input;
}

async function main(argv) {
  if (argv.length !== 1 || ['-h', '--help'].includes(argv[0])) {
    process.stdout.write('usage: node review-patch.mjs <patch-review-input.json|ready-pack>\n');
    process.exitCode = argv.length === 1 ? 0 : 1;
    return;
  }
  const result = reviewPatch(await loadInput(argv[0]));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ready) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`patch review error: ${error.message}`);
    process.exitCode = 1;
  });
}
