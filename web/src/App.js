import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { connect, disconnect, listMotions, listTtsVoices, createTts, endCall, requestCall, requestRtcConfig, sendCommand, sendSignal, setListeners, setTargetDevice, setTtsCredentials, addPersonalAudio, deletePersonalAudio, listPersonalAudio, playPersonalAudio, renamePersonalAudio, getPersonalAudio, renameMember, reclaimDevice, } from './api';
const LS_SERVER = 'pet.serverUrl';
const LS_SECRET = 'pet.secret';
const LS_PARTICIPANT = 'pet.participantId';
const LS_TARGET_DEVICE = 'pet.targetDeviceId';
const LS_TTS_MODE = 'pet.ttsMode';
const LS_TTS_VOICE = 'pet.ttsVoiceId';
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
const EXPRESSIONS = [
    { name: 'joy', label: '开心' },
    { name: 'surprised', label: '吃惊' },
    { name: 'sorrow', label: '委屈' },
    { name: 'angry', label: '生气' },
    { name: 'blink', label: '眨眼' },
    { name: 'neutral', label: '平静' },
];
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
    const [memberId, setMemberId] = useState('a');
    const [deviceName, setDeviceName] = useState('浏览器');
    const [targetId, setTargetId] = useState(() => localStorage.getItem(LS_TARGET_DEVICE) || '');
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
    const [remoteTrackSummary, setRemoteTrackSummary] = useState('无');
    const [rtcRoute, setRtcRoute] = useState(EMPTY_RTC_ROUTE);
    const toastTimer = useRef(null);
    const remoteVideoRef = useRef(null);
    const remoteMicAudioRef = useRef(null);
    const remoteSystemAudioRef = useRef(null);
    const videoStageRef = useRef(null);
    const remoteVideoStreamRef = useRef(null);
    const remoteMicStreamRef = useRef(null);
    const remoteSystemStreamRef = useRef(null);
    const rtcPcRef = useRef(null);
    const localAudioRef = useRef(null);
    const pendingCandidatesRef = useRef([]);
    const currentCallIdRef = useRef(null);
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
        if (remoteVideoRef.current)
            remoteVideoRef.current.srcObject = null;
        if (remoteMicAudioRef.current)
            remoteMicAudioRef.current.srcObject = null;
        if (remoteSystemAudioRef.current)
            remoteSystemAudioRef.current.srcObject = null;
    }, [setMicEnabled, stopLocalAudio]);
    const sendRtcSignal = useCallback((signal) => {
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
                const devices = next.members.find((member) => member.id !== next.self.memberId)?.devices || [];
                setTargetId((current) => {
                    const onlineDevices = devices.filter((device) => device.petOnline);
                    const selected = current || (onlineDevices.length === 1 ? onlineDevices[0].id : '');
                    if (selected)
                        localStorage.setItem(LS_TARGET_DEVICE, selected);
                    setTargetDevice(selected);
                    return selected;
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
                    setRemoteReady(payload.state === 'available' && !!remoteVideoStreamRef.current?.getVideoTracks().length);
                    if (payload.reason === 'relay_audio_only')
                        showToast('当前走 TURN：已停用画面，仅保留音频');
                    if (payload.reason === 'capture_failed')
                        showToast('对方屏幕采集失败，音频仍可继续', true);
                    if (payload.reason === 'track_ended')
                        showToast('对方已停止屏幕共享，音频仍可继续');
                }
            },
            onCallStart: (callId) => {
                beginMediaCall(callId).catch((e) => {
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
    }, [beginMediaCall, handleSignal, showToast, teardownCall]);
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
            if (nextServer && nextSecret && nextParticipant && config.memberId && config.deviceName)
                connect(nextServer, nextSecret, { memberId: config.memberId, deviceId: nextParticipant, deviceName: config.deviceName });
            else
                disconnect();
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
        listMotions().then((items) => {
            setMotions(items);
        });
    }, [status, peers.peerPetOnline, showToast, teardownCall]);
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
    }, [deviceName, memberId, participantId, secret, serverUrl, showToast]);
    const onDisconnect = useCallback(() => {
        teardownCall({ sendRemoteHangup: true, nextState: 'idle' });
        disconnect();
    }, [teardownCall]);
    const refreshPersonalAudio = useCallback(async () => {
        const result = await listPersonalAudio();
        if (result?.ok)
            setPersonalAudio(result.items || []);
    }, []);
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
            setRecording(false);
            await uploadAudioBlob(new Blob(chunks, { type: recorder.mimeType }), `录音 ${new Date().toLocaleString()}`, Math.min(60000, Date.now() - started));
        };
        recorder.start();
        setRecording(true);
        window.setTimeout(() => { if (recorder.state === 'recording')
            recorder.stop(); }, 60000);
        window.__personalAudioRecorder = recorder;
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
    const selectedDevice = peers.members.flatMap((member) => member.devices).find((device) => device.id === targetId);
    const canSend = status === 'connected' && !!selectedDevice?.petOnline;
    const canCall = canSend && !!selectedDevice?.controllerOnline;
    const send = useCallback((cmd, label) => {
        if (!canSend) {
            showToast(status === 'connected' ? '桌宠端未上线' : '未连接', true);
            return;
        }
        const ok = sendCommand(cmd);
        showToast(ok ? `✔ ${label}` : '发送失败', !ok);
    }, [canSend, showToast, status]);
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
            if (!result.ok)
                throw new Error(result.code === 'peer_not_ready' ? '对方二合一客户端尚未就绪' : '无法创建通话');
        }
        catch (e) {
            console.warn('[webrtc] startCall failed:', e);
            showToast(`开通话失败：${e?.message || e}`, true);
            teardownCall({ nextState: 'error' });
        }
    }, [canCall, showToast, teardownCall]);
    const onEndCall = useCallback(() => {
        teardownCall({ sendRemoteHangup: true, nextState: 'idle' });
    }, [teardownCall]);
    const toggleLocalMic = useCallback(() => {
        if (callState !== 'in-call' && callState !== 'calling')
            return;
        setMicEnabled(!micEnabled);
    }, [callState, micEnabled, setMicEnabled]);
    return (_jsxs("div", { className: "app", children: [_jsxs("header", { className: "hero", children: [_jsxs("div", { children: [_jsx("p", { className: "eyebrow", children: "REMOTE CONSOLE" }), _jsx("h1", { children: "\u684C\u5BA0\u8FDC\u7A0B\u63A7\u5236\u53F0" }), _jsx("p", { className: "hero-copy", children: "\u9ED1\u767D\u84DD\u4E3B\u754C\u9762\uFF0C\u4F18\u5148\u628A\u5C4F\u5E55\u3001\u901A\u8BDD\u548C\u63A7\u5236\u52A8\u4F5C\u653E\u5230\u4E00\u5C4F\u5185\u3002" })] }), _jsxs("div", { className: "hero-badge", children: [_jsx("span", { className: `signal ${peers.peerOnline ? 'on' : ''}` }), _jsx("span", { children: peers.peerOnline ? '对方在线' : '等待对方' })] })] }), _jsxs("section", { className: "section", children: [_jsx("h2", { children: "\u6210\u5458\u4E0E\u8BBE\u5907" }), peers.members.map((member) => (_jsxs("div", { children: [_jsxs("div", { className: "status-row", children: [_jsxs("strong", { children: [member.displayName, member.id === peers.self.memberId ? '（我）' : ''] }), _jsx("button", { className: "btn", onClick: async () => { const name = prompt('成员名称', member.displayName); if (name)
                                            await renameMember(member.id, name); }, children: "\u4FEE\u6539\u540D\u79F0" })] }), member.devices.map((device) => _jsxs("div", { className: "empty", children: [device.name, " \u00B7 \u684C\u5BA0", device.petOnline ? '在线' : '离线', " \u00B7 \u63A7\u5236\u7AEF", device.controllerOnline ? '在线' : '离线', " \u00B7 \u6700\u8FD1\u8FDE\u63A5 ", new Date(device.lastSeenAt).toLocaleString(), member.id === peers.self.memberId && device.id !== peers.self.deviceId && !device.petOnline && !device.controllerOnline && _jsx("button", { className: "btn", onClick: async () => { if (confirm(`将当前设备认领为“${device.name}”？`))
                                            await reclaimDevice(device.id, device.name); }, children: "\u8BA4\u9886\u4E3A\u5F53\u524D\u8BBE\u5907" })] }, device.id))] }, member.id)))] }), _jsxs("div", { className: "status-bar", children: [_jsxs("div", { className: "status-row", children: [_jsx("label", { children: "\u76EE\u6807\u8BBE\u5907" }), _jsxs("select", { value: targetId, onChange: (event) => {
                                    const selected = event.target.value;
                                    setTargetId(selected);
                                    setTargetDevice(selected);
                                    if (selected)
                                        localStorage.setItem(LS_TARGET_DEVICE, selected);
                                    else
                                        localStorage.removeItem(LS_TARGET_DEVICE);
                                }, children: [_jsx("option", { value: "", children: "\u8BF7\u9009\u62E9\u5BF9\u65B9\u8BBE\u5907" }), peers.members.find((member) => member.id !== peers.self.memberId)?.devices.map((device) => (_jsxs("option", { value: device.id, children: [device.name, " \u00B7 \u684C\u5BA0", device.petOnline ? '在线' : '离线', " / \u63A7\u5236\u7AEF", device.controllerOnline ? '在线' : '离线'] }, device.id)))] })] }), _jsxs("div", { className: "status-row", children: [_jsx("label", { children: "\u670D\u52A1\u5668" }), _jsx("input", { value: serverUrl, onChange: (e) => setServerUrl(e.target.value), placeholder: "http://localhost:3030", disabled: status === 'connecting' || status === 'connected' })] }), _jsxs("div", { className: "status-row", children: [_jsx("label", { children: "\u623F\u95F4\u5BC6\u94A5" }), _jsx("input", { type: "password", value: secret, onChange: (e) => setSecret(e.target.value), placeholder: "ROOM_SECRET", disabled: status === 'connecting' || status === 'connected' })] }), _jsxs("div", { className: "status-row", children: [_jsx(StatusPill, { status: status }), _jsx(PeerPill, { role: "pet", online: peers.peerPetOnline }), !window.desktopPetControl && !peers.selfReady && _jsx("span", { className: "hint", children: "\u6D4F\u89C8\u5668\u6A21\u5F0F\uFF1A\u4EC5\u63A7\u5236\u7AEF\u5728\u7EBF" }), _jsx("div", { style: { flex: 1 } }), status === 'connected' || status === 'connecting' ? (_jsx("button", { className: "btn", onClick: onDisconnect, children: "\u65AD\u5F00" })) : (_jsx("button", { className: "btn accent", onClick: onConnect, children: "\u8FDE\u63A5" }))] }), window.desktopPetControl && (_jsxs("div", { className: "pet-settings", children: [_jsxs("div", { className: "pet-settings-head", children: [_jsx("span", { children: "\u672C\u673A\u684C\u5BA0\u5927\u5C0F" }), _jsxs("strong", { children: [Math.round(petScale * 100), "%"] })] }), _jsx("input", { className: "pet-scale-range", type: "range", min: "30", max: "150", step: "10", value: Math.round(petScale * 100), onChange: (event) => void changePetScale(Number(event.target.value) / 100), "aria-label": "\u8C03\u6574\u672C\u673A\u684C\u5BA0\u5927\u5C0F" }), _jsxs("div", { className: "pet-settings-actions", children: [_jsx("button", { className: "btn", onClick: () => void resetPetScale(), children: "\u6062\u590D\u9ED8\u8BA4\u5927\u5C0F" }), _jsx("button", { className: "btn", onClick: () => void exportDiagnostics(), children: "\u5BFC\u51FA\u8BCA\u65AD\u65E5\u5FD7" })] }), _jsx("span", { className: "hint", children: "\u7F29\u653E\u5F02\u5E38\u65F6\u5BFC\u51FA\u65E5\u5FD7\uFF1B\u4E0D\u4F1A\u5305\u542B\u623F\u95F4\u5BC6\u94A5\u3001API Key \u6216\u97F3\u9891\u3002" })] }))] }), _jsxs("section", { className: "section", children: [_jsx("h2", { children: "\u901A\u8BDD" }), _jsx("audio", { ref: remoteMicAudioRef, autoPlay: true, muted: remoteMicMuted }), _jsx("audio", { ref: remoteSystemAudioRef, autoPlay: true, muted: remoteSystemMuted }), _jsxs("div", { className: "video-stage", ref: videoStageRef, children: [_jsx("video", { ref: remoteVideoRef, className: `video-frame ${remoteReady ? 'ready' : ''}`, playsInline: true, autoPlay: true }), !remoteReady && (_jsx("div", { className: "video-empty", children: screenStatus === 'paused' ? '当前网络通过 TURN 中继，仅保留音频。' : callState === 'calling' || callState === 'requesting-media'
                                    ? '正在等桌宠把屏幕推过来。\n如果一直没画面，先去 B 端确认屏幕录制权限。'
                                    : '点“开始通话”后，这里会显示她的屏幕。' })), _jsx("button", { type: "button", className: "video-fullscreen", disabled: !remoteReady, onClick: toggleFullscreen, "aria-label": "\u5207\u6362\u89C6\u9891\u5168\u5C4F", children: "\u5168\u5C4F" })] }), _jsxs("div", { className: "video-meta", children: [_jsx("span", { children: remoteReady ? '已收到桌面视频流' : '尚未收到视频流' }), _jsxs("span", { children: ["\u8FDC\u7AEF\u8F68\u9053\uFF1A", remoteTrackSummary] }), _jsxs("span", { children: ["\u9EA6\u514B\u98CE\uFF1A", remoteMicMuted ? '静音' : '播放'] }), _jsxs("span", { children: ["\u7CFB\u7EDF\u58F0\u97F3\uFF1A", remoteSystemMuted ? '静音' : '播放'] })] }), _jsxs("div", { className: `rtc-route ${rtcRoute.candidateType}`, children: [_jsxs("span", { children: ["\u8DEF\u5F84\uFF1A", rtcRoute.path, "\uFF08ICE ", rtcRoute.candidateType, "\uFF09"] }), _jsx("span", { children: rtcRoute.relayed ? '正在走 TURN 中继：仅音频，屏幕视频已暂停' : '点对点连接，不走本项目服务器媒体带宽' }), _jsx("span", { children: rtcRoute.detail })] }), _jsxs("div", { className: "call-row", children: [_jsx(CallPill, { state: callState }), _jsx("button", { className: "btn accent", disabled: !canCall || callState === 'calling' || callState === 'requesting-media' || callState === 'in-call', onClick: onStartCall, children: "\u5F00\u59CB\u901A\u8BDD" }), _jsx("button", { className: "btn", disabled: callState !== 'calling' && callState !== 'in-call', onClick: onEndCall, children: "\u7ED3\u675F\u901A\u8BDD" }), _jsx("button", { className: `btn ${micEnabled ? 'accent' : ''}`, disabled: callState !== 'calling' && callState !== 'in-call', onClick: toggleLocalMic, children: micEnabled ? '关闭麦克风' : '打开麦克风' }), _jsx("button", { className: "btn", disabled: callState !== 'calling' && callState !== 'in-call', onClick: () => toggleRemoteAudio('mic'), children: remoteMicMuted ? '播放麦克风' : '静音麦克风' }), _jsx("button", { className: "btn", disabled: callState !== 'calling' && callState !== 'in-call', onClick: () => toggleRemoteAudio('system'), children: remoteSystemMuted ? '播放系统声音' : '静音系统声音' })] })] }), _jsxs("section", { className: "section", children: [_jsx("h2", { children: "\u8868\u60C5" }), _jsx("div", { className: "grid tight", children: EXPRESSIONS.map((e) => (_jsx("button", { className: "btn", disabled: !canSend, onClick: () => send({ type: 'expression', name: e.name }, e.label), children: e.label }, e.name))) }), _jsx("h3", { children: "\u52A8\u4F5C" }), _jsxs("div", { className: "grid tight", children: [_jsx("button", { className: "btn", disabled: !canSend, onClick: () => send({ type: 'animation', name: 'idle' }, '默认动作'), children: "\u9ED8\u8BA4\u52A8\u4F5C" }), motions.filter((m) => m.id !== 'idle').map((m) => (_jsx("button", { className: "btn", disabled: !canSend, onClick: () => send({ type: 'animation', name: m.id }, m.label), children: m.label }, m.id)))] }), motions.length === 0 && (_jsx("div", { className: "empty", children: canSend ? '当前模型还没配置额外动作；默认动作仍可使用' : '连上后会显示额外动作' }))] }), _jsxs("section", { className: "section", children: [_jsx("h2", { children: "\u6211\u7684\u97F3\u9891" }), _jsxs("div", { className: "grid tight", children: [_jsxs("label", { className: "btn", children: ["\u5BFC\u5165\u97F3\u9891", _jsx("input", { hidden: true, type: "file", accept: "audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/webm", onChange: (event) => void importAudio(event.target.files?.[0]) })] }), _jsx("button", { className: "btn", onClick: () => recording ? window.__personalAudioRecorder?.stop() : void recordAudio(), children: recording ? '停止录音' : '开始录音' }), _jsx("button", { className: "btn", onClick: () => void refreshPersonalAudio(), children: "\u5237\u65B0" })] }), personalAudio.length === 0 ? _jsx("div", { className: "empty", children: "\u8FD9\u91CC\u53EA\u663E\u793A\u4F60\u81EA\u5DF1\u5F55\u5236\u6216\u5BFC\u5165\u7684\u97F3\u9891" }) : personalAudio.map((clip) => (_jsxs("div", { className: "status-row", children: [_jsxs("span", { children: [clip.name, " \u00B7 ", Math.round(clip.durationMs / 1000), " \u79D2"] }), _jsx("button", { className: "btn", onClick: async () => { const result = await getPersonalAudio(clip.id); if (result?.ok) {
                                    const url = URL.createObjectURL(new Blob([result.data], { type: result.mime }));
                                    const audio = new Audio(url);
                                    audio.onended = () => URL.revokeObjectURL(url);
                                    void audio.play();
                                } }, children: "\u8BD5\u542C" }), _jsx("button", { className: "btn", disabled: !canSend, onClick: () => void playPersonalAudio(clip.id), children: "\u53D1\u9001" }), _jsx("button", { className: "btn", onClick: async () => { const name = prompt('新名称', clip.name); if (name) {
                                    await renamePersonalAudio(clip.id, name);
                                    await refreshPersonalAudio();
                                } }, children: "\u91CD\u547D\u540D" }), _jsx("button", { className: "btn", onClick: async () => { await deletePersonalAudio(clip.id); await refreshPersonalAudio(); }, children: "\u5220\u9664" })] }, clip.id)))] }), _jsxs("section", { className: "section", children: [_jsxs("h2", { children: ["\u8BED\u97F3\u6D88\u606F \u00B7 ", ttsProvider === 'cosyvoice' ? 'CosyVoice' : 'ElevenLabs'] }), _jsxs("div", { className: "tts-area", children: [_jsxs("div", { className: "tts-mode-row", children: [_jsx("button", { className: `btn ${ttsMode === 'managed' ? 'accent' : ''}`, onClick: () => selectTtsMode('managed'), children: "\u670D\u52A1\u7AEF\u58F0\u97F3" }), ttsProvider === 'elevenlabs' && _jsx("button", { className: `btn ${ttsMode === 'byok' ? 'accent' : ''}`, onClick: () => selectTtsMode('byok'), children: "\u4F7F\u7528\u6211\u7684 API Key" }), _jsx("span", { className: "tts-hint", children: "\u53D1\u9001\u540E\u7531\u5BF9\u65B9\u684C\u5BA0\u7528\u4F60\u7684\u514B\u9686\u58F0\u97F3\u64AD\u653E" })] }), ttsMode === 'byok' && (_jsxs("div", { className: "tts-key-row", children: [_jsx("input", { type: "password", value: ttsApiKeyInput, onChange: (event) => setTtsApiKeyInput(event.target.value), placeholder: ttsKeyConfigured ? 'API Key 已安全保存，输入新 Key 可替换' : 'ElevenLabs API Key', autoComplete: "off" }), _jsx("button", { className: "btn", disabled: !ttsApiKeyInput.trim(), onClick: saveByokKey, children: "\u9A8C\u8BC1\u5E76\u4FDD\u5B58" }), ttsKeyConfigured && _jsx("button", { className: "btn danger", onClick: clearByokKey, children: "\u5220\u9664 Key" })] })), _jsxs("div", { className: "tts-voice-row", children: [_jsx("label", { htmlFor: "tts-voice", children: "\u6211\u7684\u58F0\u97F3" }), _jsxs("select", { id: "tts-voice", value: ttsVoiceId, disabled: status !== 'connected' || !ttsVoices.length, onChange: (event) => {
                                            setTtsVoiceId(event.target.value);
                                            localStorage.setItem(LS_TTS_VOICE, event.target.value);
                                        }, children: [!ttsVoices.length && _jsx("option", { value: "", children: "\u6682\u65E0\u53EF\u7528\u58F0\u97F3" }), ttsVoices.map((voice) => _jsx("option", { value: voice.id, children: voice.label }, voice.id))] }), _jsx("button", { className: "btn", disabled: !ttsVoices.find((voice) => voice.id === ttsVoiceId)?.previewUrl, onClick: previewTtsVoice, children: "\u8BD5\u542C" }), _jsx("span", { className: "tts-status", children: ttsState })] }), _jsx("textarea", { value: tts, onChange: (e) => setTts(e.target.value), placeholder: "\u60F3\u4F60\u4E86\u2026 (Ctrl/Cmd + Enter \u53D1\u9001)", maxLength: 200, onKeyDown: (e) => {
                                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                        e.preventDefault();
                                        onSendTts();
                                    }
                                } }), _jsxs("div", { className: "tts-row", children: [_jsx("button", { className: "btn accent", disabled: !canSend || !tts.trim() || !ttsVoiceId, onClick: onSendTts, children: "\u8BA9\u5979\u542C\u5230 \u25B6" }), _jsx("span", { className: "tts-hint", children: "\u53EA\u4F7F\u7528\u672C\u4EBA\u6240\u6709\u6216\u5DF2\u83B7\u6388\u6743\u7684\u514B\u9686\u58F0\u97F3" }), _jsx("div", { style: { flex: 1 } }), _jsxs("span", { className: "tts-hint", children: [tts.length, "/200"] })] })] })] }), _jsxs("section", { className: "section", children: [_jsx("h2", { children: "\u4F4D\u7F6E" }), _jsx("div", { className: "grid tight", children: CORNERS.map((c) => (_jsx("button", { className: "btn", disabled: !canSend, onClick: () => send({ type: 'relocate', corner: c.corner }, `贴 ${c.label}`), children: c.label }, c.corner))) })] }), _jsx("div", { className: `toast ${toast ? 'on' : ''} ${toast?.err ? 'err' : ''}`, children: toast?.msg })] }));
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
function PeerPill({ role, online }) {
    const text = role === 'pet' ? '桌宠端' : '控制端';
    return (_jsxs("span", { className: `pill ${online ? 'ok' : ''}`, children: [_jsx("span", { className: "dot" }), " ", text, "\uFF1A", online ? '在线' : '离线'] }));
}
function CallPill({ state }) {
    const map = {
        idle: { cls: '', text: '未通话' },
        'requesting-media': { cls: 'warn', text: '拿麦克风中…' },
        calling: { cls: 'warn', text: '呼叫中…' },
        'in-call': { cls: 'ok', text: '通话中' },
        error: { cls: 'bad', text: '通话失败' },
    };
    const m = map[state];
    return _jsxs("span", { className: `pill ${m.cls}`, children: [_jsx("span", { className: "dot" }), " ", m.text] });
}
