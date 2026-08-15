const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,32}$/;
const REMOTE_VIEW_ID = 'trtc-remote-screen';
const PCM_FRAME_BYTES = 3_840;

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

function validIdentity(identity) {
  return SAFE_USER_ID.test(String(identity?.userId || '')) && !!String(identity?.userSig || '');
}

function createTrtcPreloadBridge(options = {}) {
  const systemAudioTransport = options.systemAudioTransport || null;
  const sdkLoader = options.sdkLoader || (() => require('trtc-electron-sdk'));
  let sdk = null;
  let mainRecord = null;
  let systemRecord = null;
  let activeConfig = null;
  let generation = 0;
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
    sdk = sdkLoader();
    return sdk;
  };

  const isCurrent = (record) => !!record
    && record.generation === generation
    && (record.kind === 'main' ? mainRecord === record : systemRecord === record);

  const emitSystemState = (state, fields = {}) => emit('system-audio-state', { state, ...fields });

  const stopNativeTransport = (recordGeneration) => {
    try {
      const pending = systemAudioTransport?.stop(recordGeneration);
      Promise.resolve(pending).catch(() => {});
    } catch {}
  };

  const attachMainListeners = (record) => {
    const cloud = record.cloud;
    cloud.on('onError', (errorCode, errorMessage) => {
      if (!isCurrent(record)) return;
      emit('error', {
        errorCode: asFiniteNumber(errorCode),
        errorMessage: String(errorMessage || ''),
      });
    });
    cloud.on('onEnterRoom', (elapsed) => {
      if (!isCurrent(record)) return;
      record.entered = asFiniteNumber(elapsed) >= 0;
      if (record.entered) {
        try { cloud.muteRemoteAudio(activeConfig.remoteUserId, true); } catch {}
        try {
          if (activeConfig.remoteSystemUserId) cloud.muteRemoteAudio(activeConfig.remoteSystemUserId, true);
        } catch {}
      }
      emit('enter-room', { elapsed: asFiniteNumber(elapsed) });
    });
    cloud.on('onExitRoom', (reason) => {
      if (isCurrent(record)) emit('exit-room', { reason: asFiniteNumber(reason) });
    });
    cloud.on('onConnectionLost', () => { if (isCurrent(record)) emit('connection-lost'); });
    cloud.on('onTryToReconnect', () => { if (isCurrent(record)) emit('reconnecting'); });
    cloud.on('onConnectionRecovery', () => { if (isCurrent(record)) emit('connection-recovered'); });
    cloud.on('onUserSubStreamAvailable', (userId, available) => {
      if (!isCurrent(record)) return;
      emit('substream-available', {
        userId: String(userId || ''),
        available: Number(available) === 1,
      });
    });
    cloud.on('onFirstVideoFrame', (userId, streamType, width, height) => {
      if (!isCurrent(record)) return;
      emit('first-video-frame', {
        userId: String(userId || ''),
        streamType: asFiniteNumber(streamType),
        width: asFiniteNumber(width),
        height: asFiniteNumber(height),
      });
    });
    cloud.on('onSendFirstLocalVideoFrame', (streamType) => {
      if (isCurrent(record)) emit('first-local-video-frame', { streamType: asFiniteNumber(streamType) });
    });
    cloud.on('onStatistics', (statistics) => {
      if (!isCurrent(record)) return;
      const streamType = loadSdk().TRTCVideoStreamType.TRTCVideoStreamTypeSub;
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
  };

  const ensureMainCloud = () => {
    if (mainRecord) return mainRecord.cloud;
    const TRTCCloud = loadSdk().default;
    const record = {
      kind: 'main',
      cloud: TRTCCloud.getTRTCShareInstance(),
      generation,
      entered: false,
    };
    mainRecord = record;
    attachMainListeners(record);
    return record.cloud;
  };

  const stopSystemIdentity = () => {
    const record = systemRecord;
    systemRecord = null;
    if (!record) return;
    if (record.mode === 'process-exclusion') {
      stopNativeTransport(record.generation);
      try { record.cloud.enableCustomAudioCapture(false); } catch {}
    } else {
      try { record.cloud.stopSystemAudioLoopback(); } catch {}
    }
    try { record.cloud.stopLocalAudio(); } catch {}
    try { record.cloud.exitRoom(); } catch {}
    try { record.cloud.destroy(); } catch {}
  };

  const failSystemIdentity = (record, error) => {
    if (!isCurrent(record)) return;
    emitSystemState('unavailable', {
      mode: record.mode || 'unavailable',
      echoExclusion: record.echoExclusion || 'unknown',
      error: String(error || 'system_audio_failed').slice(0, 160),
    });
    stopSystemIdentity();
  };

  const startSystemCapture = async (record) => {
    if (!isCurrent(record)) return;
    let capability;
    try {
      capability = systemAudioTransport
        ? await systemAudioTransport.getCapability()
        : { mode: process.platform === 'darwin' || process.platform === 'win32' ? 'trtc-loopback' : 'unavailable', echoExclusion: 'not-supported' };
    } catch {
      capability = { mode: 'unavailable', echoExclusion: 'capability-error' };
    }
    if (!isCurrent(record)) return;
    record.mode = String(capability?.mode || 'unavailable');
    record.echoExclusion = String(capability?.echoExclusion || 'unknown');
    if (record.mode === 'process-exclusion') {
      try {
        record.cloud.stopLocalAudio();
        record.cloud.enableCustomAudioCapture(true);
        const result = await systemAudioTransport.start(record.generation);
        if (!isCurrent(record)) {
          stopNativeTransport(record.generation);
          return;
        }
        if (!result?.ok) throw new Error(result?.error || 'helper_start_failed');
        record.captureStarted = true;
        emitSystemState('available', {
          mode: record.mode,
          echoExclusion: record.echoExclusion,
          protocolVersion: result.protocolVersion,
          windowsBuild: capability.windowsBuild,
        });
      } catch (error) {
        failSystemIdentity(record, error?.message || error);
      }
      return;
    }
    if (record.mode === 'trtc-loopback') {
      try {
        record.cloud.startSystemAudioLoopback();
        record.cloud.setSystemAudioLoopbackVolume(100);
        record.captureStarted = true;
        emitSystemState('available', {
          mode: record.mode,
          echoExclusion: record.echoExclusion,
          windowsBuild: capability.windowsBuild,
        });
      } catch (error) {
        failSystemIdentity(record, error?.message || error);
      }
      return;
    }
    failSystemIdentity(record, 'system_audio_unavailable');
  };

  const startSystemIdentity = () => {
    if (!activeConfig?.publishScreen || !validIdentity(activeConfig.localSystemAudio)) {
      emitSystemState('unavailable', { mode: 'unavailable', error: 'missing_system_identity' });
      return;
    }
    stopSystemIdentity();
    const parent = ensureMainCloud();
    const child = parent.createSubCloud();
    if (!child) {
      emitSystemState('unavailable', { mode: 'unavailable', error: 'subcloud_unavailable' });
      return;
    }
    const record = {
      kind: 'system',
      cloud: child,
      generation,
      entered: false,
      captureStarted: false,
      mode: 'pending',
      echoExclusion: 'unknown',
    };
    systemRecord = record;
    child.on('onError', (errorCode, errorMessage) => {
      if (!isCurrent(record)) return;
      failSystemIdentity(record, `trtc_${asFiniteNumber(errorCode)}:${String(errorMessage || '')}`);
    });
    child.on('onSystemAudioLoopbackError', (errorCode) => {
      if (!isCurrent(record)) return;
      failSystemIdentity(record, `loopback_${asFiniteNumber(errorCode)}`);
    });
    child.on('onEnterRoom', (elapsed) => {
      if (!isCurrent(record)) return;
      record.entered = asFiniteNumber(elapsed) >= 0;
      if (!record.entered) {
        failSystemIdentity(record, `enter_room_${asFiniteNumber(elapsed)}`);
        return;
      }
      void startSystemCapture(record);
    });
    try {
      child.setDefaultStreamRecvMode(false, false);
      child.muteAllRemoteAudio(true);
      const params = new (loadSdk().TRTCParams)();
      params.sdkAppId = Number(activeConfig.sdkAppId);
      params.roomId = Number(activeConfig.roomId);
      params.userId = String(activeConfig.localSystemAudio.userId);
      params.userSig = String(activeConfig.localSystemAudio.userSig);
      child.enterRoom(params, loadSdk().TRTCAppScene.TRTCAppSceneAudioCall);
      emitSystemState('starting', { mode: 'pending', echoExclusion: 'unknown' });
    } catch (error) {
      failSystemIdentity(record, error?.message || error);
    }
  };

  const stopScreenShare = () => {
    if (mainRecord) {
      try { mainRecord.cloud.stopScreenCapture(); } catch {}
    }
    screenSharing = false;
    stopSystemIdentity();
  };

  const leaveRoom = () => {
    generation += 1;
    const record = mainRecord;
    stopSystemIdentity();
    if (record) {
      try { record.cloud.stopScreenCapture(); } catch {}
      try {
        if (remoteViewUserId) {
          record.cloud.stopRemoteView(remoteViewUserId, loadSdk().TRTCVideoStreamType.TRTCVideoStreamTypeSub);
        }
      } catch {}
      try { record.cloud.stopLocalAudio(); } catch {}
      try { record.cloud.exitRoom(); } catch {}
    }
    remoteViewUserId = '';
    screenSharing = false;
    microphoneEnabled = false;
    activeConfig = null;
    mainRecord = null;
    try { sdk?.default.destroyTRTCShareInstance(); } catch {}
  };

  const removeFrameListener = systemAudioTransport?.onFrame?.((payload) => {
    const record = systemRecord;
    if (!record || !isCurrent(record) || record.mode !== 'process-exclusion'
      || payload?.generation !== record.generation) return;
    try {
      const pcm = Buffer.isBuffer(payload.pcm) ? payload.pcm : Buffer.from(payload.pcm || []);
      if (pcm.length !== PCM_FRAME_BYTES) throw new Error('invalid_pcm_frame');
      const trtcSdk = loadSdk();
      const frame = new trtcSdk.TRTCAudioFrame(
        trtcSdk.TRTCAudioFrameFormat.TRTCAudioFrameFormatPCM,
        pcm,
        pcm.length,
        48_000,
        2,
        record.cloud.generateCustomPTS(),
      );
      record.cloud.sendCustomAudioData(frame);
    } catch (error) {
      failSystemIdentity(record, error?.message || error);
    }
  });

  const removeStatusListener = systemAudioTransport?.onStatus?.((payload) => {
    const record = systemRecord;
    if (!record || !isCurrent(record) || payload?.generation !== record.generation) return;
    if (payload.event === 'helper-error' || payload.event === 'protocol-error'
      || (payload.event === 'helper-exit' && !payload.expected)) {
      failSystemIdentity(record, payload.error || `helper_exit_${payload.code ?? 'unknown'}`);
      return;
    }
    if (payload.event === 'helper-status' && payload.droppedFrames) {
      emit('system-audio-dropped-frames', { droppedFrames: payload.droppedFrames });
    }
    if (payload.event === 'transport-frames-dropped' && payload.droppedFrames) {
      emit('system-audio-dropped-frames', { droppedFrames: payload.droppedFrames });
    }
  });

  return {
    isAvailable: () => {
      try {
        const instance = ensureMainCloud();
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
        const remoteUserId = String(config?.remoteUserId || '');
        const remoteSystemUserId = config?.remoteSystemUserId == null ? '' : String(config.remoteSystemUserId);
        if (!Number.isSafeInteger(sdkAppId) || sdkAppId <= 0
          || !Number.isSafeInteger(roomId) || roomId <= 0
          || !SAFE_USER_ID.test(userId) || !userSig || !SAFE_USER_ID.test(remoteUserId)
          || (remoteSystemUserId && !SAFE_USER_ID.test(remoteSystemUserId))
          || (!!config?.publishScreen && !validIdentity(config?.localSystemAudio))) {
          return { ok: false, error: 'invalid_trtc_config' };
        }
        leaveRoom();
        generation += 1;
        activeConfig = { ...config, sdkAppId, roomId, userId, userSig, remoteUserId, remoteSystemUserId };
        const instance = ensureMainCloud();
        mainRecord.generation = generation;
        const params = new (loadSdk().TRTCParams)();
        params.sdkAppId = sdkAppId;
        params.roomId = roomId;
        params.userId = userId;
        params.userSig = userSig;
        instance.setDefaultStreamRecvMode(true, true);
        instance.muteRemoteAudio(remoteUserId, true);
        if (remoteSystemUserId) instance.muteRemoteAudio(remoteSystemUserId, true);
        instance.enterRoom(params, loadSdk().TRTCAppScene.TRTCAppSceneAudioCall);
        return { ok: true };
      } catch (error) {
        leaveRoom();
        return { ok: false, error: String(error?.message || error) };
      }
    },
    startScreenShare: (profile) => {
      try {
        if (!activeConfig?.publishScreen || !mainRecord?.entered) return { ok: false, error: 'screen_not_authorized' };
        const trtcSdk = loadSdk();
        const instance = ensureMainCloud();
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
        screenSharing = true;
        startSystemIdentity();
        return { ok: true, sourceName: String(source.sourceName || ''), profile: use1080p ? '1080p30' : '720p30' };
      } catch (error) {
        stopScreenShare();
        return { ok: false, error: String(error?.message || error) };
      }
    },
    setScreenEnabled: (enabled) => {
      try {
        if (!mainRecord || !screenSharing) return { ok: false, error: 'screen_not_started' };
        mainRecord.cloud.muteLocalVideo(!enabled, loadSdk().TRTCVideoStreamType.TRTCVideoStreamTypeSub);
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
        ensureMainCloud().startRemoteView(
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
        if (!mainRecord?.entered) return { ok: false, error: 'not_in_room' };
        microphoneEnabled = !!enabled;
        if (microphoneEnabled) {
          mainRecord.cloud.startLocalAudio(loadSdk().TRTCAudioQuality.TRTCAudioQualityDefault);
          mainRecord.cloud.setAudioCaptureVolume(100);
        } else {
          mainRecord.cloud.stopLocalAudio();
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    setRemoteMicrophoneMuted: (muted) => {
      try {
        if (!activeConfig?.remoteUserId) return { ok: false, error: 'remote_microphone_unavailable' };
        ensureMainCloud().muteRemoteAudio(activeConfig.remoteUserId, !!muted);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    setRemoteSystemAudioMuted: (muted) => {
      try {
        if (!activeConfig?.remoteSystemUserId) return { ok: false, error: 'remote_system_audio_unavailable' };
        ensureMainCloud().muteRemoteAudio(activeConfig.remoteSystemUserId, !!muted);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    leaveRoom: () => {
      leaveRoom();
      return { ok: true };
    },
    dispose: () => {
      leaveRoom();
      removeFrameListener?.();
      removeStatusListener?.();
      eventListeners.clear();
    },
  };
}

module.exports = { createTrtcPreloadBridge };
