import { createHmac } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

function urlSafeBase64(value) {
  return value.replace(/\+/g, '*').replace(/\//g, '-').replace(/=/g, '_');
}

function standardBase64(value) {
  return value.replace(/\*/g, '+').replace(/-/g, '/').replace(/_/g, '=');
}

export function trtcSignaturePayload({ sdkAppId, userId, expiresInSeconds, issuedAt }) {
  return [
    `TLS.identifier:${userId}`,
    `TLS.sdkappid:${sdkAppId}`,
    `TLS.time:${issuedAt}`,
    `TLS.expire:${expiresInSeconds}`,
    '',
  ].join('\n');
}

export function generateTrtcUserSig({ sdkAppId, secretKey, userId, expiresInSeconds = 900, issuedAt = Math.floor(Date.now() / 1000) }) {
  if (!Number.isSafeInteger(sdkAppId) || sdkAppId <= 0) throw new Error('invalid TRTC sdkAppId');
  if (!secretKey) throw new Error('missing TRTC secretKey');
  if (!userId || Buffer.byteLength(userId, 'utf8') > 32) throw new Error('invalid TRTC userId');
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 604_800) {
    throw new Error('invalid TRTC UserSig expiry');
  }
  const document = {
    'TLS.ver': '2.0',
    'TLS.identifier': userId,
    'TLS.sdkappid': sdkAppId,
    'TLS.expire': expiresInSeconds,
    'TLS.time': issuedAt,
  };
  document['TLS.sig'] = createHmac('sha256', secretKey)
    .update(trtcSignaturePayload({ sdkAppId, userId, expiresInSeconds, issuedAt }))
    .digest('base64');
  return urlSafeBase64(deflateSync(Buffer.from(JSON.stringify(document))).toString('base64'));
}

export function decodeTrtcUserSig(userSig) {
  return JSON.parse(inflateSync(Buffer.from(standardBase64(userSig), 'base64')).toString('utf8'));
}
