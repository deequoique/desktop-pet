import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistentStore } from '../src/persistent-store.js';

test('registry persists names, devices, and member-private audio', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-store-'));
  let now = Date.UTC(2026, 0, 1);
  try {
    const store = new PersistentStore(directory, () => now);
    store.renameMember('room', 'a', 'Alice');
    store.touchDevice('room', 'a', 'device-1', 'Laptop');
    const audio = store.addAudio('room', 'a', {
      name: 'Hello', mime: 'audio/mpeg', extension: 'mp3', durationMs: 1000, data: Buffer.from('audio'),
    });
    const reloaded = new PersistentStore(directory, () => now);
    assert.equal(reloaded.room('room').members.a.displayName, 'Alice');
    assert.equal(reloaded.devices('room', 'a')[0].name, 'Laptop');
    assert.equal(reloaded.audio('room', 'a')[0].id, audio.id);
    assert.equal(reloaded.audio('room', 'b').length, 0);
    assert.equal(fs.readFileSync(reloaded.audioPath('room', 'a', audio.id).file, 'utf8'), 'audio');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('devices older than thirty days are pruned unless online', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-store-'));
  let now = Date.UTC(2026, 0, 1);
  try {
    const store = new PersistentStore(directory, () => now);
    store.touchDevice('room', 'a', 'old-offline', 'Old');
    store.touchDevice('room', 'a', 'old-online', 'Online');
    now += 31 * 24 * 60 * 60 * 1000;
    store.prune((_room, _member, device) => device === 'old-online');
    assert.deepEqual(store.devices('room', 'a').map((device) => device.id), ['old-online']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
