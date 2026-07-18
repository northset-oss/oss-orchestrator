import assert from 'node:assert/strict';
import {access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  authorDockerArgs,
  attemptLineageForSpec,
  buildBatchBoard,
  buildWarmPlan,
  buildEconomicInput,
  assertOracleChangedPaths,
  canonicalCommitArgs,
  canonicalIssueUrlFromSnapshot,
  changedEntries,
  checkDockerArgs,
  classifyChangedFiles,
  cloneStandaloneRepository,
  copyDependencySnapshot,
  copyNodeDependencies,
  copyProfileDependencies,
  dependencyCacheKey,
  detectToolchainClass,
  dependencyBootstrapDockerArgs,
  AUTHOR_MODEL_ATTEMPT_MS,
  MAX_ELEVATED_EXISTING_TESTS,
  PREPARE_BUDGET_MS,
  prepareMission,
  parseOssArgs,
  githubProviderThrottleFailure,
  latchPrepareProviderThrottle,
  requireModelRunnerSuccess,
  remainingAuthorModelMs,
  removeRunWorkspace,
  runAuthorContainer,
  isNativeToolchainFailure,
  snapshotProfileDependencies,
  verifyTestOnlyAuthorResult,
  warmBatch,
  writeAttempt,
} from './oss.mjs';
import {GitHubGatewayRefusalError, GitHubThrottleError} from './gh-gateway.mjs';
import {
  OSS_IDENTITY,
  PROFILE_REGISTRY,
  assertBindingChain,
  assertOssCommitIdentity,
  assertPatchCommitBinding,
  directoryDigest,
  authorEffort,
  batchApprovalDigest,
  canonical,
  git,
  manifestDigest,
  LIVE_RECHECK_OUTPUT_LIMIT_BYTES,
  possibleOverlappingPrs,
  prBody,
  recheck,
  receiptFooter,
  timelineApiArgs,
  timelineCrossReferences,
  taskIdForCandidate,
  sha256,
  validateSpec,
  validateSpecs,
} from './core.mjs';

const oid = (char) => char.repeat(40);
const digest = (char) => `sha256:${char.repeat(64)}`;

function command(program, args, env) {
  return new Promise((resolve) => {
    const child = spawn(program, args, {env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({code, stdout, stderr}));
  });
}

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
      source_evidence: ['src/parser.mjs:7 — return boundedValue;'],
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
  assert.equal(MAX_ELEVATED_EXISTING_TESTS, 2);
  assert.equal(parseOssArgs(['prepare', 'M-010']).concurrency, 3);
  assert.throws(() => parseOssArgs(['prepare', '--concurrency', '13', 'M-010']), /1 to 12/);
  assert.throws(() => parseOssArgs(['ship-batch', '--batch', '/tmp/board.json', '--approve', digest('a')]), /approval-record/i);
  assert.equal(parseOssArgs(['ship-batch', '--batch', '/tmp/board.json', '--approve', digest('a'),
    '--approval-record', '/tmp/approval.json']).approvalRecord, '/tmp/approval.json');
  assert.throws(() => parseOssArgs(['ship-batch', '--batch', '/tmp/board.json', '--approve', digest('a'),
    '--approval-record', '/tmp/approval.json', '--reviewer-roster', '/tmp/forged.json']), /unknown argument/i);
});

test('prepare records a gateway throttle as terminal PROVIDER_THROTTLED and never retries it', async (t) => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'northset-prepare-github-throttle-'));
  t.after(() => rm(runsDir, {recursive: true, force: true}));
  const value = spec({
    schema_version: 2,
    task_id: taskIdForCandidate('owner/repo#123'),
    attempt_sequence: 1,
    work_category: 'defect_fix',
  });
  const throttle = new GitHubThrottleError('GitHub secondary rate limit', {
    signal: 'GITHUB_SECONDARY_RATE_LIMIT',
  });
  assert.deepEqual(githubProviderThrottleFailure(throttle), {
    failure_reason_code: 'PROVIDER_THROTTLED',
    terminal_reason_class: 'PROVIDER_THROTTLED',
    retryable: false,
    error_code: 'GITHUB_PROVIDER_THROTTLED',
    signal: 'GITHUB_SECONDARY_RATE_LIMIT',
  });
  let rechecks = 0;
  const options = {
    runsDir,
    gatewayOptions: {stateDir: path.join(runsDir, 'gateway-state')},
    prepareAdapter: {
      recheck: async () => {
        rechecks += 1;
        throw throttle;
      },
    },
  };
  const result = await prepareMission(value, options);
  assert.equal(result.state, 'FAILED_INFRA_TERMINAL');
  assert.equal(result.failure_reason_code, 'PROVIDER_THROTTLED');
  assert.equal(result.terminal_reason_class, 'PROVIDER_THROTTLED');
  assert.equal(result.retryable, false);
  assert.equal(result.error_code, 'GITHUB_PROVIDER_THROTTLED');
  assert.equal(result.signal, 'GITHUB_SECONDARY_RATE_LIMIT');

  const record = JSON.parse(await readFile(path.join(runsDir, value.mission_id, 'attempt.json'), 'utf8'));
  assert.equal(record.state, 'FAILED_INFRA_TERMINAL');
  assert.equal(record.failure_reason_code, 'PROVIDER_THROTTLED');
  assert.equal(record.terminal_reason_class, 'PROVIDER_THROTTLED');
  assert.equal(record.retryable, false);
  assert.equal(record.error_code, 'GITHUB_PROVIDER_THROTTLED');
  assert.equal(record.signal, 'GITHUB_SECONDARY_RATE_LIMIT');
  const resourceControl = JSON.parse(await readFile(path.join(runsDir, 'phase0', 'resource-control.json'), 'utf8'));
  assert.equal(resourceControl.provider_pause.provider, 'GitHub');
  assert.equal(resourceControl.provider_pause.signal, 'GITHUB_SECONDARY_RATE_LIMIT');
  await assert.rejects(() => readFile(path.join(runsDir, 'gh-gateway-state', 'state.json')), {code: 'ENOENT'});

  const replay = await prepareMission(value, options);
  assert.equal(replay.state, 'FAILED_INFRA_TERMINAL');
  assert.equal(replay.failure_reason_code, 'PROVIDER_THROTTLED');
  assert.equal(replay.retryable, false);
  assert.equal(rechecks, 1);
  const lineage = await attemptLineageForSpec(runsDir, {
    ...value,
    mission_id: 'M-011',
    attempt_sequence: 2,
  });
  assert.equal(lineage[0].terminal_reason_class, 'PROVIDER_THROTTLED');
});

