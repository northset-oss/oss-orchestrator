import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {createEvidenceManifest, verifyEvidenceManifest} from './evidence-manifest.mjs';

test('signed Phase 0 evidence manifest binds every artifact digest and the seal commit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-evidence-manifest-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await writeFile(first, 'one');
  await writeFile(second, 'two');
  const keys = generateKeyPairSync('ed25519');
  const record = await createEvidenceManifest({files: [{kind: 'source', file: first}, {kind: 'image', file: second}],
    privateKey: keys.privateKey, sealCommit: 'a'.repeat(40), createdAt: '2026-07-17T12:00:00Z'});
  assert.equal(record.seal_commit, 'a'.repeat(40));
  assert.equal(await verifyEvidenceManifest(record, keys.publicKey, {rehash: true}), true);
  await writeFile(second, 'changed');
  await assert.rejects(() => verifyEvidenceManifest(record, keys.publicKey, {rehash: true}), /digest/i);
});
