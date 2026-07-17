const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('packaged stable builds also check for prerelease updates', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
  assert.match(
    source,
    /function setupAutoUpdater\(\) \{[\s\S]*?autoUpdater\.allowPrerelease = true;/,
  );
});