test('non-throttle gateway refusals are never promoted to provider-throttle failures', () => {
  const refusal = new GitHubGatewayRefusalError('daily budget is exhausted', {
    reason: 'daily-budget-exhausted',
  });
  assert.equal(githubProviderThrottleFailure(refusal), null);
});

test('prepare does not classify quoted issue-body throttling language outside the GitHub gateway', async (t) => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'northset-prepare-false-throttle-'));
  t.after(() => rm(runsDir, {recursive: true, force: true}));
  const value = spec({
    mission_id: 'M-011',
    schema_version: 2,
    task_id: taskIdForCandidate('owner/repo#123'),
    attempt_sequence: 1,
    work_category: 'defect_fix',
  });
  const result = await prepareMission(value, {
    runsDir,
    gatewayOptions: {stateDir: path.join(runsDir, 'gateway-state')},
    prepareAdapter: {
      recheck: async () => {
        throw new Error('issue body says: we should throttle the worker pool and honor retry-after');
      },
    },
  });
  assert.equal(result.state, 'FAILED_INFRA_TERMINAL');
  assert.equal(result.failure_reason_code, undefined);
  await assert.rejects(() => readFile(path.join(runsDir, 'phase0', 'resource-control.json')), {code: 'ENOENT'});
});

test('trusted author model-runner structured 429 latches OpenAI while untagged quoted author text does not', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-author-model-throttle-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const resourceControlFile = path.join(root, 'phase0', 'resource-control.json');
  let modelError;
  try {
    await requireModelRunnerSuccess('author container', {
      code: 1,
      stdout: JSON.stringify({type: 'turn.failed', error: {
        message: 'HTTP 429 Too Many Requests',
        codexErrorInfo: {responseTooManyFailedAttempts: {httpStatusCode: 429}},
      }}),
      stderr: 'candidate says secondary rate limit and Retry-After',
    });
  } catch (error) {
    modelError = error;
  }
  const latched = await latchPrepareProviderThrottle(modelError, {
    activeStage: 'author',
    resourceControlFile,
    gatewayOptions: {stateDir: path.join(root, 'gateway-state')},
  });
  assert.equal(latched.modelProviderThrottle, true);
  const pause = JSON.parse(await readFile(resourceControlFile, 'utf8')).provider_pause;
  assert.equal(pause.provider, 'OpenAI');
  assert.equal(pause.signal, 'OPENAI_MODEL_RATE_LIMIT');
  assert.equal(pause.auto_resume, false);

  const quotedRoot = await mkdtemp(path.join(os.tmpdir(), 'northset-author-quoted-throttle-'));
  t.after(() => rm(quotedRoot, {recursive: true, force: true}));
  const quotedControl = path.join(quotedRoot, 'phase0', 'resource-control.json');
  let quotedError;
  try {
    await requireModelRunnerSuccess('author container', {
      code: 1,
      stdout: 'HTTP 429 Too Many Requests',
      stderr: 'candidate says secondary rate limit and Retry-After',
    });
  } catch (error) {
    quotedError = error;
  }
  const quoted = await latchPrepareProviderThrottle(quotedError, {
    activeStage: 'author',
    resourceControlFile: quotedControl,
    gatewayOptions: {stateDir: path.join(quotedRoot, 'gateway-state')},
  });
  assert.equal(quoted.modelProviderThrottle, false);
  await assert.rejects(() => readFile(quotedControl), {code: 'ENOENT'});
});

test('prepare and ship command paths enforce activated Phase-1 schedule and incident holds', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-phase1-oss-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const specs = path.join(root, 'specs');
  const runs = path.join(root, 'runs');
  const runtimeFile = path.join(root, 'runtime.json');
  const controlsFile = path.join(root, 'controls.json');
  await mkdir(specs);
  await writeFile(path.join(specs, 'M-010.json'), JSON.stringify(spec()));
  const monotonicNow = () => Number(process.hrtime.bigint() / 1_000_000n);
  const runtime = (overrides = {}) => ({
    schema_version: 1,
    active: true,
    controls_state_file: controlsFile,
    lanes: 8,
    p75_attempt_start_interval_ms: 15 * 60 * 1000,
    max_ntp_offset_ms: 1000,
    ntp: {offset_ms: 0, observed_at: new Date().toISOString()},
    board_monotonic_ms: monotonicNow() + 60 * 60 * 1000,
    qualification: {predicted_prepare_start_monotonic_ms: monotonicNow() + 30 * 60 * 1000, qualified_ahead: 0},
    ...overrides,
  });
  const controls = (incidents = []) => ({schema_version: 1, incidents, closures: [], hold_clearances: []});
  const gatewayRoot = path.join(root, 'gateway');
  const gatewayEnvironment = {
    ...process.env,
    OSS_GH_GATEWAY_TEST_MODE: '1',
    OSS_GH_GATEWAY_TEST_LOCK_POLL_MS: '1',
    OSS_GH_CANONICAL_ROOT: gatewayRoot,
    OSS_GH_GATEWAY_STATE_DIR: path.join(gatewayRoot, 'state'),
    OSS_GH_REQUEST_LEDGER: path.join(gatewayRoot, 'ledger.jsonl'),
    OSS_RESOURCE_CONTROL_FILE: path.join(gatewayRoot, 'resource-control.json'),
    OSS_CAMPAIGN_CONTROL_STATE: path.join(gatewayRoot, 'control-state.json'),
  };
  const invoke = (commandArgs) => command(process.execPath,
    [path.join(import.meta.dirname, 'oss.mjs'), ...commandArgs], gatewayEnvironment);

  await writeFile(controlsFile, JSON.stringify(controls()));
  await writeFile(runtimeFile, JSON.stringify(runtime({board_monotonic_ms: monotonicNow() + 7 * 60 * 60 * 1000})));
  let result = await invoke(['prepare', 'M-010', '--specs', specs, '--runs', runs, '--phase1-runtime', runtimeFile, '--no-push']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Phase-1 runtime blocked prepare: OUTSIDE_BOARD_WINDOW/);

  await writeFile(runtimeFile, JSON.stringify(runtime({ntp: {offset_ms: 1001, observed_at: new Date().toISOString()}})));
  result = await invoke(['prepare', 'M-010', '--specs', specs, '--runs', runs, '--phase1-runtime', runtimeFile, '--no-push']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Phase-1 runtime blocked prepare: NTP_HOLD/);

  await writeFile(controlsFile, JSON.stringify(controls([{
    incident_id: 'repo-stop', severity: 'SEV_1', scope: 'repository', repository: 'owner/repo',
    event_class: 'stop_request', occurred_at: new Date().toISOString(),
  }])));
  await writeFile(runtimeFile, JSON.stringify(runtime()));
  result = await invoke(['prepare', 'M-010', '--specs', specs, '--runs', runs, '--phase1-runtime', runtimeFile, '--no-push']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Phase-1 runtime blocked prepare: REPOSITORY_HOLD owner\/repo/);

  await writeFile(controlsFile, JSON.stringify(controls([{
    incident_id: 'platform-stop', severity: 'SEV_1', scope: 'platform', repository: null,
    event_class: 'platform_warning', occurred_at: new Date().toISOString(),
  }])));
  result = await invoke(['ship', 'M-010', '--specs', specs, '--runs', runs, '--phase1-runtime', runtimeFile,
    '--approve', digest('a'), '--approval-record', path.join(root, 'missing-approval.json'), '--no-push']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Phase-1 runtime blocked ship: GLOBAL_PUBLICATION_HOLD/);
});

