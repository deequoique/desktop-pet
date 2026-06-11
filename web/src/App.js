import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { connect, disconnect, sendCommand, listVoices, setListeners, } from './api';
const LS_SERVER = 'pet.serverUrl';
const LS_SECRET = 'pet.secret';
const DEFAULT_SERVER = 'http://localhost:3030';
const DEFAULT_SECRET = 'change-me';
const EXPRESSIONS = [
    { name: 'joy', label: '😄 笑' },
    { name: 'surprised', label: '😮 吃惊' },
    { name: 'sorrow', label: '🥺 委屈' },
    { name: 'angry', label: '😡 生气' },
    { name: 'blink', label: '😉 眨眼' },
    { name: 'neutral', label: '😐 平静' },
];
const ANIMATIONS = [
    { name: 'wag_tail', label: '🐕 摇尾巴' },
    { name: 'shake', label: '🤸 抖一抖' },
];
const CORNERS = [
    { corner: 'top-left', label: '↖ 左上' },
    { corner: 'top-right', label: '↗ 右上' },
    { corner: 'bottom-left', label: '↙ 左下' },
    { corner: 'bottom-right', label: '↘ 右下' },
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
    const [voices, setVoices] = useState([]);
    const [tts, setTts] = useState('');
    const [toast, setToast] = useState(null);
    const toastTimer = useRef(null);
    const showToast = useCallback((msg, err = false) => {
        if (toastTimer.current)
            window.clearTimeout(toastTimer.current);
        setToast({ msg, err });
        toastTimer.current = window.setTimeout(() => setToast(null), 2000);
    }, []);
    useEffect(() => {
        setListeners({
            onStatus: setStatus,
            onPeers: setPeers,
            onError: (m) => showToast(m, true),
        });
        return () => setListeners({});
    }, [showToast]);
    // 连上 / peer 变化时拉一次台词列表
    useEffect(() => {
        if (status !== 'connected' || !peers.pet) {
            setVoices([]);
            return;
        }
        listVoices().then((files) => {
            setVoices(files);
            if (!files.length)
                showToast('桌宠端没有预录台词');
        });
    }, [status, peers.pet, showToast]);
    const onConnect = useCallback(() => {
        if (!serverUrl.trim() || !secret.trim()) {
            showToast('填一下服务器和密钥', true);
            return;
        }
        localStorage.setItem(LS_SERVER, serverUrl);
        localStorage.setItem(LS_SECRET, secret);
        connect(serverUrl.trim(), secret.trim());
    }, [serverUrl, secret, showToast]);
    const onDisconnect = useCallback(() => disconnect(), []);
    const canSend = status === 'connected' && peers.pet;
    const send = useCallback((cmd, label) => {
        if (!canSend) {
            showToast(status === 'connected' ? '桌宠端未上线' : '未连接', true);
            return;
        }
        const ok = sendCommand(cmd);
        showToast(ok ? `✔ ${label}` : '发送失败', !ok);
    }, [canSend, status, showToast]);
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
    }, [tts, send, showToast]);
    const groupedVoices = useMemo(() => {
        const g = { head: [], body: [], tail: [], idle: [], other: [] };
        for (const v of voices)
            g[voicePart(v)].push(v);
        return g;
    }, [voices]);
    return (_jsxs("div", { className: "app", children: [_jsx("h1", { children: "\uD83D\uDC36 \u684C\u5BA0\u9065\u63A7" }), _jsxs("div", { className: "status-bar", children: [_jsxs("div", { className: "status-row", children: [_jsx("label", { children: "\u670D\u52A1\u5668" }), _jsx("input", { value: serverUrl, onChange: (e) => setServerUrl(e.target.value), placeholder: "http://localhost:3030", disabled: status === 'connecting' || status === 'connected' })] }), _jsxs("div", { className: "status-row", children: [_jsx("label", { children: "\u623F\u95F4\u5BC6\u94A5" }), _jsx("input", { type: "password", value: secret, onChange: (e) => setSecret(e.target.value), placeholder: "ROOM_SECRET", disabled: status === 'connecting' || status === 'connected' })] }), _jsxs("div", { className: "status-row", children: [_jsx(StatusPill, { status: status }), _jsx(PeerPill, { role: "pet", online: peers.pet }), _jsx("div", { style: { flex: 1 } }), status === 'connected' || status === 'connecting' ? (_jsx("button", { className: "btn", onClick: onDisconnect, children: "\u65AD\u5F00" })) : (_jsx("button", { className: "btn accent", onClick: onConnect, children: "\u8FDE\u63A5" }))] })] }), _jsxs("section", { className: "section", children: [_jsx("h2", { children: "\u8868\u60C5" }), _jsx("div", { className: "grid tight", children: EXPRESSIONS.map((e) => (_jsx("button", { className: "btn", disabled: !canSend, onClick: () => send({ type: 'expression', name: e.name }, e.label), children: e.label }, e.name))) }), _jsx("h3", { children: "\u52A8\u4F5C" }), _jsx("div", { className: "grid tight", children: ANIMATIONS.map((a) => (_jsx("button", { className: "btn", disabled: !canSend, onClick: () => send({ type: 'animation', name: a.name }, a.label), children: a.label }, a.name))) })] }), _jsxs("section", { className: "section", children: [_jsx("h2", { children: "\u9884\u5F55\u53F0\u8BCD" }), voices.length === 0 ? (_jsx("div", { className: "empty", children: canSend ? '桌宠端没扫到台词；放 .wav 到 pet/public/voices/ 下重启即可' : '连上后会显示' })) : (['head', 'body', 'tail', 'idle', 'other'].map((part) => groupedVoices[part]?.length ? (_jsxs("div", { children: [_jsx("h3", { children: part }), _jsx("div", { className: "grid", children: groupedVoices[part].map((url) => (_jsx("button", { className: "btn", disabled: !canSend, onClick: () => send({ type: 'say_audio', url }, voiceLabel(url)), children: voiceLabel(url) }, url))) })] }, part)) : null))] }), _jsxs("section", { className: "section", children: [_jsx("h2", { children: "\u6253\u5B57\u5FF5\u51FA\u6765\uFF08\u7528\u4F60\u7684\u58F0\u97F3\uFF09" }), _jsxs("div", { className: "tts-area", children: [_jsx("textarea", { value: tts, onChange: (e) => setTts(e.target.value), placeholder: "\u60F3\u4F60\u4E86\u2026 (Ctrl/Cmd + Enter \u53D1\u9001)", maxLength: 200, onKeyDown: (e) => {
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
