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
export type PersonalAudio = { id: string; name: string; mime: string; durationMs: number; size: number; createdAt: string };

export type Peers = {
  protocolVersion: 2;
  self: { memberId: 'a' | 'b'; deviceId: string };
  members: Array<{ id: 'a' | 'b'; displayName: string; devices: Array<{ id: string; name: string; lastSeenAt: string; petOnline: boolean; controllerOnline: boolean }> }>;
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
  onCallStart?: (callId: string, peerDeviceId?: string) => void;
  onCallEnd?: (callId?: string, reason?: string) => void;
  onTtsStatus?: (status: TtsStatus) => void;
};

let socket: Socket | null = null;
let listeners: Listeners = {};
let ttsApiKey = '';
export type ConnectionIdentity = { memberId: 'a' | 'b'; deviceId: string; deviceName: string };
export type TargetResult<T = Record<string, unknown>> = { targetDeviceId: string; result: T };
export type ActionResult = { ok: boolean; code?: string };
export type TtsCreateResult = ActionResult & { jobId?: string; state?: string; position?: number };
export type PairingMember = { id: 'a' | 'b'; displayName: string };
export type PairingDiscovery = ActionResult & { members?: PairingMember[] };
export type MemberChangeResult = ActionResult & { memberId?: 'a' | 'b' };

export function setListeners(l: Listeners) {
  listeners = l;
}

export function connect(serverUrl: string, secret: string, identity: ConnectionIdentity): Socket {
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
      { protocolVersion: 2, secret, role: 'controller', ...identity },
      (res: { ok: boolean; code?: string; error?: string; peers?: Peers }) => {
        if (res?.ok) {
          listeners.onStatus?.('connected');
          if (res.peers) listeners.onPeers?.(res.peers);
          if (ttsApiKey) s.emit('tts:set-credentials', { apiKey: ttsApiKey }, () => {});
        } else {
          listeners.onStatus?.('rejected');
          listeners.onError?.(res?.code === 'upgrade_required' ? '客户端版本过旧，必须升级' : res?.error || '加入失败');
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
  s.on('call:start', (payload: { callId?: string; peerDeviceId?: string }) => {
    if (payload?.callId) listeners.onCallStart?.(payload.callId, payload.peerDeviceId);
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

export function discoverPairing(serverUrl: string, secret: string, timeoutMs = 5000): Promise<PairingDiscovery> {
  return new Promise((resolve) => {
    const probe = io(serverUrl, {
      transports: ['websocket', 'polling'],
      reconnection: false,
      forceNew: true,
    });
    let settled = false;
    const finish = (result: PairingDiscovery) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      probe.removeAllListeners();
      probe.disconnect();
      resolve(result);
    };
    const timer = window.setTimeout(() => finish({ ok: false, code: 'timeout' }), timeoutMs);
    probe.on('connect', () => {
      probe.emit('pairing:discover', { protocolVersion: 2, secret }, (result: PairingDiscovery) => {
        const members = Array.isArray(result?.members)
          ? result.members.filter((member): member is PairingMember => !!member && (member.id === 'a' || member.id === 'b') && !!member.displayName)
          : [];
        finish(result?.ok && members.length === 2 ? { ok: true, members } : result || { ok: false, code: 'discovery_failed' });
      });
    });
    probe.on('connect_error', () => finish({ ok: false, code: 'unreachable' }));
  });
}

export function sendCommand(cmd: Command, targetDeviceIds: string[]): number {
  if (!socket || !socket.connected) return 0;
  const targets = [...new Set(targetDeviceIds.filter(Boolean))];
  for (const targetDeviceId of targets) socket.emit('pet:command', { ...cmd, targetDeviceId });
  return targets.length;
}

export function listMotions(targetDeviceId: string, timeoutMs = 4000): Promise<MotionMeta[]> {
  return new Promise((resolve) => {
    if (!socket || !socket.connected) return resolve([]);
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve([]); } }, timeoutMs);
    socket.emit('pet:list-motions', { targetDeviceId }, (motions: MotionMeta[]) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(Array.isArray(motions) ? motions : []);
    });
  });
}

export function sendSignal(signal: WebRtcSignal, targetDeviceId?: string): boolean {
  if (!socket || !socket.connected) return false;
  socket.emit('webrtc:signal', { ...signal, targetDeviceId });
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

export function requestCall(targetDeviceId: string): Promise<{ ok: boolean; callId?: string; code?: string }> {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, code: 'disconnected' });
    socket.timeout(4000).emit('call:start', { targetDeviceId }, (err: Error | null, response: any) => {
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

export async function createTts(text: string, voiceId: string, targetDeviceIds: string[]): Promise<TargetResult<TtsCreateResult>[]> {
  return Promise.all([...new Set(targetDeviceIds.filter(Boolean))].map(async (targetDeviceId) => ({
    targetDeviceId,
    result: await new Promise<TtsCreateResult>((resolve) => {
      if (!socket?.connected) return resolve({ ok: false, code: 'disconnected' });
      socket.timeout(5000).emit('tts:create', { text, voiceId, targetDeviceId }, (err: Error | null, response: any) => {
        resolve(err ? { ok: false, code: 'timeout' } : response || { ok: false, code: 'tts_create_failed' });
      });
    }),
  })));
}

function audioRequest(event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, code: 'disconnected' });
    socket.timeout(12_000).emit(event, payload, (err: Error | null, response: any) => resolve(err ? { ok: false, code: 'timeout' } : response));
  });
}

export const listPersonalAudio = () => audioRequest('audio:list');
export const addPersonalAudio = (payload: { name: string; mime: string; durationMs: number; data: ArrayBuffer }) => audioRequest('audio:add', payload);
export const renamePersonalAudio = (audioId: string, name: string) => audioRequest('audio:rename', { audioId, name });
export const deletePersonalAudio = (audioId: string) => audioRequest('audio:delete', { audioId });
export const playPersonalAudio = async (audioId: string, targetDeviceIds: string[] = []): Promise<TargetResult<ActionResult>[]> => (
  Promise.all([...new Set(targetDeviceIds.filter(Boolean))].map(async (targetDeviceId) => ({
    targetDeviceId,
    result: await audioRequest('audio:play', { audioId, targetDeviceId }),
  })))
);
export const getPersonalAudio = (audioId: string) => audioRequest('audio:get', { audioId });
export const renameMember = (memberId: 'a' | 'b', displayName: string) => audioRequest('room:rename-member', { memberId, displayName });
export const reclaimDevice = (deviceId: string, deviceName: string) => audioRequest('device:reclaim', { deviceId, deviceName });
export const changeMember = (targetMemberId: 'a' | 'b'): Promise<MemberChangeResult> => new Promise((resolve) => {
  if (!socket?.connected) return resolve({ ok: false, code: 'disconnected' });
  socket.timeout(5000).emit('device:change-member', { targetMemberId }, (err: Error | null, response: MemberChangeResult) => {
    resolve(err ? { ok: false, code: 'timeout' } : response || { ok: false, code: 'member_change_failed' });
  });
});
