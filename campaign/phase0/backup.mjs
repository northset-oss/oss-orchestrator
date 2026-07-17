import {execFile} from 'node:child_process';
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {promisify} from 'node:util';
import {
  chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {sha256} from '../../core.mjs';

const exec = promisify(execFile);
const MAGIC = 'NORTHSET-PHASE0-BACKUP-V1\n';

async function readKey(file) {
  const key = Buffer.from((await readFile(file, 'utf8')).trim(), 'base64');
  if (key.length !== 32) throw new Error('backup key must decode to exactly 32 bytes');
  return key;
}

export async function createBackupKey(file) {
  await mkdir(path.dirname(path.resolve(file)), {recursive: true, mode: 0o700});
  try {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(`${randomBytes(32).toString('base64')}\n`); }
    finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await chmod(file, 0o600);
  await readKey(file);
  return path.resolve(file);
}

async function exists(file) {
  try { await stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function journalPaths(repo) {
  const runs = path.join(repo, 'runs');
  if (!await exists(runs)) return [];
  const result = [];
  for (const entry of await readdir(runs, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(runs, entry.name);
    const journal = path.join(directory, 'ship.journal.json');
    if (await exists(journal)) result.push(journal);
    if (entry.name === 'batch-approvals') {
      for (const approval of await readdir(directory, {withFileTypes: true})) {
        if (approval.isFile() && approval.name.endsWith('.json')) result.push(path.join(directory, approval.name));
      }
    }
  }
  return result.sort();
}

async function controlPaths(repo) {
  const directory = path.join(repo, 'runs', 'phase0');
  const names = [
    'review-control.json',
    'review-control.json.initialized',
    'resource-control.json',
  ];
  const result = [];
  for (const name of names) {
    const file = path.join(directory, name);
    if (await exists(file)) result.push(file);
  }
  return result.sort();
}

function sqliteString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function inventory(root, relativeFiles) {
  const files = [];
  for (const relative of relativeFiles.sort()) {
    const bytes = await readFile(path.join(root, relative));
    files.push({path: relative, bytes: bytes.length, sha256: sha256(bytes)});
  }
  return files;
}

export async function createEncryptedOperationalBackup({repo, output, keyFile, createdAt = new Date().toISOString()} = {}) {
  const absoluteRepo = path.resolve(repo);
  const absoluteOutput = path.resolve(output);
  const key = await readKey(path.resolve(keyFile));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'northset-operational-backup-'));
  try {
    const stage = path.join(temporary, 'payload');
    await mkdir(path.join(stage, 'runs'), {recursive: true, mode: 0o700});
    const lakeSource = path.join(absoluteRepo, 'candidate_lake.sqlite');
    if (!await exists(lakeSource)) throw new Error('candidate_lake.sqlite is missing');
    const lakeTarget = path.join(stage, 'candidate_lake.sqlite');
    await exec('sqlite3', [lakeSource, `.backup ${sqliteString(lakeTarget)}`]);

    const relativeFiles = ['candidate_lake.sqlite'];
    const journals = await journalPaths(absoluteRepo);
    const controls = await controlPaths(absoluteRepo);
    for (const source of [...journals, ...controls]) {
      const relative = path.relative(absoluteRepo, source);
      const target = path.join(stage, relative);
      await mkdir(path.dirname(target), {recursive: true, mode: 0o700});
      await copyFile(source, target);
      relativeFiles.push(relative);
    }
    const manifest = {
      schema_version: 2,
      kind: 'northset_phase0_operational_backup',
      created_at: createdAt,
      source_repository: path.basename(absoluteRepo),
      journal_files: journals.length,
      control_files: controls.length,
      files: await inventory(stage, relativeFiles),
    };
    await writeFile(path.join(stage, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {mode: 0o600});
    const tarFile = path.join(temporary, 'payload.tar');
    await exec('tar', ['-C', stage, '-cf', tarFile, '.']);
    const plaintext = await readFile(tarFile);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const header = Buffer.from(`${JSON.stringify({algorithm: 'aes-256-gcm', iv: iv.toString('base64'),
      auth_tag: cipher.getAuthTag().toString('base64')})}\n`, 'utf8');
    const bytes = Buffer.concat([Buffer.from(MAGIC, 'utf8'), header, ciphertext]);
    await mkdir(path.dirname(absoluteOutput), {recursive: true, mode: 0o700});
    await writeFile(absoluteOutput, bytes, {mode: 0o600});
    return {file: absoluteOutput, sha256: sha256(bytes), manifest};
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}

export async function restoreEncryptedOperationalBackup({backup, keyFile, output, expectedSha256, expectedCreatedAt} = {}) {
  const bytes = await readFile(path.resolve(backup));
  if (!/^sha256:[0-9a-f]{64}$/i.test(expectedSha256 ?? '') || sha256(bytes) !== expectedSha256) {
    throw new Error('backup does not match the separately expected digest');
  }
  if (typeof expectedCreatedAt !== 'string' || !expectedCreatedAt) throw new Error('expected backup checkpoint time is required');
  const magic = Buffer.from(MAGIC, 'utf8');
  if (!bytes.subarray(0, magic.length).equals(magic)) throw new Error('backup format is invalid');
  const headerEnd = bytes.indexOf(0x0a, magic.length);
  if (headerEnd < 0) throw new Error('backup header is invalid');
  const header = JSON.parse(bytes.subarray(magic.length, headerEnd).toString('utf8'));
  if (header.algorithm !== 'aes-256-gcm') throw new Error('backup encryption algorithm is unsupported');
  const key = await readKey(path.resolve(keyFile));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(header.auth_tag, 'base64'));
  let plaintext;
  try { plaintext = Buffer.concat([decipher.update(bytes.subarray(headerEnd + 1)), decipher.final()]); }
  catch (error) { throw new Error(`cannot authenticate or decrypt backup: ${error.message}`); }

  const absoluteOutput = path.resolve(output);
  await mkdir(path.dirname(absoluteOutput), {recursive: true, mode: 0o700});
  const temporary = await mkdtemp(path.join(path.dirname(absoluteOutput), '.northset-restore-'));
  try {
    const tarFile = path.join(temporary, 'payload.tar');
    const extracted = path.join(temporary, 'payload');
    await mkdir(extracted, {recursive: true, mode: 0o700});
    await writeFile(tarFile, plaintext, {mode: 0o600});
    await exec('tar', ['-C', extracted, '-xf', tarFile]);
    const manifest = JSON.parse(await readFile(path.join(extracted, 'backup-manifest.json'), 'utf8'));
    if (manifest.created_at !== expectedCreatedAt) throw new Error('backup checkpoint time does not match the expected checkpoint');
    for (const item of manifest.files) {
      const content = await readFile(path.join(extracted, item.path));
      if (content.length !== item.bytes || sha256(content) !== item.sha256) throw new Error(`restored digest mismatch: ${item.path}`);
    }
    const integrity = (await exec('sqlite3', [path.join(extracted, 'candidate_lake.sqlite'), 'PRAGMA integrity_check;'])).stdout.trim();
    if (integrity !== 'ok') throw new Error(`restored SQLite integrity check failed: ${integrity}`);
    const previous = path.join(temporary, 'previous-output');
    const hadPrevious = await exists(absoluteOutput);
    if (hadPrevious) await rename(absoluteOutput, previous);
    try { await rename(extracted, absoluteOutput); }
    catch (error) {
      if (hadPrevious) await rename(previous, absoluteOutput);
      throw error;
    }
    if (hadPrevious) await rm(previous, {recursive: true, force: true});
    return {output: absoluteOutput, manifest, sqlite_integrity: integrity};
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}
