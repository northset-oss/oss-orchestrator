import {createReadStream, createWriteStream} from 'node:fs';
import {appendFile, mkdir, open, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';

const MAGIC = 'NORTHSET-PHASE0-ARTIFACT-V1\n';
const TAG_BYTES = 16;

async function readKey(file) {
  const key = Buffer.from((await readFile(file, 'utf8')).trim(), 'base64');
  if (key.length !== 32) throw new Error('artifact key must decode to exactly 32 bytes');
  return key;
}

async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

export async function encryptArtifact({input, output, keyFile} = {}) {
  const source = path.resolve(input);
  const destination = path.resolve(output);
  const key = await readKey(path.resolve(keyFile));
  const iv = randomBytes(12);
  const header = Buffer.from(`${MAGIC}${JSON.stringify({algorithm: 'aes-256-gcm', iv: iv.toString('base64')})}\n`, 'utf8');
  await mkdir(path.dirname(destination), {recursive: true, mode: 0o700});
  await writeFile(destination, header, {mode: 0o600});
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  await pipeline(createReadStream(source), cipher, createWriteStream(destination, {flags: 'a', mode: 0o600}));
  await appendFile(destination, cipher.getAuthTag());
  return {
    file: destination,
    input_sha256: await fileSha256(source),
    encrypted_sha256: await fileSha256(destination),
  };
}

async function readHeader(file) {
  const handle = await open(file, 'r');
  try {
    const probe = Buffer.alloc(4096);
    const {bytesRead} = await handle.read(probe, 0, probe.length, 0);
    const bytes = probe.subarray(0, bytesRead);
    const magic = Buffer.from(MAGIC, 'utf8');
    if (!bytes.subarray(0, magic.length).equals(magic)) throw new Error('encrypted artifact format is invalid');
    const end = bytes.indexOf(0x0a, magic.length);
    if (end < 0) throw new Error('encrypted artifact header is invalid');
    return {header: JSON.parse(bytes.subarray(magic.length, end).toString('utf8')), ciphertextStart: end + 1};
  } finally { await handle.close(); }
}

export async function decryptArtifact({input, output, keyFile} = {}) {
  const source = path.resolve(input);
  const destination = path.resolve(output);
  const key = await readKey(path.resolve(keyFile));
  const {header, ciphertextStart} = await readHeader(source);
  if (header.algorithm !== 'aes-256-gcm') throw new Error('encrypted artifact algorithm is unsupported');
  const info = await stat(source);
  if (info.size < ciphertextStart + TAG_BYTES) throw new Error('encrypted artifact is truncated');
  const handle = await open(source, 'r');
  const tag = Buffer.alloc(TAG_BYTES);
  try { await handle.read(tag, 0, TAG_BYTES, info.size - TAG_BYTES); }
  finally { await handle.close(); }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  decipher.setAuthTag(tag);
  await mkdir(path.dirname(destination), {recursive: true, mode: 0o700});
  try {
    await pipeline(
      createReadStream(source, {start: ciphertextStart, end: info.size - TAG_BYTES - 1}),
      decipher,
      createWriteStream(destination, {mode: 0o600}),
    );
  } catch (error) {
    await rm(destination, {force: true});
    throw new Error(`cannot authenticate or decrypt artifact: ${error.message}`);
  }
  return {file: destination, output_sha256: await fileSha256(destination)};
}
