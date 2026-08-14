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

test('TURN keeps bounded adaptive screen video while camera relay fails closed', () => {
  assert.match(petRendererSource, /applyVideoSenderProfile\([\s\S]*?sender,[\s\S]*?screenTrack,[\s\S]*?profile,[\s\S]*?'screen',[\s\S]*?screenAdaptiveState\.qualityLevel,[\s\S]*?screenAdaptiveState\.frameRateTarget/);
  assert.match(petRendererSource, /screenProfileApplyChain\.catch\(\(\) => \{\}\)\.then/);
  assert.match(petRendererSource, /if \(!applied\.ok\)[\s\S]*?screenTrack\.enabled = false;[\s\S]*?screenTrack\.enabled = true/);
  assert.match(appSource, /applyVideoSenderProfile\([\s\S]*?sender,[\s\S]*?track,[\s\S]*?profile,[\s\S]*?'camera',[\s\S]*?cameraQualityLevelRef\.current/);
  assert.match(appSource, /cameraProfileApplyChainRef\.current\.catch\(\(\) => \{\}\)\.then/);
  assert.match(appSource, /disableCameraForRelay[\s\S]*?replaceTrack\(null\)[\s\S]*?stopLocalCameraCapture[\s\S]*?relay_disabled/);
  assert.match(appSource, /cameraDesiredRef\.current = false;[\s\S]*?setCameraDesired\(false\)/);
  assert.match(appSource, /摄像头通道使用 TURN，为保证屏幕和声音已关闭/);
  assert.match(appSource, /qualityLevelLabel\(screenQualityLevel\)/);
  assert.match(appSource, /rtcNetworkSample\?\.roundTripTimeMs/);
  assert.match(petRendererSource, /new AdaptiveScreenQualityController\(\)/);
  assert.match(petRendererSource, /frameRate:\s*\{\s*ideal:\s*90,\s*max:\s*90\s*\}/);
  assert.match(petRendererSource, /screenAdaptiveState\.frameRateTarget/);
  assert.doesNotMatch(appSource, /TURN 音频兜底|relay_audio_only/);
  assert.doesNotMatch(petRendererSource, /screenRouteIsP2P|relay_audio_only/);
});

test('camera transport is lazy and closes immediately after both sides disable it', () => {
  assert.doesNotMatch(appSource, /cameraPrewarm|webrtc\.camera-prewarm/);
  assert.match(appSource, /sendCameraSignal\(\{ callId, cameraDesired: true \}\);[\s\S]*?await beginCameraCall/);
  assert.match(appSource, /typeof signal\.cameraDesired === 'boolean'[\s\S]*?remoteCameraDesiredRef\.current = signal\.cameraDesired/);
  assert.match(appSource, /if \(signal\.cameraDesired\) \{[\s\S]*?await beginCameraCall/);
  assert.match(appSource, /sendCameraSignal\(\{ callId, cameraDesired: false \}\);[\s\S]*?if \(!remoteCameraDesiredRef\.current\) teardownCameraTransport\('both-cameras-disabled'\)/);
  assert.match(appSource, /else if \(!cameraDesiredRef\.current\) \{[\s\S]*?teardownCameraTransport\('both-cameras-disabled'\)/);
  assert.match(appSource, /const teardownCameraTransport = useCallback[\s\S]*?cameraPcRef\.current\?\.close\(\)[\s\S]*?cameraPcRef\.current = null/);
  assert.match(appSource, /cameraTransportGenerationRef\.current !== transportGeneration/);
  assert.match(appSource, /cameraNegotiationStartedCallIdRef\.current = ''/);
});

test('camera surface only mounts for available remote video', () => {
  assert.match(appSource, /remoteCameraAvailable && !cameraHidden && <div className=\{`media-surface camera-surface/);
  assert.doesNotMatch(appSource, /\{!cameraHidden && <div className=\{`media-surface camera-surface/);
});
