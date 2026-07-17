const test = require('node:test');
const assert = require('node:assert/strict');
const { isCompletePairing, shouldShowControlOnStartup } = require('../src/main/pairing-config');

const complete = {
  serverUrl: 'https://pet.example.com', roomSecret: 'secret', memberId: 'a', deviceId: 'device-1', deviceName: 'Laptop',
};

test('complete pairing requires every endpoint identity field', () => {
  assert.equal(isCompletePairing(complete), true);
  for (const field of Object.keys(complete)) {
    assert.equal(isCompletePairing({ ...complete, [field]: '' }), false, `${field} must be present`);
  }
  assert.equal(isCompletePairing({ ...complete, memberId: 'c' }), false);
});

test('incomplete pairing opens the control panel at startup', () => {
  assert.equal(shouldShowControlOnStartup(complete), false);
  assert.equal(shouldShowControlOnStartup({ ...complete, memberId: '' }), true);
});
