import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import { Server as SocketIOServer } from 'socket.io';

const PORT = process.env.PORT || 3030;

// === TTS（ElevenLabs）===
const ELEVENLABS_KEY = process['env']['ELEVENLABS_API_KEY'];
const ELEVENLABS_BASE_URL = String(process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
const TTS_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
const TTS_JOB_TTL_MS = Math.max(5_000, Number(process.env.TTS_JOB_TTL_MS || 60_000));
const TTS_RATE_LIMIT = Math.max(1, Number(process.env.TTS_RATE_LIMIT || 10));
const TTS_QUEUE_LIMIT = 3;

function loadAllowedVoices() {
  const legacyId = String(process.env.ELEVENLABS_VOICE_ID || '').trim();
  const raw = String(process.env.ELEVENLABS_VOICES_JSON || '').trim();
  let parsed = [];
  if (raw) {
    try { parsed = JSON.parse(raw); }
    catch (error) { console.warn('[tts] invalid ELEVENLABS_VOICES_JSON:', error?.message || error); }
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

// === Socket.IO 房间 / 鉴权 ===
// 房间密钥由服务端预配置。ROOM_SECRETS 支持逗号分隔；ROOM_SECRET 保持 v1.1 兼容。
const ROOM_SECRET_HASHES = new Set(
  String(process.env.ROOM_SECRETS || process.env.ROOM_SECRET || 'change-me')
    .split(',').map((value) => value.trim()).filter(Boolean).map(hashSecret)
);
const ROOM_GRACE_MS = Math.max(0, Number(process.env.ROOM_GRACE_MS || 30_000));

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    tts: ELEVENLABS_KEY && ALLOWED_VOICES.length ? 'ready' : 'disabled',
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

function otherParticipant(room, participantId) {
  return [...room.participants.values()].find((p) => p.id !== participantId) || null;
}

function participantOnline(participant) {
  return !!(participant?.pet || participant?.controller);
}

function peerSnapshot(room, participantId) {
  const self = room.participants.get(participantId);
  const peer = otherParticipant(room, participantId);
  return {
    selfReady: !!(self?.pet && self?.controller),
    peerOnline: participantOnline(peer),
    peerPetOnline: !!peer?.pet,
    peerControllerOnline: !!peer?.controller,
    // v1.1 UI compatibility: from this participant's perspective these mean remote endpoints.
    pet: !!peer?.pet,
    controller: !!peer?.controller,
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
  room.callId = null;
  emitToRoomEndpoints(room, 'call:end', { callId, reason });
  emitToRoomEndpoints(room, 'webrtc:hangup', { callId, reason });
}

// === ElevenLabs TTS jobs ===
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
  const apiKey = apiKeyForJob(job);
  if (!apiKey) {
    finishTtsJob(job, 'error', 'tts_credentials_unavailable');
    return res.status(503).json({ error: 'tts_credentials_unavailable' });
  }

  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });
  try {
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
          model_id: TTS_MODEL,
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
    finishTtsJob(job, 'error', error?.name === 'AbortError' ? 'tts_stream_cancelled' : 'tts_upstream_unavailable');
    if (!res.headersSent) res.status(502).json({ error: 'tts_upstream_unavailable' });
  }
});

io.on('connection', (socket) => {
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

    let room = rooms.get(roomHash);
    if (!room) {
      room = { hash: roomHash, participants: new Map(), callId: null };
      rooms.set(roomHash, room);
    }
    // 老客户端没有 participantId：controller 与 pet 各视为一名参与者，保持旧式配对。
    const participantId = String(data?.participantId || `legacy-${role}`).slice(0, 128);
    let participant = room.participants.get(participantId);
    if (!participant && room.participants.size >= 2) {
      if (typeof ack === 'function') ack({ ok: false, code: 'room_full', error: 'room full' });
      return;
    }
    if (!participant) {
      participant = { id: participantId, pet: null, controller: null, releaseTimer: null };
      room.participants.set(participantId, participant);
    }
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
    socket.join(roomChannel(roomHash));
    if (typeof ack === 'function') ack({ ok: true, peers: peerSnapshot(room, participantId) });
    emitPeerSnapshots(room);
    console.log(`[socket] ${role} joined room=${roomHash.slice(0, 8)} participant=${participantId}`);
  });

  socket.on('pet:command', (cmd) => {
    if (socket.data?.role !== 'controller') return;
    const room = roomForSocket(socket);
    const petId = room && otherParticipant(room, socket.data.participantId)?.pet;
    if (!petId) return;
    io.to(petId).emit('pet:command', cmd);
  });

  // controller 想知道 pet 当前有哪些预录台词；ack 链：server 转发给 pet，pet 回 callback。
  socket.on('pet:list-voices', (ack) => {
    if (socket.data?.role !== 'controller') {
      if (typeof ack === 'function') ack([]);
      return;
    }
    const room = roomForSocket(socket);
    const petId = room && otherParticipant(room, socket.data.participantId)?.pet;
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

  socket.on('pet:list-motions', (ack) => {
    if (socket.data?.role !== 'controller') {
      if (typeof ack === 'function') ack([]);
      return;
    }
    const room = roomForSocket(socket);
    const petId = room && otherParticipant(room, socket.data.participantId)?.pet;
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
      if (typeof ack === 'function') ack({ ok: true, mode: 'managed', voices: await allowedVoicesWithPreviews() });
      return;
    }
    try {
      const voices = await fetchByokVoices(apiKey);
      socket.data.elevenlabsKey = apiKey;
      socket.data.elevenlabsVoices = voices;
      if (typeof ack === 'function') ack({ ok: true, mode: 'byok', voices });
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
      if (typeof ack === 'function') ack({ ok: true, mode: 'byok', voices: socket.data.elevenlabsVoices });
      return;
    }
    const voices = await allowedVoicesWithPreviews();
    if (typeof ack === 'function') ack({
      ok: !!(ELEVENLABS_KEY && voices.length),
      mode: 'managed',
      code: !ELEVENLABS_KEY ? 'tts_not_configured' : voices.length ? undefined : 'tts_no_voices',
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
    if (credentialMode === 'managed' && (!ELEVENLABS_KEY || !ALLOWED_VOICES.length)) {
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
    const target = otherParticipant(room, socket.data.participantId);
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
    const targetId = targetRole && otherParticipant(room, socket.data.participantId)?.[targetRole];
    if (!targetId) return;
    io.to(targetId).emit('webrtc:signal', payload);
  });

  socket.on('call:start', (ack) => {
    const room = roomForSocket(socket);
    if (!room || socket.data?.role !== 'controller') return;
    const peer = otherParticipant(room, socket.data.participantId);
    const ready = room.participants.size === 2
      && [...room.participants.values()].every((p) => p.pet && p.controller);
    if (!peer || !ready) {
      if (typeof ack === 'function') ack({ ok: false, code: 'peer_not_ready' });
      return;
    }
    if (!room.callId) room.callId = randomUUID();
    for (const participant of room.participants.values()) {
      if (participant.controller) io.to(participant.controller).emit('call:start', { callId: room.callId });
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
    const targetId = room && targetRole && otherParticipant(room, socket.data.participantId)?.[targetRole];
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
    endRoomCall(room, 'peer_disconnected');
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
  console.log(`  tts:    ${ELEVENLABS_KEY && ALLOWED_VOICES.length ? `managed (${TTS_MODEL}, voices=${ALLOWED_VOICES.length})` : 'managed disabled; BYOK available'}`);
  console.log(`  socket: ready @ /socket.io  (configured rooms=${ROOM_SECRET_HASHES.size})`);
});
