import type { RendererDiagnosticInput } from './diagnostics';

type Recorder = (event: RendererDiagnosticInput) => void;
type CandidateDirection = 'local' | 'remote';
type CandidateAction = 'generated' | 'received' | 'queued' | 'added' | 'add-failed' | 'gathering-complete';

export type RtcDiagnosticHandle = {
  candidate: (direction: CandidateDirection, action: CandidateAction, candidate?: RTCIceCandidate | RTCIceCandidateInit | null, error?: unknown) => void;
  snapshot: (reason: string) => Promise<void>;
  close: (reason: string) => void;
};

type AttachOptions = {
  recorder: Recorder;
  role: 'controller' | 'pet';
  mediaKind: 'main' | 'camera';
  getCallId: () => string | null | undefined;
  configuration: RTCConfiguration;
};

function rawCandidateFields(raw: string) {
  const parts = raw.replace(/^candidate:/i, '').trim().split(/\s+/);
  const valueAfter = (name: string) => {
    const index = parts.indexOf(name);
    return index >= 0 ? parts[index + 1] : undefined;
  };
  const typeIndex = parts.indexOf('typ');
  return {
    foundation: parts[0],
    protocol: parts[2]?.toLowerCase(),
    priority: Number(parts[3]) || undefined,
    address: parts[4],
    port: Number(parts[5]) || undefined,
    candidateType: typeIndex >= 0 ? parts[typeIndex + 1] : undefined,
    relatedAddress: valueAfter('raddr'),
    relatedPort: Number(valueAfter('rport')) || undefined,
    tcpType: valueAfter('tcptype'),
    usernameFragment: valueAfter('ufrag'),
  };
}

export function summarizeIceCandidate(candidate?: RTCIceCandidate | RTCIceCandidateInit | null) {
  if (!candidate) return null;
  const item = candidate as RTCIceCandidate & RTCIceCandidateInit;
  const parsed = rawCandidateFields(String(item.candidate || ''));
  return {
    candidateType: item.type || parsed.candidateType,
    protocol: item.protocol || parsed.protocol,
    address: item.address || parsed.address,
    port: item.port || parsed.port,
    relatedAddress: item.relatedAddress || parsed.relatedAddress,
    relatedPort: item.relatedPort || parsed.relatedPort,
    foundation: item.foundation || parsed.foundation,
    priority: item.priority || parsed.priority,
    tcpType: item.tcpType || parsed.tcpType,
    usernameFragment: item.usernameFragment || parsed.usernameFragment,
    sdpMid: item.sdpMid ?? undefined,
    sdpMLineIndex: item.sdpMLineIndex ?? undefined,
  };
}

function statsCandidate(report: any) {
  return {
    id: report.id,
    candidateType: report.candidateType,
    protocol: report.protocol,
    address: report.address || report.ip,
    port: report.port,
    relatedAddress: report.relatedAddress,
    relatedPort: report.relatedPort,
    relayProtocol: report.relayProtocol,
    foundation: report.foundation,
    priority: report.priority,
    tcpType: report.tcpType,
    usernameFragment: report.usernameFragment,
    networkType: report.networkType,
  };
}

export async function collectRtcStats(pc: RTCPeerConnection) {
  const stats = await pc.getStats();
  const candidates = new Map<string, ReturnType<typeof statsCandidate>>();
  const pairs: any[] = [];
  let selectedPairId: string | undefined;
  stats.forEach((report: any) => {
    if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
      candidates.set(report.id, statsCandidate(report));
    }
    if (report.type === 'transport' && report.selectedCandidatePairId) {
      selectedPairId = report.selectedCandidatePairId;
    }
  });
  stats.forEach((report: any) => {
    if (report.type !== 'candidate-pair') return;
    pairs.push({
      id: report.id,
      state: report.state,
      selected: !!report.selected || report.id === selectedPairId,
      nominated: !!report.nominated,
      priority: report.priority,
      currentRoundTripTime: report.currentRoundTripTime,
      availableOutgoingBitrate: report.availableOutgoingBitrate,
      bytesSent: report.bytesSent,
      bytesReceived: report.bytesReceived,
      requestsSent: report.requestsSent,
      requestsReceived: report.requestsReceived,
      responsesSent: report.responsesSent,
      responsesReceived: report.responsesReceived,
      local: candidates.get(report.localCandidateId),
      remote: candidates.get(report.remoteCandidateId),
    });
  });
  if (!selectedPairId) {
    selectedPairId = pairs.find((pair) => pair.selected)?.id
      || pairs.find((pair) => pair.nominated && pair.state === 'succeeded')?.id;
  }
  return {
    selectedPairId,
    selectedPair: pairs.find((pair) => pair.id === selectedPairId),
    pairs: pairs
      .sort((a, b) => Number(b.selected) - Number(a.selected))
      .slice(0, 40),
  };
}

