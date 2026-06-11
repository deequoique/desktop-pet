import { io, type Socket } from 'socket.io-client';

export type ExpressionName =
  | 'joy' | 'sorrow' | 'angry' | 'surprised' | 'blink' | 'neutral';

export type Command =
  | { type: 'expression'; name: ExpressionName; strength?: number; holdMs?: number }
  | { type: 'animation'; name: 'wag_tail' | 'shake' }
  | { type: 'say_audio'; url: string }
  | { type: 'say_tts'; text: string }
  | { type: 'relocate'; corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' };

export type Peers = { controller: boolean; pet: boolean };

export type WebRtcSignal = {
  description?: RTCSessionDescriptionInit | null;
  candidate?: RTCIceCandidateInit | null;
};

export type Listeners = {
  onStatus?: (s: 'connecting' | 'connected' | 'disconnected' | 'rejected') => void;
  onPeers?: (p: Peers) => void;
  onError?: (msg: string) => void;
  onSignal?: (signal: WebRtcSignal) => void;
  onHangup?: () => void;
  onRtcError?: (msg: string) => void;
};

let socket: Socket | null = null;
let listeners: Listeners = {};

export function setListeners(l: Listeners) {
  listeners = l;
}

export function connect(serverUrl: string, secret: string): Socket {
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
      { secret, role: 'controller' },
      (res: { ok: boolean; error?: string; peers?: Peers }) => {
        if (res?.ok) {
          listeners.onStatus?.('connected');
          if (res.peers) listeners.onPeers?.(res.peers);
        } else {
          listeners.onStatus?.('rejected');
          listeners.onError?.(res?.error || '加入失败');
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

export function sendSignal(signal: WebRtcSignal): boolean {
  if (!socket || !socket.connected) return false;
  socket.emit('webrtc:signal', signal);
  return true;
}

export function sendHangup(): boolean {
  if (!socket || !socket.connected) return false;
  socket.emit('webrtc:hangup');
  return true;
}
