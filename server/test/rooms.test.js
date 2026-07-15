import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { io } from 'socket.io-client';

const port = 31_000 + Math.floor(Math.random() * 2_000);
const url = `http://127.0.0.1:${port}`;
let server;
const sockets = new Set();
const tests = [];
function test(name, run) { tests.push({ name, run }); }

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function once(socket, event, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

async function join({ secret = 'alpha', role, participantId }) {
  const socket = io(url, { transports: ['websocket'], reconnection: false, forceNew: true });
  sockets.add(socket);
  await once(socket, 'connect');
  const response = await new Promise((resolve) => {
    socket.emit('pet:join', { secret, role, participantId }, resolve);
  });
  return { socket, response };
}

async function setup() {
  server = spawn(process.execPath, ['src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, PORT: String(port), ROOM_SECRETS: 'alpha,beta', ROOM_GRACE_MS: '80',
      RTC_STUN_URLS: 'stun:rtc.example.test:3478',
      RTC_TURN_URLS: 'turn:rtc.example.test:3478?transport=udp,turn:rtc.example.test:3478?transport=tcp',
      RTC_TURN_SHARED_SECRET: 'test-turn-secret', RTC_TURN_REALM: 'rtc.example.test',
      RTC_TURN_CREDENTIAL_TTL_SEC: '600', RTC_ICE_TRANSPORT_POLICY: 'relay',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 4000);
    server.once('exit', (code) => reject(new Error(`server exited ${code}`)));
    server.stdout.on('data', (chunk) => {
      if (String(chunk).includes('pet server listening')) { clearTimeout(timer); resolve(); }
    });
  });
}

function teardown() {
  for (const socket of sockets) socket.disconnect();
  server?.kill();
}

test('participant endpoints share one slot; third participant is rejected', async () => {
  const aPet = await join({ role: 'pet', participantId: 'a' });
  const aController = await join({ role: 'controller', participantId: 'a' });
  const bPet = await join({ role: 'pet', participantId: 'b' });
  const bController = await join({ role: 'controller', participantId: 'b' });
  assert.equal(aPet.response.ok, true);
  assert.equal(aController.response.ok, true);
  assert.equal(bPet.response.ok, true);
  assert.equal(bController.response.peers.peerPetOnline, true);

  const kicked = once(bPet.socket, 'room:kicked');
  const bPetReplacement = await join({ role: 'pet', participantId: 'b' });
  assert.equal(bPetReplacement.response.ok, true);
  assert.equal((await kicked).reason, 'replaced');

  const third = await join({ role: 'pet', participantId: 'c' });
  assert.deepEqual({ ok: third.response.ok, code: third.response.code }, { ok: false, code: 'room_full' });
  assert.equal(aPet.socket.connected, true);
  assert.equal(bPetReplacement.socket.connected, true);

  const commandPromise = once(bPetReplacement.socket, 'pet:command');
  aController.socket.emit('pet:command', { type: 'animation', name: 'waving' });
  assert.deepEqual(await commandPromise, { type: 'animation', name: 'waving' });

  let selfReceived = false;
  aPet.socket.once('pet:command', () => { selfReceived = true; });
  await wait(40);
  assert.equal(selfReceived, false);

  const callStartedA = once(aController.socket, 'call:start');
  const callStartedB = once(bController.socket, 'call:start');
  const callResponse = await new Promise((resolve) => aController.socket.emit('call:start', resolve));
  assert.equal(callResponse.ok, true);
  const [{ callId }, bCall] = await Promise.all([callStartedA, callStartedB]);
  assert.equal(bCall.callId, callId);

  let staleDelivered = false;
  bPetReplacement.socket.once('webrtc:signal', () => { staleDelivered = true; });
  aController.socket.emit('webrtc:signal', { callId: 'stale', candidate: { candidate: 'x' } });
  await wait(30);
  assert.equal(staleDelivered, false);
  const validSignal = once(bPetReplacement.socket, 'webrtc:signal');
  aController.socket.emit('webrtc:signal', { callId, candidate: { candidate: 'ok' } });
  assert.equal((await validSignal).callId, callId);

  const rtcConfig = await new Promise((resolve) => aController.socket.emit('webrtc:get-config', resolve));
  assert.equal(rtcConfig.ok, true);
  assert.equal(rtcConfig.iceTransportPolicy, 'relay');
  assert.deepEqual(rtcConfig.iceServers[0].urls, ['stun:rtc.example.test:3478']);
  const turn = rtcConfig.iceServers[1];
  assert.equal(turn.urls.length, 2);
  assert.match(turn.username, /^\d+:a$/);
  assert.equal(turn.credential, createHmac('sha1', 'test-turn-secret').update(turn.username).digest('base64'));
  assert.ok(rtcConfig.expiresAt > Date.now());

  const mediaStatus = once(bController.socket, 'webrtc:media-status');
  aPet.socket.emit('webrtc:media-status', {
    callId, media: 'screen', state: 'paused', reason: 'relay_audio_only',
  });
  assert.deepEqual(await mediaStatus, {
    callId, media: 'screen', state: 'paused', reason: 'relay_audio_only',
  });

  for (const item of [aPet, aController, bPet, bPetReplacement, bController, third]) item.socket.disconnect();
  await wait(120);
});

