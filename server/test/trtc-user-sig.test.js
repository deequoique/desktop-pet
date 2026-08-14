import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { decodeTrtcUserSig, generateTrtcUserSig, trtcSignaturePayload } from '../src/trtc-user-sig.js';

test('generates a decodable TRTC UserSig without embedding the secret', () => {
  const input = {
    sdkAppId: 1600157176,
    secretKey: 'server-only-secret',
    userId: 'c_0123456789abcdef',
    expiresInSeconds: 900,
    issuedAt: 1_786_665_600,
  };
  const userSig = generateTrtcUserSig(input);
  assert.doesNotMatch(userSig, /server-only-secret/);
  const decoded = decodeTrtcUserSig(userSig);
  assert.deepEqual({
    version: decoded['TLS.ver'],
    userId: decoded['TLS.identifier'],
    sdkAppId: decoded['TLS.sdkappid'],
    expires: decoded['TLS.expire'],
    time: decoded['TLS.time'],
  }, {
    version: '2.0',
    userId: input.userId,
    sdkAppId: input.sdkAppId,
    expires: input.expiresInSeconds,
    time: input.issuedAt,
  });
  assert.equal(decoded['TLS.sig'], createHmac('sha256', input.secretKey)
    .update(trtcSignaturePayload(input))
    .digest('base64'));
});

test('rejects unsafe TRTC UserSig inputs', () => {
  assert.throws(() => generateTrtcUserSig({ sdkAppId: 0, secretKey: 'x', userId: 'u' }), /sdkAppId/);
  assert.throws(() => generateTrtcUserSig({ sdkAppId: 1, secretKey: '', userId: 'u' }), /secretKey/);
  assert.throws(() => generateTrtcUserSig({ sdkAppId: 1, secretKey: 'x', userId: 'x'.repeat(33) }), /userId/);
});
