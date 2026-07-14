import assert from 'node:assert/strict';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  authorDockerArgs,
  attemptLineageForSpec,
  buildEconomicInput,
  assertOracleChangedPaths,
  canonicalCommitArgs,
  changedEntries,
  checkDockerArgs,
  classifyChangedFiles,
  copyNodeDependencies,
  dependencyBootstrapDockerArgs,
  PREPARE_BUDGET_MS,
  removeRunWorkspace,
  runAuthorContainer,
} from './oss.mjs';
import {
  OSS_IDENTITY,
  assertBindingChain,
  assertOssCommitIdentity,
  assertPatchCommitBinding,
  directoryDigest,
  authorEffort,
  git,
  manifestDigest,
  possibleOverlappingPrs,
  prBody,
  recheck,
  receiptFooter,
  timelineApiArgs,
  timelineCrossReferences,
  taskIdForCandidate,
  validateSpec,
  validateSpecs,
} from './core.mjs';

const oid = (char) => char.repeat(40);
const digest = (char) => `sha256:${char.repeat(64)}`;

function spec(overrides = {}) {
  return {
    schema_version: 1,
    mission_id: 'M-010',
    candidate: 'owner/repo#123',
    target_repo: 'https://github.com/owner/repo',
    issue_url: 'https://github.com/owner/repo/issues/123',
    base_branch: 'main',
    base_commit: oid('a'),
    problem_statement: 'The parser returns the wrong value for a bounded input.',
    acceptance_criteria: ['The focused regression passes for that input.'],
    constraints: ['Do not change dependencies or public API.'],
    implementation_hints: [],
    process_requirements: [],
    qualification: {
      review_id: digest('1'),
      review_prompt_version: 2,
      reviewed_at: '2026-07-13T12:00:00Z',
      qualification_expires_at: '2026-07-13T14:00:00Z',
      evidence_sha256: digest('2'),
      issue_updated_at: '2026-07-13T11:00:00Z',
      invitation_evidence: {
        type: 'label', url: 'https://github.com/owner/repo/issues/123', observed_at: '2026-07-13T12:00:00Z',
      },
      pre_author_notice_required: false,
      pre_author_notice: null,
      acceptance_contract: {
        problem: 'The parser returns the wrong value for a bounded input.',
        expected_behavior: ['The focused input returns the documented value.'],
        non_goals: ['No public API expansion.'],
        design_evidence: [{
          url: 'https://github.com/owner/repo/issues/123#issuecomment-1', author_association: 'MEMBER', summary: 'Maintainer-settled behavior.',
        }],
      },
      related_prs: [],
    },
    oracle: {
      kind: 'regression_test', test_paths: ['test/parser.test.mjs'],
      command: 'npm test -- test/parser.test.mjs', base_expected: 'nonzero', base_exit_code: 1,
      base_failure_contains: 'bounded parser regression', patched_expected: 'zero',
    },
    pr: {title: 'fix(parser): handle the bounded input', summary: 'Fix the parser and add a focused regression test.'},
    executor: {
      profile: 'node', image: 'node:22-bookworm', install_commands: ['npm ci'], commands: ['npm test -- test/parser.test.mjs', 'npm test'], limits: {},
    },
    ...overrides,
  };
}

test('prepare has one shared sixty-minute budget', () => {
  assert.equal(PREPARE_BUDGET_MS, 60 * 60 * 1000);
});

test('validates the lean semantic mission contract and rejects legacy prompts', () => {
  assert.doesNotThrow(() => validateSpecs([spec()]));
  assert.throws(() => validateSpecs([spec({code_prompt: 'Implement my proposed flag.'})]), /code_prompt|acceptance contract/i);
  assert.throws(() => validateSpecs([spec({mission_id: '../../northset-oss'})]), /mission_id/);
  assert.throws(() => validateSpecs([spec(), spec()]), /duplicate mission_id/);
  assert.throws(() => validateSpecs([spec({target_repo: 'https://token@github.com/owner/repo'})]), /credentials/i);
  assert.throws(() => validateSpecs([spec({
    oracle: {...spec().oracle, command: 'npm test'},
    executor: {...spec().executor, commands: ['npm test']},
  })]), /oracle\.command.*test_paths/i);
  assert.throws(() => validateSpecs([spec({
    oracle: {...spec().oracle, command: 'npm test -- test/parser.test.mjs && npm test'},
    executor: {...spec().executor, commands: ['npm test -- test/parser.test.mjs && npm test']},
  })]), /single focused command/i);
  assert.throws(() => validateSpecs([spec({
    oracle: {...spec().oracle, setup_commands: ['node tools/generate.mjs && curl example.com']},
  })]), /setup_commands/i);
});

