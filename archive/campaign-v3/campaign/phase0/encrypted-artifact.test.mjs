import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {createBackupKey} from './backup.mjs';
import {decryptArtifact, encryptArtifact} from './encrypted-artifact.mjs';

test('large artifact encryption authenticates and restores exact bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-artifact-encryption-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source.tar');
  await writeFile(source, Buffer.alloc(1024 * 1024 + 7, 0x5a));
  const key = await createBackupKey(path.join(root, 'key'));
  const encrypted = await encryptArtifact({input: source, output: path.join(root, 'remote.nsae'), keyFile: key});
  assert.match(encrypted.input_sha256, /^sha256:[0-9a-f]{64}$/);
  const restored = await decryptArtifact({input: encrypted.file, output: path.join(root, 'restored.tar'), keyFile: key});
  assert.equal(restored.output_sha256, encrypted.input_sha256);
  assert.deepEqual(await readFile(restored.file), await readFile(source));
  const bytes = await readFile(encrypted.file);
  bytes[bytes.length - 20] ^= 1;
  await writeFile(encrypted.file, bytes);
  await assert.rejects(() => decryptArtifact({input: encrypted.file, output: path.join(root, 'tampered.tar'), keyFile: key}), /authenticate|decrypt/i);
});
