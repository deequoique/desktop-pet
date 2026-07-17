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

function join({ secret = 'alpha', role, memberId, deviceId, deviceName = deviceId }) {
  return connect({ protocolVersion: 2, secret, role, memberId, deviceId, deviceName });
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

  const audio = Buffer.from('test-audio');
  const added = await new Promise((resolve) => aController.socket.emit('audio:add', {
    name: '问候', mime: 'audio/mpeg', durationMs: 1000, data: audio,
  }, resolve));
  assert.equal(added.ok, true);
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

  console.log('ok - protocol v2 multi-device presence, routing, names, and private audio');
} finally {
  for (const socket of sockets) socket.disconnect();
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
