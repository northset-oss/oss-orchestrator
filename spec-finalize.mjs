#!/usr/bin/env node

import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROFILE_REGISTRY, taskIdForCandidate, validateSpec} from './core.mjs';

const SCRIPT_FILE = fileURLToPath(import.meta.url);

function clone(value) {
  return structuredClone(value);
}

function nonEmptyObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new Error(`${label} must be a non-empty object`);
  }
  return value;
}

export function finalizeSpec(draftValue, {
  missionId,
  attemptSequence,
  repoPolicySnapshot,
  authoringMode,
} = {}) {
  const source = draftValue?.spec_draft ?? draftValue;
  if (!source || source.schema_version !== 2) throw new Error('spec draft must use schema_version 2');
  if (!/^M-[0-9]{3,}$/.test(missionId ?? '')) throw new Error('missionId must have the form M-100');
  if (!Number.isInteger(attemptSequence) || attemptSequence < 1) throw new Error('attemptSequence must be a positive integer');
  nonEmptyObject(repoPolicySnapshot, 'repoPolicySnapshot');
  const spec = clone(source);
  const profile = spec.executor?.profile;
  const registered = PROFILE_REGISTRY.profiles[profile];
  if (!registered) throw new Error(`executor profile must be one of ${Object.keys(PROFILE_REGISTRY.profiles).join(', ')}`);
  if ((spec.oracle?.test_paths ?? []).some((item) => /TO_FILL/i.test(item)) ||
      /TO_FILL/i.test(spec.oracle?.base_failure_contains ?? '') || /TO_FILL/i.test(spec.oracle?.command ?? '')) {
    throw new Error('oracle path, command, and exact base-failure marker must be completed before finalization');
  }

  spec.mission_id = missionId;
  spec.task_id = taskIdForCandidate(spec.candidate);
  spec.attempt_sequence = attemptSequence;
  spec.authoring_mode = authoringMode ?? spec.authoring_mode ?? 'test_only_then_fix';
  spec.allow_modified_existing_tests ??= false;
  spec.non_goals ??= [...(spec.qualification?.acceptance_contract?.non_goals ?? [])];
  spec.source_evidence ??= [...(spec.qualification?.source_evidence ?? [])];
  spec.executor = {
    ...spec.executor,
    image: registered.image,
    profile_status: registered.status,
    profile_production_proven: registered.production_proven,
  };
  spec.receipt = {
    ...(spec.receipt ?? {}),
    repo_policy_snapshot: clone(repoPolicySnapshot),
    checks_not_run: [...(spec.receipt?.checks_not_run ?? [])],
    limitations: spec.receipt?.limitations ?? [
      'Does not prove code quality',
      'Does not prove security',
      "Contributor self-run record of Northset's own contribution; not the maintainer's verification.",
    ],
  };
  validateSpec(spec);
  return spec;
}

function parseArgs(argv) {
  const input = argv.shift();
  if (!input || ['-h', '--help'].includes(input)) return {help: true};
  const options = {input: path.resolve(input), output: null, missionId: null, attemptSequence: null, policyFile: null, authoringMode: null};
  while (argv.length) {
    const value = argv.shift();
    if (value === '--mission-id') options.missionId = argv.shift();
    else if (value === '--attempt-sequence') options.attemptSequence = Number(argv.shift());
    else if (value === '--repo-policy-snapshot') options.policyFile = path.resolve(argv.shift());
    else if (value === '--authoring-mode') options.authoringMode = argv.shift();
    else if (value === '--output') options.output = path.resolve(argv.shift());
    else throw new Error(`unknown argument ${value}`);
  }
  if (!options.missionId || !options.attemptSequence || !options.policyFile) {
    throw new Error('--mission-id, --attempt-sequence, and --repo-policy-snapshot are required');
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write('usage: node spec-finalize.mjs draft.json --mission-id M-100 --attempt-sequence 1 --repo-policy-snapshot policy.json [--output spec.json]\n');
    return;
  }
  const [draft, policy] = await Promise.all([
    readFile(options.input, 'utf8').then(JSON.parse),
    readFile(options.policyFile, 'utf8').then(JSON.parse),
  ]);
  const spec = finalizeSpec(draft, {
    missionId: options.missionId,
    attemptSequence: options.attemptSequence,
    repoPolicySnapshot: policy,
    authoringMode: options.authoringMode,
  });
  const output = `${JSON.stringify(spec, null, 2)}\n`;
  if (options.output) await writeFile(options.output, output, {mode: 0o600});
  process.stdout.write(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`spec finalization error: ${error.message}`);
    process.exitCode = 1;
  });
}
