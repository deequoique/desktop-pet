const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');

function sourceBetween(start, end) {
  const startIndex = mainSource.indexOf(start);
  const endIndex = mainSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return mainSource.slice(startIndex, endIndex);
}

test('pet drag freezes the actual bounds captured at drag start', () => {
  const dragStartSource = sourceBetween("ipcMain.on('pet:drag-start'", "ipcMain.on('pet:drag-end'");

  assert.match(dragStartSource, /const bounds = win\.getBounds\(\)/);
  assert.match(dragStartSource, /petDragOffset = \{ x: p\.x - bounds\.x, y: p\.y - bounds\.y \}/);
  assert.match(dragStartSource, /petDragBounds = bounds/);
});

test('cursor polling skips stationary moves and preserves drag-start dimensions atomically', () => {
  const pollSource = sourceBetween('function startCursorPoll()', 'function stopCursorPoll()');

  assert.doesNotMatch(pollSource, /win\.setPosition\(/);
  assert.match(pollSource, /if \(x !== wx \|\| y !== wy\)/);
  assert.match(
    pollSource,
    /win\.setBounds\(\{ x, y, width: petDragBounds\.width, height: petDragBounds\.height \}\)/,
  );
});

test('ending a drag clears both the active flag and frozen bounds', () => {
  const stopSource = sourceBetween('function stopPetDrag()', 'function checkForPetUpdates');

  assert.match(stopSource, /petDragging = false/);
  assert.match(stopSource, /petDragBounds = null/);
  assert.match(mainSource, /if \(gameMode\) stopPetDrag\(\)/);
  assert.match(mainSource, /app\.on\('will-quit',[\s\S]*?stopPetDrag\(\)/);
});