test('warm planning deduplicates executor images and retains immutable digests without deleting data', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'warm-planning-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const one = spec();
  const qualification = structuredClone(one.qualification);
  qualification.invitation_evidence.url = 'https://github.com/other/repo/issues/2';
  qualification.acceptance_contract.design_evidence[0].url = 'https://github.com/other/repo/issues/2#issuecomment-1';
  const two = spec({mission_id: 'M-011', candidate: 'other/repo#2', target_repo: 'https://github.com/other/repo',
    issue_url: 'https://github.com/other/repo/issues/2', qualification});
  const plan = buildWarmPlan([one, two]);
  assert.equal(plan.images.length, 1);
  assert.equal(plan.repositories.length, 2);
  const calls = [];
  const imageDigest = `node@${digest('a')}`;
  const runImpl = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'pull' || args[0] === 'run') return {code: 0, stdout: '', stderr: ''};
    if (args[0] === 'image' && args[1] === 'inspect') return {code: 0, stdout: `${JSON.stringify([imageDigest])}\n`, stderr: ''};
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  };
  const warmed = await warmBatch([one, two], {
    runImpl,
    mirrorRoot: path.join(root, 'mirrors'),
    mirrorInitializer: async (value) => `/mirrors/${value.mission_id}.git`,
    statfsImpl: async () => ({bavail: 100, bsize: 100}),
    minimumFreeBytes: 1,
  });
  assert.equal(calls.filter((call) => call[1] === 'pull').length, 1);
  assert.equal(calls.filter((call) => call[1] === 'run').length, 1);
  assert.equal(warmed.images[0].digest, imageDigest);
  assert.equal(warmed.disk.data_deleted, false);
});

test('writable dependency caches are isolated while schema-v2 retries reuse the same task cache', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dependency-cache-key-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const first = spec();
  const same = structuredClone(first);
  const otherMission = spec({mission_id: 'M-011', candidate: 'other/repo#7',
    target_repo: 'https://github.com/other/repo', issue_url: 'https://github.com/other/repo/issues/7'});
  const otherBase = spec({base_commit: oid('b')});
  const image = 'node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(await dependencyCacheKey(first, root, image), await dependencyCacheKey(same, root, image));
  assert.notEqual(await dependencyCacheKey(first, root, image), await dependencyCacheKey(otherMission, root, image));
  assert.notEqual(await dependencyCacheKey(first, root, image), await dependencyCacheKey(otherBase, root, image));
  const firstAttempt = {...first, schema_version: 2, task_id: 'TASK-OSS-0123456789ABCDEF',
    attempt_sequence: 1, work_category: 'defect_fix'};
  const retryAttempt = {...firstAttempt, mission_id: 'M-011', attempt_sequence: 2};
  assert.equal(await dependencyCacheKey(firstAttempt, root, image),
    await dependencyCacheKey(retryAttempt, root, image));

  const identity = {architecture: 'arm64', repositoryNodeId: 'R_kgDOExample', trustDomain: 'authored'};
  const authored = await dependencyCacheKey(first, root, image, identity);
  assert.notEqual(authored, await dependencyCacheKey(first, root, image, {...identity, architecture: 'amd64'}));
  assert.notEqual(authored, await dependencyCacheKey(first, root, image, {...identity, repositoryNodeId: 'R_kgDOOther'}));
  assert.notEqual(authored, await dependencyCacheKey(first, root, image, {...identity, trustDomain: 'foreign'}));
});

test('Phase-1 toolchain classes are registered and repository-controlled apt installs are rejected', () => {
  assert.equal(PROFILE_REGISTRY.profiles.go.image, 'golang:1.26.4-bookworm');
  assert.deepEqual(Object.keys(PROFILE_REGISTRY.toolchain_classes).sort(), [
    'node-native', 'node-pure', 'python-native', 'python-pure',
  ]);
  assert.throws(() => validateSpec(spec({
    executor: {...spec().executor, install_commands: ['apt-get install -y build-essential', 'npm ci']},
  })), /apt.*forbidden/i);
  assert.doesNotThrow(() => validateSpec(spec({
    executor: {...spec().executor, toolchain_class: 'node-pure'},
    workspace_mode: 'writable_copy', workspace_write_allowlist: ['coverage'],
  })));
  assert.throws(() => validateSpec(spec({workspace_mode: 'writable_copy', workspace_write_allowlist: ['../escape']})), /allowlist/i);
});

test('toolchain classification detects native Node and Python metadata deterministically', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'toolchain-classification-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({scripts: {install: 'node-gyp rebuild'}}));
  assert.deepEqual(await detectToolchainClass('node', root), {
    toolchain_class: 'node-native', signals: ['node-install-script'],
  });
  await rm(path.join(root, 'package.json'));
  await writeFile(path.join(root, 'pyproject.toml'), '[build-system]\nrequires = ["maturin"]\n');
  assert.deepEqual(await detectToolchainClass('python', root), {
    toolchain_class: 'python-native', signals: ['python-extension-metadata'],
  });
  assert.equal(isNativeToolchainFailure({stdout: '', stderr: 'gyp ERR! build error'}), true);
  assert.equal(isNativeToolchainFailure({stdout: '', stderr: 'npm ERR! ordinary test failure'}), false);
});

test('every durable attempt record carries complete Phase-1 measurement-class attribution', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'phase1-attribution-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const value = spec();
  await writeAttempt({base: root}, value, 'FAILED_AUTHOR', 'bounded failure', [
    {stage: 'author', duration_ms: 1250},
  ], new Date(Date.now() - 5000));
  const record = JSON.parse(await readFile(path.join(root, 'attempt.json'), 'utf8'));
  assert.equal(record.profile, value.executor.profile);
  assert.equal(record.workspace_mode, 'readonly');
  assert.ok(record.prepare_duration_ms >= 5000);
  assert.equal(record.attribution_complete, true);
  assert.equal(record.attribution.components.model.measurement_class, 'observed_usage');
  assert.equal(record.attribution.components.compute.measurement_class, 'observed_usage');
  assert.equal(record.attribution.components.subscription.measurement_class, 'unavailable');
  assert.equal(record.attribution.components.operator_labor.measurement_class, 'unavailable');
});

