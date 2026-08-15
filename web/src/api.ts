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
export type NoteAttachment = { id: string; mime: 'image/jpeg' | 'image/png'; extension: 'jpg' | 'png'; size: number; width: number; height: number; createdAt: string };
export type NoteMedia =
  | { kind: 'image'; attachment: NoteAttachment }
  | { kind: 'song' | 'video'; url: string; source: string; title?: string; thumbnailUrl?: string };
export type DesktopNote = {
  id: string;
  revision: number;
  senderMemberId: 'a' | 'b';
  recipientMemberId: 'a' | 'b';
  body: string;
  paperColor: 'yellow' | 'pink' | 'blue' | 'sage' | 'lavender';
  media: NoteMedia | null;
  createdAt: string;
  noticedAt?: string;
  review?: { reviewedAt: string; body?: string; imageAttachment?: NoteAttachment };
  favorite: boolean;
};
export type NoteImageInput = { mime: 'image/jpeg' | 'image/png'; data: ArrayBuffer };
export type NoteCreateInput = {
  body: string;
  paperColor: DesktopNote['paperColor'];
  media?: { kind: 'image'; mime: NoteImageInput['mime']; data: ArrayBuffer } | { kind: 'song' | 'video'; url: string };
};
export type NoteResult = ActionResult & { note?: DesktopNote };

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
  cameraDesired?: boolean;
};
export type MediaControl = { callId: string; media: 'screen'; enabled: boolean };
export type RtcConfig = { iceServers: RTCIceServer[]; iceTransportPolicy: RTCIceTransportPolicy; expiresAt?: number };
export type TrtcConfig = {
  ok: boolean;
  code?: string;
  mode?: 'webrtc' | 'trtc';
  sdkAppId?: number;
  roomId?: number;
  userId?: string;
  userSig?: string;
  expiresAt?: number;
  publishScreen?: boolean;
  remoteUserId?: string;
  remoteSystemUserId?: string;
  localSystemAudio?: { userId: string; userSig: string };
  videoProfile?: '720p30' | '1080p30';
};
export type MediaStatus = {
  callId: string;
  media: 'screen' | 'camera' | 'microphone' | 'system-audio';
  state: 'available' | 'paused' | 'unavailable';
  quality?: 'normal' | 'relay-low';
  qualityLevel?: 1 | 2 | 3 | 4 | 5;
  reason?: 'controller_disabled' | 'capture_failed' | 'permission_denied' | 'device_lost' | 'track_ended' | 'profile_failed' | 'relay_disabled';
  sourceDeviceId?: string;
};

export type Listeners = {
  onStatus?: (s: 'connecting' | 'connected' | 'disconnected' | 'rejected') => void;
  onPeers?: (p: Peers) => void;
  onError?: (msg: string, code?: string) => void;
  onSignal?: (signal: WebRtcSignal) => void;
  onCameraSignal?: (signal: WebRtcSignal) => void;
  onHangup?: () => void;
  onRtcError?: (msg: string) => void;
  onMediaStatus?: (status: MediaStatus) => void;
  onTrtcMediaControl?: (control: MediaControl) => void;
  onTrtcMediaStatus?: (status: MediaStatus) => void;
  onCallStart?: (callId: string, peerDeviceId?: string, cameraOffererDeviceId?: string, cameraSenderDeviceId?: string, mediaMode?: 'webrtc' | 'trtc') => void;
  onCallEnd?: (callId?: string, reason?: string) => void;
  onTtsStatus?: (status: TtsStatus) => void;
  onNoteChanged?: (payload: { reason: string; note: DesktopNote }) => void;
  onNoteRemoved?: (payload: { noteId: string; reason: string }) => void;
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
          listeners.onError?.(
            res?.code === 'upgrade_required' ? '客户端版本过旧，必须升级' : res?.error || '加入失败',
            res?.code || 'socket_join_rejected',
          );
        }
      }
    );
  };

  s.on('connect', join);
  s.on('disconnect', () => listeners.onStatus?.('disconnected'));
  s.on('connect_error', (e) => {
    listeners.onStatus?.('disconnected');
    listeners.onError?.(`连接出错：${e.message}`, 'socket_connect_error');
  });
  s.on('room:peers', (p: Peers) => listeners.onPeers?.(p));
  s.on('room:kicked', (r: { reason: string }) => {
    listeners.onError?.(`被踢出：${r?.reason || ''}`, `socket_kicked_${r?.reason || 'unknown'}`);
    listeners.onStatus?.('rejected');
  });
  s.on('webrtc:signal', (signal: WebRtcSignal) => listeners.onSignal?.(signal));
  s.on('webrtc:camera-signal', (signal: WebRtcSignal) => listeners.onCameraSignal?.(signal));
  s.on('webrtc:hangup', () => listeners.onHangup?.());
  s.on('webrtc:error', (payload: { message?: string }) => {
    listeners.onRtcError?.(payload?.message || '通话出错');
  });
  s.on('webrtc:media-status', (payload: MediaStatus) => listeners.onMediaStatus?.(payload));
  s.on('trtc:media-control', (payload: MediaControl) => listeners.onTrtcMediaControl?.(payload));
  s.on('trtc:media-status', (payload: MediaStatus) => listeners.onTrtcMediaStatus?.(payload));
  s.on('call:start', (payload: { callId?: string; peerDeviceId?: string; cameraOffererDeviceId?: string; cameraSenderDeviceId?: string; mediaMode?: 'webrtc' | 'trtc' }) => {
    if (payload?.callId) {
      listeners.onCallStart?.(
        payload.callId,
        payload.peerDeviceId,
        payload.cameraOffererDeviceId,
        payload.cameraSenderDeviceId,
        payload.mediaMode,
      );
    }
  });
  s.on('call:end', (payload: { callId?: string; reason?: string }) => {
    listeners.onCallEnd?.(payload?.callId, payload?.reason);
  });
  s.on('tts:status', (payload: TtsStatus) => listeners.onTtsStatus?.(payload));
  s.on('note:changed', (payload: { reason: string; note: DesktopNote }) => listeners.onNoteChanged?.(payload));
  s.on('note:removed', (payload: { noteId: string; reason: string }) => listeners.onNoteRemoved?.(payload));

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

