import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
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
  sendCameraSignal,
  sendMediaStatus,
  requestMediaControl,
  setListeners,
  setTtsCredentials,
  addPersonalAudio, deletePersonalAudio, listPersonalAudio, playPersonalAudio, renamePersonalAudio,
  getPersonalAudio,
  createNote, listNotes, setNoteFavorite, getNoteAttachment,
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
  type PersonalAudio, type PairingMember, type DesktopNote, type NoteImageInput,
} from './api';
import { applyVideoSenderProfile, type VideoRouteProfile } from './video-profile';
import { normalizeDiagnosticError, recordControlDiagnostic, type RendererDiagnosticInput } from './diagnostics';
import { attachRtcDiagnostics, type RtcDiagnosticHandle } from './rtc-diagnostics';

type Status = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'rejected';
type CallState = 'idle' | 'requesting-media' | 'calling' | 'in-call' | 'error';
type ActiveView = 'control' | 'send' | 'notes' | 'call' | 'settings';
type SendView = 'tts' | 'audio';
type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown' | 'failed';
type MemberId = 'a' | 'b';
type SetupStage = 'server' | 'identity' | 'complete';

type RtcRoute = {
  candidateType: CandidateType;
  relayed: boolean;
  path: 'IPv4 P2P' | 'IPv6 P2P' | 'TURN 低清视频' | '选路中' | '失败';
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
const LS_CAMERA_DEVICE = 'pet.cameraDeviceId';

type PairingConfig = { serverUrl?: string; roomSecret?: string; deviceId?: string; deviceName?: string; memberId?: 'a' | 'b' };
type PetScaleResult = { ok: boolean; scale?: number; error?: string };
type DiagnosticsExportResult = { ok: boolean; canceled?: boolean; path?: string; error?: string };
type DiagnosticIncidentSummary = {
  id: string;
  timestamp: string;
  errorCode: string;
  message: string;
  count: number;
  level: 'fatal';
};
type DiagnosticStatus = { pendingIncidents: DiagnosticIncidentSummary[] };

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
      recordDiagnostic: (event: RendererDiagnosticInput) => void;
      getDiagnosticStatus: () => Promise<DiagnosticStatus>;
      dismissDiagnosticIncident: (id: string) => Promise<{ ok: boolean; error?: string }>;
      exportDiagnostics: () => Promise<DiagnosticsExportResult>;
      onDiagnosticRefresh: (cb: () => void) => () => void;
      openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
      onMediaFloatClosed: (cb: () => void) => () => void;
      onOpenNoteComposer: (cb: () => void) => () => void;
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
const NOTE_COLORS: Array<{ id: DesktopNote['paperColor']; label: string; value: string }> = [
  { id: 'yellow', label: '奶油黄', value: '#F4D77D' },
  { id: 'pink', label: '温柔粉', value: '#E8B7C8' },
  { id: 'blue', label: '雾蓝', value: '#AFC9D8' },
  { id: 'sage', label: '鼠尾草绿', value: '#B8C9A3' },
  { id: 'lavender', label: '淡紫灰', value: '#C8B7D8' },
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

function noteErrorMessage(code?: string) {
  const messages: Record<string, string> = {
    disconnected: '尚未连接服务器',
    invalid_note: '便签内容或附件不符合要求',
    invalid_image: '图片必须是 2 MB 内的 JPEG 或 PNG',
    note_inbox_full: '对方便签箱已满',
    note_pending_image_limit: '对方待批阅图片空间已满',
    note_room_image_limit: '房间图片空间已满，可改发文字或链接',
    favorite_limit_reached: '收藏数量已达上限',
    favorite_image_limit: '收藏图片空间已满',
    note_storage_failed: '服务器未能保存便签',
    timeout: '服务器响应超时，请重试',
  };
  return messages[code || ''] || '便签操作失败';
}

function graphemeCount(value: string) {
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => {
      segment(input: string): Iterable<unknown>;
    };
  }).Segmenter;
  if (Segmenter) return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length;
  return [...value].length;
}

async function compressNoteImage(file: File): Promise<NoteImageInput> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('image_canvas_unavailable');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let quality = 0.9;
  let blob: Blob | null = null;
  do {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    quality -= 0.1;
  } while (blob && blob.size > 2 * 1024 * 1024 && quality >= 0.4);
  if (!blob || blob.size > 2 * 1024 * 1024) throw new Error('invalid_image');
  return { mime: 'image/jpeg', data: await blob.arrayBuffer() };
}