test('profile cache copying excludes host virtual environments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'profile-cache-copy-'));
  const fromWorkspace = path.join(root, 'from');
  const toWorkspace = path.join(root, 'to');
  const from = path.join(fromWorkspace, 'repo');
  const to = path.join(toWorkspace, 'repo');
  await mkdir(path.join(from, '.venv'), {recursive: true});
  await mkdir(path.join(from, '__pypackages__'), {recursive: true});
  await mkdir(path.join(fromWorkspace, '.northset', 'bootstrap-home', '.cache', 'pip'), {recursive: true});
  await writeFile(path.join(from, '.venv', 'python'), 'host-specific');
  await writeFile(path.join(from, '__pypackages__', 'portable.whl'), 'wheel');
  await writeFile(path.join(fromWorkspace, '.northset', 'bootstrap-home', '.cache', 'pip', 'download.whl'), 'wheel');
  await copyProfileDependencies('python', from, to);
  await access(path.join(to, '__pypackages__', 'portable.whl'));
  await access(path.join(toWorkspace, '.northset', 'bootstrap-home', '.cache', 'pip', 'download.whl'));
  await assert.rejects(() => access(path.join(to, '.venv', 'python')), /ENOENT/);

  const pythonSpec = spec({
    executor: {
      ...spec().executor,
      profile: 'python',
      image: 'python:3.14.5-bookworm',
      install_commands: ['python -m pip install -e .'],
      commands: ['python -m pytest test_parser.py -q'],
    },
  });
  const bootstrap = dependencyBootstrapDockerArgs(pythonSpec, '/runs/M-010/author-workspace',
    pythonSpec.executor.image, '/cache/python');
  assert.ok(bootstrap.includes('PIP_TARGET=/workspace/.northset/bootstrap-home/python-site'));
  assert.ok(bootstrap.includes('PATH=/workspace/.northset/bootstrap-home/python-site/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'));
  assert.match(bootstrap.at(-1), /python-site/);
  const check = checkDockerArgs(pythonSpec, '/runs/M-010/oracle', 'python@' + digest('a'),
    pythonSpec.executor.commands[0]);
  assert.ok(check.includes('PYTHONPATH=/workspace/.northset/bootstrap-home/python-site'));
  assert.ok(check.includes('PATH=/workspace/.northset/bootstrap-home/python-site/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'));
  const author = authorDockerArgs(pythonSpec, '/runs/M-010/author-workspace', 'northset-author@' + digest('b'),
    '/runs/M-010/codex-home');
  assert.ok(author.includes('PYTHONPATH=/workspace/.northset/bootstrap-home/python-site'));
  assert.ok(author.includes('PATH=/workspace/.northset/bootstrap-home/python-site/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'));
});

test('Go dependency cache export is writable and idempotent across a bootstrap retry', () => {
  const goSpec = spec({
    executor: {
      ...spec().executor,
      profile: 'go',
      image: 'golang:1.26.4-bookworm',
      install_commands: ['go mod download'],
      commands: ['go test ./minio -run TestFocused'],
    },
  });
  const bootstrap = dependencyBootstrapDockerArgs(goSpec, '/runs/M-010/author-workspace',
    goSpec.executor.image, '/cache/go');
  const command = bootstrap.at(-1);
  assert.match(command, /chmod -R u\+w \/workspace\/\.northset\/bootstrap-home\/go\/pkg\/mod/);
  assert.match(command, /rm -rf \/workspace\/\.northset\/bootstrap-home\/go\/pkg\/mod/);
  assert.match(command, /tar -C \/northset-cache\/go-mod -cf - \. \| tar -C \/workspace\/\.northset\/bootstrap-home\/go\/pkg\/mod --no-same-owner --no-same-permissions -xf -/);
  assert.match(command, /chmod -R u\+rwX \/workspace\/\.northset\/bootstrap-home\/go\/pkg\/mod/);
});

test('base-red dependency bytes come from a hash-verified pre-author snapshot', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-preauthor-dependencies-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const authorRepo = path.join(root, 'author', 'repo');
  const dependency = path.join(authorRepo, 'node_modules', 'parser', 'index.js');
  await mkdir(path.dirname(dependency), {recursive: true});
  await writeFile(dependency, 'trusted pre-author bytes\n');
  const snapshot = await snapshotProfileDependencies('node', authorRepo, path.join(root, 'snapshot'));

  await writeFile(dependency, 'credentialed author poison\n');
  const redRepo = path.join(root, 'red', 'repo');
  await mkdir(redRepo, {recursive: true});
  await copyDependencySnapshot('node', snapshot, redRepo);
  assert.equal(await readFile(path.join(redRepo, 'node_modules', 'parser', 'index.js'), 'utf8'),
    'trusted pre-author bytes\n');

  await writeFile(path.join(snapshot.repo, 'node_modules', 'parser', 'index.js'), 'tampered snapshot\n');
  await assert.rejects(() => copyDependencySnapshot('node', snapshot, path.join(root, 'second', 'repo')),
    /dependency snapshot.*changed/i);

  await symlink(dependency, path.join(authorRepo, 'node_modules', 'external-link'));
  await assert.rejects(() => snapshotProfileDependencies('node', authorRepo, path.join(root, 'unsafe-snapshot')),
    /dependency snapshot contains an external symlink/i);
});

test('test_only_then_fix stops before the fix phase when base-red proof is absent', async () => {
  const value = spec({authoring_mode: 'test_only_then_fix'});
  const workspace = '/runs/M-010/author-workspace';
  const runImpl = async (command, args) => {
    if (command === 'git' && args.includes('rev-parse')) return {code: 0, stdout: `${value.base_commit}\n`, stderr: ''};
    if (command === 'git' && args.includes('status')) return {code: 0, stdout: '?? test/parser.test.mjs\n', stderr: ''};
    if (command === 'docker') return {code: 1, stdout: 'ordinary failure without marker', stderr: ''};
    throw new Error(`unexpected ${command}`);
  };
  await assert.rejects(() => verifyTestOnlyAuthorResult(value, workspace, value.executor.image, {runImpl}), /FAILED_ORACLE_DESIGN/);
});

