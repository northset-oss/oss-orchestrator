import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {createBackupKey, createEncryptedOperationalBackup, restoreEncryptedOperationalBackup} from './backup.mjs';

const exec = promisify(execFile);

test('encrypted off-machine backup restores the SQLite lake and shipment journals', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-backup-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'runs', 'M-001'), {recursive: true});
  await mkdir(path.join(repo, 'runs', 'batch-approvals'), {recursive: true});
  await mkdir(path.join(repo, 'runs', 'phase0'), {recursive: true});
  await exec('sqlite3', [path.join(repo, 'candidate_lake.sqlite'), 'CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items(value) VALUES("kept");']);
  await writeFile(path.join(repo, 'runs', 'M-001', 'ship.journal.json'), '{"state":"SHIPPED"}\n');
  await writeFile(path.join(repo, 'runs', 'batch-approvals', 'a.json'), '{"approved":true}\n');
  await writeFile(path.join(repo, 'runs', 'phase0', 'review-control.json'), '{"head_hash":"sha256:review"}\n');
  await writeFile(path.join(repo, 'runs', 'phase0', 'review-control.json.initialized'), 'northset-phase0-dual-review-disagreement\n');
  await writeFile(path.join(repo, 'runs', 'phase0', 'resource-control.json'), '{"provider_throttle":null}\n');
  const key = path.join(root, 'backup.key');
  await createBackupKey(key);
  const encrypted = path.join(root, 'off-machine', 'lake-journals.nsbak');
  const created = await createEncryptedOperationalBackup({repo, output: encrypted, keyFile: key,
    createdAt: '2026-07-17T12:00:00.000Z'});
  assert.equal(created.manifest.journal_files, 2);
  assert.equal(created.manifest.control_files, 3);
  assert.match(created.sha256, /^sha256:[0-9a-f]{64}$/);
  const restored = await restoreEncryptedOperationalBackup({backup: encrypted, keyFile: key,
    output: path.join(root, 'restored'), expectedSha256: created.sha256,
    expectedCreatedAt: '2026-07-17T12:00:00.000Z'});
  assert.equal(restored.sqlite_integrity, 'ok');
  assert.equal(await readFile(path.join(restored.output, 'runs', 'M-001', 'ship.journal.json'), 'utf8'), '{"state":"SHIPPED"}\n');
  assert.equal(await readFile(path.join(restored.output, 'runs', 'phase0', 'review-control.json'), 'utf8'),
    '{"head_hash":"sha256:review"}\n');
  assert.equal(await readFile(path.join(restored.output, 'runs', 'phase0', 'resource-control.json'), 'utf8'),
    '{"provider_throttle":null}\n');
  const wrong = path.join(root, 'wrong.key');
  await createBackupKey(wrong);
  await assert.rejects(() => restoreEncryptedOperationalBackup({backup: encrypted, keyFile: wrong,
    output: path.join(root, 'wrong'), expectedSha256: created.sha256,
    expectedCreatedAt: '2026-07-17T12:00:00.000Z'}), /authenticate|decrypt/i);
  await assert.rejects(() => restoreEncryptedOperationalBackup({backup: encrypted, keyFile: key,
    output: path.join(root, 'stale'), expectedSha256: `sha256:${'0'.repeat(64)}`,
    expectedCreatedAt: '2026-07-17T12:00:00.000Z'}), /expected digest/i);
});
