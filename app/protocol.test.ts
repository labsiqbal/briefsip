import test from 'node:test';
import assert from 'node:assert/strict';
import { closedObject, digestCommand, normalizeEmail, parseJson, ProtocolError, requestMetadata } from './shared/protocol.ts';

test('protocol parser rejects duplicate and unknown fields, canonicalizes command digest', () => {
  assert.deepEqual(parseJson('{"a":1,"b":[true,null]}'), { a: 1, b: [true, null] });
  assert.throws(() => parseJson('{"a":1,"a":2}'), (error: unknown) => error instanceof ProtocolError && error.code === 'duplicate_key');
  assert.throws(() => closedObject({ requestId: 'x', extra: true }, ['requestId']), /unknown/);
  assert.equal(digestCommand({ b: 2, a: 1 }), digestCommand({ a: 1, b: 2 }));
  assert.throws(() => parseJson(' '.repeat(64 * 1024 + 1)), /JSON payload/);
});

test('protocol identity and mailbox normalization stay closed', () => {
  assert.equal(normalizeEmail(' User@Example.COM '), 'user@example.com');
  assert.equal(normalizeEmail('a@bücher.example'), 'a@xn--bcher-kva.example');
  for (const email of ['a..b@example.com', 'a@example..com', 'a@example.com\n']) assert.throws(() => normalizeEmail(email));
  assert.throws(() => requestMetadata(new Headers({ 'X-Minarbot-Protocol': '2', 'X-Minarbot-Request-Id': 'bad', 'Content-Type': 'application/json' })), /protocol version/);
});
