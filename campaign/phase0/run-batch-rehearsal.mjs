#!/usr/bin/env node
import path from 'node:path';

import {writeBatchRehearsalReport} from './batch-rehearsal.mjs';

const args = process.argv.slice(2);
const index = args.indexOf('--out');
if (index < 0 || !args[index + 1] || args.length !== 2) {
  process.stderr.write('usage: run-batch-rehearsal.mjs --out <report.json>\n');
  process.exitCode = 1;
} else {
  const result = await writeBatchRehearsalReport(path.resolve(args[index + 1]));
  process.stdout.write(`${result.sha256}  ${result.file}\n`);
}
