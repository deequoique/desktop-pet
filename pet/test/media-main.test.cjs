const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'control-preload.js'), 'utf8');
const packageConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const appSource = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'App.tsx'), 'utf8');
const petRendererSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'main.ts'), 'utf8');
const controlStyles = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'control-panel.css'), 'utf8');

test('media floating window is allowlisted, resizable, topmost, and reports native close', () => {
  assert.match(mainSource, /url !== 'about:blank' \|\| frameName !== 'media-float'/);
  assert.match(mainSource, /minWidth: 320,[\s\S]*?minHeight: 180,[\s\S]*?resizable: true,[\s\S]*?alwaysOnTop: true/);
  assert.match(mainSource, /patchState\(\{ mediaFloatBounds: mediaFloatWin\.getBounds\(\) \}\)/);
  assert.match(mainSource, /clampMediaFloatToVisibleArea\(\)/);
  assert.match(mainSource, /webContents\.send\('media-float:closed'\)/);
  assert.match(preloadSource, /onMediaFloatClosed:[\s\S]*?removeListener\('media-float:closed'/);
  assert.doesNotMatch(mainSource, /mediaFloatWin\.setAspectRatio|aspectRatio:/);
});

test('media float renders only uncropped media while embedded controls stay compact', () => {
  assert.match(appSource, /\{!floatContainer && <div className="call-controls media-controls">/);
  assert.match(appSource, /!floatContainer && screenStatus !== 'available'/);
  assert.match(controlStyles, /\.media-float-root \.unified-media-stage \.media-surface\.primary\{inset:0;border-radius:0\}/);
  assert.match(controlStyles, /object-fit:contain/);
  assert.match(controlStyles, /\.unified-media-stage \.media-controls button\{height:32px;[\s\S]*?font-size:12px/);
});

test('media permission is scoped to application webContents and macOS declares usage text', () => {
  assert.match(mainSource, /permission === 'media' && isTrusted\(webContents\)/);
  assert.equal(typeof packageConfig.build.mac.extendInfo.NSCameraUsageDescription, 'string');
  assert.equal(typeof packageConfig.build.mac.extendInfo.NSMicrophoneUsageDescription, 'string');
  assert.equal(packageConfig.build.mac.extendInfo.NSCameraUseContinuityCameraDeviceType, true);
});

test('controller camera is bidirectional, locally controlled, and listener refresh does not tear down calls', () => {
  assert.match(appSource, /addTransceiver\('video', \{ direction: 'sendrecv' \}\)/);
  assert.match(appSource, /videoTransceiver\.direction = 'sendrecv'/);
  assert.match(appSource, /cameraSenderRef\.current = videoTransceiver\.sender/);
  assert.match(appSource, /const toggleCamera = useCallback[\s\S]*?await setLocalCameraEnabled\(enabled\)/);
  assert.doesNotMatch(appSource, /requestMediaControl\(\{ callId, media: 'camera'/);
  assert.match(appSource, /return \(\) => setListeners\(\{\}\);/);
  assert.doesNotMatch(appSource, /return \(\) => \{\s*setListeners\(\{\}\);\s*teardownCall/);
  assert.doesNotMatch(appSource, /isCameraSender/);
});

test('TURN keeps bounded low-resolution screen and camera video with fail-closed profiles', () => {
  assert.match(petRendererSource, /applyVideoSenderProfile\(sender, screenTrack, profile, 'screen'\)/);
  assert.match(petRendererSource, /screenProfileApplyChain\.catch\(\(\) => \{\}\)\.then/);
  assert.match(petRendererSource, /screenTrack\.enabled = false;[\s\S]*?if \(!applied\.ok\)[\s\S]*?screenTrack\.enabled = true/);
  assert.match(appSource, /applyVideoSenderProfile\(sender, track, profile, 'camera'\)/);
  assert.match(appSource, /cameraProfileApplyChainRef\.current\.catch\(\(\) => \{\}\)\.then/);
  assert.match(appSource, /await sender\.replaceTrack\(null\);[\s\S]*?if \(!applied\.ok\)[\s\S]*?await sender\.replaceTrack\(track\)/);
  assert.match(appSource, /TURN 低清视频/);
  assert.doesNotMatch(appSource, /TURN 音频兜底|relay_audio_only/);
  assert.doesNotMatch(petRendererSource, /screenRouteIsP2P|relay_audio_only/);
});
