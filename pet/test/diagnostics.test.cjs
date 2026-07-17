const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  appendDiagnostic,
  clampBoundsToWorkArea,
  clampScale,
  readDiagnosticLogs,
  redactDiagnosticValue,
  redactString,
} = require('../src/main/diagnostics');

test('clampScale accepts finite values and rejects invalid input', () => {
  assert.equal(clampScale(0.1), 0.3);
  assert.equal(clampScale(0.8), 0.8);
  assert.equal(clampScale(2), 1.5);
  assert.equal(clampScale('not-a-number'), 1);
});

test('clampBoundsToWorkArea keeps a window visible', () => {
  assert.deepEqual(
    clampBoundsToWorkArea(
      { x: 1900, y: 1000, width: 360, height: 480 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    ),
    { x: 1560, y: 600, width: 360, height: 480 },
  );
});

test('diagnostic redaction removes secrets, credentials, and binary audio', () => {
  const source = {
    roomSecret: 'room-secret-value',
    nested: {
      apiKey: 'sk-1234567890abcdef',
      authorization: 'Bearer abc.def.ghi',
      safe: 'scale=1',
      audioData: Buffer.from('private audio'),
    },
  };
  const redacted = redactDiagnosticValue(source);
  assert.equal(redacted.roomSecret, '[REDACTED]');
  assert.equal(redacted.nested.apiKey, '[REDACTED]');
  assert.equal(redacted.nested.authorization, '[REDACTED]');
  assert.equal(redacted.nested.audioData, '[REDACTED]');
  assert.equal(redacted.nested.safe, 'scale=1');
  assert.doesNotMatch(JSON.stringify(redacted), /room-secret-value|1234567890abcdef|private audio/);
});

test('diagnostic string redaction handles embedded credentials', () => {
  const redacted = redactString('authorization=Bearer-token apiKey=sk-1234567890abcdef Bearer abc.def');
  assert.doesNotMatch(redacted, /1234567890abcdef|abc\.def/);
});

test('persisted diagnostic logs remain redacted when exported', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-pet-diagnostics-'));
  const logFile = path.join(directory, 'diagnostic.jsonl');
  try {
    assert.equal(appendDiagnostic(logFile, 'test', {
      roomSecret: 'private-room',
      apiKey: 'sk-1234567890abcdef',
      audioData: Buffer.from('private audio'),
      scale: 1,
    }), true);
    const exported = JSON.stringify(readDiagnosticLogs(logFile));
    assert.doesNotMatch(exported, /private-room|1234567890abcdef|private audio/);
    assert.match(exported, /REDACTED/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
