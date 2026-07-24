import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertDcoIdentity,
  assertPatchCommitBinding,
  bootstrapDependencies,
  buildProof,
  dependencyCacheKey,
  SOURCE_MUTATION_MARKER,
  verifyContribution,
} from './verifier.mjs';

const exec = promisify(execFile);

async function git(cwd, ...args) {
  return (await exec('git', ['-C', cwd, ...args], {
    env: {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'},
  })).stdout.trim();
}

async function makeGitFixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'factory-verifier-'));
  const root = path.join(parent, 'repo');
  await mkdir(root);
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.name', 'Aysajan Eziz');
  await git(root, 'config', 'user.email', 'aeziz@northset.ai');
  await writeFile(path.join(root, 'value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-q', '-m', 'base');
  const baseOid = await git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'value.mjs'), 'export const value = 2;\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-q', '-m', 'fix', '-m', 'Signed-off-by: Aysajan Eziz <aeziz@northset.ai>');
  const commitOid = await git(root, 'rev-parse', 'HEAD');
  const commitTreeOid = await git(root, 'rev-parse', 'HEAD^{tree}');
  const patchFile = path.join(parent, 'fix.patch');
  const patch = (await exec('git', ['-C', root, 'diff', '--binary', baseOid, commitOid], {
    env: {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'},
  })).stdout;
  await writeFile(patchFile, patch);
  t.after(async () => {});
  return {parent, root, baseOid, commitOid, commitTreeOid, patchFile};
}

function fakeRunner({base = 1, patched = 0, onPlan = null} = {}) {
  return async (plan) => {
    await onPlan?.(plan);
    return plan.phase === 'base_observation'
      ? {code: base, stdout: 'base', stderr: base ? 'failed' : ''}
      : {code: patched, stdout: 'patched', stderr: patched ? 'failed' : ''};
  };
}

test('commit identity rejects the personal Gmail fallback', async (t) => {
  const fixture = await makeGitFixture(t);
  await git(fixture.root,
    '-c', 'user.name=Aysajan Eziz',
    '-c', 'user.email=aysajan1986@gmail.com',
    'commit', '--amend', '--no-edit', '--reset-author');
  const commitOid = await git(fixture.root, 'rev-parse', 'HEAD');

  await assert.rejects(
    () => assertDcoIdentity(fixture.root, commitOid),
    /commit identity must be Aysajan Eziz <aeziz@northset\.ai>/,
  );
});

function input(fixture, claimType) {
  return {
    claimType,
    baseCheckout: fixture.root,
    patchedCheckout: fixture.root,
    baseOid: fixture.baseOid,
    commitOid: fixture.commitOid,
    commitTreeOid: fixture.commitTreeOid,
    patchFile: fixture.patchFile,
    testCommand: 'node --test',
    baseFailureContains: 'failed',
    dependencyMaterial: {cache_key: `sha256:${'a'.repeat(64)}`, mounts: [{source: 'deps', target: '/deps', readOnly: true}]},
    environment: {image: `sha256:${'b'.repeat(64)}`},
  };
}

