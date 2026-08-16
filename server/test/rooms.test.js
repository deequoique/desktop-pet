import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { io } from 'socket.io-client';

const port = 31_000 + Math.floor(Math.random() * 2_000);
const url = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(joinPath(tmpdir(), 'desktop-pet-server-'));
let server;
const sockets = new Set();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const once = (socket, event, timeout = 1500) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
  socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
});

async function connect(payload) {
  const socket = io(url, { transports: ['websocket'], reconnection: false, forceNew: true });
  sockets.add(socket);
  await once(socket, 'connect');
  const response = await new Promise((resolve) => socket.emit('pet:join', payload, resolve));
  return { socket, response };
}

async function discover(secret) {
  const socket = io(url, { transports: ['websocket'], reconnection: false, forceNew: true });
  sockets.add(socket);
  await once(socket, 'connect');
  const response = await new Promise((resolve) => socket.emit('pairing:discover', { protocolVersion: 2, secret }, resolve));
  return { socket, response };
}

function join({ secret = 'alpha', role, memberId, deviceId, deviceName = deviceId }) {
  return connect({ protocolVersion: 2, secret, role, memberId, deviceId, deviceName });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

server = spawn(process.execPath, ['src/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    ROOM_SECRETS: 'alpha,beta',
    ROOM_GRACE_MS: '40',
    PET_DATA_DIR: dataDir,
    TRTC_MEDIA_MODE: 'trtc',
    TRTC_SDK_APP_ID: '1600157176',
    TRTC_SECRET_KEY: 'integration-test-secret',
    TRTC_VIDEO_PROFILE: '720p30',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server start timeout')), 10_000);
  server.once('error', (error) => { clearTimeout(timer); reject(error); });
  server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
  server.stdout.on('data', (chunk) => { if (String(chunk).includes('pet server listening')) { clearTimeout(timer); resolve(); } });
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
});

try {
  const discovered = await discover('alpha');
  assert.equal(discovered.response.ok, true);
  assert.deepEqual(discovered.response.members.map((member) => member.displayName), ['用户 A', '用户 B']);
  const rejectedDiscovery = await discover('wrong');
  assert.equal(rejectedDiscovery.response.code, 'bad_secret');

  const legacy = await connect({ secret: 'alpha', role: 'pet', participantId: 'old' });
  assert.equal(legacy.response.code, 'upgrade_required');

  const aController = await join({ role: 'controller', memberId: 'a', deviceId: 'a-laptop' });
  const aPet = await join({ role: 'pet', memberId: 'a', deviceId: 'a-laptop' });
  const bPet1 = await join({ role: 'pet', memberId: 'b', deviceId: 'b-pc' });
  const bController1 = await join({ role: 'controller', memberId: 'b', deviceId: 'b-pc' });
  const bPet2 = await join({ role: 'pet', memberId: 'b', deviceId: 'b-tablet' });
  const betaController = await join({ secret: 'beta', role: 'controller', memberId: 'a', deviceId: 'beta-a' });
  assert.equal(bPet2.response.ok, true);
  assert.equal(betaController.response.ok, true);
  assert.equal(aController.response.peers.peerOnline, false);

  await new Promise((resolve) => aController.socket.emit('room:rename-member', { memberId: 'b', displayName: '小明' }, resolve));
  const aController2 = await join({ role: 'controller', memberId: 'a', deviceId: 'a-phone' });
  const aPet2 = await join({ role: 'pet', memberId: 'a', deviceId: 'a-phone' });
  const bController2 = await join({ role: 'controller', memberId: 'b', deviceId: 'b-tablet' });
  const renamed = aController2.response.peers;
  assert.equal(renamed.members.find((member) => member.id === 'b').displayName, '小明');
  assert.equal(renamed.members.find((member) => member.id === 'b').devices.length, 2);

  const command = once(bPet2.socket, 'pet:command');
  aController.socket.emit('pet:command', { targetDeviceId: 'b-tablet', type: 'animation', name: 'wave' });
  assert.equal((await command).name, 'wave');

  const aCallStart = once(aController.socket, 'call:start');
  const bCallStart = once(bController1.socket, 'call:start');
  const started = await emitAck(aController.socket, 'call:start', { targetDeviceId: 'b-pc' });
  assert.equal(started.ok, true);
  const [aCall, bCall] = await Promise.all([aCallStart, bCallStart]);
  assert.equal(aCall.callId, started.callId);
  assert.equal(aCall.mediaMode, 'trtc');
  assert.equal(aCall.peerDeviceId, 'b-pc');
  assert.equal(aCall.cameraOffererDeviceId, 'a-laptop');
  assert.equal(aCall.cameraSenderDeviceId, 'b-pc');
  assert.equal(bCall.peerDeviceId, 'a-laptop');
  assert.equal(bCall.mediaMode, 'trtc');
  assert.equal(bCall.cameraOffererDeviceId, 'a-laptop');
  assert.equal(bCall.cameraSenderDeviceId, 'b-pc');

  const [aTrtc, bTrtc] = await Promise.all([
    emitAck(aController.socket, 'trtc:get-config', { callId: started.callId }),
    emitAck(bController1.socket, 'trtc:get-config', { callId: started.callId }),
  ]);
  assert.equal(aTrtc.ok, true);
  assert.equal(aTrtc.mode, 'trtc');
  assert.equal(aTrtc.sdkAppId, 1600157176);
  assert.equal(aTrtc.roomId, bTrtc.roomId);
  assert.equal(aTrtc.remoteUserId, bTrtc.userId);
  assert.equal(bTrtc.remoteUserId, aTrtc.userId);
  assert.equal(aTrtc.remoteSystemUserId, bTrtc.localSystemAudio.userId);
  assert.match(aTrtc.remoteSystemUserId, /^s_[a-f0-9]{24}$/);
  assert.ok(bTrtc.localSystemAudio.userSig);
  assert.equal(aTrtc.localSystemAudio, undefined);
  assert.equal(bTrtc.remoteSystemUserId, undefined);
  assert.equal(aTrtc.userSig === bTrtc.localSystemAudio.userSig, false);
  assert.doesNotMatch(aTrtc.userId, /a-laptop|b-pc/);
  assert.doesNotMatch(bTrtc.userId, /a-laptop|b-pc/);
  assert.doesNotMatch(aTrtc.remoteSystemUserId, /a-laptop|b-pc/);
  assert.equal(aTrtc.publishScreen, false);
  assert.equal(bTrtc.publishScreen, true);
  assert.equal(aTrtc.videoProfile, '720p30');
  assert.ok(aTrtc.userSig);
  assert.ok(aTrtc.expiresAt > Date.now());
  const repeatedTargetTrtc = await emitAck(bController1.socket, 'trtc:get-config', { callId: started.callId });
  assert.equal(repeatedTargetTrtc.localSystemAudio.userId, bTrtc.localSystemAudio.userId);
  assert.equal((await emitAck(aController.socket, 'trtc:get-config', { callId: 'stale-call' })).code, 'not_in_call');
  assert.equal((await emitAck(aPet.socket, 'trtc:get-config', { callId: started.callId })).code, 'not_joined');

  const screenControl = once(bController1.socket, 'trtc:media-control');
  let leakedScreenControl = false;
  const onLeakedScreenControl = () => { leakedScreenControl = true; };
  bPet2.socket.on('trtc:media-control', onLeakedScreenControl);
  assert.deepEqual(await emitAck(aController.socket, 'webrtc:media-control', {
    callId: started.callId, media: 'screen', enabled: false,
  }), { ok: true });
  assert.deepEqual(await screenControl, { callId: started.callId, media: 'screen', enabled: false });
  await wait(20);
  bPet2.socket.off('trtc:media-control', onLeakedScreenControl);
  assert.equal(leakedScreenControl, false);

  const trtcScreenStatus = once(aController.socket, 'trtc:media-status');
  bController1.socket.emit('trtc:media-status', {
    callId: started.callId, media: 'screen', state: 'available',
  });
  assert.deepEqual(await trtcScreenStatus, {
    callId: started.callId, media: 'screen', state: 'available', qualityLevel: 3,
  });

  const trtcSystemStatus = once(aController.socket, 'trtc:media-status');
  bController1.socket.emit('trtc:media-status', {
    callId: started.callId, media: 'system-audio', state: 'unavailable', reason: 'capture_failed',
  });
  assert.deepEqual(await trtcSystemStatus, {
    callId: started.callId, media: 'system-audio', state: 'unavailable', reason: 'capture_failed',
  });

  let leakedCameraControl = false;
  const onLeakedCameraControl = () => { leakedCameraControl = true; };
  bController1.socket.on('webrtc:media-control', onLeakedCameraControl);
  assert.equal((await emitAck(aController.socket, 'webrtc:media-control', {
    callId: started.callId, media: 'camera', enabled: true,
  })).code, 'invalid_media');
  assert.equal((await emitAck(bController1.socket, 'webrtc:media-control', {
    callId: started.callId, media: 'camera', enabled: false,
  })).code, 'invalid_media');
  await wait(20);
  bController1.socket.off('webrtc:media-control', onLeakedCameraControl);
  assert.equal(leakedCameraControl, false);
  assert.equal((await emitAck(aController.socket, 'webrtc:media-control', {
    callId: 'stale-call', media: 'screen', enabled: true,
  })).code, 'not_in_call');
  assert.equal((await emitAck(bPet1.socket, 'webrtc:media-control', {
    callId: started.callId, media: 'screen', enabled: true,
  })).code, 'not_in_call');

  const cameraSignal = once(bController1.socket, 'webrtc:camera-signal');
  aController.socket.emit('webrtc:camera-signal', {
    callId: started.callId, description: { type: 'offer', sdp: 'camera-offer' },
  });
  assert.equal((await cameraSignal).description.sdp, 'camera-offer');

  const cameraDesired = once(bController1.socket, 'webrtc:camera-signal');
  aController.socket.emit('webrtc:camera-signal', {
    callId: started.callId, cameraDesired: true,
  });
  assert.deepEqual(await cameraDesired, {
    callId: started.callId, cameraDesired: true,
  });

  const cameraAnswer = once(aController.socket, 'webrtc:camera-signal');
  bController1.socket.emit('webrtc:camera-signal', {
    callId: started.callId, description: { type: 'answer', sdp: 'camera-answer' },
  });
  assert.equal((await cameraAnswer).description.sdp, 'camera-answer');

  const cameraStatus = once(aController.socket, 'webrtc:media-status');
  bController1.socket.emit('webrtc:media-status', {
    callId: started.callId, media: 'camera', state: 'unavailable',
    reason: 'controller_disabled', sourceDeviceId: 'a-laptop', quality: 'ultra', qualityLevel: 9,
  });
  assert.deepEqual(await cameraStatus, {
    callId: started.callId, media: 'camera', state: 'unavailable',
    reason: 'controller_disabled', sourceDeviceId: 'b-pc',
  });

  const relayDisabledCameraStatus = once(aController.socket, 'webrtc:media-status');
  bController1.socket.emit('webrtc:media-status', {
    callId: started.callId, media: 'camera', state: 'unavailable',
    reason: 'relay_disabled', sourceDeviceId: 'a-laptop', quality: 'relay-low', qualityLevel: 1,
  });
  assert.deepEqual(await relayDisabledCameraStatus, {
    callId: started.callId, media: 'camera', state: 'unavailable',
    reason: 'relay_disabled', sourceDeviceId: 'b-pc', quality: 'relay-low', qualityLevel: 1,
  });

  const reverseCameraStatus = once(bController1.socket, 'webrtc:media-status');
  aController.socket.emit('webrtc:media-status', {
    callId: started.callId, media: 'camera', state: 'available',
    sourceDeviceId: 'b-pc', quality: 'relay-low', qualityLevel: 1,
  });
  assert.deepEqual(await reverseCameraStatus, {
    callId: started.callId, media: 'camera', state: 'available',
    sourceDeviceId: 'a-laptop', quality: 'relay-low', qualityLevel: 1,
  });

  let thirdDeviceCameraLeak = false;
  const onThirdDeviceCameraLeak = () => { thirdDeviceCameraLeak = true; };
  bController1.socket.on('webrtc:camera-signal', onThirdDeviceCameraLeak);
  bController1.socket.on('webrtc:media-status', onThirdDeviceCameraLeak);
  aController.socket.on('webrtc:camera-signal', onThirdDeviceCameraLeak);
  aController.socket.on('webrtc:media-status', onThirdDeviceCameraLeak);
  aController2.socket.emit('webrtc:camera-signal', {
    callId: started.callId, description: { type: 'offer', sdp: 'third-device-offer' },
  });
  aController2.socket.emit('webrtc:media-status', {
    callId: started.callId, media: 'camera', state: 'available',
  });
  bPet2.socket.emit('webrtc:camera-signal', {
    callId: started.callId, description: { type: 'offer', sdp: 'wrong-role-offer' },
  });
  bPet2.socket.emit('webrtc:media-status', {
    callId: started.callId, media: 'camera', state: 'available',
  });
  betaController.socket.emit('webrtc:camera-signal', {
    callId: started.callId, description: { type: 'offer', sdp: 'other-room-offer' },
  });
  betaController.socket.emit('webrtc:media-status', {
    callId: started.callId, media: 'camera', state: 'available',
  });
  await wait(20);
  bController1.socket.off('webrtc:camera-signal', onThirdDeviceCameraLeak);
  bController1.socket.off('webrtc:media-status', onThirdDeviceCameraLeak);
  aController.socket.off('webrtc:camera-signal', onThirdDeviceCameraLeak);
  aController.socket.off('webrtc:media-status', onThirdDeviceCameraLeak);
  assert.equal(thirdDeviceCameraLeak, false);

  const screenStatus = once(aController.socket, 'webrtc:media-status');
  bPet1.socket.emit('webrtc:media-status', {
    callId: started.callId, media: 'screen', state: 'paused',
    reason: 'controller_disabled', quality: 'normal', qualityLevel: 3,
  });
  assert.deepEqual(await screenStatus, {
    callId: started.callId, media: 'screen', state: 'paused',
    reason: 'controller_disabled', quality: 'normal', qualityLevel: 3,
  });

  let unrelatedStatusReceived = false;
  const onUnrelatedStatus = () => { unrelatedStatusReceived = true; };
  aController.socket.on('webrtc:media-status', onUnrelatedStatus);
  bPet2.socket.emit('webrtc:media-status', {
    callId: started.callId, media: 'screen', state: 'available',
  });
  await wait(20);
  aController.socket.off('webrtc:media-status', onUnrelatedStatus);
  assert.equal(unrelatedStatusReceived, false);

  aController.socket.emit('call:end', { callId: started.callId });
  await wait(20);

  const handoffBaseAStart = once(aController.socket, 'call:start');
  const handoffBaseBStart = once(bController1.socket, 'call:start');
  const handoffBase = await emitAck(aController.socket, 'call:start', { targetDeviceId: 'b-pc' });
  assert.equal(handoffBase.ok, true);
  await Promise.all([handoffBaseAStart, handoffBaseBStart]);

  const wrongTargetBusy = await emitAck(aController2.socket, 'call:start', { targetDeviceId: 'b-tablet' });
  assert.deepEqual(wrongTargetBusy, { ok: false, code: 'call_busy' });
  assert.equal((await emitAck(aController.socket, 'trtc:get-config', { callId: handoffBase.callId })).ok, true);

  let joinTriggeredHandoff = false;
  const onUnexpectedHandoff = (payload) => {
    if (payload?.callId === handoffBase.callId && payload?.reason === 'transferred') joinTriggeredHandoff = true;
  };
  aController.socket.on('call:end', onUnexpectedHandoff);
  const incompleteController = await join({ role: 'controller', memberId: 'a', deviceId: 'a-watch' });
  await wait(20);
  aController.socket.off('call:end', onUnexpectedHandoff);
  assert.equal(joinTriggeredHandoff, false);
  assert.deepEqual(await emitAck(incompleteController.socket, 'call:start', { targetDeviceId: 'b-pc' }), {
    ok: false, code: 'peer_not_ready',
  });
  assert.equal((await emitAck(aController.socket, 'trtc:get-config', { callId: handoffBase.callId })).ok, true);

  const oldAEnd = once(aController.socket, 'call:end');
  const peerEndForA = once(bController1.socket, 'call:end');
  const newAStart = once(aController2.socket, 'call:start');
  const peerRestartForA = once(bController1.socket, 'call:start');
  const initiatorHandoff = await emitAck(aController2.socket, 'call:start', { targetDeviceId: 'b-pc' });
  assert.equal(initiatorHandoff.ok, true);
  assert.equal(initiatorHandoff.transferred, true);
  assert.notEqual(initiatorHandoff.callId, handoffBase.callId);
  const [oldAEndPayload, peerEndForAPayload, newAStartPayload, peerRestartForAPayload] = await Promise.all([
    oldAEnd, peerEndForA, newAStart, peerRestartForA,
  ]);
  for (const payload of [oldAEndPayload, peerEndForAPayload]) {
    assert.equal(payload.callId, handoffBase.callId);
    assert.equal(payload.reason, 'transferred');
    assert.equal(payload.transferredMemberId, 'a');
  }
  assert.equal(newAStartPayload.callId, initiatorHandoff.callId);
  assert.equal(newAStartPayload.peerDeviceId, 'b-pc');
  assert.equal(newAStartPayload.cameraOffererDeviceId, 'a-phone');
  assert.equal(newAStartPayload.cameraSenderDeviceId, 'b-pc');
  assert.equal(peerRestartForAPayload.peerDeviceId, 'a-phone');
  assert.equal(peerRestartForAPayload.cameraOffererDeviceId, 'a-phone');
  assert.equal(peerRestartForAPayload.cameraSenderDeviceId, 'b-pc');

  let staleHandoffLeak = false;
  const onStaleHandoffLeak = () => { staleHandoffLeak = true; };
  bController1.socket.on('webrtc:camera-signal', onStaleHandoffLeak);
  bController1.socket.on('webrtc:media-status', onStaleHandoffLeak);
  bPet1.socket.on('webrtc:signal', onStaleHandoffLeak);
  bPet1.socket.on('webrtc:error', onStaleHandoffLeak);
  aController.socket.emit('call:end', { callId: handoffBase.callId });
  aController.socket.emit('webrtc:hangup', { callId: handoffBase.callId });
  aController.socket.emit('webrtc:signal', {
    callId: handoffBase.callId, description: { type: 'offer', sdp: 'stale-main-offer' },
  });
  aController.socket.emit('webrtc:error', {
    callId: handoffBase.callId, message: 'stale-error',
  });
  aController.socket.emit('webrtc:camera-signal', {
    callId: handoffBase.callId, description: { type: 'offer', sdp: 'stale-handoff-offer' },
  });
  aController.socket.emit('webrtc:media-status', {
    callId: handoffBase.callId, media: 'camera', state: 'available',
  });
  await wait(20);
  bController1.socket.off('webrtc:camera-signal', onStaleHandoffLeak);
  bController1.socket.off('webrtc:media-status', onStaleHandoffLeak);
  bPet1.socket.off('webrtc:signal', onStaleHandoffLeak);
  bPet1.socket.off('webrtc:error', onStaleHandoffLeak);
  assert.equal(staleHandoffLeak, false);
  assert.equal((await emitAck(aController.socket, 'webrtc:media-control', {
    callId: handoffBase.callId, media: 'screen', enabled: false,
  })).code, 'not_in_call');
  assert.equal((await emitAck(aController2.socket, 'trtc:get-config', { callId: initiatorHandoff.callId })).ok, true);
  assert.equal((await emitAck(bController1.socket, 'trtc:get-config', { callId: initiatorHandoff.callId })).ok, true);
  aController2.socket.emit('webrtc:hangup');
  await wait(20);
  assert.equal((await emitAck(aController2.socket, 'trtc:get-config', { callId: initiatorHandoff.callId })).ok, true);
  aController2.socket.emit('call:end', { callId: initiatorHandoff.callId });
  await wait(20);

  const targetBaseAStart = once(aController.socket, 'call:start');
  const targetBaseBStart = once(bController1.socket, 'call:start');
  const targetBase = await emitAck(aController.socket, 'call:start', { targetDeviceId: 'b-pc' });
  await Promise.all([targetBaseAStart, targetBaseBStart]);
  const peerEndForB = once(aController.socket, 'call:end');
  const oldBEnd = once(bController1.socket, 'call:end');
  const peerRestartForB = once(aController.socket, 'call:start');
  const newBStart = once(bController2.socket, 'call:start');
  const targetHandoff = await emitAck(bController2.socket, 'call:start', { targetDeviceId: 'a-laptop' });
  assert.equal(targetHandoff.ok, true);
  assert.equal(targetHandoff.transferred, true);
  assert.notEqual(targetHandoff.callId, targetBase.callId);
  const [peerEndForBPayload, oldBEndPayload, peerRestartForBPayload, newBStartPayload] = await Promise.all([
    peerEndForB, oldBEnd, peerRestartForB, newBStart,
  ]);
  for (const payload of [peerEndForBPayload, oldBEndPayload]) {
    assert.equal(payload.callId, targetBase.callId);
    assert.equal(payload.reason, 'transferred');
    assert.equal(payload.transferredMemberId, 'b');
  }
  assert.equal(peerRestartForBPayload.peerDeviceId, 'b-tablet');
  assert.equal(peerRestartForBPayload.cameraOffererDeviceId, 'a-laptop');
  assert.equal(peerRestartForBPayload.cameraSenderDeviceId, 'b-tablet');
  assert.equal(newBStartPayload.peerDeviceId, 'a-laptop');
  assert.equal(newBStartPayload.cameraOffererDeviceId, 'a-laptop');
  assert.equal(newBStartPayload.cameraSenderDeviceId, 'b-tablet');
  const [handoffATrtc, handoffBTrtc] = await Promise.all([
    emitAck(aController.socket, 'trtc:get-config', { callId: targetHandoff.callId }),
    emitAck(bController2.socket, 'trtc:get-config', { callId: targetHandoff.callId }),
  ]);
  assert.equal(handoffATrtc.publishScreen, false);
  assert.equal(handoffBTrtc.publishScreen, true);
  assert.equal(handoffATrtc.remoteSystemUserId, handoffBTrtc.localSystemAudio.userId);

  let staleTargetStatusLeak = false;
  const onStaleTargetStatusLeak = () => { staleTargetStatusLeak = true; };
  aController.socket.on('trtc:media-status', onStaleTargetStatusLeak);
  bController1.socket.emit('trtc:media-status', {
    callId: targetBase.callId, media: 'system-audio', state: 'available',
  });
  await wait(20);
  aController.socket.off('trtc:media-status', onStaleTargetStatusLeak);
  assert.equal(staleTargetStatusLeak, false);

  const repeatedHandoffCall = await emitAck(bController2.socket, 'call:start', { targetDeviceId: 'a-laptop' });
  assert.equal(repeatedHandoffCall.ok, true);
  assert.equal(repeatedHandoffCall.callId, targetHandoff.callId);
  assert.equal(repeatedHandoffCall.transferred, undefined);
  bController2.socket.emit('call:end', { callId: targetHandoff.callId });
  await wait(20);
  bController2.socket.disconnect();
  await wait(20);

  const audio = Buffer.from('test-audio');
  const added = await new Promise((resolve) => aController.socket.emit('audio:add', {
    name: '问候', mime: 'audio/webm;codecs=opus', durationMs: 1000, data: audio,
  }, resolve));
  assert.equal(added.ok, true);
  assert.equal(added.item.mime, 'audio/webm');
  const ownList = await new Promise((resolve) => aController.socket.emit('audio:list', resolve));
  const otherList = await new Promise((resolve) => bController1.socket.emit('audio:list', resolve));
  assert.equal(ownList.items.length, 1);
  assert.equal(otherList.items.length, 0);
  const playback = once(bPet1.socket, 'audio:play');
  const played = await new Promise((resolve) => aController.socket.emit('audio:play', {
    audioId: added.item.id, targetDeviceId: 'b-pc',
  }, resolve));
  assert.equal(played.ok, true);
  assert.deepEqual(Buffer.from((await playback).data), audio);

  const noteAtPet1 = once(bPet1.socket, 'note:changed');
  const noteAtPet2 = once(bPet2.socket, 'note:changed');
  const createdNote = await emitAck(aController.socket, 'note:create', {
    body: '稍后看看这个',
    paperColor: 'yellow',
    media: { kind: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  });
  assert.equal(createdNote.ok, true);
  assert.equal((await noteAtPet1).note.id, createdNote.note.id);
  assert.equal((await noteAtPet2).note.id, createdNote.note.id);
  const inbox = await emitAck(bPet1.socket, 'note:list', { view: 'inbox' });
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].media.source, 'youtube.com');
  assert.equal((await emitAck(bPet1.socket, 'note:create', { body: 'bad', paperColor: 'yellow' })).code, 'wrong_role');

  const noticedAtOtherDevice = once(bPet2.socket, 'note:changed');
  let noticedLeakedToSender = false;
  const onSenderNotice = (payload) => { if (payload.reason === 'noticed') noticedLeakedToSender = true; };
  aController.socket.on('note:changed', onSenderNotice);
  assert.equal((await emitAck(bPet1.socket, 'note:mark-noticed', { noteId: createdNote.note.id })).ok, true);
  assert.equal((await noticedAtOtherDevice).reason, 'noticed');
  await wait(20);
  aController.socket.off('note:changed', onSenderNotice);
  assert.equal(noticedLeakedToSender, false);
  const senderSnapshot = await emitAck(aController.socket, 'note:list', { view: 'sent' });
  assert.equal('noticedAt' in senderSnapshot.items[0], false);

  let favoriteLeakedToRecipient = false;
  const onRecipientFavorite = (payload) => { if (payload.reason === 'favorite') favoriteLeakedToRecipient = true; };
  bPet1.socket.on('note:changed', onRecipientFavorite);
  assert.equal((await emitAck(aController.socket, 'note:set-favorite', {
    noteId: createdNote.note.id, favorite: true,
  })).ok, true);
  await wait(20);
  bPet1.socket.off('note:changed', onRecipientFavorite);
  assert.equal(favoriteLeakedToRecipient, false);
  const reviewedAtSender = once(aController.socket, 'note:changed');
  assert.equal((await emitAck(bPet2.socket, 'note:review', {
    noteId: createdNote.note.id, reply: { body: '收到 👍' },
  })).ok, true);
  const reviewedEvent = await reviewedAtSender;
  assert.equal(reviewedEvent.reason, 'reviewed');
  assert.equal(reviewedEvent.note.review.body, '收到 👍');
  assert.equal((await emitAck(bPet1.socket, 'note:review', { noteId: createdNote.note.id })).code, 'note_already_reviewed');
  assert.equal((await emitAck(aController.socket, 'note:list', { view: 'favorites' })).items.length, 1);

  bController1.socket.disconnect();
  await wait(30);
  const offlineState = await new Promise((resolve) => {
    aController.socket.once('room:peers', resolve);
    bPet1.socket.disconnect();
  });
  assert.equal(offlineState.peerOnline, false);
  assert.equal(offlineState.peerPetOnline, true); // b-tablet pet remains online

  const movedPeers = once(aController.socket, 'room:peers');
  const moved = await new Promise((resolve) => aController.socket.emit('device:change-member', { targetMemberId: 'b' }, resolve));
  assert.equal(moved.ok, true);
  const movedState = await movedPeers;
  assert.equal(movedState.self.memberId, 'b');
  assert.equal(movedState.members.find((member) => member.id === 'a').devices.some((device) => device.id === 'a-laptop'), false);
  assert.equal(movedState.members.find((member) => member.id === 'b').devices.some((device) => device.id === 'a-laptop'), true);
  const movedAudio = await new Promise((resolve) => aController.socket.emit('audio:list', resolve));
  const originalMemberAudio = await new Promise((resolve) => aController2.socket.emit('audio:list', resolve));
  assert.equal(movedAudio.items.length, 0);
  assert.equal(originalMemberAudio.items.length, 1);

  const movedPetAudio = await new Promise((resolve) => aPet.socket.emit('audio:list', resolve));
  assert.equal(movedPetAudio.items.length, 0);

  const rejectedPetMove = await new Promise((resolve) => aPet.socket.emit('device:change-member', { targetMemberId: 'b' }, resolve));
  assert.equal(rejectedPetMove.code, 'not_joined');
  const rejectedMember = await new Promise((resolve) => aController.socket.emit('device:change-member', { targetMemberId: 'invalid' }, resolve));
  assert.equal(rejectedMember.code, 'invalid_member');
  const movedBack = await new Promise((resolve) => aController.socket.emit('device:change-member', { targetMemberId: 'a' }, resolve));
  assert.equal(movedBack.ok, true);
  const restoredAudio = await new Promise((resolve) => aController.socket.emit('audio:list', resolve));
  assert.equal(restoredAudio.items.length, 1);

  console.log('ok - protocol v2 multi-device presence, routing, names, and private audio');
} finally {
  for (const socket of sockets) socket.disconnect();
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
