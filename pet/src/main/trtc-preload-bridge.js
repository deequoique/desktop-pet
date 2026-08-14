const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,32}$/;
const REMOTE_VIEW_ID = 'trtc-remote-screen';

function asFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function videoSummary(item) {
  if (!item) return null;
  return {
    userId: String(item.userId || ''),
    streamType: asFiniteNumber(item.streamType),
    width: asFiniteNumber(item.width),
    height: asFiniteNumber(item.height),
    frameRate: asFiniteNumber(item.frameRate),
    videoBitrate: asFiniteNumber(item.videoBitrate),
    audioBitrate: asFiniteNumber(item.audioBitrate),
  };
}

function createTrtcPreloadBridge() {
  let sdk = null;
  let cloud = null;
  let screenSharing = false;
  let microphoneEnabled = false;
  let remoteViewUserId = '';
  const eventListeners = new Set();

  const emit = (event, payload = {}) => {
    for (const listener of eventListeners) {
      try { listener({ event, ...payload }); } catch {}
    }
  };

  const loadSdk = () => {
    if (sdk) return sdk;
    sdk = require('trtc-electron-sdk');
    return sdk;
  };

  const ensureCloud = () => {
    if (cloud) return cloud;
    const trtcSdk = loadSdk();
    const TRTCCloud = trtcSdk.default;
    cloud = new TRTCCloud();
    cloud.on('onError', (errorCode, errorMessage) => emit('error', {
      errorCode: asFiniteNumber(errorCode),
      errorMessage: String(errorMessage || ''),
    }));
    cloud.on('onEnterRoom', (elapsed) => emit('enter-room', { elapsed: asFiniteNumber(elapsed) }));
    cloud.on('onExitRoom', (reason) => emit('exit-room', { reason: asFiniteNumber(reason) }));
    cloud.on('onConnectionLost', () => emit('connection-lost'));
    cloud.on('onTryToReconnect', () => emit('reconnecting'));
    cloud.on('onConnectionRecovery', () => emit('connection-recovered'));
    cloud.on('onUserSubStreamAvailable', (userId, available) => emit('substream-available', {
      userId: String(userId || ''),
      available: Number(available) === 1,
    }));
    cloud.on('onFirstVideoFrame', (userId, streamType, width, height) => emit('first-video-frame', {
      userId: String(userId || ''),
      streamType: asFiniteNumber(streamType),
      width: asFiniteNumber(width),
      height: asFiniteNumber(height),
    }));
    cloud.on('onSendFirstLocalVideoFrame', (streamType) => emit('first-local-video-frame', {
      streamType: asFiniteNumber(streamType),
    }));
    cloud.on('onSystemAudioLoopbackError', (errorCode) => emit('system-audio-error', {
      errorCode: asFiniteNumber(errorCode),
    }));
    cloud.on('onStatistics', (statistics) => {
      const trtcSdk = loadSdk();
      const streamType = trtcSdk.TRTCVideoStreamType.TRTCVideoStreamTypeSub;
      const local = statistics?.localStatisticsArray?.find((item) => item.streamType === streamType);
      const remote = statistics?.remoteStatisticsArray?.find((item) => item.streamType === streamType);
      emit('statistics', {
        rtt: asFiniteNumber(statistics?.rtt),
        upLoss: asFiniteNumber(statistics?.upLoss),
        downLoss: asFiniteNumber(statistics?.downLoss),
        appCpu: asFiniteNumber(statistics?.appCpu),
        systemCpu: asFiniteNumber(statistics?.systemCpu),
        local: videoSummary(local),
        remote: videoSummary(remote),
      });
    });
    return cloud;
  };

  const stopScreenShare = () => {
    if (!cloud) return;
    try { cloud.stopScreenCapture(); } catch {}
    try { cloud.stopSystemAudioLoopback(); } catch {}
    screenSharing = false;
    if (!microphoneEnabled) {
      try { cloud.stopLocalAudio(); } catch {}
    }
  };

  const leaveRoom = () => {
    if (!cloud) return;
    stopScreenShare();
    try {
      if (remoteViewUserId) {
        cloud.stopRemoteView(remoteViewUserId, loadSdk().TRTCVideoStreamType.TRTCVideoStreamTypeSub);
      }
    } catch {}
    remoteViewUserId = '';
    microphoneEnabled = false;
    try { cloud.stopLocalAudio(); } catch {}
    try { cloud.exitRoom(); } catch {}
  };

  return {
    isAvailable: () => {
      try {
        const instance = ensureCloud();
        return { ok: true, version: String(instance.getSDKVersion?.() || '') };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    onEvent: (callback) => {
      if (typeof callback !== 'function') return () => {};
      eventListeners.add(callback);
      return () => eventListeners.delete(callback);
    },
    enterRoom: (config) => {
      try {
        const sdkAppId = Number(config?.sdkAppId);
        const roomId = Number(config?.roomId);
        const userId = String(config?.userId || '');
        const userSig = String(config?.userSig || '');
        if (!Number.isSafeInteger(sdkAppId) || sdkAppId <= 0
          || !Number.isSafeInteger(roomId) || roomId <= 0
          || !SAFE_USER_ID.test(userId) || !userSig) {
          return { ok: false, error: 'invalid_trtc_config' };
        }
        const trtcSdk = loadSdk();
        const instance = ensureCloud();
        const params = new trtcSdk.TRTCParams();
        params.sdkAppId = sdkAppId;
        params.roomId = roomId;
        params.userId = userId;
        params.userSig = userSig;
        instance.setDefaultStreamRecvMode(true, true);
        instance.enterRoom(params, trtcSdk.TRTCAppScene.TRTCAppSceneAudioCall);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    startScreenShare: (profile) => {
      try {
        const trtcSdk = loadSdk();
        const instance = ensureCloud();
        const sources = instance.getScreenCaptureSources(160, 90, 24, 24) || [];
        const source = sources.find((item) => (
          item.type === trtcSdk.TRTCScreenCaptureSourceType.TRTCScreenCaptureSourceTypeScreen
        )) || sources[0];
        if (!source) return { ok: false, error: 'screen_source_unavailable' };
        const use1080p = profile === '1080p30';
        const encParam = new trtcSdk.TRTCVideoEncParam(
          use1080p
            ? trtcSdk.TRTCVideoResolution.TRTCVideoResolution_1920_1080
            : trtcSdk.TRTCVideoResolution.TRTCVideoResolution_1280_720,
          trtcSdk.TRTCVideoResolutionMode.TRTCVideoResolutionModeLandscape,
          30,
          use1080p ? 4000 : 1800,
          use1080p ? 1500 : 800,
          true,
        );
        instance.selectScreenCaptureTarget(
          source.type,
          source.sourceId,
          source.sourceName,
          new trtcSdk.Rect(),
          true,
          true,
        );
        instance.startScreenCapture(null, trtcSdk.TRTCVideoStreamType.TRTCVideoStreamTypeSub, encParam);
        instance.startLocalAudio(trtcSdk.TRTCAudioQuality.TRTCAudioQualityMusic);
        instance.setAudioCaptureVolume(microphoneEnabled ? 100 : 0);
        instance.startSystemAudioLoopback();
        instance.setSystemAudioLoopbackVolume(100);
        screenSharing = true;
        return { ok: true, sourceName: String(source.sourceName || ''), profile: use1080p ? '1080p30' : '720p30' };
      } catch (error) {
        stopScreenShare();
        return { ok: false, error: String(error?.message || error) };
      }
    },
    setScreenEnabled: (enabled) => {
      try {
        if (!cloud || !screenSharing) return { ok: false, error: 'screen_not_started' };
        cloud.muteLocalVideo(!enabled, loadSdk().TRTCVideoStreamType.TRTCVideoStreamTypeSub);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    startRemoteView: (userId) => {
      try {
        if (!SAFE_USER_ID.test(String(userId || ''))) return { ok: false, error: 'invalid_remote_user' };
        const view = document.getElementById(REMOTE_VIEW_ID);
        if (!view) return { ok: false, error: 'remote_view_unavailable' };
        view.textContent = '';
        remoteViewUserId = String(userId);
        ensureCloud().startRemoteView(
          remoteViewUserId,
          view,
          loadSdk().TRTCVideoStreamType.TRTCVideoStreamTypeSub,
        );
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    setMicrophoneEnabled: (enabled) => {
      try {
        const instance = ensureCloud();
        microphoneEnabled = !!enabled;
        if (microphoneEnabled) {
          instance.startLocalAudio(loadSdk().TRTCAudioQuality.TRTCAudioQualityMusic);
          instance.setAudioCaptureVolume(100);
        } else if (screenSharing) {
          instance.setAudioCaptureVolume(0);
        } else {
          instance.stopLocalAudio();
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    setRemoteAudioMuted: (userId, muted) => {
      try {
        if (!SAFE_USER_ID.test(String(userId || ''))) return { ok: false, error: 'invalid_remote_user' };
        ensureCloud().muteRemoteAudio(String(userId), !!muted);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    leaveRoom: () => {
      leaveRoom();
      return { ok: true };
    },
  };
}

module.exports = { createTrtcPreloadBridge };