test('configured rooms are isolated and bad secrets are rejected', async () => {
  const alphaController = await join({ secret: 'alpha', role: 'controller', participantId: 'alpha-a' });
  const alphaPet = await join({ secret: 'alpha', role: 'pet', participantId: 'alpha-b' });
  const betaPet = await join({ secret: 'beta', role: 'pet', participantId: 'beta-b' });
  const bad = await join({ secret: 'not-configured', role: 'pet', participantId: 'bad' });
  const badRole = await join({ secret: 'beta', role: 'admin', participantId: 'bad-role' });
  assert.equal(bad.response.code, 'bad_secret');
  assert.equal(badRole.response.code, 'bad_role');

  let betaReceived = false;
  betaPet.socket.once('pet:command', () => { betaReceived = true; });
  const alphaCommand = once(alphaPet.socket, 'pet:command');
  alphaController.socket.emit('pet:command', { type: 'animation', name: 'idle' });
  await alphaCommand;
  await wait(30);
  assert.equal(betaReceived, false);

  for (const item of [alphaController, alphaPet, betaPet, bad, badRole]) item.socket.disconnect();
  await wait(120);
});

test('legacy controller and pet remain compatible', async () => {
  const controller = await join({ role: 'controller' });
  const pet = await join({ role: 'pet' });
  assert.equal(controller.response.ok, true);
  assert.equal(pet.response.ok, true);
  const command = once(pet.socket, 'pet:command');
  controller.socket.emit('pet:command', { type: 'expression', name: 'joy' });
  assert.equal((await command).name, 'joy');
  controller.socket.disconnect();
  pet.socket.disconnect();
  await wait(120);
});

test('a fully disconnected participant keeps then releases its slot', async () => {
  const aPet = await join({ role: 'pet', participantId: 'grace-a' });
  const aController = await join({ role: 'controller', participantId: 'grace-a' });
  const bPet = await join({ role: 'pet', participantId: 'grace-b' });
  aPet.socket.disconnect();
  aController.socket.disconnect();
  const immediate = await join({ role: 'pet', participantId: 'grace-c' });
  assert.equal(immediate.response.code, 'room_full');
  immediate.socket.disconnect();
  await wait(120);
  const afterGrace = await join({ role: 'pet', participantId: 'grace-c' });
  assert.equal(afterGrace.response.ok, true);
  bPet.socket.disconnect();
  afterGrace.socket.disconnect();
});

await setup();
try {
  for (const { name, run } of tests) {
    await run();
    console.log(`ok - ${name}`);
  }
} finally {
  teardown();
}
