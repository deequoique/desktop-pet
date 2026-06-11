import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  connect,
  disconnect,
  listMotions,
  listVoices,
  sendCommand,
  sendHangup,
  sendSignal,
  setListeners,
  type Command,
  type ExpressionName,
  type MotionMeta,
  type Peers,
  type WebRtcSignal,
} from './api';

type Status = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'rejected';
type CallState = 'idle' | 'requesting-media' | 'calling' | 'in-call' | 'error';

const LS_SERVER = 'pet.serverUrl';
const LS_SECRET = 'pet.secret';

const DEFAULT_SERVER = 'http://localhost:3030';
const DEFAULT_SECRET = 'change-me';

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

function voicePart(url: string): 'head' | 'body' | 'tail' | 'idle' | 'other' {
  const name = url.split('/').pop() || '';
  const m = name.match(/^(head|body|tail|idle)_/i);
  return (m ? m[1].toLowerCase() : 'other') as any;
}

function voiceLabel(url: string): string {
  return (url.split('/').pop() || url).replace(/\.[^.]+$/, '');
}

export default function App() {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem(LS_SERVER) || DEFAULT_SERVER);
  const [secret, setSecret] = useState(() => localStorage.getItem(LS_SECRET) || DEFAULT_SECRET);
  const [status, setStatus] = useState<Status>('idle');
  const [peers, setPeers] = useState<Peers>({ controller: false, pet: false });
  const [motions, setMotions] = useState<MotionMeta[]>([]);
  const [voices, setVoices] = useState<string[]>([]);
  const [tts, setTts] = useState('');
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [callState, setCallState] = useState<CallState>('idle');
  const [remoteMuted, setRemoteMuted] = useState(true);
  const [pttPressed, setPttPressed] = useState(false);
  const [remoteReady, setRemoteReady] = useState(false);
  const [remoteTrackSummary, setRemoteTrackSummary] = useState('无');
  const toastTimer = useRef<number | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const rtcPcRef = useRef<RTCPeerConnection | null>(null);
  const localAudioRef = useRef<MediaStream | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

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
    setPttPressed(enabled);
  }, []);

  const teardownCall = useCallback((opts?: { sendRemoteHangup?: boolean; nextState?: CallState }) => {
    if (opts?.sendRemoteHangup) sendHangup();
    try { rtcPcRef.current?.close(); } catch {}
    rtcPcRef.current = null;
    pendingCandidatesRef.current = [];
    stopLocalAudio();
    setMicEnabled(false);
    setRemoteReady(false);
    setRemoteTrackSummary('无');
    remoteStreamRef.current = null;
    setCallState(opts?.nextState ?? 'idle');
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
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

    if (!stream || !remoteVideoRef.current) return;
    if (remoteVideoRef.current.srcObject !== stream) {
      remoteVideoRef.current.srcObject = stream;
    }
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
  }, []);

  const ensurePeerConnection = useCallback(async () => {
    if (rtcPcRef.current) return rtcPcRef.current;

    const localAudio = await ensureLocalAudio();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    rtcPcRef.current = pc;

    for (const track of localAudio.getTracks()) pc.addTrack(track, localAudio);
    pc.addTransceiver('video', { direction: 'recvonly' });

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ candidate: event.candidate.toJSON() });
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
        return;
      }
      if (state === 'failed' || state === 'disconnected') {
        showToast('通话断开了', true);
        teardownCall({ nextState: 'idle' });
      }
      if (state === 'closed') teardownCall({ nextState: 'idle' });
    };

    return pc;
  }, [ensureLocalAudio, showToast, teardownCall]);

  const handleSignal = useCallback(async (signal: WebRtcSignal) => {
    if (!signal) return;
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
      if (!peers.pet) teardownCall({ nextState: 'idle' });
      return;
    }
    listMotions().then((items) => {
      setMotions(items);
    });
    listVoices().then((files) => {
      setVoices(files);
      if (!files.length) showToast('桌宠端没有预录台词');
    });
  }, [status, peers.pet, showToast, teardownCall]);

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.muted = remoteMuted;
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

  const send = useCallback((cmd: Command, label: string) => {
    if (!canSend) {
      showToast(status === 'connected' ? '桌宠端未上线' : '未连接', true);
      return;
    }
    const ok = sendCommand(cmd);
    showToast(ok ? `✔ ${label}` : '发送失败', !ok);
  }, [canSend, showToast, status]);

  const onSendTts = useCallback(() => {
    const text = tts.trim();
    if (!text) return;
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
    } catch (e: any) {
      console.warn('[webrtc] startCall failed:', e);
      showToast(`开通话失败：${e?.message || e}`, true);
      teardownCall({ nextState: 'error' });
    }
  }, [canCall, ensurePeerConnection, showToast, teardownCall]);

  const onEndCall = useCallback(() => {
    teardownCall({ sendRemoteHangup: true, nextState: 'idle' });
  }, [teardownCall]);

  const setTalkPressed = useCallback((pressed: boolean) => {
    if (callState !== 'in-call' && callState !== 'calling') return;
    setMicEnabled(pressed);
  }, [callState, setMicEnabled]);

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
          <span className={`signal ${peers.pet ? 'on' : ''}`} />
          <span>{peers.pet ? '桌宠在线' : '等待桌宠'}</span>
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
          <PeerPill role="pet" online={peers.pet} />
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
        <div className="video-stage">
          <video ref={remoteVideoRef} className={`video-frame ${remoteReady ? 'ready' : ''}`} playsInline autoPlay />
          {!remoteReady && (
            <div className="video-empty">
              {callState === 'calling' || callState === 'requesting-media'
                ? '正在等桌宠把屏幕推过来。\n如果一直没画面，先去 B 端确认屏幕录制权限。'
                : '点“开始通话”后，这里会显示她的屏幕。'}
            </div>
          )}
        </div>
        <div className="video-meta">
          <span>{remoteReady ? '已收到桌面视频流' : '尚未收到视频流'}</span>
          <span>远端轨道：{remoteTrackSummary}</span>
          <span>{remoteMuted ? '对端声音默认静音' : '对端声音开启'}</span>
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
            className={`btn ${pttPressed ? 'accent' : ''}`}
            disabled={callState !== 'calling' && callState !== 'in-call'}
            onMouseDown={() => setTalkPressed(true)}
            onMouseUp={() => setTalkPressed(false)}
            onMouseLeave={() => setTalkPressed(false)}
            onTouchStart={() => setTalkPressed(true)}
            onTouchEnd={() => setTalkPressed(false)}
            onTouchCancel={() => setTalkPressed(false)}
          >{pttPressed ? '正在说话...' : '按住说话'}</button>
          <button
            className="btn"
            disabled={!remoteReady}
            onClick={() => setRemoteMuted((v) => !v)}
          >{remoteMuted ? '打开声音' : '静音对端'}</button>
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
        {motions.length === 0 ? (
          <div className="empty">
            {canSend ? '当前模型还没配置动作；把 manifest 和 .vrma 放进 pet/public/motions/ 后重启即可' : '连上后会显示'}
          </div>
        ) : (
          <div className="grid tight">
            {motions.map((m) => (
              <button
                key={m.id}
                className="btn"
                disabled={!canSend}
                onClick={() => send({ type: 'animation', name: m.id }, m.label)}
              >{m.label}</button>
            ))}
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
        <h2>打字念出来（用你的声音）</h2>
        <div className="tts-area">
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
              disabled={!canSend || !tts.trim()}
              onClick={onSendTts}
            >让她听到 ▶</button>
            <span className="tts-hint">需要后端配好 ELEVENLABS_API_KEY + VOICE_ID</span>
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
