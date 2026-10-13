import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { verifyNevoaSignature } from './hmac.js';

test('rejeita webhook sem secret', () => {
  assert.equal(verifyNevoaSignature('{}', '', '', String(Date.now() / 1000)), false);
});

test('aceita assinatura válida dentro da janela', () => {
  const body = '{"event":"message.received"}';
  const secret = 'test-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature =
    'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  assert.equal(verifyNevoaSignature(body, secret, signature, timestamp), true);
});

test('rejeita assinatura antiga', () => {
  const body = '{}';
  const secret = 'test-secret';
  const timestamp = String(Math.floor(Date.now() / 1000) - 301);
  const signature =
    'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  assert.equal(verifyNevoaSignature(body, secret, signature, timestamp), false);
});