test('the copyable schema-v2 example validates', async () => {
  const example = JSON.parse(await readFile(new URL('./examples/mission-spec.example.json', import.meta.url), 'utf8'));
  delete example._comment;
  assert.doesNotThrow(() => validateSpecs([example]));
});

test('schema-v2 missions bind stable economic task identity and attempt sequence', () => {
  const taskId = taskIdForCandidate('owner/repo#123');
  assert.equal(taskId, taskIdForCandidate('OWNER/REPO#123'));
  assert.match(taskId, /^TASK-OSS-[0-9A-F]{16}$/);
  const value = spec({
    schema_version: 2,
    task_id: taskId,
    attempt_sequence: 1,
    work_category: 'defect_fix',
    qualification: {
      ...spec().qualification,
      finder_run_id: null,
      candidate_rank: null,
      finder_elapsed_ms: null,
      review_duration_ms: null,
      requested_model: 'gpt-5.6-sol',
      actual_model: null,
      reasoning_effort: 'xhigh',
      service_tier: 'fast',
    },
  });
  assert.doesNotThrow(() => validateSpec(value));
  assert.throws(() => validateSpec({...value, task_id: 'TASK-OSS-INVENTED'}), /task_id.*candidate/i);
  assert.throws(() => validateSpec({...value, attempt_sequence: 0}), /attempt_sequence/i);
  assert.throws(() => validateSpec({...value, work_category: 'revenue_generation'}), /work_category/i);
});

test('schema-v2 economic input reports observed scope and preserves unknown costs', () => {
  const value = spec({
    schema_version: 2,
    task_id: taskIdForCandidate('owner/repo#123'),
    attempt_sequence: 1,
    work_category: 'defect_fix',
    qualification: {
      ...spec().qualification,
      finder_run_id: 'd86d9ac8-99ce-4dc0-b18e-579f6f0b9d78',
      candidate_rank: 2,
      finder_elapsed_ms: 1200,
      review_duration_ms: 3000,
      requested_model: 'gpt-5.6-sol',
      actual_model: null,
      reasoning_effort: 'xhigh',
      service_tier: 'fast',
    },
  });
  const economic = buildEconomicInput(value, {
    missionSha256: digest('3'),
    issueSnapshotSha256: digest('4'),
    result: {
      changedFiles: ['src/parser.mjs', 'test/parser.test.mjs'],
      lines: 18,
      classes: [
        {path: 'src/parser.mjs', class: 'source'},
        {path: 'test/parser.test.mjs', class: 'added-test'},
      ],
    },
    authorUsage: {
      bootstrap_duration_ms: 1800, bootstrap_retry_count: 0, author_duration_ms: 5000,
      requested_model: 'gpt-5.6-sol', actual_model: null, reasoning_effort: 'xhigh', service_tier: 'fast',
      model_requests: null, input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_tokens: null,
    },
    timings: [{stage: 'clone', duration_ms: 2200}],
    totalDurationMs: 9000,
    attempts: [{attempt_id: 'M-010', attempt_sequence: 1, state: 'READY', terminal_reason_class: null}],
  });
  assert.equal(economic.task.task_id, value.task_id);
  assert.equal(economic.work_scope.production_files, 1);
  assert.equal(economic.work_scope.test_files, 1);
  assert.equal(economic.usage.authoring.duration_ms, 5000);
  assert.equal(economic.costs.status, 'partial');
  assert.equal(economic.costs.total_economic_cost, null);
  assert.ok(economic.costs.missing_components.includes('model_inference'));
  assert.equal(JSON.stringify(economic).includes('estimated'), false);
});

