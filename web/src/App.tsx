import { useCallback, useEffect, useRef, useState } from 'react';
import {
  connect,
  disconnect,
  listMotions,
  listTtsVoices,
  createTts,
  endCall,
  requestCall,
  requestRtcConfig,
  sendCommand,
  sendSignal,
  setListeners,
  setTtsCredentials,
  addPersonalAudio, deletePersonalAudio, listPersonalAudio, playPersonalAudio, renamePersonalAudio,
  getPersonalAudio,
  renameMember, discoverPairing, changeMember,
  reclaimDevice,
  type Command,
  type MotionMeta,
  type Peers,
  type TtsStatus,
  type TtsProvider,
  type TtsVoice,
  type WebRtcSignal,
  type MediaStatus,
  type PersonalAudio, type PairingMember,
} from './api';

type Status = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'rejected';
type CallState = 'idle' | 'requesting-media' | 'calling' | 'in-call' | 'error';
type ActiveView = 'control' | 'send' | 'call' | 'settings';
type SendView = 'tts' | 'audio';
type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown' | 'failed';
type MemberId = 'a' | 'b';
type SetupStage = 'server' | 'identity' | 'complete';

type RtcRoute = {
  candidateType: CandidateType;
  relayed: boolean;
  path: 'IPv4 P2P' | 'IPv6 P2P' | 'TURN 音频兜底' | '选路中' | '失败';
  detail: string;
};

const LS_SERVER = 'pet.serverUrl';
const LS_SECRET = 'pet.secret';
const LS_PARTICIPANT = 'pet.participantId';
const LS_TARGET_DEVICE = 'pet.targetDeviceId';
const LS_TARGET_DEVICES = 'pet.targetDeviceIds';
const LS_MEMBER_NAMES = 'pet.memberNames';
const LS_TTS_MODE = 'pet.ttsMode';
const LS_TTS_VOICE = 'pet.ttsVoiceId';

type PairingConfig = { serverUrl?: string; roomSecret?: string; deviceId?: string; deviceName?: string; memberId?: 'a' | 'b' };
type PetScaleResult = { ok: boolean; scale?: number; error?: string };
type DiagnosticsExportResult = { ok: boolean; canceled?: boolean; path?: string; error?: string };

