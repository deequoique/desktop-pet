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
  env: { ...process.env, PORT: String(port), ROOM_SECRETS: 'alpha,beta', ROOM_GRACE_MS: '40', PET_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server start timeout')), 4000);
  server.once('exit', (code) => reject(new Error(`server exited ${code}`)));
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
  assert.equal(bPet2.response.ok, true);
  assert.equal(aController.response.peers.peerOnline, false);

  await new Promise((resolve) => aController.socket.emit('room:rename-member', { memberId: 'b', displayName: '小明' }, resolve));
  const aController2 = await join({ role: 'controller', memberId: 'a', deviceId: 'a-phone' });
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
  assert.equal(aCall.peerDeviceId, 'b-pc');
  assert.equal(aCall.cameraSenderDeviceId, 'b-pc');
  assert.equal(bCall.peerDeviceId, 'a-laptop');
  assert.equal(bCall.cameraSenderDeviceId, 'b-pc');

  const screenControl = once(bPet1.socket, 'webrtc:media-control');
  let leakedScreenControl = false;
  const onLeakedScreenControl = () => { leakedScreenControl = true; };
  bPet2.socket.on('webrtc:media-control', onLeakedScreenControl);
  assert.deepEqual(await emitAck(aController.socket, 'webrtc:media-control', {
    callId: started.callId, media: 'screen', enabled: false,
  }), { ok: true });
  assert.deepEqual(await screenControl, { callId: started.callId, media: 'screen', enabled: false });
  await wait(20);
  bPet2.socket.off('webrtc:media-control', onLeakedScreenControl);
  assert.equal(leakedScreenControl, false);

  const cameraControl = once(bController1.socket, 'webrtc:media-control');
  assert.deepEqual(await emitAck(aController.socket, 'webrtc:media-control', {
    callId: started.callId, media: 'camera', enabled: true,
  }), { ok: true });
  assert.deepEqual(await cameraControl, { callId: started.callId, media: 'camera', enabled: true });
  assert.equal((await emitAck(bController1.socket, 'webrtc:media-control', {
    callId: started.callId, media: 'camera', enabled: false,
  })).code, 'not_allowed');
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

  const cameraStatus = once(aController.socket, 'webrtc:media-status');
  bController1.socket.emit('webrtc:media-status', {
    callId: started.callId, media: 'camera', state: 'unavailable', reason: 'controller_disabled',
  });
  assert.deepEqual(await cameraStatus, {
    callId: started.callId, media: 'camera', state: 'unavailable', reason: 'controller_disabled',
  });

  const screenStatus = once(aController.socket, 'webrtc:media-status');
  bPet1.socket.emit('webrtc:media-status', {
    callId: started.callId, media: 'screen', state: 'paused', reason: 'controller_disabled',
  });
  assert.deepEqual(await screenStatus, {
    callId: started.callId, media: 'screen', state: 'paused', reason: 'controller_disabled',
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
