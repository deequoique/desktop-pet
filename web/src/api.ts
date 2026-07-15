import { io, type Socket } from 'socket.io-client';

export type ExpressionName =
  | 'joy' | 'sorrow' | 'angry' | 'surprised' | 'blink' | 'neutral';

export type MotionMeta = {
  id: string;
  label: string;
  loop: boolean;
};

export type Command =
  | { type: 'expression'; name: ExpressionName; strength?: number; holdMs?: number }
  | { type: 'animation'; name: string }
  | { type: 'say_audio'; url: string }
  | { type: 'relocate'; corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' };

export type TtsVoice = { id: string; label: string; previewUrl?: string };
export type TtsStatus = { jobId: string; state: 'dispatched' | 'generating' | 'playing' | 'completed' | 'error'; error?: string };
export type TtsProvider = 'elevenlabs' | 'cosyvoice';
export type TtsVoiceResponse = { ok: boolean; mode?: 'managed' | 'byok'; provider?: TtsProvider; code?: string; voices: TtsVoice[] };

export type Peers = {
  selfReady: boolean;
  peerOnline: boolean;
  peerPetOnline: boolean;
  peerControllerOnline: boolean;
  controller: boolean;
  pet: boolean;
};

export type WebRtcSignal = {
  callId?: string;
  description?: RTCSessionDescriptionInit | null;
  candidate?: RTCIceCandidateInit | null;
};
export type RtcConfig = { iceServers: RTCIceServer[]; iceTransportPolicy: RTCIceTransportPolicy; expiresAt?: number };
export type MediaStatus = {
  callId: string;
  media: 'screen' | 'microphone' | 'system-audio';
  state: 'available' | 'paused' | 'unavailable';
  reason?: 'relay_audio_only' | 'capture_failed' | 'track_ended';
};

export type Listeners = {
  onStatus?: (s: 'connecting' | 'connected' | 'disconnected' | 'rejected') => void;
  onPeers?: (p: Peers) => void;
  onError?: (msg: string) => void;
  onSignal?: (signal: WebRtcSignal) => void;
  onHangup?: () => void;
  onRtcError?: (msg: string) => void;
  onMediaStatus?: (status: MediaStatus) => void;
  onCallStart?: (callId: string) => void;
  onCallEnd?: (callId?: string, reason?: string) => void;
  onTtsStatus?: (status: TtsStatus) => void;
};

let socket: Socket | null = null;
let listeners: Listeners = {};
let ttsApiKey = '';

export function setListeners(l: Listeners) {
  listeners = l;
}

export function connect(serverUrl: string, secret: string, participantId: string): Socket {
  if (socket) disconnect();
  listeners.onStatus?.('connecting');
  const s = io(serverUrl, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 5000,
  });
  socket = s;

  const join = () => {
    s.emit(
      'pet:join',
      { secret, role: 'controller', participantId },
      (res: { ok: boolean; code?: string; error?: string; peers?: Peers }) => {
        if (res?.ok) {
          listeners.onStatus?.('connected');
          if (res.peers) listeners.onPeers?.(res.peers);
          if (ttsApiKey) s.emit('tts:set-credentials', { apiKey: ttsApiKey }, () => {});
        } else {
          listeners.onStatus?.('rejected');
          listeners.onError?.(res?.code === 'room_full' ? '房间已满（最多两人）' : res?.error || '加入失败');
        }
      }
    );
  };

  s.on('connect', join);
  s.on('disconnect', () => listeners.onStatus?.('disconnected'));
  s.on('connect_error', (e) => {
    listeners.onStatus?.('disconnected');
    listeners.onError?.(`连接出错：${e.message}`);
  });
  s.on('room:peers', (p: Peers) => listeners.onPeers?.(p));
  s.on('room:kicked', (r: { reason: string }) => {
    listeners.onError?.(`被踢出：${r?.reason || ''}`);
    listeners.onStatus?.('rejected');
  });
  s.on('webrtc:signal', (signal: WebRtcSignal) => listeners.onSignal?.(signal));
  s.on('webrtc:hangup', () => listeners.onHangup?.());
  s.on('webrtc:error', (payload: { message?: string }) => {
    listeners.onRtcError?.(payload?.message || '通话出错');
  });
  s.on('webrtc:media-status', (payload: MediaStatus) => listeners.onMediaStatus?.(payload));
  s.on('call:start', (payload: { callId?: string }) => {
    if (payload?.callId) listeners.onCallStart?.(payload.callId);
  });
  s.on('call:end', (payload: { callId?: string; reason?: string }) => {
    listeners.onCallEnd?.(payload?.callId, payload?.reason);
  });
  s.on('tts:status', (payload: TtsStatus) => listeners.onTtsStatus?.(payload));

  return s;
}

