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

  test(`${runtime} five-tier video profile preserves encodings and applies bounded parameters`, async () => {
    let applied;
    const sender = {
      getParameters: () => ({ encodings: [{ rid: 'main', active: true }] }),
      setParameters: async (parameters) => { applied = parameters; },
    };
    const track = { getSettings: () => ({ width: 1280, height: 720 }) };
    assert.deepEqual(await profile.applyVideoSenderProfile(sender, track, 'relay-low', 'camera'), { ok: true, level: 1 });
    assert.equal(applied.encodings[0].rid, 'main');
    assert.equal(applied.encodings[0].active, true);
    assert.equal(applied.encodings[0].maxBitrate, 120_000);
    assert.equal(applied.encodings[0].maxFramerate, 10);
    assert.equal(applied.encodings[0].scaleResolutionDownBy, 4);

    sender.getParameters = () => ({ encodings: [{ ...applied.encodings[0] }] });
    assert.deepEqual(await profile.applyVideoSenderProfile(sender, track, 'normal', 'camera', 3), { ok: true, level: 3 });
    assert.equal(applied.encodings[0].maxBitrate, 500_000);
    assert.equal(applied.encodings[0].maxFramerate, 15);
    assert.equal(applied.encodings[0].scaleResolutionDownBy, 2);
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

  test(`${runtime} adaptive quality drops quickly and upgrades one level after stable samples`, () => {
    assert.equal(profile.recommendVideoQualityLevel({
      connected: true,
      roundTripTimeMs: 724,
      availableOutgoingBitrate: 300_000,
    }, 'screen'), 1);
    assert.equal(profile.recommendVideoQualityLevel({
      connected: true,
      roundTripTimeMs: 40,
      availableOutgoingBitrate: 4_000_000,
      lossRatio: 0,
      jitterMs: 5,
    }, 'screen'), 4);

    const controller = new profile.AdaptiveVideoQualityController(3);
    const degraded = controller.update({
      connected: true,
      roundTripTimeMs: 724,
      availableOutgoingBitrate: 300_000,
    }, 'screen');
    assert.deepEqual(degraded, {
      level: 1, targetLevel: 1, changed: true, reason: 'degrade',
    });

    const stable = {
      connected: true,
      roundTripTimeMs: 40,
      availableOutgoingBitrate: 5_000_000,
      lossRatio: 0,
      jitterMs: 4,
    };
    for (let index = 0; index < 5; index += 1) {
      assert.equal(controller.update(stable, 'screen').changed, false);
    }
    assert.deepEqual(controller.update(stable, 'screen'), {
      level: 2, targetLevel: 5, changed: true, reason: 'upgrade',
    });
    assert.deepEqual(controller.update(stable, 'screen', true), {
      level: 1, targetLevel: 1, changed: true, reason: 'relay',
    });
  });
}