declare global {
  interface Window {
    desktopPetControl?: {
      getPairingConfig: () => Promise<PairingConfig>;
      savePairingConfig: (config: PairingConfig) => Promise<{ ok: boolean; error?: string; config?: PairingConfig }>;
      onPairingChanged: (cb: (config: PairingConfig) => void) => void;
      getTtsCredentials: () => Promise<{ configured: boolean; apiKey?: string }>;
      saveTtsCredentials: (apiKey: string) => Promise<{ ok: boolean; configured?: boolean; error?: string }>;
      getPetScale: () => Promise<number>;
      setPetScale: (scale: number) => Promise<PetScaleResult>;
      resetPetScale: () => Promise<PetScaleResult>;
      onPetScaleChanged: (cb: (scale: number) => void) => () => void;
      exportDiagnostics: () => Promise<DiagnosticsExportResult>;
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

const QUICK_MOTION_IDS = new Set(['joy', 'jumping', 'sorrow', 'waiting']);
const QUICK_MOTION_ICONS: Record<string, string> = {
  joy: '♡',
  jumping: '↑',
  sorrow: '☁',
  waiting: '…',
};

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
  path: '选路中',
  detail: '等待 ICE 选路',
};

type PeerDevice = Peers['members'][number]['devices'][number];

function readSavedTargets(memberId: string, devices: PeerDevice[]): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${LS_TARGET_DEVICES}.${memberId}`) || '[]');
    if (Array.isArray(parsed)) return parsed.filter((id): id is string => typeof id === 'string');
  } catch {}
  const legacy = localStorage.getItem(LS_TARGET_DEVICE);
  return legacy && devices.some((device) => device.id === legacy) ? [legacy] : [];
}

function normalizeTargets(devices: PeerDevice[], saved: string[]): string[] {
  const online = devices.filter((device) => device.petOnline);
  const onlineIds = new Set(online.map((device) => device.id));
  const retained = saved.filter((id, index) => onlineIds.has(id) && saved.indexOf(id) === index);
  if (retained.length) return retained;
  const newest = [...online].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0];
  return newest ? [newest.id] : [];
}

function readMemberNames(): Record<'a' | 'b', string> {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_MEMBER_NAMES) || '{}');
    return { a: String(saved.a || '用户 A'), b: String(saved.b || '用户 B') };
  } catch {
    return { a: '用户 A', b: '用户 B' };
  }
}

function hasCompletePairing(config: PairingConfig) {
  return !!String(config.serverUrl || '').trim()
    && !!String(config.roomSecret || '').trim()
    && (config.memberId === 'a' || config.memberId === 'b')
    && !!String(config.deviceId || '').trim()
    && !!String(config.deviceName || '').trim();
}

function pairingErrorMessage(code?: string) {
  const messages: Record<string, string> = {
    bad_secret: '服务器密钥不正确',
    upgrade_required: '服务器版本过旧，请先更新服务器',
    timeout: '连接服务器超时，请检查地址和网络',
    unreachable: '无法连接服务器，请检查地址和网络',
    invalid_member: '请选择有效身份',
    device_identity_conflict: '该设备身份与服务器记录冲突，请重试',
    device_move_failed: '服务器无法迁移设备身份，请稍后重试',
    disconnected: '当前未连接服务器',
  };
  return messages[code || ''] || '操作失败，请重试';
}

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
    return { candidateType: 'failed', relayed: false, path: '失败', detail: 'ICE 连接失败' };
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
  const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
  const protocol = local?.protocol || pair.protocol || '';
  const localAddr = candidateAddress(local);
  const remoteAddr = candidateAddress(remote);
  const addresses = [localAddr, remoteAddr].filter(Boolean);
  const ipv6 = addresses.some((address) => address.includes(':'));
  const ipv4 = addresses.some((address) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address));
  const detail = [
    candidateType,
    protocol,
    localAddr && remoteAddr ? `${localAddr} → ${remoteAddr}` : '',
  ].filter(Boolean).join(' · ');

  return {
    candidateType,
    relayed,
    path: relayed ? 'TURN 音频兜底' : ipv6 ? 'IPv6 P2P' : ipv4 ? 'IPv4 P2P' : '选路中',
    detail: detail || 'ICE 已连接',
  };
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
  const [memberId, setMemberId] = useState<MemberId | ''>('');
  const [deviceName, setDeviceName] = useState('浏览器');
  const [activeView, setActiveView] = useState<ActiveView>('settings');
  const [sendView, setSendView] = useState<SendView>('tts');
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [callTargetId, setCallTargetId] = useState('');
  const [targetMenuOpen, setTargetMenuOpen] = useState(false);
  const [editingMemberId, setEditingMemberId] = useState<'a' | 'b' | null>(null);
  const [memberNameDraft, setMemberNameDraft] = useState('');
  const [knownMemberNames, setKnownMemberNames] = useState(readMemberNames);
  const [setupStage, setSetupStage] = useState<SetupStage>(() => window.desktopPetControl ? 'server' : 'complete');
  const [verifiedMembers, setVerifiedMembers] = useState<PairingMember[] | null>(null);
  const [verifyingPairing, setVerifyingPairing] = useState(false);
  const [identityChangeOpen, setIdentityChangeOpen] = useState(false);
  const [identityChangeTarget, setIdentityChangeTarget] = useState<MemberId>('a');
  const [identityChanging, setIdentityChanging] = useState(false);
  const [editingAudioId, setEditingAudioId] = useState<string | null>(null);
  const [audioNameDraft, setAudioNameDraft] = useState('');
  const [deleteAudioId, setDeleteAudioId] = useState<string | null>(null);
  const [reclaimCandidate, setReclaimCandidate] = useState<PeerDevice | null>(null);
  const [peers, setPeers] = useState<Peers>({
    protocolVersion: 2, self: { memberId: 'a', deviceId: '' }, members: [],
    selfReady: false, peerOnline: false, peerPetOnline: false, peerControllerOnline: false,
    controller: false, pet: false,
  });
  const [motions, setMotions] = useState<MotionMeta[]>([]);
  const [personalAudio, setPersonalAudio] = useState<PersonalAudio[]>([]);
  const [recording, setRecording] = useState(false);
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
  const [petScale, setPetScaleState] = useState(1);
  const [callState, setCallState] = useState<CallState>('idle');
  const [remoteMicMuted, setRemoteMicMuted] = useState(true);
  const [remoteSystemMuted, setRemoteSystemMuted] = useState(true);
  const [micEnabled, setMicEnabledState] = useState(false);
  const [remoteReady, setRemoteReady] = useState(false);
  const [screenStatus, setScreenStatus] = useState<MediaStatus['state']>('unavailable');
  const [remoteTrackSummary, setRemoteTrackSummary] = useState('无');
  const [rtcRoute, setRtcRoute] = useState<RtcRoute>(EMPTY_RTC_ROUTE);
  const toastTimer = useRef<number | null>(null);
  const personalAudioRecorderRef = useRef<MediaRecorder | null>(null);
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
  const callTargetIdRef = useRef('');
  const recoveryTimerRef = useRef<number | null>(null);
  const iceRestartedRef = useRef(false);

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
    if (recoveryTimerRef.current) window.clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = null;
    iceRestartedRef.current = false;
    rtcPcRef.current = null;
    pendingCandidatesRef.current = [];
    stopLocalAudio();
    setMicEnabled(false);
    setRemoteReady(false);
    setScreenStatus('unavailable');
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
    return sendSignal({ ...signal, callId: currentCallIdRef.current || undefined }, callTargetIdRef.current || undefined);
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
    setRemoteReady(videoTracks.length > 0 && screenStatus === 'available');

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
  }, [screenStatus]);

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
    const rtcConfig = await requestRtcConfig();
    const pc = new RTCPeerConnection(rtcConfig);
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
        if (recoveryTimerRef.current) window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
        setCallState('in-call');
        readRtcRoute(pc).then(setRtcRoute).catch(() => {});
        return;
      }
      if (state === 'failed' || state === 'disconnected') {
        setRtcRoute({ candidateType: 'failed', relayed: false, path: '失败', detail: `连接状态：${state}，正在恢复` });
        if (!iceRestartedRef.current) {
          iceRestartedRef.current = true;
          pc.createOffer({ iceRestart: true }).then(async (offer) => {
            if (rtcPcRef.current !== pc) return;
            await pc.setLocalDescription(offer);
            sendRtcSignal({ description: pc.localDescription });
          }).catch((error) => console.warn('[webrtc] ICE restart failed:', error));
        }
        if (!recoveryTimerRef.current) recoveryTimerRef.current = window.setTimeout(() => {
          if (rtcPcRef.current !== pc || pc.connectionState === 'connected') return;
          showToast('通话恢复超时，已断开', true);
          endCall(currentCallIdRef.current || undefined);
          teardownCall({ nextState: 'idle' });
        }, 15_000);
      }
      if (state === 'closed') teardownCall({ nextState: 'idle' });
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        readRtcRoute(pc).then(setRtcRoute).catch(() => {});
      }
      if (pc.iceConnectionState === 'failed') {
        setRtcRoute({ candidateType: 'failed', relayed: false, path: '失败', detail: 'ICE 连接失败' });
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
      onPeers: (next) => {
        setPeers(next);
        const names = {
          a: next.members.find((member) => member.id === 'a')?.displayName || '用户 A',
          b: next.members.find((member) => member.id === 'b')?.displayName || '用户 B',
        };
        setKnownMemberNames(names);
        localStorage.setItem(LS_MEMBER_NAMES, JSON.stringify(names));
        const peer = next.members.find((member) => member.id !== next.self.memberId);
        if (!peer) return;
        setTargetIds((current) => {
          const saved = current.length ? current : readSavedTargets(peer.id, peer.devices);
          const selected = normalizeTargets(peer.devices, saved);
          localStorage.setItem(`${LS_TARGET_DEVICES}.${peer.id}`, JSON.stringify(selected));
          return selected;
        });
        const callable = peer.devices.filter((device) => device.petOnline && device.controllerOnline);
        setCallTargetId((current) => {
          if (callable.some((device) => device.id === current)) return current;
          return callable.length === 1 ? callable[0].id : '';
        });
      },
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
      onMediaStatus: (payload) => {
        if (payload.callId !== currentCallIdRef.current) return;
        if (payload.media === 'screen') {
          setScreenStatus(payload.state);
          setRemoteReady(payload.state === 'available' && !!remoteVideoStreamRef.current?.getVideoTracks().length);
          if (payload.reason === 'relay_audio_only') showToast('当前走 TURN：已停用画面，仅保留音频');
          if (payload.reason === 'capture_failed') showToast('对方屏幕采集失败，音频仍可继续', true);
          if (payload.reason === 'track_ended') showToast('对方已停止屏幕共享，音频仍可继续');
        }
      },
      onCallStart: (callId, peerDeviceId) => {
        callTargetIdRef.current = peerDeviceId || callTargetIdRef.current;
        setActiveView('call');
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
      const nextParticipant = String(config.deviceId || '').trim();
      setServerUrl(nextServer);
      setSecret(nextSecret);
      if (nextParticipant) setParticipantId(nextParticipant);
      if (config.memberId) setMemberId(config.memberId);
      if (config.deviceName) setDeviceName(config.deviceName);
      if (!hasCompletePairing(config)) {
        setMemberId('');
        setSetupStage('server');
        setVerifiedMembers(null);
        setActiveView('settings');
        disconnect();
        return;
      }
      setSetupStage('complete');
      const configuredMemberId = config.memberId;
      const configuredDeviceName = String(config.deviceName || '').trim();
      if (configuredMemberId !== 'a' && configuredMemberId !== 'b') return;
      connect(nextServer, nextSecret, { memberId: configuredMemberId, deviceId: nextParticipant, deviceName: configuredDeviceName });
    };
    bridge.getPairingConfig().then(applyConfig).catch((e) => {
      showToast(`读取桌宠配置失败：${e?.message || e}`, true);
    });
    bridge.onPairingChanged(applyConfig);
  }, [showToast]);

  useEffect(() => {
    const bridge = window.desktopPetControl;
    if (!bridge) return;
    bridge.getPetScale().then((scale) => setPetScaleState(scale)).catch((error) => {
      showToast(`读取桌宠大小失败：${error?.message || error}`, true);
    });
    return bridge.onPetScaleChanged((scale) => setPetScaleState(scale));
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
      if (!peers.peerPetOnline) teardownCall({ nextState: 'idle' });
      return;
    }
    const primaryTargetId = targetIds[0];
    if (!primaryTargetId) return;
    listMotions(primaryTargetId).then((items) => {
      setMotions(items);
    });
  }, [status, peers.peerPetOnline, targetIds, teardownCall]);

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
    if (!memberId) {
      showToast('请选择我的身份', true);
      return;
    }
    if (window.desktopPetControl) {
      const result = await window.desktopPetControl.savePairingConfig({
        serverUrl: serverUrl.trim(),
        roomSecret: secret.trim(),
        memberId,
        deviceName,
      });
      if (!result.ok) showToast(result.error || '保存配置失败', true);
      return;
    }
    localStorage.setItem(LS_SERVER, serverUrl);
    localStorage.setItem(LS_SECRET, secret);
    connect(serverUrl.trim(), secret.trim(), { memberId, deviceId: participantId, deviceName });
    setSetupStage('complete');
  }, [deviceName, memberId, participantId, secret, serverUrl, showToast]);

  const onDisconnect = useCallback(() => {
    teardownCall({ sendRemoteHangup: true, nextState: 'idle' });
    disconnect();
  }, [teardownCall]);

  const verifyPairing = useCallback(async () => {
    if (!serverUrl.trim() || !secret.trim()) {
      showToast('填一下服务器和密钥', true);
      return;
    }
    setVerifyingPairing(true);
    const result = await discoverPairing(serverUrl.trim(), secret.trim());
    setVerifyingPairing(false);
    if (!result.ok || !result.members) {
      showToast(pairingErrorMessage(result.code), true);
      return;
    }
    const names = {
      a: result.members.find((member) => member.id === 'a')?.displayName || '用户 A',
      b: result.members.find((member) => member.id === 'b')?.displayName || '用户 B',
    };
    setKnownMemberNames(names);
    localStorage.setItem(LS_MEMBER_NAMES, JSON.stringify(names));
    setVerifiedMembers(result.members);
    setMemberId('');
    setSetupStage('identity');
  }, [secret, serverUrl, showToast]);

  const resetPairingVerification = useCallback(() => {
    if (setupStage === 'complete') return;
    setVerifiedMembers(null);
    setMemberId('');
    setSetupStage('server');
  }, [setupStage]);

  const confirmIdentityChange = useCallback(async () => {
    const bridge = window.desktopPetControl;
    if (!bridge || !memberId || identityChangeTarget === memberId) return;
    setIdentityChanging(true);
    const moved = await changeMember(identityChangeTarget);
    if (!moved.ok) {
      setIdentityChanging(false);
      showToast(pairingErrorMessage(moved.code), true);
      return;
    }
    const saved = await bridge.savePairingConfig({ serverUrl, roomSecret: secret, memberId: identityChangeTarget, deviceName });
    if (!saved.ok) {
      const restored = await changeMember(memberId);
      setIdentityChanging(false);
      showToast(restored.ok ? '本地保存失败，身份已恢复' : '本地保存失败，服务器身份需要重试恢复', true);
      return;
    }
    setIdentityChanging(false);
    setIdentityChangeOpen(false);
    showToast('身份已更改，正在重新连接');
  }, [deviceName, identityChangeTarget, memberId, secret, serverUrl, showToast]);

  const refreshPersonalAudio = useCallback(async () => {
    const result = await listPersonalAudio();
    if (result?.ok) setPersonalAudio(result.items || []);
  }, []);

  useEffect(() => {
    if (status === 'connected') void refreshPersonalAudio();
    else setPersonalAudio([]);
  }, [refreshPersonalAudio, status]);

  const uploadAudioBlob = useCallback(async (blob: Blob, name: string, durationMs: number) => {
    const result = await addPersonalAudio({ name, mime: blob.type, durationMs, data: await blob.arrayBuffer() });
    if (!result?.ok) return showToast(`添加音频失败：${result?.code || 'unknown'}`, true);
    await refreshPersonalAudio();
  }, [refreshPersonalAudio, showToast]);

  const importAudio = useCallback(async (file?: File) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);
    audio.onloadedmetadata = async () => {
      URL.revokeObjectURL(url);
      await uploadAudioBlob(file, file.name.replace(/\.[^.]+$/, ''), Math.round(audio.duration * 1000));
    };
    audio.onerror = () => { URL.revokeObjectURL(url); showToast('无法读取这个音频文件', true); };
  }, [showToast, uploadAudioBlob]);

  const recordAudio = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '' });
    const chunks: Blob[] = [];
    const started = Date.now();
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      personalAudioRecorderRef.current = null;
      setRecording(false);
      await uploadAudioBlob(new Blob(chunks, { type: recorder.mimeType }), `录音 ${new Date().toLocaleString()}`, Math.min(60_000, Date.now() - started));
    };
    recorder.start(); setRecording(true);
    window.setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 60_000);
    personalAudioRecorderRef.current = recorder;
  }, [uploadAudioBlob]);

  const changePetScale = useCallback(async (scale: number) => {
    const result = await window.desktopPetControl?.setPetScale(scale);
    if (!result) return;
    if (!result.ok) {
      showToast(result.error || '调整桌宠大小失败', true);
      return;
    }
    if (typeof result.scale === 'number') setPetScaleState(result.scale);
  }, [showToast]);

  const resetPetScale = useCallback(async () => {
    const result = await window.desktopPetControl?.resetPetScale();
    if (!result) return;
    if (!result.ok) {
      showToast(result.error || '恢复默认大小失败', true);
      return;
    }
    showToast('桌宠大小已恢复为 100%');
  }, [showToast]);

  const exportDiagnostics = useCallback(async () => {
    const result = await window.desktopPetControl?.exportDiagnostics();
    if (!result || result.canceled) return;
    showToast(result.ok ? '诊断日志已导出' : `导出失败：${result.error || 'unknown'}`, !result.ok);
  }, [showToast]);

  const peerMember = peers.members.find((member) => member.id !== peers.self.memberId);
  const selfMember = peers.members.find((member) => member.id === peers.self.memberId);
  const onlineDevices = peerMember?.devices.filter((device) => device.petOnline) || [];
  const callableDevices = peerMember?.devices.filter((device) => device.petOnline && device.controllerOnline) || [];
  const selectedDevices = onlineDevices.filter((device) => targetIds.includes(device.id));
  const canSend = status === 'connected' && selectedDevices.length > 0;
  const quickMotions = motions.filter((motion) => QUICK_MOTION_IDS.has(motion.id));
  const canCall = status === 'connected' && callableDevices.some((device) => device.id === callTargetId);
  const pairingIncomplete = !!window.desktopPetControl && (!serverUrl.trim() || !secret.trim() || !memberId || !participantId || !deviceName.trim());
  const setupRequired = setupStage !== 'complete' || pairingIncomplete;
  const setupStep: Exclude<SetupStage, 'complete'> = setupStage === 'identity' && verifiedMembers ? 'identity' : 'server';

  useEffect(() => {
    callTargetIdRef.current = callTargetId;
  }, [callTargetId]);

  useEffect(() => {
    if (callableDevices.some((device) => device.id === callTargetId)) return;
    const preferred = targetIds.find((id) => callableDevices.some((device) => device.id === id));
    setCallTargetId(preferred || (callableDevices.length === 1 ? callableDevices[0].id : ''));
  }, [callTargetId, callableDevices, targetIds]);

  useEffect(() => {
    if (activeView === 'call') syncRemoteMediaState().catch(() => {});
  }, [activeView, syncRemoteMediaState]);

  const toggleTarget = useCallback((deviceId: string) => {
    if (!peerMember) return;
    setTargetIds((current) => {
      const selected = current.includes(deviceId)
        ? current.filter((id) => id !== deviceId)
        : [...current, deviceId];
      localStorage.setItem(`${LS_TARGET_DEVICES}.${peerMember.id}`, JSON.stringify(selected));
      return selected;
    });
  }, [peerMember]);

  const onPlayPersonalAudio = useCallback(async (audioId: string) => {
    const results = await playPersonalAudio(audioId, targetIds);
    const succeeded = results.filter(({ result }) => result?.ok).length;
    const failed = results.length - succeeded;
    if (!succeeded) return showToast(results[0]?.result?.code || '发送音频失败', true);
    showToast(failed ? `已发送 ${succeeded} 台，${failed} 台失败` : `已发送到 ${succeeded} 台设备`, failed > 0);
  }, [showToast, targetIds]);

  const send = useCallback((cmd: Command, label: string) => {
    if (!canSend) {
      showToast(status === 'connected' ? '桌宠端未上线' : '未连接', true);
      return;
    }
    const sent = sendCommand(cmd, targetIds);
    showToast(sent ? `${label} · 已发送到 ${sent} 台设备` : '发送失败', !sent);
  }, [canSend, showToast, status, targetIds]);

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
    const results = await createTts(text, ttsVoiceId, targetIds);
    const succeeded = results.filter(({ result }) => result?.ok);
    if (!succeeded.length) {
      const message = ttsErrorMessage(results[0]?.result?.code);
      setTtsState(message);
      showToast(message, true);
      return;
    }
    setTts('');
    const failed = results.length - succeeded.length;
    const message = failed ? `已发送 ${succeeded.length} 台，${failed} 台失败` : `已发送到 ${succeeded.length} 台设备`;
    setTtsState(message);
    showToast(message, failed > 0);
  }, [showToast, targetIds, tts, ttsVoiceId]);

  const onStartCall = useCallback(async () => {
    if (!canCall) {
      showToast('先连上桌宠', true);
      return;
    }
    try {
      setCallState('requesting-media');
      callTargetIdRef.current = callTargetId;
      setActiveView('call');
      const result = await requestCall(callTargetId);
      if (!result.ok) throw new Error(result.code === 'peer_not_ready' ? '对方二合一客户端尚未就绪' : '无法创建通话');
    } catch (e: any) {
      console.warn('[webrtc] startCall failed:', e);
      showToast(`开通话失败：${e?.message || e}`, true);
      teardownCall({ nextState: 'error' });
    }
  }, [callTargetId, canCall, showToast, teardownCall]);

  const onEndCall = useCallback(() => {
    teardownCall({ sendRemoteHangup: true, nextState: 'idle' });
  }, [teardownCall]);

  const toggleLocalMic = useCallback(() => {
    if (callState !== 'in-call' && callState !== 'calling') return;
    setMicEnabled(!micEnabled);
  }, [callState, micEnabled, setMicEnabled]);

  const peerName = peerMember?.displayName || '对方';
  const selfName = selfMember?.displayName || '我';
  const callActive = callState === 'requesting-media' || callState === 'calling' || callState === 'in-call';

  return (
    <div className="control-app">
      <aside className="app-rail" aria-label="主导航">
        <div className="brand-mark" aria-hidden="true">🐾</div>
        {([
          ['control', '⌁', '控制'],
          ['send', '✦', '发送'],
          ['call', '◉', '通话'],
        ] as const).map(([view, icon, label]) => (
          <button key={view} className={`rail-item ${activeView === view ? 'active' : ''}`} onClick={() => setActiveView(view)}>
            <span aria-hidden="true">{icon}</span><b>{label}</b>{view === 'call' && callActive && <i />}
          </button>
        ))}
        <button className={`rail-item settings ${activeView === 'settings' ? 'active' : ''}`} onClick={() => setActiveView('settings')}>
          <span aria-hidden="true">⚙</span><b>设置</b>
        </button>
      </aside>

      <div className="app-workspace">
        <header className="app-topbar">
          <div className="room-identity">
            <div className="room-avatar">我</div>
            <div><strong>{selfName}和{peerName}</strong><small>桌宠连接空间</small></div>
          </div>
          <div className="peer-target">
            <button
              className={`online-chip ${onlineDevices.length ? '' : 'offline'}`}
              disabled={onlineDevices.length < 2}
              aria-expanded={targetMenuOpen}
              onClick={() => setTargetMenuOpen((open) => !open)}
            >
              <span className="status-dot" />
              {peerName}{onlineDevices.length ? '在线' : '离线'}
              {onlineDevices.length > 1 && <em>· {onlineDevices.length} 台⌄</em>}
            </button>
            {targetMenuOpen && onlineDevices.length > 1 && (
              <div className="target-popover">
                {onlineDevices.map((device) => (
                  <label className="target-option" key={device.id}>
                    <input type="checkbox" checked={targetIds.includes(device.id)} onChange={() => toggleTarget(device.id)} />
                    <span><strong>{device.name}</strong><small>{targetIds.includes(device.id) ? '发送目标' : '在线'}</small></span>
                    <i />
                  </label>
                ))}
              </div>
            )}
          </div>
        </header>

        {activeView === 'control' && (
          <main className="page control-page">
            <section className="pet-hero card">
              <div className="pet-face" aria-hidden="true">˶ᵔ ᵕ ᵔ˶</div>
              <h1>想让{peerName}的桌宠做什么？</h1>
            </section>
            <section className="card action-panel">
              <div className="section-title"><h2>快捷互动</h2></div>
              <div className="action-grid">
                {quickMotions.map((motion) => (
                  <button className="action-tile" key={motion.id} disabled={!canSend} onClick={() => send({ type: 'animation', name: motion.id }, motion.label)}>
                    <span>{QUICK_MOTION_ICONS[motion.id] || '↝'}</span><b>{motion.label}</b><small>动作</small>
                  </button>
                ))}
                {!quickMotions.length && <p className="action-empty">{status === 'connected' ? '桌宠未提供可用动作' : '连接桌宠后显示可用动作'}</p>}
              </div>
            </section>
            <aside className="control-side">
              <section className="card compact-card"><h2>移动位置</h2><div className="corner-grid">{CORNERS.map((item) => <button key={item.corner} disabled={!canSend} onClick={() => send({ type: 'relocate', corner: item.corner }, `移动到${item.label}`)}>{item.label}</button>)}</div></section>
              <section className="card compact-card"><h2>和{peerName}通话</h2><button className="dark-button" onClick={() => setActiveView('call')}>打开通话</button></section>
              {window.desktopPetControl && <section className="card compact-card"><div className="section-title"><h2>我的桌宠</h2><b>{Math.round(petScale * 100)}%</b></div><input className="scale-range" type="range" min="30" max="150" step="10" value={Math.round(petScale * 100)} onChange={(event) => void changePetScale(Number(event.target.value) / 100)} aria-label="调整本机桌宠大小" /></section>}
            </aside>
          </main>
        )}

        {activeView === 'send' && (
          <main className="page send-page">
            <div className="page-heading"><h1>发送给{peerName}</h1><div className="segmented"><button className={sendView === 'tts' ? 'active' : ''} onClick={() => setSendView('tts')}>说句话</button><button className={sendView === 'audio' ? 'active' : ''} onClick={() => setSendView('audio')}>我的音频</button></div></div>
            {sendView === 'tts' ? (
              <section className="card tts-compose">
                <div className="compose-main">
                  <textarea value={tts} maxLength={200} onChange={(event) => setTts(event.target.value)} placeholder="输入想让桌宠说的话…" onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void onSendTts(); } }} />
                  <div className="compose-actions"><label>声音<select value={ttsVoiceId} disabled={!ttsVoices.length} onChange={(event) => { setTtsVoiceId(event.target.value); localStorage.setItem(LS_TTS_VOICE, event.target.value); }}>{!ttsVoices.length && <option value="">暂无可用声音</option>}{ttsVoices.map((voice) => <option value={voice.id} key={voice.id}>{voice.label}</option>)}</select></label><button className="text-button" disabled={!ttsVoices.find((voice) => voice.id === ttsVoiceId)?.previewUrl} onClick={previewTtsVoice}>试听</button><span className="compose-state">{ttsState}</span><button className="primary-button" disabled={!canSend || !tts.trim() || !ttsVoiceId} onClick={() => void onSendTts()}>发送</button></div>
                </div>
              </section>
            ) : (
              <section className="card audio-library">
                <div className="section-title"><h2>我的音频</h2><div className="button-row"><button onClick={() => recording ? personalAudioRecorderRef.current?.stop() : void recordAudio()}>{recording ? '停止录制' : '● 录制'}</button><label className="button-like">＋ 导入<input hidden type="file" accept="audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/webm" onChange={(event) => void importAudio(event.target.files?.[0])} /></label></div></div>
                <div className="audio-grid">
                  {personalAudio.map((clip) => (
                    <article className="audio-card" key={clip.id}>
                      <button className="play-button" aria-label={`试听 ${clip.name}`} onClick={async () => { const result = await getPersonalAudio(clip.id); if (result?.ok) { const url = URL.createObjectURL(new Blob([result.data], { type: result.mime })); const audio = new Audio(url); audio.onended = () => URL.revokeObjectURL(url); void audio.play(); } }}>▶</button>
                      {editingAudioId === clip.id ? <input value={audioNameDraft} onChange={(event) => setAudioNameDraft(event.target.value)} /> : <div><strong>{clip.name}</strong><small>{Math.round(clip.durationMs / 1000)} 秒</small></div>}
                      <div className="audio-actions">
                        {editingAudioId === clip.id ? <button onClick={async () => { if (audioNameDraft.trim()) await renamePersonalAudio(clip.id, audioNameDraft.trim()); setEditingAudioId(null); await refreshPersonalAudio(); }}>保存</button> : <button onClick={() => { setEditingAudioId(clip.id); setAudioNameDraft(clip.name); }}>重命名</button>}
                        <button disabled={!canSend} onClick={() => void onPlayPersonalAudio(clip.id)}>发送</button>
                        {deleteAudioId === clip.id ? <><button className="danger" onClick={async () => { await deletePersonalAudio(clip.id); setDeleteAudioId(null); await refreshPersonalAudio(); }}>确认删除</button><button onClick={() => setDeleteAudioId(null)}>取消</button></> : <button onClick={() => setDeleteAudioId(clip.id)}>删除</button>}
                      </div>
                    </article>
                  ))}
                  {!personalAudio.length && <button className="audio-empty" onClick={() => void recordAudio()}>＋ 添加第一段音频</button>}
                </div>
              </section>
            )}
          </main>
        )}

        {activeView === 'call' && (
          <main className={`page call-page ${callActive ? 'active-call' : ''}`}>
            <audio ref={remoteMicAudioRef} autoPlay muted={remoteMicMuted} /><audio ref={remoteSystemAudioRef} autoPlay muted={remoteSystemMuted} />
            {callActive ? (
              <>
                <section className="video-stage-new" ref={videoStageRef}>
                  <video ref={remoteVideoRef} className={remoteReady ? 'ready' : ''} playsInline autoPlay />
                  {!remoteReady && <div className="call-placeholder"><div className="pet-face small">˶ᵔ ᵕ ᵔ˶</div><strong>{screenStatus === 'paused' ? '仅音频通话' : '正在连接画面…'}</strong></div>}
                  <div className="call-controls"><button onClick={toggleLocalMic}>{micEnabled ? '关闭麦克风' : '打开麦克风'}</button><button onClick={() => void toggleRemoteAudio('system')}>{remoteSystemMuted ? '打开对方声音' : '静音对方声音'}</button><button disabled={!remoteReady} onClick={() => void toggleFullscreen()}>全屏</button><button className="hangup" onClick={onEndCall}>结束</button></div>
                </section>
                <aside className="call-sidebar"><section className="card"><h2>正在和{peerName}通话</h2><p>{callState === 'in-call' ? '已连接' : '连接中…'}</p></section><section className="card"><h2>通话控制</h2><label>我的麦克风<input type="checkbox" checked={micEnabled} onChange={toggleLocalMic} /></label><label>对方系统声音<input type="checkbox" checked={!remoteSystemMuted} onChange={() => void toggleRemoteAudio('system')} /></label><label>对方麦克风<input type="checkbox" checked={!remoteMicMuted} onChange={() => void toggleRemoteAudio('mic')} /></label></section><section className="card connection-quality"><span className="status-dot" />{rtcRoute.relayed ? '仅音频连接' : rtcRoute.candidateType === 'failed' ? '连接恢复中' : '连接稳定'}</section></aside>
              </>
            ) : (
              <section className="card call-idle">
                <div className="pet-face">˶ᵔ ᵕ ᵔ˶</div><h1>和{peerName}通话</h1>
                {callableDevices.length > 1 && <div className="call-device-list">{callableDevices.map((device) => <label key={device.id}><input type="radio" name="call-target" checked={callTargetId === device.id} onChange={() => setCallTargetId(device.id)} />{device.name}</label>)}</div>}
                <button className="primary-button large" disabled={!canCall} onClick={() => void onStartCall()}>开始通话</button>
              </section>
            )}
          </main>
        )}

        {activeView === 'settings' && (
          <main className="page settings-page">
            <div className="page-heading"><h1>设置</h1></div>
            {setupRequired ? (
              <section className="card settings-section setup-card">
                <p className="setup-step">{setupStep === 'server' ? '第 1 步，共 2 步' : '第 2 步，共 2 步'}</p>
                <h2>{setupStep === 'server' ? '连接你的服务器' : '选择你的身份'}</h2>
                {setupStep === 'server' ? <><p className="settings-hint">先验证服务器地址和密钥，再选择身份。</p><div className="form-grid"><label>服务器地址<input value={serverUrl} onChange={(event) => { setServerUrl(event.target.value); resetPairingVerification(); }} placeholder="https://pet.example.com" /></label><label>服务器密钥<input type="password" value={secret} onChange={(event) => { setSecret(event.target.value); resetPairingVerification(); }} placeholder="输入服务器密钥" /></label></div><div className="settings-actions"><button className="primary-button" disabled={verifyingPairing || !serverUrl.trim() || !secret.trim()} onClick={() => void verifyPairing()}>{verifyingPairing ? '验证中…' : '验证并继续'}</button></div></> : <><p className="settings-hint">请选择这台设备属于谁；切换身份后仍可在设置中更改。</p><div className="form-grid"><label>我的身份<select value={memberId} onChange={(event) => setMemberId(event.target.value as MemberId | '')}><option value="">请选择身份</option>{verifiedMembers?.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label><label>设备名称<input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} /></label></div><div className="settings-actions"><button onClick={() => { setSetupStage('server'); setMemberId(''); }}>上一步</button><button className="primary-button" disabled={!memberId || !deviceName.trim()} onClick={() => void onConnect()}>保存并连接</button></div></>}</section>
            ) : <>
              <section className="card settings-section"><h2>连接</h2><div className="form-grid"><label>服务器<input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} disabled={status === 'connecting' || status === 'connected'} /></label><label>房间密钥<input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} disabled={status === 'connecting' || status === 'connected'} /></label><label>当前身份<strong className="identity-summary">{memberId ? knownMemberNames[memberId] : '未选择'}</strong>{window.desktopPetControl && <button disabled={status !== 'connected'} onClick={() => { if (memberId) { setIdentityChangeTarget(memberId === 'a' ? 'b' : 'a'); setIdentityChangeOpen(true); } }}>更改身份</button>}</label><label>设备名称<input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} disabled={status === 'connecting' || status === 'connected'} /></label></div>{identityChangeOpen && <div className="identity-change"><strong>更改身份会让桌宠和控制端短暂重新连接。</strong><select value={identityChangeTarget} onChange={(event) => setIdentityChangeTarget(event.target.value as MemberId)}><option value="a">{knownMemberNames.a}</option><option value="b">{knownMemberNames.b}</option></select><button className="primary-button" disabled={identityChanging || identityChangeTarget === memberId} onClick={() => void confirmIdentityChange()}>{identityChanging ? '正在更改…' : '确认并重新连接'}</button><button disabled={identityChanging} onClick={() => setIdentityChangeOpen(false)}>取消</button></div>}<div className="settings-actions"><StatusPill status={status} />{status === 'connected' || status === 'connecting' ? <button onClick={onDisconnect}>断开</button> : <button className="primary-button" disabled={!serverUrl.trim() || !secret.trim() || !memberId || !deviceName.trim()} onClick={() => void onConnect()}>连接</button>}</div></section>
              <section className="card settings-section"><h2>成员名称</h2>{peers.members.map((member) => <div className="member-row" key={member.id}><span>{member.id === peers.self.memberId ? '我' : '对方'}</span>{editingMemberId === member.id ? <><input value={memberNameDraft} onChange={(event) => setMemberNameDraft(event.target.value)} /><button onClick={async () => { if (memberNameDraft.trim()) await renameMember(member.id, memberNameDraft.trim()); setEditingMemberId(null); }}>保存</button><button onClick={() => setEditingMemberId(null)}>取消</button></> : <><strong>{member.displayName}</strong><button onClick={() => { setEditingMemberId(member.id); setMemberNameDraft(member.displayName); }}>修改</button></>}</div>)}</section>
              <section className="card settings-section"><h2>设备</h2>{peers.members.map((member) => <div className="device-group" key={member.id}><h3>{member.displayName}</h3>{member.devices.map((device) => <div className="device-row" key={device.id}><span className={`device-signal ${device.petOnline ? 'online' : ''}`} /><div><strong>{device.name}{device.id === peers.self.deviceId ? ' · 本机' : ''}</strong><small>桌宠{device.petOnline ? '在线' : '离线'} · 控制端{device.controllerOnline ? '在线' : '离线'} · {new Date(device.lastSeenAt).toLocaleString()}</small></div>{member.id === peers.self.memberId && device.id !== peers.self.deviceId && !device.petOnline && !device.controllerOnline && (reclaimCandidate?.id === device.id ? <span className="inline-confirm"><button onClick={async () => { await reclaimDevice(device.id, device.name); setReclaimCandidate(null); }}>确认认领</button><button onClick={() => setReclaimCandidate(null)}>取消</button></span> : <button onClick={() => setReclaimCandidate(device)}>认领为本机</button>)}</div>)}</div>)}</section>
              {window.desktopPetControl && <section className="card settings-section"><h2>本机桌宠</h2><div className="scale-settings"><input className="scale-range" type="range" min="30" max="150" step="10" value={Math.round(petScale * 100)} onChange={(event) => void changePetScale(Number(event.target.value) / 100)} /><strong>{Math.round(petScale * 100)}%</strong></div><div className="button-row"><button onClick={() => void resetPetScale()}>恢复默认</button><button onClick={() => void exportDiagnostics()}>导出诊断日志</button></div></section>}
              <section className="card settings-section"><h2>语音服务</h2><div className="button-row"><button className={ttsMode === 'managed' ? 'selected' : ''} onClick={() => selectTtsMode('managed')}>服务端声音</button>{ttsProvider === 'elevenlabs' && <button className={ttsMode === 'byok' ? 'selected' : ''} onClick={() => selectTtsMode('byok')}>我的 API Key</button>}</div>{ttsMode === 'byok' && <div className="key-row"><input type="password" value={ttsApiKeyInput} onChange={(event) => setTtsApiKeyInput(event.target.value)} placeholder={ttsKeyConfigured ? '已配置，输入新 Key 可替换' : 'ElevenLabs API Key'} /><button onClick={() => void saveByokKey()}>保存</button>{ttsKeyConfigured && <button className="danger" onClick={() => void clearByokKey()}>删除 Key</button>}</div>}</section>
            </>}
          </main>
        )}
      </div>
      <div className={`toast-new ${toast ? 'show' : ''} ${toast?.err ? 'error' : ''}`}>{toast?.msg}</div>
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