test('attempt lineage includes every task-bound attempt and rejects sequence gaps', async (t) => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'northset-attempt-lineage-'));
  t.after(() => rm(runsDir, {recursive: true, force: true}));
  const taskId = taskIdForCandidate('owner/repo#123');
  await mkdir(path.join(runsDir, 'M-010'));
  await writeFile(path.join(runsDir, 'M-010', 'attempt.json'), `${JSON.stringify({
    schema_version: 2,
    mission_id: 'M-010',
    task_id: taskId,
    attempt_sequence: 1,
    state: 'FAILED_ORACLE',
    terminal_reason: 'canonical verifier rejected the receipt',
  })}\n`);
  const current = spec({
    schema_version: 2,
    mission_id: 'M-011',
    task_id: taskId,
    attempt_sequence: 2,
    work_category: 'defect_fix',
  });
  const lineage = await attemptLineageForSpec(runsDir, current);
  assert.deepEqual(lineage, [
    {attempt_id: 'M-010', attempt_sequence: 1, state: 'FAILED_ORACLE', terminal_reason_class: 'verification'},
    {attempt_id: 'M-011', attempt_sequence: 2, state: 'READY', terminal_reason_class: null},
  ]);
  await assert.rejects(
    attemptLineageForSpec(runsDir, {...current, attempt_sequence: 3}),
    /contiguous|sequence/i,
  );

  await writeFile(path.join(runsDir, 'M-010', 'attempt.json'), `${JSON.stringify({
    schema_version: 2,
    mission_id: 'M-010',
    task_id: taskId,
    attempt_sequence: 1,
    state: 'READY',
    terminal_reason_class: null,
  })}\n`);
  await writeFile(path.join(runsDir, 'M-010', 'ship.journal.json'), `${JSON.stringify({
    schema_version: 2,
    mission_id: 'M-010',
    state: 'ABORTED_STALE',
  })}\n`);
  assert.deepEqual(await attemptLineageForSpec(runsDir, current), [
    {attempt_id: 'M-010', attempt_sequence: 1, state: 'ABORTED_STALE', terminal_reason_class: 'precondition_drift'},
    {attempt_id: 'M-011', attempt_sequence: 2, state: 'READY', terminal_reason_class: null},
  ]);

  await rm(path.join(runsDir, 'M-010', 'ship.journal.json'));
  await assert.rejects(attemptLineageForSpec(runsDir, current), /prior attempt.*not terminal/i);

  await writeFile(path.join(runsDir, 'M-010', 'ship.journal.json'), `${JSON.stringify({
    schema_version: 2,
    mission_id: 'M-010',
    state: 'SHIPPED',
  })}\n`);
  await assert.rejects(attemptLineageForSpec(runsDir, current), /already shipped/i);
});

test('a repository-required pre-author notice is a live, bound gate', () => {
  const value = spec({
    process_requirements: ['Tell maintainers before beginning work to avoid duplicate effort.'],
    qualification: {
      ...spec().qualification,
      pre_author_notice_required: true,
      pre_author_notice: {
        url: 'https://github.com/owner/repo/issues/123#issuecomment-99',
        observed_at: '2026-07-13T12:00:00Z',
      },
    },
  });
  assert.doesNotThrow(() => validateSpecs([value]));
  const missing = structuredClone(value);
  missing.qualification.pre_author_notice = null;
  assert.throws(() => validateSpecs([missing]), /pre_author_notice/i);
});

test('repository-policy invitations require pinned, content-bound evidence', () => {
  const invitation = {
    type: 'repository_policy',
    url: `https://github.com/owner/repo/blob/${oid('a')}/CONTRIBUTING.md#L10-L14`,
    observed_at: '2026-07-13T12:00:00Z',
    content_sha256: digest('4'),
  };
  const value = spec({qualification: {
    ...spec().qualification,
    invitation_evidence: invitation,
    acceptance_contract: {
      ...spec().qualification.acceptance_contract,
      design_evidence: [{
        url: invitation.url,
        author_association: 'REPOSITORY_POLICY',
        summary: 'The pinned repository policy marks these issues as ready for contributors.',
        content_sha256: digest('4'),
      }, {
        url: `https://github.com/owner/repo/blob/${oid('a')}/docs/bug-policy.md#L1-L4`,
        author_association: 'REPOSITORY_POLICY',
        summary: 'A separate pinned bug policy settles the issue status.',
        content_sha256: digest('5'),
      }],
    },
  }});
  assert.doesNotThrow(() => validateSpecs([value]));
  const missingDigest = structuredClone(value);
  delete missingDigest.qualification.invitation_evidence.content_sha256;
  assert.throws(() => validateSpecs([missingDigest]), /content_sha256/i);
  const mutableUrl = structuredClone(value);
  mutableUrl.qualification.invitation_evidence.url = 'https://github.com/owner/repo/blob/main/CONTRIBUTING.md';
  mutableUrl.qualification.acceptance_contract.design_evidence[0].url = mutableUrl.qualification.invitation_evidence.url;
  assert.throws(() => validateSpecs([mutableUrl]), /base commit/i);
});

