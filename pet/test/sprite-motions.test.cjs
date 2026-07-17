const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const petRoot = path.join(__dirname, '..');
const repoRoot = path.join(petRoot, '..');
const rendererSource = fs.readFileSync(path.join(petRoot, 'src', 'renderer', 'main.ts'), 'utf8');
const controlSource = fs.readFileSync(path.join(repoRoot, 'web', 'src', 'App.tsx'), 'utf8');
const controlStyles = fs.readFileSync(path.join(repoRoot, 'web', 'src', 'control-panel.css'), 'utf8');

test('sprite motion ids and runtime asset directories use matching semantics', () => {
  assert.match(rendererSource, /\{ id: 'joy', label: '开心', loop: false \}/);
  assert.match(rendererSource, /\{ id: 'sorrow', label: '委屈', loop: false \}/);
  assert.equal(fs.existsSync(path.join(petRoot, 'public', 'sprites', 'screen-dog', 'joy', '00.png')), true);
  assert.equal(fs.existsSync(path.join(petRoot, 'public', 'sprites', 'screen-dog', 'sorrow', '00.png')), true);
  assert.equal(fs.existsSync(path.join(petRoot, 'public', 'sprites', 'screen-dog', 'waving')), false);
  assert.equal(fs.existsSync(path.join(petRoot, 'public', 'sprites', 'screen-dog', 'failed')), false);
});

test('quick interactions expose only supported user-triggered motions with press feedback', () => {
  assert.match(controlSource, /new Set\(\['joy', 'jumping', 'sorrow', 'waiting'\]\)/);
  assert.doesNotMatch(controlSource, /EXPRESSIONS|expandedMotions/);
  assert.match(controlStyles, /\.action-tile:not\(:disabled\):active\{[^}]*transform:/);
  assert.match(controlStyles, /prefers-reduced-motion:reduce[^}]*\.action-tile/);
});
