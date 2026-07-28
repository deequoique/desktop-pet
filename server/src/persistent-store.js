import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const VERSION = 2;
const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_NOTE_LIMITS = Object.freeze({
  imageMaxBytes: 2 * 1024 * 1024,
  pendingMax: 500,
  pendingImageMaxBytes: 500 * 1024 * 1024,
  favoriteMax: 500,
  favoriteImageMaxBytes: 500 * 1024 * 1024,
  roomImageMaxBytes: 2 * 1024 * 1024 * 1024,
  historyTtlMs: 30 * DAY_MS,
});

function blankMember(id) {
  return { displayName: id === 'a' ? '用户 A' : '用户 B', devices: {}, audio: {} };
}

function blankRoom() {
  return { members: { a: blankMember('a'), b: blankMember('b') }, notes: {} };
}

function migrateRegistry(parsed) {
  if (!parsed?.rooms || ![1, VERSION].includes(parsed.version)) throw new Error('unsupported registry version');
  const migrated = structuredClone(parsed);
  migrated.version = VERSION;
  for (const room of Object.values(migrated.rooms)) {
    room.members ||= { a: blankMember('a'), b: blankMember('b') };
    for (const memberId of ['a', 'b']) {
      room.members[memberId] ||= blankMember(memberId);
      room.members[memberId].devices ||= {};
      room.members[memberId].audio ||= {};
    }
    room.notes ||= {};
  }
  return migrated;
}