test('a maintainer-authored candidate issue is valid design evidence', () => {
  const value = spec();
  value.qualification.acceptance_contract.design_evidence = [{
    url: value.issue_url,
    author_association: 'OWNER',
    summary: 'The owner-authored issue settles the bounded behavior.',
  }];
  assert.doesNotThrow(() => validateSpecs([value]));
});

test('only the smoke-tested node profile and approved reasoning values are accepted', () => {
  assert.equal(authorEffort(spec()), 'xhigh');
  assert.equal(authorEffort(spec({executor: {...spec().executor, reasoning_effort: 'xhigh'}})), 'xhigh');
  assert.throws(() => validateSpecs([spec({executor: {...spec().executor, profile: 'go'}})]), /profile/);
  assert.throws(() => validateSpecs([spec({executor: {...spec().executor, reasoning_effort: 'ultra'}})]), /reasoning_effort/);
});

test('dependency bootstrap has no credential mount; author mount appears only in author phase', async () => {
  const value = spec();
  const bootstrap = dependencyBootstrapDockerArgs(value, '/runs/M-010/author', 'node@sha256:' + '9'.repeat(64));
  const author = authorDockerArgs(value, '/runs/M-010/author', 'node@sha256:' + '9'.repeat(64), '/secret/codex');
  assert.equal(bootstrap.some((part) => String(part).includes('/secret/codex')), false);
  assert.equal(bootstrap.includes('CODEX_HOME=/codex-home'), false);
  assert.ok(author.some((part) => String(part).includes('src=/secret/codex,dst=/codex-home')));
  for (const plan of [bootstrap, author]) {
    assert.ok(plan.includes('--rm'));
    assert.ok(plan.includes('--cap-drop=ALL'));
    assert.deepEqual(plan.slice(plan.indexOf('--security-opt'), plan.indexOf('--security-opt') + 2), ['--security-opt', 'no-new-privileges']);
  }
  const dry = await runAuthorContainer(value, {base: '/runs/M-010', authorWorkspace: '/runs/M-010/author'}, {dryRun: true});
  assert.match(dry.codex.join(' '), /Problem statement:/);
  assert.match(dry.codex.join(' '), /Red\/green requirement/);
  assert.match(dry.codex.join(' '), /Do not edit repository pull-request templates/);
  assert.doesNotMatch(dry.codex.join(' '), /code_prompt/);
});

test('spec validation rejects public-receipt limitations that omit exact baseline claims', () => {
  assert.throws(() => validateSpec(spec({
    receipt: {limitations: ['Does not prove code quality or security.']},
  })), /limitations.*Does not prove code quality/i);
});

test('dependency bootstrap retries one infrastructure failure within the same author attempt', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'northset-dependency-bootstrap-retry-'));
  t.after(() => rm(base, {recursive: true, force: true}));
  let bootstrapRuns = 0;
  const runImpl = async (command, args) => {
    assert.equal(command, 'docker');
    if (args.includes('northset-m-010-dependency-bootstrap') && args[0] === 'run') {
      bootstrapRuns += 1;
      if (bootstrapRuns === 1) return {code: 125, stdout: '', stderr: 'temporary Docker daemon failure', durationMs: 11};
      return {code: 0, stdout: '', stderr: '', durationMs: 13};
    }
    return {code: 0, stdout: '', stderr: '', durationMs: args[0] === 'run' ? 17 : 0};
  };

  const result = await runAuthorContainer(spec(), {
    base,
    authorWorkspace: path.join(base, 'author-workspace'),
  }, {runImpl, authorImage: 'sha256:' + '8'.repeat(64)});

  assert.equal(bootstrapRuns, 2);
  assert.deepEqual(result.usage, {
    bootstrap_duration_ms: 24,
    bootstrap_retry_count: 1,
    author_duration_ms: 17,
    requested_model: 'gpt-5.6-sol',
    actual_model: null,
    reasoning_effort: 'xhigh',
    service_tier: 'fast',
    model_requests: null,
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
  });
});

