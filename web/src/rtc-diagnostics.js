function rawCandidateFields(raw) {
    const parts = raw.replace(/^candidate:/i, '').trim().split(/\s+/);
    const valueAfter = (name) => {
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
export function summarizeIceCandidate(candidate) {
    if (!candidate)
        return null;
    const item = candidate;
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
function statsCandidate(report) {
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
function turnHosts(configuration) {
    const hosts = new Set();
    for (const server of configuration?.iceServers ?? []) {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        for (const raw of urls) {
            const value = String(raw || '');
            if (!/^turns?:/i.test(value))
                continue;
            try {
                hosts.add(new URL(value.replace(/^turns?:/i, 'http:')).hostname);
            }
            catch { }
        }
    }
    return hosts;
}
export function isEffectiveRelayCandidate(candidate, configuration, relatedCandidates = []) {
    if (!candidate)
        return false;
    if (candidate.candidateType === 'relay' || !!candidate.relayProtocol)
        return true;
    const address = candidate.address?.replace(/^\[|\]$/g, '');
    if (!!address && turnHosts(configuration).has(address))
        return true;
    return candidate.candidateType === 'prflx' && relatedCandidates.some((related) => (related !== candidate
        && related.candidateType === 'relay'
        && related.port === candidate.port
        && (!candidate.usernameFragment || related.usernameFragment === candidate.usernameFragment)));
}
export function isEffectiveRelayPair(pair, configuration, relatedCandidates = []) {
    return isEffectiveRelayCandidate(pair?.local, configuration, relatedCandidates)
        || isEffectiveRelayCandidate(pair?.remote, configuration, relatedCandidates);
}
function reportKind(report) {
    return report.kind || report.mediaType;
}
function bitrateKbps(report, field, baselines) {
    if (!baselines)
        return undefined;
    const timestamp = Number(report.timestamp);
    const bytes = Number(report[field]);
    if (!Number.isFinite(timestamp) || !Number.isFinite(bytes))
        return undefined;
    const key = `${report.id}:${field}`;
    const previous = baselines.get(key);
    baselines.set(key, { timestamp, value: bytes });
    if (!previous || bytes < previous.value || timestamp <= previous.timestamp)
        return undefined;
    return Math.round(((bytes - previous.value) * 8) / (timestamp - previous.timestamp));
}
function counterDelta(report, field, baselines) {
    if (!baselines)
        return undefined;
    const timestamp = Number(report.timestamp);
    const value = Number(report[field]);
    if (!Number.isFinite(timestamp) || !Number.isFinite(value))
        return undefined;
    const key = `${report.id}:${field}`;
    const previous = baselines.get(key);
    baselines.set(key, { timestamp, value });
    if (!previous || value < previous.value || timestamp <= previous.timestamp)
        return undefined;
    return value - previous.value;
}
function intervalLossRatio(report, baselines) {
    const lost = counterDelta(report, 'packetsLost', baselines);
    const received = counterDelta(report, 'packetsReceived', baselines);
    if (lost == null || received == null || lost + received <= 0)
        return undefined;
    return lost / (lost + received);
}
function videoRtp(report, byteField, baselines) {
    return {
        id: report.id,
        bitrateKbps: bitrateKbps(report, byteField, baselines),
        packetsSent: report.packetsSent,
        packetsReceived: report.packetsReceived,
        packetsLost: report.packetsLost,
        retransmittedPacketsSent: report.retransmittedPacketsSent,
        framesEncoded: report.framesEncoded,
        framesDecoded: report.framesDecoded,
        framesDropped: report.framesDropped,
        framesPerSecond: report.framesPerSecond,
        frameWidth: report.frameWidth,
        frameHeight: report.frameHeight,
        keyFramesEncoded: report.keyFramesEncoded,
        nackCount: report.nackCount,
        pliCount: report.pliCount,
        jitter: report.jitter,
        fractionLost: Number.isFinite(Number(report.fractionLost))
            ? Number(report.fractionLost)
            : intervalLossRatio(report, baselines),
        roundTripTime: report.roundTripTime,
        freezeCount: report.freezeCount,
        totalFreezesDuration: report.totalFreezesDuration,
        qualityLimitationReason: report.qualityLimitationReason,
    };
}
function collectFromReport(stats, configuration, baselines, includePairs = false, connected = false) {
    const candidates = new Map();
    const pairs = [];
    let selectedPairId;
    let outboundVideo;
    let remoteInboundVideo;
    let inboundVideo;
    let inboundAudio;
    stats.forEach((report) => {
        if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
            candidates.set(report.id, statsCandidate(report));
        }
        if (report.type === 'transport' && report.selectedCandidatePairId) {
            selectedPairId = report.selectedCandidatePairId;
        }
        if (report.type === 'outbound-rtp' && !report.isRemote && reportKind(report) === 'video') {
            outboundVideo = videoRtp(report, 'bytesSent', baselines);
        }
        if (report.type === 'remote-inbound-rtp' && reportKind(report) === 'video') {
            remoteInboundVideo = videoRtp(report, 'bytesReceived', baselines);
        }
        if (report.type === 'inbound-rtp' && !report.isRemote && reportKind(report) === 'video') {
            inboundVideo = videoRtp(report, 'bytesReceived', baselines);
        }
        if (report.type === 'inbound-rtp' && !report.isRemote && reportKind(report) === 'audio') {
            inboundAudio = {
                packetsReceived: report.packetsReceived,
                packetsLost: report.packetsLost,
                jitter: report.jitter,
                concealedSamples: report.concealedSamples,
                concealmentEvents: report.concealmentEvents,
            };
        }
    });
    const relatedCandidates = [...candidates.values()];
    stats.forEach((report) => {
        if (report.type !== 'candidate-pair')
            return;
        const pair = {
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
        };
        pair.effectiveRelayed = isEffectiveRelayPair(pair, configuration, relatedCandidates);
        pairs.push(pair);
    });
    if (!selectedPairId) {
        selectedPairId = pairs.find((pair) => pair.selected)?.id
            || pairs.find((pair) => pair.nominated && pair.state === 'succeeded')?.id;
    }
    const selectedPair = pairs.find((pair) => pair.id === selectedPairId);
    const roundTripTime = remoteInboundVideo?.roundTripTime ?? selectedPair?.currentRoundTripTime;
    const jitter = remoteInboundVideo?.jitter ?? inboundVideo?.jitter ?? inboundAudio?.jitter;
    const result = {
        sampledAt: new Date().toISOString(),
        connected,
        selectedPairId,
        selectedPair,
        effectiveRelayed: isEffectiveRelayPair(selectedPair, configuration, relatedCandidates),
        roundTripTimeMs: Number.isFinite(Number(roundTripTime)) ? Math.round(Number(roundTripTime) * 1000) : undefined,
        availableOutgoingBitrate: selectedPair?.availableOutgoingBitrate,
        lossRatio: remoteInboundVideo?.fractionLost ?? inboundVideo?.fractionLost,
        jitterMs: Number.isFinite(Number(jitter)) ? Math.round(Number(jitter) * 1000) : undefined,
        outboundVideo,
        remoteInboundVideo,
        inboundVideo,
        inboundAudio,
    };
    return {
        ...result,
        ...(includePairs ? {
            pairCount: pairs.length,
            pairs: pairs
                .filter((pair) => pair.id !== selectedPairId)
                .sort((a, b) => Number(b.selected) - Number(a.selected))
                .slice(0, 8),
        } : {}),
    };
}
export async function collectRtcNetworkSample(pc, configuration, baselines) {
    const stats = await pc.getStats();
    const connected = pc.connectionState === 'connected'
        || pc.iceConnectionState === 'connected'
        || pc.iceConnectionState === 'completed';
    return collectFromReport(stats, configuration, baselines, false, connected);
}
export async function collectRtcStats(pc, configuration) {
    const stats = await pc.getStats();
    const connected = pc.connectionState === 'connected'
        || pc.iceConnectionState === 'connected'
        || pc.iceConnectionState === 'completed';
    return collectFromReport(stats, configuration, undefined, true, connected);
}
export function attachRtcDiagnostics(pc, options) {
    const base = () => ({
        callId: options.getCallId() || undefined,
        role: options.role,
        mediaKind: options.mediaKind,
    });
    const recordState = (stateKind, value) => {
        options.recorder({
            event: 'webrtc.state',
            domain: 'webrtc',
            level: value === 'failed' ? 'error' : value === 'disconnected' ? 'warn' : 'info',
            ...(value === 'failed' ? {
                errorCode: 'webrtc_ice_connectivity_failed',
                recoverability: 'retryable',
            } : value === 'disconnected' ? {
                errorCode: 'webrtc_ice_disconnected',
                recoverability: 'automatic',
            } : {}),
            correlation: { callId: options.getCallId() || undefined },
            context: { ...base(), stateKind, value },
        });
    };
    let lastSnapshotKey = '';
    let closed = false;
    let pollPending = false;
    let pollCount = 0;
    const baselines = new Map();
    const snapshot = async (reason) => {
        const key = `${reason}:${pc.connectionState}:${pc.iceConnectionState}`;
        if (key === lastSnapshotKey)
            return;
        lastSnapshotKey = key;
        try {
            options.recorder({
                event: 'webrtc.stats',
                domain: 'webrtc',
                correlation: { callId: options.getCallId() || undefined },
                context: { ...base(), reason, ...(await collectRtcStats(pc, options.configuration)) },
            });
        }
        catch (error) {
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
    const poll = async () => {
        if (closed || pollPending || pc.connectionState === 'closed')
            return;
        pollPending = true;
        try {
            const sample = await collectRtcNetworkSample(pc, options.configuration, baselines);
            if (closed)
                return;
            options.onSample?.(sample);
            pollCount += 1;
            if (pollCount % 5 === 0) {
                options.recorder({
                    event: 'webrtc.network-sample',
                    domain: 'webrtc',
                    correlation: { callId: options.getCallId() || undefined },
                    context: { ...base(), ...sample },
                });
            }
        }
        catch (error) {
            if (pollCount % 5 === 0) {
                options.recorder({
                    event: 'webrtc.stats-failed',
                    domain: 'webrtc',
                    level: 'warn',
                    errorCode: 'webrtc_stats_unavailable',
                    recoverability: 'automatic',
                    correlation: { callId: options.getCallId() || undefined },
                    context: { ...base(), reason: 'periodic', message: error instanceof Error ? error.message : String(error) },
                });
            }
            pollCount += 1;
        }
        finally {
            pollPending = false;
        }
    };
    const onGathering = () => recordState('iceGatheringState', pc.iceGatheringState);
    const onIceConnection = () => {
        recordState('iceConnectionState', pc.iceConnectionState);
        if (['connected', 'completed', 'failed', 'disconnected'].includes(pc.iceConnectionState)) {
            void snapshot(`ice-${pc.iceConnectionState}`);
            if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')
                void poll();
        }
    };
    const onConnection = () => {
        recordState('connectionState', pc.connectionState);
        if (['connected', 'failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
            void snapshot(`connection-${pc.connectionState}`);
            if (pc.connectionState === 'connected')
                void poll();
        }
    };
    const onSignaling = () => recordState('signalingState', pc.signalingState);
    const onCandidateError = (rawEvent) => {
        const event = rawEvent;
        const expectedInterfaceFailure = event.errorCode === 600 || event.errorCode === 701;
        options.recorder({
            event: 'webrtc.ice-candidate-error',
            domain: 'webrtc',
            level: expectedInterfaceFailure ? 'warn' : 'error',
            errorCode: 'webrtc_ice_candidate_error',
            recoverability: expectedInterfaceFailure ? 'automatic' : 'retryable',
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
    const pollTimer = window.setInterval(() => void poll(), Math.max(1000, options.sampleIntervalMs ?? 2000));
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
                    recoverability: 'retryable',
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
            if (closed)
                return;
            closed = true;
            window.clearInterval(pollTimer);
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
