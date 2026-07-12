import { io } from 'socket.io-client';
let socket = null;
let listeners = {};
export function setListeners(l) {
    listeners = l;
}
export function connect(serverUrl, secret, participantId) {
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
        s.emit('pet:join', { secret, role: 'controller', participantId }, (res) => {
            if (res?.ok) {
                listeners.onStatus?.('connected');
                if (res.peers)
                    listeners.onPeers?.(res.peers);
            }
            else {
                listeners.onStatus?.('rejected');
                listeners.onError?.(res?.code === 'room_full' ? '房间已满（最多两人）' : res?.error || '加入失败');
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
    s.on('call:start', (payload) => {
        if (payload?.callId)
            listeners.onCallStart?.(payload.callId);
    });
    s.on('call:end', (payload) => {
        listeners.onCallEnd?.(payload?.callId, payload?.reason);
    });
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
    socket.emit('pet:command', cmd);
    return true;
}
export function listVoices(timeoutMs = 4000) {
    return new Promise((resolve) => {
        if (!socket || !socket.connected)
            return resolve([]);
        let done = false;
        const t = setTimeout(() => { if (!done) {
            done = true;
            resolve([]);
        } }, timeoutMs);
        socket.emit('pet:list-voices', (files) => {
            if (done)
                return;
            done = true;
            clearTimeout(t);
            resolve(Array.isArray(files) ? files : []);
        });
    });
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
        socket.emit('pet:list-motions', (motions) => {
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
    socket.emit('webrtc:signal', signal);
    return true;
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
        socket.timeout(4000).emit('call:start', (err, response) => {
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