test('author plan uses the prebuilt image and performs no per-mission Codex install', async () => {
  const dry = await runAuthorContainer(spec(), {
    base: '/runs/M-010', authorWorkspace: '/runs/M-010/author-workspace',
  }, {dryRun: true, authorImage: 'sha256:' + '8'.repeat(64)});
  assert.ok(dry.author.includes('sha256:' + '8'.repeat(64)));
  assert.doesNotMatch(dry.author.join(' '), /npm install.*@openai\/codex/);
  assert.equal(Object.hasOwn(dry, 'codexBootstrap'), false);
});

test('run workspace cleanup retries transient non-empty directory races', async () => {
  const calls = [];
  await removeRunWorkspace('/tmp/northset-run', async (...args) => calls.push(args));
  assert.deepEqual(calls, [[
    '/tmp/northset-run',
    {recursive: true, force: true, maxRetries: 5, retryDelay: 100},
  ]]);
});

test('oracle dependency copy preserves the workspace-level offline Corepack cache', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'northset-oracle-dependencies-'));
  t.after(() => rm(base, {recursive: true, force: true}));
  const sourceWorkspace = path.join(base, 'source');
  const targetWorkspace = path.join(base, 'target');
  const marker = path.join('.northset', 'bootstrap-home', '.cache', 'node', 'corepack', 'marker');
  const installState = path.join('repo', '.yarn', 'install-state.gz');
  await mkdir(path.dirname(path.join(sourceWorkspace, marker)), {recursive: true});
  await writeFile(path.join(sourceWorkspace, marker), 'offline cache');
  await mkdir(path.dirname(path.join(sourceWorkspace, installState)), {recursive: true});
  await writeFile(path.join(sourceWorkspace, installState), 'install state');
  await copyNodeDependencies(path.join(sourceWorkspace, 'repo'), path.join(targetWorkspace, 'repo'));
  assert.equal(await readFile(path.join(targetWorkspace, marker), 'utf8'), 'offline cache');
  assert.equal(await readFile(path.join(targetWorkspace, installState), 'utf8'), 'install state');
});

test('host normalization bypasses repository hooks before isolated verification', () => {
  const args = canonicalCommitArgs(spec());
  assert.ok(args.includes('--no-verify'));
  assert.ok(args.includes('-s'));
});

test('differential oracle checks use a read-only root and network-off sandbox', () => {
  const value = spec();
  const args = checkDockerArgs(value, '/runs/M-010/oracle', 'node@sha256:' + '9'.repeat(64), value.oracle.command);
  assert.ok(args.includes('--network'));
  assert.ok(args.includes('none'));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.some((part) => String(part).includes('dst=/workspace,readonly')));
  assert.deepEqual(args.slice(args.indexOf('--tmpfs'), args.indexOf('--tmpfs') + 2), [
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=512m',
  ]);
  assert.ok(args.includes('COREPACK_HOME=/workspace/.northset/bootstrap-home/.cache/node/corepack'));
  assert.equal(args.at(-1).trim().endsWith(value.oracle.command), true);
});

test('changed-file risk classes reject dependency, CI, binary, and existing-test mutations', () => {
  const classes = classifyChangedFiles(
    ['src/index.mjs', 'test/existing.test.mjs', 'package.json', '.github/workflows/test.yml'],
    [
      {path: 'src/index.mjs'}, {path: 'test/existing.test.mjs'}, {path: 'test/new.test.mjs'},
      {path: 'package.json'}, {path: '.github/workflows/test.yml'}, {path: 'blob.dat', binary: true},
    ],
  );
  const byPath = Object.fromEntries(classes.map((item) => [item.path, item]));
  assert.equal(byPath['src/index.mjs'].flagged, false);
  assert.equal(byPath['test/new.test.mjs'].class, 'added-test');
  assert.equal(byPath['test/existing.test.mjs'].flagged, true);
  assert.equal(byPath['package.json'].class, 'dependency-manifest');
  assert.equal(byPath['.github/workflows/test.yml'].class, 'check-or-CI-config');
  assert.equal(byPath['blob.dat'].class, 'binary');
});

