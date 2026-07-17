import {createPrivateKey, createPublicKey, generateKeyPairSync} from 'node:crypto';
import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {reviewerIdFromPublicKey} from './integrity.mjs';

async function readExisting(privateFile, publicFile) {
  try {
    const [privatePem, publicPem] = await Promise.all([readFile(privateFile, 'utf8'), readFile(publicFile, 'utf8')]);
    const privateKey = createPrivateKey(privatePem);
    const derived = createPublicKey(privateKey).export({type: 'spki', format: 'pem'});
    if (Buffer.compare(Buffer.from(derived), Buffer.from(publicPem)) !== 0) {
      throw new Error('existing reviewer public key does not match its private key');
    }
    await chmod(privateFile, 0o600);
    return {reviewer_id: reviewerIdFromPublicKey(publicPem), private_file: privateFile, public_file: publicFile};
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function provisionReviewerKey({
  privateFile,
  publicFile,
  expectedOsUser,
  currentOsUser = os.userInfo().username,
}) {
  if (typeof expectedOsUser !== 'string' || !expectedOsUser || currentOsUser !== expectedOsUser) {
    throw new Error(`reviewer key must be provisioned from OS user ${expectedOsUser}`);
  }
  if (!path.isAbsolute(privateFile) || !path.isAbsolute(publicFile)) throw new Error('reviewer key paths must be absolute');
  const existing = await readExisting(privateFile, publicFile);
  if (existing) return existing;
  await Promise.all([
    mkdir(path.dirname(privateFile), {recursive: true, mode: 0o700}),
    mkdir(path.dirname(publicFile), {recursive: true, mode: 0o755}),
  ]);
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({type: 'pkcs8', format: 'pem'});
  const publicPem = publicKey.export({type: 'spki', format: 'pem'});
  await writeFile(privateFile, privatePem, {mode: 0o600, flag: 'wx'});
  await writeFile(publicFile, publicPem, {mode: 0o644, flag: 'wx'});
  return {reviewer_id: reviewerIdFromPublicKey(publicKey), private_file: privateFile, public_file: publicFile};
}
