import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { connect, disconnect, listMotions, listTtsVoices, createTts, endCall, requestCall, requestRtcConfig, sendCommand, sendSignal, sendCameraSignal, sendMediaStatus, requestMediaControl, setListeners, setTtsCredentials, addPersonalAudio, deletePersonalAudio, listPersonalAudio, playPersonalAudio, renamePersonalAudio, getPersonalAudio, renameMember, discoverPairing, changeMember, reclaimDevice, } from './api';
const LS_SERVER = 'pet.serverUrl';
const LS_SECRET = 'pet.secret';
const LS_PARTICIPANT = 'pet.participantId';
const LS_TARGET_DEVICE = 'pet.targetDeviceId';
const LS_TARGET_DEVICES = 'pet.targetDeviceIds';
const LS_MEMBER_NAMES = 'pet.memberNames';
const LS_TTS_MODE = 'pet.ttsMode';
const LS_TTS_VOICE = 'pet.ttsVoiceId';
const LS_CAMERA_DEVICE = 'pet.cameraDeviceId';
function localParticipantId() {
    const saved = localStorage.getItem(LS_PARTICIPANT);
    if (saved)
        return saved;
    const id = crypto.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(LS_PARTICIPANT, id);
    return id;
}
const DEFAULT_SERVER = import.meta.env.VITE_PET_SERVER_URL || 'http://localhost:3030';
const DEFAULT_SECRET = import.meta.env.VITE_PET_ROOM_SECRET || 'change-me';
const QUICK_MOTION_IDS = new Set(['joy', 'jumping', 'sorrow', 'waiting']);
const QUICK_MOTION_ICONS = {
    joy: '♡',
    jumping: '↑',
    sorrow: '☁',
    waiting: '…',
};
const CORNERS = [
    { corner: 'top-left', label: '左上' },
    { corner: 'top-right', label: '右上' },
    { corner: 'bottom-left', label: '左下' },
    { corner: 'bottom-right', label: '右下' },
];
const EMPTY_RTC_ROUTE = {
    candidateType: 'unknown',
    relayed: false,
    path: '选路中',
    detail: '等待 ICE 选路',
};
function readSavedTargets(memberId, devices) {
    try {
        const parsed = JSON.parse(localStorage.getItem(`${LS_TARGET_DEVICES}.${memberId}`) || '[]');
        if (Array.isArray(parsed))
            return parsed.filter((id) => typeof id === 'string');
    }
    catch { }
    const legacy = localStorage.getItem(LS_TARGET_DEVICE);
    return legacy && devices.some((device) => device.id === legacy) ? [legacy] : [];
}
function normalizeTargets(devices, saved) {
    const online = devices.filter((device) => device.petOnline);
    const onlineIds = new Set(online.map((device) => device.id));
    const retained = saved.filter((id, index) => onlineIds.has(id) && saved.indexOf(id) === index);
    if (retained.length)
        return retained;
    const newest = [...online].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0];
    return newest ? [newest.id] : [];
}
function readMemberNames() {
    try {
        const saved = JSON.parse(localStorage.getItem(LS_MEMBER_NAMES) || '{}');
        return { a: String(saved.a || '用户 A'), b: String(saved.b || '用户 B') };
    }
    catch {
        return { a: '用户 A', b: '用户 B' };
    }
}
function hasCompletePairing(config) {
    return !!String(config.serverUrl || '').trim()
        && !!String(config.roomSecret || '').trim()
        && (config.memberId === 'a' || config.memberId === 'b')
        && !!String(config.deviceId || '').trim()
        && !!String(config.deviceName || '').trim();
}
function pairingErrorMessage(code) {
    const messages = {
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
function explainMediaDevicesUnavailable() {
    const protocol = window.location.protocol;
    const host = window.location.hostname;
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (protocol !== 'https:' && !isLocalhost) {
        return '当前控制台页面不是浏览器认可的安全上下文，麦克风被禁用；将只接收远程画面，请用可信 HTTPS 域名开启对讲。';
    }
    return '当前浏览器不支持麦克风采集；将只接收远程画面。';
}
function candidateAddress(candidate) {
    return candidate?.address || candidate?.ip || candidate?.hostname || '';
}
async function readRtcRoute(pc) {
    if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') {
        return { candidateType: 'failed', relayed: false, path: '失败', detail: 'ICE 连接失败' };
    }
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
            pair = stats.get(report.selectedCandidatePairId);
        }
    });
    if (!pair) {
        stats.forEach((report) => {
            if (report.type === 'candidate-pair' && (report.selected || report.nominated) && report.state === 'succeeded') {
                pair = report;
            }
        });
    }
    if (!pair)
        return EMPTY_RTC_ROUTE;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const candidateType = (local?.candidateType || 'unknown');
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
function ttsErrorMessage(code) {
    const messages = {
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
    const [status, setStatus] = useState('idle');
    const [participantId, setParticipantId] = useState(localParticipantId);
    const [memberId, setMemberId] = useState('');
    const [deviceName, setDeviceName] = useState('浏览器');
    const [activeView, setActiveView] = useState('settings');
    const [sendView, setSendView] = useState('tts');
    const [targetIds, setTargetIds] = useState([]);
    const [callTargetId, setCallTargetId] = useState('');
    const [targetMenuOpen, setTargetMenuOpen] = useState(false);
    const [editingMemberId, setEditingMemberId] = useState(null);
    const [memberNameDraft, setMemberNameDraft] = useState('');
    const [knownMemberNames, setKnownMemberNames] = useState(readMemberNames);
    const [setupStage, setSetupStage] = useState(() => window.desktopPetControl ? 'server' : 'complete');
    const [verifiedMembers, setVerifiedMembers] = useState(null);
    const [verifyingPairing, setVerifyingPairing] = useState(false);
    const [identityChangeOpen, setIdentityChangeOpen] = useState(false);
    const [identityChangeTarget, setIdentityChangeTarget] = useState('a');
    const [identityChanging, setIdentityChanging] = useState(false);
    const [editingAudioId, setEditingAudioId] = useState(null);
    const [audioNameDraft, setAudioNameDraft] = useState('');
    const [deleteAudioId, setDeleteAudioId] = useState(null);
    const [reclaimCandidate, setReclaimCandidate] = useState(null);
    const [peers, setPeers] = useState({
        protocolVersion: 2, self: { memberId: 'a', deviceId: '' }, members: [],
        selfReady: false, peerOnline: false, peerPetOnline: false, peerControllerOnline: false,
        controller: false, pet: false,
    });
    const [motions, setMotions] = useState([]);
    const [personalAudio, setPersonalAudio] = useState([]);
    const [recording, setRecording] = useState(false);
    const [tts, setTts] = useState('');
    const [ttsMode, setTtsMode] = useState(() => localStorage.getItem(LS_TTS_MODE) === 'byok' ? 'byok' : 'managed');
    const [ttsProvider, setTtsProvider] = useState('elevenlabs');
    const [ttsApiKey, setTtsApiKey] = useState('');
    const [ttsApiKeyInput, setTtsApiKeyInput] = useState('');
    const [ttsKeyConfigured, setTtsKeyConfigured] = useState(false);
    const [ttsVoices, setTtsVoices] = useState([]);
    const [ttsVoiceId, setTtsVoiceId] = useState(() => localStorage.getItem(LS_TTS_VOICE) || '');
    const [ttsState, setTtsState] = useState('等待发送');
    const [toast, setToast] = useState(null);
    const [petScale, setPetScaleState] = useState(1);
    const [callState, setCallState] = useState('idle');
    const [remoteMicMuted, setRemoteMicMuted] = useState(true);
    const [remoteSystemMuted, setRemoteSystemMuted] = useState(true);
    const [micEnabled, setMicEnabledState] = useState(false);
    const [remoteReady, setRemoteReady] = useState(false);
    const [screenStatus, setScreenStatus] = useState('unavailable');
    const [screenDesired, setScreenDesired] = useState(true);
    const [screenControlPending, setScreenControlPending] = useState(false);
    const [cameraStatus, setCameraStatus] = useState('unavailable');
    const [cameraDesired, setCameraDesired] = useState(false);
    const [cameraControlPending, setCameraControlPending] = useState(false);
    const [isCameraSender, setIsCameraSender] = useState(false);
    const [cameraDevices, setCameraDevices] = useState([]);
    const [selectedCameraId, setSelectedCameraId] = useState(() => localStorage.getItem(LS_CAMERA_DEVICE) || '');
    const [cameraPreviewCollapsed, setCameraPreviewCollapsed] = useState(false);
    const [cameraHidden, setCameraHidden] = useState(false);
    const [preferredPrimary, setPreferredPrimary] = useState('screen');
    const [floatContainer, setFloatContainer] = useState(null);
    const [remoteTrackSummary, setRemoteTrackSummary] = useState('无');
    const [rtcRoute, setRtcRoute] = useState(EMPTY_RTC_ROUTE);
    const toastTimer = useRef(null);
    const personalAudioRecorderRef = useRef(null);
    const remoteVideoRef = useRef(null);
    const remoteCameraVideoRef = useRef(null);
    const localCameraVideoRef = useRef(null);
    const remoteMicAudioRef = useRef(null);
    const remoteSystemAudioRef = useRef(null);
    const videoStageRef = useRef(null);
    const remoteVideoStreamRef = useRef(null);
    const remoteMicStreamRef = useRef(null);
    const remoteSystemStreamRef = useRef(null);
    const rtcPcRef = useRef(null);
    const cameraPcRef = useRef(null);
    const cameraSenderRef = useRef(null);
    const localCameraStreamRef = useRef(null);
    const remoteCameraStreamRef = useRef(null);
    const cameraPendingCandidatesRef = useRef([]);
    const cameraSenderDeviceIdRef = useRef('');
    const selfDeviceIdRef = useRef('');
    const cameraRouteIsP2PRef = useRef(false);
    const cameraRouteKnownRef = useRef(false);
    const cameraDesiredRef = useRef(false);
    const cameraCapturePendingRef = useRef(false);
    const mediaFloatWindowRef = useRef(null);
    const localAudioRef = useRef(null);
    const pendingCandidatesRef = useRef([]);
    const currentCallIdRef = useRef(null);
    const callTargetIdRef = useRef('');
    const recoveryTimerRef = useRef(null);
    const iceRestartedRef = useRef(false);
    const showToast = useCallback((msg, err = false) => {
        if (toastTimer.current)
            window.clearTimeout(toastTimer.current);
        setToast({ msg, err });
        toastTimer.current = window.setTimeout(() => setToast(null), 2200);
    }, []);
    const stopLocalAudio = useCallback(() => {
        try {
            localAudioRef.current?.getTracks().forEach((track) => track.stop());
        }
        catch { }
        localAudioRef.current = null;
    }, []);
    const setMicEnabled = useCallback((enabled) => {
        for (const track of localAudioRef.current?.getAudioTracks() ?? []) {
            track.enabled = enabled;
        }
        setMicEnabledState(enabled);
    }, []);
    const teardownCall = useCallback((opts) => {
        if (opts?.sendRemoteHangup)
            endCall(currentCallIdRef.current || undefined);
        try {
            rtcPcRef.current?.close();
        }
        catch { }
        if (recoveryTimerRef.current)
            window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
        iceRestartedRef.current = false;
        rtcPcRef.current = null;
        try {
            cameraPcRef.current?.close();
        }
        catch { }
        cameraPcRef.current = null;
        cameraSenderRef.current = null;
        cameraPendingCandidatesRef.current = [];
        cameraRouteIsP2PRef.current = false;
        cameraRouteKnownRef.current = false;
        for (const track of localCameraStreamRef.current?.getTracks() ?? [])
            track.stop();
        localCameraStreamRef.current = null;
        remoteCameraStreamRef.current = null;
        cameraDesiredRef.current = false;
        setCameraDesired(false);
        setCameraStatus('unavailable');
        setIsCameraSender(false);
        setCameraHidden(false);
        setPreferredPrimary('screen');
        if (localCameraVideoRef.current)
            localCameraVideoRef.current.srcObject = null;
        if (remoteCameraVideoRef.current)
            remoteCameraVideoRef.current.srcObject = null;
        try {
            mediaFloatWindowRef.current?.close();
        }
        catch { }
        mediaFloatWindowRef.current = null;
        setFloatContainer(null);
        pendingCandidatesRef.current = [];
        stopLocalAudio();
        setMicEnabled(false);
        setRemoteReady(false);
        setScreenStatus('unavailable');
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
        if (remoteVideoRef.current)
            remoteVideoRef.current.srcObject = null;
        if (remoteMicAudioRef.current)
            remoteMicAudioRef.current.srcObject = null;
        if (remoteSystemAudioRef.current)
            remoteSystemAudioRef.current.srcObject = null;
    }, [setMicEnabled, stopLocalAudio]);
    const sendRtcSignal = useCallback((signal) => {
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
        if (!videoStream || !remoteVideoRef.current)
            return;
        if (remoteVideoRef.current.srcObject !== videoStream) {
            remoteVideoRef.current.srcObject = videoStream;
        }
        remoteVideoRef.current.muted = true;
        try {
            await remoteVideoRef.current.play();
        }
        catch (e) {
            console.warn('[webrtc] remote video play failed:', e);
        }
    }, [screenStatus]);
    const flushPendingCandidates = useCallback(async () => {
        const pc = rtcPcRef.current;
        if (!pc?.remoteDescription)
            return;
        while (pendingCandidatesRef.current.length) {
            const candidate = pendingCandidatesRef.current.shift();
            if (!candidate)
                continue;
            try {
                await pc.addIceCandidate(candidate);
            }
            catch (e) {
                console.warn('[webrtc] addIceCandidate failed:', e);
            }
        }
    }, []);
    const ensureLocalAudio = useCallback(async () => {
        const live = localAudioRef.current?.getAudioTracks().some((track) => track.readyState === 'live');
        if (localAudioRef.current && live)
            return localAudioRef.current;
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
            for (const track of stream.getAudioTracks())
                track.enabled = false;
            localAudioRef.current = stream;
            return stream;
        }
        catch (e) {
            console.warn('[webrtc] local microphone capture failed; starting receive-only call:', e);
            showToast(`麦克风不可用，将只接收远程画面：${e?.message || e}`, true);
            return null;
        }
    }, [showToast]);
    const ensurePeerConnection = useCallback(async () => {
        if (rtcPcRef.current)
            return rtcPcRef.current;
        const localAudio = await ensureLocalAudio();
        const rtcConfig = await requestRtcConfig();
        const pc = new RTCPeerConnection(rtcConfig);
        rtcPcRef.current = pc;
        if (localAudio) {
            pc.addTrack(localAudio.getAudioTracks()[0], localAudio);
        }
        else {
            pc.addTransceiver('audio', { direction: 'recvonly' });
        }
        const systemTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.onicecandidate = (event) => {
            if (event.candidate)
                sendRtcSignal({ candidate: event.candidate.toJSON() });
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
                if (audio && audio.srcObject !== stream)
                    audio.srcObject = stream;
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
                syncRemoteMediaState().catch(() => { });
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
                if (recoveryTimerRef.current)
                    window.clearTimeout(recoveryTimerRef.current);
                recoveryTimerRef.current = null;
                setCallState('in-call');
                readRtcRoute(pc).then(setRtcRoute).catch(() => { });
                return;
            }
            if (state === 'failed' || state === 'disconnected') {
                setRtcRoute({ candidateType: 'failed', relayed: false, path: '失败', detail: `连接状态：${state}，正在恢复` });
                if (!iceRestartedRef.current) {
                    iceRestartedRef.current = true;
                    pc.createOffer({ iceRestart: true }).then(async (offer) => {
                        if (rtcPcRef.current !== pc)
                            return;
                        await pc.setLocalDescription(offer);
                        sendRtcSignal({ description: pc.localDescription });
                    }).catch((error) => console.warn('[webrtc] ICE restart failed:', error));
                }
                if (!recoveryTimerRef.current)
                    recoveryTimerRef.current = window.setTimeout(() => {
                        if (rtcPcRef.current !== pc || pc.connectionState === 'connected')
                            return;
                        showToast('通话恢复超时，已断开', true);
                        endCall(currentCallIdRef.current || undefined);
                        teardownCall({ nextState: 'idle' });
                    }, 15000);
            }
            if (state === 'closed')
                teardownCall({ nextState: 'idle' });
        };
        pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                readRtcRoute(pc).then(setRtcRoute).catch(() => { });
            }
            if (pc.iceConnectionState === 'failed') {
                setRtcRoute({ candidateType: 'failed', relayed: false, path: '失败', detail: 'ICE 连接失败' });
            }
        };
        return pc;
    }, [ensureLocalAudio, sendRtcSignal, showToast, teardownCall]);
    const handleSignal = useCallback(async (signal) => {
        if (!signal)
            return;
        if (signal.callId && signal.callId !== currentCallIdRef.current)
            return;
        if (signal.description) {
            const desc = signal.description;
            console.log('[webrtc] controller got description:', desc.type);
            if (desc.type === 'answer') {
                const pc = rtcPcRef.current;
                if (!pc)
                    return;
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
    const refreshCameraDevices = useCallback(async () => {
        if (!navigator.mediaDevices?.enumerateDevices)
            return;
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
        setCameraDevices(devices);
        setSelectedCameraId((current) => {
            if (current && devices.some((device) => device.deviceId === current))
                return current;
            const fallback = devices[0]?.deviceId || '';
            if (fallback)
                localStorage.setItem(LS_CAMERA_DEVICE, fallback);
            return fallback;
        });
    }, []);
    const reportCameraStatus = useCallback((state, reason) => {
        const callId = currentCallIdRef.current;
        if (!callId)
            return;
        setCameraStatus(state);
        sendMediaStatus({ callId, media: 'camera', state, ...(reason ? { reason } : {}) });
    }, []);
    const syncCameraSenderTrack = useCallback(async () => {
        const sender = cameraSenderRef.current;
        if (!sender)
            return;
        const track = cameraDesiredRef.current && cameraRouteIsP2PRef.current
            ? localCameraStreamRef.current?.getVideoTracks()[0] || null
            : null;
        await sender.replaceTrack(track);
        if (!cameraDesiredRef.current)
            reportCameraStatus('unavailable', 'controller_disabled');
        else if (!cameraRouteKnownRef.current)
            reportCameraStatus('paused');
        else if (!cameraRouteIsP2PRef.current)
            reportCameraStatus('paused', 'relay_audio_only');
        else if (track)
            reportCameraStatus('available');
        else
            reportCameraStatus('unavailable', 'capture_failed');
    }, [reportCameraStatus]);
    const setLocalCameraEnabled = useCallback(async (enabled) => {
        cameraDesiredRef.current = enabled;
        cameraCapturePendingRef.current = enabled;
        setCameraDesired(enabled);
        if (!enabled) {
            try {
                await cameraSenderRef.current?.replaceTrack(null);
            }
            catch { }
            for (const track of localCameraStreamRef.current?.getTracks() ?? [])
                track.stop();
            localCameraStreamRef.current = null;
            if (localCameraVideoRef.current)
                localCameraVideoRef.current.srcObject = null;
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
            for (const track of localCameraStreamRef.current?.getTracks() ?? [])
                track.stop();
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    ...(selectedCameraId ? { deviceId: { exact: selectedCameraId } } : {}),
                    width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 24 },
                },
                audio: false,
            });
            if (!cameraDesiredRef.current) {
                stream.getTracks().forEach((track) => track.stop());
                return;
            }
            localCameraStreamRef.current = stream;
            const track = stream.getVideoTracks()[0];
            track.addEventListener('ended', () => {
                if (localCameraStreamRef.current !== stream)
                    return;
                localCameraStreamRef.current = null;
                reportCameraStatus('unavailable', 'device_lost');
                void refreshCameraDevices();
                showToast('摄像头已断开，正在尝试默认设备', true);
            }, { once: true });
            if (localCameraVideoRef.current) {
                localCameraVideoRef.current.srcObject = stream;
                void localCameraVideoRef.current.play().catch(() => { });
            }
            await refreshCameraDevices();
            await syncCameraSenderTrack();
            cameraCapturePendingRef.current = false;
        }
        catch (error) {
            cameraDesiredRef.current = false;
            setCameraDesired(false);
            const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
            reportCameraStatus('unavailable', denied ? 'permission_denied' : 'capture_failed');
            showToast(denied ? '没有获得摄像头权限' : `摄像头打开失败：${error?.message || error}`, true);
            cameraCapturePendingRef.current = false;
        }
    }, [refreshCameraDevices, reportCameraStatus, selectedCameraId, showToast, syncCameraSenderTrack]);
    const ensureCameraPeerConnection = useCallback(async (senderSide) => {
        if (cameraPcRef.current)
            return cameraPcRef.current;
        const pc = new RTCPeerConnection(await requestRtcConfig());
        cameraPcRef.current = pc;
        if (!senderSide)
            pc.addTransceiver('video', { direction: 'recvonly' });
        pc.onicecandidate = (event) => {
            const callId = currentCallIdRef.current;
            if (event.candidate && callId)
                sendCameraSignal({ callId, candidate: event.candidate.toJSON() });
        };
        pc.ontrack = (event) => {
            const stream = remoteCameraStreamRef.current ?? new MediaStream();
            remoteCameraStreamRef.current = stream;
            if (!stream.getTracks().some((track) => track.id === event.track.id))
                stream.addTrack(event.track);
            if (remoteCameraVideoRef.current) {
                remoteCameraVideoRef.current.srcObject = stream;
                void remoteCameraVideoRef.current.play().catch(() => { });
            }
            setCameraStatus('available');
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') {
                readRtcRoute(pc).then(async (route) => {
                    cameraRouteKnownRef.current = true;
                    cameraRouteIsP2PRef.current = !route.relayed;
                    if (senderSide)
                        await syncCameraSenderTrack();
                }).catch(() => {
                    cameraRouteKnownRef.current = false;
                    cameraRouteIsP2PRef.current = false;
                    if (senderSide)
                        void syncCameraSenderTrack();
                });
            }
            else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                cameraRouteKnownRef.current = false;
                cameraRouteIsP2PRef.current = false;
                if (senderSide)
                    void syncCameraSenderTrack();
            }
        };
        return pc;
    }, [syncCameraSenderTrack]);
    const flushCameraCandidates = useCallback(async () => {
        const pc = cameraPcRef.current;
        if (!pc?.remoteDescription)
            return;
        while (cameraPendingCandidatesRef.current.length) {
            const candidate = cameraPendingCandidatesRef.current.shift();
            if (candidate)
                await pc.addIceCandidate(candidate);
        }
    }, []);
    const handleCameraSignal = useCallback(async (signal) => {
        if (!signal?.callId || signal.callId !== currentCallIdRef.current)
            return;
        const senderSide = selfDeviceIdRef.current === cameraSenderDeviceIdRef.current;
        const pc = await ensureCameraPeerConnection(senderSide);
        if (signal.description?.type === 'offer') {
            if (!senderSide)
                return;
            await pc.setRemoteDescription(signal.description);
            const videoTransceiver = pc.getTransceivers().find((item) => item.receiver.track.kind === 'video');
            if (!videoTransceiver)
                throw new Error('camera transceiver missing');
            videoTransceiver.direction = 'sendonly';
            cameraSenderRef.current = videoTransceiver.sender;
            await flushCameraCandidates();
            await pc.setLocalDescription(await pc.createAnswer());
            sendCameraSignal({ callId: signal.callId, description: pc.localDescription });
            return;
        }
        if (signal.description?.type === 'answer') {
            if (senderSide)
                return;
            await pc.setRemoteDescription(signal.description);
            await flushCameraCandidates();
            return;
        }
        if (signal.candidate) {
            if (!pc.remoteDescription)
                cameraPendingCandidatesRef.current.push(signal.candidate);
            else
                await pc.addIceCandidate(signal.candidate);
        }
    }, [ensureCameraPeerConnection, flushCameraCandidates]);
    const beginCameraCall = useCallback(async (callId, cameraSenderDeviceId) => {
        cameraSenderDeviceIdRef.current = cameraSenderDeviceId;
        const senderSide = selfDeviceIdRef.current === cameraSenderDeviceId;
        setIsCameraSender(senderSide);
        setCameraDesired(false);
        cameraDesiredRef.current = false;
        setCameraStatus('unavailable');
        if (senderSide) {
            await refreshCameraDevices();
            return;
        }
        const pc = await ensureCameraPeerConnection(false);
        await pc.setLocalDescription(await pc.createOffer());
        sendCameraSignal({ callId, description: pc.localDescription });
    }, [ensureCameraPeerConnection, refreshCameraDevices]);
    const beginMediaCall = useCallback(async (callId) => {
        if (currentCallIdRef.current === callId && rtcPcRef.current)
            return;
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
                selfDeviceIdRef.current = next.self.deviceId;
                const names = {
                    a: next.members.find((member) => member.id === 'a')?.displayName || '用户 A',
                    b: next.members.find((member) => member.id === 'b')?.displayName || '用户 B',
                };
                setKnownMemberNames(names);
                localStorage.setItem(LS_MEMBER_NAMES, JSON.stringify(names));
                const peer = next.members.find((member) => member.id !== next.self.memberId);
                if (!peer)
                    return;
                setTargetIds((current) => {
                    const saved = current.length ? current : readSavedTargets(peer.id, peer.devices);
                    const selected = normalizeTargets(peer.devices, saved);
                    localStorage.setItem(`${LS_TARGET_DEVICES}.${peer.id}`, JSON.stringify(selected));
                    return selected;
                });
                const callable = peer.devices.filter((device) => device.petOnline && device.controllerOnline);
                setCallTargetId((current) => {
                    if (callable.some((device) => device.id === current))
                        return current;
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
            onCameraSignal: (signal) => {
                handleCameraSignal(signal).catch((error) => {
                    console.warn('[webrtc] camera signal failed:', error);
                    showToast(`摄像头连接失败：${error?.message || error}`, true);
                });
            },
            onMediaControl: (control) => {
                if (control.callId !== currentCallIdRef.current || control.media !== 'camera' || !isCameraSender)
                    return;
                setCameraControlPending(true);
                setLocalCameraEnabled(control.enabled).finally(() => setCameraControlPending(false));
            },
            onHangup: () => {
                if (!currentCallIdRef.current)
                    return;
                teardownCall({ nextState: 'idle' });
                showToast('通话结束了');
            },
            onRtcError: (msg) => {
                showToast(msg, true);
                teardownCall({ nextState: 'error' });
            },
            onMediaStatus: (payload) => {
                if (payload.callId !== currentCallIdRef.current)
                    return;
                if (payload.media === 'screen') {
                    setScreenStatus(payload.state);
                    setScreenControlPending(false);
                    if (payload.reason === 'controller_disabled')
                        setScreenDesired(false);
                    else if (payload.state === 'available')
                        setScreenDesired(true);
                    setRemoteReady(payload.state === 'available' && !!remoteVideoStreamRef.current?.getVideoTracks().length);
                    if (payload.reason === 'relay_audio_only')
                        showToast('当前走 TURN：已停用画面，仅保留音频');
                    if (payload.reason === 'capture_failed')
                        showToast('对方屏幕采集失败，音频仍可继续', true);
                    if (payload.reason === 'track_ended')
                        showToast('对方已停止屏幕共享，音频仍可继续');
                }
                if (payload.media === 'camera') {
                    setCameraStatus(payload.state);
                    setCameraControlPending(false);
                    if (payload.reason === 'controller_disabled' || payload.state === 'unavailable')
                        setCameraDesired(false);
                    else
                        setCameraDesired(true);
                    if (payload.reason === 'permission_denied')
                        showToast('对方未授予摄像头权限', true);
                    if (payload.reason === 'device_lost')
                        showToast('对方摄像头已断开', true);
                    if (payload.reason === 'relay_audio_only')
                        showToast('TURN 模式不传输摄像头画面');
                }
            },
            onCallStart: (callId, peerDeviceId, cameraSenderDeviceId) => {
                callTargetIdRef.current = peerDeviceId || callTargetIdRef.current;
                if (cameraSenderDeviceId) {
                    cameraSenderDeviceIdRef.current = cameraSenderDeviceId;
                    setIsCameraSender(selfDeviceIdRef.current === cameraSenderDeviceId);
                }
                setActiveView('call');
                beginMediaCall(callId).then(() => {
                    if (cameraSenderDeviceId)
                        return beginCameraCall(callId, cameraSenderDeviceId);
                }).catch((e) => {
                    console.warn('[webrtc] start coordinated call failed:', e);
                    showToast(`通话失败：${e?.message || e}`, true);
                    teardownCall({ nextState: 'error' });
                });
            },
            onCallEnd: (callId) => {
                if (callId && currentCallIdRef.current && callId !== currentCallIdRef.current)
                    return;
                teardownCall({ nextState: 'idle' });
                showToast('通话结束了');
            },
            onTtsStatus: (payload) => {
                const labels = {
                    dispatched: '已发送到对方桌宠', generating: '正在生成语音…',
                    playing: '对方正在播放', completed: '播放完成', error: ttsErrorMessage(payload.error),
                };
                const label = labels[payload.state] || payload.state;
                setTtsState(label);
                if (payload.state === 'error')
                    showToast(label, true);
            },
        });
        return () => {
            setListeners({});
            teardownCall({ nextState: 'idle' });
        };
    }, [beginCameraCall, beginMediaCall, handleCameraSignal, handleSignal, isCameraSender, setLocalCameraEnabled, showToast, teardownCall]);
    useEffect(() => {
        const bridge = window.desktopPetControl;
        if (!bridge)
            return;
        const applyConfig = (config) => {
            const nextServer = String(config.serverUrl || '').trim();
            const nextSecret = String(config.roomSecret || '').trim();
            const nextParticipant = String(config.deviceId || '').trim();
            setServerUrl(nextServer);
            setSecret(nextSecret);
            if (nextParticipant)
                setParticipantId(nextParticipant);
            if (config.memberId)
                setMemberId(config.memberId);
            if (config.deviceName)
                setDeviceName(config.deviceName);
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
            if (configuredMemberId !== 'a' && configuredMemberId !== 'b')
                return;
            connect(nextServer, nextSecret, { memberId: configuredMemberId, deviceId: nextParticipant, deviceName: configuredDeviceName });
        };
        bridge.getPairingConfig().then(applyConfig).catch((e) => {
            showToast(`读取桌宠配置失败：${e?.message || e}`, true);
        });
        bridge.onPairingChanged(applyConfig);
    }, [showToast]);
    useEffect(() => {
        const bridge = window.desktopPetControl;
        if (!bridge)
            return;
        bridge.getPetScale().then((scale) => setPetScaleState(scale)).catch((error) => {
            showToast(`读取桌宠大小失败：${error?.message || error}`, true);
        });
        return bridge.onPetScaleChanged((scale) => setPetScaleState(scale));
    }, [showToast]);
    useEffect(() => {
        const bridge = window.desktopPetControl;
        if (!bridge)
            return;
        bridge.getTtsCredentials().then((result) => {
            setTtsKeyConfigured(!!result.configured);
            if (result.apiKey)
                setTtsApiKey(result.apiKey);
        }).catch(() => { });
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
                if (cancelled)
                    return;
                if (discovery.provider)
                    setTtsProvider(discovery.provider);
                if (discovery.provider === 'cosyvoice') {
                    setTtsMode('managed');
                    localStorage.setItem(LS_TTS_MODE, 'managed');
                    setTtsVoices(discovery.voices || []);
                    setTtsState(discovery.ok ? '等待发送' : ttsErrorMessage(discovery.code));
                }
                else {
                    setTtsVoices([]);
                    setTtsState('请配置 ElevenLabs API Key');
                }
                return;
            }
            const response = ttsMode === 'byok'
                ? await setTtsCredentials(ttsApiKey)
                : await setTtsCredentials('');
            if (cancelled)
                return;
            if (response.provider)
                setTtsProvider(response.provider);
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
                if (nextId)
                    localStorage.setItem(LS_TTS_VOICE, nextId);
                else
                    localStorage.removeItem(LS_TTS_VOICE);
            }
            setTtsState(response.voices.length ? '等待发送' : '没有可用声音');
        };
        load().catch((error) => {
            if (!cancelled)
                setTtsState(`声音加载失败：${error?.message || error}`);
        });
        return () => { cancelled = true; };
    }, [status, ttsApiKey, ttsMode]);
    useEffect(() => {
        if (status !== 'connected' || !peers.peerPetOnline) {
            setMotions([]);
            if (!peers.peerPetOnline)
                teardownCall({ nextState: 'idle' });
            return;
        }
        const primaryTargetId = targetIds[0];
        if (!primaryTargetId)
            return;
        listMotions(primaryTargetId).then((items) => {
            setMotions(items);
        });
    }, [status, peers.peerPetOnline, targetIds, teardownCall]);
    const toggleRemoteAudio = useCallback(async (kind) => {
        const isMic = kind === 'mic';
        const audio = isMic ? remoteMicAudioRef.current : remoteSystemAudioRef.current;
        const currentlyMuted = isMic ? remoteMicMuted : remoteSystemMuted;
        const nextMuted = !currentlyMuted;
        if (isMic)
            setRemoteMicMuted(nextMuted);
        else
            setRemoteSystemMuted(nextMuted);
        if (!audio)
            return;
        audio.muted = nextMuted;
        audio.volume = nextMuted ? 0 : 1;
        if (!nextMuted) {
            try {
                await audio.play();
                showToast(isMic ? '桌宠麦克风已打开' : '电脑系统声音已打开');
            }
            catch (e) {
                showToast(`声音播放失败：${e?.message || e}`, true);
            }
        }
    }, [remoteMicMuted, remoteSystemMuted, showToast]);
    const toggleFullscreen = useCallback(async () => {
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
            }
            else {
                await videoStageRef.current?.requestFullscreen();
            }
        }
        catch (e) {
            showToast(`全屏切换失败：${e?.message || e}`, true);
        }
    }, [showToast]);
    const bindScreenVideo = useCallback((element) => {
        remoteVideoRef.current = element;
        if (!element || !remoteVideoStreamRef.current)
            return;
        element.srcObject = remoteVideoStreamRef.current;
        element.muted = true;
        void element.play().catch(() => { });
    }, []);
    const bindRemoteCameraVideo = useCallback((element) => {
        remoteCameraVideoRef.current = element;
        if (!element || !remoteCameraStreamRef.current)
            return;
        element.srcObject = remoteCameraStreamRef.current;
        element.muted = true;
        void element.play().catch(() => { });
    }, []);
    const bindLocalCameraVideo = useCallback((element) => {
        localCameraVideoRef.current = element;
        if (!element || !localCameraStreamRef.current)
            return;
        element.srcObject = localCameraStreamRef.current;
        element.muted = true;
        void element.play().catch(() => { });
    }, []);
    useEffect(() => {
        const mediaDevices = navigator.mediaDevices;
        if (!mediaDevices?.addEventListener)
            return;
        const onDeviceChange = () => void refreshCameraDevices();
        mediaDevices.addEventListener('devicechange', onDeviceChange);
        return () => mediaDevices.removeEventListener('devicechange', onDeviceChange);
    }, [refreshCameraDevices]);
    useEffect(() => {
        if (!isCameraSender || !cameraDesired || !selectedCameraId)
            return;
        const activeTrack = localCameraStreamRef.current?.getVideoTracks()[0];
        const activeId = activeTrack?.getSettings().deviceId;
        if (!cameraCapturePendingRef.current && (!activeTrack || activeTrack.readyState !== 'live' || activeId !== selectedCameraId)) {
            void setLocalCameraEnabled(true);
        }
    }, [cameraDesired, isCameraSender, selectedCameraId, setLocalCameraEnabled]);
    useEffect(() => {
        const bridge = window.desktopPetControl;
        if (!bridge)
            return;
        return bridge.onMediaFloatClosed(() => {
            mediaFloatWindowRef.current = null;
            setFloatContainer(null);
        });
    }, []);
    const openMediaFloat = useCallback(() => {
        if (!window.desktopPetControl)
            return;
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
    const closeMediaFloat = useCallback(() => {
        mediaFloatWindowRef.current?.close();
    }, []);
    useEffect(() => {
        if (callState !== 'calling' && callState !== 'in-call')
            return;
        const timer = window.setInterval(() => {
            const pc = rtcPcRef.current;
            if (!pc)
                return;
            readRtcRoute(pc).then(setRtcRoute).catch(() => { });
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
            if (!result.ok)
                showToast(result.error || '保存配置失败', true);
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
        if (setupStage === 'complete')
            return;
        setVerifiedMembers(null);
        setMemberId('');
        setSetupStage('server');
    }, [setupStage]);
    const confirmIdentityChange = useCallback(async () => {
        const bridge = window.desktopPetControl;
        if (!bridge || !memberId || identityChangeTarget === memberId)
            return;
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
        if (result?.ok)
            setPersonalAudio(result.items || []);
    }, []);
    useEffect(() => {
        if (status === 'connected')
            void refreshPersonalAudio();
        else
            setPersonalAudio([]);
    }, [refreshPersonalAudio, status]);
    const uploadAudioBlob = useCallback(async (blob, name, durationMs) => {
        const result = await addPersonalAudio({ name, mime: blob.type, durationMs, data: await blob.arrayBuffer() });
        if (!result?.ok)
            return showToast(`添加音频失败：${result?.code || 'unknown'}`, true);
        await refreshPersonalAudio();
    }, [refreshPersonalAudio, showToast]);
    const importAudio = useCallback(async (file) => {
        if (!file)
            return;
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
        const chunks = [];
        const started = Date.now();
        recorder.ondataavailable = (event) => chunks.push(event.data);
        recorder.onstop = async () => {
            stream.getTracks().forEach((track) => track.stop());
            personalAudioRecorderRef.current = null;
            setRecording(false);
            await uploadAudioBlob(new Blob(chunks, { type: recorder.mimeType }), `录音 ${new Date().toLocaleString()}`, Math.min(60000, Date.now() - started));
        };
        recorder.start();
        setRecording(true);
        window.setTimeout(() => { if (recorder.state === 'recording')
            recorder.stop(); }, 60000);
        personalAudioRecorderRef.current = recorder;
    }, [uploadAudioBlob]);
    const changePetScale = useCallback(async (scale) => {
        const result = await window.desktopPetControl?.setPetScale(scale);
        if (!result)
            return;
        if (!result.ok) {
            showToast(result.error || '调整桌宠大小失败', true);
            return;
        }
        if (typeof result.scale === 'number')
            setPetScaleState(result.scale);
    }, [showToast]);
    const resetPetScale = useCallback(async () => {
        const result = await window.desktopPetControl?.resetPetScale();
        if (!result)
            return;
        if (!result.ok) {
            showToast(result.error || '恢复默认大小失败', true);
            return;
        }
        showToast('桌宠大小已恢复为 100%');
    }, [showToast]);
    const exportDiagnostics = useCallback(async () => {
        const result = await window.desktopPetControl?.exportDiagnostics();
        if (!result || result.canceled)
            return;
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
    const setupStep = setupStage === 'identity' && verifiedMembers ? 'identity' : 'server';
    useEffect(() => {
        callTargetIdRef.current = callTargetId;
    }, [callTargetId]);
    useEffect(() => {
        if (callableDevices.some((device) => device.id === callTargetId))
            return;
        const preferred = targetIds.find((id) => callableDevices.some((device) => device.id === id));
        setCallTargetId(preferred || (callableDevices.length === 1 ? callableDevices[0].id : ''));
    }, [callTargetId, callableDevices, targetIds]);
    useEffect(() => {
        if (activeView === 'call')
            syncRemoteMediaState().catch(() => { });
    }, [activeView, syncRemoteMediaState]);
    const toggleTarget = useCallback((deviceId) => {
        if (!peerMember)
            return;
        setTargetIds((current) => {
            const selected = current.includes(deviceId)
                ? current.filter((id) => id !== deviceId)
                : [...current, deviceId];
            localStorage.setItem(`${LS_TARGET_DEVICES}.${peerMember.id}`, JSON.stringify(selected));
            return selected;
        });
    }, [peerMember]);
    const onPlayPersonalAudio = useCallback(async (audioId) => {
        const results = await playPersonalAudio(audioId, targetIds);
        const succeeded = results.filter(({ result }) => result?.ok).length;
        const failed = results.length - succeeded;
        if (!succeeded)
            return showToast(results[0]?.result?.code || '发送音频失败', true);
        showToast(failed ? `已发送 ${succeeded} 台，${failed} 台失败` : `已发送到 ${succeeded} 台设备`, failed > 0);
    }, [showToast, targetIds]);
    const send = useCallback((cmd, label) => {
        if (!canSend) {
            showToast(status === 'connected' ? '桌宠端未上线' : '未连接', true);
            return;
        }
        const sent = sendCommand(cmd, targetIds);
        showToast(sent ? `${label} · 已发送到 ${sent} 台设备` : '发送失败', !sent);
    }, [canSend, showToast, status, targetIds]);
    const selectTtsMode = useCallback((mode) => {
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
        if (window.desktopPetControl)
            await window.desktopPetControl.saveTtsCredentials('');
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
        if (!text)
            return;
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
            if (!result.ok)
                throw new Error(result.code === 'peer_not_ready' ? '对方二合一客户端尚未就绪' : '无法创建通话');
        }
        catch (e) {
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
        if (!callId || screenControlPending)
            return;
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
        if (!callId || cameraControlPending)
            return;
        const enabled = !cameraDesired;
        setCameraControlPending(true);
        if (isCameraSender) {
            await setLocalCameraEnabled(enabled);
            setCameraControlPending(false);
            return;
        }
        const result = await requestMediaControl({ callId, media: 'camera', enabled });
        if (!result.ok) {
            setCameraControlPending(false);
            showToast(`摄像头控制失败：${result.code || 'unknown'}`, true);
        }
    }, [cameraControlPending, cameraDesired, isCameraSender, setLocalCameraEnabled, showToast]);
    const selectCamera = useCallback((deviceId) => {
        setSelectedCameraId(deviceId);
        if (deviceId)
            localStorage.setItem(LS_CAMERA_DEVICE, deviceId);
    }, []);
    const toggleLocalMic = useCallback(() => {
        if (callState !== 'in-call' && callState !== 'calling')
            return;
        setMicEnabled(!micEnabled);
    }, [callState, micEnabled, setMicEnabled]);
    const peerName = peerMember?.displayName || '对方';
    const selfName = selfMember?.displayName || '我';
    const callActive = callState === 'requesting-media' || callState === 'calling' || callState === 'in-call';
    const remoteCameraAvailable = !isCameraSender && cameraStatus === 'available';
    const effectivePrimary = !cameraHidden && screenStatus !== 'available' && remoteCameraAvailable
        ? 'camera'
        : !cameraHidden && preferredPrimary === 'camera' && remoteCameraAvailable ? 'camera' : 'screen';
    const mediaStage = callActive ? (_jsxs("section", { className: `video-stage-new unified-media-stage ${floatContainer ? 'detached' : ''}`, ref: videoStageRef, children: [_jsxs("div", { className: `media-surface screen-surface ${effectivePrimary === 'screen' ? 'primary' : 'inset'} ${screenStatus === 'available' ? 'available' : ''}`, children: [_jsx("video", { ref: bindScreenVideo, playsInline: true, autoPlay: true, muted: true }), screenStatus !== 'available' && _jsxs("div", { className: "surface-label", children: ["\u5C4F\u5E55", screenStatus === 'paused' ? '已暂停' : '不可用'] })] }), !cameraHidden && !isCameraSender && _jsxs("div", { className: `media-surface camera-surface ${effectivePrimary === 'camera' ? 'primary' : 'inset'} ${remoteCameraAvailable ? 'available' : ''}`, children: [_jsx("video", { ref: bindRemoteCameraVideo, playsInline: true, autoPlay: true, muted: true }), !remoteCameraAvailable && _jsx("div", { className: "surface-label", children: "\u6444\u50CF\u5934\u672A\u5F00\u542F" })] }), screenStatus !== 'available' && !remoteCameraAvailable && _jsxs("div", { className: "call-placeholder", children: [_jsx("div", { className: "pet-face small", children: "\u02F6\u1D54 \u1D55 \u1D54\u02F6" }), _jsx("strong", { children: "\u97F3\u9891\u901A\u8BDD\u4E2D" })] }), _jsxs("div", { className: "call-controls media-controls", children: [_jsx("button", { disabled: screenControlPending, onClick: () => void toggleRemoteScreen(), children: screenControlPending ? '处理中…' : screenDesired ? '停止屏幕共享' : '恢复屏幕共享' }), _jsx("button", { disabled: cameraControlPending, onClick: () => void toggleCamera(), children: cameraControlPending ? '处理中…' : cameraDesired ? '关闭摄像头' : '打开摄像头' }), !isCameraSender && remoteCameraAvailable && _jsx("button", { onClick: () => setCameraHidden((hidden) => !hidden), children: cameraHidden ? '显示摄像头' : '隐藏摄像头' }), !isCameraSender && remoteCameraAvailable && !cameraHidden && _jsx("button", { onClick: () => setPreferredPrimary((value) => value === 'screen' ? 'camera' : 'screen'), children: "\u4EA4\u6362\u753B\u9762" }), window.desktopPetControl && (floatContainer ? _jsx("button", { onClick: closeMediaFloat, children: "\u8FD4\u56DE\u63A7\u5236\u9762\u677F" }) : _jsx("button", { onClick: openMediaFloat, children: "\u7CFB\u7EDF\u6D6E\u7A97" })), !floatContainer && _jsx("button", { disabled: !remoteReady && !remoteCameraAvailable, onClick: () => void toggleFullscreen(), children: "\u5168\u5C4F" }), _jsx("button", { className: "hangup", onClick: onEndCall, children: "\u7ED3\u675F" })] })] })) : null;
    return (_jsxs("div", { className: "control-app", children: [_jsxs("aside", { className: "app-rail", "aria-label": "\u4E3B\u5BFC\u822A", children: [_jsx("div", { className: "brand-mark", "aria-hidden": "true", children: "\uD83D\uDC3E" }), [
                        ['control', '⌁', '控制'],
                        ['send', '✦', '发送'],
                        ['call', '◉', '通话'],
                    ].map(([view, icon, label]) => (_jsxs("button", { className: `rail-item ${activeView === view ? 'active' : ''}`, onClick: () => setActiveView(view), children: [_jsx("span", { "aria-hidden": "true", children: icon }), _jsx("b", { children: label }), view === 'call' && callActive && _jsx("i", {})] }, view))), _jsxs("button", { className: `rail-item settings ${activeView === 'settings' ? 'active' : ''}`, onClick: () => setActiveView('settings'), children: [_jsx("span", { "aria-hidden": "true", children: "\u2699" }), _jsx("b", { children: "\u8BBE\u7F6E" })] })] }), _jsxs("div", { className: "app-workspace", children: [_jsxs("header", { className: "app-topbar", children: [_jsxs("div", { className: "room-identity", children: [_jsx("div", { className: "room-avatar", children: "\u6211" }), _jsxs("div", { children: [_jsxs("strong", { children: [selfName, "\u548C", peerName] }), _jsx("small", { children: "\u684C\u5BA0\u8FDE\u63A5\u7A7A\u95F4" })] })] }), _jsxs("div", { className: "peer-target", children: [_jsxs("button", { className: `online-chip ${onlineDevices.length ? '' : 'offline'}`, disabled: onlineDevices.length < 2, "aria-expanded": targetMenuOpen, onClick: () => setTargetMenuOpen((open) => !open), children: [_jsx("span", { className: "status-dot" }), peerName, onlineDevices.length ? '在线' : '离线', onlineDevices.length > 1 && _jsxs("em", { children: ["\u00B7 ", onlineDevices.length, " \u53F0\u2304"] })] }), targetMenuOpen && onlineDevices.length > 1 && (_jsx("div", { className: "target-popover", children: onlineDevices.map((device) => (_jsxs("label", { className: "target-option", children: [_jsx("input", { type: "checkbox", checked: targetIds.includes(device.id), onChange: () => toggleTarget(device.id) }), _jsxs("span", { children: [_jsx("strong", { children: device.name }), _jsx("small", { children: targetIds.includes(device.id) ? '发送目标' : '在线' })] }), _jsx("i", {})] }, device.id))) }))] })] }), activeView === 'control' && (_jsxs("main", { className: "page control-page", children: [_jsxs("section", { className: "pet-hero card", children: [_jsx("div", { className: "pet-face", "aria-hidden": "true", children: "\u02F6\u1D54 \u1D55 \u1D54\u02F6" }), _jsxs("h1", { children: ["\u60F3\u8BA9", peerName, "\u7684\u684C\u5BA0\u505A\u4EC0\u4E48\uFF1F"] })] }), _jsxs("section", { className: "card action-panel", children: [_jsx("div", { className: "section-title", children: _jsx("h2", { children: "\u5FEB\u6377\u4E92\u52A8" }) }), _jsxs("div", { className: "action-grid", children: [quickMotions.map((motion) => (_jsxs("button", { className: "action-tile", disabled: !canSend, onClick: () => send({ type: 'animation', name: motion.id }, motion.label), children: [_jsx("span", { children: QUICK_MOTION_ICONS[motion.id] || '↝' }), _jsx("b", { children: motion.label }), _jsx("small", { children: "\u52A8\u4F5C" })] }, motion.id))), !quickMotions.length && _jsx("p", { className: "action-empty", children: status === 'connected' ? '桌宠未提供可用动作' : '连接桌宠后显示可用动作' })] })] }), _jsxs("aside", { className: "control-side", children: [_jsxs("section", { className: "card compact-card", children: [_jsx("h2", { children: "\u79FB\u52A8\u4F4D\u7F6E" }), _jsx("div", { className: "corner-grid", children: CORNERS.map((item) => _jsx("button", { disabled: !canSend, onClick: () => send({ type: 'relocate', corner: item.corner }, `移动到${item.label}`), children: item.label }, item.corner)) })] }), _jsxs("section", { className: "card compact-card", children: [_jsxs("h2", { children: ["\u548C", peerName, "\u901A\u8BDD"] }), _jsx("button", { className: "dark-button", onClick: () => setActiveView('call'), children: "\u6253\u5F00\u901A\u8BDD" })] }), window.desktopPetControl && _jsxs("section", { className: "card compact-card", children: [_jsxs("div", { className: "section-title", children: [_jsx("h2", { children: "\u6211\u7684\u684C\u5BA0" }), _jsxs("b", { children: [Math.round(petScale * 100), "%"] })] }), _jsx("input", { className: "scale-range", type: "range", min: "30", max: "150", step: "10", value: Math.round(petScale * 100), onChange: (event) => void changePetScale(Number(event.target.value) / 100), "aria-label": "\u8C03\u6574\u672C\u673A\u684C\u5BA0\u5927\u5C0F" })] })] })] })), activeView === 'send' && (_jsxs("main", { className: "page send-page", children: [_jsxs("div", { className: "page-heading", children: [_jsxs("h1", { children: ["\u53D1\u9001\u7ED9", peerName] }), _jsxs("div", { className: "segmented", children: [_jsx("button", { className: sendView === 'tts' ? 'active' : '', onClick: () => setSendView('tts'), children: "\u8BF4\u53E5\u8BDD" }), _jsx("button", { className: sendView === 'audio' ? 'active' : '', onClick: () => setSendView('audio'), children: "\u6211\u7684\u97F3\u9891" })] })] }), sendView === 'tts' ? (_jsx("section", { className: "card tts-compose", children: _jsxs("div", { className: "compose-main", children: [_jsx("textarea", { value: tts, maxLength: 200, onChange: (event) => setTts(event.target.value), placeholder: "\u8F93\u5165\u60F3\u8BA9\u684C\u5BA0\u8BF4\u7684\u8BDD\u2026", onKeyDown: (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                                                event.preventDefault();
                                                void onSendTts();
                                            } } }), _jsxs("div", { className: "compose-actions", children: [_jsxs("label", { children: ["\u58F0\u97F3", _jsxs("select", { value: ttsVoiceId, disabled: !ttsVoices.length, onChange: (event) => { setTtsVoiceId(event.target.value); localStorage.setItem(LS_TTS_VOICE, event.target.value); }, children: [!ttsVoices.length && _jsx("option", { value: "", children: "\u6682\u65E0\u53EF\u7528\u58F0\u97F3" }), ttsVoices.map((voice) => _jsx("option", { value: voice.id, children: voice.label }, voice.id))] })] }), _jsx("button", { className: "text-button", disabled: !ttsVoices.find((voice) => voice.id === ttsVoiceId)?.previewUrl, onClick: previewTtsVoice, children: "\u8BD5\u542C" }), _jsx("span", { className: "compose-state", children: ttsState }), _jsx("button", { className: "primary-button", disabled: !canSend || !tts.trim() || !ttsVoiceId, onClick: () => void onSendTts(), children: "\u53D1\u9001" })] })] }) })) : (_jsxs("section", { className: "card audio-library", children: [_jsxs("div", { className: "section-title", children: [_jsx("h2", { children: "\u6211\u7684\u97F3\u9891" }), _jsxs("div", { className: "button-row", children: [_jsx("button", { onClick: () => recording ? personalAudioRecorderRef.current?.stop() : void recordAudio(), children: recording ? '停止录制' : '● 录制' }), _jsxs("label", { className: "button-like", children: ["\uFF0B \u5BFC\u5165", _jsx("input", { hidden: true, type: "file", accept: "audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/webm", onChange: (event) => void importAudio(event.target.files?.[0]) })] })] })] }), _jsxs("div", { className: "audio-grid", children: [personalAudio.map((clip) => (_jsxs("article", { className: "audio-card", children: [_jsx("button", { className: "play-button", "aria-label": `试听 ${clip.name}`, onClick: async () => { const result = await getPersonalAudio(clip.id); if (result?.ok) {
                                                            const url = URL.createObjectURL(new Blob([result.data], { type: result.mime }));
                                                            const audio = new Audio(url);
                                                            audio.onended = () => URL.revokeObjectURL(url);
                                                            void audio.play();
                                                        } }, children: "\u25B6" }), editingAudioId === clip.id ? _jsx("input", { value: audioNameDraft, onChange: (event) => setAudioNameDraft(event.target.value) }) : _jsxs("div", { children: [_jsx("strong", { children: clip.name }), _jsxs("small", { children: [Math.round(clip.durationMs / 1000), " \u79D2"] })] }), _jsxs("div", { className: "audio-actions", children: [editingAudioId === clip.id ? _jsx("button", { onClick: async () => { if (audioNameDraft.trim())
                                                                    await renamePersonalAudio(clip.id, audioNameDraft.trim()); setEditingAudioId(null); await refreshPersonalAudio(); }, children: "\u4FDD\u5B58" }) : _jsx("button", { onClick: () => { setEditingAudioId(clip.id); setAudioNameDraft(clip.name); }, children: "\u91CD\u547D\u540D" }), _jsx("button", { disabled: !canSend, onClick: () => void onPlayPersonalAudio(clip.id), children: "\u53D1\u9001" }), deleteAudioId === clip.id ? _jsxs(_Fragment, { children: [_jsx("button", { className: "danger", onClick: async () => { await deletePersonalAudio(clip.id); setDeleteAudioId(null); await refreshPersonalAudio(); }, children: "\u786E\u8BA4\u5220\u9664" }), _jsx("button", { onClick: () => setDeleteAudioId(null), children: "\u53D6\u6D88" })] }) : _jsx("button", { onClick: () => setDeleteAudioId(clip.id), children: "\u5220\u9664" })] })] }, clip.id))), !personalAudio.length && _jsx("button", { className: "audio-empty", onClick: () => void recordAudio(), children: "\uFF0B \u6DFB\u52A0\u7B2C\u4E00\u6BB5\u97F3\u9891" })] })] }))] })), activeView === 'call' && (_jsxs("main", { className: `page call-page ${callActive ? 'active-call' : ''}`, children: [_jsx("audio", { ref: remoteMicAudioRef, autoPlay: true, muted: remoteMicMuted }), _jsx("audio", { ref: remoteSystemAudioRef, autoPlay: true, muted: remoteSystemMuted }), callActive ? (_jsxs(_Fragment, { children: [!floatContainer && mediaStage, _jsxs("aside", { className: "call-sidebar", children: [_jsxs("section", { className: "card", children: [_jsxs("h2", { children: ["\u6B63\u5728\u548C", peerName, "\u901A\u8BDD"] }), _jsx("p", { children: callState === 'in-call' ? '已连接' : '连接中…' })] }), _jsxs("section", { className: "card", children: [_jsx("h2", { children: "\u901A\u8BDD\u63A7\u5236" }), _jsxs("label", { children: ["\u6211\u7684\u9EA6\u514B\u98CE", _jsx("input", { type: "checkbox", checked: micEnabled, onChange: toggleLocalMic })] }), _jsxs("label", { children: ["\u5BF9\u65B9\u7CFB\u7EDF\u58F0\u97F3", _jsx("input", { type: "checkbox", checked: !remoteSystemMuted, onChange: () => void toggleRemoteAudio('system') })] }), _jsxs("label", { children: ["\u5BF9\u65B9\u9EA6\u514B\u98CE", _jsx("input", { type: "checkbox", checked: !remoteMicMuted, onChange: () => void toggleRemoteAudio('mic') })] })] }), isCameraSender && _jsxs("section", { className: "card camera-preview-card", children: [_jsxs("div", { className: "section-title", children: [_jsx("h2", { children: "\u6211\u7684\u6444\u50CF\u5934" }), _jsx("button", { onClick: () => setCameraPreviewCollapsed((value) => !value), children: cameraPreviewCollapsed ? '展开预览' : '收起预览' })] }), !cameraPreviewCollapsed && _jsx("video", { ref: bindLocalCameraVideo, autoPlay: true, muted: true, playsInline: true }), cameraDevices.length > 0 && _jsx("select", { "aria-label": "\u9009\u62E9\u6444\u50CF\u5934", value: selectedCameraId, onChange: (event) => selectCamera(event.target.value), children: cameraDevices.map((device, index) => _jsx("option", { value: device.deviceId, children: device.label || `摄像头 ${index + 1}` }, device.deviceId)) }), _jsx("button", { disabled: cameraControlPending, onClick: () => void toggleCamera(), children: cameraDesired ? '关闭并释放摄像头' : '打开摄像头' }), _jsx("small", { children: "\u6536\u8D77\u9884\u89C8\u4E0D\u4F1A\u505C\u6B62\u53D1\u9001\uFF1B\u5173\u95ED\u4F1A\u771F\u6B63\u91CA\u653E\u786C\u4EF6\u3002" })] }), _jsxs("section", { className: "card connection-quality", children: [_jsx("span", { className: "status-dot" }), rtcRoute.relayed ? '仅音频连接' : rtcRoute.candidateType === 'failed' ? '连接恢复中' : '连接稳定'] })] })] })) : (_jsxs("section", { className: "card call-idle", children: [_jsx("div", { className: "pet-face", children: "\u02F6\u1D54 \u1D55 \u1D54\u02F6" }), _jsxs("h1", { children: ["\u548C", peerName, "\u901A\u8BDD"] }), callableDevices.length > 1 && _jsx("div", { className: "call-device-list", children: callableDevices.map((device) => _jsxs("label", { children: [_jsx("input", { type: "radio", name: "call-target", checked: callTargetId === device.id, onChange: () => setCallTargetId(device.id) }), device.name] }, device.id)) }), _jsx("button", { className: "primary-button large", disabled: !canCall, onClick: () => void onStartCall(), children: "\u5F00\u59CB\u901A\u8BDD" })] }))] })), activeView === 'settings' && (_jsxs("main", { className: "page settings-page", children: [_jsx("div", { className: "page-heading", children: _jsx("h1", { children: "\u8BBE\u7F6E" }) }), setupRequired ? (_jsxs("section", { className: "card settings-section setup-card", children: [_jsx("p", { className: "setup-step", children: setupStep === 'server' ? '第 1 步，共 2 步' : '第 2 步，共 2 步' }), _jsx("h2", { children: setupStep === 'server' ? '连接你的服务器' : '选择你的身份' }), setupStep === 'server' ? _jsxs(_Fragment, { children: [_jsx("p", { className: "settings-hint", children: "\u5148\u9A8C\u8BC1\u670D\u52A1\u5668\u5730\u5740\u548C\u5BC6\u94A5\uFF0C\u518D\u9009\u62E9\u8EAB\u4EFD\u3002" }), _jsxs("div", { className: "form-grid", children: [_jsxs("label", { children: ["\u670D\u52A1\u5668\u5730\u5740", _jsx("input", { value: serverUrl, onChange: (event) => { setServerUrl(event.target.value); resetPairingVerification(); }, placeholder: "https://pet.example.com" })] }), _jsxs("label", { children: ["\u670D\u52A1\u5668\u5BC6\u94A5", _jsx("input", { type: "password", value: secret, onChange: (event) => { setSecret(event.target.value); resetPairingVerification(); }, placeholder: "\u8F93\u5165\u670D\u52A1\u5668\u5BC6\u94A5" })] })] }), _jsx("div", { className: "settings-actions", children: _jsx("button", { className: "primary-button", disabled: verifyingPairing || !serverUrl.trim() || !secret.trim(), onClick: () => void verifyPairing(), children: verifyingPairing ? '验证中…' : '验证并继续' }) })] }) : _jsxs(_Fragment, { children: [_jsx("p", { className: "settings-hint", children: "\u8BF7\u9009\u62E9\u8FD9\u53F0\u8BBE\u5907\u5C5E\u4E8E\u8C01\uFF1B\u5207\u6362\u8EAB\u4EFD\u540E\u4ECD\u53EF\u5728\u8BBE\u7F6E\u4E2D\u66F4\u6539\u3002" }), _jsxs("div", { className: "form-grid", children: [_jsxs("label", { children: ["\u6211\u7684\u8EAB\u4EFD", _jsxs("select", { value: memberId, onChange: (event) => setMemberId(event.target.value), children: [_jsx("option", { value: "", children: "\u8BF7\u9009\u62E9\u8EAB\u4EFD" }), verifiedMembers?.map((member) => _jsx("option", { value: member.id, children: member.displayName }, member.id))] })] }), _jsxs("label", { children: ["\u8BBE\u5907\u540D\u79F0", _jsx("input", { value: deviceName, onChange: (event) => setDeviceName(event.target.value) })] })] }), _jsxs("div", { className: "settings-actions", children: [_jsx("button", { onClick: () => { setSetupStage('server'); setMemberId(''); }, children: "\u4E0A\u4E00\u6B65" }), _jsx("button", { className: "primary-button", disabled: !memberId || !deviceName.trim(), onClick: () => void onConnect(), children: "\u4FDD\u5B58\u5E76\u8FDE\u63A5" })] })] })] })) : _jsxs(_Fragment, { children: [_jsxs("section", { className: "card settings-section", children: [_jsx("h2", { children: "\u8FDE\u63A5" }), _jsxs("div", { className: "form-grid", children: [_jsxs("label", { children: ["\u670D\u52A1\u5668", _jsx("input", { value: serverUrl, onChange: (event) => setServerUrl(event.target.value), disabled: status === 'connecting' || status === 'connected' })] }), _jsxs("label", { children: ["\u623F\u95F4\u5BC6\u94A5", _jsx("input", { type: "password", value: secret, onChange: (event) => setSecret(event.target.value), disabled: status === 'connecting' || status === 'connected' })] }), _jsxs("label", { children: ["\u5F53\u524D\u8EAB\u4EFD", _jsx("strong", { className: "identity-summary", children: memberId ? knownMemberNames[memberId] : '未选择' }), window.desktopPetControl && _jsx("button", { disabled: status !== 'connected', onClick: () => { if (memberId) {
                                                                    setIdentityChangeTarget(memberId === 'a' ? 'b' : 'a');
                                                                    setIdentityChangeOpen(true);
                                                                } }, children: "\u66F4\u6539\u8EAB\u4EFD" })] }), _jsxs("label", { children: ["\u8BBE\u5907\u540D\u79F0", _jsx("input", { value: deviceName, onChange: (event) => setDeviceName(event.target.value), disabled: status === 'connecting' || status === 'connected' })] })] }), identityChangeOpen && _jsxs("div", { className: "identity-change", children: [_jsx("strong", { children: "\u66F4\u6539\u8EAB\u4EFD\u4F1A\u8BA9\u684C\u5BA0\u548C\u63A7\u5236\u7AEF\u77ED\u6682\u91CD\u65B0\u8FDE\u63A5\u3002" }), _jsxs("select", { value: identityChangeTarget, onChange: (event) => setIdentityChangeTarget(event.target.value), children: [_jsx("option", { value: "a", children: knownMemberNames.a }), _jsx("option", { value: "b", children: knownMemberNames.b })] }), _jsx("button", { className: "primary-button", disabled: identityChanging || identityChangeTarget === memberId, onClick: () => void confirmIdentityChange(), children: identityChanging ? '正在更改…' : '确认并重新连接' }), _jsx("button", { disabled: identityChanging, onClick: () => setIdentityChangeOpen(false), children: "\u53D6\u6D88" })] }), _jsxs("div", { className: "settings-actions", children: [_jsx(StatusPill, { status: status }), status === 'connected' || status === 'connecting' ? _jsx("button", { onClick: onDisconnect, children: "\u65AD\u5F00" }) : _jsx("button", { className: "primary-button", disabled: !serverUrl.trim() || !secret.trim() || !memberId || !deviceName.trim(), onClick: () => void onConnect(), children: "\u8FDE\u63A5" })] })] }), _jsxs("section", { className: "card settings-section", children: [_jsx("h2", { children: "\u6210\u5458\u540D\u79F0" }), peers.members.map((member) => _jsxs("div", { className: "member-row", children: [_jsx("span", { children: member.id === peers.self.memberId ? '我' : '对方' }), editingMemberId === member.id ? _jsxs(_Fragment, { children: [_jsx("input", { value: memberNameDraft, onChange: (event) => setMemberNameDraft(event.target.value) }), _jsx("button", { onClick: async () => { if (memberNameDraft.trim())
                                                                    await renameMember(member.id, memberNameDraft.trim()); setEditingMemberId(null); }, children: "\u4FDD\u5B58" }), _jsx("button", { onClick: () => setEditingMemberId(null), children: "\u53D6\u6D88" })] }) : _jsxs(_Fragment, { children: [_jsx("strong", { children: member.displayName }), _jsx("button", { onClick: () => { setEditingMemberId(member.id); setMemberNameDraft(member.displayName); }, children: "\u4FEE\u6539" })] })] }, member.id))] }), _jsxs("section", { className: "card settings-section", children: [_jsx("h2", { children: "\u8BBE\u5907" }), peers.members.map((member) => _jsxs("div", { className: "device-group", children: [_jsx("h3", { children: member.displayName }), member.devices.map((device) => _jsxs("div", { className: "device-row", children: [_jsx("span", { className: `device-signal ${device.petOnline ? 'online' : ''}` }), _jsxs("div", { children: [_jsxs("strong", { children: [device.name, device.id === peers.self.deviceId ? ' · 本机' : ''] }), _jsxs("small", { children: ["\u684C\u5BA0", device.petOnline ? '在线' : '离线', " \u00B7 \u63A7\u5236\u7AEF", device.controllerOnline ? '在线' : '离线', " \u00B7 ", new Date(device.lastSeenAt).toLocaleString()] })] }), member.id === peers.self.memberId && device.id !== peers.self.deviceId && !device.petOnline && !device.controllerOnline && (reclaimCandidate?.id === device.id ? _jsxs("span", { className: "inline-confirm", children: [_jsx("button", { onClick: async () => { await reclaimDevice(device.id, device.name); setReclaimCandidate(null); }, children: "\u786E\u8BA4\u8BA4\u9886" }), _jsx("button", { onClick: () => setReclaimCandidate(null), children: "\u53D6\u6D88" })] }) : _jsx("button", { onClick: () => setReclaimCandidate(device), children: "\u8BA4\u9886\u4E3A\u672C\u673A" }))] }, device.id))] }, member.id))] }), window.desktopPetControl && _jsxs("section", { className: "card settings-section", children: [_jsx("h2", { children: "\u672C\u673A\u684C\u5BA0" }), _jsxs("div", { className: "scale-settings", children: [_jsx("input", { className: "scale-range", type: "range", min: "30", max: "150", step: "10", value: Math.round(petScale * 100), onChange: (event) => void changePetScale(Number(event.target.value) / 100) }), _jsxs("strong", { children: [Math.round(petScale * 100), "%"] })] }), _jsxs("div", { className: "button-row", children: [_jsx("button", { onClick: () => void resetPetScale(), children: "\u6062\u590D\u9ED8\u8BA4" }), _jsx("button", { onClick: () => void exportDiagnostics(), children: "\u5BFC\u51FA\u8BCA\u65AD\u65E5\u5FD7" })] })] }), _jsxs("section", { className: "card settings-section", children: [_jsx("h2", { children: "\u8BED\u97F3\u670D\u52A1" }), _jsxs("div", { className: "button-row", children: [_jsx("button", { className: ttsMode === 'managed' ? 'selected' : '', onClick: () => selectTtsMode('managed'), children: "\u670D\u52A1\u7AEF\u58F0\u97F3" }), ttsProvider === 'elevenlabs' && _jsx("button", { className: ttsMode === 'byok' ? 'selected' : '', onClick: () => selectTtsMode('byok'), children: "\u6211\u7684 API Key" })] }), ttsMode === 'byok' && _jsxs("div", { className: "key-row", children: [_jsx("input", { type: "password", value: ttsApiKeyInput, onChange: (event) => setTtsApiKeyInput(event.target.value), placeholder: ttsKeyConfigured ? '已配置，输入新 Key 可替换' : 'ElevenLabs API Key' }), _jsx("button", { onClick: () => void saveByokKey(), children: "\u4FDD\u5B58" }), ttsKeyConfigured && _jsx("button", { className: "danger", onClick: () => void clearByokKey(), children: "\u5220\u9664 Key" })] })] })] })] }))] }), floatContainer && mediaStage && createPortal(mediaStage, floatContainer), _jsx("div", { className: `toast-new ${toast ? 'show' : ''} ${toast?.err ? 'error' : ''}`, children: toast?.msg })] }));
}
function StatusPill({ status }) {
    const map = {
        idle: { cls: '', text: '未连接' },
        connecting: { cls: 'warn', text: '连接中…' },
        connected: { cls: 'ok', text: '已连接' },
        disconnected: { cls: 'bad', text: '断开' },
        rejected: { cls: 'bad', text: '被拒绝' },
    };
    const m = map[status];
    return _jsxs("span", { className: `pill ${m.cls}`, children: [_jsx("span", { className: "dot" }), " ", m.text] });
}
