const assert = require('node:assert/strict');
const test = require('node:test');
const { createTrtcPreloadBridge } = require('../src/main/trtc-preload-bridge');

class FakeCloud {
  static shared = null;
  static destroyed = 0;

  static getTRTCShareInstance() {
    if (!FakeCloud.shared) FakeCloud.shared = new FakeCloud('main');
    return FakeCloud.shared;
  }

  static destroyTRTCShareInstance() {
    FakeCloud.destroyed += 1;
    FakeCloud.shared = null;
  }

  constructor(kind = 'child') {
    this.kind = kind;
    this.calls = [];
    this.listeners = new Map();
    this.children = [];
  }

  on(name, callback) { this.listeners.set(name, callback); }
  emit(name, ...args) { this.listeners.get(name)?.(...args); }
  record(name, ...args) { this.calls.push([name, ...args]); }
  getSDKVersion() { return 'fake'; }
  createSubCloud() { const child = new FakeCloud(); this.children.push(child); return child; }
  setDefaultStreamRecvMode(...args) { this.record('setDefaultStreamRecvMode', ...args); }
  muteRemoteAudio(...args) { this.record('muteRemoteAudio', ...args); }
  muteAllRemoteAudio(...args) { this.record('muteAllRemoteAudio', ...args); }
  enterRoom(...args) { this.record('enterRoom', ...args); }
  exitRoom() { this.record('exitRoom'); }
  destroy() { this.record('destroy'); }
  stopLocalAudio() { this.record('stopLocalAudio'); }
  startLocalAudio(...args) { this.record('startLocalAudio', ...args); }
  setAudioCaptureVolume(...args) { this.record('setAudioCaptureVolume', ...args); }
  enableCustomAudioCapture(...args) { this.record('enableCustomAudioCapture', ...args); }
  generateCustomPTS() { this.record('generateCustomPTS'); return 123_456; }
  sendCustomAudioData(...args) { this.record('sendCustomAudioData', ...args); }
  getScreenCaptureSources() { return [{ type: 1, sourceId: 'screen', sourceName: 'screen' }]; }
  selectScreenCaptureTarget(...args) { this.record('selectScreenCaptureTarget', ...args); }
  startScreenCapture(...args) { this.record('startScreenCapture', ...args); }
  stopScreenCapture() { this.record('stopScreenCapture'); }
  startSystemAudioLoopback() { this.record('startSystemAudioLoopback'); }
  stopSystemAudioLoopback() { this.record('stopSystemAudioLoopback'); }
  setSystemAudioLoopbackVolume(...args) { this.record('setSystemAudioLoopbackVolume', ...args); }
}

function fakeSdk() {
  class Params {}
  class VideoEncParam { constructor(...args) { this.args = args; } }
  class AudioFrame { constructor(...args) { this.args = args; } }
  class Rect {}
  return {
    default: FakeCloud,
    TRTCParams: Params,
    TRTCVideoEncParam: VideoEncParam,
    TRTCAudioFrame: AudioFrame,
    TRTCAudioFrameFormat: { TRTCAudioFrameFormatPCM: 1 },
    Rect,
    TRTCAppScene: { TRTCAppSceneAudioCall: 1 },
    TRTCAudioQuality: { TRTCAudioQualityDefault: 2 },
    TRTCVideoStreamType: { TRTCVideoStreamTypeSub: 1 },
    TRTCScreenCaptureSourceType: { TRTCScreenCaptureSourceTypeScreen: 1 },
    TRTCVideoResolution: { TRTCVideoResolution_1280_720: 3, TRTCVideoResolution_1920_1080: 5 },
    TRTCVideoResolutionMode: { TRTCVideoResolutionModeLandscape: 1 },
  };
}

function calls(cloud, name) {
  return cloud.calls.filter((entry) => entry[0] === name);
}

test('TRTC main microphone and system subcloud remain separate and default muted', async () => {
  FakeCloud.shared = null;
  FakeCloud.destroyed = 0;
  const transport = {
    getCapability: async () => ({ mode: 'trtc-loopback', echoExclusion: 'unsupported', windowsBuild: 19_045 }),
    start: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    onFrame: () => () => {},
    onStatus: () => () => {},
  };
  const bridge = createTrtcPreloadBridge({ systemAudioTransport: transport, sdkLoader: fakeSdk });
  assert.equal(bridge.enterRoom({
    sdkAppId: 1,
    roomId: 2,
    userId: 'c_target',
    userSig: 'main-sig',
    remoteUserId: 'c_initiator',
    publishScreen: true,
    localSystemAudio: { userId: 's_target', userSig: 'system-sig' },
  }).ok, true);
  const main = FakeCloud.shared;
  assert.deepEqual(calls(main, 'muteRemoteAudio')[0], ['muteRemoteAudio', 'c_initiator', true]);
  assert.equal(calls(main, 'startLocalAudio').length, 0);
  main.emit('onEnterRoom', 10);
  assert.equal(bridge.setMicrophoneEnabled(true).ok, true);
  assert.deepEqual(calls(main, 'startLocalAudio').at(-1), ['startLocalAudio', 2]);
  bridge.setMicrophoneEnabled(false);
  assert.ok(calls(main, 'stopLocalAudio').length >= 1);

  assert.equal(bridge.startScreenShare('720p30').ok, true);
  const child = main.children[0];
  assert.deepEqual(calls(child, 'muteAllRemoteAudio')[0], ['muteAllRemoteAudio', true]);
  assert.equal(calls(main, 'startSystemAudioLoopback').length, 0);
  assert.equal(calls(child, 'enterRoom')[0][1].userId, 's_target');
  child.emit('onEnterRoom', 8);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls(child, 'startSystemAudioLoopback').length, 1);
  assert.equal(calls(child, 'startLocalAudio').length, 0);

  bridge.leaveRoom();
  assert.ok(calls(child, 'destroy').length >= 1);
  assert.equal(FakeCloud.destroyed, 1);
});