export function sendCameraSignal(signal: WebRtcSignal): boolean {
  if (!socket || !socket.connected) return false;
  socket.emit('webrtc:camera-signal', signal);
  return true;
}

export function sendMediaStatus(status: MediaStatus): boolean {
  if (!socket || !socket.connected) return false;
  socket.emit('webrtc:media-status', status);
  return true;
}

export function requestMediaControl(control: MediaControl): Promise<ActionResult> {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, code: 'disconnected' });
    socket.timeout(4000).emit('webrtc:media-control', control, (err: Error | null, response: ActionResult) => {
      if (err) resolve({ ok: false, code: 'timeout' });
      else resolve(response || { ok: false });
    });
  });
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

export function requestTrtcConfig(callId: string): Promise<TrtcConfig> {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, code: 'disconnected' });
    socket.timeout(4000).emit('trtc:get-config', { callId }, (err: Error | null, response: TrtcConfig) => {
      if (err) resolve({ ok: false, code: 'timeout' });
      else resolve(response || { ok: false, code: 'trtc_config_failed' });
    });
  });
}

export function sendTrtcMediaStatus(status: MediaStatus): boolean {
  if (!socket?.connected) return false;
  socket.emit('trtc:media-status', status);
  return true;
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
function noteRequest<T = ActionResult>(event: string, payload?: unknown): Promise<T> {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ ok: false, code: 'disconnected' } as T);
    socket.timeout(15_000).emit(event, payload, (err: Error | null, response: T) => {
      resolve(err ? ({ ok: false, code: 'timeout' } as T) : response || ({ ok: false, code: 'note_request_failed' } as T));
    });
  });
}
export const createNote = (payload: NoteCreateInput) => noteRequest<NoteResult>('note:create', payload);
export const listNotes = (view: 'inbox' | 'sent' | 'history' | 'favorites') => (
  noteRequest<ActionResult & { items: DesktopNote[] }>('note:list', { view, limit: 500 })
);
export const markNoteNoticed = (noteId: string) => noteRequest<NoteResult>('note:mark-noticed', { noteId });
export const reviewNote = (noteId: string, reply?: { body?: string; image?: NoteImageInput }) => (
  noteRequest<NoteResult>('note:review', { noteId, ...(reply ? { reply } : {}) })
);
export const setNoteFavorite = (noteId: string, favorite: boolean) => noteRequest<NoteResult>('note:set-favorite', { noteId, favorite });
export const getNoteAttachment = (noteId: string, attachmentId: string) => (
  noteRequest<ActionResult & { mime?: string; data?: ArrayBuffer }>('note:get-attachment', { noteId, attachmentId })
);
export const renameMember = (memberId: 'a' | 'b', displayName: string) => audioRequest('room:rename-member', { memberId, displayName });
export const reclaimDevice = (deviceId: string, deviceName: string) => audioRequest('device:reclaim', { deviceId, deviceName });
export const changeMember = (targetMemberId: 'a' | 'b'): Promise<MemberChangeResult> => new Promise((resolve) => {
  if (!socket?.connected) return resolve({ ok: false, code: 'disconnected' });
  socket.timeout(5000).emit('device:change-member', { targetMemberId }, (err: Error | null, response: MemberChangeResult) => {
    resolve(err ? { ok: false, code: 'timeout' } : response || { ok: false, code: 'member_change_failed' });
  });
});
