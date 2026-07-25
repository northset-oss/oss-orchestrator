import assert from 'node:assert/strict';
import {lstat, mkdtemp, readFile, rm, symlink, writeFile, mkdir} from 'node:fs/promises';
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
  dependencyVolumeInitDockerArgs,
  prepareCodexHome,
  runBounded,
  runtimeDockerArgs,
} from './node-worker.mjs';
import {createCommandDriver} from './worker.mjs';
import {SOURCE_MUTATION_MARKER} from './verifier.mjs';

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
  task.issue_snapshot.labels = ['good first issue'];
  task.issue_snapshot.body = '<!-- ordinary template guidance -->Please add a regression and fix value().';
  task.issue_snapshot.comments = [{
    author: 'AysajanE',
    body: '<!-- do not send this hidden text to the model --!>I would like to work on this.',
  }];
  let invocation;
  const worker = createNodeWorker({image: IMAGE, codexRunner: async (options) => {
    invocation = options;
    return {
      decision: 'GO', reason: 'small focused correction', test_command: 'node --test test/value.test.mjs',
      target_files: ['src/value.mjs', 'test/value.test.mjs'], estimated_risk: 'GREEN',
      pre_work_rule: 'Comment before starting.',
      pre_work_evidence: 'I would like to work on this.', required_checks: [],
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
  assert.match(invocation.prompt, /empty\s+install_command/);
  assert.match(invocation.prompt, /future\s+pull-request number/);
  assert.match(invocation.prompt, /Existing issue comments/);
  assert.match(invocation.prompt, /I would like to work on this/);
  assert.doesNotMatch(invocation.prompt, /ordinary template guidance|do not send this hidden text/);
  assert.match(invocation.prompt, /pre_work_rule/);
  assert.match(invocation.prompt, /current maintainer-authored issue already satisfies it/);
  assert.match(invocation.prompt, /required_checks/);
  assert.match(invocation.prompt, /Never call GitHub|Do not call GitHub/);
  assert.deepEqual(new Set(SCOUT_SCHEMA.required), new Set(Object.keys(SCOUT_SCHEMA.properties)));
  assert.equal(result.decision, 'GO');
  assert.deepEqual(result.target_files, ['src/value.mjs', 'test/value.test.mjs']);
});

test('N1b scout skips when mandatory pre-work communication has no issue evidence', async (t) => {
  const {checkout, task} = await repository(t);
  task.issue_snapshot.comments = [{author: 'someone-else', body: 'I would like to work on this.'}];
  const worker = createNodeWorker({image: IMAGE, codexRunner: async () => ({
    decision: 'GO', reason: 'the patch itself is bounded',
    test_command: 'node --test test/value.test.mjs && npm test && npm run typecheck',
    install_command: '', target_files: ['src/value.mjs', 'test/value.test.mjs'],
    estimated_risk: 'GREEN',
    pre_work_rule: 'Comment on medium issues before starting work.',
    pre_work_evidence: 'I would like to work on this.',
    required_checks: ['npm test', 'npm run typecheck'],
  })});

  const result = await worker.handle({action: 'scout', task, checkout});
  assert.equal(result.decision, 'SKIP');
  assert.match(result.reason, /required pre-work public communication was not completed/);
  assert.deepEqual(result.required_checks, ['npm test', 'npm run typecheck']);
});

test('N1b2 scout skips explicit documentation-only issues without model or bootstrap work', async (t) => {
  const root = await temporary(t, 'factory-node-worker-docs');
  let modelCalls = 0;
  const worker = createNodeWorker({
    codexRunner: async () => {
      modelCalls += 1;
      throw new Error('documentation-only issue must not reach the model');
    },
  });

  const result = await worker.handle({
    action: 'scout',
    task: {
      issue_snapshot: {
        title: 'Good First Issue: Document Implicit index Variable inside VirtualList Template Slots',
        labels: ['documentation'],
      },
    },
    checkout: root,
  });

  assert.equal(result.decision, 'SKIP');
  assert.match(result.reason, /documentation-only/);
  assert.equal(modelCalls, 0);

  const labeled = await worker.handle({
    action: 'scout',
    task: {
      issue_snapshot: {
        title: 'Add docs/README.md index linking all docs files',
        labels: ['documentation', 'good first issue'],
      },
    },
    checkout: root,
  });
  assert.equal(labeled.decision, 'SKIP');
  assert.equal(modelCalls, 0);

  for (const title of [
    'Documentation generator emits stale navigation',
    'README renderer truncates code blocks',
    'Translate command hangs on nested input',
    'Documentation pipeline hangs on startup',
    'README preview is blank',
    'Documentation index duplicates entries',
    'README links resolve incorrectly',
    'Translate task times out on nested input',
  ]) {
    const codeResult = await worker.handle({
      action: 'scout',
      task: {issue_snapshot: {title}},
      checkout: root,
    });
    assert.doesNotMatch(codeResult.reason, /documentation-only/, title);
    assert.match(codeResult.reason, /root package\.json is missing/, title);
  }

  const explicitDocs = await worker.handle({
    action: 'scout',
    task: {issue_snapshot: {title: 'Document the build command'}},
    checkout: root,
  });
  assert.doesNotMatch(explicitDocs.reason, /documentation-only/);
  assert.match(explicitDocs.reason, /root package\.json is missing/);

  let codeModelCalls = 0;
  const codeWorker = createNodeWorker({
    codexRunner: async () => {
      codeModelCalls += 1;
      return {
        decision: 'SKIP', reason: 'model inspected a testable code defect',
        test_command: '', install_command: '', target_files: [],
        estimated_risk: 'GREEN', pre_work_rule: '', pre_work_evidence: '',
        required_checks: [],
      };
    },
  });
  for (const title of [
    'Documentation build fails when schemas contain aliases',
    'Translate command fails on nested input',
  ]) {
    const codeResult = await codeWorker.handle({
      action: 'scout', task: {issue_snapshot: {title}}, checkout: root,
    });
    assert.equal(codeResult.reason, 'root package.json is missing');
  }
  assert.equal(codeModelCalls, 0);
});

test('N1c author must bind every required repository check into the verifier command', async (t) => {
  const {checkout, task} = await repository(t);
  let invocation;
  const worker = createNodeWorker({image: IMAGE, codexRunner: async (options) => {
    invocation = options;
    return {
      outcome: 'PATCH', reason: 'implemented focused correction',
      pr_title: 'fix: return expected value',
      pr_body: '## Test\n\n`npm test -- test/value.test.mjs && npm run typecheck`',
      summary: 'Return the expected value.', claim_type: 'regression_fix',
      test_command: 'npm test -- test/value.test.mjs && npm run typecheck',
      test_only_paths: ['test/value.test.mjs'], base_failure_contains: 'EXPECTED_TWO',
      checks: ['npm test -- test/value.test.mjs && npm run typecheck'],
    };
  }});

  await assert.rejects(() => worker.handle({
    action: 'author', task, checkout,
    scout: {required_checks: ['npm test', 'npm run typecheck'], estimated_risk: 'GREEN'},
  }), /author test_command omits required repository checks: npm test/);
  assert.match(invocation.prompt, /pr_title becomes the canonical commit subject/);
  assert.match(invocation.prompt, /read and follow any existing repository pull-request template/);
  assert.match(invocation.prompt, /Preserve its required fields and checklist items/);
  assert.match(invocation.prompt, /leave any unrun QA or UAT check unchecked/);
  assert.match(invocation.prompt, /do not invent evidence or an\s+API-contract classification/);
  assert.match(invocation.prompt, /exact\s+command the clean verifier and receipt will bind/);
  assert.equal(await git(['-C', checkout, 'status', '--porcelain', '--untracked-files=all']), '');
});

test('N1d scout rejects workspace and PnP layouts before model or bootstrap work', async (t) => {
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

  await rm(path.join(checkout, '.yarnrc.yml'));
  await writeFile(path.join(checkout, 'composer.json'), JSON.stringify({
    name: 'fixture/mixed-php-node',
  }));
  const composer = await worker.handle({action: 'scout', task, checkout});
  assert.equal(composer.decision, 'SKIP');
  assert.match(composer.reason, /mixed PHP\/Node repositories require an explicit Node target/);

  let mixedNodeCalls = 0;
  const mixedNodeWorker = createNodeWorker({
    image: IMAGE,
    codexRunner: async () => {
      mixedNodeCalls += 1;
      return {
        decision: 'SKIP', reason: 'model inspected an explicit Node target',
        test_command: '', install_command: '', target_files: [],
        estimated_risk: 'GREEN', pre_work_rule: '', pre_work_evidence: '',
        required_checks: [],
      };
    },
  });
  const explicitNode = await mixedNodeWorker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Fix the JavaScript value helper',
        body: 'Update src/value.mjs and run node --test.',
      },
    },
    checkout,
  });
  assert.equal(explicitNode.reason, 'model inspected an explicit Node target');
  assert.equal(mixedNodeCalls, 1);

  const nodeWithPhpContext = await mixedNodeWorker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Update the JavaScript client',
        body: 'Update src/value.mjs to handle output documented in backend/Controller.php.',
      },
    },
    checkout,
  });
  assert.equal(nodeWithPhpContext.reason, 'model inspected an explicit Node target');
  assert.equal(mixedNodeCalls, 2);

  const nodeWithInspectedPhpContext = await mixedNodeWorker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Update the JavaScript client',
        body: 'Update src/value.mjs; inspect backend/Controller.php for the response format.',
      },
    },
    checkout,
  });
  assert.equal(nodeWithInspectedPhpContext.reason, 'model inspected an explicit Node target');
  assert.equal(mixedNodeCalls, 3);

  const nodeWithLaravelContext = await mixedNodeWorker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Update the JavaScript client for Laravel responses',
        body: 'Update src/value.mjs.',
      },
    },
    checkout,
  });
  assert.equal(nodeWithLaravelContext.reason, 'model inspected an explicit Node target');
  assert.equal(mixedNodeCalls, 4);

  const phpForReact = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Fix the PHP response consumed by the React client',
        body: 'The Laravel controller returns the wrong status.',
      },
    },
    checkout,
  });
  assert.equal(phpForReact.decision, 'SKIP');
  assert.match(phpForReact.reason, /mixed PHP\/Node repositories require an explicit Node target/);

  const phpWithNodeVerification = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Fix the Laravel response',
        body: 'Update the PHP controller.\nRun npm test after the change.',
      },
    },
    checkout,
  });
  assert.equal(phpWithNodeVerification.decision, 'SKIP');
  assert.match(phpWithNodeVerification.reason, /mixed PHP\/Node repositories require an explicit Node target/);

  const mixedMutationTargets = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Update the response and client',
        body: 'Modify the Laravel controller. Update src/value.mjs.',
      },
    },
    checkout,
  });
  assert.equal(mixedMutationTargets.decision, 'SKIP');
  assert.match(mixedMutationTargets.reason, /mixed PHP\/Node repositories require an explicit Node target/);

  const modifiedPhpPath = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Update the response and client',
        body: 'Update existing backend/Controller.php. Update src/value.mjs.',
      },
    },
    checkout,
  });
  assert.equal(modifiedPhpPath.decision, 'SKIP');
  assert.match(modifiedPhpPath.reason, /mixed PHP\/Node repositories require an explicit Node target/);

  const modifiedLegacyPhp = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Update the response and client',
        body: 'Refactor the legacy Laravel controller. Update src/value.mjs.',
      },
    },
    checkout,
  });
  assert.equal(modifiedLegacyPhp.decision, 'SKIP');
  assert.match(modifiedLegacyPhp.reason, /mixed PHP\/Node repositories require an explicit Node target/);

  const sameClauseMixedPaths = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Update both clients',
        body: 'Update src/value.mjs and backend/Controller.php.',
      },
    },
    checkout,
  });
  assert.equal(sameClauseMixedPaths.decision, 'SKIP');
  assert.match(sameClauseMixedPaths.reason, /mixed PHP\/Node repositories require an explicit Node target/);

  const phpLocationAfterReactContext = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Fix response handling',
        body: 'Fix React handling in the Laravel controller.',
      },
    },
    checkout,
  });
  assert.equal(phpLocationAfterReactContext.decision, 'SKIP');
  assert.match(phpLocationAfterReactContext.reason, /mixed PHP\/Node repositories require an explicit Node target/);

  const sameClauseMixedTechnologies = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Update both frontends',
        body: 'Update the React frontend and Laravel controller.',
      },
    },
    checkout,
  });
  assert.equal(sameClauseMixedTechnologies.decision, 'SKIP');
  assert.match(sameClauseMixedTechnologies.reason, /mixed PHP\/Node repositories require an explicit Node target/);
  await rm(path.join(checkout, 'composer.json'));

  await mkdir(path.join(checkout, 'backend'));
  await writeFile(path.join(checkout, 'backend', 'composer.json'), JSON.stringify({
    name: 'fixture/php-backend',
  }));
  const nestedComposer = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Fix backend response',
        body: 'Start in backend/src/Controller.php',
      },
    },
    checkout,
  });
  assert.equal(nestedComposer.decision, 'SKIP');
  assert.match(nestedComposer.reason, /nested Composer package backend\//);

  const directoryComposer = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Fix backend response',
        body: 'Start in backend',
      },
    },
    checkout,
  });
  assert.equal(directoryComposer.decision, 'SKIP');
  assert.match(directoryComposer.reason, /nested Composer package backend\//);

  const implementedInComposer = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Add validation',
        body: 'Implement validation in backend',
      },
    },
    checkout,
  });
  assert.equal(implementedInComposer.decision, 'SKIP');
  assert.match(implementedInComposer.reason, /nested Composer package backend\//);

  let nestedContextCalls = 0;
  const nestedContextWorker = createNodeWorker({
    image: IMAGE,
    codexRunner: async () => {
      nestedContextCalls += 1;
      return {
        decision: 'SKIP', reason: 'model inspected the explicit Node path',
        test_command: '', install_command: '', target_files: [],
        estimated_risk: 'GREEN', pre_work_rule: '', pre_work_evidence: '',
        required_checks: [],
      };
    },
  });
  const inspectedComposerContext = await nestedContextWorker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Update the JavaScript client',
        body: 'Update src/value.mjs; inspect backend/Controller.php for the response format.',
      },
    },
    checkout,
  });
  assert.equal(inspectedComposerContext.reason, 'model inspected the explicit Node path');
  assert.equal(nestedContextCalls, 1);

  const usedComposerContext = await nestedContextWorker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Update the JavaScript client',
        body: 'Update src/value.mjs; use backend/Controller.php as a reference.',
      },
    },
    checkout,
  });
  assert.equal(usedComposerContext.reason, 'model inspected the explicit Node path');
  assert.equal(nestedContextCalls, 2);

  for (const target of ['./backend', 'backend.']) {
    const normalizedDirectoryComposer = await worker.handle({
      action: 'scout',
      task: {
        ...task,
        issue_snapshot: {
          title: 'Fix backend response',
          body: `Start in ${target}`,
        },
      },
      checkout,
    });
    assert.equal(normalizedDirectoryComposer.decision, 'SKIP');
    assert.match(normalizedDirectoryComposer.reason, /nested Composer package backend\//);
  }

  const nestedContext = await nestedContextWorker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Update the JavaScript client',
        body: 'Update src/value.mjs so it handles data from backend/src/Controller.php.',
      },
    },
    checkout,
  });
  assert.equal(nestedContext.reason, 'model inspected the explicit Node path');
  assert.equal(nestedContextCalls, 3);

  await mkdir(path.join(checkout, 'stellar-payment-platform'));
  await writeFile(path.join(checkout, 'stellar-payment-platform', 'package.json'), JSON.stringify({
    name: 'nested-backend', private: true,
  }));
  const nested = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Fix CORS configuration',
        body: 'Where to Start: stellar-payment-platform/server.js',
      },
    },
    checkout,
  });
  assert.equal(nested.decision, 'SKIP');
  assert.match(nested.reason, /nested package stellar-payment-platform\//);

  await mkdir(path.join(checkout, 'packages', 'api'), {recursive: true});
  await writeFile(path.join(checkout, 'packages', 'api', 'package.json'), JSON.stringify({
    name: 'nested-api', private: true,
  }));
  const deepNested = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Fix API response',
        body: 'Start in packages/api/src/server.js',
      },
    },
    checkout,
  });
  assert.equal(deepNested.decision, 'SKIP');
  assert.match(deepNested.reason, /nested package packages\/api\//);

  const directoryOnly = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Fix API response',
        body: 'Start in packages/api',
      },
    },
    checkout,
  });
  assert.equal(directoryOnly.decision, 'SKIP');
  assert.match(directoryOnly.reason, /nested package packages\/api\//);

  await mkdir(path.join(checkout, 'packages', '@scope', 'api'), {recursive: true});
  await writeFile(path.join(checkout, 'packages', '@scope', 'api', 'package.json'), JSON.stringify({
    name: '@scope/api', private: true,
  }));
  const scopedNested = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Fix scoped API response',
        body: 'Start in packages/@scope/api/src/server.js',
      },
    },
    checkout,
  });
  assert.equal(scopedNested.decision, 'SKIP');
  assert.match(scopedNested.reason, /nested package packages\/@scope\/api\//);

  await symlink(path.join('packages', 'api'), path.join(checkout, 'linked-api'));
  const symlinkedNested = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Fix linked API response',
        body: 'Start in linked-api/src/server.js',
      },
    },
    checkout,
  });
  assert.equal(symlinkedNested.decision, 'SKIP');
  assert.match(symlinkedNested.reason, /target linked-api\/ uses a symlink/);

  await mkdir(path.join(checkout, 'manifest-link'));
  await symlink(path.join('..', 'package.json'), path.join(checkout, 'manifest-link', 'package.json'));
  const symlinkedManifest = await worker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Fix manifest-linked API response',
        body: 'Start in manifest-link/src/server.js',
      },
    },
    checkout,
  });
  assert.equal(symlinkedManifest.decision, 'SKIP');
  assert.match(symlinkedManifest.reason, /nested package manifest-link\/ uses a symlinked manifest/);

  let traversalModelCalls = 0;
  const traversalWorker = createNodeWorker({
    image: IMAGE,
    codexRunner: async () => {
      traversalModelCalls += 1;
      return {
        decision: 'SKIP', reason: 'model inspected the non-nested target',
        test_command: '', install_command: '', target_files: [],
        estimated_risk: 'GREEN', pre_work_rule: '', pre_work_evidence: '',
        required_checks: [],
      };
    },
  });
  const traversal = await traversalWorker.handle({
    action: 'scout',
    task: {
      ...task,
      issue_snapshot: {
        title: 'Fix shared response',
        body: 'Inspect src/../shared/file.js',
      },
    },
    checkout,
  });
  assert.equal(traversal.reason, 'model inspected the non-nested target');
  assert.equal(traversalModelCalls, 1);

  await rm(path.join(checkout, 'package.json'));
  const missingRoot = await worker.handle({action: 'scout', task, checkout});
  assert.equal(missingRoot.decision, 'SKIP');
  assert.match(missingRoot.reason, /root package\.json/);
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
  assert.doesNotMatch(joinedAuthor, /service_tier="fast"/);
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
  assert.match(bootstrap, /--user\n1000:1000/);
  assert.match(bootstrap, /\/workspace:rw,exec,nosuid,nodev,size=2g,mode=1777/);
  assert.match(bootstrap, /tar -C \/source/);
  assert.match(bootstrap, /--strip-components=1 --no-same-owner --no-same-permissions -m/);
  assert.match(bootstrap, /src=northset-deps-abc,dst=\/workspace\/node_modules$/m);
  assert.doesNotMatch(bootstrap, /dst=\/workspace\/node_modules,readonly/);
  assert.doesNotMatch(bootstrap, /auth\.json|CODEX_HOME|GITHUB_TOKEN|GH_TOKEN/);

  const volumeInit = dependencyVolumeInitDockerArgs({
    volume: 'northset-deps-abc', image: IMAGE,
  }).join('\n');
  assert.match(volumeInit, /--network=none/);
  assert.match(volumeInit, /--read-only/);
  assert.match(volumeInit, /--cap-drop=ALL/);
  assert.match(volumeInit, /--cap-add=CHOWN/);
  assert.match(volumeInit, /src=northset-deps-abc,dst=\/deps/);
  assert.match(volumeInit, /chown\n-R\n1000:1000\n\/deps$/);
  assert.doesNotMatch(volumeInit, /\/source|CODEX_HOME|GITHUB_TOKEN|GH_TOKEN/);

  const runtime = runtimeDockerArgs({
    checkout, volume: 'northset-deps-abc', image: IMAGE, command: 'node --test',
  }).join('\n');
  assert.match(runtime, /--network=none/);
  assert.match(runtime, /src=northset-deps-abc,dst=\/workspace\/node_modules,readonly/);
  assert.match(runtime, /src=\/private\/factory\/repository,dst=\/source,readonly/);
  assert.match(runtime, /\/workspace:rw,exec,nosuid,nodev,size=2g/);
  assert.match(runtime, /tar -C \/source/);
  assert.match(runtime, /NORTHSET_VERIFY_COMMAND=node --test/);
  assert.match(runtime, /northset_snapshot \/source \/tmp\/northset-source-before\.tar/);
  assert.match(runtime, /northset_snapshot \/workspace \/tmp\/northset-source-after\.tar/);
  assert.match(runtime, /tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner/);
  assert.doesNotMatch(runtime, /git diff|exclude-standard/);
  assert.match(runtime, new RegExp(SOURCE_MUTATION_MARKER));

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

