#!/usr/bin/env node
import path from 'node:path';

import {
  createBackupKey, createEncryptedOperationalBackup, restoreEncryptedOperationalBackup,
} from './backup.mjs';

function parse(args) {
  const options = {};
  while (args.length) {
    const name = args.shift();
    const value = args.shift();
    if (!name?.startsWith('--') || value === undefined || options[name] !== undefined) throw new Error(`invalid argument ${name ?? ''}`);
    options[name] = value;
  }
  return options;
}

const [command, ...args] = process.argv.slice(2);
const options = parse(args);
if (command === 'keygen') {
  if (!options['--key']) throw new Error('keygen requires --key');
  process.stdout.write(`${await createBackupKey(path.resolve(options['--key']))}\n`);
} else if (command === 'create') {
  for (const name of ['--repo', '--out', '--key']) if (!options[name]) throw new Error(`create requires ${name}`);
  const result = await createEncryptedOperationalBackup({
    repo: path.resolve(options['--repo']), output: path.resolve(options['--out']), keyFile: path.resolve(options['--key']),
  });
  process.stdout.write(`${result.sha256}  ${result.file}\n`);
} else if (command === 'restore') {
  for (const name of ['--backup', '--out', '--key', '--expected-sha256', '--expected-created-at']) if (!options[name]) throw new Error(`restore requires ${name}`);
  const result = await restoreEncryptedOperationalBackup({
    backup: path.resolve(options['--backup']), output: path.resolve(options['--out']), keyFile: path.resolve(options['--key']),
    expectedSha256: options['--expected-sha256'], expectedCreatedAt: options['--expected-created-at'],
  });
  process.stdout.write(`${result.sqlite_integrity}  ${result.output}\n`);
} else {
  throw new Error('usage: backup-cli.mjs keygen|create|restore [options]');
}
