import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { createHash, createHmac, randomUUID } from 'crypto';
import { Readable } from 'stream';
import fs from 'node:fs';
import { Server as SocketIOServer } from 'socket.io';
import WebSocket from 'ws';
import { PersistentStore } from './persistent-store.js';

const PORT = process.env.PORT || 3030;

function csvEnv(name) {
  return String(process.env[name] || '').split(',').map((value) => value.trim()).filter(Boolean);
}

const RTC_STUN_URLS = csvEnv('RTC_STUN_URLS');
const RTC_TURN_URLS = csvEnv('RTC_TURN_URLS');
const RTC_TURN_SHARED_SECRET = String(process.env.RTC_TURN_SHARED_SECRET || '').trim();
const RTC_TURN_REALM = String(process.env.RTC_TURN_REALM || '').trim();
const RTC_TURN_CREDENTIAL_TTL_SEC = Math.max(300, Number(process.env.RTC_TURN_CREDENTIAL_TTL_SEC || 43_200));
const RTC_ICE_TRANSPORT_POLICY = process.env.RTC_ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all';

function rtcConfigFor(participantId) {
  const iceServers = [];
  if (RTC_STUN_URLS.length) iceServers.push({ urls: RTC_STUN_URLS });
  let expiresAt;
  if (RTC_TURN_URLS.length && RTC_TURN_SHARED_SECRET) {
    const expiry = Math.floor(Date.now() / 1000) + RTC_TURN_CREDENTIAL_TTL_SEC;
    const username = `${expiry}:${participantId}`;
    const credential = createHmac('sha1', RTC_TURN_SHARED_SECRET).update(username).digest('base64');
    expiresAt = expiry * 1000;
    iceServers.push({ urls: RTC_TURN_URLS, username, credential });
  }
  return {
    iceServers,
    iceTransportPolicy: RTC_ICE_TRANSPORT_POLICY,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

// === TTS providers ===
const TTS_PROVIDER = String(process.env.TTS_PROVIDER || 'elevenlabs').trim().toLowerCase();
if (!['elevenlabs', 'cosyvoice'].includes(TTS_PROVIDER)) {
  throw new Error(`Unsupported TTS_PROVIDER: ${TTS_PROVIDER}`);
}
const ELEVENLABS_KEY = process['env']['ELEVENLABS_API_KEY'];
const ELEVENLABS_BASE_URL = String(process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
const COSYVOICE_KEY = process.env.DASHSCOPE_API_KEY;
const COSYVOICE_WORKSPACE_ID = String(process.env.DASHSCOPE_WORKSPACE_ID || '').trim();
const COSYVOICE_MODEL = process.env.COSYVOICE_MODEL || 'cosyvoice-v3.5-plus';
const COSYVOICE_WS_URL = String(
  process.env.COSYVOICE_WS_URL
    || (COSYVOICE_WORKSPACE_ID
      ? `wss://${COSYVOICE_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`
      : '')
).trim();
const TTS_JOB_TTL_MS = Math.max(5_000, Number(process.env.TTS_JOB_TTL_MS || 60_000));
const TTS_RATE_LIMIT = Math.max(1, Number(process.env.TTS_RATE_LIMIT || 10));
const TTS_QUEUE_LIMIT = 3;

function loadAllowedVoices() {
  const isCosyVoice = TTS_PROVIDER === 'cosyvoice';
  const legacyId = String(isCosyVoice ? '' : process.env.ELEVENLABS_VOICE_ID || '').trim();
  const envName = isCosyVoice ? 'COSYVOICE_VOICES_JSON' : 'ELEVENLABS_VOICES_JSON';
  const raw = String(process.env[envName] || '').trim();
  let parsed = [];
  if (raw) {
    try { parsed = JSON.parse(raw); }
    catch (error) { console.warn(`[tts] invalid ${envName}:`, error?.message || error); }
  }
  const voices = Array.isArray(parsed) ? parsed : [];
  const normalized = voices
    .map((voice) => ({ id: String(voice?.id || '').trim(), label: String(voice?.label || '').trim() }))
    .filter((voice) => voice.id && voice.label);
  if (!normalized.length && legacyId) normalized.push({ id: legacyId, label: 'Default' });
  return normalized;
}

const ALLOWED_VOICES = loadAllowedVoices();
const ALLOWED_VOICE_IDS = new Set(ALLOWED_VOICES.map((voice) => voice.id));

function managedTtsReady() {
  if (!ALLOWED_VOICES.length) return false;
  if (TTS_PROVIDER === 'cosyvoice') return !!(COSYVOICE_KEY && COSYVOICE_WS_URL);
  return !!ELEVENLABS_KEY;
}

function managedTtsModel() {
  return TTS_PROVIDER === 'cosyvoice' ? COSYVOICE_MODEL : ELEVENLABS_MODEL;
}

// === Socket.IO 房间 / 鉴权 ===
// 房间密钥由服务端预配置。ROOM_SECRETS 支持逗号分隔；ROOM_SECRET 保持 v1.1 兼容。
const ROOM_SECRET_HASHES = new Set(
  String(process.env.ROOM_SECRETS || process.env.ROOM_SECRET || 'change-me')
    .split(',').map((value) => value.trim()).filter(Boolean).map(hashSecret)
);
const ROOM_GRACE_MS = Math.max(0, Number(process.env.ROOM_GRACE_MS || 30_000));
const store = new PersistentStore(process.env.PET_DATA_DIR || new URL('../data', import.meta.url).pathname);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    tts: managedTtsReady() ? 'ready' : 'disabled',
    ttsProvider: TTS_PROVIDER,
    ttsVoices: ALLOWED_VOICES.length,
    socket: 'ready',
  });
});

