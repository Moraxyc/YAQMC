#!/usr/bin/env node
// Publisher tool: signs the original UTF-8 payload bytes, never reserialized JSON.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const domains = {
  feed: Buffer.from('YAQMC-PLUGIN-FEED-v1\0'),
  release: Buffer.from('YAQMC-PLUGIN-RELEASE-v1\0'),
};
export function signPayload(kind, payload, privateKey, keyId) {
  if (!domains[kind] || !keyId) throw new Error('Expected feed/release and a key ID');
  JSON.parse(payload.toString('utf8'));
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 private key');
  return {
    keyId,
    payload: payload.toString('base64'),
    signature: sign(null, Buffer.concat([domains[kind], payload]), key).toString('base64'),
  };
}
export function verifyPayload(kind, envelope, publicKey, keyId) {
  if (!domains[kind] || envelope.keyId !== keyId) throw new Error('Unknown domain or key ID');
  const payload = Buffer.from(envelope.payload, 'base64');
  const key = createPublicKey(publicKey);
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(
      null,
      Buffer.concat([domains[kind], payload]),
      key,
      Buffer.from(envelope.signature, 'base64'),
    )
  )
    throw new Error('Signature verification failed');
  return JSON.parse(payload.toString('utf8'));
}
export async function main(args) {
  const [command, kind, input, keyPath, keyId, output] = args;
  if (command === 'public-key') {
    const publicKey = createPublicKey(await readFile(kind));
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 key');
    process.stdout.write(
      `${publicKey.export({ format: 'jwk' }).x.replaceAll('-', '+').replaceAll('_', '/')}=\n`,
    );
  } else if (command === 'hash') {
    const size = (await stat(kind)).size;
    const sha256 = createHash('sha256')
      .update(await readFile(kind))
      .digest('hex');
    process.stdout.write(`${JSON.stringify({ size, sha256 }, null, 2)}\n`);
  } else if (command === 'sign' && output) {
    const envelope = signPayload(kind, await readFile(input), await readFile(keyPath), keyId);
    await writeFile(output, `${JSON.stringify(envelope)}\n`, { flag: 'wx' });
  } else if (command === 'verify') {
    const payload = verifyPayload(
      kind,
      JSON.parse(await readFile(input, 'utf8')),
      await readFile(keyPath),
      keyId,
    );
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else
    throw new Error(
      'Usage: plugin-release.mjs sign <feed|release> <payload.json> <private.pem> <keyId> <new-envelope.json> | verify <feed|release> <envelope.json> <public.pem> <keyId> | public-key <key.pem> | hash <package>',
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