test('the differential oracle is bound to newly added test files', () => {
  const value = spec();
  const classes = [
    {path: 'src/index.mjs', class: 'source'},
    {path: 'test/parser.test.mjs', class: 'added-test'},
  ];
  assert.doesNotThrow(() => assertOracleChangedPaths(value, classes));
  assert.doesNotThrow(() => assertOracleChangedPaths(value, [
    {path: 'test/parser.test.mjs', class: 'modified-existing-test'},
  ]));
  assert.throws(() => assertOracleChangedPaths(value, [
    {path: 'test/parser.test.mjs', class: 'rename'},
  ]), /newly added|modified existing/i);
});

test('manifest digest is order-stable and content-bound', () => {
  const a = {mission_id: 'M-010', repo: 'one/repo', pr_title: 'fix: one', bundle_digest: digest('1')};
  const b = {mission_id: 'M-011', repo: 'two/repo', pr_title: 'fix: two', bundle_digest: digest('2')};
  assert.equal(manifestDigest([a, b]), manifestDigest([b, a]));
  assert.notEqual(manifestDigest([a]), manifestDigest([{...a, pr_title: 'mutated'}]));
});

test('prepared-directory digest binds outer mission files as well as bundle files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-directory-digest-'));
  await writeFile(path.join(root, 'mission.json'), '{}\n');
  const before = await directoryDigest(root);
  await writeFile(path.join(root, 'mission.json'), '{"changed":true}\n');
  assert.notEqual(await directoryDigest(root), before);
});

test('patch bytes applied to the base index must reproduce the committed tree', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'northset-binding-test-'));
  await git(repo, 'init');
  await git(repo, 'config', 'user.name', OSS_IDENTITY.name);
  await git(repo, 'config', 'user.email', OSS_IDENTITY.email);
  await writeFile(path.join(repo, 'value.txt'), 'base\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'base');
  const base = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
  await writeFile(path.join(repo, 'value.txt'), 'patched\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-s', '-m', 'fix: value');
  const commit = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
  const patch = (await git(repo, 'diff', '--binary', '--full-index', `${base}..${commit}`)).stdout;
  const patchFile = path.join(repo, 'fix.patch');
  await writeFile(patchFile, patch);
  assert.match(await assertPatchCommitBinding(repo, base, commit, patchFile), /^[0-9a-f]{40,64}$/);
  await writeFile(patchFile, patch.replace('+patched', '+different'));
  await assert.rejects(() => assertPatchCommitBinding(repo, base, commit, patchFile), /mismatch/);
});

test('Git diff parsing preserves mode, binary detection, and changed-line totals', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'northset-diff-test-'));
  await git(repo, 'init');
  await git(repo, 'config', 'user.name', OSS_IDENTITY.name);
  await git(repo, 'config', 'user.email', OSS_IDENTITY.email);
  await writeFile(path.join(repo, 'value.txt'), 'base\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'base');
  const base = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
  await writeFile(path.join(repo, 'value.txt'), 'changed\n');
  await writeFile(path.join(repo, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'change');
  const commit = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
  const parsed = await changedEntries(repo, base, commit);
  assert.deepEqual(parsed.entries.map((entry) => entry.path), ['binary.dat', 'value.txt']);
  assert.equal(parsed.entries.find((entry) => entry.path === 'binary.dat').binary, true);
  assert.equal(parsed.entries.find((entry) => entry.path === 'value.txt').mode, '100644');
  assert.equal(parsed.lines, 2);
});

