export const VIDEO_QUALITY_LEVELS = {
    screen: {
        1: { width: 640, height: 360, maxFramerate: 5, maxBitrate: 240000 },
        2: { width: 854, height: 480, maxFramerate: 7, maxBitrate: 450000 },
        3: { width: 1280, height: 720, maxFramerate: 10, maxBitrate: 900000 },
        4: { width: 1600, height: 900, maxFramerate: 12, maxBitrate: 1500000 },
        5: { width: 2560, height: 1440, maxFramerate: 15, maxBitrate: 3500000 },
    },
    camera: {
        1: { width: 320, height: 180, maxFramerate: 10, maxBitrate: 120000 },
        2: { width: 480, height: 270, maxFramerate: 12, maxBitrate: 240000 },
        3: { width: 640, height: 360, maxFramerate: 15, maxBitrate: 500000 },
        4: { width: 960, height: 540, maxFramerate: 20, maxBitrate: 900000 },
        5: { width: 1280, height: 720, maxFramerate: 24, maxBitrate: 1500000 },
    },
};
export const RELAY_VIDEO_LIMITS = {
    screen: VIDEO_QUALITY_LEVELS.screen[1],
    camera: VIDEO_QUALITY_LEVELS.camera[1],
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
export function recommendVideoQualityLevel(metrics, kind) {
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
    const available = Number(metrics.availableOutgoingBitrate);
    if (Number.isFinite(available) && available > 0) {
        const reserve = kind === 'screen' ? 128000 : 32000;
        const usable = Math.max(0, available - reserve);
        let capacityLevel = 1;
        for (let level = 5; level >= 1; level -= 1) {
            const candidate = level;
            if (VIDEO_QUALITY_LEVELS[kind][candidate].maxBitrate * 1.25 <= usable) {
                capacityLevel = candidate;
                break;
            }
        }
        target = degrade(target, capacityLevel);
    }
    if (metrics.qualityLimitationReason === 'bandwidth')
        target = degrade(target, 4);
    return target;
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
        const targetLevel = relayed ? 1 : recommendVideoQualityLevel(metrics, kind);
        if (targetLevel < this.level) {
            this.stableSamples = 0;
            this.badSamples += 1;
            const severe = targetLevel === 1 || this.level - targetLevel >= 2;
            if (severe || this.badSamples >= 2) {
                this.level = targetLevel;
                this.badSamples = 0;
                return { level: this.level, targetLevel, changed: true, reason: relayed ? 'relay' : 'degrade' };
            }
            return { level: this.level, targetLevel, changed: false, reason: 'stable' };
        }
        this.badSamples = 0;
        if (targetLevel > this.level) {
            this.stableSamples += 1;
            if (this.stableSamples >= 6) {
                this.level = boundedLevel(this.level + 1);
                this.stableSamples = 0;
                return { level: this.level, targetLevel, changed: true, reason: 'upgrade' };
            }
            return { level: this.level, targetLevel, changed: false, reason: 'stable' };
        }
        this.stableSamples = 0;
        return { level: this.level, targetLevel, changed: false, reason: 'stable' };
    }
}
export async function applyVideoSenderProfile(sender, track, profile, kind, requestedLevel = profile === 'relay-low' ? 1 : 5) {
    try {
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length)
            return { ok: false, error: 'missing_encoding' };
        const level = profile === 'relay-low' ? 1 : boundedLevel(requestedLevel);
        const limit = VIDEO_QUALITY_LEVELS[kind][level];
        const scale = calculateScaleResolutionDownBy(track.getSettings(), limit);
        if (scale == null)
            return { ok: false, error: 'missing_track_dimensions' };
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
