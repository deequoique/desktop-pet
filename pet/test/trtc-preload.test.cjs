const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('TRTC stays behind the isolated control preload and packages native binaries', () => {
  const manifest = JSON.parse(read('package.json'));
  const controlPreload = read('src/main/control-preload.js');
  const bridge = read('src/main/trtc-preload-bridge.js');
  const main = read('src/main/index.js');
  assert.equal(manifest.dependencies['trtc-electron-sdk'], '13.3.801');
  assert.ok(manifest.build.asarUnpack.includes('node_modules/trtc-electron-sdk/**/*'));
  assert.match(controlPreload, /trtc:\s*createTrtcPreloadBridge\(\)/);
  assert.match(main, /preload: path\.join\(__dirname, 'control-preload\.js'\),\s*contextIsolation: true,\s*nodeIntegration: false,\s*\/\/ TRTC[\s\S]*?sandbox: false/);
  assert.match(bridge, /TRTCVideoStreamTypeSub/);
  assert.match(bridge, /TRTCVideoResolution_1280_720/);
  assert.match(bridge, /TRTCVideoResolution_1920_1080/);
  assert.match(bridge, /\n\s*30,\n/);
  assert.match(bridge, /startSystemAudioLoopback\(\)/);
  assert.match(bridge, /setAudioCaptureVolume\(microphoneEnabled \? 100 : 0\)/);
  assert.doesNotMatch(bridge, /SDKSECRETKEY|TRTC_SECRET_KEY|localStorage/);
});