// === HTTP server + Socket.IO ===
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // 留 polling 兜底；国内/严苛代理下 ws 升级失败时还能跑
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 11 * 1024 * 1024,
});

// roomHash -> { participants: Map<participantId, participant>, callId }
// 密钥只用于入房并立即哈希，内存与日志均不保留明文。
const rooms = new Map();

function hashSecret(secret) {
  return createHash('sha256').update(secret).digest('hex');
}

function roomChannel(roomHash) { return `pet-room:${roomHash}`; }

function roomForSocket(socket) {
  return socket.data?.roomHash ? rooms.get(socket.data.roomHash) : null;
}

function participantForSocket(socket) {
  return roomForSocket(socket)?.participants.get(socket.data?.participantId) || null;
}

function otherMemberId(memberId) { return memberId === 'a' ? 'b' : 'a'; }

function otherParticipant(room, deviceId, targetDeviceId) {
  const self = room.participants.get(deviceId);
  if (!self) return null;
  const candidates = [...room.participants.values()].filter((p) => p.memberId === otherMemberId(self.memberId));
  if (targetDeviceId) return candidates.find((p) => p.id === targetDeviceId) || null;
  return candidates.length === 1 ? candidates[0] : null;
}

function participantOnline(participant) {
  return !!(participant?.pet || participant?.controller);
}

function peerSnapshot(room, participantId) {
  const self = room.participants.get(participantId);
  const peerDevices = [...room.participants.values()].filter((p) => p.memberId === otherMemberId(self?.memberId));
  const registry = store.room(room.hash);
  const members = ['a', 'b'].map((memberId) => ({
    id: memberId,
    displayName: registry.members[memberId].displayName,
    devices: store.devices(room.hash, memberId).map((device) => {
      const runtime = room.participants.get(device.id);
      return { ...device, petOnline: !!runtime?.pet, controllerOnline: !!runtime?.controller };
    }),
  }));
  return {
    protocolVersion: 2,
    self: { memberId: self?.memberId, deviceId: self?.id },
    members,
    selfReady: !!(self?.pet && self?.controller),
    peerOnline: peerDevices.some((device) => !!device.controller),
    peerPetOnline: peerDevices.some((device) => !!device.pet),
    peerControllerOnline: peerDevices.some((device) => !!device.controller),
    // v1.1 UI compatibility: from this participant's perspective these mean remote endpoints.
    pet: peerDevices.some((device) => !!device.pet),
    controller: peerDevices.some((device) => !!device.controller),
  };
}

function emitPeerSnapshots(room) {
  for (const participant of room.participants.values()) {
    const snapshot = peerSnapshot(room, participant.id);
    for (const socketId of [participant.pet, participant.controller]) {
      if (socketId) io.to(socketId).emit('room:peers', snapshot);
    }
  }
}

function emitToRoomEndpoints(room, event, payload) {
  for (const participant of room.participants.values()) {
    for (const socketId of [participant.pet, participant.controller]) {
      if (socketId) io.to(socketId).emit(event, payload);
    }
  }
}

function endRoomCall(room, reason = 'ended') {
  if (!room.callId) return;
  const callId = room.callId;
  const deviceIds = room.call ? [room.call.initiatorDeviceId, room.call.targetDeviceId] : [];
  for (const deviceId of deviceIds) {
    const device = room.participants.get(deviceId);
    for (const socketId of [device?.pet, device?.controller]) if (socketId) {
      io.to(socketId).emit('call:end', { callId, reason });
      io.to(socketId).emit('webrtc:hangup', { callId, reason });
    }
  }
  room.callId = null;
  room.call = null;
}

// === TTS jobs ===
const ttsJobs = new Map();
const ttsQueues = new Map();
const ttsRateWindows = new Map();
let voiceMetadataCache = { expiresAt: 0, voices: [] };

function ttsQueueKey(roomHash, participantId) { return `${roomHash}:${participantId}`; }

function ttsQueueFor(roomHash, participantId) {
  const key = ttsQueueKey(roomHash, participantId);
  let queue = ttsQueues.get(key);
  if (!queue) {
    queue = { key, roomHash, participantId, active: null, pending: [] };
    ttsQueues.set(key, queue);
  }
  return queue;
}

function emitTtsStatus(job, state, error) {
  const room = rooms.get(job.roomHash);
  const requester = room?.participants.get(job.requesterId);
  if (!requester?.controller) return;
  io.to(requester.controller).emit('tts:status', {
    jobId: job.id,
    state,
    ...(error ? { error } : {}),
  });
}

function dispatchNextTts(queue) {
  if (queue.active || !queue.pending.length) return;
  const jobId = queue.pending.shift();
  const job = ttsJobs.get(jobId);
  if (!job) return dispatchNextTts(queue);
  const room = rooms.get(job.roomHash);
  const target = room?.participants.get(job.targetId);
  if (!target?.pet) {
    emitTtsStatus(job, 'error', 'peer_pet_offline');
    ttsJobs.delete(job.id);
    return dispatchNextTts(queue);
  }
  queue.active = job.id;
  job.state = 'dispatched';
  job.expiresAt = Date.now() + TTS_JOB_TTL_MS;
  job.expiryTimer = setTimeout(() => finishTtsJob(job, 'error', 'tts_job_expired'), TTS_JOB_TTL_MS);
  io.to(target.pet).emit('tts:play', {
    jobId: job.id,
    text: job.text,
    streamUrl: `/api/tts/jobs/${job.id}`,
  });
  emitTtsStatus(job, 'dispatched');
}