test('batch board and approval digest bind mission order, patch, PR body and risks', () => {
  const manifest = (id, character) => ({
    mission_id: id, repo: `${character}/repo`, issue_url: `https://github.com/${character}/repo/issues/1`,
    pr_title: `fix: ${character}`, patch_sha256: digest(character), pr_body_sha256: digest(character),
    pr_claim_text: `Fix bounded ${character} behavior. Contributor self-run.`,
    patch_review_sha256: digest(character), risk_flags: [], changed_file_classes: [{path: 'src/x', class: 'source'}],
    oracle_sha256: digest(character), bundle_digest: digest(character),
  });
  const a = manifest('M-100', 'a');
  const b = manifest('M-101', 'b');
  assert.notEqual(batchApprovalDigest([a, b]), batchApprovalDigest([b, a]));
  assert.notEqual(batchApprovalDigest([a]), batchApprovalDigest([{...a, pr_body_sha256: digest('c')}]))
  const results = [a, b].map((value) => ({state: 'READY', manifest: value,
    spec: spec({mission_id: value.mission_id}), classes: value.changed_file_classes}));
  const board = buildBatchBoard(results);
  assert.equal(board.machine.batch_digest, batchApprovalDigest([a, b]));
  assert.deepEqual(board.machine.ordered_mission_ids, ['M-100', 'M-101']);
  assert.match(board.markdown, /Fix bounded a behavior\. Contributor self-run\./);
  assert.match(board.markdown, /Approval binds the ordered manifest bytes/);
});

test('canonical verifier base clone remains standalone after shared mirror removal', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-standalone-base-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source');
  const mirror = path.join(root, 'mirror.git');
  const author = path.join(root, 'author');
  const standalone = path.join(root, 'standalone');
  await mkdir(source);
  await git(source, 'init');
  await git(source, 'config', 'user.name', OSS_IDENTITY.name);
  await git(source, 'config', 'user.email', OSS_IDENTITY.email);
  await writeFile(path.join(source, 'value.txt'), 'base\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'base');
  const base = (await git(source, 'rev-parse', 'HEAD')).stdout.trim();
  await git(root, 'clone', '--mirror', source, mirror);
  await git(root, 'clone', '--shared', mirror, author);
  await cloneStandaloneRepository(author, standalone, base);
  await rm(mirror, {recursive: true, force: true});
  await rm(author, {recursive: true, force: true});
  await assert.rejects(() => access(path.join(standalone, '.git', 'objects', 'info', 'alternates')), /ENOENT/);
  const topLevel = (await git(standalone, 'rev-parse', '--show-toplevel')).stdout.trim();
  assert.equal(await realpath(topLevel), await realpath(standalone));
  assert.equal((await git(standalone, 'rev-parse', 'HEAD^{commit}')).stdout.trim(), base);
  const indexed = await git(standalone, 'ls-files', '-v', '-z');
  assert.equal(indexed.code, 0);
  assert.ok(indexed.stdout.split('\0').filter(Boolean)
    .every((record) => record[1] === ' ' && record[0] === record[0].toUpperCase()));
  const sourceStatus = await git(standalone, 'status', '--porcelain', '--untracked-files=all', '--ignored=matching');
  assert.equal(sourceStatus.code, 0);
  assert.equal(sourceStatus.stdout.trim(), '');
  assert.equal((await git(standalone, 'cat-file', '-e', `${base}^{commit}`)).code, 0);
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
  const vitestScratchOracle = 'ln -s "$PWD/node_modules" /tmp/node_modules && cp vitest.config.ts /tmp/vitest.config.ts && npm test -- --config /tmp/vitest.config.ts --root "$PWD" --no-cache test/parser.test.mjs';
  assert.doesNotThrow(() => validateSpecs([spec({
    oracle: {...spec().oracle, command: vitestScratchOracle},
    executor: {...spec().executor, commands: [vitestScratchOracle]},
  })]));
  const uiOracle = 'pnpm --dir ui exec vitest run src/parser.test.ts';
  assert.doesNotThrow(() => validateSpecs([spec({
    oracle: {...spec().oracle, test_paths: ['ui/src/parser.test.ts'], command: uiOracle},
    executor: {...spec().executor, commands: [uiOracle]},
  })]));
  const npmPrefixOracle = 'npm --prefix packages/parser test -- test/postlude-regression.test.ts';
  assert.doesNotThrow(() => validateSpecs([spec({
    oracle: {...spec().oracle, test_paths: ['packages/parser/test/postlude-regression.test.ts'], command: npmPrefixOracle},
    executor: {...spec().executor, commands: [npmPrefixOracle]},
  })]));
  const goPackageOracle = "env -u SECOND_MINIO_ENDPOINT TF_ACC=1 go test ./minio -run '^TestReplicationGuard$' -count=1";
  assert.doesNotThrow(() => validateSpecs([spec({
    oracle: {...spec().oracle, test_paths: ['minio/resource_replication_test.go'], command: goPackageOracle},
    executor: {...spec().executor, commands: [goPackageOracle]},
  })]));
  const goMakePackageOracle = "make test-single PKG=./protocol TEST='^TestMessengerReplySuite$' TESTIFY_M='^TestInvalidResponseTo$'";
  assert.doesNotThrow(() => validateSpecs([spec({
    oracle: {...spec().oracle, test_paths: ['protocol/messenger_reply_test.go'], command: goMakePackageOracle},
    executor: {...spec().executor, commands: [goMakePackageOracle]},
  })]));
  const broadGoOracle = 'go test ./...';
  assert.throws(() => validateSpecs([spec({
    oracle: {...spec().oracle, test_paths: ['protocol/messenger_reply_test.go'], command: broadGoOracle},
    executor: {...spec().executor, commands: [broadGoOracle]},
  })]), /oracle\.command.*test_paths/i);
  const conflictingDirectoryOracle = 'npm --prefix packages/other test -- --dir packages/parser test/regression.test.ts';
  assert.throws(() => validateSpecs([spec({
    oracle: {...spec().oracle, test_paths: ['packages/parser/test/regression.test.ts'], command: conflictingDirectoryOracle},
    executor: {...spec().executor, commands: [conflictingDirectoryOracle]},
  })]), /single directory control|oracle\.command.*test_paths/i);
  const aliasedDirectoryOracle = 'npm --prefix packages/parser -C packages/other test -- test/regression.test.ts';
  assert.throws(() => validateSpecs([spec({
    oracle: {...spec().oracle, test_paths: ['packages/parser/test/regression.test.ts'], command: aliasedDirectoryOracle},
    executor: {...spec().executor, commands: [aliasedDirectoryOracle]},
  })]), /directory control|oracle\.command.*test_paths/i);
  const equalsDirectoryOracle = 'npm --prefix=packages/other --prefix packages/parser test -- test/regression.test.ts';
  assert.throws(() => validateSpecs([spec({
    oracle: {...spec().oracle, test_paths: ['packages/parser/test/regression.test.ts'], command: equalsDirectoryOracle},
    executor: {...spec().executor, commands: [equalsDirectoryOracle]},
  })]), /directory control|oracle\.command.*test_paths/i);
  const corpusOracle = 'npx tree-sitter test --file-name conditional-access-precedence.txt';
  assert.doesNotThrow(() => validateSpecs([spec({
    oracle: {...spec().oracle, test_paths: ['test/corpus/conditional-access-precedence.txt'], command: corpusOracle},
    executor: {...spec().executor, commands: [corpusOracle]},
  })]));
  assert.throws(() => validateSpecs([spec({
    oracle: {...spec().oracle, test_paths: ['other/tests/conditional-access-precedence.txt'], command: corpusOracle},
    executor: {...spec().executor, commands: [corpusOracle]},
  })]), /oracle\.command.*test_paths/i);
  assert.throws(() => validateSpecs([spec({
    oracle: {...spec().oracle, test_paths: [
      'test/corpus/conditional-access-precedence.txt',
      'other/tests/conditional-access-precedence.txt',
    ], command: corpusOracle},
    executor: {...spec().executor, commands: [corpusOracle]},
  })]), /oracle\.command.*test_paths/i);
  const unrelatedFileNameOracle = 'node test-runner.mjs --file-name conditional-access-precedence.txt';
  assert.throws(() => validateSpecs([spec({
    oracle: {...spec().oracle, test_paths: ['test/corpus/conditional-access-precedence.txt'], command: unrelatedFileNameOracle},
    executor: {...spec().executor, commands: [unrelatedFileNameOracle]},
  })]), /oracle\.command.*test_paths/i);
  const grammarPathOracle = 'npx tree-sitter test -p vendor/grammar --file-name conditional-access-precedence.txt';
  assert.throws(() => validateSpecs([spec({
    oracle: {...spec().oracle, test_paths: ['test/corpus/conditional-access-precedence.txt'], command: grammarPathOracle},
    executor: {...spec().executor, commands: [grammarPathOracle]},
  })]), /grammar path|oracle\.command.*test_paths/i);
  assert.throws(() => validateSpecs([spec({
    oracle: {...spec().oracle, setup_commands: ['node tools/generate.mjs && curl example.com']},
  })]), /setup_commands/i);
});