test('remote microphone and remote system controls mute distinct TRTC identities', () => {
  FakeCloud.shared = null;
  FakeCloud.destroyed = 0;
  const bridge = createTrtcPreloadBridge({ sdkLoader: fakeSdk });
  assert.equal(bridge.enterRoom({
    sdkAppId: 1,
    roomId: 2,
    userId: 'c_initiator',
    userSig: 'main-sig',
    remoteUserId: 'c_target',
    remoteSystemUserId: 's_target',
    publishScreen: false,
  }).ok, true);
  const main = FakeCloud.shared;
  bridge.setRemoteMicrophoneMuted(false);
  bridge.setRemoteSystemAudioMuted(false);
  assert.deepEqual(calls(main, 'muteRemoteAudio').slice(-2), [
    ['muteRemoteAudio', 'c_target', false],
    ['muteRemoteAudio', 's_target', false],
  ]);
  bridge.leaveRoom();
});

test('Windows 11 PCM is injected only into the current system child', async () => {
  FakeCloud.shared = null;
  FakeCloud.destroyed = 0;
  let frameListener = null;
  let statusListener = null;
  let startedGeneration = 0;
  const stoppedGenerations = [];
  const transport = {
    getCapability: async () => ({ mode: 'process-exclusion', echoExclusion: 'supported', windowsBuild: 22_631 }),
    start: async (generation) => { startedGeneration = generation; return { ok: true, protocolVersion: 1 }; },
    stop: async (generation) => { stoppedGenerations.push(generation); return { ok: true }; },
    onFrame: (listener) => { frameListener = listener; return () => { frameListener = null; }; },
    onStatus: (listener) => { statusListener = listener; return () => { statusListener = null; }; },
  };
  const bridge = createTrtcPreloadBridge({ systemAudioTransport: transport, sdkLoader: fakeSdk });
  assert.equal(bridge.enterRoom({
    sdkAppId: 1,
    roomId: 2,
    userId: 'c_target',
    userSig: 'main-sig',
    remoteUserId: 'c_initiator',
    publishScreen: true,
    localSystemAudio: { userId: 's_target', userSig: 'system-sig' },
  }).ok, true);
  const main = FakeCloud.shared;
  main.emit('onEnterRoom', 10);
  assert.equal(bridge.startScreenShare('720p30').ok, true);
  const child = main.children[0];
  child.emit('onEnterRoom', 8);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(startedGeneration > 0);
  assert.deepEqual(calls(child, 'enableCustomAudioCapture')[0], ['enableCustomAudioCapture', true]);

  frameListener?.({ generation: startedGeneration, sequence: 1, pcm: Buffer.alloc(3_840) });
  assert.equal(calls(child, 'sendCustomAudioData').length, 1);
  const sentFrame = calls(child, 'sendCustomAudioData')[0][1];
  assert.deepEqual(sentFrame.args.slice(0, 1), [1]);
  assert.equal(sentFrame.args[1].length, 3_840);
  assert.deepEqual(sentFrame.args.slice(2), [3_840, 48_000, 2, 123_456]);
  assert.equal(calls(main, 'sendCustomAudioData').length, 0);

  bridge.leaveRoom();
  frameListener?.({ generation: startedGeneration, sequence: 2, pcm: Buffer.alloc(3_840) });
  statusListener?.({ generation: startedGeneration, event: 'helper-exit', expected: false, code: 1 });
  assert.equal(calls(child, 'sendCustomAudioData').length, 1);
  assert.ok(stoppedGenerations.includes(startedGeneration));
});

test('late system capability result cannot revive capture after hangup and redial', async () => {
  FakeCloud.shared = null;
  FakeCloud.destroyed = 0;
  let resolveCapability;
  const starts = [];
  const transport = {
    getCapability: () => new Promise((resolve) => { resolveCapability = resolve; }),
    start: async (generation) => { starts.push(generation); return { ok: true, protocolVersion: 1 }; },
    stop: async () => ({ ok: true }),
    onFrame: () => () => {},
    onStatus: () => () => {},
  };
  const bridge = createTrtcPreloadBridge({ systemAudioTransport: transport, sdkLoader: fakeSdk });
  const config = {
    sdkAppId: 1,
    roomId: 2,
    userId: 'c_target',
    userSig: 'main-sig',
    remoteUserId: 'c_initiator',
    publishScreen: true,
    localSystemAudio: { userId: 's_target', userSig: 'system-sig' },
  };
  bridge.enterRoom(config);
  const oldMain = FakeCloud.shared;
  oldMain.emit('onEnterRoom', 10);
  bridge.startScreenShare('720p30');
  const oldChild = oldMain.children[0];
  oldChild.emit('onEnterRoom', 8);
  bridge.leaveRoom();
  bridge.enterRoom({ ...config, roomId: 3, userSig: 'new-main-sig', localSystemAudio: { userId: 's_target_2', userSig: 'new-system-sig' } });
  resolveCapability?.({ mode: 'process-exclusion', echoExclusion: 'supported', windowsBuild: 22_631 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, []);
  assert.equal(calls(oldChild, 'enableCustomAudioCapture').length, 0);
  const newMain = FakeCloud.shared;
  assert.notEqual(newMain, oldMain);
  assert.equal(calls(newMain, 'startLocalAudio').length, 0);
  assert.deepEqual(calls(newMain, 'muteRemoteAudio')[0], ['muteRemoteAudio', 'c_initiator', true]);
  bridge.leaveRoom();
});
