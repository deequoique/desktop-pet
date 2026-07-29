const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../node_modules/typescript');

function loadTypeScriptModule(file) {
  const source = fs.readFileSync(file, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const loaded = { exports: {} };
  Function('module', 'exports', output)(loaded, loaded.exports);
  return loaded.exports;
}

const modules = [
  ['pet', path.join(__dirname, '..', 'src', 'renderer', 'video-profile.ts')],
  ['web', path.join(__dirname, '..', '..', 'web', 'src', 'video-profile.ts')],
].map(([name, file]) => [name, loadTypeScriptModule(file)]);

for (const [runtime, profile] of modules) {
  test(`${runtime} relay video profile calculates bounded proportional scale`, () => {
    const screen = profile.RELAY_VIDEO_LIMITS.screen;
    assert.deepEqual(screen, { width: 640, height: 360, maxFramerate: 5, maxBitrate: 240_000 });
    assert.equal(profile.calculateScaleResolutionDownBy({ width: 1920, height: 1080 }, screen), 3);
    assert.equal(profile.calculateScaleResolutionDownBy({ width: 800, height: 600 }, screen), 5 / 3);
    assert.equal(profile.calculateScaleResolutionDownBy({ width: 320, height: 180 }, screen), 1);
    assert.equal(profile.calculateScaleResolutionDownBy({}, screen), null);
  });

  test(`${runtime} screen P2P states are monotonic while TURN stays at five fps`, () => {
    assert.deepEqual(profile.SCREEN_P2P_STATES, [
      { qualityLevel: 2, frameRateTarget: 30 },
      { qualityLevel: 3, frameRateTarget: 30 },
      { qualityLevel: 3, frameRateTarget: 45 },
      { qualityLevel: 4, frameRateTarget: 45 },
      { qualityLevel: 4, frameRateTarget: 60 },
      { qualityLevel: 5, frameRateTarget: 60 },
      { qualityLevel: 5, frameRateTarget: 90 },
    ]);
    assert.deepEqual(profile.RELAY_VIDEO_LIMITS.screen, {
      width: 640, height: 360, maxFramerate: 5, maxBitrate: 240_000,
    });
    assert.deepEqual(
      Object.values(profile.VIDEO_QUALITY_LEVELS.camera).map((item) => item.maxFramerate),
      [10, 12, 15, 20, 24],
    );
  });

  test(`${runtime} video profile applies independent P2P screen fps and relay bounds`, async () => {
    let applied;
    const sender = {
      getParameters: () => ({ encodings: [{ rid: 'main', active: true }] }),
      setParameters: async (parameters) => { applied = parameters; },
    };
    const track = { getSettings: () => ({ width: 2560, height: 1440 }) };
    assert.deepEqual(await profile.applyVideoSenderProfile(sender, track, 'relay-low', 'camera'), { ok: true, level: 1 });
    assert.equal(applied.encodings[0].rid, 'main');
    assert.equal(applied.encodings[0].active, true);
    assert.equal(applied.encodings[0].maxBitrate, 120_000);
    assert.equal(applied.encodings[0].maxFramerate, 10);
    assert.equal(applied.encodings[0].scaleResolutionDownBy, 8);

    sender.getParameters = () => ({ encodings: [{ ...applied.encodings[0] }] });
    assert.deepEqual(await profile.applyVideoSenderProfile(sender, track, 'normal', 'camera', 3), { ok: true, level: 3 });
    assert.equal(applied.encodings[0].maxBitrate, 500_000);
    assert.equal(applied.encodings[0].maxFramerate, 15);
    assert.equal(applied.encodings[0].scaleResolutionDownBy, 4);

    sender.getParameters = () => ({ encodings: [{ rid: 'screen', active: true }] });
    assert.deepEqual(
      await profile.applyVideoSenderProfile(sender, track, 'normal', 'screen', 2, 30),
      { ok: true, level: 2 },
    );
    assert.equal(applied.degradationPreference, 'maintain-framerate');
    assert.equal(applied.encodings[0].maxBitrate, 600_000);
    assert.equal(applied.encodings[0].maxFramerate, 30);
    assert.equal(applied.encodings[0].scaleResolutionDownBy, 3);

    sender.getParameters = () => ({ encodings: [{ rid: 'screen', active: true }] });
    assert.deepEqual(
      await profile.applyVideoSenderProfile(sender, track, 'normal', 'screen', 5, 90),
      { ok: true, level: 5 },
    );
    assert.equal(applied.encodings[0].maxBitrate, 12_000_000);
    assert.equal(applied.encodings[0].maxFramerate, 90);
    assert.equal(applied.encodings[0].scaleResolutionDownBy, 1);

    sender.getParameters = () => ({ encodings: [{ rid: 'screen', active: true }] });
    assert.deepEqual(
      await profile.applyVideoSenderProfile(sender, track, 'relay-low', 'screen', 5, 90),
      { ok: true, level: 1 },
    );
    assert.equal(applied.encodings[0].maxBitrate, 240_000);
    assert.equal(applied.encodings[0].maxFramerate, 5);
    assert.equal(applied.encodings[0].scaleResolutionDownBy, 4);
  });

  test(`${runtime} relay video profile fails closed when dimensions or setParameters are unavailable`, async () => {
    const missingDimensions = {
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async () => { throw new Error('should not run'); },
    };
    assert.deepEqual(
      await profile.applyVideoSenderProfile(missingDimensions, { getSettings: () => ({}) }, 'relay-low', 'screen'),
      { ok: false, error: 'missing_track_dimensions' },
    );
    const rejected = {
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async () => { throw new Error('unsupported'); },
    };
    assert.deepEqual(
      await profile.applyVideoSenderProfile(rejected, { getSettings: () => ({ width: 640, height: 360 }) }, 'relay-low', 'screen'),
      { ok: false, error: 'unsupported' },
    );
  });

  test(`${runtime} camera adaptive quality uses health instead of hard-locking on bandwidth estimate`, () => {
    assert.equal(profile.recommendVideoQualityLevel({
      connected: true,
      roundTripTimeMs: 724,
      availableOutgoingBitrate: 300_000,
    }, 'screen'), 1);
    assert.equal(profile.recommendVideoQualityLevel({
      connected: true, roundTripTimeMs: 29, availableOutgoingBitrate: 300_000, lossRatio: 0, jitterMs: 5,
    }, 'screen'), 5);

    const controller = new profile.AdaptiveVideoQualityController(3);
    const healthyLowEstimate = {
      connected: true,
      roundTripTimeMs: 29,
      availableOutgoingBitrate: 300_000,
      lossRatio: 0,
      jitterMs: 5,
    };
    assert.equal(controller.update(healthyLowEstimate, 'camera').level, 3);

    const degraded = controller.update({
      connected: true,
      roundTripTimeMs: 724,
      availableOutgoingBitrate: 300_000,
    }, 'camera');
    assert.equal(degraded.level, 1);
    assert.equal(degraded.reason, 'hard-degrade');
    assert.deepEqual(controller.update(healthyLowEstimate, 'camera', true), {
      level: 1,
      targetLevel: 1,
      healthTargetLevel: 1,
      bandwidthLevel: 1,
      changed: false,
      reason: 'relay',
    });
  });

  test(`${runtime} screen controller escapes low-estimate lock and follows the seven states`, () => {
    const healthy = {
      connected: true,
      roundTripTimeMs: 29,
      availableOutgoingBitrate: 12_000_000,
      lossRatio: 0,
      jitterMs: 5,
    };
    const lowEstimate = {
      connected: true,
      roundTripTimeMs: 29,
      availableOutgoingBitrate: 300_000,
      lossRatio: 0,
      jitterMs: 5,
      qualityLimitationReason: 'bandwidth',
    };
    const controller = new profile.AdaptiveScreenQualityController();
    assert.deepEqual(controller.current(), { qualityLevel: 2, frameRateTarget: 30 });
    for (let index = 0; index < 5; index += 1) {
      assert.equal(controller.update(lowEstimate).changed, false);
    }
    assert.deepEqual(controller.update(lowEstimate), {
      state: { qualityLevel: 3, frameRateTarget: 30 },
      healthTargetLevel: 5,
      bandwidthLevel: 1,
      changed: true,
      reason: 'recovery-probe',
    });

    const expected = profile.SCREEN_P2P_STATES.slice(2);
    for (const state of expected) {
      const samples = state.qualityLevel === 5 ? 6 : 3;
      let decision;
      for (let index = 0; index < samples; index += 1) decision = controller.update(healthy);
      assert.equal(decision.changed, true);
      assert.deepEqual(decision.state, state);
    }

    const moderateCongestion = {
      connected: true,
      roundTripTimeMs: 150,
      availableOutgoingBitrate: 7_000_000,
      lossRatio: 0,
      jitterMs: 5,
    };
    assert.equal(controller.update(moderateCongestion).changed, false);
    assert.deepEqual(controller.update(moderateCongestion), {
      state: { qualityLevel: 5, frameRateTarget: 60 },
      healthTargetLevel: 4,
      bandwidthLevel: 4,
      changed: true,
      reason: 'congestion-step-down',
    });

    const hard = controller.update({
      connected: true,
      roundTripTimeMs: 600,
      availableOutgoingBitrate: 300_000,
      lossRatio: 0.1,
      jitterMs: 200,
    });
    assert.deepEqual(hard.state, { qualityLevel: 2, frameRateTarget: 30 });
    assert.equal(hard.reason, 'hard-degrade');

    assert.deepEqual(controller.update(healthy, true), {
      state: { qualityLevel: 1, frameRateTarget: 5 },
      healthTargetLevel: 1,
      bandwidthLevel: 5,
      changed: true,
      reason: 'relay',
    });
  });
}
