import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { createHash, randomUUID } from 'crypto';
import { Server as SocketIOServer } from 'socket.io';
import { getPersona, buildSystemPrompt } from './prompts.js';

const PORT = process.env.PORT || 3030;

// === Chat（DeepSeek，OpenAI 兼容接口）===
const DEEPSEEK_KEY = process['env']['DEEPSEEK_API_KEY'];
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const DEEPSEEK_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions';

// === TTS（ElevenLabs）===
const ELEVENLABS_KEY = process['env']['ELEVENLABS_API_KEY'];
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const TTS_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

// === Socket.IO 房间 / 鉴权 ===
// 房间密钥由服务端预配置。ROOM_SECRETS 支持逗号分隔；ROOM_SECRET 保持 v1.1 兼容。
const ROOM_SECRET_HASHES = new Set(
  String(process.env.ROOM_SECRETS || process.env.ROOM_SECRET || 'change-me')
    .split(',').map((value) => value.trim()).filter(Boolean).map(hashSecret)
);
const ROOM_GRACE_MS = Math.max(0, Number(process.env.ROOM_GRACE_MS || 30_000));

// 计划 §四 模块 4：人设抽到 prompts.js 里了；用 PET_PERSONA 切换
const PERSONA = getPersona(process.env.PET_PERSONA);
const SYSTEM_PROMPT = buildSystemPrompt(PERSONA);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    chat: DEEPSEEK_KEY ? 'deepseek' : 'missing',
    tts: !!(ELEVENLABS_KEY && VOICE_ID),
    socket: 'ready',
  });
});

// 文字对话 → DeepSeek 回复
app.post('/api/chat', async (req, res) => {
  if (!DEEPSEEK_KEY) {
    return res.status(503).json({ error: 'DEEPSEEK_API_KEY not configured on server' });
  }
  const text = String(req.body?.text ?? '').slice(0, 1000).trim();
  if (!text) return res.status(400).json({ error: 'text required' });

  try {
    const r = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_KEY}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        max_tokens: 200,
        temperature: 0.9,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.error('[chat] deepseek', r.status, errText);
      return res.status(r.status).json({ error: errText || `deepseek ${r.status}` });
    }
    const j = await r.json();
    const reply = (j.choices?.[0]?.message?.content ?? '').trim();
    res.json({ reply, usage: j.usage });
  } catch (e) {
    console.error('[chat] error:', e?.message || e);
    res.status(500).json({ error: e?.message || 'chat failed' });
  }
});

// === TTS：ElevenLabs 代理 ===
// 支持 POST {text} 和 GET ?text=...
// B 端收到 say_tts 指令后直接 GET 这个 URL（用 fetch 拿 ArrayBuffer 再 playAudioBuffer）。
async function elevenlabsTTS(text) {
  if (!ELEVENLABS_KEY || !VOICE_ID) {
    const err = new Error('ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not configured');
    err.status = 503;
    throw err;
  }
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: TTS_MODEL,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2 },
    }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    const err = new Error(errText || `elevenlabs ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return Buffer.from(await r.arrayBuffer());
}

async function handleTTS(text, res) {
  text = String(text ?? '').slice(0, 1000).trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const buf = await elevenlabsTTS(text);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    console.error('[tts] error:', e?.message || e);
    res.status(e?.status || 500).json({ error: e?.message || 'tts failed' });
  }
}

app.post('/api/tts', (req, res) => handleTTS(req.body?.text, res));
app.get('/api/tts', (req, res) => handleTTS(req.query?.text, res));

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
  console.log(`  chat:   ${DEEPSEEK_KEY ? `deepseek (${DEEPSEEK_MODEL})` : 'MISSING (set DEEPSEEK_API_KEY)'}`);
  console.log(`  tts:    ${ELEVENLABS_KEY && VOICE_ID ? `elevenlabs ok (voice=${VOICE_ID})` : 'disabled (set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID)'}`);
  console.log(`  socket: ready @ /socket.io  (configured rooms=${ROOM_SECRET_HASHES.size})`);
  console.log(`  persona: ${PERSONA.id} (${PERSONA.name})`);
});
