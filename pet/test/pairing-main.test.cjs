const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Electron startup initializes the migrated device identity', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
  assert.doesNotMatch(source, /ensureParticipantId/);
  assert.match(source, /app\.whenReady\(\)\.then\(\(\) => \{\s*ensureDeviceId\(\);/);
});