test('identity, binding chain, and direct mission footer are fail closed', () => {
  const body = `detail\n\nSigned-off-by: ${OSS_IDENTITY.name} <${OSS_IDENTITY.email}>`;
  assert.doesNotThrow(() => assertOssCommitIdentity({authorEmail: OSS_IDENTITY.email, committerEmail: OSS_IDENTITY.email, body}));
  assert.throws(() => assertOssCommitIdentity({authorEmail: 'wrong@example.com', committerEmail: OSS_IDENTITY.email, body}));
  const chain = {patch_sha256: digest('a'), tested_tree_oid: oid('b'), commit_oid: oid('c')};
  assert.equal(assertBindingChain({...chain, pushed_oid: oid('c'), pr_head_oid: oid('c')}), true);
  assert.throws(() => assertBindingChain({...chain, pushed_oid: oid('d')}), /binding mismatch/);
  const footer = receiptFooter('M-010', oid('c'));
  const canonicalReceipt = 'https://northset-oss.github.io/verification-pilot/receipts/M-010/';
  assert.equal(footer, [
    '---',
    'AI assistance was used; I reviewed and own this change.',
    '',
    '<!-- northset-receipt:M-010:start -->',
    '### Verification',
    '',
    `[Northset proof-of-pass receipt M-010](${canonicalReceipt})  `,
    'Contributor self-run; not maintainer verification.',
    '<!-- northset-receipt:M-010:end -->',
  ].join('\n'));
  assert.equal(footer.split(canonicalReceipt).length - 1, 1);
  assert.doesNotMatch(footer, /\/#M-010/);
  const bodyText = prBody(spec(), {changedFiles: ['src/index.mjs'], commitOid: oid('c')});
  assert.match(bodyText, /AI assistance was used/);
  assert.match(bodyText, /proof-of-pass receipt M-010/);
  const templated = prBody(spec({pr: {
    ...spec().pr,
    body_template: '## Changes\n\n{{SUMMARY}}\n\nCloses: #{{ISSUE_NUMBER}}\n\n{{CHECKS}}\n\n{{RECEIPT_FOOTER}}',
  }}), {changedFiles: ['src/index.mjs'], commitOid: oid('c')});
  assert.match(templated, /Closes: #123/);
  assert.match(templated, /npm test -- test\/parser\.test\.mjs/);
  assert.match(templated, /Contributor self-run/);
});

test('PR preparation rejects duplicate canonical or legacy receipt links before publication', () => {
  const canonical = 'https://northset-oss.github.io/verification-pilot/receipts/M-010/';
  assert.throws(() => prBody(spec({pr: {...spec().pr, summary: `Duplicate ${canonical}`}}), {
    changedFiles: ['src/index.mjs'], commitOid: oid('c'),
  }), /canonical receipt URL.*exactly once/i);
  assert.throws(() => prBody(spec({pr: {
    ...spec().pr, summary: 'Legacy https://northset-oss.github.io/verification-pilot/#M-010',
  }}), {changedFiles: ['src/index.mjs'], commitOid: oid('c')}), /legacy receipt URL/i);
  assert.throws(() => prBody(spec({pr: {
    ...spec().pr, summary: 'Legacy https://northset-oss.github.io/verification-pilot#M-010',
  }}), {changedFiles: ['src/index.mjs'], commitOid: oid('c')}), /legacy receipt URL/i);
  assert.throws(() => prBody(spec({pr: {
    ...spec().pr, summary: 'Extra ledger link https://northset-oss.github.io/verification-pilot/docs/',
  }}), {changedFiles: ['src/index.mjs'], commitOid: oid('c')}), /one Northset ledger link/i);
});

test('timeline pagination and cross-reference parsing include closed attempts with timestamps', () => {
  const args = timelineApiArgs('owner', 'repo', 123);
  assert.ok(args.includes('--paginate'));
  assert.ok(args.includes('--slurp'));
  assert.deepEqual(timelineCrossReferences([[{event: 'cross-referenced', created_at: '2026-01-01T00:00:00Z', source: {issue: {
    html_url: 'https://example/pr/1', state: 'closed', title: 'one', pull_request: {},
  }}}]]), [{source: 'https://example/pr/1', state: 'closed', title: 'one', is_pr: true, created_at: '2026-01-01T00:00:00Z'}]);
});

test('semantic PR matching is title-bounded and ignores unrelated dependency release-note bodies', () => {
  const value = spec({
    problem_statement: 'Quadlet image replacement metadata is missing for digest updates.',
  });
  const prs = [{
    state: 'MERGED',
    title: 'chore(deps): update dependency pnpm to v11.10.0 (main)',
    body: 'Long release notes mention image replacement metadata and digest updates.',
    url: 'https://github.com/owner/repo/pull/9',
  }];
  assert.deepEqual(possibleOverlappingPrs(prs, value), []);
});

test('live recheck fails closed on invitation drift, issue drift, overlap, and Northset repo cap', async () => {
  const value = spec();
  const state = {labels: ['help wanted'], updatedAt: value.qualification.issue_updated_at, comments: [], prs: [], timeline: [[]], designPresent: true, noticePresent: true};
  const gh = async (args) => {
    const joined = args.join(' ');
    if (joined.includes('/issues/comments/1')) return state.designPresent ? {
      html_url: value.qualification.acceptance_contract.design_evidence[0].url,
      author_association: 'MEMBER', created_at: '2026-07-13T10:00:00Z',
    } : {html_url: 'https://github.com/owner/repo/issues/123#issuecomment-2', author_association: 'NONE'};
    if (joined.includes('/comments?')) return [state.comments];
    if (joined.includes('/timeline?')) return state.timeline;
    if (joined.startsWith('pr list')) return state.prs;
    if (joined.includes('/git/ref/heads/')) return {object: {sha: value.base_commit}};
    if (joined.includes('/issues/123')) return {
      number: 123, state: 'open', title: 'Parser defect', html_url: value.issue_url,
      assignees: [], labels: state.labels, created_at: '2026-07-01T00:00:00Z',
      updated_at: state.updatedAt, body: 'body', author_association: 'OWNER', user: {login: 'maintainer'},
    };
    return {default_branch: 'main', archived: false, fork: false, html_url: value.target_repo};
  };
  const options = {gh, now: () => new Date('2026-07-13T12:00:00Z')};
  assert.equal((await recheck(value, async () => {}, options)).clean, true);
  const issueAuthSpec = structuredClone(value);
  issueAuthSpec.qualification.acceptance_contract.design_evidence = [{
    url: value.issue_url, author_association: 'OWNER', summary: 'Owner-authored issue contract.',
  }];
  assert.equal((await recheck(issueAuthSpec, async () => {}, options)).clean, true);
  state.designPresent = false;
  assert.match((await recheck(value, async () => {}, options)).reasons.join(' '), /maintainer design evidence/);
  state.designPresent = true;
  state.labels = [];
  assert.match((await recheck(value, async () => {}, options)).reasons.join(' '), /invitation/);
  state.labels = ['help wanted'];
  state.updatedAt = '2026-07-13T12:01:00Z';
  assert.equal((await recheck(value, async () => {}, options)).clean, true);
  state.comments = [{created_at: '2026-07-13T12:01:00Z', html_url: 'https://github.com/owner/repo/issues/123#issuecomment-2', user: {login: 'external', type: 'User'}}];
  assert.match((await recheck(value, async () => {}, options)).reasons.join(' '), /external comment/);
  state.comments = [];
  state.updatedAt = value.qualification.issue_updated_at;
  state.prs = [{state: 'OPEN', title: 'Parser bounded input fix', body: 'Fixes #123', url: 'https://github.com/owner/repo/pull/4', author: {login: 'someone'}}];
  assert.match((await recheck(value, async () => {}, options)).reasons.join(' '), /related PR/);
  state.prs = [{state: 'OPEN', title: 'Other', body: '', url: 'https://github.com/owner/repo/pull/5', author: {login: 'AysajanE'}}];
  assert.match((await recheck(value, async () => {}, options)).reasons.join(' '), /already has an open PR/);

  const noticeSpec = spec({
    process_requirements: ['Notify maintainers before work.'],
    qualification: {...spec().qualification, pre_author_notice_required: true,
      pre_author_notice: {url: 'https://github.com/owner/repo/issues/123#issuecomment-99', observed_at: '2026-07-13T12:00:00Z'}},
  });
  state.prs = [];
  const noticeGh = async (args) => args.join(' ').includes('/issues/comments/99')
    ? (state.noticePresent ? {html_url: noticeSpec.qualification.pre_author_notice.url, user: {login: 'AysajanE'}, created_at: '2026-07-13T11:55:00Z'} : {html_url: 'wrong', user: {login: 'other'}})
    : gh(args);
  assert.equal((await recheck(noticeSpec, async () => {}, {...options, gh: noticeGh})).clean, true);
  state.noticePresent = false;
  assert.match((await recheck(noticeSpec, async () => {}, {...options, gh: noticeGh})).reasons.join(' '), /pre-author notice/);
});
