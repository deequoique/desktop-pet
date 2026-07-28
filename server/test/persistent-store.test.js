import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistentStore } from '../src/persistent-store.js';

function png(width = 1, height = 1, padding = 0) {
  const data = Buffer.alloc(24 + padding);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function withTempDir(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-store-'));
  try { return run(directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

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

test('v1 registry migrates without losing members, devices, or audio metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-store-'));
  try {
    fs.writeFileSync(path.join(directory, 'registry.json'), JSON.stringify({
      version: 1,
      rooms: {
        room: {
          members: {
            a: { displayName: 'Alice', devices: { d1: { name: 'PC', firstSeenAt: '2026-01-01', lastSeenAt: '2026-01-01' } }, audio: { clip: { id: 'clip' } } },
            b: { displayName: 'Bob', devices: {}, audio: {} },
          },
        },
      },
    }));
    const store = new PersistentStore(directory, () => Date.UTC(2026, 0, 1));
    assert.equal(store.data.version, 2);
    assert.equal(store.room('room').members.a.displayName, 'Alice');
    assert.equal(store.devices('room', 'a')[0].id, 'd1');
    assert.equal(store.audio('room', 'a')[0].id, 'clip');
    assert.deepEqual(store.room('room').notes, {});
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('unsupported or corrupt registries fail closed without replacing existing data', () => {
  withTempDir((directory) => {
    const registry = path.join(directory, 'registry.json');
    const unsupported = JSON.stringify({ version: 99, rooms: { keep: {} } });
    fs.writeFileSync(registry, unsupported);
    assert.throws(() => new PersistentStore(directory), /unsupported registry version/);
    assert.equal(fs.readFileSync(registry, 'utf8'), unsupported);
    fs.writeFileSync(registry, '{broken');
    assert.throws(() => new PersistentStore(directory), /registry load failed/);
    assert.equal(fs.readFileSync(registry, 'utf8'), '{broken');
  });
});

test('startup removes orphan and interrupted note attachment files', () => {
  withTempDir((directory) => {
    const store = new PersistentStore(directory);
    store.touchDevice('room', 'a', 'device', 'Device');
    const noteDirectory = path.join(directory, 'notes', 'room');
    fs.mkdirSync(noteDirectory, { recursive: true });
    const orphan = path.join(noteDirectory, 'orphan.png');
    const interrupted = path.join(noteDirectory, 'upload.png.123.tmp');
    fs.writeFileSync(orphan, png());
    fs.writeFileSync(interrupted, png());
    new PersistentStore(directory);
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.existsSync(interrupted), false);
  });
});

test('notes persist, review once, sync private favorites, and prune unreferenced history', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-store-'));
  let now = Date.UTC(2026, 0, 1);
  try {
    const store = new PersistentStore(directory, () => now, { historyTtlMs: 1000 });
    const created = store.createNote('room', 'a', {
      body: 'hello',
      paperColor: 'yellow',
      media: { kind: 'image', image: { mime: 'image/png', data: png() } },
    });
    assert.equal(created.ok, true);
    assert.equal(store.listNotes('room', 'b', 'inbox').length, 1);
    assert.equal(store.markNoteNoticed('room', 'b', created.note.id).ok, true);
    assert.ok(store.listNotes('room', 'b', 'inbox')[0].noticedAt);

    const reviewed = store.reviewNote('room', 'b', created.note.id, { body: '👍' });
    assert.equal(reviewed.ok, true);
    assert.equal(store.reviewNote('room', 'b', created.note.id).code, 'note_already_reviewed');
    assert.equal(store.setNoteFavorite('room', 'a', created.note.id, true).ok, true);

    now += 2000;
    store.prune();
    assert.equal(store.listNotes('room', 'a', 'favorites').length, 1);
    assert.equal(store.listNotes('room', 'b', 'history').length, 0);
    assert.equal(store.setNoteFavorite('room', 'a', created.note.id, false).ok, true);
    const pruned = store.prune();
    assert.deepEqual(pruned.removedNotes, [{ roomHash: 'room', noteId: created.note.id }]);
    assert.equal(store.room('room').notes[created.note.id], undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('note image quotas reject only image writes and do not duplicate favorite bytes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-store-'));
  try {
    const store = new PersistentStore(directory, () => Date.UTC(2026, 0, 1), {
      imageMaxBytes: 64,
      pendingMax: 2,
      pendingImageMaxBytes: 64,
      favoriteMax: 2,
      favoriteImageMaxBytes: 64,
      roomImageMaxBytes: 64,
    });
    const first = store.createNote('room', 'a', {
      body: '',
      paperColor: 'blue',
      media: { kind: 'image', image: { mime: 'image/png', data: png(1, 1, 16) } },
    });
    assert.equal(first.ok, true);
    assert.equal(store.setNoteFavorite('room', 'a', first.note.id, true).ok, true);
    assert.equal(store.favoriteStats('room', 'a').imageBytes, 40);
    assert.equal(store.setNoteFavorite('room', 'a', first.note.id, true).ok, true);
    assert.equal(store.favoriteStats('room', 'a').imageBytes, 40);

    const rejected = store.createNote('room', 'a', {
      body: '',
      paperColor: 'pink',
      media: { kind: 'image', image: { mime: 'image/png', data: png(1, 1, 16) } },
    });
    assert.equal(rejected.code, 'note_pending_image_limit');
    assert.equal(store.createNote('room', 'a', { body: 'text still works', paperColor: 'pink', media: null }).ok, true);
    assert.equal(store.createNote('room', 'a', { body: 'third', paperColor: 'pink', media: null }).code, 'note_inbox_full');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('failed note mutations roll back noticed, review, and favorite state in memory', () => {
  withTempDir((directory) => {
    const store = new PersistentStore(directory);
    const created = store.createNote('room', 'a', { body: 'rollback', paperColor: 'blue', media: null });
    assert.equal(created.ok, true);
    const note = created.note;
    store.save = () => { throw new Error('disk full'); };

    assert.throws(() => store.markNoteNoticed('room', 'b', note.id), /disk full/);
    assert.equal(note.noticedAt, undefined);
    assert.equal(note.revision, 1);

    assert.equal(store.reviewNote('room', 'b', note.id, { body: 'reply' }).code, 'note_storage_failed');
    assert.equal(note.review, undefined);
    assert.equal(note.noticedAt, undefined);
    assert.equal(note.revision, 1);

    assert.throws(() => store.setNoteFavorite('room', 'a', note.id, true), /disk full/);
    assert.equal(note.favorites.a, undefined);
    assert.equal(note.revision, 1);
  });
});
