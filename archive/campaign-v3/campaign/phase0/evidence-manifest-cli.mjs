#!/usr/bin/env node
import {createPrivateKey, createPublicKey} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {createEvidenceManifest, verifyEvidenceManifest} from './evidence-manifest.mjs';

const [command, ...args] = process.argv.slice(2);
const options = new Map();
const evidence = [];
while (args.length) {
  const name = args.shift();
  const value = args.shift();
  if (!name?.startsWith('--') || value === undefined) throw new Error(`invalid argument ${name ?? ''}`);
  if (name === '--evidence') {
    const separator = value.indexOf('=');
    if (separator < 1 || separator === value.length - 1) throw new Error('--evidence must be kind=/absolute/file');
    evidence.push({kind: value.slice(0, separator), file: path.resolve(value.slice(separator + 1))});
  } else {
    if (options.has(name)) throw new Error(`duplicate argument ${name}`);
    options.set(name, value);
  }
}

if (command === 'create') {
  for (const name of ['--private', '--seal-commit', '--out']) if (!options.has(name)) throw new Error(`create requires ${name}`);
  const privateKey = createPrivateKey(await readFile(path.resolve(options.get('--private')), 'utf8'));
  const record = await createEvidenceManifest({files: evidence, privateKey, sealCommit: options.get('--seal-commit')});
  const output = path.resolve(options.get('--out'));
  await mkdir(path.dirname(output), {recursive: true, mode: 0o700});
  await writeFile(output, `${JSON.stringify(record, null, 2)}\n`, {mode: 0o600});
  process.stdout.write(`${record.reviewer_id} ${output}\n`);
} else if (command === 'verify') {
  for (const name of ['--public', '--record']) if (!options.has(name)) throw new Error(`verify requires ${name}`);
  const [publicPem, record] = await Promise.all([
    readFile(path.resolve(options.get('--public')), 'utf8'),
    readFile(path.resolve(options.get('--record')), 'utf8').then(JSON.parse),
  ]);
  await verifyEvidenceManifest(record, createPublicKey(publicPem), {rehash: true});
  process.stdout.write(`${record.reviewer_id} verified\n`);
} else {
  throw new Error('usage: evidence-manifest-cli.mjs create|verify [options]');
}
