const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'main.ts'), 'utf8');
const rendererHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

test('note child windows are narrowly allowlisted, resizable, topmost, and position-aware', () => {
  assert.match(mainSource, /url !== 'about:blank' \|\| !isNoteFrameName\(frameName\)/);
  assert.match(mainSource, /frameName === 'note-stack' \|\| \/\^note-card:/);
  assert.match(mainSource, /minWidth: 260,[\s\S]*?minHeight: 220,[\s\S]*?frame: false,[\s\S]*?resizable: true,[\s\S]*?alwaysOnTop: true/);
  assert.match(mainSource, /patchState\(\{[\s\S]*?noteLayouts:/);
  assert.match(mainSource, /clampNoteWindowsToVisibleArea\(\)/);
  assert.match(mainSource, /child\.showInactive\(\)/);
});

test('game mode hides expanded notes and restores only the previous visible set', () => {
  assert.match(mainSource, /noteWindowsHiddenForGame\.clear\(\)/);
  assert.match(mainSource, /child\.isVisible\(\)[\s\S]*?noteWindowsHiddenForGame\.add\(frameName\)[\s\S]*?child\.hide\(\)/);
  assert.match(mainSource, /for \(const frameName of noteWindowsHiddenForGame\)[\s\S]*?child\.showInactive\(\)/);
  assert.match(mainSource, /webContents\.send\('note:game-mode-changed', gameMode\)/);
});

test('note bridge limits external navigation and cleans up lifecycle listeners', () => {
  assert.match(mainSource, /\['http:', 'https:'\]\.includes\(url\.protocol\)/);
  assert.match(mainSource, /shell\.openExternal\(url\.toString\(\)\)/);
  assert.match(preloadSource, /onGameModeChanged:[\s\S]*?removeListener\('note:game-mode-changed'/);
  assert.match(preloadSource, /onNoteWindowClosed:[\s\S]*?removeListener\('note-window:closed'/);
  assert.match(preloadSource, /onNoteWindowInteracted:[\s\S]*?removeListener\('note-window:interacted'/);
  assert.match(mainSource, /child\.on\('will-move', reportInteraction\)/);
  assert.match(mainSource, /child\.on\('will-resize', reportInteraction\)/);
});

test('pet renderer exposes the stack, explicit review, reply media, and no note sound', () => {
  assert.match(rendererHtml, /id="notes-dock"/);
  assert.match(rendererSource, /note:list/);
  assert.match(rendererSource, /note:mark-noticed/);
  assert.match(rendererSource, /note:review/);
  assert.match(rendererSource, /note:set-favorite/);
  assert.match(rendererSource, /批阅并回复/);
  assert.match(rendererSource, /image\/jpeg,image\/png/);
  assert.match(rendererSource, /NOTE_COLLAPSED_STORAGE/);
  assert.match(rendererSource, /yellow: '#F4D77D'/);
  assert.doesNotMatch(rendererSource, /note.*new Audio|new Audio.*note/i);
});
