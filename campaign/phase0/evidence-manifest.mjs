import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {stat} from 'node:fs/promises';
import path from 'node:path';

import {signRecord, verifySignedRecord} from './integrity.mjs';

async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

export async function createEvidenceManifest({files, privateKey, sealCommit, createdAt = new Date().toISOString()} = {}) {
  if (!/^[0-9a-f]{40}$/i.test(sealCommit ?? '')) throw new Error('seal commit must be a full Git commit OID');
  if (!Array.isArray(files) || !files.length) throw new Error('evidence files are required');
  const evidence = [];
  for (const entry of files) {
    const file = path.resolve(entry.file);
    const info = await stat(file);
    if (!info.isFile()) throw new Error(`evidence is not a regular file: ${file}`);
    evidence.push({kind: entry.kind, label: entry.label ?? path.basename(file), file,
      bytes: info.size, sha256: await fileDigest(file)});
  }
  evidence.sort((left, right) => left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label));
  return signRecord({kind: 'phase0_evidence_manifest', seal_commit: sealCommit,
    created_at: createdAt, evidence}, privateKey);
}

export async function verifyEvidenceManifest(record, publicKey, {rehash = false} = {}) {
  if (record?.kind !== 'phase0_evidence_manifest') throw new Error('record is not a Phase 0 evidence manifest');
  verifySignedRecord(record, publicKey);
  if (rehash) {
    for (const item of record.evidence) {
      const info = await stat(item.file);
      if (info.size !== item.bytes || await fileDigest(item.file) !== item.sha256) {
        throw new Error(`evidence digest mismatch: ${item.label}`);
      }
    }
  }
  return true;
}
