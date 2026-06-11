import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { connect, disconnect, listMotions, listVoices, sendCommand, sendHangup, sendSignal, setListeners, } from './api';
const LS_SERVER = 'pet.serverUrl';
const LS_SECRET = 'pet.secret';
const DEFAULT_SERVER = 'http://localhost:3030';
const DEFAULT_SECRET = 'change-me';
const RTC_CONFIG = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
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
function voicePart(url) {
    const name = url.split('/').pop() || '';
    const m = name.match(/^(head|body|tail|idle)_/i);
    return (m ? m[1].toLowerCase() : 'other');
}
function voiceLabel(url) {
    return (url.split('/').pop() || url).replace(/\.[^.]+$/, '');
}
export default function App() {
    const [serverUrl, setServerUrl] = useState(() => localStorage.getItem(LS_SERVER) || DEFAULT_SERVER);
    const [secret, setSecret] = useState(() => localStorage.getItem(LS_SECRET) || DEFAULT_SECRET);
    const [status, setStatus] = useState('idle');
    const [peers, setPeers] = useState({ controller: false, pet: false });
    const [motions, setMotions] = useState([]);
    const [voices, setVoices] = useState([]);
    const [tts, setTts] = useState('');
    const [toast, setToast] = useState(null);
    const [callState, setCallState] = useState('idle');
    const [remoteMuted, setRemoteMuted] = useState(true);
    const [pttPressed, setPttPressed] = useState(false);
    const [remoteReady, setRemoteReady] = useState(false);
    const [remoteTrackSummary, setRemoteTrackSummary] = useState('无');
    const toastTimer = useRef(null);
    const remoteVideoRef = useRef(null);
    const remoteStreamRef = useRef(null);
    const rtcPcRef = useRef(null);
    const localAudioRef = useRef(null);
    const pendingCandidatesRef = useRef([]);
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
        setPttPressed(enabled);
    }, []);
    const teardownCall = useCallback((opts) => {
        if (opts?.sendRemoteHangup)
            sendHangup();
        try {
            rtcPcRef.current?.close();
        }
        catch { }
        rtcPcRef.current = null;
        pendingCandidatesRef.current = [];
        stopLocalAudio();
        setMicEnabled(false);
        setRemoteReady(false);
        setRemoteTrackSummary('无');
        remoteStreamRef.current = null;
        setCallState(opts?.nextState ?? 'idle');
        if (remoteVideoRef.current)
            remoteVideoRef.current.srcObject = null;
    }, [setMicEnabled, stopLocalAudio]);
    const syncRemoteMediaState = useCallback(async () => {
        const stream = remoteStreamRef.current;
        const videoTracks = stream?.getVideoTracks() ?? [];
        const audioTracks = stream?.getAudioTracks() ?? [];
        const summary = [
            videoTracks.length ? `video:${videoTracks.length}` : null,
            audioTracks.length ? `audio:${audioTracks.length}` : null,
        ].filter(Boolean).join(' + ') || '无';
        setRemoteTrackSummary(summary);
        setRemoteReady(videoTracks.length > 0);
        if (!stream || !remoteVideoRef.current)
            return;
        if (remoteVideoRef.current.srcObject !== stream) {
            remoteVideoRef.current.srcObject = stream;
        }
        try {
            await remoteVideoRef.current.play();
        }
        catch (e) {
            console.warn('[webrtc] remote video play failed:', e);
        }
    }, []);
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
    }, []);
    const ensurePeerConnection = useCallback(async () => {
        if (rtcPcRef.current)
            return rtcPcRef.current;
        const localAudio = await ensureLocalAudio();
        const pc = new RTCPeerConnection(RTC_CONFIG);
        rtcPcRef.current = pc;
        for (const track of localAudio.getTracks())
            pc.addTrack(track, localAudio);
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.onicecandidate = (event) => {
            if (event.candidate)
                sendSignal({ candidate: event.candidate.toJSON() });
        };
        pc.ontrack = async (event) => {
            const stream = remoteStreamRef.current ?? new MediaStream();
            remoteStreamRef.current = stream;
            if (!stream.getTracks().some((t) => t.id === event.track.id)) {
                stream.addTrack(event.track);
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
                setCallState('in-call');
                return;
            }
            if (state === 'failed' || state === 'disconnected') {
                showToast('通话断开了', true);
                teardownCall({ nextState: 'idle' });
            }
            if (state === 'closed')
                teardownCall({ nextState: 'idle' });
        };
        return pc;
    }, [ensureLocalAudio, showToast, teardownCall]);
    const handleSignal = useCallback(async (signal) => {
        if (!signal)
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
                sendSignal({ description: pc.localDescription });
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
    }, [ensurePeerConnection, flushPendingCandidates]);
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
                teardownCall({ nextState: 'idle' });
                showToast('通话结束了');
            },
            onRtcError: (msg) => {
                showToast(msg, true);
                teardownCall({ nextState: 'error' });
            },
        });
        return () => {
            setListeners({});
            teardownCall({ nextState: 'idle' });
        };
    }, [handleSignal, showToast, teardownCall]);
    useEffect(() => {
        if (status !== 'connected' || !peers.pet) {
            setMotions([]);
            setVoices([]);
            if (!peers.pet)
                teardownCall({ nextState: 'idle' });
            return;
        }
        listMotions().then((items) => {
            setMotions(items);
        });
        listVoices().then((files) => {
            setVoices(files);
            if (!files.length)
                showToast('桌宠端没有预录台词');
        });
    }, [status, peers.pet, showToast, teardownCall]);
    useEffect(() => {
        if (remoteVideoRef.current)
            remoteVideoRef.current.muted = remoteMuted;
    }, [remoteMuted]);
    const onConnect = useCallback(() => {
        if (!serverUrl.trim() || !secret.trim()) {
            showToast('填一下服务器和密钥', true);
            return;
        }
        localStorage.setItem(LS_SERVER, serverUrl);
        localStorage.setItem(LS_SECRET, secret);
        connect(serverUrl.trim(), secret.trim());
    }, [secret, serverUrl, showToast]);
    const onDisconnect = useCallback(() => {
        teardownCall({ sendRemoteHangup: true, nextState: 'idle' });
        disconnect();
    }, [teardownCall]);
    const canSend = status === 'connected' && peers.pet;
    const canCall = canSend;
    const send = useCallback((cmd, label) => {
        if (!canSend) {
            showToast(status === 'connected' ? '桌宠端未上线' : '未连接', true);
            return;
        }
        const ok = sendCommand(cmd);
        showToast(ok ? `✔ ${label}` : '发送失败', !ok);
    }, [canSend, showToast, status]);
    const onSendTts = useCallback(() => {
        const text = tts.trim();
        if (!text)
            return;
        if (text.length > 200) {
            showToast('太长了，控制在 200 字内', true);
            return;
        }
        send({ type: 'say_tts', text }, `说："${text.slice(0, 12)}${text.length > 12 ? '…' : ''}"`);
        setTts('');
    }, [send, showToast, tts]);
    const onStartCall = useCallback(async () => {
        if (!canCall) {
            showToast('先连上桌宠', true);
            return;
        }
        try {
            setCallState('requesting-media');
            const pc = await ensurePeerConnection();
            const offer = await pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true,
            });
            await pc.setLocalDescription(offer);
            sendSignal({ description: pc.localDescription });
            console.log('[webrtc] controller sent offer');
            setCallState('calling');
        }
        catch (e) {
            console.warn('[webrtc] startCall failed:', e);
            showToast(`开通话失败：${e?.message || e}`, true);
            teardownCall({ nextState: 'error' });
        }
    }, [canCall, ensurePeerConnection, showToast, teardownCall]);
    const onEndCall = useCallback(() => {
        teardownCall({ sendRemoteHangup: true, nextState: 'idle' });
    }, [teardownCall]);
    const setTalkPressed = useCallback((pressed) => {
        if (callState !== 'in-call' && callState !== 'calling')
            return;
        setMicEnabled(pressed);
    }, [callState, setMicEnabled]);
    const groupedVoices = useMemo(() => {
        const g = { head: [], body: [], tail: [], idle: [], other: [] };
        for (const v of voices)
            g[voicePart(v)].push(v);
        return g;
    }, [voices]);
    return (_jsxs("div", { className: "app", children: [_jsxs("header", { className: "hero", children: [_jsxs("div", { children: [_jsx("p", { className: "eyebrow", children: "REMOTE CONSOLE" }), _jsx("h1", { children: "\u684C\u5BA0\u8FDC\u7A0B\u63A7\u5236\u53F0" }), _jsx("p", { className: "hero-copy", children: "\u9ED1\u767D\u84DD\u4E3B\u754C\u9762\uFF0C\u4F18\u5148\u628A\u5C4F\u5E55\u3001\u901A\u8BDD\u548C\u63A7\u5236\u52A8\u4F5C\u653E\u5230\u4E00\u5C4F\u5185\u3002" })] }), _jsxs("div", { className: "hero-badge", children: [_jsx("span", { className: `signal ${peers.pet ? 'on' : ''}` }), _jsx("span", { children: peers.pet ? '桌宠在线' : '等待桌宠' })] })] }), _jsxs("div", { className: "status-bar", children: [_jsxs("div", { className: "status-row", children: [_jsx("label", { children: "\u670D\u52A1\u5668" }), _jsx("input", { value: serverUrl, onChange: (e) => setServerUrl(e.target.value), placeholder: "http://localhost:3030", disabled: status === 'connecting' || status === 'connected' })] }), _jsxs("div", { className: "status-row", children: [_jsx("label", { children: "\u623F\u95F4\u5BC6\u94A5" }), _jsx("input", { type: "password", value: secret, onChange: (e) => setSecret(e.target.value), placeholder: "ROOM_SECRET", disabled: status === 'connecting' || status === 'connected' })] }), _jsxs("div", { className: "status-row", children: [_jsx(StatusPill, { status: status }), _jsx(PeerPill, { role: "pet", online: peers.pet }), _jsx("div", { style: { flex: 1 } }), status === 'connected' || status === 'connecting' ? (_jsx("button", { className: "btn", onClick: onDisconnect, children: "\u65AD\u5F00" })) : (_jsx("button", { className: "btn accent", onClick: onConnect, children: "\u8FDE\u63A5" }))] })] }), _jsxs("section", { className: "section", children: [_jsx("h2", { children: "\u901A\u8BDD" }), _jsxs("div", { className: "video-stage", children: [_jsx("video", { ref: remoteVideoRef, className: `video-frame ${remoteReady ? 'ready' : ''}`, playsInline: true, autoPlay: true }), !remoteReady && (_jsx("div", { className: "video-empty", children: callState === 'calling' || callState === 'requesting-media'
                                    ? '正在等桌宠把屏幕推过来。\n如果一直没画面，先去 B 端确认屏幕录制权限。'
                                    : '点“开始通话”后，这里会显示她的屏幕。' }))] }), _jsxs("div", { className: "video-meta", children: [_jsx("span", { children: remoteReady ? '已收到桌面视频流' : '尚未收到视频流' }), _jsxs("span", { children: ["\u8FDC\u7AEF\u8F68\u9053\uFF1A", remoteTrackSummary] }), _jsx("span", { children: remoteMuted ? '对端声音默认静音' : '对端声音开启' })] }), _jsxs("div", { className: "call-row", children: [_jsx(CallPill, { state: callState }), _jsx("button", { className: "btn accent", disabled: !canCall || callState === 'calling' || callState === 'requesting-media' || callState === 'in-call', onClick: onStartCall, children: "\u5F00\u59CB\u901A\u8BDD" }), _jsx("button", { className: "btn", disabled: callState !== 'calling' && callState !== 'in-call', onClick: onEndCall, children: "\u7ED3\u675F\u901A\u8BDD" }), _jsx("button", { className: `btn ${pttPressed ? 'accent' : ''}`, disabled: callState !== 'calling' && callState !== 'in-call', onMouseDown: () => setTalkPressed(true), onMouseUp: () => setTalkPressed(false), onMouseLeave: () => setTalkPressed(false), onTouchStart: () => setTalkPressed(true), onTouchEnd: () => setTalkPressed(false), onTouchCancel: () => setTalkPressed(false), children: pttPressed ? '正在说话...' : '按住说话' }), _jsx("button", { className: "btn", disabled: !remoteReady, onClick: () => setRemoteMuted((v) => !v), children: remoteMuted ? '打开声音' : '静音对端' })] })] }), _jsxs("section", { className: "section", children: [_jsx("h2", { children: "\u8868\u60C5" }), _jsx("div", { className: "grid tight", children: EXPRESSIONS.map((e) => (_jsx("button", { className: "btn", disabled: !canSend, onClick: () => send({ type: 'expression', name: e.name }, e.label), children: e.label }, e.name))) }), _jsx("h3", { children: "\u52A8\u4F5C" }), motions.length === 0 ? (_jsx("div", { className: "empty", children: canSend ? '当前模型还没配置动作；把 manifest 和 .vrma 放进 pet/public/motions/ 后重启即可' : '连上后会显示' })) : (_jsx("div", { className: "grid tight", children: motions.map((m) => (_jsx("button", { className: "btn", disabled: !canSend, onClick: () => send({ type: 'animation', name: m.id }, m.label), children: m.label }, m.id))) }))] }), _jsxs("section", { className: "section", children: [_jsx("h2", { children: "\u9884\u5F55\u53F0\u8BCD" }), voices.length === 0 ? (_jsx("div", { className: "empty", children: canSend ? '桌宠端没扫到台词；放 .wav 到 pet/public/voices/ 下重启即可' : '连上后会显示' })) : (['head', 'body', 'tail', 'idle', 'other'].map((part) => groupedVoices[part]?.length ? (_jsxs("div", { children: [_jsx("h3", { children: part }), _jsx("div", { className: "grid", children: groupedVoices[part].map((url) => (_jsx("button", { className: "btn", disabled: !canSend, onClick: () => send({ type: 'say_audio', url }, voiceLabel(url)), children: voiceLabel(url) }, url))) })] }, part)) : null))] }), _jsxs("section", { className: "section", children: [_jsx("h2", { children: "\u6253\u5B57\u5FF5\u51FA\u6765\uFF08\u7528\u4F60\u7684\u58F0\u97F3\uFF09" }), _jsxs("div", { className: "tts-area", children: [_jsx("textarea", { value: tts, onChange: (e) => setTts(e.target.value), placeholder: "\u60F3\u4F60\u4E86\u2026 (Ctrl/Cmd + Enter \u53D1\u9001)", maxLength: 200, onKeyDown: (e) => {
                                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                        e.preventDefault();
                                        onSendTts();
                                    }
                                } }), _jsxs("div", { className: "tts-row", children: [_jsx("button", { className: "btn accent", disabled: !canSend || !tts.trim(), onClick: onSendTts, children: "\u8BA9\u5979\u542C\u5230 \u25B6" }), _jsx("span", { className: "tts-hint", children: "\u9700\u8981\u540E\u7AEF\u914D\u597D ELEVENLABS_API_KEY + VOICE_ID" }), _jsx("div", { style: { flex: 1 } }), _jsxs("span", { className: "tts-hint", children: [tts.length, "/200"] })] })] })] }), _jsxs("section", { className: "section", children: [_jsx("h2", { children: "\u4F4D\u7F6E" }), _jsx("div", { className: "grid tight", children: CORNERS.map((c) => (_jsx("button", { className: "btn", disabled: !canSend, onClick: () => send({ type: 'relocate', corner: c.corner }, `贴 ${c.label}`), children: c.label }, c.corner))) })] }), _jsx("div", { className: `toast ${toast ? 'on' : ''} ${toast?.err ? 'err' : ''}`, children: toast?.msg })] }));
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
