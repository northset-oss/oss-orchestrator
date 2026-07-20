import assert from 'node:assert/strict';
import {lstat, mkdtemp, readFile, rm, writeFile, mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUTHOR_SCHEMA,
  SCOUT_SCHEMA,
  bootstrapDockerArgs,
  codexHostArgs,
  codexProcessEnvironment,
  createNodeWorker,
  prepareCodexHome,
  runBounded,
  runtimeDockerArgs,
} from './node-worker.mjs';

const IMAGE = 'northset-oss-author:test';
const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;

async function temporary(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

async function git(args, options = {}) {
  const result = await runBounded('git', args, {timeoutMs: 30_000, ...options});
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function repository(t) {
  const root = await temporary(t, 'factory-node-worker');
  const checkout = path.join(root, 'repository');
  await mkdir(path.join(checkout, 'src'), {recursive: true});
  await writeFile(path.join(checkout, 'package.json'), `${JSON.stringify({
    name: 'worker-fixture', private: true, type: 'module', scripts: {test: 'node --test'},
  }, null, 2)}\n`);
  await writeFile(path.join(checkout, 'package-lock.json'), `${JSON.stringify({
    name: 'worker-fixture', lockfileVersion: 3, requires: true, packages: {'': {name: 'worker-fixture'}},
  }, null, 2)}\n`);
  await writeFile(path.join(checkout, 'src', 'value.mjs'), 'export function value() { return 1; }\n');
  await git(['init', '-q', checkout]);
  await git(['-C', checkout, 'add', '-A']);
  await git(['-C', checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '-q', '-m', 'fixture base']);
  const baseOid = await git(['-C', checkout, 'rev-parse', 'HEAD']);
  const task = {
    task_id: 'TASK-NODE-1', candidate: 'owner/repo#7', repository: 'owner/repo', issue_number: 7,
    base_oid: baseOid,
    issue_snapshot: {title: 'Return the expected value', body: 'Please add a regression and fix value().'},
    live_state: {repository: {id: 'R_fixture', defaultBranch: 'main'}},
  };
  return {root, checkout, baseOid, task};
}

function ok(stdout = '') {
  return {code: 0, stdout, stderr: ''};
}

test('N1 scout uses the bounded structured read-only contract', async (t) => {
  const {checkout, task} = await repository(t);
  let invocation;
  const worker = createNodeWorker({image: IMAGE, codexRunner: async (options) => {
    invocation = options;
    return {
      decision: 'GO', reason: 'small focused correction', test_command: 'node --test test/value.test.mjs',
      target_files: ['src/value.mjs', 'test/value.test.mjs'], estimated_risk: 'GREEN',
    };
  }});
  const result = await worker.handle({
    action: 'scout', task, checkout, effort: 'medium', timeoutMs: 200_000,
  });
  assert.equal(invocation.schema, SCOUT_SCHEMA);
  assert.equal(invocation.readOnly, true);
  assert.equal(invocation.effort, 'medium');
  assert.equal(invocation.timeoutMs, 90_000);
  assert.match(invocation.prompt, /Inspect this checkout read-only/);
  assert.match(invocation.prompt, /empty install_command/);
  assert.match(invocation.prompt, /Never call GitHub|Do not call GitHub/);
  assert.deepEqual(new Set(SCOUT_SCHEMA.required), new Set(Object.keys(SCOUT_SCHEMA.properties)));
  assert.deepEqual(result.target_files, ['src/value.mjs', 'test/value.test.mjs']);
});

test('N1b scout rejects workspace and PnP layouts before model or bootstrap work', async (t) => {
  const {checkout, task} = await repository(t);
  const worker = createNodeWorker({image: IMAGE, codexRunner: async () => assert.fail('no model call')});
  await writeFile(path.join(checkout, 'package.json'), JSON.stringify({
    name: 'worker-fixture', private: true, workspaces: ['packages/*'],
  }));
  const workspace = await worker.handle({action: 'scout', task, checkout});
  assert.equal(workspace.decision, 'SKIP');
  assert.match(workspace.reason, /multi-package workspaces/);

  await writeFile(path.join(checkout, 'package.json'), JSON.stringify({
    name: 'worker-fixture', private: true, packageManager: 'yarn@4.9.2',
  }));
  const pnp = await worker.handle({action: 'scout', task, checkout});
  assert.equal(pnp.decision, 'SKIP');
  assert.match(pnp.reason, /Yarn Berry/);

  await writeFile(path.join(checkout, 'package.json'), JSON.stringify({
    name: 'worker-fixture', private: true,
  }));
  await writeFile(path.join(checkout, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
  const yarnRc = await worker.handle({action: 'scout', task, checkout});
  assert.equal(yarnRc.decision, 'SKIP');
  assert.match(yarnRc.reason, /Yarn Berry/);
});

test('N2 the authenticated model client stays host-side and Docker plans remain credential-free', async (t) => {
  const checkout = '/private/factory/repository';
  const codexHome = '/private/factory/codex-home';
  const outputRoot = '/private/factory/output';
  const author = codexHostArgs({
    checkout,
    schemaFile: `${outputRoot}/schema.json`, outputFile: `${outputRoot}/result.json`,
    model: 'test-model', effort: 'high', readOnly: false,
  });
  const joinedAuthor = author.join('\n');
  assert.equal(author[0], 'exec');
  assert.match(joinedAuthor, /-C\n\/private\/factory\/repository/);
  assert.match(joinedAuthor, /default_permissions="factory_workspace"/);
  assert.doesNotMatch(joinedAuthor, /--sandbox/);
  assert.doesNotMatch(joinedAuthor, /--ignore-user-config/);
  assert.doesNotMatch(joinedAuthor, /dangerously-bypass-approvals-and-sandbox/);
  assert.doesNotMatch(joinedAuthor, /docker|--mount|auth\.json/);
  assert.match(joinedAuthor, /--output-schema/);
  assert.match(joinedAuthor, /--output-last-message/);
  assert.match(joinedAuthor, /shell_environment_policy\.exclude/);
  const clientEnvironment = codexProcessEnvironment({codexHome});
  assert.equal(clientEnvironment.CODEX_ACCESS_TOKEN, undefined);
  assert.equal(clientEnvironment.CODEX_HOME, codexHome);
  assert.equal(clientEnvironment.GITHUB_TOKEN, undefined);
  assert.equal(clientEnvironment.GH_TOKEN, undefined);
  assert.equal(clientEnvironment.OPENAI_API_KEY, undefined);

  const scout = codexHostArgs({
    checkout,
    schemaFile: `${outputRoot}/schema.json`, outputFile: `${outputRoot}/result.json`,
    model: 'test-model', effort: 'medium', readOnly: true,
  }).join('\n');
  assert.match(scout, /default_permissions="factory_readonly"/);

  const bootstrap = bootstrapDockerArgs({
    checkout, volume: 'northset-deps-abc', image: IMAGE,
    installCommand: 'npm ci --no-audit --no-fund',
  }).join('\n');
  assert.match(bootstrap, /src=\/private\/factory\/repository,dst=\/source,readonly/);
  assert.match(bootstrap, /\/workspace:rw,exec,nosuid,nodev,size=2g/);
  assert.match(bootstrap, /tar -C \/source/);
  assert.match(bootstrap, /src=northset-deps-abc,dst=\/workspace\/node_modules$/m);
  assert.doesNotMatch(bootstrap, /dst=\/workspace\/node_modules,readonly/);
  assert.doesNotMatch(bootstrap, /auth\.json|CODEX_HOME|GITHUB_TOKEN|GH_TOKEN/);

  const runtime = runtimeDockerArgs({
    checkout, volume: 'northset-deps-abc', image: IMAGE, command: 'node --test',
  }).join('\n');
  assert.match(runtime, /--network=none/);
  assert.match(runtime, /src=northset-deps-abc,dst=\/workspace\/node_modules,readonly/);
  assert.match(runtime, /src=\/private\/factory\/repository,dst=\/workspace,readonly/);

  const authRoot = await temporary(t, 'factory-codex-auth');
  const sourceHome = path.join(authRoot, 'source-home');
  await mkdir(sourceHome, {recursive: true});
  await writeFile(path.join(sourceHome, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: 'host-id-token',
      access_token: 'host-access-token',
      refresh_token: 'host-refresh-token',
      account_id: 'host-account-id',
    },
    last_refresh: '2026-07-19T00:00:00Z',
  }));
  const isolatedHome = await prepareCodexHome(authRoot, sourceHome);
  const isolatedConfig = await readFile(path.join(isolatedHome, 'config.toml'), 'utf8');
  const isolatedAuth = JSON.parse(await readFile(path.join(isolatedHome, 'auth.json'), 'utf8'));
  assert.deepEqual(isolatedAuth.tokens, {
    id_token: 'host-id-token',
    access_token: 'host-access-token',
    refresh_token: '',
    account_id: 'host-account-id',
  });
  assert.equal(isolatedAuth.auth_mode, 'chatgpt');
  assert.match(isolatedConfig, /default_permissions = "factory_readonly"/);
  assert.match(isolatedConfig, /\[permissions\.factory_readonly\.filesystem\]/);
  assert.match(isolatedConfig, /\[permissions\.factory_workspace\.filesystem\]/);
  assert.match(isolatedConfig, new RegExp(`${sourceHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" = "deny"`));
  assert.match(isolatedConfig, new RegExp(`${isolatedHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" = "deny"`));
});

test('N3 bootstrap creates one content-keyed volume and then reuses its frozen marker', async (t) => {
  const {checkout, task} = await repository(t);
  const calls = [];
  let ready = false;
  const run = async (command, args, options) => {
    calls.push({command, args: [...args], options});
    assert.equal(command, 'docker');
    if (args[0] === 'image') return ok(`${IMAGE_DIGEST}\n`);
    if (args.includes('/deps/.northset-ready')) return {code: ready ? 0 : 1, stdout: '', stderr: ''};
    if (args[0] === 'volume' && args[1] === 'create') return ok(`${args[2]}\n`);
    if (args[0] === 'volume' && args[1] === 'rm') return ok();
    if (args[0] === 'run') { ready = true; return ok(); }
    assert.fail(`unexpected Docker command ${args.join(' ')}`);
  };
  const worker = createNodeWorker({run, image: IMAGE, codexRunner: async () => assert.fail('no model call')});
  const payload = {
    action: 'bootstrap', task, checkout,
    scout: {test_command: 'node --test test/value.test.mjs', estimated_risk: 'GREEN'},
  };
  const first = await worker.handle(payload);
  const second = await worker.handle(payload);
  assert.match(first.cache_key, /^sha256:[a-f0-9]{64}$/);
  assert.equal(second.cache_key, first.cache_key);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.deepEqual(first.mounts, [{
    source: `northset-deps-${first.cache_key.slice(-32)}`,
    target: '/workspace/node_modules', readOnly: true,
  }]);
  assert.equal(calls.filter((call) => call.args[0] === 'volume' && call.args[1] === 'create').length, 1);
  const install = calls.find((call) => call.args[0] === 'run' &&
    call.args.some((arg) => String(arg).includes('npm ci')));
  assert.ok(install);
  assert.equal(install.args.at(-4), IMAGE_DIGEST);
  assert.match(install.args.join('\n'), /dst=\/source,readonly/);
  assert.match(install.args.join('\n'), /dst=\/workspace\/node_modules(?:\n|$)/);
  assert.doesNotMatch(install.args.join('\n'), /dst=\/workspace\/node_modules,readonly/);
  await assert.rejects(() => lstat(path.join(checkout, 'node_modules')), {code: 'ENOENT'});
});

test('N4 only recognizable Docker or registry bootstrap failures are retryable', async (t) => {
  const {checkout, task} = await repository(t);
  const runner = (stderr) => async (_command, args) => {
    if (args[0] === 'image') return ok(`${IMAGE_DIGEST}\n`);
    if (args.includes('/deps/.northset-ready')) return {code: 1, stdout: '', stderr: ''};
    if (args[0] === 'volume') return ok();
    return {code: 1, stdout: '', stderr};
  };
  const payload = {action: 'bootstrap', task, checkout, scout: {test_command: 'node --test'}};
  const transient = createNodeWorker({run: runner('npm error code EAI_AGAIN\npackage registry unavailable'), image: IMAGE});
  await assert.rejects(() => transient.handle(payload), (error) =>
    error.transient === true && /temporary bootstrap infrastructure failure/.test(error.message));

  const mountFailure = createNodeWorker({
    run: runner('docker: Error response from daemon: error mounting dependency volume: ' +
      'create mountpoint for /workspace/node_modules: read-only file system'),
    image: IMAGE,
  });
  await assert.rejects(() => mountFailure.handle(payload), (error) =>
    error.transient === true && /temporary bootstrap infrastructure failure/.test(error.message));

  const deterministic = createNodeWorker({run: runner('npm error: unsupported engine for this package'), image: IMAGE});
  await assert.rejects(() => deterministic.handle(payload), (error) =>
    error.transient !== true && /unsupported engine/.test(error.message));
});

test('N5 direct author produces a host DCO commit and clean verifier proves base-red patched-green', async (t) => {
  const {checkout, baseOid, task} = await repository(t);
  const dockerCalls = [];
  let deferredBaseRoot = null;
  const run = async (command, args, options = {}) => {
    if (command !== 'docker') return runBounded(command, args, options);
    assert.equal(args[0], 'run');
    const checkoutMount = args.find((arg) => typeof arg === 'string' &&
      arg.startsWith('type=bind,src=') && arg.includes(',dst=/workspace,readonly'));
    assert.ok(checkoutMount, args.join(' '));
    const source = checkoutMount.slice('type=bind,src='.length).split(',dst=/workspace,readonly')[0];
    const cleanEnvironment = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !name.startsWith('NODE_TEST')));
    const result = await runBounded('sh', ['-lc', args.at(-1)], {
      cwd: source, env: cleanEnvironment,
      timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes,
    });
    dockerCalls.push({args: [...args], source, result});
    return result;
  };
  const dependencyMaterial = {
    cache_key: `sha256:${'b'.repeat(64)}`,
    image: IMAGE,
    image_digest: IMAGE_DIGEST,
    mounts: [{source: 'northset-deps-fixture', target: '/workspace/node_modules', readOnly: true}],
  };
  let authorInvocation;
  const worker = createNodeWorker({
    run,
    image: IMAGE,
    removeTree: async (root, options) => {
      assert.deepEqual(options, {tolerateBusy: true});
      deferredBaseRoot = root;
      return false;
    },
    codexRunner: async (options) => {
    assert.equal(options.schema, AUTHOR_SCHEMA);
    authorInvocation = options;
    await mkdir(path.join(checkout, 'test'));
    await writeFile(path.join(checkout, 'test', 'value.test.mjs'), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import {value} from '../src/value.mjs';",
      "test('value', () => assert.equal(value(), 2, 'BASE_MARKER_EXPECTED_TWO'));",
      '',
    ].join('\n'));
    await writeFile(path.join(checkout, 'src', 'value.mjs'), 'export function value() { return 2; }\n');
    return {
      outcome: 'PATCH', reason: 'implemented focused correction',
      pr_title: 'fix: return expected value',
      pr_body: '## Summary\n\nReturn the expected value and cover it with a regression.',
      summary: 'Return the expected value.', claim_type: 'regression_fix',
      test_command: 'node --test test/value.test.mjs',
      test_only_paths: ['test/value.test.mjs'], base_failure_contains: 'BASE_MARKER_EXPECTED_TWO',
      checks: ['node --test test/value.test.mjs'],
    };
    },
  });
  const authored = await worker.handle({
    action: 'author', task, checkout,
    scout: {decision: 'GO', test_command: 'node --test test/value.test.mjs', estimated_risk: 'GREEN'},
    effort: 'high', timeoutMs: 20 * 60_000, dependencyMaterial,
  });
  assert.equal(authorInvocation.readOnly, false);
  assert.equal(authorInvocation.timeoutMs, 10 * 60_000);
  assert.equal(authorInvocation.dependencyMaterial, dependencyMaterial);
  assert.equal(authorInvocation.image, IMAGE_DIGEST);
  assert.match(authorInvocation.prompt, /feature_implementation/);
  assert.ok(AUTHOR_SCHEMA.properties.claim_type.enum.includes('feature_implementation'));
  assert.equal(await git(['-C', checkout, 'rev-parse', 'HEAD^']), baseOid);
  assert.equal(await git(['-C', checkout, 'status', '--porcelain', '--untracked-files=all']), '');
  const identity = await git(['-C', checkout, 'show', '-s', '--format=%an%n%ae%n%ce%n%B', 'HEAD']);
  assert.match(identity, /^Aysajan Eziz\naeziz@northset\.ai\naeziz@northset\.ai\n/);
  assert.match(identity, /Signed-off-by: Aysajan Eziz <aeziz@northset\.ai>/);
  const testOnlyPatch = await readFile(authored.test_only_patch_file, 'utf8');
  assert.match(testOnlyPatch, /diff --git a\/test\/value\.test\.mjs b\/test\/value\.test\.mjs/);
  assert.doesNotMatch(testOnlyPatch, /diff --git a\/src\/value\.mjs b\/src\/value\.mjs/);

  let verification;
  try {
    verification = await worker.handle({action: 'verify', task, checkout, authored, dependencyMaterial});
  } catch (error) {
    assert.fail(`${error.message}\n${JSON.stringify(dockerCalls, null, 2)}`);
  }
  assert.equal(verification.ok, true);
  assert.equal(verification.claim_type, 'regression_fix');
  assert.equal(verification.base_observation.exit_code, 1);
  assert.equal(verification.patched_observation.exit_code, 0);
  assert.equal(verification.dco_verified, true);
  assert.equal(verification.commit_oid, authored.commit_oid);
  assert.equal(verification.dependency_cache_key, dependencyMaterial.cache_key);
  assert.equal(verification.test_command, 'node --test test/value.test.mjs');
  assert.deepEqual(verification.test_only_paths, ['test/value.test.mjs']);
  assert.equal(verification.base_failure_contains, 'BASE_MARKER_EXPECTED_TWO');
  assert.equal(verification.dependency_image_digest, IMAGE_DIGEST);
  assert.equal(dockerCalls.length, 2);
  for (const call of dockerCalls) {
    const joined = call.args.join('\n');
    assert.match(joined, /--network=none/);
    assert.match(joined, /src=northset-deps-fixture,dst=\/workspace\/node_modules,readonly/);
    assert.equal(call.args.at(-4), IMAGE_DIGEST);
  }
  assert.match(path.basename(deferredBaseRoot), /^\.northset-base-/);
  await rm(deferredBaseRoot, {recursive: true, force: true});

  await worker.handle({action: 'reset', task, checkout, authored});
  assert.equal(await git(['-C', checkout, 'rev-parse', 'HEAD']), baseOid);
  assert.equal(await git(['-C', checkout, 'status', '--porcelain', '--untracked-files=all']), '');
  assert.equal(await readFile(path.join(checkout, 'src', 'value.mjs'), 'utf8'),
    'export function value() { return 1; }\n');
  await assert.rejects(() => readFile(path.join(checkout, 'test', 'value.test.mjs'), 'utf8'),
    (error) => error.code === 'ENOENT');
});

test('N6 subprocess execution is bounded by both wall time and aggregate output', async () => {
  await assert.rejects(() => runBounded(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    timeoutMs: 30, maxOutputBytes: 1024,
  }), (error) => error.code === 'ETIMEDOUT');
  await assert.rejects(() => runBounded(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096))"], {
    timeoutMs: 2_000, maxOutputBytes: 128,
  }), (error) => error.code === 'EOUTPUTLIMIT');
});
