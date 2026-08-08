import assert from 'node:assert/strict';
import test from 'node:test';
import { sign, verifySignature } from '../security.js';

test('rejects modified playback signatures', () => {
  const payload = 'session.expiry';
  const signature = sign(payload, 'secret');
  assert.equal(verifySignature(payload, signature, 'secret'), true);
  assert.equal(verifySignature(`${payload}.changed`, signature, 'secret'), false);
});