export function disconnect() {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  listeners.onStatus?.('disconnected');
}

export function sendCommand(cmd: Command): boolean {
  if (!socket || !socket.connected) return false;
  socket.emit('pet:command', cmd);
  return true;
}

export function listVoices(timeoutMs = 4000): Promise<string[]> {
  return new Promise((resolve) => {
    if (!socket || !socket.connected) return resolve([]);
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve([]); } }, timeoutMs);
    socket.emit('pet:list-voices', (files: string[]) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(Array.isArray(files) ? files : []);
    });
  });
}

export function listMotions(timeoutMs = 4000): Promise<MotionMeta[]> {
  return new Promise((resolve) => {
    if (!socket || !socket.connected) return resolve([]);
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve([]); } }, timeoutMs);
    socket.emit('pet:list-motions', (motions: MotionMeta[]) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(Array.isArray(motions) ? motions : []);
    });
  });
}

export function sendSignal(signal: WebRtcSignal): boolean {
  if (!socket || !socket.connected) return false;
  socket.emit('webrtc:signal', signal);
  return true;
}

export function requestRtcConfig(): Promise<RtcConfig> {
  return new Promise((resolve) => {
    const fallback: RtcConfig = { iceServers: [], iceTransportPolicy: 'all' };
    if (!socket?.connected) return resolve(fallback);
    socket.timeout(4000).emit('webrtc:get-config', (err: Error | null, response: any) => {
      if (err || !response?.ok) resolve(fallback);
      else resolve({
        iceServers: Array.isArray(response.iceServers) ? response.iceServers : [],
        iceTransportPolicy: response.iceTransportPolicy === 'relay' ? 'relay' : 'all',
        expiresAt: response.expiresAt,
      });
    });
  });
}

export function sendHangup(): boolean {
  if (!socket || !socket.connected) return false;
  socket.emit('webrtc:hangup');
  return true;
}

export function requestCall(): Promise<{ ok: boolean; callId?: string; code?: string }> {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, code: 'disconnected' });
    socket.timeout(4000).emit('call:start', (err: Error | null, response: any) => {
      if (err) resolve({ ok: false, code: 'timeout' });
      else resolve(response || { ok: false });
    });
  });
}

export function endCall(callId?: string): boolean {
  if (!socket?.connected) return false;
  socket.emit('call:end', { callId });
  return true;
}

export function setTtsCredentials(apiKey: string): Promise<TtsVoiceResponse> {
  const nextApiKey = String(apiKey || '').trim();
  if (!nextApiKey) ttsApiKey = '';
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, code: 'disconnected', voices: [] });
    socket.timeout(12_000).emit('tts:set-credentials', { apiKey: nextApiKey }, (err: Error | null, response: TtsVoiceResponse) => {
      if (err) resolve({ ok: false, code: 'timeout', voices: [] });
      else {
        if (response?.ok) ttsApiKey = nextApiKey;
        resolve(response || { ok: false, code: 'tts_credentials_failed', voices: [] });
      }
    });
  });
}

export function listTtsVoices(): Promise<TtsVoiceResponse> {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, code: 'disconnected', voices: [] });
    socket.timeout(12_000).emit('tts:list-voices', (err: Error | null, response: TtsVoiceResponse) => {
      if (err) resolve({ ok: false, code: 'timeout', voices: [] });
      else resolve(response || { ok: false, code: 'tts_unavailable', voices: [] });
    });
  });
}

export function createTts(text: string, voiceId: string): Promise<{ ok: boolean; jobId?: string; state?: string; position?: number; code?: string }> {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, code: 'disconnected' });
    socket.timeout(5000).emit('tts:create', { text, voiceId }, (err: Error | null, response: any) => {
      if (err) resolve({ ok: false, code: 'timeout' });
      else resolve(response || { ok: false, code: 'tts_create_failed' });
    });
  });
}
