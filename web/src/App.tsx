import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  connect,
  disconnect,
  listMotions,
  listTtsVoices,
  listVoices,
  createTts,
  endCall,
  requestCall,
  sendCommand,
  sendSignal,
  setListeners,
  setTtsCredentials,
  type Command,
  type ExpressionName,
  type MotionMeta,
  type Peers,
  type TtsStatus,
  type TtsProvider,
  type TtsVoice,
  type WebRtcSignal,
} from './api';

type Status = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'rejected';
type CallState = 'idle' | 'requesting-media' | 'calling' | 'in-call' | 'error';
type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown' | 'failed';

type RtcRoute = {
  candidateType: CandidateType;
  relayed: boolean;
  detail: string;
};

const LS_SERVER = 'pet.serverUrl';
const LS_SECRET = 'pet.secret';
const LS_PARTICIPANT = 'pet.participantId';
const LS_TTS_MODE = 'pet.ttsMode';
const LS_TTS_VOICE = 'pet.ttsVoiceId';

type PairingConfig = { serverUrl?: string; roomSecret?: string; participantId?: string };

declare global {
  interface Window {
    desktopPetControl?: {
      getPairingConfig: () => Promise<PairingConfig>;
      savePairingConfig: (config: { serverUrl: string; roomSecret: string }) => Promise<{ ok: boolean; error?: string; config?: PairingConfig }>;
      onPairingChanged: (cb: (config: PairingConfig) => void) => void;
      getTtsCredentials: () => Promise<{ configured: boolean; apiKey?: string }>;
      saveTtsCredentials: (apiKey: string) => Promise<{ ok: boolean; configured?: boolean; error?: string }>;
    };
  }
}

function localParticipantId() {
  const saved = localStorage.getItem(LS_PARTICIPANT);
  if (saved) return saved;
  const id = crypto.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(LS_PARTICIPANT, id);
  return id;
}

const DEFAULT_SERVER = import.meta.env.VITE_PET_SERVER_URL || 'http://localhost:3030';
const DEFAULT_SECRET = import.meta.env.VITE_PET_ROOM_SECRET || 'change-me';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

const EXPRESSIONS: { name: ExpressionName; label: string }[] = [
  { name: 'joy', label: '开心' },
  { name: 'surprised', label: '吃惊' },
  { name: 'sorrow', label: '委屈' },
  { name: 'angry', label: '生气' },
  { name: 'blink', label: '眨眼' },
  { name: 'neutral', label: '平静' },
];

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const CORNERS: { corner: Corner; label: string }[] = [
  { corner: 'top-left', label: '左上' },
  { corner: 'top-right', label: '右上' },
  { corner: 'bottom-left', label: '左下' },
  { corner: 'bottom-right', label: '右下' },
];

const EMPTY_RTC_ROUTE: RtcRoute = {
  candidateType: 'unknown',
  relayed: false,
  detail: '等待 ICE 选路',
};

function explainMediaDevicesUnavailable(): string {
  const protocol = window.location.protocol;
  const host = window.location.hostname;
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (protocol !== 'https:' && !isLocalhost) {
    return '当前控制台页面不是浏览器认可的安全上下文，麦克风被禁用；将只接收远程画面，请用可信 HTTPS 域名开启对讲。';
  }
  return '当前浏览器不支持麦克风采集；将只接收远程画面。';
}

function candidateAddress(candidate: any): string {
  return candidate?.address || candidate?.ip || candidate?.hostname || '';
}

async function readRtcRoute(pc: RTCPeerConnection): Promise<RtcRoute> {
  if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') {
    return { candidateType: 'failed', relayed: false, detail: 'ICE 连接失败' };
  }

  const stats = await pc.getStats();
  let pair: any = null;

  stats.forEach((report: any) => {
    if (report.type === 'transport' && report.selectedCandidatePairId) {
      pair = stats.get(report.selectedCandidatePairId);
    }
  });

  if (!pair) {
    stats.forEach((report: any) => {
      if (report.type === 'candidate-pair' && (report.selected || report.nominated) && report.state === 'succeeded') {
        pair = report;
      }
    });
  }

  if (!pair) return EMPTY_RTC_ROUTE;

  const local: any = stats.get(pair.localCandidateId);
  const remote: any = stats.get(pair.remoteCandidateId);
  const candidateType = (local?.candidateType || 'unknown') as CandidateType;
  const protocol = local?.protocol || pair.protocol || '';
  const localAddr = candidateAddress(local);
  const remoteAddr = candidateAddress(remote);
  const detail = [
    candidateType,
    protocol,
    localAddr && remoteAddr ? `${localAddr} → ${remoteAddr}` : '',
  ].filter(Boolean).join(' · ');

  return {
    candidateType,
    relayed: candidateType === 'relay',
    detail: detail || 'ICE 已连接',
  };
}

function voicePart(url: string): 'head' | 'body' | 'tail' | 'idle' | 'other' {
  const name = url.split('/').pop() || '';
  const m = name.match(/^(head|body|tail|idle)_/i);
  return (m ? m[1].toLowerCase() : 'other') as any;
}

