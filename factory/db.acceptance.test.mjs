import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';

import {FACTORY_SCHEMA_VERSION, openFactoryDb} from './db.mjs';

test('schema v1 publication checkpoints migrate additively and retain async recovery fields', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-db-migration-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const database = path.join(root, 'factory.sqlite');
  const legacy = new DatabaseSync(database);
  legacy.exec(`
    CREATE TABLE factory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO factory_meta(key,value) VALUES('schema_version','1'),('next_mission_number','1000');
    CREATE TABLE publications(
      mission_id TEXT PRIMARY KEY,branch TEXT,pushed_oid TEXT,pr_url TEXT,pr_number INTEGER,
      pr_head_oid TEXT,receipt_url TEXT,proof_published INTEGER NOT NULL DEFAULT 0,
      attestation_state TEXT NOT NULL DEFAULT 'NOT_STARTED',
      publication_state TEXT NOT NULL DEFAULT 'APPROVED',last_error TEXT,updated_at TEXT NOT NULL
    );
    INSERT INTO publications(mission_id,branch,proof_published,attestation_state,publication_state,updated_at)
      VALUES('M-1000','northset/m-1000',1,'ATTESTATION_PENDING','SUBMITTED','2026-07-19T12:00:00.000Z');
  `);
  legacy.close();

  const db = openFactoryDb(database);
  t.after(() => db.close());
  assert.equal(Number(db.connection.prepare("SELECT value FROM factory_meta WHERE key='schema_version'").get().value),
    FACTORY_SCHEMA_VERSION);
  const saved = db.savePublication('M-1000', {
    task_id: 'TASK-OSS-RECOVERY',
    pr_base_branch: 'main',
    receipt_state: 'PUBLISHED',
    attestation_url: 'https://example.test/attestations/1000',
    attested_at: '2026-07-19T12:05:00.000Z',
    attestation_error: null,
    submitted_at: '2026-07-19T12:01:00.000Z',
    status_state: 'PENDING',
    status_url: null,
    status_error: 'temporary status failure',
    last_error_detail: 'retry asynchronously',
  });
  assert.equal(saved.branch, 'northset/m-1000');
  assert.equal(saved.proof_published, true);
  assert.equal(saved.task_id, 'TASK-OSS-RECOVERY');
  assert.equal(saved.pr_base_branch, 'main');
  assert.equal(saved.receipt_state, 'PUBLISHED');
  assert.equal(saved.attestation_url, 'https://example.test/attestations/1000');
  assert.equal(saved.attested_at, '2026-07-19T12:05:00.000Z');
  assert.equal(saved.submitted_at, '2026-07-19T12:01:00.000Z');
  assert.equal(saved.status_state, 'PENDING');
  assert.equal(saved.status_error, 'temporary status failure');
  assert.equal(saved.last_error_detail, 'retry asynchronously');
});
