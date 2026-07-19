#!/usr/bin/env node

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {run} from '../core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const tag = process.env.OSS_AUTHOR_IMAGE ?? 'northset-oss-author:0.144.1';
const built = await run('docker', ['build', '--pull', '--tag', tag, '--file',
  path.join(root, 'author-image', 'Dockerfile'), path.join(root, 'author-image')], {
  timeoutMs: 15 * 60 * 1000,
});
if (built.code !== 0) {
  console.error((built.stderr || built.stdout).trim());
  process.exit(1);
}
const inspected = await run('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], {timeoutMs: 30_000});
if (inspected.code !== 0 || !/^sha256:[0-9a-f]{64}$/i.test(inspected.stdout.trim())) {
  console.error(`cannot resolve immutable image id for ${tag}`);
  process.exit(1);
}
console.log(`${tag} -> ${inspected.stdout.trim()}`);