function jpegDimensions(data) {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > data.length) return null;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function inspectImage(mime, input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  let dimensions = null;
  let extension = '';
  if (mime === 'image/png' && data.length >= 24
    && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && data.indexOf(Buffer.from('acTL')) === -1) {
    dimensions = { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    extension = 'png';
  } else if (mime === 'image/jpeg') {
    dimensions = jpegDimensions(data);
    extension = 'jpg';
  }
  if (!dimensions || !dimensions.width || !dimensions.height
    || dimensions.width > 8192 || dimensions.height > 8192
    || dimensions.width * dimensions.height > 32_000_000) return null;
  return { data, extension, ...dimensions };
}

function uniqueAttachments(note) {
  const items = [];
  if (note.media?.kind === 'image' && note.media.attachment) items.push(note.media.attachment);
  if (note.review?.imageAttachment) items.push(note.review.imageAttachment);
  return items;
}

export class PersistentStore {
  constructor(dataDir, now = () => Date.now(), noteLimits = {}) {
    this.dataDir = dataDir;
    this.registryFile = path.join(dataDir, 'registry.json');
    this.audioDir = path.join(dataDir, 'audio');
    this.noteDir = path.join(dataDir, 'notes');
    this.now = now;
    this.noteLimits = { ...DEFAULT_NOTE_LIMITS, ...noteLimits };
    this.data = { version: VERSION, rooms: {} };
    this.load();
  }

  load() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.prune();
        return;
      }
      throw new Error(`registry load failed: ${error?.message || error}`, { cause: error });
    }
    const migrated = parsed.version !== VERSION;
    this.data = migrateRegistry(parsed);
    if (migrated) this.save();
    this.prune();
    this.cleanupNoteFiles();
  }

  cleanupNoteFiles() {
    const referenced = new Set();
    for (const [roomHash, room] of Object.entries(this.data.rooms)) {
      for (const note of Object.values(room.notes || {})) {
        for (const item of uniqueAttachments(note)) referenced.add(`${roomHash}/${item.id}.${item.extension}`);
      }
    }
    let roomEntries = [];
    try { roomEntries = fs.readdirSync(this.noteDir, { withFileTypes: true }); } catch { return; }
    for (const roomEntry of roomEntries) {
      if (!roomEntry.isDirectory()) continue;
      const directory = path.join(this.noteDir, roomEntry.name);
      let files = [];
      try { files = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
      for (const file of files) {
        if (!file.isFile()) continue;
        const key = `${roomEntry.name}/${file.name}`;
        if (file.name.endsWith('.tmp') || !referenced.has(key)) {
          try { fs.unlinkSync(path.join(directory, file.name)); } catch {}
        }
      }
    }
  }

  room(roomHash) {
    const room = this.data.rooms[roomHash] ||= blankRoom();
    room.members ||= { a: blankMember('a'), b: blankMember('b') };
    room.notes ||= {};
    room.members.a ||= blankMember('a');
    room.members.b ||= blankMember('b');
    return room;
  }

  save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const temp = `${this.registryFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, this.registryFile);
  }

  touchDevice(roomHash, memberId, deviceId, name) {
    const member = this.room(roomHash).members[memberId];
    const existing = member.devices[deviceId];
    const timestamp = new Date(this.now()).toISOString();
    member.devices[deviceId] = {
      name,
      firstSeenAt: existing?.firstSeenAt || timestamp,
      lastSeenAt: timestamp,
    };
    this.save();
    return member.devices[deviceId];
  }

  markSeen(roomHash, memberId, deviceId) {
    const device = this.room(roomHash).members[memberId].devices[deviceId];
    if (!device) return;
    device.lastSeenAt = new Date(this.now()).toISOString();
    this.save();
  }

  renameMember(roomHash, memberId, displayName) {
    this.room(roomHash).members[memberId].displayName = displayName;
    this.save();
  }

  memberDisplayNames(roomHash) {
    const members = this.data.rooms[roomHash]?.members;
    return ['a', 'b'].map((id) => ({
      id,
      displayName: String(members?.[id]?.displayName || (id === 'a' ? '用户 A' : '用户 B')),
    }));
  }

  devices(roomHash, memberId) {
    return Object.entries(this.room(roomHash).members[memberId].devices).map(([id, device]) => ({ id, ...device }));
  }

  reclaimDevice(roomHash, memberId, oldDeviceId, newDeviceId, name) {
    const devices = this.room(roomHash).members[memberId].devices;
    const oldDevice = devices[oldDeviceId];
    const current = devices[newDeviceId];
    if (!oldDevice || !current || oldDeviceId === newDeviceId) return null;
    devices[newDeviceId] = { ...current, name, firstSeenAt: oldDevice.firstSeenAt, lastSeenAt: new Date(this.now()).toISOString() };
    delete devices[oldDeviceId];
    this.save();
    return { id: newDeviceId, ...devices[newDeviceId] };
  }

  moveDevice(roomHash, sourceMemberId, targetMemberId, deviceId) {
    const room = this.room(roomHash);
    const source = room.members[sourceMemberId]?.devices;
    const target = room.members[targetMemberId]?.devices;
    const device = source?.[deviceId];
    if (!device || !target) return { ok: false, code: 'device_not_found' };
    if (target[deviceId]) return { ok: false, code: 'device_identity_conflict' };
    const previousSource = source[deviceId];
    const previousTarget = target[deviceId];
    const moved = {
      ...device,
      lastSeenAt: new Date(this.now()).toISOString(),
    };
    delete source[deviceId];
    target[deviceId] = moved;
    try {
      this.save();
      return { ok: true, device: { id: deviceId, ...moved } };
    } catch (error) {
      source[deviceId] = previousSource;
      if (previousTarget) target[deviceId] = previousTarget;
      else delete target[deviceId];
      throw error;
    }
  }

  audio(roomHash, memberId) {
    return Object.values(this.room(roomHash).members[memberId].audio || {});
  }

  addAudio(roomHash, memberId, { name, mime, extension, durationMs, data }) {
    const member = this.room(roomHash).members[memberId];
    member.audio ||= {};
    const id = randomUUID();
    const directory = path.join(this.audioDir, roomHash, memberId);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${id}.${extension}`);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, file);
    const item = { id, name, mime, extension, durationMs, size: data.length, createdAt: new Date(this.now()).toISOString() };
    member.audio[id] = item;
    try { this.save(); }
    catch (error) { try { fs.unlinkSync(file); } catch {} throw error; }
    return item;
  }

  renameAudio(roomHash, memberId, audioId, name) {
    const item = this.room(roomHash).members[memberId].audio?.[audioId];
    if (!item) return null;
    item.name = name;
    this.save();
    return item;
  }

  deleteAudio(roomHash, memberId, audioId) {
    const member = this.room(roomHash).members[memberId];
    const item = member.audio?.[audioId];
    if (!item) return false;
    try { fs.unlinkSync(path.join(this.audioDir, roomHash, memberId, `${audioId}.${item.extension}`)); } catch {}
    delete member.audio[audioId];
    this.save();
    return true;
  }

  audioPath(roomHash, memberId, audioId) {
    const item = this.room(roomHash).members[memberId].audio?.[audioId];
    return item ? { item, file: path.join(this.audioDir, roomHash, memberId, `${audioId}.${item.extension}`) } : null;
  }

  noteVisible(note, memberId) {
    if (![note.senderMemberId, note.recipientMemberId].includes(memberId)) return false;
    if (!note.review) return true;
    if (this.now() - Date.parse(note.review.reviewedAt) <= this.noteLimits.historyTtlMs) return true;
    return !!note.favorites?.[memberId];
  }

  noteSnapshot(note, memberId) {
    if (!this.noteVisible(note, memberId)) return null;
    return {
      id: note.id,
      revision: note.revision,
      senderMemberId: note.senderMemberId,
      recipientMemberId: note.recipientMemberId,
      body: note.body,
      paperColor: note.paperColor,
      media: note.media,
      createdAt: note.createdAt,
      ...(memberId === note.recipientMemberId && note.noticedAt ? { noticedAt: note.noticedAt } : {}),
      review: note.review,
      favorite: !!note.favorites?.[memberId],
    };
  }

  listNotes(roomHash, memberId, view = 'inbox') {
    const notes = Object.values(this.room(roomHash).notes || {});
    return notes
      .filter((note) => {
        if (!this.noteVisible(note, memberId)) return false;
        if (view === 'inbox') return note.recipientMemberId === memberId && !note.review;
        if (view === 'sent') return note.senderMemberId === memberId;
        if (view === 'history') return !!note.review;
        if (view === 'favorites') return !!note.favorites?.[memberId];
        return false;
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((note) => this.noteSnapshot(note, memberId));
  }

  roomImageBytes(roomHash) {
    const ids = new Set();
    let total = 0;
    for (const note of Object.values(this.room(roomHash).notes || {})) {
      for (const item of uniqueAttachments(note)) {
        if (!ids.has(item.id)) { ids.add(item.id); total += item.size; }
      }
    }
    return total;
  }

  pendingStats(roomHash, memberId) {
    const notes = Object.values(this.room(roomHash).notes || {})
      .filter((note) => note.recipientMemberId === memberId && !note.review);
    return {
      count: notes.length,
      imageBytes: notes.reduce((sum, note) => sum + (note.media?.kind === 'image' ? note.media.attachment.size : 0), 0),
    };
  }

  favoriteStats(roomHash, memberId) {
    const notes = Object.values(this.room(roomHash).notes || {}).filter((note) => note.favorites?.[memberId]);
    const ids = new Set();
    let imageBytes = 0;
    for (const note of notes) {
      for (const item of uniqueAttachments(note)) {
        if (!ids.has(item.id)) { ids.add(item.id); imageBytes += item.size; }
      }
    }
    return { count: notes.length, imageBytes };
  }

  writeNoteImage(roomHash, image) {
    if (!image) return { ok: true, attachment: null };
    const inspected = inspectImage(String(image.mime || ''), image.data);
    if (!inspected || inspected.data.length > this.noteLimits.imageMaxBytes) return { ok: false, code: 'invalid_image' };
    if (this.roomImageBytes(roomHash) + inspected.data.length > this.noteLimits.roomImageMaxBytes) {
      return { ok: false, code: 'note_room_image_limit' };
    }
    const id = randomUUID();
    const directory = path.join(this.noteDir, roomHash);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${id}.${inspected.extension}`);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, inspected.data);
    fs.renameSync(temp, file);
    return {
      ok: true,
      file,
      attachment: {
        id,
        mime: String(image.mime),
        extension: inspected.extension,
        size: inspected.data.length,
        width: inspected.width,
        height: inspected.height,
        createdAt: new Date(this.now()).toISOString(),
      },
    };
  }

  createNote(roomHash, senderMemberId, input) {
    const recipientMemberId = senderMemberId === 'a' ? 'b' : 'a';
    const stats = this.pendingStats(roomHash, recipientMemberId);
    if (stats.count >= this.noteLimits.pendingMax) return { ok: false, code: 'note_inbox_full' };
    const imageBytes = input.media?.kind === 'image' ? Buffer.byteLength(input.media.image?.data || []) : 0;
    if (stats.imageBytes + imageBytes > this.noteLimits.pendingImageMaxBytes) {
      return { ok: false, code: 'note_pending_image_limit' };
    }
    const written = input.media?.kind === 'image' ? this.writeNoteImage(roomHash, input.media.image) : { ok: true };
    if (!written.ok) return written;
    const note = {
      id: randomUUID(),
      revision: 1,
      senderMemberId,
      recipientMemberId,
      body: input.body,
      paperColor: input.paperColor,
      media: input.media?.kind === 'image'
        ? { kind: 'image', attachment: written.attachment }
        : input.media || null,
      createdAt: new Date(this.now()).toISOString(),
      favorites: {},
    };
    this.room(roomHash).notes[note.id] = note;
    try {
      this.save();
      return { ok: true, note };
    } catch {
      delete this.room(roomHash).notes[note.id];
      if (written.file) try { fs.unlinkSync(written.file); } catch {}
      return { ok: false, code: 'note_storage_failed' };
    }
  }

  markNoteNoticed(roomHash, memberId, noteId) {
    const note = this.room(roomHash).notes?.[noteId];
    if (!note || note.recipientMemberId !== memberId || note.review) return { ok: false, code: 'note_not_found' };
    if (!note.noticedAt) {
      note.noticedAt = new Date(this.now()).toISOString();
      note.revision += 1;
      try {
        this.save();
      } catch (error) {
        delete note.noticedAt;
        note.revision -= 1;
        throw error;
      }
    }
    return { ok: true, note };
  }

  reviewNote(roomHash, memberId, noteId, reply = null) {
    const note = this.room(roomHash).notes?.[noteId];
    if (!note || note.recipientMemberId !== memberId) return { ok: false, code: 'note_not_found' };
    if (note.review) return { ok: false, code: 'note_already_reviewed', note };
    const written = reply?.image ? this.writeNoteImage(roomHash, reply.image) : { ok: true };
    if (!written.ok) return written;
    const previousNoticedAt = note.noticedAt;
    note.review = {
      reviewedAt: new Date(this.now()).toISOString(),
      ...(reply?.body ? { body: reply.body } : {}),
      ...(written.attachment ? { imageAttachment: written.attachment } : {}),
    };
    note.noticedAt ||= note.review.reviewedAt;
    note.revision += 1;
    try {
      this.save();
      return { ok: true, note };
    } catch {
      delete note.review;
      if (previousNoticedAt) note.noticedAt = previousNoticedAt;
      else delete note.noticedAt;
      note.revision -= 1;
      if (written.file) try { fs.unlinkSync(written.file); } catch {}
      return { ok: false, code: 'note_storage_failed' };
    }
  }

  setNoteFavorite(roomHash, memberId, noteId, favorite) {
    const note = this.room(roomHash).notes?.[noteId];
    if (!note || !this.noteVisible(note, memberId)) return { ok: false, code: 'note_not_found' };
    note.favorites ||= {};
    if (!!note.favorites[memberId] === favorite) return { ok: true, note };
    const previousFavorite = note.favorites[memberId];
    if (favorite) {
      const stats = this.favoriteStats(roomHash, memberId);
      const existingIds = new Set(Object.values(this.room(roomHash).notes || {})
        .filter((item) => item.favorites?.[memberId])
        .flatMap(uniqueAttachments).map((item) => item.id));
      const extraBytes = uniqueAttachments(note)
        .filter((item) => !existingIds.has(item.id))
        .reduce((sum, item) => sum + item.size, 0);
      if (stats.count >= this.noteLimits.favoriteMax) return { ok: false, code: 'favorite_limit_reached' };
      if (stats.imageBytes + extraBytes > this.noteLimits.favoriteImageMaxBytes) {
        return { ok: false, code: 'favorite_image_limit' };
      }
      note.favorites[memberId] = { favoritedAt: new Date(this.now()).toISOString() };
    } else {
      delete note.favorites[memberId];
    }
    note.revision += 1;
    try {
      this.save();
    } catch (error) {
      if (previousFavorite) note.favorites[memberId] = previousFavorite;
      else delete note.favorites[memberId];
      note.revision -= 1;
      throw error;
    }
    return { ok: true, note };
  }

  noteAttachmentPath(roomHash, memberId, noteId, attachmentId) {
    const note = this.room(roomHash).notes?.[noteId];
    if (!note || !this.noteVisible(note, memberId)) return null;
    const item = uniqueAttachments(note).find((attachment) => attachment.id === attachmentId);
    return item ? { item, file: path.join(this.noteDir, roomHash, `${item.id}.${item.extension}`) } : null;
  }

  prune(isOnline = () => false) {
    const deviceCutoff = this.now() - DEVICE_TTL_MS;
    let changed = false;
    const filesToDelete = [];
    const removedNotes = [];
    for (const [roomHash, room] of Object.entries(this.data.rooms)) {
      room.notes ||= {};
      for (const memberId of ['a', 'b']) {
        const devices = room.members?.[memberId]?.devices || {};
        for (const [deviceId, device] of Object.entries(devices)) {
          if (!isOnline(roomHash, memberId, deviceId) && Date.parse(device.lastSeenAt) < deviceCutoff) {
            delete devices[deviceId];
            changed = true;
          }
        }
      }
      for (const [noteId, note] of Object.entries(room.notes)) {
        const expired = note.review && this.now() - Date.parse(note.review.reviewedAt) > this.noteLimits.historyTtlMs;
        if (expired && !Object.keys(note.favorites || {}).length) {
          filesToDelete.push(...uniqueAttachments(note).map((item) => path.join(this.noteDir, roomHash, `${item.id}.${item.extension}`)));
          delete room.notes[noteId];
          removedNotes.push({ roomHash, noteId });
          changed = true;
        }
      }
    }
    if (changed) this.save();
    for (const file of filesToDelete) try { fs.unlinkSync(file); } catch {}
    return { removedNotes };
  }
}