export function attachRtcDiagnostics(pc: RTCPeerConnection, options: AttachOptions): RtcDiagnosticHandle {
  const base = () => ({
    callId: options.getCallId() || undefined,
    role: options.role,
    mediaKind: options.mediaKind,
  });
  const recordState = (stateKind: string, value: string) => {
    options.recorder({
      event: 'webrtc.state',
      domain: 'webrtc',
      level: value === 'failed' ? 'error' : value === 'disconnected' ? 'warn' : 'info',
      ...(value === 'failed' ? {
        errorCode: 'webrtc_ice_connectivity_failed',
        recoverability: 'retryable' as const,
      } : value === 'disconnected' ? {
        errorCode: 'webrtc_ice_disconnected',
        recoverability: 'automatic' as const,
      } : {}),
      correlation: { callId: options.getCallId() || undefined },
      context: { ...base(), stateKind, value },
    });
  };
  let lastSnapshotKey = '';
  const snapshot = async (reason: string) => {
    const key = `${reason}:${pc.connectionState}:${pc.iceConnectionState}`;
    if (key === lastSnapshotKey) return;
    lastSnapshotKey = key;
    try {
      options.recorder({
        event: 'webrtc.stats',
        domain: 'webrtc',
        correlation: { callId: options.getCallId() || undefined },
        context: { ...base(), reason, ...(await collectRtcStats(pc)) },
      });
    } catch (error) {
      options.recorder({
        event: 'webrtc.stats-failed',
        domain: 'webrtc',
        level: 'warn',
        errorCode: 'webrtc_stats_unavailable',
        recoverability: 'automatic',
        correlation: { callId: options.getCallId() || undefined },
        context: { ...base(), reason, message: error instanceof Error ? error.message : String(error) },
      });
    }
  };
  const onGathering = () => recordState('iceGatheringState', pc.iceGatheringState);
  const onIceConnection = () => {
    recordState('iceConnectionState', pc.iceConnectionState);
    if (['connected', 'completed', 'failed', 'disconnected'].includes(pc.iceConnectionState)) {
      void snapshot(`ice-${pc.iceConnectionState}`);
    }
  };
  const onConnection = () => {
    recordState('connectionState', pc.connectionState);
    if (['connected', 'failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      void snapshot(`connection-${pc.connectionState}`);
    }
  };
  const onSignaling = () => recordState('signalingState', pc.signalingState);
  const onCandidateError = (rawEvent: Event) => {
    const event = rawEvent as Event & { url?: string; errorCode?: number; errorText?: string; address?: string; port?: number };
    options.recorder({
      event: 'webrtc.ice-candidate-error',
      domain: 'webrtc',
      level: 'error',
      errorCode: 'webrtc_ice_candidate_error',
      recoverability: 'retryable',
      correlation: { callId: options.getCallId() || undefined },
      context: {
        ...base(),
        url: event.url,
        code: event.errorCode,
        text: event.errorText,
        address: event.address,
        port: event.port,
      },
    });
  };
  pc.addEventListener('icegatheringstatechange', onGathering);
  pc.addEventListener('iceconnectionstatechange', onIceConnection);
  pc.addEventListener('connectionstatechange', onConnection);
  pc.addEventListener('signalingstatechange', onSignaling);
  pc.addEventListener('icecandidateerror', onCandidateError);
  options.recorder({
    event: 'webrtc.peer-created',
    domain: 'webrtc',
    correlation: { callId: options.getCallId() || undefined },
    context: {
      ...base(),
      iceTransportPolicy: options.configuration.iceTransportPolicy || 'all',
      iceServerCount: options.configuration.iceServers?.length || 0,
      turnServerCount: options.configuration.iceServers?.filter((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some((url) => String(url).startsWith('turn:') || String(url).startsWith('turns:'));
      }).length || 0,
    },
  });
  return {
    candidate(direction, action, candidate, error) {
      options.recorder({
        event: action === 'gathering-complete' ? 'webrtc.gathering-complete' : 'webrtc.candidate',
        domain: 'webrtc',
        level: action === 'add-failed' ? 'error' : 'info',
        ...(action === 'add-failed' ? {
          errorCode: 'webrtc_add_ice_candidate_failed',
          recoverability: 'retryable' as const,
        } : {}),
        correlation: { callId: options.getCallId() || undefined },
        context: {
          ...base(),
          direction,
          action,
          candidate: summarizeIceCandidate(candidate),
          ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
        },
      });
    },
    snapshot,
    close(reason) {
      void snapshot(`close-${reason}`);
      options.recorder({
        event: 'webrtc.peer-closed',
        domain: 'webrtc',
        correlation: { callId: options.getCallId() || undefined },
        context: {
          ...base(),
          reason,
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
          signalingState: pc.signalingState,
        },
      });
      pc.removeEventListener('icegatheringstatechange', onGathering);
      pc.removeEventListener('iceconnectionstatechange', onIceConnection);
      pc.removeEventListener('connectionstatechange', onConnection);
      pc.removeEventListener('signalingstatechange', onSignaling);
      pc.removeEventListener('icecandidateerror', onCandidateError);
    },
  };
}
