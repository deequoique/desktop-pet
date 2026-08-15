const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  FRAME_VERSION,
  MAX_PENDING_IPC_FRAMES,
  PCM_FRAME_BYTES,
  FrameDecoder,
  createFrameDeliveryQueue,
  createWindowsProcessLoopbackManager,
  processLoopbackCapability,
} = require('../src/main/windows-process-loopback');

function encodedFrame(sequence, fill = 0x2a) {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32LE(FRAME_MAGIC, 0);
  header.writeUInt16LE(FRAME_VERSION, 4);
  header.writeUInt16LE(1, 6);
  header.writeBigUInt64LE(BigInt(sequence), 8);
  header.writeBigUInt64LE(BigInt(1_000 + sequence * 20), 16);
  header.writeUInt32LE(PCM_FRAME_BYTES, 24);
  header.writeUInt32LE(0, 28);
  return Buffer.concat([header, Buffer.alloc(PCM_FRAME_BYTES, fill)]);
}

test('process-loopback capability uses exclusion only on Windows 11 builds', () => {
  assert.deepEqual(processLoopbackCapability({ platform: 'win32', build: 22_000, enabled: true }), {
    mode: 'process-exclusion', echoExclusion: 'supported', windowsBuild: 22_000,
  });
  assert.deepEqual(processLoopbackCapability({ platform: 'win32', build: 19_045, enabled: true }), {
    mode: 'trtc-loopback', echoExclusion: 'unsupported', windowsBuild: 19_045,
  });
  assert.deepEqual(processLoopbackCapability({ platform: 'win32', build: 22_631, enabled: false }), {
    mode: 'unavailable', echoExclusion: 'disabled', windowsBuild: 22_631,
  });
  assert.equal(processLoopbackCapability({ platform: 'darwin' }).mode, 'trtc-loopback');
  assert.equal(processLoopbackCapability({ platform: 'linux' }).mode, 'unavailable');
  assert.deepEqual(processLoopbackCapability({ platform: 'win32', release: '10.0.22631', enabled: true }), {
    mode: 'process-exclusion', echoExclusion: 'supported', windowsBuild: 22_631,
  });
});

test('renderer IPC delivery remains bounded until each frame is consumed', () => {
  const delivered = [];
  const drops = [];
  const queue = createFrameDeliveryQueue({
    onDeliver: (frame) => delivered.push(frame.sequence),
    onDrop: (count) => drops.push(count),
  });
  for (let sequence = 0; sequence < MAX_PENDING_IPC_FRAMES + 4; sequence += 1) {
    queue.push({ generation: 7, sequence });
  }
  assert.equal(queue.size(), MAX_PENDING_IPC_FRAMES + 1);
  assert.deepEqual(delivered, [0]);
  assert.deepEqual(drops, [1, 2, 3]);
  assert.equal(queue.acknowledge(6, 0), false);
  assert.equal(queue.acknowledge(7, 0), true);
  assert.deepEqual(delivered, [0, 4]);
  assert.equal(queue.reset(6), false);
  assert.equal(queue.size(), MAX_PENDING_IPC_FRAMES);
  queue.reset();
  assert.equal(queue.size(), 0);
});

test('restarting the helper with the same call generation rejects stale process data', () => {
  const processes = [];
  const frames = [];
  const statuses = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    child.kill = () => {};
    processes.push(child);
    return child;
  };
  const manager = createWindowsProcessLoopbackManager({
    helperPath: 'fixed-helper.exe',
    rootProcessId: 42,
    spawnProcess,
    fileExists: () => true,
    onFrame: (frame) => frames.push(frame.sequence),
    onStatus: (status) => statuses.push(status),
  });
  assert.equal(manager.start(7).ok, true);
  assert.equal(manager.start(7).ok, true);
  processes[0].stdout.emit('data', encodedFrame(1));
  const malformed = encodedFrame(2);
  malformed.writeUInt32LE(0, 0);
  processes[0].stdout.emit('data', malformed);
  processes[0].emit('error', new Error('late old process error'));
  assert.deepEqual(frames, []);
  assert.equal(statuses.some((status) => status.event === 'protocol-error'), false);
  assert.equal(statuses.some((status) => status.event === 'helper-error'), false);
  assert.equal(manager.isRunning(), true);
  processes[1].stdout.emit('data', encodedFrame(3));
  assert.deepEqual(frames, [3]);
  manager.stop(7);
});

test('framed PCM decoder accepts partial and coalesced 20 ms frames', () => {
  const frames = [];
  const errors = [];
  const decoder = new FrameDecoder((frame) => frames.push(frame), (error) => errors.push(error));
  const first = encodedFrame(1, 0x11);
  decoder.push(first.subarray(0, 17));
  decoder.push(Buffer.concat([first.subarray(17), encodedFrame(2, 0x22), encodedFrame(3, 0x33)]));
  assert.deepEqual(frames.map((frame) => frame.sequence), [1, 2, 3]);
  assert.deepEqual(frames.map((frame) => frame.ptsMs), [1_020, 1_040, 1_060]);
  assert.equal(frames[0].pcm.length, PCM_FRAME_BYTES);
  assert.equal(frames[2].pcm[0], 0x33);
  assert.deepEqual(errors, []);
});

test('framed PCM decoder fails closed on malformed protocol input', () => {
  const frames = [];
  const errors = [];
  const decoder = new FrameDecoder((frame) => frames.push(frame), (error) => errors.push(error));
  const invalid = encodedFrame(1);
  invalid.writeUInt32LE(0, 0);
  decoder.push(invalid);
  assert.deepEqual(frames, []);
  assert.deepEqual(errors, ['invalid_frame_header']);
});
