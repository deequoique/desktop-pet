const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'control-preload.js'), 'utf8');
const packageConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

test('media floating window is allowlisted, resizable, topmost, and reports native close', () => {
  assert.match(mainSource, /url !== 'about:blank' \|\| frameName !== 'media-float'/);
  assert.match(mainSource, /minWidth: 320,[\s\S]*?minHeight: 180,[\s\S]*?resizable: true,[\s\S]*?alwaysOnTop: true/);
  assert.match(mainSource, /patchState\(\{ mediaFloatBounds: mediaFloatWin\.getBounds\(\) \}\)/);
  assert.match(mainSource, /clampMediaFloatToVisibleArea\(\)/);
  assert.match(mainSource, /webContents\.send\('media-float:closed'\)/);
  assert.match(preloadSource, /onMediaFloatClosed:[\s\S]*?removeListener\('media-float:closed'/);
});

test('media permission is scoped to application webContents and macOS declares usage text', () => {
  assert.match(mainSource, /permission === 'media' && isTrusted\(webContents\)/);
  assert.equal(typeof packageConfig.build.mac.extendInfo.NSCameraUsageDescription, 'string');
  assert.equal(typeof packageConfig.build.mac.extendInfo.NSMicrophoneUsageDescription, 'string');
  assert.equal(packageConfig.build.mac.extendInfo.NSCameraUseContinuityCameraDeviceType, true);
});
