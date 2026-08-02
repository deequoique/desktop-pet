const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  acknowledgeIncidents,
  appendDiagnostic,
  beginDiagnosticSession,
  completeDiagnosticSession,
  clampBoundsToWorkArea,
  clampScale,
  createDiagnosticEntry,
  readCrashArtifactMetadata,
  readDiagnosticLogs,
  readIncidents,
  recordIncident,
  redactDiagnosticValue,
  redactString,
  validateRendererDiagnosticInput,
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
      { x: 1900, y: 1000, width: 180, height: 240 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    ),
    { x: 1740, y: 840, width: 180, height: 240 },
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

test('structured entries include severity, source, session, and correlation', () => {
  const entry = createDiagnosticEntry({
    event: 'webrtc.state',
    domain: 'webrtc',
    level: 'warn',
    errorCode: 'webrtc_ice_disconnected',
    recoverability: 'automatic',
    correlation: { callId: 'call-1' },
    context: { state: 'disconnected' },
  }, {}, {
    source: 'pet-renderer',
    appVersion: '1.6.0',
    runtimeSessionId: 'session-1',
  });
  assert.equal(entry.level, 'warn');
  assert.equal(entry.domain, 'webrtc');
  assert.equal(entry.source, 'pet-renderer');
  assert.equal(entry.appVersion, '1.6.0');
  assert.equal(entry.runtimeSessionId, 'session-1');
  assert.equal(entry.correlation.callId, 'call-1');
});

test('stable device identifiers are hashed in shareable diagnostics', () => {
  const entry = createDiagnosticEntry({
    event: 'socket.joined',
    domain: 'socket',
    correlation: { deviceId: 'device-private-id', callId: 'call-public-id' },
    context: { targetDeviceId: 'target-private-id' },
  });
  assert.match(entry.correlation.deviceId, /^sha256:[0-9a-f]{16}$/);
  assert.equal(entry.correlation.callId, 'call-public-id');
  assert.match(entry.context.targetDeviceId, /^sha256:[0-9a-f]{16}$/);
});

test('renderer diagnostics enforce event namespace and payload limit', () => {
  assert.deepEqual(validateRendererDiagnosticInput({ event: 'not-allowed', domain: 'app' }), {
    ok: false,
    error: 'invalid_event',
  });
  assert.equal(validateRendererDiagnosticInput({
    event: 'webrtc.candidate',
    domain: 'webrtc',
    context: {
      candidate: {
        candidateType: 'srflx',
        address: '203.0.113.10',
        port: 54000,
        relatedAddress: '192.168.1.20',
      },
    },
  }).ok, true);
  assert.equal(validateRendererDiagnosticInput({
    event: 'app.renderer-error',
    domain: 'app',
    context: { huge: 'x'.repeat(40 * 1024) },
  }).error, 'payload_too_large');
});

test('raw SDP and ICE candidate strings are omitted while structured network metadata remains', () => {
  const entry = createDiagnosticEntry({
    event: 'webrtc.candidate',
    domain: 'webrtc',
    context: {
      sdp: 'v=0 secret description',
      candidate: 'candidate:1 1 udp 1 203.0.113.10 5000 typ srflx',
      parsedCandidate: {
        address: '203.0.113.10',
        port: 5000,
        candidateType: 'srflx',
      },
    },
  });
  assert.equal(entry.context.sdp, '[REDACTED]');
  assert.equal(entry.context.candidate, '[RAW_ICE_CANDIDATE_OMITTED]');
  assert.equal(entry.context.parsedCandidate.address, '203.0.113.10');
});

test('incidents merge duplicates, retain breadcrumbs, and can be acknowledged', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-pet-incidents-'));
  const incidentFile = path.join(directory, 'incidents.json');
  try {
    const entry = createDiagnosticEntry({
      event: 'app.renderer-error',
      domain: 'app',
      level: 'fatal',
      errorCode: 'app_renderer_crashed',
      exception: { message: 'boom', stack: 'Error: boom\n at app.js:1' },
    }, {}, { source: 'control-renderer', runtimeSessionId: 'session-1' });
    const first = recordIncident(incidentFile, entry, [{ event: 'app.started' }], { platform: 'test' });
    const second = recordIncident(incidentFile, entry, [{ event: 'app.started' }, { event: 'socket.connected' }], { platform: 'test' });
    assert.equal(first.id, second.id);
    assert.equal(readIncidents(incidentFile)[0].count, 2);
    assert.equal(readIncidents(incidentFile)[0].breadcrumbs.length, 2);
    assert.equal(acknowledgeIncidents(incidentFile, first.id, 'dismissed'), true);
    assert.equal(readIncidents(incidentFile)[0].status, 'dismissed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('session markers distinguish abnormal and clean previous exits', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-pet-session-'));
  const sessionFile = path.join(directory, 'runtime-session.json');
  try {
    assert.equal(beginDiagnosticSession(sessionFile, { runtimeSessionId: 'one', appVersion: '1' }), null);
    assert.equal(beginDiagnosticSession(sessionFile, { runtimeSessionId: 'two', appVersion: '1' }).runtimeSessionId, 'one');
    assert.equal(completeDiagnosticSession(sessionFile, 'two'), true);
    assert.equal(beginDiagnosticSession(sessionFile, { runtimeSessionId: 'three', appVersion: '1' }), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('crash artifact metadata is bounded and does not include file contents', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-pet-crash-'));
  try {
    for (let index = 0; index < 7; index += 1) {
      fs.writeFileSync(path.join(directory, `${index}.dmp`), `dump-${index}`);
    }
    const artifacts = readCrashArtifactMetadata(directory);
    assert.equal(artifacts.length, 5);
    assert.equal(Object.hasOwn(artifacts[0], 'content'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('opening the control panel refreshes persistent diagnostic incidents', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '../src/main/control-preload.js'), 'utf8');
  const controlSource = fs.readFileSync(path.join(__dirname, '../../web/src/App.tsx'), 'utf8');
  assert.match(mainSource, /webContents\.send\('diagnostics:refresh'\)/);
  assert.match(preloadSource, /onDiagnosticRefresh/);
  assert.match(controlSource, /onDiagnosticRefresh\(\(\) =>/);
});