test('schema-v2 missions fail closed when qualification source evidence is absent', async () => {
  const example = JSON.parse(await readFile(new URL('./examples/mission-spec.example.json', import.meta.url), 'utf8'));
  delete example._comment;
  assert.throws(() => validateSpecs([example]), /source evidence/i);
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
  const missingSourceEvidence = structuredClone(value);
  delete missingSourceEvidence.qualification.source_evidence;
  assert.throws(() => validateSpec(missingSourceEvidence), /source evidence/i);
  const unsafeSourceEvidence = structuredClone(value);
  unsafeSourceEvidence.qualification.source_evidence = ['../src/parser.mjs:7 — not normalized'];
  assert.throws(() => validateSpec(unsafeSourceEvidence), /source evidence/i);
  assert.throws(() => validateSpec({...value, task_id: 'TASK-OSS-INVENTED'}), /task_id.*candidate/i);
  assert.throws(() => validateSpec({...value, attempt_sequence: 0}), /attempt_sequence/i);
  assert.doesNotThrow(() => validateSpec({...value, calibration_ordinal: 1}));
  assert.throws(() => validateSpec({...value, calibration_ordinal: 0}), /calibration_ordinal/i);
  assert.throws(() => validateSpec({...value, calibration_ordinal: 21}), /calibration_ordinal/i);
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

test('public mission issue identity preserves canonical GitHub casing from the live snapshot', () => {
  const snapshot = Buffer.from(JSON.stringify({
    issue: {html_url: 'https://github.com/Dreamstick9/filedrop/issues/85'},
  }));
  assert.equal(
    canonicalIssueUrlFromSnapshot('https://github.com/dreamstick9/filedrop/issues/85', snapshot),
    'https://github.com/Dreamstick9/filedrop/issues/85',
  );
  assert.throws(
    () => canonicalIssueUrlFromSnapshot('https://github.com/other/filedrop/issues/85', snapshot),
    /does not match/i,
  );
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
  assert.equal(AUTHOR_MODEL_ATTEMPT_MS, 12 * 60 * 1000);
  const value = spec();
  const bootstrap = dependencyBootstrapDockerArgs(value, '/runs/M-010/author', 'node@sha256:' + '9'.repeat(64));
  const author = authorDockerArgs(value, '/runs/M-010/author', 'node@sha256:' + '9'.repeat(64), '/secret/codex');
  assert.equal(bootstrap.some((part) => String(part).includes('/secret/codex')), false);
  assert.equal(bootstrap.includes('CODEX_HOME=/codex-home'), false);
  assert.ok(author.some((part) => String(part).includes('src=/secret/codex,dst=/codex-home')));
  assert.match(author.at(-1), /codex exec --json/);
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

test('test-only and fix-only phases share one twelve-minute model budget', () => {
  assert.equal(remainingAuthorModelMs(0), AUTHOR_MODEL_ATTEMPT_MS);
  assert.equal(remainingAuthorModelMs(4 * 60 * 1000), 8 * 60 * 1000);
  assert.equal(remainingAuthorModelMs(AUTHOR_MODEL_ATTEMPT_MS), 0);
  assert.equal(remainingAuthorModelMs(AUTHOR_MODEL_ATTEMPT_MS + 1), 0);
  assert.throws(() => remainingAuthorModelMs(-1), /elapsed model time/i);
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
  let authorTimeoutMs = null;
  const runImpl = async (command, args, options = {}) => {
    assert.equal(command, 'docker');
    if (args.includes('northset-m-010-dependency-bootstrap') && args[0] === 'run') {
      bootstrapRuns += 1;
      if (bootstrapRuns === 1) return {code: 125, stdout: '', stderr: 'temporary Docker daemon failure', durationMs: 11};
      return {code: 0, stdout: '', stderr: '', durationMs: 13};
    }
    if (args.includes('northset-m-010-author') && args[0] === 'run') authorTimeoutMs = options.timeoutMs;
    return {code: 0, stdout: '', stderr: '', durationMs: args[0] === 'run' ? 17 : 0};
  };

  const result = await runAuthorContainer(spec(), {
    base,
    authorWorkspace: path.join(base, 'author-workspace'),
  }, {runImpl, authorImage: 'sha256:' + '8'.repeat(64)});

  assert.equal(bootstrapRuns, 2);
  assert.equal(authorTimeoutMs, AUTHOR_MODEL_ATTEMPT_MS);
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

test('a classified native bootstrap failure escalates once to the partitioned native toolchain', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'northset-native-escalation-'));
  t.after(() => rm(base, {recursive: true, force: true}));
  const images = [];
  const runImpl = async (command, args) => {
    assert.equal(command, 'docker');
    if (args[0] === 'run' && args.includes('northset-m-010-dependency-bootstrap')) {
      images.push(args.find((value) => String(value).startsWith('node@')));
      if (images.length === 1) return {code: 1, stdout: '', stderr: 'gyp ERR! build error', durationMs: 5};
    }
    return {code: 0, stdout: '', stderr: '', durationMs: args[0] === 'run' ? 7 : 0};
  };
  const result = await runAuthorContainer(spec(), {
    base, authorWorkspace: path.join(base, 'author-workspace'),
  }, {
    runImpl, authorImage: 'sha256:' + '8'.repeat(64), image: 'node@' + digest('1'),
    architecture: 'arm64', toolchainClass: 'node-pure', cacheKey: 'pure-key',
    nativeFallback: async () => ({
      image: 'node@' + digest('2'), architecture: 'arm64', cacheKey: 'native-key',
      cacheDir: path.join(base, 'native-cache'), toolchainClass: 'node-native',
    }),
  });
  assert.deepEqual(result.toolchainEscalation, {
    from: 'node-pure', to: 'node-native', reason: 'classified_native_toolchain_error',
  });
  assert.equal(result.image, 'node@' + digest('2'));
  assert.equal(result.cacheKey, 'native-key');
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
  const uiDependency = path.join('repo', 'ui', 'node_modules', '.bin', 'vitest');
  const clientDependency = path.join('repo', 'client', 'node_modules', '.bin', 'vitest');
  await mkdir(path.dirname(path.join(sourceWorkspace, marker)), {recursive: true});
  await writeFile(path.join(sourceWorkspace, marker), 'offline cache');
  await mkdir(path.dirname(path.join(sourceWorkspace, installState)), {recursive: true});
  await writeFile(path.join(sourceWorkspace, installState), 'install state');
  await mkdir(path.dirname(path.join(sourceWorkspace, uiDependency)), {recursive: true});
  await writeFile(path.join(sourceWorkspace, uiDependency), 'ui dependency');
  await mkdir(path.dirname(path.join(sourceWorkspace, clientDependency)), {recursive: true});
  await writeFile(path.join(sourceWorkspace, clientDependency), 'client dependency');
  await copyNodeDependencies(path.join(sourceWorkspace, 'repo'), path.join(targetWorkspace, 'repo'));
  assert.equal(await readFile(path.join(targetWorkspace, marker), 'utf8'), 'offline cache');
  assert.equal(await readFile(path.join(targetWorkspace, installState), 'utf8'), 'install state');
  assert.equal(await readFile(path.join(targetWorkspace, uiDependency), 'utf8'), 'ui dependency');
  assert.equal(await readFile(path.join(targetWorkspace, clientDependency), 'utf8'), 'client dependency');
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

  const uiValue = spec({oracle: {...spec().oracle, test_paths: ['ui/src/parser.test.ts']}});
  const uiArgs = checkDockerArgs(uiValue, '/runs/M-010/oracle', 'node@sha256:' + '9'.repeat(64), uiValue.oracle.command);
  assert.ok(uiArgs.includes('/workspace/repo/ui/node_modules/.vite-temp:rw,exec,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=700'));
});

test('changed-file risk classes reject dependency, CI, generated, binary, and profile-specific existing tests', () => {
  const classes = classifyChangedFiles(
    ['src/index.mjs', 'test/existing.test.mjs', 'test_parser.py', 'parser_test.go',
      'src/client.generated.ts', 'package.json', '.github/workflows/test.yml'],
    [
      {path: 'src/index.mjs'}, {path: 'test/existing.test.mjs'}, {path: 'test/new.test.mjs'},
      {path: 'test_parser.py'}, {path: 'parser_test.go'}, {path: 'src/client.generated.ts'},
      {path: 'package.json'}, {path: '.github/workflows/test.yml'}, {path: 'blob.dat', binary: true},
      {path: 'README.md'}, {path: 'CONTRIBUTING.md'}, {path: 'Makefile'},
      {path: '.github/dependabot.yml'}, {path: 'notes.unknown'}, {path: 'src/types.d.ts'},
      {path: 'src/types.pyi'}, {path: 'runtime.config.js'}, {path: 'config/runtime.js'},
      {path: 'examples/demo.py'}, {path: 'scripts/release.mjs'},
    ],
  );
  const byPath = Object.fromEntries(classes.map((item) => [item.path, item]));
  assert.equal(byPath['src/index.mjs'].flagged, false);
  assert.equal(byPath['test/new.test.mjs'].class, 'added-test');
  assert.equal(byPath['test/existing.test.mjs'].flagged, true);
  assert.equal(byPath['test_parser.py'].class, 'modified-existing-test');
  assert.equal(byPath['parser_test.go'].class, 'modified-existing-test');
  assert.equal(byPath['src/client.generated.ts'].class, 'generated-output');
  assert.equal(byPath['package.json'].class, 'dependency-manifest');
  assert.equal(byPath['.github/workflows/test.yml'].class, 'check-or-CI-config');
  assert.equal(byPath['blob.dat'].class, 'binary');
  for (const file of ['README.md', 'CONTRIBUTING.md', 'Makefile', '.github/dependabot.yml',
    'notes.unknown', 'src/types.d.ts', 'src/types.pyi', 'runtime.config.js',
    'config/runtime.js', 'examples/demo.py', 'scripts/release.mjs']) {
    assert.notEqual(byPath[file].class, 'source', file);
    assert.equal(byPath[file].flagged, true, file);
  }
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

test('dependency snapshot digest can ignore Finder metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-dependency-digest-'));
  await writeFile(path.join(root, 'module.txt'), 'module cache bytes\n');
  const before = await directoryDigest(root, {ignoreNames: ['.DS_Store']});
  await writeFile(path.join(root, '.DS_Store'), 'host metadata\n');
  assert.equal(await directoryDigest(root, {ignoreNames: ['.DS_Store']}), before);
});

test('public receipt omits an internal campaign control policy snapshot', async () => {
  const module = await import('./oss.mjs');
  assert.equal(typeof module.publicRepoPolicySnapshot, 'function');
  assert.equal(module.publicRepoPolicySnapshot({
    schema_version: 2,
    defaults: {max_open_prs: 1, daily_pr_cap: 1},
    repositories: {},
  }), null);
  const receiptPolicy = {
    url: 'https://github.com/owner/repo/blob/main/CONTRIBUTING.md',
    checked_at: '2026-07-17T21:25:13Z',
    ai_policy_summary: 'Contributions are accepted under the repository policy.',
  };
  assert.deepEqual(module.publicRepoPolicySnapshot(receiptPolicy), receiptPolicy);
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
  assert.deepEqual(args, ['api', 'repos/owner/repo/issues/123/timeline?per_page=100&page=1']);
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
  assert.equal(LIVE_RECHECK_OUTPUT_LIMIT_BYTES, 10_000_000);
  const value = spec();
  const state = {labels: ['help wanted'], updatedAt: value.qualification.issue_updated_at, comments: [], prs: [], timeline: [], designPresent: true, noticePresent: true};
  const gh = async (args) => {
    const joined = args.join(' ');
    if (joined.includes('/issues/comments/1')) return state.designPresent ? {
      html_url: value.qualification.acceptance_contract.design_evidence[0].url,
      author_association: 'MEMBER', created_at: '2026-07-13T10:00:00Z',
    } : {html_url: 'https://github.com/owner/repo/issues/123#issuecomment-2', author_association: 'NONE'};
    const page = Number(/(?:\?|&)page=(\d+)/.exec(joined)?.[1] ?? 1);
    if (joined.includes('/comments?')) return state.comments.slice((page - 1) * 100, page * 100);
    if (joined.includes('/timeline?')) return state.timeline.slice((page - 1) * 100, page * 100);
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
  state.comments = Array.from({length: 300}, (_, index) => ({id: index + 1}));
  const commentsBound = await recheck(value, async () => {}, options);
  assert.equal(commentsBound.clean, false);
  assert.ok(commentsBound.reasons.includes(
    'evidence_truncated_too_active: issue comments reached the 300-item evidence bound'));
  assert.deepEqual(commentsBound.snapshot.evidence_bounds.comments,
    {page_size: 100, pages_fetched: 3, truncated: true});
  state.comments = [];
  state.timeline = Array.from({length: 300}, (_, index) => ({id: index + 1}));
  const timelineBound = await recheck(value, async () => {}, options);
  assert.equal(timelineBound.clean, false);
  assert.ok(timelineBound.reasons.includes(
    'evidence_truncated_too_active: issue timeline reached the 300-item evidence bound'));
  assert.deepEqual(timelineBound.snapshot.evidence_bounds.timeline,
    {page_size: 100, pages_fetched: 3, truncated: true});
  state.timeline = [];
  const repoFallbackCalls = [];
  const repoFallbackGh = async (args) => {
    repoFallbackCalls.push(args);
    if (args[0] === 'api' && args[1] === 'repos/owner/repo') throw new Error('GitHub REST 503');
    if (args[0] === 'api' && args[1] === 'graphql') {
      return {default_branch: 'main', archived: false, fork: false, html_url: value.target_repo};
    }
    return gh(args);
  };
  assert.equal((await recheck(value, async () => {}, {...options, gh: repoFallbackGh})).clean, true);
  assert.ok(repoFallbackCalls.some((args) => args[0] === 'api' && args[1] === 'graphql'));
  const graphFallbackCalls = [];
  const graphFallbackGh = async (args) => {
    graphFallbackCalls.push(args);
    const joined = args.join(' ');
    if (args[0] === 'api' && args[1] === 'repos/owner/repo') throw new Error('GitHub REST 503');
    if (joined.includes('/comments?')) throw new Error('GitHub REST 503');
    if (joined.includes('/timeline?')) throw new Error('GitHub REST 503');
    if (joined.includes('/git/ref/heads/')) throw new Error('default ref REST should not be needed after repository GraphQL fallback');
    if (args[0] === 'api' && args[1] === 'graphql') {
      const query = args.find((item) => item.startsWith('query=')) ?? '';
      if (query.includes('defaultBranchRef')) {
        return {default_branch: 'main', default_head: value.base_commit, archived: false, fork: false, html_url: value.target_repo};
      }
      if (query.includes('comments(last:100)')) return {comments: [], truncated: false};
      if (query.includes('timelineItems(last:100')) return {timeline: [], truncated: false};
    }
    return gh(args);
  };
  assert.equal((await recheck(value, async () => {}, {...options, gh: graphFallbackGh})).clean, true);
  assert.ok(graphFallbackCalls.filter((args) => args[0] === 'api' && args[1] === 'graphql').length >= 3);
  state.labels = ['E-help-wanted'];
  assert.equal((await recheck(value, async () => {}, options)).clean, true);
  state.labels = ['help wanted'];
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
  const reviewedNotRelated = structuredClone(value);
  reviewedNotRelated.qualification.related_prs = [{
    url: 'https://github.com/owner/repo/pull/4', state: 'CLOSED', relationship: 'not_related',
    disposition: 'Reviewed during qualification and found to address different behavior.', reopened_by: null,
  }];
  state.prs = [{state: 'CLOSED', title: 'Parser bounded input fix', body: 'Fixes #123',
    url: 'https://github.com/owner/repo/pull/4', author: {login: 'someone'}, closedAt: '2026-07-12T12:00:00Z'}];
  state.timeline = [{event: 'cross-referenced', created_at: '2026-07-12T11:00:00Z', source: {issue: {
    html_url: 'https://github.com/owner/repo/pull/4', state: 'closed', title: 'Parser bounded input fix',
    pull_request: {url: 'https://api.github.com/repos/owner/repo/pulls/4'},
  }}}];
  assert.equal((await recheck(reviewedNotRelated, async () => {}, options)).clean, true);
  state.timeline = [];
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

  const customPolicy = {
    schema_version: 2,
    defaults: {max_open_prs: 1, daily_pr_cap: 1},
    repositories: {'Owner/Repo': {invitation_label_map: {'starter-ready': true}}},
  };
  const customDigest = sha256(Buffer.from(canonical(customPolicy)));
  const customSpec = spec({
    receipt: {repo_policy_snapshot: customPolicy},
    qualification: {
      ...spec().qualification,
      invitation_evidence: {
        type: 'label', url: value.issue_url, observed_at: '2026-07-13T12:00:00Z',
        label: 'starter-ready', repo_policy_sha256: customDigest,
      },
    },
  });
  assert.doesNotThrow(() => validateSpec(customSpec));
  assert.throws(() => validateSpec({
    ...customSpec,
    receipt: {repo_policy_snapshot: {...customPolicy, repositories: {}}},
  }), /custom invitation label.*snapshot/i);
  state.noticePresent = true;
  state.labels = ['starter-ready'];
  assert.equal((await recheck(customSpec, async () => {}, {...options, repoPolicy: customPolicy})).clean, true);
  state.labels = ['Starter-Ready'];
  assert.match((await recheck(customSpec, async () => {}, {...options, repoPolicy: customPolicy})).reasons.join(' '), /invitation/);
  state.labels = ['starter-ready'];
  assert.match((await recheck(customSpec, async () => {}, {
    ...options, repoPolicy: {...customPolicy, repositories: {}},
  })).reasons.join(' '), /invitation/);
});