test('N2b runtime detects tracked and untracked mutations inside the real container copy', async (t) => {
  const image = process.env.OSS_AUTHOR_IMAGE ?? 'northset-oss-author:0.144.1';
  let available;
  try {
    available = await runBounded('docker', ['image', 'inspect', image], {timeoutMs: 30_000});
  } catch {
    t.skip('Docker is unavailable');
    return;
  }
  if (available.code !== 0) {
    t.skip(`verifier image ${image} is unavailable`);
    return;
  }

  const {root, checkout} = await repository(t);
  await writeFile(path.join(checkout, '.gitignore'), 'ignored-output.txt\n');
  await git(['-C', checkout, 'add', '.gitignore']);
  await git(['-C', checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '-q', '-m', 'ignore generated output']);
  const volume = `northset-verifier-test-${path.basename(root).replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
  const created = await runBounded('docker', ['volume', 'create', volume], {timeoutMs: 30_000});
  assert.equal(created.code, 0, created.stderr || created.stdout);
  t.after(() => runBounded('docker', ['volume', 'rm', '-f', volume], {timeoutMs: 30_000}));

  const runVerification = (command) => runBounded('docker', runtimeDockerArgs({
    checkout, volume, image, command,
  }), {timeoutMs: 30_000});

  const cleanPass = await runVerification('node -e "process.exit(0)"');
  assert.equal(cleanPass.code, 0, cleanPass.stderr || cleanPass.stdout);
  assert.doesNotMatch(cleanPass.stderr, new RegExp(SOURCE_MUTATION_MARKER));

  const metadataOnlyTouch = await runVerification('touch src/value.mjs');
  assert.equal(metadataOnlyTouch.code, 0, metadataOnlyTouch.stderr || metadataOnlyTouch.stdout);
  assert.doesNotMatch(metadataOnlyTouch.stderr, new RegExp(SOURCE_MUTATION_MARKER));

  const cleanFailure = await runVerification('node -e "process.exit(7)"');
  assert.equal(cleanFailure.code, 7, cleanFailure.stderr || cleanFailure.stdout);
  assert.doesNotMatch(cleanFailure.stderr, new RegExp(SOURCE_MUTATION_MARKER));

  const spoofedMarker = await runVerification(
    `node -e "console.error('${SOURCE_MUTATION_MARKER}'); process.exit(0)"`,
  );
  assert.equal(spoofedMarker.code, 0, spoofedMarker.stderr || spoofedMarker.stdout);
  assert.match(spoofedMarker.stderr, new RegExp(SOURCE_MUTATION_MARKER));

  const spoofedMarkerFailure = await runVerification(
    `node -e "console.error('${SOURCE_MUTATION_MARKER}'); process.exit(7)"`,
  );
  assert.equal(spoofedMarkerFailure.code, 7,
    spoofedMarkerFailure.stderr || spoofedMarkerFailure.stdout);
  assert.match(spoofedMarkerFailure.stderr, new RegExp(SOURCE_MUTATION_MARKER));

  const trackedMutation = await runVerification(
    'node -e "require(\'node:fs\').writeFileSync(\'src/value.mjs\', \'formatted\\n\')"',
  );
  assert.equal(trackedMutation.code, 86, trackedMutation.stderr || trackedMutation.stdout);
  assert.match(trackedMutation.stderr, new RegExp(SOURCE_MUTATION_MARKER));

  const normalizedTrackedMutation = await runVerification(
    'node -e "require(\'node:fs\').writeFileSync(\'src/value.mjs\', \'export function value() { return 1; }\\r\\n\')"',
  );
  assert.equal(normalizedTrackedMutation.code, 86,
    normalizedTrackedMutation.stderr || normalizedTrackedMutation.stdout);
  assert.match(normalizedTrackedMutation.stderr, new RegExp(SOURCE_MUTATION_MARKER));

  const untrackedMutationAfterFailure = await runVerification(
    'node -e "require(\'node:fs\').writeFileSync(\'generated-source.mjs\', \'generated\\n\'); process.exit(7)"',
  );
  assert.equal(untrackedMutationAfterFailure.code, 86,
    untrackedMutationAfterFailure.stderr || untrackedMutationAfterFailure.stdout);
  assert.match(untrackedMutationAfterFailure.stderr, new RegExp(SOURCE_MUTATION_MARKER));

  const ignoredMutation = await runVerification(
    'node -e "require(\'node:fs\').writeFileSync(\'ignored-output.txt\', \'ignored\\n\')"',
  );
  assert.equal(ignoredMutation.code, 86, ignoredMutation.stderr || ignoredMutation.stdout);
  assert.match(ignoredMutation.stderr, new RegExp(SOURCE_MUTATION_MARKER));

  const modeMutation = await runVerification('chmod +x src/value.mjs');
  assert.equal(modeMutation.code, 86, modeMutation.stderr || modeMutation.stdout);
  assert.match(modeMutation.stderr, new RegExp(SOURCE_MUTATION_MARKER));

  const typeAndSymlinkMutation = await runVerification(
    'rm src/value.mjs && ln -s ../package.json src/value.mjs',
  );
  assert.equal(typeAndSymlinkMutation.code, 86,
    typeAndSymlinkMutation.stderr || typeAndSymlinkMutation.stdout);
  assert.match(typeAndSymlinkMutation.stderr, new RegExp(SOURCE_MUTATION_MARKER));
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
      arg.startsWith('type=bind,src=') && arg.includes(',dst=/source,readonly'));
    assert.ok(checkoutMount, args.join(' '));
    const source = checkoutMount.slice('type=bind,src='.length).split(',dst=/source,readonly')[0];
    const cleanEnvironment = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !name.startsWith('NODE_TEST')));
    const commandInWorkspace = args.find((arg) => typeof arg === 'string' &&
      arg.startsWith('NORTHSET_VERIFY_COMMAND=')).slice('NORTHSET_VERIFY_COMMAND='.length);
    const result = await runBounded('sh', ['-lc', commandInWorkspace], {
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

test('N6b outer worker timeout relays termination to nested bounded work', async (t) => {
  const root = await temporary(t, 'factory-node-worker-group');
  const started = path.join(root, 'started');
  const orphaned = path.join(root, 'orphaned');
  const nested = [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(started)}, 'started');`,
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(orphaned)}, 'orphaned'), 1200);`,
  ].join('\n');
  const wrapper = [
    `import {runBounded} from ${JSON.stringify(new URL('./node-worker.mjs', import.meta.url).href)};`,
    `await runBounded(process.execPath, ['-e', ${JSON.stringify(nested)}], {timeoutMs: 10_000});`,
  ].join('\n');
  const driver = createCommandDriver({
    command: process.execPath,
    args: ['--input-type=module', '-e', wrapper],
  });

  await assert.rejects(
    driver.scout({}, root, {timeoutMs: 500}),
    /worker command timed out after 500ms/,
  );
  assert.equal(await readFile(started, 'utf8'), 'started');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await assert.rejects(readFile(orphaned, 'utf8'), (error) => error.code === 'ENOENT');
});

test('N6c bounded command timeout terminates its spawned grandchild', async (t) => {
  const root = await temporary(t, 'factory-node-worker-subtree');
  const started = path.join(root, 'started');
  const orphaned = path.join(root, 'orphaned');
  const grandchild = [
    "const fs = require('node:fs');",
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(orphaned)}, 'orphaned'), 1200);`,
  ].join('\n');
  const child = [
    "const {spawn} = require('node:child_process');",
    "const fs = require('node:fs');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio: 'ignore'});`,
    `fs.writeFileSync(${JSON.stringify(started)}, 'started');`,
    'setTimeout(() => {}, 10_000);',
  ].join('\n');

  await assert.rejects(runBounded(process.execPath, ['-e', child], {timeoutMs: 500}),
    (error) => error.code === 'ETIMEDOUT');
  assert.equal(await readFile(started, 'utf8'), 'started');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await assert.rejects(readFile(orphaned, 'utf8'), (error) => error.code === 'ENOENT');
});
