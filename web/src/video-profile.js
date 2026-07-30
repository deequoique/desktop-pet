export const VIDEO_QUALITY_LEVELS = {
    screen: {
        1: { width: 640, height: 360, maxFramerate: 60, maxBitrate: 800000 },
        2: { width: 854, height: 480, maxFramerate: 60, maxBitrate: 1200000 },
        3: { width: 1280, height: 720, maxFramerate: 60, maxBitrate: 2500000 },
        4: { width: 1920, height: 1080, maxFramerate: 60, maxBitrate: 5000000 },
        5: { width: 2560, height: 1440, maxFramerate: 60, maxBitrate: 8000000 },
    },
    camera: {
        1: { width: 320, height: 180, maxFramerate: 10, maxBitrate: 120000 },
        2: { width: 480, height: 270, maxFramerate: 12, maxBitrate: 240000 },
        3: { width: 640, height: 360, maxFramerate: 15, maxBitrate: 500000 },
        4: { width: 960, height: 540, maxFramerate: 20, maxBitrate: 900000 },
        5: { width: 1280, height: 720, maxFramerate: 24, maxBitrate: 1500000 },
    },
};
export const SCREEN_P2P_STATES = [
    { qualityLevel: 2, frameRateTarget: 30 },
    { qualityLevel: 3, frameRateTarget: 30 },
    { qualityLevel: 3, frameRateTarget: 45 },
    { qualityLevel: 4, frameRateTarget: 45 },
    { qualityLevel: 4, frameRateTarget: 60 },
    { qualityLevel: 5, frameRateTarget: 60 },
    { qualityLevel: 5, frameRateTarget: 90 },
];
export const SCREEN_RELAY_STATES = [
    { qualityLevel: 2, frameRateTarget: 30 },
    { qualityLevel: 3, frameRateTarget: 30 },
    { qualityLevel: 3, frameRateTarget: 45 },
];
export const RELAY_VIDEO_LIMITS = {
    screen: { width: 1280, height: 720, maxFramerate: 45, maxBitrate: 1875000 },
    camera: { width: 320, height: 180, maxFramerate: 10, maxBitrate: 120000 },
};
export function calculateScaleResolutionDownBy(source, limit) {
    const width = Number(source.width);
    const height = Number(source.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
        return null;
    return Math.max(1, width / limit.width, height / limit.height);
}
function boundedLevel(value) {
    return Math.max(1, Math.min(5, Math.round(value)));
}
function degrade(target, maximum) {
    return Math.min(target, maximum);
}
function isHealthySample(metrics) {
    if (metrics.connected === false)
        return false;
    const values = [
        Number(metrics.roundTripTimeMs),
        Number(metrics.lossRatio),
        Number(metrics.jitterMs),
    ];
    if (!values.some(Number.isFinite))
        return false;
    const rtt = values[0];
    const loss = values[1];
    const jitter = values[2];
    return (!Number.isFinite(rtt) || rtt < 120)
        && (!Number.isFinite(loss) || loss < 0.015)
        && (!Number.isFinite(jitter) || jitter < 40);
}
export function recommendVideoQualityLevel(metrics, _kind) {
    if (metrics.connected === false)
        return 1;
    let target = 5;
    const rtt = Number(metrics.roundTripTimeMs);
    if (Number.isFinite(rtt)) {
        if (rtt >= 550)
            target = 1;
        else if (rtt >= 350)
            target = degrade(target, 2);
        else if (rtt >= 220)
            target = degrade(target, 3);
        else if (rtt >= 120)
            target = degrade(target, 4);
    }
    const loss = Number(metrics.lossRatio);
    if (Number.isFinite(loss)) {
        if (loss >= 0.09)
            target = 1;
        else if (loss >= 0.05)
            target = degrade(target, 2);
        else if (loss >= 0.03)
            target = degrade(target, 3);
        else if (loss >= 0.015)
            target = degrade(target, 4);
    }
    const jitter = Number(metrics.jitterMs);
    if (Number.isFinite(jitter)) {
        if (jitter >= 180)
            target = 1;
        else if (jitter >= 120)
            target = degrade(target, 2);
        else if (jitter >= 80)
            target = degrade(target, 3);
        else if (jitter >= 40)
            target = degrade(target, 4);
    }
    return target;
}
export function estimateBandwidthQualityLevel(metrics, kind) {
    const available = Number(metrics.availableOutgoingBitrate);
    if (!Number.isFinite(available) || available <= 0)
        return 5;
    const reserve = kind === 'screen' ? 128000 : 32000;
    const usable = Math.max(0, available - reserve);
    for (let level = 5; level >= 1; level -= 1) {
        const candidate = level;
        if (VIDEO_QUALITY_LEVELS[kind][candidate].maxBitrate * 1.25 <= usable)
            return candidate;
    }
    return 1;
}
export class AdaptiveVideoQualityController {
    constructor(initialLevel = 3) {
        this.badSamples = 0;
        this.stableSamples = 0;
        this.level = boundedLevel(initialLevel);
    }
    current() {
        return this.level;
    }
    reset(level = 3) {
        this.level = boundedLevel(level);
        this.badSamples = 0;
        this.stableSamples = 0;
        return this.level;
    }
    update(metrics, kind, relayed = false) {
        const measuredHealthLevel = recommendVideoQualityLevel(metrics, kind);
        const healthTargetLevel = relayed ? 1 : measuredHealthLevel;
        const bandwidthLevel = estimateBandwidthQualityLevel(metrics, kind);
        const targetLevel = healthTargetLevel;
        if (relayed) {
            const changed = this.level !== 1;
            this.level = 1;
            this.badSamples = 0;
            this.stableSamples = 0;
            return { level: 1, targetLevel: 1, healthTargetLevel: 1, bandwidthLevel, changed, reason: 'relay' };
        }
        if (healthTargetLevel < this.level) {
            this.stableSamples = 0;
            this.badSamples += 1;
            const severe = healthTargetLevel === 1 || this.level - healthTargetLevel >= 2;
            if (severe || this.badSamples >= 2) {
                this.level = healthTargetLevel;
                this.badSamples = 0;
                return {
                    level: this.level,
                    targetLevel,
                    healthTargetLevel,
                    bandwidthLevel,
                    changed: true,
                    reason: severe ? 'hard-degrade' : 'degrade',
                };
            }
            return { level: this.level, targetLevel, healthTargetLevel, bandwidthLevel, changed: false, reason: 'stable' };
        }
        this.badSamples = 0;
        if (healthTargetLevel > this.level && isHealthySample(metrics)) {
            this.stableSamples += 1;
            const bandwidthPressure = metrics.qualityLimitationReason === 'bandwidth' && bandwidthLevel < this.level;
            if (this.stableSamples >= (bandwidthPressure ? 12 : 6)) {
                this.level = boundedLevel(this.level + 1);
                this.stableSamples = 0;
                return {
                    level: this.level,
                    targetLevel,
                    healthTargetLevel,
                    bandwidthLevel,
                    changed: true,
                    reason: bandwidthPressure ? 'recovery-probe' : 'upgrade',
                };
            }
        }
        else {
            this.stableSamples = 0;
        }
        return { level: this.level, targetLevel, healthTargetLevel, bandwidthLevel, changed: false, reason: 'stable' };
    }
}
function copyScreenState(state) {
    return { qualityLevel: state.qualityLevel, frameRateTarget: state.frameRateTarget };
}
export class AdaptiveScreenQualityController {
    constructor() {
        this.stateIndex = 0;
        this.relayed = false;
        this.badSamples = 0;
        this.stableSamples = 0;
    }
    current() {
        const states = this.relayed ? SCREEN_RELAY_STATES : SCREEN_P2P_STATES;
        return copyScreenState(states[this.stateIndex]);
    }
    reset(relayed = false) {
        this.relayed = relayed;
        this.stateIndex = 0;
        this.badSamples = 0;
        this.stableSamples = 0;
        return this.current();
    }
    update(metrics, relayed = false) {
        const bandwidthLevel = estimateBandwidthQualityLevel(metrics, 'screen');
        const healthTargetLevel = recommendVideoQualityLevel(metrics, 'screen');
        if (this.relayed !== relayed) {
            this.relayed = relayed;
            this.stateIndex = 0;
            this.badSamples = 0;
            this.stableSamples = 0;
            return {
                state: this.current(),
                healthTargetLevel,
                bandwidthLevel,
                changed: true,
                reason: relayed ? 'relay' : 'recovery-probe',
            };
        }
        if (healthTargetLevel === 1) {
            const changed = this.stateIndex !== 0;
            this.stateIndex = 0;
            this.badSamples = 0;
            this.stableSamples = 0;
            return {
                state: this.current(),
                healthTargetLevel,
                bandwidthLevel,
                changed,
                reason: changed ? 'hard-degrade' : 'stable',
            };
        }
        const states = this.relayed ? SCREEN_RELAY_STATES : SCREEN_P2P_STATES;
        const current = states[this.stateIndex];
        const relayStateUnderPressure = this.relayed
            && this.stateIndex > 0
            && !isHealthySample(metrics);
        if (healthTargetLevel < current.qualityLevel || relayStateUnderPressure) {
            this.stableSamples = 0;
            this.badSamples += 1;
            if (this.badSamples >= 2) {
                this.stateIndex = Math.max(0, this.stateIndex - 1);
                this.badSamples = 0;
                return {
                    state: this.current(),
                    healthTargetLevel,
                    bandwidthLevel,
                    changed: true,
                    reason: 'congestion-step-down',
                };
            }
            return { state: this.current(), healthTargetLevel, bandwidthLevel, changed: false, reason: 'stable' };
        }
        this.badSamples = 0;
        const next = states[this.stateIndex + 1];
        if (next && healthTargetLevel >= next.qualityLevel && isHealthySample(metrics)) {
            this.stableSamples += 1;
            const bandwidthPressure = metrics.qualityLimitationReason === 'bandwidth'
                && bandwidthLevel < next.qualityLevel;
            const baseSamples = this.relayed
                ? this.stateIndex === 0 ? 3 : 6
                : next.qualityLevel === 5 ? 6 : 3;
            const requiredSamples = bandwidthPressure ? baseSamples * 2 : baseSamples;
            if (this.stableSamples >= requiredSamples) {
                this.stateIndex += 1;
                this.stableSamples = 0;
                return {
                    state: this.current(),
                    healthTargetLevel,
                    bandwidthLevel,
                    changed: true,
                    reason: bandwidthPressure
                        ? 'recovery-probe'
                        : next.qualityLevel > current.qualityLevel
                            ? 'quality-upgrade'
                            : 'frame-rate-upgrade',
                };
            }
        }
        else {
            this.stableSamples = 0;
        }
        return { state: this.current(), healthTargetLevel, bandwidthLevel, changed: false, reason: 'stable' };
    }
}
function screenP2PLimit(level, frameRateTarget) {
    const base = VIDEO_QUALITY_LEVELS.screen[level];
    const maxFramerate = Math.max(1, Math.min(90, Math.round(frameRateTarget)));
    return {
        ...base,
        maxFramerate,
        maxBitrate: Math.round(base.maxBitrate * maxFramerate / 60),
    };
}
function relayScreenState(requestedLevel, requestedFrameRate) {
    const level = Math.min(3, boundedLevel(requestedLevel));
    const frameRate = Math.max(30, Math.min(45, Math.round(requestedFrameRate)));
    let selected = SCREEN_RELAY_STATES[0];
    for (const state of SCREEN_RELAY_STATES) {
        if (state.qualityLevel <= level && state.frameRateTarget <= frameRate)
            selected = state;
    }
    return copyScreenState(selected);
}
export async function applyVideoSenderProfile(sender, track, profile, kind, requestedLevel = profile === 'relay-low' ? 1 : 5, requestedFrameRate) {
    try {
        if (profile === 'relay-low' && kind === 'camera') {
            return { ok: false, error: 'relay_camera_disabled' };
        }
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length)
            return { ok: false, error: 'missing_encoding' };
        let level = boundedLevel(requestedLevel);
        let limit;
        if (kind === 'screen') {
            if (profile === 'relay-low') {
                const state = relayScreenState(level, requestedFrameRate ?? 30);
                level = state.qualityLevel;
                limit = screenP2PLimit(level, state.frameRateTarget);
            }
            else {
                limit = screenP2PLimit(level, requestedFrameRate ?? VIDEO_QUALITY_LEVELS.screen[level].maxFramerate);
            }
        }
        else {
            limit = VIDEO_QUALITY_LEVELS.camera[level];
        }
        const scale = calculateScaleResolutionDownBy(track.getSettings(), limit);
        if (scale == null)
            return { ok: false, error: 'missing_track_dimensions' };
        parameters.degradationPreference = kind === 'screen'
            ? 'maintain-framerate'
            : 'balanced';
        for (const encoding of parameters.encodings) {
            encoding.maxBitrate = limit.maxBitrate;
            encoding.maxFramerate = limit.maxFramerate;
            encoding.scaleResolutionDownBy = scale;
        }
        await sender.setParameters(parameters);
        return { ok: true, level };
    }
    catch (error) {
        return { ok: false, error: String(error?.message || error || 'set_parameters_failed') };
    }
}
