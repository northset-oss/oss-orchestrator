#!/usr/bin/env node
import path from 'node:path';
import {decryptArtifact, encryptArtifact} from './encrypted-artifact.mjs';

const [command, ...args] = process.argv.slice(2);
const options = {};
while (args.length) {
  const name = args.shift();
  const value = args.shift();
  if (!name?.startsWith('--') || value === undefined || options[name]) throw new Error(`invalid argument ${name ?? ''}`);
  options[name] = value;
}
for (const name of ['--in', '--out', '--key']) if (!options[name]) throw new Error(`${command} requires ${name}`);
const subject = {input: path.resolve(options['--in']), output: path.resolve(options['--out']), keyFile: path.resolve(options['--key'])};
if (command === 'encrypt') {
  const result = await encryptArtifact(subject);
  process.stdout.write(`${result.input_sha256} ${result.encrypted_sha256} ${result.file}\n`);
} else if (command === 'decrypt') {
  const result = await decryptArtifact(subject);
  process.stdout.write(`${result.output_sha256} ${result.file}\n`);
} else {
  throw new Error('usage: encrypted-artifact-cli.mjs encrypt|decrypt --in <file> --out <file> --key <file>');
}
