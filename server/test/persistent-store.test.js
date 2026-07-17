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

test('moving a device preserves device history and keeps audio with its original member', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-store-'));
  let now = Date.UTC(2026, 0, 1);
  try {
    const store = new PersistentStore(directory, () => now);
    store.touchDevice('room', 'a', 'device-1', 'Laptop');
    const audio = store.addAudio('room', 'a', {
      name: 'Hello', mime: 'audio/mpeg', extension: 'mp3', durationMs: 1000, data: Buffer.from('audio'),
    });
    const firstSeenAt = store.devices('room', 'a')[0].firstSeenAt;
    now += 1000;
    const moved = store.moveDevice('room', 'a', 'b', 'device-1');
    assert.equal(moved.ok, true);
    assert.deepEqual(store.devices('room', 'a'), []);
    assert.equal(store.devices('room', 'b')[0].name, 'Laptop');
    assert.equal(store.devices('room', 'b')[0].firstSeenAt, firstSeenAt);
    assert.equal(store.audio('room', 'a')[0].id, audio.id);
    assert.equal(store.audio('room', 'b').length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('moving a device rejects an identity already owned by the target member', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-store-'));
  try {
    const store = new PersistentStore(directory);
    store.touchDevice('room', 'a', 'device-1', 'A laptop');
    store.touchDevice('room', 'b', 'device-1', 'B laptop');
    assert.deepEqual(store.moveDevice('room', 'a', 'b', 'device-1'), { ok: false, code: 'device_identity_conflict' });
    assert.equal(store.devices('room', 'a')[0].name, 'A laptop');
    assert.equal(store.devices('room', 'b')[0].name, 'B laptop');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
