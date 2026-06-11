import { io } from 'socket.io-client';
let socket = null;
let listeners = {};
export function setListeners(l) {
    listeners = l;
}
export function connect(serverUrl, secret) {
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
        s.emit('pet:join', { secret, role: 'controller' }, (res) => {
            if (res?.ok) {
                listeners.onStatus?.('connected');
                if (res.peers)
                    listeners.onPeers?.(res.peers);
            }
            else {
                listeners.onStatus?.('rejected');
                listeners.onError?.(res?.error || '加入失败');
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
