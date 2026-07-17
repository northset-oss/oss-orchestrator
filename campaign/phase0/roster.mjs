import {createPublicKey} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {reviewerIdFromPublicKey} from './integrity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROSTER = path.join(HERE, 'roster', 'reviewers.json');

export async function loadReviewerRoster(file = DEFAULT_ROSTER) {
  const absolute = path.resolve(file);
  const document = JSON.parse(await readFile(absolute, 'utf8'));
  if (document?.schema_version !== 1 || !Array.isArray(document.reviewers)) {
    throw new Error('reviewer roster schema is invalid');
  }
  const keys = new Map();
  const capabilities = new Map();
  const pending = [];
  for (const reviewer of document.reviewers) {
    if (reviewer.key_status !== 'provisioned') {
      pending.push(reviewer.operator);
      continue;
    }
    const publicFile = path.resolve(path.dirname(absolute), reviewer.public_key_file);
    const publicKey = createPublicKey(await readFile(publicFile, 'utf8'));
    const actual = reviewerIdFromPublicKey(publicKey);
    if (actual !== reviewer.reviewer_id) throw new Error(`${reviewer.operator} roster identity does not match its public key`);
    if (keys.has(actual)) throw new Error(`duplicate reviewer identity in roster: ${actual}`);
    keys.set(actual, publicKey);
    if (!Array.isArray(reviewer.capabilities) || !reviewer.capabilities.every((item) => typeof item === 'string')) {
      throw new Error(`${reviewer.operator} roster capabilities are invalid`);
    }
    capabilities.set(actual, new Set(reviewer.capabilities));
  }
  return {document, keys, capabilities, pending};
}