function voiceLabel(url: string): string {
  return (url.split('/').pop() || url).replace(/\.[^.]+$/, '');
}

function ttsErrorMessage(code?: string) {
  const messages: Record<string, string> = {
    disconnected: '尚未连接 server',
    tts_not_configured: 'Server 尚未配置语音服务',
    tts_no_voices: '没有可用声音',
    tts_voice_not_allowed: '所选声音不可用，请重新选择',
    tts_queue_full: '对方语音队列已满，请稍后再发',
    tts_rate_limited: '发送太频繁，请一分钟后再试',
    peer_pet_offline: '对方桌宠不在线',
    tts_byok_unauthorized: 'ElevenLabs API Key 无效',
    tts_byok_unavailable: '无法读取 ElevenLabs 声音列表',
    tts_byok_not_supported: '当前语音供应商不支持应用内 BYOK',
    tts_credentials_unavailable: '自定义 API Key 已断开，请重新连接',
    tts_upstream_unauthorized: '语音供应商拒绝了 API Key',
    tts_upstream_rate_limited: '语音供应商额度或频率已受限',
    tts_upstream_error: '语音供应商生成失败',
    tts_stream_failed: '语音流中断',
    tts_job_expired: '语音任务已过期',
  };
  return messages[code || ''] || code || '语音发送失败';
}

