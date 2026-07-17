import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const VERSION = 1;
const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function blankMember(id) {
  return { displayName: id === 'a' ? '用户 A' : '用户 B', devices: {}, audio: {} };
}

function blankRoom() {
  return { members: { a: blankMember('a'), b: blankMember('b') } };
}

export class PersistentStore {
  constructor(dataDir, now = () => Date.now()) {
    this.dataDir = dataDir;
    this.registryFile = path.join(dataDir, 'registry.json');
    this.audioDir = path.join(dataDir, 'audio');
    this.now = now;
    this.data = { version: VERSION, rooms: {} };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
      if (parsed?.version !== VERSION || !parsed.rooms) throw new Error('unsupported registry version');
      this.data = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[store] registry load failed:', error?.message || error);
    }
    this.prune();
  }

  room(roomHash) {
    const room = this.data.rooms[roomHash] ||= blankRoom();
    room.members ||= { a: blankMember('a'), b: blankMember('b') };
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

  prune(isOnline = () => false) {
    const cutoff = this.now() - DEVICE_TTL_MS;
    let changed = false;
    for (const [roomHash, room] of Object.entries(this.data.rooms)) {
      for (const memberId of ['a', 'b']) {
        const devices = room.members?.[memberId]?.devices || {};
        for (const [deviceId, device] of Object.entries(devices)) {
          if (!isOnline(roomHash, memberId, deviceId) && Date.parse(device.lastSeenAt) < cutoff) {
            delete devices[deviceId];
            changed = true;
          }
        }
      }
    }
    if (changed) this.save();
  }
}
