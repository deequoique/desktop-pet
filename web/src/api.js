import { io } from 'socket.io-client';
let socket = null;
let listeners = {};
let ttsApiKey = '';
let targetDeviceId = '';
export function setTargetDevice(deviceId) { targetDeviceId = deviceId; }
export function setListeners(l) {
    listeners = l;
}
export function connect(serverUrl, secret, identity) {
    if (socket)
        disconnect();
    listeners.onStatus?.('connecting');
    const s = io(serverUrl, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 800,
        reconnectionDelayMax: 5000,
    });
    socket = s;
    const join = () => {
        s.emit('pet:join', { protocolVersion: 2, secret, role: 'controller', ...identity }, (res) => {
            if (res?.ok) {
                listeners.onStatus?.('connected');
                if (res.peers)
                    listeners.onPeers?.(res.peers);
                if (ttsApiKey)
                    s.emit('tts:set-credentials', { apiKey: ttsApiKey }, () => { });
            }
            else {
                listeners.onStatus?.('rejected');
                listeners.onError?.(res?.code === 'upgrade_required' ? '客户端版本过旧，必须升级' : res?.error || '加入失败');
            }
        });
    };
    s.on('connect', join);
    s.on('disconnect', () => listeners.onStatus?.('disconnected'));
    s.on('connect_error', (e) => {
        listeners.onStatus?.('disconnected');
        listeners.onError?.(`连接出错：${e.message}`);
    });
    s.on('room:peers', (p) => listeners.onPeers?.(p));
    s.on('room:kicked', (r) => {
        listeners.onError?.(`被踢出：${r?.reason || ''}`);
        listeners.onStatus?.('rejected');
    });
    s.on('webrtc:signal', (signal) => listeners.onSignal?.(signal));
    s.on('webrtc:hangup', () => listeners.onHangup?.());
    s.on('webrtc:error', (payload) => {
        listeners.onRtcError?.(payload?.message || '通话出错');
    });
    s.on('webrtc:media-status', (payload) => listeners.onMediaStatus?.(payload));
    s.on('call:start', (payload) => {
        if (payload?.callId)
            listeners.onCallStart?.(payload.callId);
    });
    s.on('call:end', (payload) => {
        listeners.onCallEnd?.(payload?.callId, payload?.reason);
    });
    s.on('tts:status', (payload) => listeners.onTtsStatus?.(payload));
    return s;
}
export function disconnect() {
    if (!socket)
        return;
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
    listeners.onStatus?.('disconnected');
}
export function sendCommand(cmd) {
    if (!socket || !socket.connected)
        return false;
    if (!targetDeviceId)
        return false;
    socket.emit('pet:command', { ...cmd, targetDeviceId });
    return true;
}
export function listMotions(timeoutMs = 4000) {
    return new Promise((resolve) => {
        if (!socket || !socket.connected)
            return resolve([]);
        let done = false;
        const t = setTimeout(() => { if (!done) {
            done = true;
            resolve([]);
        } }, timeoutMs);
        socket.emit('pet:list-motions', { targetDeviceId }, (motions) => {
            if (done)
                return;
            done = true;
            clearTimeout(t);
            resolve(Array.isArray(motions) ? motions : []);
        });
    });
}
export function sendSignal(signal) {
    if (!socket || !socket.connected)
        return false;
    socket.emit('webrtc:signal', { ...signal, targetDeviceId });
    return true;
}
export function requestRtcConfig() {
    return new Promise((resolve) => {
        const fallback = { iceServers: [], iceTransportPolicy: 'all' };
        if (!socket?.connected)
            return resolve(fallback);
        socket.timeout(4000).emit('webrtc:get-config', (err, response) => {
            if (err || !response?.ok)
                resolve(fallback);
            else
                resolve({
                    iceServers: Array.isArray(response.iceServers) ? response.iceServers : [],
                    iceTransportPolicy: response.iceTransportPolicy === 'relay' ? 'relay' : 'all',
                    expiresAt: response.expiresAt,
                });
        });
    });
}
export function sendHangup() {
    if (!socket || !socket.connected)
        return false;
    socket.emit('webrtc:hangup');
    return true;
}
export function requestCall() {
    return new Promise((resolve) => {
        if (!socket?.connected)
            return resolve({ ok: false, code: 'disconnected' });
        socket.timeout(4000).emit('call:start', { targetDeviceId }, (err, response) => {
            if (err)
                resolve({ ok: false, code: 'timeout' });
            else
                resolve(response || { ok: false });
        });
    });
}
export function endCall(callId) {
    if (!socket?.connected)
        return false;
    socket.emit('call:end', { callId });
    return true;
}
export function setTtsCredentials(apiKey) {
    const nextApiKey = String(apiKey || '').trim();
    if (!nextApiKey)
        ttsApiKey = '';
    return new Promise((resolve) => {
        if (!socket?.connected)
            return resolve({ ok: false, code: 'disconnected', voices: [] });
        socket.timeout(12000).emit('tts:set-credentials', { apiKey: nextApiKey }, (err, response) => {
            if (err)
                resolve({ ok: false, code: 'timeout', voices: [] });
            else {
                if (response?.ok)
                    ttsApiKey = nextApiKey;
                resolve(response || { ok: false, code: 'tts_credentials_failed', voices: [] });
            }
        });
    });
}
export function listTtsVoices() {
    return new Promise((resolve) => {
        if (!socket?.connected)
            return resolve({ ok: false, code: 'disconnected', voices: [] });
        socket.timeout(12000).emit('tts:list-voices', (err, response) => {
            if (err)
                resolve({ ok: false, code: 'timeout', voices: [] });
            else
                resolve(response || { ok: false, code: 'tts_unavailable', voices: [] });
        });
    });
}
export function createTts(text, voiceId) {
    return new Promise((resolve) => {
        if (!socket?.connected)
            return resolve({ ok: false, code: 'disconnected' });
        socket.timeout(5000).emit('tts:create', { text, voiceId, targetDeviceId }, (err, response) => {
            if (err)
                resolve({ ok: false, code: 'timeout' });
            else
                resolve(response || { ok: false, code: 'tts_create_failed' });
        });
    });
}
function audioRequest(event, payload) {
    return new Promise((resolve) => {
        if (!socket?.connected)
            return resolve({ ok: false, code: 'disconnected' });
        socket.timeout(12000).emit(event, payload, (err, response) => resolve(err ? { ok: false, code: 'timeout' } : response));
    });
}
export const listPersonalAudio = () => audioRequest('audio:list');
export const addPersonalAudio = (payload) => audioRequest('audio:add', payload);
export const renamePersonalAudio = (audioId, name) => audioRequest('audio:rename', { audioId, name });
export const deletePersonalAudio = (audioId) => audioRequest('audio:delete', { audioId });
export const playPersonalAudio = (audioId) => audioRequest('audio:play', { audioId, targetDeviceId });
export const getPersonalAudio = (audioId) => audioRequest('audio:get', { audioId });
export const renameMember = (memberId, displayName) => audioRequest('room:rename-member', { memberId, displayName });
export const reclaimDevice = (deviceId, deviceName) => audioRequest('device:reclaim', { deviceId, deviceName });