function finishTtsJob(job, state, error) {
  if (!job || job.finished) return;
  job.finished = true;
  if (job.expiryTimer) clearTimeout(job.expiryTimer);
  emitTtsStatus(job, state, error);
  ttsJobs.delete(job.id);
  const queue = ttsQueues.get(ttsQueueKey(job.roomHash, job.targetId));
  if (!queue) return;
  if (queue.active === job.id) queue.active = null;
  else queue.pending = queue.pending.filter((id) => id !== job.id);
  if (!queue.active && !queue.pending.length) ttsQueues.delete(queue.key);
  else dispatchNextTts(queue);
}

function failTtsForTarget(roomHash, participantId, error) {
  const queue = ttsQueues.get(ttsQueueKey(roomHash, participantId));
  if (!queue) return;
  for (const id of [queue.active, ...queue.pending].filter(Boolean)) {
    const job = ttsJobs.get(id);
    if (job) finishTtsJob(job, 'error', error);
  }
}

function consumeTtsRate(roomHash, participantId) {
  const key = `${roomHash}:${participantId}`;
  const now = Date.now();
  const timestamps = (ttsRateWindows.get(key) || []).filter((at) => now - at < 60_000);
  if (timestamps.length >= TTS_RATE_LIMIT) {
    ttsRateWindows.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  ttsRateWindows.set(key, timestamps);
  return true;
}

async function allowedVoicesWithPreviews() {
  if (voiceMetadataCache.expiresAt > Date.now()) return voiceMetadataCache.voices;
  if (TTS_PROVIDER === 'cosyvoice') return ALLOWED_VOICES;
  const voices = await Promise.all(ALLOWED_VOICES.map(async (voice) => {
    if (!ELEVENLABS_KEY) return voice;
    try {
      const response = await fetch(`${ELEVENLABS_BASE_URL}/v1/voices/${encodeURIComponent(voice.id)}`, {
        headers: { 'xi-api-key': ELEVENLABS_KEY },
      });
      if (!response.ok) return voice;
      const metadata = await response.json();
      return { ...voice, previewUrl: metadata?.preview_url || undefined };
    } catch {
      return voice;
    }
  }));
  voiceMetadataCache = { expiresAt: Date.now() + 10 * 60_000, voices };
  return voices;
}

async function fetchByokVoices(apiKey) {
  const response = await fetch(`${ELEVENLABS_BASE_URL}/v2/voices?page_size=100`, {
    headers: { 'xi-api-key': apiKey },
  });
  if (!response.ok) {
    const error = new Error(response.status === 401 ? 'tts_byok_unauthorized' : 'tts_byok_unavailable');
    error.status = response.status;
    throw error;
  }
  const body = await response.json();
  return (Array.isArray(body?.voices) ? body.voices : []).map((voice) => ({
    id: String(voice?.voice_id || ''),
    label: String(voice?.name || voice?.voice_id || 'Voice'),
    previewUrl: voice?.preview_url || undefined,
  })).filter((voice) => voice.id);
}

function apiKeyForJob(job) {
  if (job.credentialMode === 'managed') return ELEVENLABS_KEY;
  const room = rooms.get(job.roomHash);
  const requester = room?.participants.get(job.requesterId);
  const controllerSocket = requester?.controller ? io.sockets.sockets.get(requester.controller) : null;
  return controllerSocket?.data?.elevenlabsKey || '';
}

function streamCosyVoice(job, res) {
  return new Promise((resolve, reject) => {
    const taskId = randomUUID();
    let settled = false;
    let audioStarted = false;
    const ws = new WebSocket(COSYVOICE_WS_URL, {
      headers: {
        Authorization: `Bearer ${COSYVOICE_KEY}`,
        'User-Agent': 'desktop-pet-server/1.3',
        ...(COSYVOICE_WORKSPACE_ID ? { 'X-DashScope-WorkSpace': COSYVOICE_WORKSPACE_ID } : {}),
      },
    });
    let timeout;
    const cleanup = () => clearTimeout(timeout);
    const complete = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!res.writableEnded) res.end();
      ws.close();
      resolve();
    };
    const fail = (code, detail) => {
      if (settled) return;
      settled = true;
      cleanup();
      ws.close();
      reject(Object.assign(new Error(detail || code), { code }));
    };
    timeout = setTimeout(() => fail('tts_upstream_unavailable', 'CosyVoice timeout'), Math.max(TTS_JOB_TTL_MS, 30_000));
    const send = (action, payload) => ws.send(JSON.stringify({
      header: { action, task_id: taskId, streaming: 'duplex' },
      payload,
    }));

    ws.on('open', () => send('run-task', {
      task_group: 'audio',
      task: 'tts',
      function: 'SpeechSynthesizer',
      model: COSYVOICE_MODEL,
      parameters: {
        text_type: 'PlainText',
        voice: job.voiceId,
        format: 'mp3',
        sample_rate: 44100,
        volume: 50,
        rate: 1,
        pitch: 1,
        language_hints: ['zh'],
        enable_ssml: false,
      },
      input: {},
    }));
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        audioStarted = true;
        if (!res.write(Buffer.from(data))) ws.pause();
        return;
      }
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { return; }
      const event = message?.header?.event;
      if (event === 'task-started') {
        send('continue-task', { input: { text: job.text } });
        send('finish-task', { input: {} });
      } else if (event === 'task-finished') {
        complete();
      } else if (event === 'task-failed') {
        const status = Number(message?.header?.status_code || message?.header?.status || 0);
        const code = status === 401 || status === 403 ? 'tts_upstream_unauthorized'
          : status === 429 ? 'tts_upstream_rate_limited' : 'tts_upstream_error';
        fail(code, message?.header?.error_message || message?.header?.message);
      }
    });
    res.on('drain', () => ws.resume());
    res.on('close', () => {
      if (!res.writableEnded && !settled) {
        settled = true;
        cleanup();
        ws.close();
        resolve();
      }
    });
    ws.on('unexpected-response', (_request, response) => {
      const code = response.statusCode === 401 || response.statusCode === 403
        ? 'tts_upstream_unauthorized'
        : response.statusCode === 429 ? 'tts_upstream_rate_limited' : 'tts_upstream_error';
      fail(code, `CosyVoice HTTP ${response.statusCode}`);
    });
    ws.on('error', (error) => {
      if (!settled) fail(audioStarted ? 'tts_stream_failed' : 'tts_upstream_unavailable', error.message);
    });
    ws.on('close', () => {
      if (!settled) fail(audioStarted ? 'tts_stream_failed' : 'tts_upstream_unavailable', 'CosyVoice connection closed');
    });
  });
}

