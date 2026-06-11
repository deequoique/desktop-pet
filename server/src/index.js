import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
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
// 私人项目两人用：硬编码一个固定房间 + 共享密钥；secret 不对直接断开。
const ROOM_SECRET = process['env']['ROOM_SECRET'] || 'change-me';
const ROOM_ID = 'pet-room-1';

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

// 简单 in-memory 状态：当前房间里 controller / pet 的 socketId
const room = { controller: null, pet: null };

function roleOf(socket) { return socket.data?.role; }

function peerSnapshot() {
  return {
    controller: !!room.controller,
    pet: !!room.pet,
  };
}

function otherRole(role) {
  return role === 'controller' ? 'pet' : role === 'pet' ? 'controller' : null;
}

io.on('connection', (socket) => {
  socket.on('pet:join', (data, ack) => {
    const secret = data?.secret;
    const role = data?.role;
    if (secret !== ROOM_SECRET) {
      if (typeof ack === 'function') ack({ ok: false, error: 'bad secret' });
      console.warn('[socket] reject bad secret from', socket.id);
      socket.disconnect(true);
      return;
    }
    if (role !== 'controller' && role !== 'pet') {
      if (typeof ack === 'function') ack({ ok: false, error: 'bad role' });
      socket.disconnect(true);
      return;
    }
    // 同角色只允许一个：踢掉旧的
    const prevId = room[role];
    if (prevId && prevId !== socket.id) {
      const prev = io.sockets.sockets.get(prevId);
      if (prev) {
        prev.emit('room:kicked', { reason: 'replaced' });
        prev.disconnect(true);
      }
    }
    room[role] = socket.id;
    socket.data.role = role;
    socket.join(ROOM_ID);
    if (typeof ack === 'function') ack({ ok: true, peers: peerSnapshot() });
    io.to(ROOM_ID).emit('room:peers', peerSnapshot());
    console.log(`[socket] ${role} joined (${socket.id})`);
  });

  socket.on('pet:command', (cmd) => {
    if (roleOf(socket) !== 'controller') return;
    const petId = room.pet;
    if (!petId) return;
    io.to(petId).emit('pet:command', cmd);
  });

  // controller 想知道 pet 当前有哪些预录台词；ack 链：server 转发给 pet，pet 回 callback。
  socket.on('pet:list-voices', (ack) => {
    if (roleOf(socket) !== 'controller') {
      if (typeof ack === 'function') ack([]);
      return;
    }
    const petId = room.pet;
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
    if (roleOf(socket) !== 'controller') {
      if (typeof ack === 'function') ack([]);
      return;
    }
    const petId = room.pet;
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
    const role = roleOf(socket);
    const targetRole = otherRole(role);
    if (!targetRole) return;
    const targetId = room[targetRole];
    if (!targetId) return;
    io.to(targetId).emit('webrtc:signal', payload);
  });

  socket.on('webrtc:hangup', () => {
    const role = roleOf(socket);
    const targetRole = otherRole(role);
    if (!targetRole) return;
    const targetId = room[targetRole];
    if (!targetId) return;
    io.to(targetId).emit('webrtc:hangup');
  });

  socket.on('webrtc:error', (payload) => {
    const role = roleOf(socket);
    const targetRole = otherRole(role);
    if (!targetRole) return;
    const targetId = room[targetRole];
    if (!targetId) return;
    io.to(targetId).emit('webrtc:error', payload);
  });

  socket.on('disconnect', () => {
    const role = roleOf(socket);
    if (role && room[role] === socket.id) {
      const targetRole = otherRole(role);
      const targetId = targetRole ? room[targetRole] : null;
      if (targetId) io.to(targetId).emit('webrtc:hangup');
      room[role] = null;
      io.to(ROOM_ID).emit('room:peers', peerSnapshot());
      console.log(`[socket] ${role} left`);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`pet server listening on :${PORT}`);
  console.log(`  chat:   ${DEEPSEEK_KEY ? `deepseek (${DEEPSEEK_MODEL})` : 'MISSING (set DEEPSEEK_API_KEY)'}`);
  console.log(`  tts:    ${ELEVENLABS_KEY && VOICE_ID ? `elevenlabs ok (voice=${VOICE_ID})` : 'disabled (set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID)'}`);
  console.log(`  socket: ready @ /socket.io  (room=${ROOM_ID}, secret=${ROOM_SECRET === 'change-me' ? '!! DEFAULT — change me' : 'set'})`);
  console.log(`  persona: ${PERSONA.id} (${PERSONA.name})`);
});
