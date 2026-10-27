import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { signPayload, verifyPayload } from './plugin-release.mjs';

// Public test key only, never a production trust anchor.
const privateKey = createPrivateKey({
  key: Buffer.from('302e020100300506032b657004220420' + '07'.repeat(32), 'hex'),
  format: 'der',
  type: 'pkcs8',
}).export({ format: 'pem', type: 'pkcs8' });
const publicKey = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' });
test('signatures bind exact payload bytes, domain and key ID', () => {
  const payload = Buffer.from('{ "sequence": 1 }\n');
  const envelope = signPayload('feed', payload, privateKey, 'test-key');
  assert.deepEqual(verifyPayload('feed', envelope, publicKey, 'test-key'), { sequence: 1 });
  assert.throws(() => verifyPayload('release', envelope, publicKey, 'test-key'));
  assert.throws(() => verifyPayload('feed', envelope, publicKey, 'wrong-key'));
  assert.throws(() =>
    verifyPayload(
      'feed',
      { ...envelope, payload: Buffer.from('{"sequence":1}').toString('base64') },
      publicKey,
      'test-key',
    ),
  );
});
test('Node reproduces the Rust shared signature vector', async () => {
  const vector = JSON.parse(
    await readFile(
      new URL('../crates/yaqmc-core/tests/fixtures/plugin-release-vector.json', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(
    signPayload('feed', Buffer.from(vector.envelope.payload, 'base64'), privateKey, 'test-key'),
    vector.envelope,
  );
  const feed = verifyPayload('feed', vector.envelope, publicKey, 'test-key');
  assert.equal(
    verifyPayload('release', feed.releases[0], publicKey, 'test-key').pluginId,
    vector.source.pluginId,
  );
});
