import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerDiagnostics, normalizeHttpRoute } from '../src/diagnostics.js';

test('server diagnostics emit correlated JSON and redact credentials and WebRTC payloads', () => {
  const lines = [];
  const output = {
    log: (line) => lines.push(line),
    warn: (line) => lines.push(line),
    error: (line) => lines.push(line),
  };
  createServerDiagnostics({ runtimeSessionId: 'session-1', output }).info('webrtc', 'webrtc.test', {
    correlation: { callId: 'call-1' },
    context: {
      targetDeviceId: 'private-device-id',
      candidate: 'candidate:1 1 udp 1 192.0.2.1 1234 typ host',
      sdp: 'v=0',
      credential: 'turn-password',
      candidateType: 'host',
    },
  });
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.runtimeSessionId, 'session-1');
  assert.equal(entry.correlation.callId, 'call-1');
  assert.equal(entry.context.candidate, '[redacted]');
  assert.equal(entry.context.sdp, '[redacted]');
  assert.equal(entry.context.credential, '[redacted]');
  assert.equal(entry.context.candidateType, 'host');
  assert.match(entry.context.targetDeviceId, /^sha256:[0-9a-f]{16}$/);
});

test('HTTP route normalization removes unstable identifiers', () => {
  assert.equal(normalizeHttpRoute({ path: '/api/items/123' }), '/api/items/:id');
  assert.equal(
    normalizeHttpRoute({ path: '/api/jobs/123e4567-e89b-12d3-a456-426614174000' }),
    '/api/jobs/:id',
  );
});