function upsertNote(items: DesktopNote[], note: DesktopNote) {
  const current = items.find((item) => item.id === note.id);
  if (current && current.revision > note.revision) return items;
  return [note, ...items.filter((item) => item.id !== note.id)];
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
  const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
  const candidateType = (relayed ? 'relay' : local?.candidateType || remote?.candidateType || 'unknown') as CandidateType;
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
    path: relayed ? 'TURN 低清视频' : ipv6 ? 'IPv6 P2P' : ipv4 ? 'IPv4 P2P' : '选路中',
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
  const [noteSection, setNoteSection] = useState<'compose' | 'sent' | 'history' | 'favorites'>('compose');
  const [noteBody, setNoteBody] = useState('');
  const [noteColor, setNoteColor] = useState<DesktopNote['paperColor']>('yellow');
  const [noteMediaKind, setNoteMediaKind] = useState<'none' | 'image' | 'song' | 'video'>('none');
  const [noteLink, setNoteLink] = useState('');
  const [noteImage, setNoteImage] = useState<NoteImageInput | null>(null);
  const [noteImageName, setNoteImageName] = useState('');
  const [noteSending, setNoteSending] = useState(false);
  const [sentNotes, setSentNotes] = useState<DesktopNote[]>([]);
  const [noteHistory, setNoteHistory] = useState<DesktopNote[]>([]);
  const [favoriteNotes, setFavoriteNotes] = useState<DesktopNote[]>([]);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [diagnosticStatus, setDiagnosticStatus] = useState<DiagnosticStatus>({ pendingIncidents: [] });
  const [petScale, setPetScaleState] = useState(1);
  const [callState, setCallState] = useState<CallState>('idle');
  const [remoteMicMuted, setRemoteMicMuted] = useState(true);
  const [remoteSystemMuted, setRemoteSystemMuted] = useState(true);
  const [micEnabled, setMicEnabledState] = useState(false);
  const [remoteReady, setRemoteReady] = useState(false);
  const [screenStatus, setScreenStatus] = useState<MediaStatus['state']>('unavailable');
  const [screenQuality, setScreenQuality] = useState<MediaStatus['quality']>();
  const [screenDesired, setScreenDesired] = useState(true);
  const [screenControlPending, setScreenControlPending] = useState(false);
  const [localCameraStatus, setLocalCameraStatus] = useState<MediaStatus['state']>('unavailable');
  const [localCameraQuality, setLocalCameraQuality] = useState<MediaStatus['quality']>();
  const [remoteCameraStatus, setRemoteCameraStatus] = useState<MediaStatus['state']>('unavailable');
  const [remoteCameraQuality, setRemoteCameraQuality] = useState<MediaStatus['quality']>();
  const [cameraDesired, setCameraDesired] = useState(false);
  const [cameraControlPending, setCameraControlPending] = useState(false);
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState(() => localStorage.getItem(LS_CAMERA_DEVICE) || '');
  const [cameraPreviewCollapsed, setCameraPreviewCollapsed] = useState(false);
  const [cameraHidden, setCameraHidden] = useState(false);
  const [preferredPrimary, setPreferredPrimary] = useState<'screen' | 'camera'>('screen');
  const [floatContainer, setFloatContainer] = useState<HTMLElement | null>(null);
  const [remoteTrackSummary, setRemoteTrackSummary] = useState('无');
  const [rtcRoute, setRtcRoute] = useState<RtcRoute>(EMPTY_RTC_ROUTE);
  const toastTimer = useRef<number | null>(null);
  const personalAudioRecorderRef = useRef<MediaRecorder | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteCameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const localCameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteMicAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteSystemAudioRef = useRef<HTMLAudioElement | null>(null);
  const videoStageRef = useRef<HTMLDivElement | null>(null);
  const remoteVideoStreamRef = useRef<MediaStream | null>(null);
  const remoteMicStreamRef = useRef<MediaStream | null>(null);
  const remoteSystemStreamRef = useRef<MediaStream | null>(null);
  const rtcPcRef = useRef<RTCPeerConnection | null>(null);
  const rtcDiagnosticsRef = useRef<RtcDiagnosticHandle | null>(null);
  const cameraPcRef = useRef<RTCPeerConnection | null>(null);
  const cameraDiagnosticsRef = useRef<RtcDiagnosticHandle | null>(null);
  const cameraPcInitRef = useRef<Promise<RTCPeerConnection> | null>(null);
  const cameraSenderRef = useRef<RTCRtpSender | null>(null);
  const localCameraStreamRef = useRef<MediaStream | null>(null);
  const remoteCameraStreamRef = useRef<MediaStream | null>(null);
  const cameraPendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const cameraOffererDeviceIdRef = useRef('');
  const selfDeviceIdRef = useRef('');
  const memberIdRef = useRef<MemberId | ''>('');
  const cameraRouteProfileRef = useRef<VideoRouteProfile>('unknown');
  const cameraProfileGenerationRef = useRef(0);
  const cameraProfileApplyChainRef = useRef<Promise<void>>(Promise.resolve());
  const cameraDesiredRef = useRef(false);
  const cameraCapturePendingRef = useRef(false);
  const mediaFloatWindowRef = useRef<Window | null>(null);
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

  const refreshDiagnosticStatus = useCallback(async () => {
    if (!window.desktopPetControl) return;
    try {
      setDiagnosticStatus(await window.desktopPetControl.getDiagnosticStatus());
    } catch (error) {
      recordControlDiagnostic({
        event: 'app.diagnostic-status-failed',
        domain: 'app',
        level: 'warn',
        errorCode: 'app_diagnostic_status_failed',
        recoverability: 'automatic',
        exception: normalizeDiagnosticError(error),
      });
    }
  }, []);

  useEffect(() => {
    void refreshDiagnosticStatus();
    return window.desktopPetControl?.onDiagnosticRefresh(() => {
      void refreshDiagnosticStatus();
    });
  }, [refreshDiagnosticStatus]);

  useEffect(() => {
    memberIdRef.current = memberId;
  }, [memberId]);

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
    rtcDiagnosticsRef.current?.close('call-teardown');
    rtcDiagnosticsRef.current = null;
    try { rtcPcRef.current?.close(); } catch {}
    if (recoveryTimerRef.current) window.clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = null;
    iceRestartedRef.current = false;
    rtcPcRef.current = null;
    cameraDiagnosticsRef.current?.close('call-teardown');
    cameraDiagnosticsRef.current = null;
    try { cameraPcRef.current?.close(); } catch {}
    cameraPcRef.current = null;
    cameraPcInitRef.current = null;
    cameraSenderRef.current = null;
    cameraPendingCandidatesRef.current = [];
    cameraRouteProfileRef.current = 'unknown';
    cameraProfileGenerationRef.current += 1;
    cameraProfileApplyChainRef.current = Promise.resolve();
    cameraOffererDeviceIdRef.current = '';
    cameraCapturePendingRef.current = false;
    for (const track of localCameraStreamRef.current?.getTracks() ?? []) track.stop();
    localCameraStreamRef.current = null;
    remoteCameraStreamRef.current = null;
    cameraDesiredRef.current = false;
    setCameraDesired(false);
    setLocalCameraStatus('unavailable');
    setLocalCameraQuality(undefined);
    setRemoteCameraStatus('unavailable');
    setRemoteCameraQuality(undefined);
    setCameraHidden(false);
    setPreferredPrimary('screen');
    if (localCameraVideoRef.current) localCameraVideoRef.current.srcObject = null;
    if (remoteCameraVideoRef.current) remoteCameraVideoRef.current.srcObject = null;
    try { mediaFloatWindowRef.current?.close(); } catch {}
    mediaFloatWindowRef.current = null;
    setFloatContainer(null);
    pendingCandidatesRef.current = [];
    stopLocalAudio();
    setMicEnabled(false);
    setRemoteReady(false);
    setScreenStatus('unavailable');
    setScreenQuality(undefined);
    setScreenDesired(true);
    setScreenControlPending(false);
    setCameraControlPending(false);
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
        rtcDiagnosticsRef.current?.candidate('remote', 'added', candidate);
      } catch (e) {
        rtcDiagnosticsRef.current?.candidate('remote', 'add-failed', candidate, e);
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
      const errorCode = e?.name === 'NotAllowedError'
        ? 'media_microphone_permission_denied'
        : 'media_microphone_capture_failed';
      recordControlDiagnostic({
        event: 'media.microphone-capture-failed',
        domain: 'media',
        level: 'warn',
        errorCode,
        recoverability: 'user_action',
        correlation: { callId: currentCallIdRef.current || undefined },
        exception: normalizeDiagnosticError(e),
      });
      console.warn('[webrtc] local microphone capture failed; starting receive-only call:', e);
      showToast(`麦克风不可用，将只接收远程画面（${errorCode}）：${e?.message || e}`, true);
      return null;
    }
  }, [showToast]);

  const ensurePeerConnection = useCallback(async () => {
    if (rtcPcRef.current) return rtcPcRef.current;

    const localAudio = await ensureLocalAudio();
    const rtcConfig = await requestRtcConfig();
    const pc = new RTCPeerConnection(rtcConfig);
    rtcPcRef.current = pc;
    rtcDiagnosticsRef.current = attachRtcDiagnostics(pc, {
      recorder: recordControlDiagnostic,
      role: 'controller',
      mediaKind: 'main',
      getCallId: () => currentCallIdRef.current,
      configuration: rtcConfig,
    });

    if (localAudio) {
      pc.addTrack(localAudio.getAudioTracks()[0], localAudio);
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    const systemTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.addTransceiver('video', { direction: 'recvonly' });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        rtcDiagnosticsRef.current?.candidate('local', 'generated', event.candidate);
        sendRtcSignal({ candidate: event.candidate.toJSON() });
      } else {
        rtcDiagnosticsRef.current?.candidate('local', 'gathering-complete');
      }
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
        rtcDiagnosticsRef.current?.snapshot('route-selected').catch(() => {});
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
      rtcDiagnosticsRef.current?.candidate('remote', 'received', signal.candidate);
      const pc = rtcPcRef.current;
      if (!pc?.remoteDescription) {
        pendingCandidatesRef.current.push(signal.candidate);
        rtcDiagnosticsRef.current?.candidate('remote', 'queued', signal.candidate);
        return;
      }
      try {
        await pc.addIceCandidate(signal.candidate);
        rtcDiagnosticsRef.current?.candidate('remote', 'added', signal.candidate);
      } catch (error) {
        rtcDiagnosticsRef.current?.candidate('remote', 'add-failed', signal.candidate, error);
        throw error;
      }
    }
  }, [ensurePeerConnection, flushPendingCandidates, sendRtcSignal]);

  const refreshCameraDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
    setCameraDevices(devices);
    setSelectedCameraId((current) => {
      if (current && devices.some((device) => device.deviceId === current)) return current;
      const fallback = devices[0]?.deviceId || '';
      if (fallback) localStorage.setItem(LS_CAMERA_DEVICE, fallback);
      return fallback;
    });
  }, []);

  const reportCameraStatus = useCallback((
    state: MediaStatus['state'],
    reason?: MediaStatus['reason'],
    quality?: MediaStatus['quality'],
  ) => {
    const callId = currentCallIdRef.current;
    if (!callId) return;
    setLocalCameraStatus(state);
    setLocalCameraQuality(quality);
    sendMediaStatus({
      callId, media: 'camera', state,
      ...(reason ? { reason } : {}),
      ...(quality ? { quality } : {}),
    });
  }, []);

  const syncCameraSenderTrack = useCallback(async () => {
    const generation = ++cameraProfileGenerationRef.current;
    const sender = cameraSenderRef.current;
    if (!sender) return;
    if (!cameraDesiredRef.current) {
      await sender.replaceTrack(null);
      reportCameraStatus('unavailable', 'controller_disabled');
      return;
    }
    const profile = cameraRouteProfileRef.current;
    if (profile === 'unknown' || profile === 'failed') {
      await sender.replaceTrack(null);
      reportCameraStatus('paused');
      return;
    }
    const track = localCameraStreamRef.current?.getVideoTracks()[0] || null;
    if (!track || track.readyState !== 'live') {
      await sender.replaceTrack(null);
      reportCameraStatus('unavailable', 'capture_failed');
      return;
    }
    await sender.replaceTrack(null);
    const operation = cameraProfileApplyChainRef.current.catch(() => {}).then(async () => {
      if (generation !== cameraProfileGenerationRef.current || !cameraDesiredRef.current) return;
      const applied = await applyVideoSenderProfile(sender, track, profile, 'camera');
      if (generation !== cameraProfileGenerationRef.current || !cameraDesiredRef.current) return;
      if (!applied.ok) {
        console.warn('[webrtc] camera video profile unavailable:', applied.error);
        reportCameraStatus('unavailable', 'profile_failed');
        return;
      }
      await sender.replaceTrack(track);
      if (generation !== cameraProfileGenerationRef.current || !cameraDesiredRef.current) {
        await sender.replaceTrack(null);
        return;
      }
      reportCameraStatus('available', undefined, profile);
    });
    cameraProfileApplyChainRef.current = operation;
    await operation;
  }, [reportCameraStatus]);

  const setLocalCameraEnabled = useCallback(async (enabled: boolean) => {
    const callId = currentCallIdRef.current;
    if (!callId) return;
    cameraProfileGenerationRef.current += 1;
    cameraDesiredRef.current = enabled;
    cameraCapturePendingRef.current = enabled;
    setCameraDesired(enabled);
    if (!enabled) {
      try { await cameraSenderRef.current?.replaceTrack(null); } catch {}
      for (const track of localCameraStreamRef.current?.getTracks() ?? []) track.stop();
      localCameraStreamRef.current = null;
      if (localCameraVideoRef.current) localCameraVideoRef.current.srcObject = null;
      reportCameraStatus('unavailable', 'controller_disabled');
      cameraCapturePendingRef.current = false;
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraDesiredRef.current = false;
      setCameraDesired(false);
      reportCameraStatus('unavailable', 'capture_failed');
      showToast('当前环境不支持摄像头', true);
      cameraCapturePendingRef.current = false;
      return;
    }
    try {
      for (const track of localCameraStreamRef.current?.getTracks() ?? []) track.stop();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(selectedCameraId ? { deviceId: { exact: selectedCameraId } } : {}),
          width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 24 },
        },
        audio: false,
      });
      if (currentCallIdRef.current !== callId || !cameraDesiredRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      localCameraStreamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      track.addEventListener('ended', () => {
        if (localCameraStreamRef.current !== stream) return;
        localCameraStreamRef.current = null;
        reportCameraStatus('unavailable', 'device_lost');
        void refreshCameraDevices();
        showToast('摄像头已断开，正在尝试默认设备', true);
      }, { once: true });
      if (localCameraVideoRef.current) {
        localCameraVideoRef.current.srcObject = stream;
        void localCameraVideoRef.current.play().catch(() => {});
      }
      await refreshCameraDevices();
      if (currentCallIdRef.current !== callId || localCameraStreamRef.current !== stream) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      await syncCameraSenderTrack();
      cameraCapturePendingRef.current = false;
    } catch (error: any) {
      const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
      const errorCode = denied ? 'media_camera_permission_denied' : 'media_camera_capture_failed';
      recordControlDiagnostic({
        event: 'media.camera-capture-failed',
        domain: 'media',
        level: 'warn',
        errorCode,
        recoverability: 'user_action',
        correlation: { callId: currentCallIdRef.current || undefined },
        exception: normalizeDiagnosticError(error),
      });
      cameraDesiredRef.current = false;
      setCameraDesired(false);
      reportCameraStatus('unavailable', denied ? 'permission_denied' : 'capture_failed');
      showToast(
        denied ? `没有获得摄像头权限（${errorCode}）` : `摄像头打开失败（${errorCode}）：${error?.message || error}`,
        true,
      );
      cameraCapturePendingRef.current = false;
    }
  }, [refreshCameraDevices, reportCameraStatus, selectedCameraId, showToast, syncCameraSenderTrack]);

  const ensureCameraPeerConnection = useCallback(async (offererSide: boolean, callId: string) => {
    if (cameraPcRef.current) return cameraPcRef.current;
    if (cameraPcInitRef.current) return cameraPcInitRef.current;
    const initialization = (async () => {
      const rtcConfig = await requestRtcConfig();
      if (currentCallIdRef.current !== callId) throw new Error('camera call superseded');
      const pc = new RTCPeerConnection(rtcConfig);
      cameraPcRef.current = pc;
      cameraDiagnosticsRef.current = attachRtcDiagnostics(pc, {
        recorder: recordControlDiagnostic,
        role: 'controller',
        mediaKind: 'camera',
        getCallId: () => currentCallIdRef.current,
        configuration: rtcConfig,
      });
      if (offererSide) {
        const transceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
        cameraSenderRef.current = transceiver.sender;
      }
      pc.onicecandidate = (event) => {
        if (event.candidate && currentCallIdRef.current === callId) {
          cameraDiagnosticsRef.current?.candidate('local', 'generated', event.candidate);
          sendCameraSignal({ callId, candidate: event.candidate.toJSON() });
        } else if (!event.candidate) {
          cameraDiagnosticsRef.current?.candidate('local', 'gathering-complete');
        }
      };
      pc.ontrack = (event) => {
        if (currentCallIdRef.current !== callId || cameraPcRef.current !== pc) return;
        const stream = remoteCameraStreamRef.current ?? new MediaStream();
        remoteCameraStreamRef.current = stream;
        if (!stream.getTracks().some((track) => track.id === event.track.id)) stream.addTrack(event.track);
        if (remoteCameraVideoRef.current) {
          remoteCameraVideoRef.current.srcObject = stream;
          void remoteCameraVideoRef.current.play().catch(() => {});
        }
        event.track.addEventListener('ended', () => {
          if (currentCallIdRef.current === callId) setRemoteCameraStatus('unavailable');
        }, { once: true });
      };
      pc.onconnectionstatechange = () => {
        if (currentCallIdRef.current !== callId || cameraPcRef.current !== pc) return;
        if (pc.connectionState === 'connected') {
          readRtcRoute(pc).then(async (route) => {
            if (currentCallIdRef.current !== callId || cameraPcRef.current !== pc) return;
            cameraRouteProfileRef.current = route.candidateType === 'unknown'
              ? 'unknown'
              : route.relayed ? 'relay-low' : 'normal';
            await syncCameraSenderTrack();
          }).catch(() => {
            if (currentCallIdRef.current !== callId || cameraPcRef.current !== pc) return;
            cameraRouteProfileRef.current = 'failed';
            void syncCameraSenderTrack();
          });
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          cameraRouteProfileRef.current = 'failed';
          void syncCameraSenderTrack();
        }
      };
      return pc;
    })();
    cameraPcInitRef.current = initialization;
    try {
      return await initialization;
    } finally {
      if (cameraPcInitRef.current === initialization) cameraPcInitRef.current = null;
    }
  }, [syncCameraSenderTrack]);

  const flushCameraCandidates = useCallback(async () => {
    const pc = cameraPcRef.current;
    if (!pc?.remoteDescription) return;
    while (cameraPendingCandidatesRef.current.length) {
      const candidate = cameraPendingCandidatesRef.current.shift();
      if (!candidate) continue;
      try {
        await pc.addIceCandidate(candidate);
        cameraDiagnosticsRef.current?.candidate('remote', 'added', candidate);
      } catch (error) {
        cameraDiagnosticsRef.current?.candidate('remote', 'add-failed', candidate, error);
        throw error;
      }
    }
  }, []);

  const handleCameraSignal = useCallback(async (signal: WebRtcSignal) => {
    if (!signal?.callId || signal.callId !== currentCallIdRef.current) return;
    const callId = signal.callId;
    const offererSide = selfDeviceIdRef.current === cameraOffererDeviceIdRef.current;
    const pc = await ensureCameraPeerConnection(offererSide, callId);
    if (currentCallIdRef.current !== callId || cameraPcRef.current !== pc) return;
    if (signal.description?.type === 'offer') {
      if (offererSide) return;
      await pc.setRemoteDescription(signal.description);
      if (currentCallIdRef.current !== callId || cameraPcRef.current !== pc) return;
      const videoTransceiver = pc.getTransceivers().find((item) => item.receiver.track.kind === 'video');
      if (!videoTransceiver) throw new Error('camera transceiver missing');
      videoTransceiver.direction = 'sendrecv';
      cameraSenderRef.current = videoTransceiver.sender;
      await flushCameraCandidates();
      if (currentCallIdRef.current !== callId || cameraPcRef.current !== pc) return;
      await pc.setLocalDescription(await pc.createAnswer());
      if (currentCallIdRef.current !== callId || cameraPcRef.current !== pc) return;
      sendCameraSignal({ callId, description: pc.localDescription });
      await syncCameraSenderTrack();
      return;
    }
    if (signal.description?.type === 'answer') {
      if (!offererSide) return;
      await pc.setRemoteDescription(signal.description);
      if (currentCallIdRef.current !== callId || cameraPcRef.current !== pc) return;
      await flushCameraCandidates();
      await syncCameraSenderTrack();
      return;
    }
    if (signal.candidate) {
      cameraDiagnosticsRef.current?.candidate('remote', 'received', signal.candidate);
      if (!pc.remoteDescription) {
        cameraPendingCandidatesRef.current.push(signal.candidate);
        cameraDiagnosticsRef.current?.candidate('remote', 'queued', signal.candidate);
      } else {
        try {
          await pc.addIceCandidate(signal.candidate);
          cameraDiagnosticsRef.current?.candidate('remote', 'added', signal.candidate);
        } catch (error) {
          cameraDiagnosticsRef.current?.candidate('remote', 'add-failed', signal.candidate, error);
          throw error;
        }
      }
    }
  }, [ensureCameraPeerConnection, flushCameraCandidates, syncCameraSenderTrack]);

  const beginCameraCall = useCallback(async (callId: string, cameraOffererDeviceId: string) => {
    if (currentCallIdRef.current !== callId) return;
    cameraOffererDeviceIdRef.current = cameraOffererDeviceId;
    const offererSide = selfDeviceIdRef.current === cameraOffererDeviceId;
    setCameraDesired(false);
    cameraDesiredRef.current = false;
    setLocalCameraStatus('unavailable');
    setLocalCameraQuality(undefined);
    setRemoteCameraStatus('unavailable');
    setRemoteCameraQuality(undefined);
    await refreshCameraDevices();
    if (currentCallIdRef.current !== callId) return;
    const pc = await ensureCameraPeerConnection(offererSide, callId);
    if (!offererSide || currentCallIdRef.current !== callId || cameraPcRef.current !== pc) return;
    await pc.setLocalDescription(await pc.createOffer());
    if (currentCallIdRef.current !== callId || cameraPcRef.current !== pc) return;
    sendCameraSignal({ callId, description: pc.localDescription });
  }, [ensureCameraPeerConnection, refreshCameraDevices]);

  const beginMediaCall = useCallback(async (callId: string) => {
    if (currentCallIdRef.current === callId && rtcPcRef.current) return;
    teardownCall({ nextState: 'requesting-media' });
    currentCallIdRef.current = callId;
    const pc = await ensurePeerConnection();
    if (currentCallIdRef.current !== callId || rtcPcRef.current !== pc) return;
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    if (currentCallIdRef.current !== callId || rtcPcRef.current !== pc) return;
    sendRtcSignal({ description: pc.localDescription });
    setCallState('calling');
  }, [ensurePeerConnection, sendRtcSignal, teardownCall]);

  useEffect(() => {
    setListeners({
      onStatus: (nextStatus) => {
        setStatus(nextStatus);
        recordControlDiagnostic({
          event: 'socket.status-changed',
          domain: 'socket',
          level: nextStatus === 'rejected' ? 'error' : nextStatus === 'disconnected' ? 'warn' : 'info',
          ...(nextStatus === 'rejected' ? {
            errorCode: 'socket_join_rejected',
            recoverability: 'user_action' as const,
          } : nextStatus === 'disconnected' ? {
            errorCode: 'socket_disconnected',
            recoverability: 'automatic' as const,
          } : {}),
          correlation: { deviceId: participantId },
          context: { status: nextStatus, memberId },
        });
      },
      onPeers: (next) => {
        setPeers(next);
        selfDeviceIdRef.current = next.self.deviceId;
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
      onError: (m, code = 'socket_operation_failed') => {
        recordControlDiagnostic({
          event: 'socket.error',
          domain: 'socket',
          level: 'error',
          errorCode: code,
          recoverability: 'retryable',
          correlation: { deviceId: participantId, callId: currentCallIdRef.current || undefined },
          context: { message: m },
        });
        showToast(`${m}（${code}）`, true);
      },
      onSignal: (signal) => {
        handleSignal(signal).catch((e) => {
          recordControlDiagnostic({
            event: 'webrtc.signal-processing-failed',
            domain: 'webrtc',
            level: 'error',
            errorCode: 'webrtc_signal_processing_failed',
            recoverability: 'retryable',
            correlation: { callId: currentCallIdRef.current || undefined },
            exception: normalizeDiagnosticError(e),
          });
          console.warn('[webrtc] signal failed:', e);
          showToast(`通话失败：${e?.message || e}`, true);
          teardownCall({ nextState: 'error' });
        });
      },
      onCameraSignal: (signal) => {
        handleCameraSignal(signal).catch((error) => {
          recordControlDiagnostic({
            event: 'webrtc.camera-signal-processing-failed',
            domain: 'webrtc',
            level: 'error',
            errorCode: 'webrtc_camera_signal_processing_failed',
            recoverability: 'retryable',
            correlation: { callId: currentCallIdRef.current || undefined },
            exception: normalizeDiagnosticError(error),
          });
          console.warn('[webrtc] camera signal failed:', error);
          showToast(`摄像头连接失败：${error?.message || error}`, true);
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
          setScreenQuality(payload.quality);
          setScreenControlPending(false);
          if (payload.reason === 'controller_disabled') setScreenDesired(false);
          else if (payload.state === 'available') setScreenDesired(true);
          setRemoteReady(payload.state === 'available' && !!remoteVideoStreamRef.current?.getVideoTracks().length);
          if (payload.reason === 'capture_failed') showToast('对方屏幕采集失败，音频仍可继续', true);
          if (payload.reason === 'track_ended') showToast('对方已停止屏幕共享，音频仍可继续');
          if (payload.reason === 'profile_failed') showToast('对方屏幕低清参数应用失败，音频仍可继续', true);
        }
        if (payload.media === 'camera') {
          if (payload.sourceDeviceId && payload.sourceDeviceId !== callTargetIdRef.current) return;
          setRemoteCameraStatus(payload.state);
          setRemoteCameraQuality(payload.quality);
          if (payload.reason === 'permission_denied') showToast('对方未授予摄像头权限', true);
          if (payload.reason === 'device_lost') showToast('对方摄像头已断开', true);
          if (payload.reason === 'profile_failed') showToast('对方摄像头低清参数应用失败', true);
        }
      },
      onCallStart: (callId, peerDeviceId, cameraOffererDeviceId, legacyCameraSenderDeviceId) => {
        callTargetIdRef.current = peerDeviceId || callTargetIdRef.current;
        const offererDeviceId = cameraOffererDeviceId || (legacyCameraSenderDeviceId
          ? legacyCameraSenderDeviceId === selfDeviceIdRef.current
            ? peerDeviceId
            : selfDeviceIdRef.current
          : '');
        setActiveView('call');
        beginMediaCall(callId).then(() => {
          if (offererDeviceId) return beginCameraCall(callId, offererDeviceId);
          showToast('摄像头协议不兼容，请升级双方客户端', true);
        }).catch((e) => {
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
      onNoteChanged: ({ note }) => {
        const self = memberIdRef.current;
        if (note.senderMemberId === self) {
          setSentNotes((items) => upsertNote(items, note));
        }
        setNoteHistory((items) => note.review
          ? upsertNote(items, note)
          : items.filter((item) => item.id !== note.id));
        setFavoriteNotes((items) => note.favorite
          ? upsertNote(items, note)
          : items.filter((item) => item.id !== note.id));
      },
      onNoteRemoved: ({ noteId }) => {
        setSentNotes((items) => items.filter((item) => item.id !== noteId));
        setNoteHistory((items) => items.filter((item) => item.id !== noteId));
        setFavoriteNotes((items) => items.filter((item) => item.id !== noteId));
      },
    });
    return () => setListeners({});
  }, [beginCameraCall, beginMediaCall, handleCameraSignal, handleSignal, memberId, participantId, showToast, teardownCall]);

  useEffect(() => () => {
    teardownCall({ nextState: 'idle' });
  }, [teardownCall]);

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
    return bridge.onOpenNoteComposer(() => {
      setActiveView('notes');
      setNoteSection('compose');
    });
  }, []);

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

  const bindScreenVideo = useCallback((element: HTMLVideoElement | null) => {
    remoteVideoRef.current = element;
    if (!element || !remoteVideoStreamRef.current) return;
    element.srcObject = remoteVideoStreamRef.current;
    element.muted = true;
    void element.play().catch(() => {});
  }, []);

  const bindRemoteCameraVideo = useCallback((element: HTMLVideoElement | null) => {
    remoteCameraVideoRef.current = element;
    if (!element || !remoteCameraStreamRef.current) return;
    element.srcObject = remoteCameraStreamRef.current;
    element.muted = true;
    void element.play().catch(() => {});
  }, []);

  const bindLocalCameraVideo = useCallback((element: HTMLVideoElement | null) => {
    localCameraVideoRef.current = element;
    if (!element || !localCameraStreamRef.current) return;
    element.srcObject = localCameraStreamRef.current;
    element.muted = true;
    void element.play().catch(() => {});
  }, []);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const onDeviceChange = () => void refreshCameraDevices();
    mediaDevices.addEventListener('devicechange', onDeviceChange);
    return () => mediaDevices.removeEventListener('devicechange', onDeviceChange);
  }, [refreshCameraDevices]);

  useEffect(() => {
    if (!cameraDesired || !selectedCameraId) return;
    const activeTrack = localCameraStreamRef.current?.getVideoTracks()[0];
    const activeId = activeTrack?.getSettings().deviceId;
    if (!cameraCapturePendingRef.current && (!activeTrack || activeTrack.readyState !== 'live' || activeId !== selectedCameraId)) {
      void setLocalCameraEnabled(true);
    }
  }, [cameraDesired, selectedCameraId, setLocalCameraEnabled]);

  useEffect(() => {
    const bridge = window.desktopPetControl;
    if (!bridge) return;
    return bridge.onMediaFloatClosed(() => {
      mediaFloatWindowRef.current = null;
      setFloatContainer(null);
    });
  }, []);

  const openMediaFloat = useCallback(() => {
    if (!window.desktopPetControl) return;
    if (mediaFloatWindowRef.current && !mediaFloatWindowRef.current.closed) {
      mediaFloatWindowRef.current.focus();
      return;
    }
    const child = window.open('about:blank', 'media-float', 'width=480,height=270');
    if (!child) {
      showToast('无法创建系统浮窗', true);
      return;
    }
    child.document.title = '通话浮窗';
    child.document.documentElement.style.background = '#17141c';
    child.document.body.style.margin = '0';
    child.document.body.style.overflow = 'hidden';
    for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
      child.document.head.appendChild(node.cloneNode(true));
    }
    const root = child.document.createElement('div');
    root.className = 'media-float-root';
    child.document.body.appendChild(root);
    child.addEventListener('beforeunload', () => {
      mediaFloatWindowRef.current = null;
      setFloatContainer(null);
    }, { once: true });
    mediaFloatWindowRef.current = child;
    setFloatContainer(root);
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

  const refreshNotes = useCallback(async () => {
    const [sent, history, favorites] = await Promise.all([listNotes('sent'), listNotes('history'), listNotes('favorites')]);
    if (sent.ok) setSentNotes(sent.items || []);
    if (history.ok) setNoteHistory(history.items || []);
    if (favorites.ok) setFavoriteNotes(favorites.items || []);
  }, []);

  useEffect(() => {
    if (activeView === 'notes' && status === 'connected') void refreshNotes();
  }, [activeView, refreshNotes, status]);

  const onSelectNoteImage = useCallback(async (file?: File) => {
    if (!file) return;
    try {
      const image = await compressNoteImage(file);
      setNoteImage(image);
      setNoteImageName(file.name);
    } catch {
      setNoteImage(null);
      setNoteImageName('');
      showToast('图片压缩后仍超过 2 MB，或格式无法读取', true);
    }
  }, [showToast]);

  const onSendNote = useCallback(async () => {
    const body = noteBody.trim();
    if (graphemeCount(body) > 1000) return showToast('便签正文最多 1000 个字符', true);
    let media: Parameters<typeof createNote>[0]['media'];
    if (noteMediaKind === 'image') {
      if (!noteImage) return showToast('请选择一张图片', true);
      media = { kind: 'image', mime: noteImage.mime, data: noteImage.data };
    } else if (noteMediaKind === 'song' || noteMediaKind === 'video') {
      if (!noteLink.trim()) return showToast('请输入外部链接', true);
      media = { kind: noteMediaKind, url: noteLink.trim() };
    }
    if (!body && !media) return showToast('写点内容或添加一个媒体', true);
    setNoteSending(true);
    const result = await createNote({ body, paperColor: noteColor, ...(media ? { media } : {}) });
    setNoteSending(false);
    if (!result.ok) return showToast(noteErrorMessage(result.code), true);
    setNoteBody('');
    setNoteMediaKind('none');
    setNoteLink('');
    setNoteImage(null);
    setNoteImageName('');
    showToast('便签已投递');
    await refreshNotes();
  }, [noteBody, noteColor, noteImage, noteLink, noteMediaKind, refreshNotes, showToast]);

  const toggleNoteFavorite = useCallback(async (note: DesktopNote) => {
    const result = await setNoteFavorite(note.id, !note.favorite);
    if (!result.ok) return showToast(noteErrorMessage(result.code), true);
    await refreshNotes();
  }, [refreshNotes, showToast]);

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
    try {
      const result = await window.desktopPetControl?.exportDiagnostics();
      if (!result || result.canceled) return;
      if (result.ok) {
        setDiagnosticStatus({ pendingIncidents: [] });
        showToast(`诊断包已保存：${result.path || '已选择的位置'}`);
      } else {
        showToast(`导出失败：${result.error || 'storage_diagnostic_export_failed'}`, true);
      }
    } catch (error) {
      recordControlDiagnostic({
        event: 'storage.diagnostic-export-failed',
        domain: 'storage',
        level: 'error',
        errorCode: 'storage_diagnostic_export_failed',
        recoverability: 'retryable',
        exception: normalizeDiagnosticError(error),
      });
      showToast('导出失败：storage_diagnostic_export_failed', true);
    }
  }, [showToast]);

  const dismissDiagnosticIncident = useCallback(async (id: string) => {
    const result = await window.desktopPetControl?.dismissDiagnosticIncident(id);
    if (!result?.ok) {
      showToast(`忽略失败：${result?.error || 'storage_diagnostic_incident_update_failed'}`, true);
      return;
    }
    setDiagnosticStatus((current) => ({
      pendingIncidents: current.pendingIncidents.filter((incident) => incident.id !== id),
    }));
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

  const toggleRemoteScreen = useCallback(async () => {
    const callId = currentCallIdRef.current;
    if (!callId || screenControlPending) return;
    const enabled = !screenDesired;
    setScreenControlPending(true);
    const result = await requestMediaControl({ callId, media: 'screen', enabled });
    if (!result.ok) {
      setScreenControlPending(false);
      showToast(`屏幕控制失败：${result.code || 'unknown'}`, true);
    }
  }, [screenControlPending, screenDesired, showToast]);

  const toggleCamera = useCallback(async () => {
    const callId = currentCallIdRef.current;
    if (!callId || cameraControlPending) return;
    const enabled = !cameraDesired;
    setCameraControlPending(true);
    try {
      await setLocalCameraEnabled(enabled);
    } finally {
      setCameraControlPending(false);
    }
  }, [cameraControlPending, cameraDesired, setLocalCameraEnabled]);

  const selectCamera = useCallback((deviceId: string) => {
    setSelectedCameraId(deviceId);
    if (deviceId) localStorage.setItem(LS_CAMERA_DEVICE, deviceId);
  }, []);

  const toggleLocalMic = useCallback(() => {
    if (callState !== 'in-call' && callState !== 'calling') return;
    setMicEnabled(!micEnabled);
  }, [callState, micEnabled, setMicEnabled]);

  const peerName = peerMember?.displayName || '对方';
  const selfName = selfMember?.displayName || '我';
  const callActive = callState === 'requesting-media' || callState === 'calling' || callState === 'in-call';
  const remoteCameraAvailable = remoteCameraStatus === 'available';
  const effectivePrimary: 'screen' | 'camera' = !cameraHidden && screenStatus !== 'available' && remoteCameraAvailable
    ? 'camera'
    : !cameraHidden && preferredPrimary === 'camera' && remoteCameraAvailable ? 'camera' : 'screen';
  const mediaStage = callActive ? (
    <section className={`video-stage-new unified-media-stage ${floatContainer ? 'detached' : ''}`} ref={videoStageRef}>
      <div className={`media-surface screen-surface ${effectivePrimary === 'screen' ? 'primary' : 'inset'} ${screenStatus === 'available' ? 'available' : ''}`}>
        <video ref={bindScreenVideo} playsInline autoPlay muted />
        {!floatContainer && screenStatus !== 'available' && <div className="surface-label">屏幕{screenStatus === 'paused' ? '已暂停' : '不可用'}</div>}
        {!floatContainer && screenStatus === 'available' && screenQuality === 'relay-low' && <div className="quality-badge">屏幕 · TURN 低清</div>}
      </div>
      {!cameraHidden && <div className={`media-surface camera-surface ${effectivePrimary === 'camera' ? 'primary' : 'inset'} ${remoteCameraAvailable ? 'available' : ''}`}>
        <video ref={bindRemoteCameraVideo} playsInline autoPlay muted />
        {!floatContainer && !remoteCameraAvailable && <div className="surface-label">摄像头未开启</div>}
        {!floatContainer && remoteCameraAvailable && remoteCameraQuality === 'relay-low' && <div className="quality-badge">摄像头 · TURN 低清</div>}
      </div>}
      {!floatContainer && screenStatus !== 'available' && !remoteCameraAvailable && <div className="call-placeholder"><div className="pet-face small">˶ᵔ ᵕ ᵔ˶</div><strong>音频通话中</strong></div>}
      {!floatContainer && <div className="call-controls media-controls">
        <button disabled={screenControlPending} onClick={() => void toggleRemoteScreen()}>{screenControlPending ? '处理中…' : screenDesired ? '停止屏幕共享' : '恢复屏幕共享'}</button>
        <button disabled={cameraControlPending} onClick={() => void toggleCamera()}>{cameraControlPending ? '处理中…' : cameraDesired ? '关闭摄像头' : '打开摄像头'}</button>
        {remoteCameraAvailable && <button onClick={() => setCameraHidden((hidden) => !hidden)}>{cameraHidden ? '显示摄像头' : '隐藏摄像头'}</button>}
        {remoteCameraAvailable && !cameraHidden && <button onClick={() => setPreferredPrimary((value) => value === 'screen' ? 'camera' : 'screen')}>交换画面</button>}
        {window.desktopPetControl && <button onClick={openMediaFloat}>系统浮窗</button>}
        <button disabled={!remoteReady && !remoteCameraAvailable} onClick={() => void toggleFullscreen()}>全屏</button>
        <button className="hangup" onClick={onEndCall}>结束</button>
      </div>}
    </section>
  ) : null;

  return (
    <div className="control-app">
      <aside className="app-rail" aria-label="主导航">
        <div className="brand-mark" aria-hidden="true">🐾</div>
        {([
          ['control', '⌁', '控制'],
          ['send', '✦', '发送'],
          ['notes', '✉', '便签'],
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

        {activeView === 'notes' && (
          <main className="page notes-page">
            <div className="page-heading">
              <div><h1>桌面便签</h1><p>投递后会在{peerName}的桌面展开，等待对方明确批阅。</p></div>
              <div className="segmented">
                <button className={noteSection === 'compose' ? 'active' : ''} onClick={() => setNoteSection('compose')}>写便签</button>
                <button className={noteSection === 'sent' ? 'active' : ''} onClick={() => setNoteSection('sent')}>已发送</button>
                <button className={noteSection === 'history' ? 'active' : ''} onClick={() => setNoteSection('history')}>历史</button>
                <button className={noteSection === 'favorites' ? 'active' : ''} onClick={() => setNoteSection('favorites')}>收藏</button>
              </div>
            </div>
            {noteSection === 'compose' && (
              <section className="card note-compose">
                <div className="note-paper" style={{ background: NOTE_COLORS.find((color) => color.id === noteColor)?.value }}>
                  <textarea value={noteBody} onChange={(event) => setNoteBody(event.target.value)} placeholder="写一张可以稍后看的便签…" />
                  <small className={graphemeCount(noteBody) > 1000 ? 'over' : ''}>{graphemeCount(noteBody)} / 1000</small>
                  {noteMediaKind === 'image' && <div className="note-attachment-preview">▧ {noteImageName || '选择一张图片'}</div>}
                  {(noteMediaKind === 'song' || noteMediaKind === 'video') && <input type="url" value={noteLink} onChange={(event) => setNoteLink(event.target.value)} placeholder={noteMediaKind === 'song' ? '粘贴歌曲链接' : '粘贴视频链接'} />}
                </div>
                <div className="note-compose-tools">
                  <fieldset><legend>纸张颜色</legend><div className="note-color-row">{NOTE_COLORS.map((color) => <button key={color.id} className={noteColor === color.id ? 'selected' : ''} style={{ background: color.value }} title={color.label} aria-label={color.label} onClick={() => setNoteColor(color.id)} />)}</div></fieldset>
                  <fieldset><legend>附加一种内容</legend><div className="button-row">{(['none', 'image', 'song', 'video'] as const).map((kind) => <button key={kind} className={noteMediaKind === kind ? 'selected' : ''} onClick={() => { setNoteMediaKind(kind); if (kind !== 'image') { setNoteImage(null); setNoteImageName(''); } if (kind === 'none' || kind === 'image') setNoteLink(''); }}>{({ none: '无附件', image: '图片', song: '歌曲链接', video: '视频链接' })[kind]}</button>)}</div></fieldset>
                  {noteMediaKind === 'image' && <label className="button-like">选择图片<input hidden type="file" accept="image/jpeg,image/png" onChange={(event) => void onSelectNoteImage(event.target.files?.[0])} /></label>}
                  <button className="primary-button large" disabled={status !== 'connected' || noteSending || graphemeCount(noteBody) > 1000} onClick={() => void onSendNote()}>{noteSending ? '投递中…' : `投递给${peerName}`}</button>
                </div>
              </section>
            )}
            {noteSection === 'sent' && <section className="note-record-grid">{sentNotes.map((note) => <NoteRecordCard key={note.id} note={note} onFavorite={toggleNoteFavorite} />)}{!sentNotes.length && <div className="card notes-empty">还没有发出的便签。</div>}</section>}
            {noteSection === 'history' && <section className="note-record-grid">{noteHistory.map((note) => <NoteRecordCard key={note.id} note={note} onFavorite={toggleNoteFavorite} />)}{!noteHistory.length && <div className="card notes-empty">批阅后的便签会在这里保留 30 天。</div>}</section>}
            {noteSection === 'favorites' && <section className="note-record-grid">{favoriteNotes.map((note) => <NoteRecordCard key={note.id} note={note} onFavorite={toggleNoteFavorite} />)}{!favoriteNotes.length && <div className="card notes-empty">收藏会同步到你的所有设备。</div>}</section>}
          </main>
        )}

        {activeView === 'call' && (
          <main className={`page call-page ${callActive ? 'active-call' : ''}`}>
            <audio ref={remoteMicAudioRef} autoPlay muted={remoteMicMuted} /><audio ref={remoteSystemAudioRef} autoPlay muted={remoteSystemMuted} />
            {callActive ? (
              <>
                {!floatContainer && mediaStage}
                <aside className="call-sidebar"><section className="card"><h2>正在和{peerName}通话</h2><p>{callState === 'in-call' ? '已连接' : '连接中…'}</p></section><section className="card"><h2>通话控制</h2><label>我的麦克风<input type="checkbox" checked={micEnabled} onChange={toggleLocalMic} /></label><label>对方系统声音<input type="checkbox" checked={!remoteSystemMuted} onChange={() => void toggleRemoteAudio('system')} /></label><label>对方麦克风<input type="checkbox" checked={!remoteMicMuted} onChange={() => void toggleRemoteAudio('mic')} /></label></section><section className="card camera-preview-card"><div className="section-title"><h2>我的摄像头</h2><button onClick={() => setCameraPreviewCollapsed((value) => !value)}>{cameraPreviewCollapsed ? '展开预览' : '收起预览'}</button></div>{!cameraPreviewCollapsed && <video ref={bindLocalCameraVideo} autoPlay muted playsInline />}{cameraDevices.length > 0 && <select aria-label="选择摄像头" value={selectedCameraId} onChange={(event) => selectCamera(event.target.value)}>{cameraDevices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `摄像头 ${index + 1}`}</option>)}</select>}<button disabled={cameraControlPending} onClick={() => void toggleCamera()}>{cameraDesired ? '关闭并释放摄像头' : '打开摄像头'}</button><small>{localCameraStatus === 'available' ? localCameraQuality === 'relay-low' ? '正在以 TURN 低清发送；' : '正在发送；' : localCameraStatus === 'paused' ? '画面暂未发送；' : ''}收起预览不会停止发送；关闭会真正释放硬件。</small></section><section className="card connection-quality"><span className="status-dot" />{rtcRoute.candidateType === 'failed' ? '连接恢复中' : rtcRoute.candidateType === 'unknown' ? '正在选路' : rtcRoute.relayed ? 'TURN 低清视频' : `连接稳定 · ${rtcRoute.path}`}</section></aside>
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
              {window.desktopPetControl && <section className="card settings-section"><h2>本机桌宠</h2><div className="scale-settings"><input className="scale-range" type="range" min="30" max="150" step="10" value={Math.round(petScale * 100)} onChange={(event) => void changePetScale(Number(event.target.value) / 100)} /><strong>{Math.round(petScale * 100)}%</strong></div><div className="button-row"><button onClick={() => void resetPetScale()}>恢复默认</button></div></section>}
              <section className="card settings-section"><h2>语音服务</h2><div className="button-row"><button className={ttsMode === 'managed' ? 'selected' : ''} onClick={() => selectTtsMode('managed')}>服务端声音</button>{ttsProvider === 'elevenlabs' && <button className={ttsMode === 'byok' ? 'selected' : ''} onClick={() => selectTtsMode('byok')}>我的 API Key</button>}</div>{ttsMode === 'byok' && <div className="key-row"><input type="password" value={ttsApiKeyInput} onChange={(event) => setTtsApiKeyInput(event.target.value)} placeholder={ttsKeyConfigured ? '已配置，输入新 Key 可替换' : 'ElevenLabs API Key'} /><button onClick={() => void saveByokKey()}>保存</button>{ttsKeyConfigured && <button className="danger" onClick={() => void clearByokKey()}>删除 Key</button>}</div>}</section>
            </>}
            {window.desktopPetControl && (
              <section className="card settings-section diagnostics-section">
                <h2>诊断与故障</h2>
                {diagnosticStatus.pendingIncidents.map((incident) => (
                  <div className="diagnostic-incident" key={incident.id}>
                    <div>
                      <strong>检测到上次异常退出</strong>
                      <small>{new Date(incident.timestamp).toLocaleString()} · {incident.errorCode}{incident.count > 1 ? ` · ${incident.count} 次` : ''}</small>
                    </div>
                    <span className="button-row">
                      <button className="primary-button" onClick={() => void exportDiagnostics()}>导出诊断</button>
                      <button onClick={() => void dismissDiagnosticIncident(incident.id)}>忽略</button>
                    </span>
                  </div>
                ))}
                <p className="settings-hint">诊断包保存在你选择的位置，不会自动上传。导出前会提示其中包含 IP、端口等网络地址信息。</p>
                <div className="button-row"><button className="primary-button" onClick={() => void exportDiagnostics()}>导出诊断包</button></div>
              </section>
            )}
          </main>
        )}
      </div>
      {floatContainer && mediaStage && createPortal(mediaStage, floatContainer)}
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

function NoteAttachmentImage({ noteId, attachment }: { noteId: string; attachment: { id: string; mime: string } }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    void getNoteAttachment(noteId, attachment.id).then((result) => {
      if (!active || !result.ok || !result.data) return;
      objectUrl = URL.createObjectURL(new Blob([result.data], { type: result.mime || attachment.mime }));
      setUrl(objectUrl);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, attachment.mime, noteId]);
  return url ? <img className="note-record-image" src={url} alt="便签图片" /> : <span className="note-media-pill">正在加载图片…</span>;
}

function NoteRecordCard({ note, onFavorite }: { note: DesktopNote; onFavorite: (note: DesktopNote) => void }) {
  const color = NOTE_COLORS.find((item) => item.id === note.paperColor)?.value || '#F4D77D';
  const linkMedia = note.media?.kind === 'song' || note.media?.kind === 'video' ? note.media : null;
  const openExternal = (event: ReactMouseEvent<HTMLAnchorElement>, url: string) => {
    if (!window.desktopPetControl) return;
    event.preventDefault();
    void window.desktopPetControl.openExternal(url);
  };
  return (
    <article className="card note-record" style={{ '--note-paper': color } as CSSProperties}>
      <div className="note-record-head"><small>{new Date(note.createdAt).toLocaleString()}</small><button aria-label={note.favorite ? '取消收藏' : '收藏'} onClick={() => onFavorite(note)}>{note.favorite ? '★' : '☆'}</button></div>
      <p>{note.body || (note.media?.kind === 'image' ? '图片便签' : '分享了一个链接')}</p>
      {note.media?.kind === 'image' && <NoteAttachmentImage noteId={note.id} attachment={note.media.attachment} />}
      {linkMedia?.thumbnailUrl && <img className="note-record-image" src={linkMedia.thumbnailUrl} alt="" referrerPolicy="no-referrer" />}
      {linkMedia && <a href={linkMedia.url} target="_blank" rel="noreferrer" onClick={(event) => openExternal(event, linkMedia.url)}>{linkMedia.kind === 'song' ? '♫' : '▶'} {linkMedia.source}</a>}
      <div className={`note-review-state ${note.review ? 'done' : ''}`}>
        {note.review ? <><strong>已批阅 · {new Date(note.review.reviewedAt).toLocaleString()}</strong>{note.review.body && <p>{note.review.body}</p>}{note.review.imageAttachment && <NoteAttachmentImage noteId={note.id} attachment={note.review.imageAttachment} />}</> : <strong>等待对方批阅</strong>}
      </div>
    </article>
  );
}
