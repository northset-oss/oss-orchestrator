#!/usr/bin/env node
import {createPublicKey, createPrivateKey} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {provisionReviewerKey} from './keys.mjs';
import {loadProtocol, protocolFreezeRecord, verifyProtocolFreeze} from './protocol.mjs';
import {
  bindReviewSet, createBatchApproval, createReviewRecord, finalizeReviewedBoard, verifyBatchApproval,
  verifyReviewedBoard,
} from './approvals.mjs';
import {loadReviewerRoster} from './roster.mjs';

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined || result[flag] !== undefined) {
      throw new Error(`invalid or duplicate argument ${flag ?? ''}`.trim());
    }
    result[flag] = value;
  }
  return result;
}

function requireOptions(value, names) {
  for (const name of names) if (!value[name]) throw new Error(`missing ${name}`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const value = options(args);
  if (command === 'keygen') {
    requireOptions(value, ['--expected-os-user', '--private', '--public']);
    const result = await provisionReviewerKey({
      expectedOsUser: value['--expected-os-user'],
      currentOsUser: os.userInfo().username,
      privateFile: path.resolve(value['--private']),
      publicFile: path.resolve(value['--public']),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'sign-protocol') {
    requireOptions(value, ['--private', '--out']);
    const [protocol, privatePem] = await Promise.all([
      loadProtocol(value['--protocol'] ? path.resolve(value['--protocol']) : undefined),
      readFile(path.resolve(value['--private']), 'utf8'),
    ]);
    const record = protocolFreezeRecord(protocol, createPrivateKey(privatePem));
    const output = path.resolve(value['--out']);
    await mkdir(path.dirname(output), {recursive: true, mode: 0o700});
    await writeFile(output, `${JSON.stringify(record, null, 2)}\n`, {mode: 0o600});
    process.stdout.write(`${record.protocol_sha256} ${record.reviewer_id}\n`);
    return;
  }
  if (command === 'verify-protocol') {
    requireOptions(value, ['--public', '--record']);
    const [protocol, publicPem, record] = await Promise.all([
      loadProtocol(value['--protocol'] ? path.resolve(value['--protocol']) : undefined),
      readFile(path.resolve(value['--public']), 'utf8'),
      readFile(path.resolve(value['--record']), 'utf8').then(JSON.parse),
    ]);
    const publicKey = createPublicKey(publicPem);
    verifyProtocolFreeze(protocol, record, new Map([[record.reviewer_id, publicKey]]));
    process.stdout.write(`${record.protocol_sha256} verified\n`);
    return;
  }
  if (command === 'sign-review') {
    requireOptions(value, ['--private', '--manifest', '--record', '--disposition', '--risk-tier']);
    const [privatePem, manifest] = await Promise.all([
      readFile(path.resolve(value['--private']), 'utf8'),
      readFile(path.resolve(value['--manifest']), 'utf8').then(JSON.parse),
    ]);
    const record = createReviewRecord(manifest, {
      privateKey: createPrivateKey(privatePem),
      disposition: value['--disposition'],
      riskTier: value['--risk-tier'],
      reviewedAt: value['--reviewed-at'] ?? new Date().toISOString(),
    });
    const recordFile = path.resolve(value['--record']);
    let records = [];
    try {
      const existing = JSON.parse(await readFile(recordFile, 'utf8'));
      records = Array.isArray(existing) ? existing : [existing];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    records = records.filter((item) => item.reviewer_id !== record.reviewer_id);
    records.push(record);
    const bound = bindReviewSet(manifest, records);
    await mkdir(path.dirname(recordFile), {recursive: true, mode: 0o700});
    await writeFile(recordFile, `${JSON.stringify(records, null, 2)}\n`, {mode: 0o600});
    await writeFile(path.resolve(value['--manifest']), `${JSON.stringify(bound, null, 2)}\n`, {mode: 0o600});
    process.stdout.write(`${record.reviewer_id} ${bound.review_record_sha256}\n`);
    return;
  }
  if (command === 'finalize-reviewed-board') {
    requireOptions(value, ['--board', '--runs', '--out']);
    const board = JSON.parse(await readFile(path.resolve(value['--board']), 'utf8'));
    if (!Array.isArray(board.ordered_mission_ids) || !board.ordered_mission_ids.length) throw new Error('batch board has no ordered_mission_ids');
    const manifests = await Promise.all(board.ordered_mission_ids.map((id) =>
      readFile(path.join(path.resolve(value['--runs']), id, 'ready-pack', 'manifest.json'), 'utf8').then(JSON.parse)));
    const reviewed = finalizeReviewedBoard(board, manifests);
    const output = path.resolve(value['--out']);
    await mkdir(path.dirname(output), {recursive: true, mode: 0o700});
    await writeFile(output, `${JSON.stringify(reviewed, null, 2)}\n`, {mode: 0o600});
    process.stdout.write(`${reviewed.batch_digest} ${output}\n`);
    return;
  }
  if (command === 'sign-batch-approval' || command === 'verify-batch-approval') {
    requireOptions(value, ['--board', '--runs', '--record']);
    const board = JSON.parse(await readFile(path.resolve(value['--board']), 'utf8'));
    if (!Array.isArray(board.ordered_mission_ids) || !board.ordered_mission_ids.length) {
      throw new Error('batch board has no ordered_mission_ids');
    }
    const manifests = await Promise.all(board.ordered_mission_ids.map((id) =>
      readFile(path.join(path.resolve(value['--runs']), id, 'ready-pack', 'manifest.json'), 'utf8').then(JSON.parse)));
    verifyReviewedBoard(board, manifests);
    if (command === 'sign-batch-approval') {
      requireOptions(value, ['--private']);
      const privatePem = await readFile(path.resolve(value['--private']), 'utf8');
      const record = createBatchApproval(manifests, {
        privateKey: createPrivateKey(privatePem),
        approvedDigest: board.batch_digest,
        approvedAt: value['--approved-at'] ?? new Date().toISOString(),
      });
      const output = path.resolve(value['--record']);
      await mkdir(path.dirname(output), {recursive: true, mode: 0o700});
      await writeFile(output, `${JSON.stringify(record, null, 2)}\n`, {mode: 0o600});
      process.stdout.write(`${record.reviewer_id} ${record.approved_manifest_digest}\n`);
    } else {
      requireOptions(value, ['--roster']);
      const [record, roster] = await Promise.all([
        readFile(path.resolve(value['--record']), 'utf8').then(JSON.parse),
        loadReviewerRoster(path.resolve(value['--roster'])),
      ]);
      const authorizedApprovers = new Set([...roster.capabilities.entries()]
        .filter(([, capabilities]) => capabilities.has('batch_approve')).map(([reviewerId]) => reviewerId));
      verifyBatchApproval(record, manifests, board.batch_digest, roster.keys, {authorizedApprovers});
      process.stdout.write(`${record.reviewer_id} ${record.approved_manifest_digest} verified\n`);
    }
    return;
  }
  throw new Error('usage: phase0-cli.mjs keygen|sign-protocol|verify-protocol|sign-review|finalize-reviewed-board|sign-batch-approval|verify-batch-approval [options]');
}

main().catch((error) => {
  process.stderr.write(`phase0: ${error.message}\n`);
  process.exitCode = 1;
});