function failByokJobsForRequester(roomHash, participantId) {
  for (const job of [...ttsJobs.values()]) {
    if (job.roomHash === roomHash && job.requesterId === participantId && job.credentialMode === 'byok') {
      finishTtsJob(job, 'error', 'tts_byok_disconnected');
    }
  }
}

app.get('/api/tts/jobs/:jobId', async (req, res) => {
  const job = ttsJobs.get(String(req.params.jobId || ''));
  if (!job || job.finished || Date.now() > job.expiresAt) {
    return res.status(410).json({ error: 'tts_job_expired' });
  }
  if (job.consumed) return res.status(410).json({ error: 'tts_job_already_used' });
  job.consumed = true;
  emitTtsStatus(job, 'generating');
  const apiKey = job.provider === 'elevenlabs' ? apiKeyForJob(job) : COSYVOICE_KEY;
  if (!apiKey || (job.provider === 'cosyvoice' && !COSYVOICE_WS_URL)) {
    finishTtsJob(job, 'error', 'tts_credentials_unavailable');
    return res.status(503).json({ error: 'tts_credentials_unavailable' });
  }

  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });
  try {
    if (job.provider === 'cosyvoice') {
      res.status(200);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store, private');
      await streamCosyVoice(job, res);
      return;
    }
    const upstream = await fetch(
      `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(job.voiceId)}/stream?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text: job.text,
          model_id: ELEVENLABS_MODEL,
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true },
        }),
        signal: abortController.signal,
      }
    );
    if (!upstream.ok || !upstream.body) {
      const code = upstream.status === 401 ? 'tts_upstream_unauthorized'
        : upstream.status === 429 ? 'tts_upstream_rate_limited'
          : 'tts_upstream_error';
      const detail = await upstream.text().catch(() => '');
      console.warn('[tts] upstream failed:', upstream.status, detail.slice(0, 300));
      finishTtsJob(job, 'error', code);
      return res.status(upstream.status || 502).json({ error: code });
    }
    res.status(200);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store, private');
    Readable.fromWeb(upstream.body).on('error', (error) => {
      console.warn('[tts] stream failed:', error?.message || error);
      finishTtsJob(job, 'error', 'tts_stream_failed');
      res.destroy(error);
    }).pipe(res);
  } catch (error) {
    if (error?.name !== 'AbortError') console.warn('[tts] request failed:', error?.message || error);
    const code = error?.name === 'AbortError' ? 'tts_stream_cancelled' : error?.code || 'tts_upstream_unavailable';
    finishTtsJob(job, 'error', code);
    if (!res.headersSent) res.status(502).json({ error: code });
    else if (!res.writableEnded) res.destroy(error);
  }
});

io.on('connection', (socket) => {
  socket.on('pairing:discover', (data, ack) => {
    if (data?.protocolVersion !== 2) {
      if (typeof ack === 'function') ack({ ok: false, code: 'upgrade_required' });
      return;
    }
    const roomHash = hashSecret(String(data?.secret || ''));
    if (!ROOM_SECRET_HASHES.has(roomHash)) {
      if (typeof ack === 'function') ack({ ok: false, code: 'bad_secret' });
      return;
    }
    if (typeof ack === 'function') ack({ ok: true, members: store.memberDisplayNames(roomHash) });
  });

  socket.on('pet:join', (data, ack) => {
    const secret = String(data?.secret || '');
    const role = data?.role;
    const roomHash = hashSecret(secret);
    if (!ROOM_SECRET_HASHES.has(roomHash)) {
      if (typeof ack === 'function') ack({ ok: false, code: 'bad_secret', error: 'bad secret' });
      console.warn('[socket] reject bad secret from', socket.id);
      return;
    }
    if (role !== 'controller' && role !== 'pet') {
      if (typeof ack === 'function') ack({ ok: false, code: 'bad_role', error: 'bad role' });
      return;
    }

    if (data?.protocolVersion !== 2 || !['a', 'b'].includes(data?.memberId)
      || !String(data?.deviceId || '').trim() || !String(data?.deviceName || '').trim()) {
      if (typeof ack === 'function') ack({ ok: false, code: 'upgrade_required', error: 'protocol v2 required' });
      return;
    }
    let room = rooms.get(roomHash);
    if (!room) {
      room = { hash: roomHash, participants: new Map(), callId: null };
      rooms.set(roomHash, room);
    }
    const participantId = String(data.deviceId).slice(0, 128);
    const memberId = data.memberId;
    let participant = room.participants.get(participantId);
    if (participant && participant.memberId !== memberId) {
      if (typeof ack === 'function') ack({ ok: false, code: 'device_identity_conflict' });
      return;
    }
    if (!participant) {
      participant = { id: participantId, memberId, pet: null, controller: null, releaseTimer: null };
      room.participants.set(participantId, participant);
    }
    store.touchDevice(roomHash, memberId, participantId, String(data.deviceName).trim().slice(0, 80));
    if (participant.releaseTimer) {
      clearTimeout(participant.releaseTimer);
      participant.releaseTimer = null;
    }

    // 同一参与者的同类端点重连时只替换自己，不影响房间内另一人。
    const prevId = participant[role];
    participant[role] = socket.id;
    if (prevId && prevId !== socket.id) {
      const prev = io.sockets.sockets.get(prevId);
      if (prev) {
        prev.emit('room:kicked', { reason: 'replaced' });
        prev.disconnect(true);
      }
    }
    socket.data.role = role;
    socket.data.roomHash = roomHash;
    socket.data.participantId = participantId;
    socket.data.memberId = memberId;
    socket.join(roomChannel(roomHash));
    if (typeof ack === 'function') ack({ ok: true, peers: peerSnapshot(room, participantId) });
    emitPeerSnapshots(room);
    console.log(`[socket] ${role} joined room=${roomHash.slice(0, 8)} member=${memberId} device=${participantId}`);
  });

  socket.on('room:rename-member', (payload, ack) => {
    const room = roomForSocket(socket);
    const memberId = payload?.memberId;
    const displayName = String(payload?.displayName || '').trim().slice(0, 40);
    if (!room || !['a', 'b'].includes(memberId) || !displayName) {
      if (typeof ack === 'function') ack({ ok: false, code: 'invalid_name' });
      return;
    }
    store.renameMember(room.hash, memberId, displayName);
    emitPeerSnapshots(room);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('device:reclaim', (payload, ack) => {
    const room = roomForSocket(socket);
    const oldDeviceId = String(payload?.deviceId || '');
    const oldRuntime = room?.participants.get(oldDeviceId);
    if (!room || !oldDeviceId || oldRuntime?.pet || oldRuntime?.controller) {
      if (typeof ack === 'function') ack({ ok: false, code: oldRuntime ? 'device_online' : 'device_not_found' });
      return;
    }
    const current = participantForSocket(socket);
    const item = store.reclaimDevice(room.hash, socket.data.memberId, oldDeviceId, current.id, String(payload?.deviceName || '').trim().slice(0, 80) || store.devices(room.hash, socket.data.memberId).find((device) => device.id === oldDeviceId)?.name || '设备');
    if (!item) return typeof ack === 'function' && ack({ ok: false, code: 'device_not_found' });
    room.participants.delete(oldDeviceId);
    emitPeerSnapshots(room);
    if (typeof ack === 'function') ack({ ok: true, device: item });
  });

  socket.on('device:change-member', (payload, ack) => {
    const room = roomForSocket(socket);
    const participant = participantForSocket(socket);
    const sourceMemberId = socket.data?.memberId;
    const targetMemberId = payload?.targetMemberId;
    if (!room || !participant || socket.data?.role !== 'controller' || !['a', 'b'].includes(sourceMemberId)) {
      if (typeof ack === 'function') ack({ ok: false, code: 'not_joined' });
      return;
    }
    if (!['a', 'b'].includes(targetMemberId)) {
      if (typeof ack === 'function') ack({ ok: false, code: 'invalid_member' });
      return;
    }
    if (targetMemberId === sourceMemberId) {
      if (typeof ack === 'function') ack({ ok: true, memberId: sourceMemberId });
      return;
    }
    let moved;
    try {
      moved = store.moveDevice(room.hash, sourceMemberId, targetMemberId, participant.id);
    } catch (error) {
      console.warn('[socket] move device failed:', error?.message || error);
      if (typeof ack === 'function') ack({ ok: false, code: 'device_move_failed' });
      return;
    }
    if (!moved.ok) {
      if (typeof ack === 'function') ack({ ok: false, code: moved.code });
      return;
    }
    if (room.call && [room.call.initiatorDeviceId, room.call.targetDeviceId].includes(participant.id)) endRoomCall(room, 'identity_changed');
    participant.memberId = targetMemberId;
    for (const socketId of [participant.pet, participant.controller]) {
      const endpoint = socketId && io.sockets.sockets.get(socketId);
      if (endpoint) endpoint.data.memberId = targetMemberId;
    }
    emitPeerSnapshots(room);
    if (typeof ack === 'function') ack({ ok: true, memberId: targetMemberId, device: moved.device });
  });

  socket.on('audio:list', (payload, ack) => {
    if (typeof payload === 'function') ack = payload;
    const room = roomForSocket(socket);
    if (typeof ack === 'function') ack(room ? { ok: true, items: store.audio(room.hash, socket.data.memberId) } : { ok: false, code: 'not_joined', items: [] });
  });

  socket.on('audio:add', (payload, ack) => {
    const room = roomForSocket(socket);
    const data = Buffer.isBuffer(payload?.data) ? payload.data : Buffer.from(payload?.data || []);
    const mime = String(payload?.mime || '').toLowerCase().split(';', 1)[0].trim();
    const allowed = new Map([
      ['audio/mpeg', 'mp3'], ['audio/mp3', 'mp3'], ['audio/wav', 'wav'], ['audio/x-wav', 'wav'],
      ['audio/ogg', 'ogg'], ['audio/mp4', 'm4a'], ['audio/x-m4a', 'm4a'], ['audio/webm', 'webm'],
    ]);
    const name = String(payload?.name || '').trim().slice(0, 80);
    const durationMs = Number(payload?.durationMs || 0);
    if (!room) return typeof ack === 'function' && ack({ ok: false, code: 'not_joined' });
    if (!name || !allowed.has(mime) || !data.length || data.length > 10 * 1024 * 1024 || durationMs <= 0 || durationMs > 60_000) {
      return typeof ack === 'function' && ack({ ok: false, code: 'invalid_audio' });
    }
    if (store.audio(room.hash, socket.data.memberId).length >= 100) {
      return typeof ack === 'function' && ack({ ok: false, code: 'audio_limit_reached' });
    }
    const item = store.addAudio(room.hash, socket.data.memberId, { name, mime, extension: allowed.get(mime), durationMs, data });
    if (typeof ack === 'function') ack({ ok: true, item });
  });

  socket.on('audio:rename', (payload, ack) => {
    const room = roomForSocket(socket);
    const name = String(payload?.name || '').trim().slice(0, 80);
    const item = room && name ? store.renameAudio(room.hash, socket.data.memberId, String(payload?.audioId || ''), name) : null;
    if (typeof ack === 'function') ack(item ? { ok: true, item } : { ok: false, code: 'audio_not_found' });
  });

  socket.on('audio:delete', (payload, ack) => {
    const room = roomForSocket(socket);
    const ok = !!room && store.deleteAudio(room.hash, socket.data.memberId, String(payload?.audioId || ''));
    if (typeof ack === 'function') ack(ok ? { ok: true } : { ok: false, code: 'audio_not_found' });
  });

  socket.on('audio:get', (payload, ack) => {
    const room = roomForSocket(socket);
    const audio = room && store.audioPath(room.hash, socket.data.memberId, String(payload?.audioId || ''));
    if (!audio) return typeof ack === 'function' && ack({ ok: false, code: 'audio_not_found' });
    try { if (typeof ack === 'function') ack({ ok: true, mime: audio.item.mime, data: fs.readFileSync(audio.file) }); }
    catch { if (typeof ack === 'function') ack({ ok: false, code: 'audio_unavailable' }); }
  });

  socket.on('audio:play', (payload, ack) => {
    const room = roomForSocket(socket);
    const target = room && otherParticipant(room, socket.data.participantId, payload?.targetDeviceId);
    const audio = room && store.audioPath(room.hash, socket.data.memberId, String(payload?.audioId || ''));
    if (!target?.pet) return typeof ack === 'function' && ack({ ok: false, code: 'peer_pet_offline' });
    if (!audio) return typeof ack === 'function' && ack({ ok: false, code: 'audio_not_found' });
    try {
      const data = fs.readFileSync(audio.file);
      io.to(target.pet).emit('audio:play', { id: audio.item.id, name: audio.item.name, mime: audio.item.mime, data });
      if (typeof ack === 'function') ack({ ok: true });
    } catch {
      if (typeof ack === 'function') ack({ ok: false, code: 'audio_unavailable' });
    }
  });

  socket.on('pet:command', (cmd) => {
    if (socket.data?.role !== 'controller') return;
    const room = roomForSocket(socket);
    const petId = room && otherParticipant(room, socket.data.participantId, cmd?.targetDeviceId)?.pet;
    if (!petId) return;
    const { targetDeviceId: _targetDeviceId, ...command } = cmd || {};
    io.to(petId).emit('pet:command', command);
  });

  // controller 想知道 pet 当前有哪些预录台词；ack 链：server 转发给 pet，pet 回 callback。
  socket.on('pet:list-voices', (payload, ack) => {
    if (socket.data?.role !== 'controller') {
      if (typeof ack === 'function') ack([]);
      return;
    }
    const room = roomForSocket(socket);
    const petId = room && otherParticipant(room, socket.data.participantId, payload?.targetDeviceId)?.pet;
    if (!petId) {
      if (typeof ack === 'function') ack([]);
      return;
    }
    io.to(petId).timeout(3000).emit('pet:list-voices', (err, replies) => {
      if (err || !replies?.length) {
        if (typeof ack === 'function') ack([]);
        return;
      }
      if (typeof ack === 'function') ack(replies[0] || []);
    });
  });

  socket.on('pet:list-motions', (payload, ack) => {
    if (socket.data?.role !== 'controller') {
      if (typeof ack === 'function') ack([]);
      return;
    }
    const room = roomForSocket(socket);
    const petId = room && otherParticipant(room, socket.data.participantId, payload?.targetDeviceId)?.pet;
    if (!petId) {
      if (typeof ack === 'function') ack([]);
      return;
    }
    io.to(petId).timeout(3000).emit('pet:list-motions', (err, replies) => {
      if (err || !replies?.length) {
        if (typeof ack === 'function') ack([]);
        return;
      }
      if (typeof ack === 'function') ack(replies[0] || []);
    });
  });

  socket.on('tts:set-credentials', async (payload, ack) => {
    if (socket.data?.role !== 'controller' || !roomForSocket(socket)) {
      if (typeof ack === 'function') ack({ ok: false, code: 'not_joined', voices: [] });
      return;
    }
    const apiKey = String(payload?.apiKey || '').trim();
    if (!apiKey) {
      delete socket.data.elevenlabsKey;
      delete socket.data.elevenlabsVoices;
      const voices = await allowedVoicesWithPreviews();
      if (typeof ack === 'function') ack({
        ok: managedTtsReady(), mode: 'managed', provider: TTS_PROVIDER, voices,
        code: !managedTtsReady() ? 'tts_not_configured' : voices.length ? undefined : 'tts_no_voices',
      });
      return;
    }
    if (TTS_PROVIDER !== 'elevenlabs') {
      if (typeof ack === 'function') ack({
        ok: false, mode: 'managed', provider: TTS_PROVIDER,
        code: 'tts_byok_not_supported', voices: [],
      });
      return;
    }
    try {
      const voices = await fetchByokVoices(apiKey);
      socket.data.elevenlabsKey = apiKey;
      socket.data.elevenlabsVoices = voices;
      if (typeof ack === 'function') ack({ ok: true, mode: 'byok', provider: 'elevenlabs', voices });
    } catch (error) {
      delete socket.data.elevenlabsKey;
      delete socket.data.elevenlabsVoices;
      if (typeof ack === 'function') ack({ ok: false, code: error?.message || 'tts_byok_unavailable', voices: [] });
    }
  });

  socket.on('tts:list-voices', async (ack) => {
    if (socket.data?.role !== 'controller' || !roomForSocket(socket)) {
      if (typeof ack === 'function') ack({ ok: false, code: 'not_joined', voices: [] });
      return;
    }
    if (socket.data.elevenlabsKey && Array.isArray(socket.data.elevenlabsVoices)) {
      if (typeof ack === 'function') ack({ ok: true, mode: 'byok', provider: 'elevenlabs', voices: socket.data.elevenlabsVoices });
      return;
    }
    const voices = await allowedVoicesWithPreviews();
    if (typeof ack === 'function') ack({
      ok: managedTtsReady(),
      mode: 'managed',
      provider: TTS_PROVIDER,
      code: !managedTtsReady() ? 'tts_not_configured' : voices.length ? undefined : 'tts_no_voices',
      voices,
    });
  });

  socket.on('tts:create', (payload, ack) => {
    if (socket.data?.role !== 'controller') {
      if (typeof ack === 'function') ack({ ok: false, code: 'not_controller' });
      return;
    }
    const room = roomForSocket(socket);
    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, code: 'not_joined' });
      return;
    }
    const byokVoices = Array.isArray(socket.data.elevenlabsVoices) ? socket.data.elevenlabsVoices : [];
    const credentialMode = socket.data.elevenlabsKey ? 'byok' : 'managed';
    const allowedIds = credentialMode === 'byok'
      ? new Set(byokVoices.map((voice) => voice.id))
      : ALLOWED_VOICE_IDS;
    if (credentialMode === 'managed' && !managedTtsReady()) {
      if (typeof ack === 'function') ack({ ok: false, code: 'tts_not_configured' });
      return;
    }
    const text = String(payload?.text || '').trim();
    const voiceId = String(payload?.voiceId || '').trim();
    if (!text) {
      if (typeof ack === 'function') ack({ ok: false, code: 'tts_text_required' });
      return;
    }
    if (text.length > 200) {
      if (typeof ack === 'function') ack({ ok: false, code: 'tts_text_too_long' });
      return;
    }
    if (!allowedIds.has(voiceId)) {
      if (typeof ack === 'function') ack({ ok: false, code: 'tts_voice_not_allowed' });
      return;
    }
    const target = otherParticipant(room, socket.data.participantId, payload?.targetDeviceId);
    if (!target?.pet) {
      if (typeof ack === 'function') ack({ ok: false, code: 'peer_pet_offline' });
      return;
    }
    const queue = ttsQueueFor(room.hash, target.id);
    const depth = (queue.active ? 1 : 0) + queue.pending.length;
    if (depth >= TTS_QUEUE_LIMIT) {
      if (typeof ack === 'function') ack({ ok: false, code: 'tts_queue_full' });
      return;
    }
    if (!consumeTtsRate(room.hash, socket.data.participantId)) {
      if (typeof ack === 'function') ack({ ok: false, code: 'tts_rate_limited' });
      return;
    }
    const job = {
      id: randomUUID(), roomHash: room.hash,
      requesterId: socket.data.participantId, targetId: target.id,
      text, voiceId, credentialMode,
      provider: credentialMode === 'byok' ? 'elevenlabs' : TTS_PROVIDER,
      state: 'queued', consumed: false, finished: false, expiresAt: 0, expiryTimer: null,
    };
    ttsJobs.set(job.id, job);
    queue.pending.push(job.id);
    dispatchNextTts(queue);
    const position = queue.active === job.id ? 0 : queue.pending.indexOf(job.id) + 1;
    if (typeof ack === 'function') ack({ ok: true, jobId: job.id, state: position ? 'queued' : 'dispatched', position });
  });

  socket.on('tts:status', (payload) => {
    if (socket.data?.role !== 'pet') return;
    const job = ttsJobs.get(String(payload?.jobId || ''));
    if (!job || job.targetId !== socket.data.participantId || job.roomHash !== socket.data.roomHash) return;
    const state = String(payload?.state || '');
    if (state === 'playing') emitTtsStatus(job, 'playing');
    else if (state === 'completed') finishTtsJob(job, 'completed');
    else if (state === 'error') finishTtsJob(job, 'error', String(payload?.error || 'tts_playback_failed').slice(0, 120));
  });

  socket.on('webrtc:signal', (payload) => {
    const room = roomForSocket(socket);
    if (!room) return;
    if (payload?.callId && payload.callId !== room.callId) return;
    const role = socket.data?.role;
    const targetRole = role === 'controller' ? 'pet' : role === 'pet' ? 'controller' : null;
    const pairedDeviceId = room.call && (socket.data.participantId === room.call.initiatorDeviceId
      ? room.call.targetDeviceId : room.call.initiatorDeviceId);
    const targetId = targetRole && otherParticipant(room, socket.data.participantId, payload?.targetDeviceId || pairedDeviceId)?.[targetRole];
    if (!targetId) return;
    io.to(targetId).emit('webrtc:signal', payload);
  });

  socket.on('webrtc:get-config', (ack) => {
    if (typeof ack !== 'function') return;
    if (!roomForSocket(socket)) {
      ack({ ok: false, code: 'not_joined' });
      return;
    }
    ack({ ok: true, ...rtcConfigFor(socket.data.participantId) });
  });

  socket.on('webrtc:media-status', (payload) => {
    const room = roomForSocket(socket);
    if (!room || socket.data?.role !== 'pet' || payload?.callId !== room.callId) return;
    const media = String(payload?.media || '');
    const state = String(payload?.state || '');
    if (!['screen', 'microphone', 'system-audio'].includes(media)) return;
    if (!['available', 'paused', 'unavailable'].includes(state)) return;
    const pairedDeviceId = socket.data.participantId === room.call?.initiatorDeviceId ? room.call?.targetDeviceId : room.call?.initiatorDeviceId;
    const targetId = otherParticipant(room, socket.data.participantId, pairedDeviceId)?.controller;
    if (!targetId) return;
    const allowedReasons = new Set(['relay_audio_only', 'capture_failed', 'track_ended']);
    const reason = allowedReasons.has(payload?.reason) ? payload.reason : undefined;
    io.to(targetId).emit('webrtc:media-status', {
      callId: room.callId, media, state, ...(reason ? { reason } : {}),
    });
  });

  socket.on('call:start', (payload, ack) => {
    const room = roomForSocket(socket);
    if (!room || socket.data?.role !== 'controller') return;
    const peer = otherParticipant(room, socket.data.participantId, payload?.targetDeviceId);
    const self = participantForSocket(socket);
    if (!peer?.pet || !peer?.controller || !self?.pet || !self?.controller) {
      if (typeof ack === 'function') ack({ ok: false, code: 'peer_not_ready' });
      return;
    }
    if (!room.callId) {
      room.callId = randomUUID();
      room.call = { initiatorDeviceId: self.id, targetDeviceId: peer.id };
    }
    for (const participant of [self, peer]) if (participant.controller) {
      io.to(participant.controller).emit('call:start', { callId: room.callId, peerDeviceId: participant.id === self.id ? peer.id : self.id });
    }
    if (typeof ack === 'function') ack({ ok: true, callId: room.callId });
  });

  socket.on('call:end', (payload) => {
    const room = roomForSocket(socket);
    if (!room || (payload?.callId && payload.callId !== room.callId)) return;
    endRoomCall(room, 'ended');
  });

  socket.on('webrtc:hangup', () => {
    const room = roomForSocket(socket);
    if (room?.callId) endRoomCall(room, 'hangup');
  });

  socket.on('webrtc:error', (payload) => {
    const room = roomForSocket(socket);
    const role = socket.data?.role;
    const targetRole = role === 'controller' ? 'pet' : role === 'pet' ? 'controller' : null;
    const pairedDeviceId = room?.call && (socket.data.participantId === room.call.initiatorDeviceId
      ? room.call.targetDeviceId : room.call.initiatorDeviceId);
    const targetId = room && targetRole && otherParticipant(room, socket.data.participantId, pairedDeviceId)?.[targetRole];
    if (!targetId) return;
    io.to(targetId).emit('webrtc:error', payload);
  });

  socket.on('disconnect', () => {
    const room = roomForSocket(socket);
    const participant = participantForSocket(socket);
    const role = socket.data?.role;
    if (!room || !participant || !role || participant[role] !== socket.id) return;
    participant[role] = null;
    if (role === 'pet') failTtsForTarget(room.hash, participant.id, 'peer_pet_offline');
    if (role === 'controller') failByokJobsForRequester(room.hash, participant.id);
    if (room.call && [room.call.initiatorDeviceId, room.call.targetDeviceId].includes(participant.id)) endRoomCall(room, 'peer_disconnected');
    if (!participantOnline(participant)) {
      participant.releaseTimer = setTimeout(() => {
        if (participantOnline(participant)) return;
        room.participants.delete(participant.id);
        if (!room.participants.size) rooms.delete(room.hash);
        else emitPeerSnapshots(room);
      }, ROOM_GRACE_MS);
    }
    emitPeerSnapshots(room);
    console.log(`[socket] ${role} left participant=${participant.id}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`pet server listening on :${PORT}`);
  console.log(`  tts:    ${managedTtsReady() ? `${TTS_PROVIDER} managed (${managedTtsModel()}, voices=${ALLOWED_VOICES.length})` : `${TTS_PROVIDER} managed disabled`}${TTS_PROVIDER === 'elevenlabs' ? '; BYOK available' : ''}`);
  console.log(`  socket: ready @ /socket.io  (configured rooms=${ROOM_SECRET_HASHES.size})`);
  console.log(`  rtc:    stun=${RTC_STUN_URLS.length} turn=${RTC_TURN_URLS.length && RTC_TURN_SHARED_SECRET ? RTC_TURN_URLS.length : 0} policy=${RTC_ICE_TRANSPORT_POLICY}${RTC_TURN_REALM ? ` realm=${RTC_TURN_REALM}` : ''}`);
});
