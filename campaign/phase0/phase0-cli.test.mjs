import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';

import {bindReviewSet, createReviewRecord, finalizeReviewedBoard} from './approvals.mjs';

const execFile = promisify(execFileCallback);
const digest = (character) => `sha256:${character.repeat(64)}`;

test('sign-batch-approval CLI binds explicit founder adjudications from a file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-phase0-cli-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const runs = path.join(root, 'runs');
  const ready = path.join(runs, 'M-902', 'ready-pack');
  await mkdir(ready, {recursive: true});

  const founder = generateKeyPairSync('ed25519');
  const second = generateKeyPairSync('ed25519');
  const base = {
    schema_version: 2,
    mission_id: 'M-902',
    repo: 'phase0/example',
    issue_url: 'https://github.com/phase0/example/issues/1',
    patch_sha256: digest('a'),
    pr_body_sha256: digest('b'),
    pr_title: 'fix: bounded example',
    pr_claim_text: 'Focused fix.',
    patch_review_sha256: digest('c'),
    bundle_digest: digest('d'),
    oracle_sha256: digest('e'),
    risk_flags: [],
    changed_file_classes: [],
  };
  const reviews = [
    createReviewRecord(base, {privateKey: founder.privateKey, disposition: 'SHIP', riskTier: 'GREEN', reviewedAt: '2026-07-17T12:00:00.000Z'}),
    createReviewRecord(base, {privateKey: second.privateKey, disposition: 'HOLD', riskTier: 'GREEN', reviewedAt: '2026-07-17T12:01:00.000Z'}),
  ];
  const manifest = bindReviewSet(base, reviews);
  const board = finalizeReviewedBoard({ordered_mission_ids: [manifest.mission_id]}, [manifest]);
  const privateFile = path.join(root, 'founder.pem');
  const boardFile = path.join(root, 'board.json');
  const adjudicationsFile = path.join(root, 'adjudications.json');
  const recordFile = path.join(root, 'approval.json');
  await Promise.all([
    writeFile(path.join(ready, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(privateFile, founder.privateKey.export({type: 'pkcs8', format: 'pem'}), {mode: 0o600}),
    writeFile(boardFile, `${JSON.stringify(board, null, 2)}\n`),
    writeFile(adjudicationsFile, `${JSON.stringify([{
      mission_id: manifest.mission_id,
      review_event_id: manifest.review_record_sha256,
      decision: 'SHIP',
      rationale: 'The bounded concern does not block this exact publication.',
    }], null, 2)}\n`),
  ]);

  await execFile(process.execPath, [
    path.resolve('campaign/phase0/phase0-cli.mjs'), 'sign-batch-approval',
    '--private', privateFile,
    '--board', boardFile,
    '--runs', runs,
    '--record', recordFile,
    '--founder-adjudications', adjudicationsFile,
    '--approved-at', '2026-07-17T12:05:00.000Z',
  ], {cwd: path.resolve('.')});
  const record = JSON.parse(await readFile(recordFile, 'utf8'));
  assert.deepEqual(record.founder_adjudications, [{
    mission_id: manifest.mission_id,
    review_event_id: manifest.review_record_sha256,
    decision: 'SHIP',
    rationale: 'The bounded concern does not block this exact publication.',
  }]);
});
