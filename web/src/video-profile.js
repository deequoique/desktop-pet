export const RELAY_VIDEO_LIMITS = {
    screen: { width: 640, height: 360, maxFramerate: 5, maxBitrate: 240000 },
    camera: { width: 320, height: 180, maxFramerate: 10, maxBitrate: 120000 },
};
export function calculateScaleResolutionDownBy(source, limit) {
    const width = Number(source.width);
    const height = Number(source.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
        return null;
    return Math.max(1, width / limit.width, height / limit.height);
}
export async function applyVideoSenderProfile(sender, track, profile, kind) {
    try {
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length)
            return { ok: false, error: 'missing_encoding' };
        if (profile === 'relay-low') {
            const limit = RELAY_VIDEO_LIMITS[kind];
            const scale = calculateScaleResolutionDownBy(track.getSettings(), limit);
            if (scale == null)
                return { ok: false, error: 'missing_track_dimensions' };
            for (const encoding of parameters.encodings) {
                encoding.maxBitrate = limit.maxBitrate;
                encoding.maxFramerate = limit.maxFramerate;
                encoding.scaleResolutionDownBy = scale;
            }
        }
        else {
            for (const encoding of parameters.encodings) {
                delete encoding.maxBitrate;
                delete encoding.maxFramerate;
                encoding.scaleResolutionDownBy = 1;
            }
        }
        await sender.setParameters(parameters);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: String(error?.message || error || 'set_parameters_failed') };
    }
}