export default function App() {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem(LS_SERVER) || DEFAULT_SERVER);
  const [secret, setSecret] = useState(() => localStorage.getItem(LS_SECRET) || DEFAULT_SECRET);
  const [status, setStatus] = useState<Status>('idle');
  const [participantId, setParticipantId] = useState(localParticipantId);
  const [peers, setPeers] = useState<Peers>({
    selfReady: false, peerOnline: false, peerPetOnline: false, peerControllerOnline: false,
    controller: false, pet: false,
  });
  const [motions, setMotions] = useState<MotionMeta[]>([]);
  const [voices, setVoices] = useState<string[]>([]);
  const [tts, setTts] = useState('');
  const [ttsMode, setTtsMode] = useState<'managed' | 'byok'>(() => localStorage.getItem(LS_TTS_MODE) === 'byok' ? 'byok' : 'managed');
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>('elevenlabs');
  const [ttsApiKey, setTtsApiKey] = useState('');
  const [ttsApiKeyInput, setTtsApiKeyInput] = useState('');
  const [ttsKeyConfigured, setTtsKeyConfigured] = useState(false);
  const [ttsVoices, setTtsVoices] = useState<TtsVoice[]>([]);
  const [ttsVoiceId, setTtsVoiceId] = useState(() => localStorage.getItem(LS_TTS_VOICE) || '');
  const [ttsState, setTtsState] = useState('等待发送');
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [callState, setCallState] = useState<CallState>('idle');
  const [remoteMicMuted, setRemoteMicMuted] = useState(true);
  const [remoteSystemMuted, setRemoteSystemMuted] = useState(true);
  const [micEnabled, setMicEnabledState] = useState(false);
  const [remoteReady, setRemoteReady] = useState(false);
  const [remoteTrackSummary, setRemoteTrackSummary] = useState('无');
  const [rtcRoute, setRtcRoute] = useState<RtcRoute>(EMPTY_RTC_ROUTE);
  const toastTimer = useRef<number | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteMicAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteSystemAudioRef = useRef<HTMLAudioElement | null>(null);
  const videoStageRef = useRef<HTMLDivElement | null>(null);
  const remoteVideoStreamRef = useRef<MediaStream | null>(null);
  const remoteMicStreamRef = useRef<MediaStream | null>(null);
  const remoteSystemStreamRef = useRef<MediaStream | null>(null);
  const rtcPcRef = useRef<RTCPeerConnection | null>(null);
  const localAudioRef = useRef<MediaStream | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const currentCallIdRef = useRef<string | null>(null);

  const showToast = useCallback((msg: string, err = false) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ msg, err });
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  const stopLocalAudio = useCallback(() => {
    try { localAudioRef.current?.getTracks().forEach((track) => track.stop()); } catch {}
    localAudioRef.current = null;
  }, []);

  const setMicEnabled = useCallback((enabled: boolean) => {
    for (const track of localAudioRef.current?.getAudioTracks() ?? []) {
      track.enabled = enabled;
    }
    setMicEnabledState(enabled);
  }, []);

  const teardownCall = useCallback((opts?: { sendRemoteHangup?: boolean; nextState?: CallState }) => {
    if (opts?.sendRemoteHangup) endCall(currentCallIdRef.current || undefined);
    try { rtcPcRef.current?.close(); } catch {}
    rtcPcRef.current = null;
    pendingCandidatesRef.current = [];
    stopLocalAudio();
    setMicEnabled(false);
    setRemoteReady(false);
    setRemoteTrackSummary('无');
    setRtcRoute(EMPTY_RTC_ROUTE);
    remoteVideoStreamRef.current = null;
    remoteMicStreamRef.current = null;
    remoteSystemStreamRef.current = null;
    setCallState(opts?.nextState ?? 'idle');
    currentCallIdRef.current = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteMicAudioRef.current) remoteMicAudioRef.current.srcObject = null;
    if (remoteSystemAudioRef.current) remoteSystemAudioRef.current.srcObject = null;
  }, [setMicEnabled, stopLocalAudio]);

  const sendRtcSignal = useCallback((signal: WebRtcSignal) => {
    return sendSignal({ ...signal, callId: currentCallIdRef.current || undefined });
  }, []);

  const syncRemoteMediaState = useCallback(async () => {
    const videoTracks = remoteVideoStreamRef.current?.getVideoTracks() ?? [];
    const micTracks = remoteMicStreamRef.current?.getAudioTracks() ?? [];
    const systemTracks = remoteSystemStreamRef.current?.getAudioTracks() ?? [];
    const summary = [
      videoTracks.length ? `video:${videoTracks.length}` : null,
      micTracks.length ? '麦克风:1' : null,
      systemTracks.length ? '系统声音:1' : null,
    ].filter(Boolean).join(' + ') || '无';
    setRemoteTrackSummary(summary);
    setRemoteReady(videoTracks.length > 0);

    const videoStream = remoteVideoStreamRef.current;
    if (!videoStream || !remoteVideoRef.current) return;
    if (remoteVideoRef.current.srcObject !== videoStream) {
      remoteVideoRef.current.srcObject = videoStream;
    }
    remoteVideoRef.current.muted = true;
    try {
      await remoteVideoRef.current.play();
    } catch (e) {
      console.warn('[webrtc] remote video play failed:', e);
    }
  }, []);

  const flushPendingCandidates = useCallback(async () => {
    const pc = rtcPcRef.current;
    if (!pc?.remoteDescription) return;
    while (pendingCandidatesRef.current.length) {
      const candidate = pendingCandidatesRef.current.shift();
      if (!candidate) continue;
      try {
        await pc.addIceCandidate(candidate);
      } catch (e) {
        console.warn('[webrtc] addIceCandidate failed:', e);
      }
    }
  }, []);

  const ensureLocalAudio = useCallback(async () => {
    const live = localAudioRef.current?.getAudioTracks().some((track) => track.readyState === 'live');
    if (localAudioRef.current && live) return localAudioRef.current;

    if (!navigator.mediaDevices?.getUserMedia) {
      showToast(explainMediaDevicesUnavailable(), true);
      return null;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      for (const track of stream.getAudioTracks()) track.enabled = false;
      localAudioRef.current = stream;
      return stream;
    } catch (e: any) {
      console.warn('[webrtc] local microphone capture failed; starting receive-only call:', e);
      showToast(`麦克风不可用，将只接收远程画面：${e?.message || e}`, true);
      return null;
    }
  }, [showToast]);

  const ensurePeerConnection = useCallback(async () => {
    if (rtcPcRef.current) return rtcPcRef.current;

    const localAudio = await ensureLocalAudio();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    rtcPcRef.current = pc;

    if (localAudio) {
      pc.addTrack(localAudio.getAudioTracks()[0], localAudio);
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    const systemTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.addTransceiver('video', { direction: 'recvonly' });

    pc.onicecandidate = (event) => {
      if (event.candidate) sendRtcSignal({ candidate: event.candidate.toJSON() });
    };
    pc.ontrack = async (event) => {
      const streamRef = event.track.kind === 'video'
        ? remoteVideoStreamRef
        : event.transceiver === systemTransceiver
          ? remoteSystemStreamRef
          : remoteMicStreamRef;
      const stream = streamRef.current ?? new MediaStream();
      streamRef.current = stream;

      if (!stream.getTracks().some((t) => t.id === event.track.id)) {
        stream.addTrack(event.track);
      }

      if (event.track.kind === 'audio') {
        const audio = event.transceiver === systemTransceiver
          ? remoteSystemAudioRef.current
          : remoteMicAudioRef.current;
        if (audio && audio.srcObject !== stream) audio.srcObject = stream;
      }

      console.log('[webrtc] remote track:', {
        kind: event.track.kind,
        id: event.track.id,
        label: event.track.label,
        muted: event.track.muted,
        streams: event.streams.map((s) => ({ id: s.id, tracks: s.getTracks().map((t) => t.kind) })),
      });

      event.track.addEventListener('ended', () => {
        console.log('[webrtc] remote track ended:', event.track.kind, event.track.id);
        syncRemoteMediaState().catch(() => {});
      });
      event.track.addEventListener('mute', () => {
        console.log('[webrtc] remote track muted:', event.track.kind, event.track.id);
      });
      event.track.addEventListener('unmute', () => {
        console.log('[webrtc] remote track unmuted:', event.track.kind, event.track.id);
      });

      await syncRemoteMediaState();
      setCallState('in-call');
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log('[webrtc] controller connection state:', state);
      if (state === 'connected') {
        setCallState('in-call');
        readRtcRoute(pc).then(setRtcRoute).catch(() => {});
        return;
      }
      if (state === 'failed' || state === 'disconnected') {
        showToast('通话断开了', true);
        endCall(currentCallIdRef.current || undefined);
        teardownCall({ nextState: 'idle' });
        setRtcRoute({ candidateType: 'failed', relayed: false, detail: `连接状态：${state}` });
      }
      if (state === 'closed') teardownCall({ nextState: 'idle' });
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        readRtcRoute(pc).then(setRtcRoute).catch(() => {});
      }
      if (pc.iceConnectionState === 'failed') {
        setRtcRoute({ candidateType: 'failed', relayed: false, detail: 'ICE 连接失败' });
      }
    };

    return pc;
  }, [ensureLocalAudio, sendRtcSignal, showToast, teardownCall]);

  const handleSignal = useCallback(async (signal: WebRtcSignal) => {
    if (!signal) return;
    if (signal.callId && signal.callId !== currentCallIdRef.current) return;
    if (signal.description) {
      const desc = signal.description;
      console.log('[webrtc] controller got description:', desc.type);
      if (desc.type === 'answer') {
        const pc = rtcPcRef.current;
        if (!pc) return;
        await pc.setRemoteDescription(desc);
        console.log('[webrtc] controller set remote answer');
        await flushPendingCandidates();
        return;
      }
      if (desc.type === 'offer') {
        const pc = await ensurePeerConnection();
        await pc.setRemoteDescription(desc);
        await flushPendingCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendRtcSignal({ description: pc.localDescription });
        console.log('[webrtc] controller answered remote offer');
        return;
      }
    }

    if (signal.candidate) {
      console.log('[webrtc] controller got ice candidate');
      const pc = rtcPcRef.current;
      if (!pc?.remoteDescription) {
        pendingCandidatesRef.current.push(signal.candidate);
        return;
      }
      await pc.addIceCandidate(signal.candidate);
    }
  }, [ensurePeerConnection, flushPendingCandidates, sendRtcSignal]);

  const beginMediaCall = useCallback(async (callId: string) => {
    if (currentCallIdRef.current === callId && rtcPcRef.current) return;
    teardownCall({ nextState: 'requesting-media' });
    currentCallIdRef.current = callId;
    const pc = await ensurePeerConnection();
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    sendRtcSignal({ description: pc.localDescription });
    setCallState('calling');
  }, [ensurePeerConnection, sendRtcSignal, teardownCall]);

  useEffect(() => {
    setListeners({
      onStatus: setStatus,
      onPeers: setPeers,
      onError: (m) => showToast(m, true),
      onSignal: (signal) => {
        handleSignal(signal).catch((e) => {
          console.warn('[webrtc] signal failed:', e);
          showToast(`通话失败：${e?.message || e}`, true);
          teardownCall({ nextState: 'error' });
        });
      },
      onHangup: () => {
        if (!currentCallIdRef.current) return;
        teardownCall({ nextState: 'idle' });
        showToast('通话结束了');
      },
      onRtcError: (msg) => {
        showToast(msg, true);
        teardownCall({ nextState: 'error' });
      },
      onCallStart: (callId) => {
        beginMediaCall(callId).catch((e) => {
          console.warn('[webrtc] start coordinated call failed:', e);
          showToast(`通话失败：${e?.message || e}`, true);
          teardownCall({ nextState: 'error' });
        });
      },
      onCallEnd: (callId) => {
        if (callId && currentCallIdRef.current && callId !== currentCallIdRef.current) return;
        teardownCall({ nextState: 'idle' });
        showToast('通话结束了');
      },
      onTtsStatus: (payload: TtsStatus) => {
        const labels: Record<string, string> = {
          dispatched: '已发送到对方桌宠', generating: '正在生成语音…',
          playing: '对方正在播放', completed: '播放完成', error: ttsErrorMessage(payload.error),
        };
        const label = labels[payload.state] || payload.state;
        setTtsState(label);
        if (payload.state === 'error') showToast(label, true);
      },
    });
    return () => {
      setListeners({});
      teardownCall({ nextState: 'idle' });
    };
  }, [beginMediaCall, handleSignal, showToast, teardownCall]);

  useEffect(() => {
    const bridge = window.desktopPetControl;
    if (!bridge) return;
    const applyConfig = (config: PairingConfig) => {
      const nextServer = String(config.serverUrl || '').trim();
      const nextSecret = String(config.roomSecret || '').trim();
      const nextParticipant = String(config.participantId || '').trim();
      setServerUrl(nextServer);
      setSecret(nextSecret);
      if (nextParticipant) setParticipantId(nextParticipant);
      if (nextServer && nextSecret && nextParticipant) connect(nextServer, nextSecret, nextParticipant);
      else disconnect();
    };
    bridge.getPairingConfig().then(applyConfig).catch((e) => {
      showToast(`读取桌宠配置失败：${e?.message || e}`, true);
    });
    bridge.onPairingChanged(applyConfig);
  }, [showToast]);

  useEffect(() => {
    const bridge = window.desktopPetControl;
    if (!bridge) return;
    bridge.getTtsCredentials().then((result) => {
      setTtsKeyConfigured(!!result.configured);
      if (result.apiKey) setTtsApiKey(result.apiKey);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (status !== 'connected') {
      setTtsVoices([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      if (ttsMode === 'byok' && !ttsApiKey) {
        const discovery = await listTtsVoices();
        if (cancelled) return;
        if (discovery.provider) setTtsProvider(discovery.provider);
        if (discovery.provider === 'cosyvoice') {
          setTtsMode('managed');
          localStorage.setItem(LS_TTS_MODE, 'managed');
          setTtsVoices(discovery.voices || []);
          setTtsState(discovery.ok ? '等待发送' : ttsErrorMessage(discovery.code));
        } else {
          setTtsVoices([]);
          setTtsState('请配置 ElevenLabs API Key');
        }
        return;
      }
      const response = ttsMode === 'byok'
        ? await setTtsCredentials(ttsApiKey)
        : await setTtsCredentials('');
      if (cancelled) return;
      if (response.provider) setTtsProvider(response.provider);
      if (response.provider === 'cosyvoice' && ttsMode === 'byok') {
        setTtsMode('managed');
        localStorage.setItem(LS_TTS_MODE, 'managed');
        return;
      }
      setTtsVoices(response.voices || []);
      if (!response.ok) {
        setTtsState(ttsErrorMessage(response.code));
        return;
      }
      const savedStillExists = response.voices.some((voice) => voice.id === ttsVoiceId);
      if (!savedStillExists) {
        const nextId = response.voices[0]?.id || '';
        setTtsVoiceId(nextId);
        if (nextId) localStorage.setItem(LS_TTS_VOICE, nextId);
        else localStorage.removeItem(LS_TTS_VOICE);
      }
      setTtsState(response.voices.length ? '等待发送' : '没有可用声音');
    };
    load().catch((error) => {
      if (!cancelled) setTtsState(`声音加载失败：${error?.message || error}`);
    });
    return () => { cancelled = true; };
  }, [status, ttsApiKey, ttsMode]);

  useEffect(() => {
    if (status !== 'connected' || !peers.peerPetOnline) {
      setMotions([]);
      setVoices([]);
      if (!peers.peerPetOnline) teardownCall({ nextState: 'idle' });
      return;
    }
    listMotions().then((items) => {
      setMotions(items);
    });
    listVoices().then((files) => {
      setVoices(files);
      if (!files.length) showToast('桌宠端没有预录台词');
    });
  }, [status, peers.peerPetOnline, showToast, teardownCall]);

  const toggleRemoteAudio = useCallback(async (kind: 'mic' | 'system') => {
    const isMic = kind === 'mic';
    const audio = isMic ? remoteMicAudioRef.current : remoteSystemAudioRef.current;
    const currentlyMuted = isMic ? remoteMicMuted : remoteSystemMuted;
    const nextMuted = !currentlyMuted;
    if (isMic) setRemoteMicMuted(nextMuted);
    else setRemoteSystemMuted(nextMuted);
    if (!audio) return;
    audio.muted = nextMuted;
    audio.volume = nextMuted ? 0 : 1;
    if (!nextMuted) {
      try {
        await audio.play();
        showToast(isMic ? '桌宠麦克风已打开' : '电脑系统声音已打开');
      } catch (e: any) {
        showToast(`声音播放失败：${e?.message || e}`, true);
      }
    }
  }, [remoteMicMuted, remoteSystemMuted, showToast]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await videoStageRef.current?.requestFullscreen();
      }
    } catch (e: any) {
      showToast(`全屏切换失败：${e?.message || e}`, true);
    }
  }, [showToast]);

  useEffect(() => {
    if (callState !== 'calling' && callState !== 'in-call') return;
    const timer = window.setInterval(() => {
      const pc = rtcPcRef.current;
      if (!pc) return;
      readRtcRoute(pc).then(setRtcRoute).catch(() => {});
    }, 2500);
    return () => window.clearInterval(timer);
  }, [callState]);

  const onConnect = useCallback(async () => {
    if (!serverUrl.trim() || !secret.trim()) {
      showToast('填一下服务器和密钥', true);
      return;
    }
    if (window.desktopPetControl) {
      const result = await window.desktopPetControl.savePairingConfig({
        serverUrl: serverUrl.trim(),
        roomSecret: secret.trim(),
      });
      if (!result.ok) showToast(result.error || '保存配置失败', true);
      return;
    }
    localStorage.setItem(LS_SERVER, serverUrl);
    localStorage.setItem(LS_SECRET, secret);
    connect(serverUrl.trim(), secret.trim(), participantId);
  }, [participantId, secret, serverUrl, showToast]);

  const onDisconnect = useCallback(() => {
    teardownCall({ sendRemoteHangup: true, nextState: 'idle' });
    disconnect();
  }, [teardownCall]);

  const canSend = status === 'connected' && peers.peerPetOnline;
  const canCall = canSend && peers.peerControllerOnline;

  const send = useCallback((cmd: Command, label: string) => {
    if (!canSend) {
      showToast(status === 'connected' ? '桌宠端未上线' : '未连接', true);
      return;
    }
    const ok = sendCommand(cmd);
    showToast(ok ? `✔ ${label}` : '发送失败', !ok);
  }, [canSend, showToast, status]);

  const selectTtsMode = useCallback((mode: 'managed' | 'byok') => {
    setTtsMode(mode);
    localStorage.setItem(LS_TTS_MODE, mode);
    setTtsState(mode === 'managed' ? '正在读取服务端声音…' : '请配置自己的 ElevenLabs API Key');
  }, []);

  const saveByokKey = useCallback(async () => {
    const apiKey = ttsApiKeyInput.trim();
    if (!apiKey) {
      showToast('请输入 ElevenLabs API Key', true);
      return;
    }
    setTtsState('正在验证 API Key…');
    const validation = await setTtsCredentials(apiKey);
    if (!validation.ok) {
      const message = ttsErrorMessage(validation.code);
      setTtsState(message);
      showToast(message, true);
      return;
    }
    if (window.desktopPetControl) {
      const result = await window.desktopPetControl.saveTtsCredentials(apiKey);
      if (!result.ok) {
        showToast(`安全保存失败：${result.error || 'unknown'}`, true);
        return;
      }
    }
    setTtsApiKey(apiKey);
    setTtsApiKeyInput('');
    setTtsKeyConfigured(true);
    setTtsVoices(validation.voices || []);
    selectTtsMode('byok');
  }, [selectTtsMode, showToast, ttsApiKeyInput]);

  const clearByokKey = useCallback(async () => {
    if (window.desktopPetControl) await window.desktopPetControl.saveTtsCredentials('');
    setTtsApiKey('');
    setTtsApiKeyInput('');
    setTtsKeyConfigured(false);
    selectTtsMode('managed');
  }, [selectTtsMode]);

  const previewTtsVoice = useCallback(() => {
    const voice = ttsVoices.find((item) => item.id === ttsVoiceId);
    if (!voice?.previewUrl) {
      showToast('这个声音没有可用试听', true);
      return;
    }
    const audio = new Audio(voice.previewUrl);
    audio.play().catch((error) => showToast(`试听失败：${error?.message || error}`, true));
  }, [showToast, ttsVoiceId, ttsVoices]);

  const onSendTts = useCallback(async () => {
    const text = tts.trim();
    if (!text) return;
    if (text.length > 200) {
      showToast('太长了，控制在 200 字内', true);
      return;
    }
    if (!ttsVoiceId) {
      showToast('请先选择自己的声音', true);
      return;
    }
    setTtsState('正在提交…');
    const result = await createTts(text, ttsVoiceId);
    if (!result.ok) {
      const message = ttsErrorMessage(result.code);
      setTtsState(message);
      showToast(message, true);
      return;
    }
    setTts('');
    setTtsState(result.position ? `排队中（前面 ${result.position} 条）` : '已发送到对方桌宠');
  }, [showToast, tts, ttsVoiceId]);

  const onStartCall = useCallback(async () => {
    if (!canCall) {
      showToast('先连上桌宠', true);
      return;
    }
    try {
      setCallState('requesting-media');
      const result = await requestCall();
      if (!result.ok) throw new Error(result.code === 'peer_not_ready' ? '对方二合一客户端尚未就绪' : '无法创建通话');
    } catch (e: any) {
      console.warn('[webrtc] startCall failed:', e);
      showToast(`开通话失败：${e?.message || e}`, true);
      teardownCall({ nextState: 'error' });
    }
  }, [canCall, showToast, teardownCall]);

  const onEndCall = useCallback(() => {
    teardownCall({ sendRemoteHangup: true, nextState: 'idle' });
  }, [teardownCall]);

  const toggleLocalMic = useCallback(() => {
    if (callState !== 'in-call' && callState !== 'calling') return;
    setMicEnabled(!micEnabled);
  }, [callState, micEnabled, setMicEnabled]);

  const groupedVoices = useMemo(() => {
    const g: Record<string, string[]> = { head: [], body: [], tail: [], idle: [], other: [] };
    for (const v of voices) g[voicePart(v)].push(v);
    return g;
  }, [voices]);

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">REMOTE CONSOLE</p>
          <h1>桌宠远程控制台</h1>
          <p className="hero-copy">黑白蓝主界面，优先把屏幕、通话和控制动作放到一屏内。</p>
        </div>
        <div className="hero-badge">
          <span className={`signal ${peers.peerOnline ? 'on' : ''}`} />
          <span>{peers.peerOnline ? '对方在线' : '等待对方'}</span>
        </div>
      </header>

      <div className="status-bar">
        <div className="status-row">
          <label>服务器</label>
          <input
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="http://localhost:3030"
            disabled={status === 'connecting' || status === 'connected'}
          />
        </div>
        <div className="status-row">
          <label>房间密钥</label>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="ROOM_SECRET"
            disabled={status === 'connecting' || status === 'connected'}
          />
        </div>
        <div className="status-row">
          <StatusPill status={status} />
          <PeerPill role="pet" online={peers.peerPetOnline} />
          {!window.desktopPetControl && !peers.selfReady && <span className="hint">浏览器模式：仅控制端在线</span>}
          <div style={{ flex: 1 }} />
          {status === 'connected' || status === 'connecting' ? (
            <button className="btn" onClick={onDisconnect}>断开</button>
          ) : (
            <button className="btn accent" onClick={onConnect}>连接</button>
          )}
        </div>
      </div>

      <section className="section">
        <h2>通话</h2>
        <audio ref={remoteMicAudioRef} autoPlay muted={remoteMicMuted} />
        <audio ref={remoteSystemAudioRef} autoPlay muted={remoteSystemMuted} />
        <div className="video-stage" ref={videoStageRef}>
          <video ref={remoteVideoRef} className={`video-frame ${remoteReady ? 'ready' : ''}`} playsInline autoPlay />
          {!remoteReady && (
            <div className="video-empty">
              {callState === 'calling' || callState === 'requesting-media'
                ? '正在等桌宠把屏幕推过来。\n如果一直没画面，先去 B 端确认屏幕录制权限。'
                : '点“开始通话”后，这里会显示她的屏幕。'}
            </div>
          )}
          <button
            type="button"
            className="video-fullscreen"
            disabled={!remoteReady}
            onClick={toggleFullscreen}
            aria-label="切换视频全屏"
          >全屏</button>
        </div>
        <div className="video-meta">
          <span>{remoteReady ? '已收到桌面视频流' : '尚未收到视频流'}</span>
          <span>远端轨道：{remoteTrackSummary}</span>
          <span>麦克风：{remoteMicMuted ? '静音' : '播放'}</span>
          <span>系统声音：{remoteSystemMuted ? '静音' : '播放'}</span>
        </div>
        <div className={`rtc-route ${rtcRoute.candidateType}`}>
          <span>ICE：{rtcRoute.candidateType}</span>
          <span>{rtcRoute.relayed ? '正在走中继，会吃 TURN 带宽' : '优先点对点，不走本项目服务器视频带宽'}</span>
          <span>{rtcRoute.detail}</span>
        </div>
        <div className="call-row">
          <CallPill state={callState} />
          <button
            className="btn accent"
            disabled={!canCall || callState === 'calling' || callState === 'requesting-media' || callState === 'in-call'}
            onClick={onStartCall}
          >开始通话</button>
          <button
            className="btn"
            disabled={callState !== 'calling' && callState !== 'in-call'}
            onClick={onEndCall}
          >结束通话</button>
          <button
            className={`btn ${micEnabled ? 'accent' : ''}`}
            disabled={callState !== 'calling' && callState !== 'in-call'}
            onClick={toggleLocalMic}
          >{micEnabled ? '关闭麦克风' : '打开麦克风'}</button>
          <button
            className="btn"
            disabled={callState !== 'calling' && callState !== 'in-call'}
            onClick={() => toggleRemoteAudio('mic')}
          >{remoteMicMuted ? '播放麦克风' : '静音麦克风'}</button>
          <button
            className="btn"
            disabled={callState !== 'calling' && callState !== 'in-call'}
            onClick={() => toggleRemoteAudio('system')}
          >{remoteSystemMuted ? '播放系统声音' : '静音系统声音'}</button>
        </div>
      </section>

      <section className="section">
        <h2>表情</h2>
        <div className="grid tight">
          {EXPRESSIONS.map((e) => (
            <button
              key={e.name}
              className="btn"
              disabled={!canSend}
              onClick={() => send({ type: 'expression', name: e.name }, e.label)}
            >{e.label}</button>
          ))}
        </div>
        <h3>动作</h3>
        <div className="grid tight">
          <button
            className="btn"
            disabled={!canSend}
            onClick={() => send({ type: 'animation', name: 'idle' }, '默认动作')}
          >默认动作</button>
          {motions.filter((m) => m.id !== 'idle').map((m) => (
            <button
              key={m.id}
              className="btn"
              disabled={!canSend}
              onClick={() => send({ type: 'animation', name: m.id }, m.label)}
            >{m.label}</button>
          ))}
        </div>
        {motions.length === 0 && (
          <div className="empty">
            {canSend ? '当前模型还没配置额外动作；默认动作仍可使用' : '连上后会显示额外动作'}
          </div>
        )}
      </section>

      <section className="section">
        <h2>预录台词</h2>
        {voices.length === 0 ? (
          <div className="empty">
            {canSend ? '桌宠端没扫到台词；放 .wav 到 pet/public/voices/ 下重启即可' : '连上后会显示'}
          </div>
        ) : (
          (['head', 'body', 'tail', 'idle', 'other'] as const).map((part) => groupedVoices[part]?.length ? (
            <div key={part}>
              <h3>{part}</h3>
              <div className="grid">
                {groupedVoices[part].map((url) => (
                  <button
                    key={url}
                    className="btn"
                    disabled={!canSend}
                    onClick={() => send({ type: 'say_audio', url }, voiceLabel(url))}
                  >{voiceLabel(url)}</button>
                ))}
              </div>
            </div>
          ) : null)
        )}
      </section>

      <section className="section">
        <h2>语音消息 · {ttsProvider === 'cosyvoice' ? 'CosyVoice' : 'ElevenLabs'}</h2>
        <div className="tts-area">
          <div className="tts-mode-row">
            <button className={`btn ${ttsMode === 'managed' ? 'accent' : ''}`} onClick={() => selectTtsMode('managed')}>服务端声音</button>
            {ttsProvider === 'elevenlabs' && <button className={`btn ${ttsMode === 'byok' ? 'accent' : ''}`} onClick={() => selectTtsMode('byok')}>使用我的 API Key</button>}
            <span className="tts-hint">发送后由对方桌宠用你的克隆声音播放</span>
          </div>
          {ttsMode === 'byok' && (
            <div className="tts-key-row">
              <input
                type="password"
                value={ttsApiKeyInput}
                onChange={(event) => setTtsApiKeyInput(event.target.value)}
                placeholder={ttsKeyConfigured ? 'API Key 已安全保存，输入新 Key 可替换' : 'ElevenLabs API Key'}
                autoComplete="off"
              />
              <button className="btn" disabled={!ttsApiKeyInput.trim()} onClick={saveByokKey}>验证并保存</button>
              {ttsKeyConfigured && <button className="btn danger" onClick={clearByokKey}>删除 Key</button>}
            </div>
          )}
          <div className="tts-voice-row">
            <label htmlFor="tts-voice">我的声音</label>
            <select
              id="tts-voice"
              value={ttsVoiceId}
              disabled={status !== 'connected' || !ttsVoices.length}
              onChange={(event) => {
                setTtsVoiceId(event.target.value);
                localStorage.setItem(LS_TTS_VOICE, event.target.value);
              }}
            >
              {!ttsVoices.length && <option value="">暂无可用声音</option>}
              {ttsVoices.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
            </select>
            <button className="btn" disabled={!ttsVoices.find((voice) => voice.id === ttsVoiceId)?.previewUrl} onClick={previewTtsVoice}>试听</button>
            <span className="tts-status">{ttsState}</span>
          </div>
          <textarea
            value={tts}
            onChange={(e) => setTts(e.target.value)}
            placeholder="想你了… (Ctrl/Cmd + Enter 发送)"
            maxLength={200}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                onSendTts();
              }
            }}
          />
          <div className="tts-row">
            <button
              className="btn accent"
              disabled={!canSend || !tts.trim() || !ttsVoiceId}
              onClick={onSendTts}
            >让她听到 ▶</button>
            <span className="tts-hint">只使用本人所有或已获授权的克隆声音</span>
            <div style={{ flex: 1 }} />
            <span className="tts-hint">{tts.length}/200</span>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>位置</h2>
        <div className="grid tight">
          {CORNERS.map((c) => (
            <button
              key={c.corner}
              className="btn"
              disabled={!canSend}
              onClick={() => send({ type: 'relocate', corner: c.corner }, `贴 ${c.label}`)}
            >{c.label}</button>
          ))}
        </div>
      </section>

      <div className={`toast ${toast ? 'on' : ''} ${toast?.err ? 'err' : ''}`}>
        {toast?.msg}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: Status }) {
  const map: Record<Status, { cls: string; text: string }> = {
    idle:         { cls: '',      text: '未连接' },
    connecting:   { cls: 'warn',  text: '连接中…' },
    connected:    { cls: 'ok',    text: '已连接' },
    disconnected: { cls: 'bad',   text: '断开' },
    rejected:     { cls: 'bad',   text: '被拒绝' },
  };
  const m = map[status];
  return <span className={`pill ${m.cls}`}><span className="dot" /> {m.text}</span>;
}

function PeerPill({ role, online }: { role: 'pet' | 'controller'; online: boolean }) {
  const text = role === 'pet' ? '桌宠端' : '控制端';
  return (
    <span className={`pill ${online ? 'ok' : ''}`}>
      <span className="dot" /> {text}：{online ? '在线' : '离线'}
    </span>
  );
}

function CallPill({ state }: { state: CallState }) {
  const map: Record<CallState, { cls: string; text: string }> = {
    idle:               { cls: '', text: '未通话' },
    'requesting-media': { cls: 'warn', text: '拿麦克风中…' },
    calling:            { cls: 'warn', text: '呼叫中…' },
    'in-call':          { cls: 'ok', text: '通话中' },
    error:              { cls: 'bad', text: '通话失败' },
  };
  const m = map[state];
  return <span className={`pill ${m.cls}`}><span className="dot" /> {m.text}</span>;
}