test('V1 regression fix records base red and patched green', async (t) => {
  const fixture = await makeGitFixture(t);
  const result = await verifyContribution(input(fixture, 'regression_fix'), {runContainer: fakeRunner()});
  assert.equal(result.base_observation.exit_code, 1);
  assert.equal(result.patched_observation.exit_code, 0);
  assert.equal(result.claim_type, 'regression_fix');
  assert.equal(result.tested_tree_oid, fixture.commitTreeOid);
  assert.deepEqual(result.executed_commands.map((command) => ({
    phase: command.phase,
    command: command.command,
    result: command.result,
    expected_result: command.expected_result,
    expectation_met: command.expectation_met,
  })), [{
    phase: 'base_observation', command: 'node --test', result: 'FAIL',
    expected_result: 'failure', expectation_met: true,
  }, {
    phase: 'patched_observation', command: 'node --test', result: 'PASS',
    expected_result: 'success', expectation_met: true,
  }]);
  assert.match(result.verification_started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(result.verification_finished_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('V1b proof v3 separates executed evidence from declared checks that were not run', async (t) => {
  const fixture = await makeGitFixture(t);
  const verification = await verifyContribution(input(fixture, 'regression_fix'), {
    runContainer: fakeRunner(),
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  });
  const proof = buildProof({
    task: {task_id: 'TASK-1', candidate: 'owner/repo#1', repository: 'owner/repo', issue_number: 1},
    verification,
    manifest: {
      base_oid: fixture.baseOid,
      checks: [
        'node --test',
        {command: 'npm test', status: 'BLOCKED'},
        {kind: 'manual', note: 'browser interaction was not checked'},
      ],
      limitations: ['The full npm test suite was not executed.'],
      receipt_claim: {type: 'regression_fix', statement: 'Focused regression evidence only.'},
    },
  });
  assert.equal(proof.schema_version, 3);
  assert.equal(proof.executed_commands.length, 2);
  assert.deepEqual(proof.checks_not_run, [{
    check: 'npm test',
    reason: 'not executed by the clean verifier',
  }, {
    check: '{"kind":"manual","note":"browser interaction was not checked"}',
    reason: 'not executed by the clean verifier',
  }]);
  assert.deepEqual(proof.limitations, ['The full npm test suite was not executed.']);
  assert.equal(proof.executed_commands.some((command) => /npm test/.test(command.command)), false);

  assert.throws(() => buildProof({
    task: {task_id: 'TASK-1', candidate: 'owner/repo#1', repository: 'owner/repo', issue_number: 1},
    verification,
    manifest: {
      base_oid: fixture.baseOid,
      checks: ['node --test'],
      checks_not_run: ['repository-wide checks were not rerun'],
      receipt_claim: {type: 'regression_fix', statement: 'Focused regression evidence only.'},
    },
  }), /checks_not_run entries require nonblank check and reason strings/);
});

test('V2 existing check repair records an existing failure and patched success', async (t) => {
  const fixture = await makeGitFixture(t);
  const result = await verifyContribution(input(fixture, 'existing_check_repair'), {runContainer: fakeRunner()});
  assert.equal(result.base_observation.exit_code, 1);
  assert.equal(result.patched_observation.exit_code, 0);
  assert.equal(result.claim_type, 'existing_check_repair');
});

test('invited feature implementation records missing base behavior without a regression claim', async (t) => {
  const fixture = await makeGitFixture(t);
  const result = await verifyContribution(input(fixture, 'feature_implementation'), {
    runContainer: fakeRunner(),
  });
  assert.equal(result.base_observation.exit_code, 1);
  assert.equal(result.patched_observation.exit_code, 0);
  assert.equal(result.claim_type, 'feature_implementation');
  assert.equal(result.base_observation.expected_result, 'failure');
});

test('V3 coverage addition records two passes without a runtime defect claim', async (t) => {
  const fixture = await makeGitFixture(t);
  const result = await verifyContribution(input(fixture, 'coverage_addition'), {
    runContainer: fakeRunner({base: 0, patched: 0}),
  });
  assert.equal(result.base_observation.exit_code, 0);
  assert.equal(result.patched_observation.exit_code, 0);
  assert.equal(result.claim_type, 'coverage_addition');
  assert.equal(JSON.stringify(result).includes('runtime defect'), false);
});

test('V4 dependency volume is writable only during bootstrap and read-only for verification', async (t) => {
  const fixture = await makeGitFixture(t);
  const bootstrapPlans = [];
  const cacheKey = await dependencyCacheKey({
    repositoryNodeId: 'R_test', repository: 'owner/repo', profile: 'node',
    executorImageDigest: `sha256:${'a'.repeat(64)}`, architecture: 'arm64',
    installCommands: ['npm ci'], checkout: fixture.root,
  });
  const material = await bootstrapDependencies({
    cacheKey, checkout: fixture.root, profile: 'node', installCommands: ['npm ci'],
  }, {runContainer: async (plan) => {
    bootstrapPlans.push(plan);
    return {code: 0};
  }});
  assert.equal(bootstrapPlans[0].mounts.every((mount) => mount.readOnly === false), true);
  assert.equal(material.mounts.every((mount) => mount.readOnly === true), true);
  const runtimePlans = [];
  await verifyContribution({...input(fixture, 'regression_fix'), dependencyMaterial: material}, {
    runContainer: fakeRunner({onPlan: async (plan) => runtimePlans.push(plan)}),
  });
  assert.equal(runtimePlans.every((plan) => plan.mounts.every((mount) => mount.readOnly === true)), true);
});

test('V5 tracked source mutation during final verification fails', async (t) => {
  const fixture = await makeGitFixture(t);
  await assert.rejects(() => verifyContribution(input(fixture, 'regression_fix'), {
    runContainer: fakeRunner({onPlan: async (plan) => {
      if (plan.phase === 'patched_observation') await writeFile(path.join(fixture.root, 'value.mjs'), 'mutated\n');
    }}),
  }), /tracked source changed/i);
});

test('V5b container-copy mutation fails even when the patched command succeeds', async (t) => {
  const fixture = await makeGitFixture(t);
  await assert.rejects(() => verifyContribution(input(fixture, 'regression_fix'), {
    runContainer: async (plan) => plan.phase === 'base_observation'
      ? {code: 1, stdout: 'base', stderr: 'failed'}
      : {code: 86, stdout: 'patched', stderr: SOURCE_MUTATION_MARKER},
  }), /patched observation changed source during clean verification/i);
});

test('V5c expected base failure cannot mask a container-copy mutation', async (t) => {
  const fixture = await makeGitFixture(t);
  let calls = 0;
  await assert.rejects(() => verifyContribution(input(fixture, 'regression_fix'), {
    runContainer: async () => {
      calls += 1;
      return {code: 86, stdout: 'failed', stderr: SOURCE_MUTATION_MARKER};
    },
  }), /base observation changed source during clean verification/i);
  assert.equal(calls, 1);
});

test('V5d command output cannot spoof the structured mutation verdict', async (t) => {
  const fixture = await makeGitFixture(t);
  const result = await verifyContribution(input(fixture, 'regression_fix'), {
    runContainer: async (plan) => plan.phase === 'base_observation'
      ? {code: 1, stdout: 'failed', stderr: ''}
      : {code: 0, stdout: SOURCE_MUTATION_MARKER, stderr: ''},
  });
  assert.equal(result.patched_observation.exit_code, 0);
  assert.equal(result.patched_observation.result, 'PASS');
});

test('V5e expected base failure may print the marker without spoofing mutation', async (t) => {
  const fixture = await makeGitFixture(t);
  const result = await verifyContribution(input(fixture, 'regression_fix'), {
    runContainer: async (plan) => plan.phase === 'base_observation'
      ? {code: 1, stdout: `failed\n${SOURCE_MUTATION_MARKER}`, stderr: ''}
      : {code: 0, stdout: 'patched', stderr: ''},
  });
  assert.equal(result.base_observation.exit_code, 1);
  assert.equal(result.base_observation.result, 'FAIL');
  assert.equal(result.base_observation.expectation_met, true);
});

test('V6 patch tree or commit binding mismatch fails', async (t) => {
  const fixture = await makeGitFixture(t);
  const badPatch = path.join(fixture.parent, 'bad.patch');
  const bytes = await readFile(fixture.patchFile, 'utf8');
  await writeFile(badPatch, bytes.replace('+export const value = 2;', '+export const value = 3;'));
  await assert.rejects(() => assertPatchCommitBinding({
    repoDir: fixture.root,
    baseOid: fixture.baseOid,
    commitOid: fixture.commitOid,
    patchFile: badPatch,
  }), /binding mismatch/i);
});
