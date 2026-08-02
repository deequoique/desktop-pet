const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../node_modules/typescript');

function loadTypeScriptModule(file) {
  const source = fs.readFileSync(file, 'utf8').replace(
    /import type \{ RendererDiagnosticInput \} from '\.\/diagnostics';/,
    '',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const loaded = { exports: {} };
  Function('module', 'exports', output)(loaded, loaded.exports);
  return loaded.exports;
}

const modules = [
  ['pet', path.join(__dirname, '..', 'src', 'renderer', 'rtc-diagnostics.ts')],
  ['web', path.join(__dirname, '..', '..', 'web', 'src', 'rtc-diagnostics.ts')],
].map(([name, file]) => [name, loadTypeScriptModule(file)]);

function reportMap(timestamp, bytesReceived) {
  return new Map([
    ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
    ['local', {
      id: 'local', type: 'local-candidate', candidateType: 'prflx', protocol: 'udp',
      address: '175.24.197.99', port: 61977, relatedAddress: '10.0.0.9',
      relatedPort: 61977, relayProtocol: 'udp',
    }],
    ['remote', {
      id: 'remote', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp',
      address: '119.234.65.176', port: 21833,
    }],
    ['pair', {
      id: 'pair', type: 'candidate-pair', state: 'succeeded', nominated: true,
      localCandidateId: 'local', remoteCandidateId: 'remote',
      currentRoundTripTime: 0.724, availableOutgoingBitrate: 300_000,
    }],
    ['video', {
      id: 'video', type: 'inbound-rtp', kind: 'video', timestamp, bytesReceived,
      packetsReceived: 100, packetsLost: 2, framesPerSecond: 15,
      frameWidth: 1280, frameHeight: 720, jitter: 0.04,
    }],
  ]);
}

for (const [runtime, rtc] of modules) {
  test(`${runtime} treats NAT-reflexive TURN allocation as effective relay`, () => {
    assert.equal(rtc.isEffectiveRelayCandidate({
      candidateType: 'prflx',
      address: '175.24.197.99',
      relatedAddress: '10.0.0.9',
      relayProtocol: 'udp',
    }), true);
    assert.equal(rtc.isEffectiveRelayCandidate({
      candidateType: 'srflx',
      address: '119.234.65.176',
    }), false);
    assert.equal(rtc.isEffectiveRelayCandidate({
      candidateType: 'prflx',
      address: '175.24.197.99',
    }, {
      iceServers: [{ urls: 'turn:175.24.197.99:3478?transport=udp' }],
    }), true);
    assert.equal(rtc.isEffectiveRelayCandidate({
      candidateType: 'prflx',
      port: 61977,
      usernameFragment: 'same',
    }, undefined, [{
      candidateType: 'relay',
      address: '10.0.0.9',
      port: 61977,
      usernameFragment: 'same',
    }]), true);
  });

  test(`${runtime} compact network sample reports route, RTT, RTP rate, and bounded pairs`, async () => {
    let reports = reportMap(1000, 1000);
    const pc = {
      connectionState: 'connected',
      iceConnectionState: 'connected',
      getStats: async () => reports,
    };
    const baseline = new Map();
    const first = await rtc.collectRtcNetworkSample(pc, undefined, baseline);
    assert.equal(first.effectiveRelayed, true);
    assert.equal(first.roundTripTimeMs, 724);
    assert.equal(first.inboundVideo.bitrateKbps, undefined);

    reports = reportMap(3000, 251000);
    reports.get('video').packetsReceived = 198;
    reports.get('video').packetsLost = 4;
    const second = await rtc.collectRtcNetworkSample(pc, undefined, baseline);
    assert.equal(second.inboundVideo.bitrateKbps, 1000);
    assert.equal(second.inboundVideo.framesPerSecond, 15);
    assert.equal(second.lossRatio, 0.02);

    const snapshot = await rtc.collectRtcStats(pc);
    assert.equal(snapshot.pairCount, 1);
    assert.equal(snapshot.pairs.length, 0);
    assert.equal(snapshot.selectedPair.effectiveRelayed, true);
  });
}

test('candidate interface failures are warnings so they do not create incidents', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'rtc-diagnostics.ts'), 'utf8');
  assert.match(source, /event\.errorCode === 600 \|\| event\.errorCode === 701/);
  assert.match(source, /level: expectedInterfaceFailure \? 'warn' : 'error'/);
  assert.match(source, /\.slice\(0, 8\)/);
});
