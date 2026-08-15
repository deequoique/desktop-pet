const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FRAME_MAGIC = 0x4c415044; // "DPAL" in little endian.
const FRAME_VERSION = 1;
const FRAME_TYPE_PCM = 1;
const FRAME_HEADER_BYTES = 32;
const PCM_FRAME_BYTES = 3_840;
// Keep enough headroom for a normal coalesced pipe read while remaining bounded.
const MAX_BUFFER_BYTES = (FRAME_HEADER_BYTES + PCM_FRAME_BYTES) * 64;
const MAX_PENDING_IPC_FRAMES = 8;

function windowsBuildNumber(release = os.release()) {
  const pieces = String(release || '').split('.');
  const build = Number(pieces[2]);
  return Number.isSafeInteger(build) && build > 0 ? build : null;
}

function createFrameDeliveryQueue({ maxPending = MAX_PENDING_IPC_FRAMES, onDeliver, onDrop }) {
  const limit = Number.isSafeInteger(maxPending) && maxPending > 0 ? maxPending : MAX_PENDING_IPC_FRAMES;
  let inFlight = null;
  let pending = [];
  let droppedFrames = 0;

  const deliverNext = () => {
    if (inFlight || pending.length === 0) return;
    inFlight = pending.shift();
    onDeliver?.(inFlight);
  };

  return {
    push(frame) {
      if (!inFlight) {
        inFlight = frame;
        onDeliver?.(frame);
        return;
      }
      if (pending.length >= limit) {
        pending.shift();
        droppedFrames += 1;
        onDrop?.(droppedFrames, frame.generation);
      }
      pending.push(frame);
    },
    acknowledge(generation, sequence) {
      if (!inFlight || inFlight.generation !== generation || inFlight.sequence !== sequence) return false;
      inFlight = null;
      deliverNext();
      return true;
    },
    reset(expectedGeneration) {
      const currentGeneration = inFlight?.generation ?? pending[0]?.generation;
      if (expectedGeneration != null && currentGeneration != null && currentGeneration !== expectedGeneration) {
        return false;
      }
      inFlight = null;
      pending = [];
      droppedFrames = 0;
      return true;
    },
    size: () => pending.length + (inFlight ? 1 : 0),
  };
}

function processLoopbackCapability(options = {}) {
  const platform = options.platform || process.platform;
  const build = options.build === undefined ? windowsBuildNumber(options.release) : options.build;
  const enabled = options.enabled !== false;
  if (platform === 'darwin') return { mode: 'trtc-loopback', echoExclusion: 'not-supported' };
  if (platform !== 'win32') return { mode: 'unavailable', echoExclusion: 'not-supported' };
  if (!Number.isSafeInteger(build) || build < 22_000) {
    return { mode: 'trtc-loopback', echoExclusion: 'unsupported', windowsBuild: build };
  }
  if (!enabled) return { mode: 'unavailable', echoExclusion: 'disabled', windowsBuild: build };
  return { mode: 'process-exclusion', echoExclusion: 'supported', windowsBuild: build };
}

function resolveHelperPath({ packaged, resourcesPath, appPath }) {
  const candidates = packaged
    ? [path.join(resourcesPath, 'native', 'desktop-pet-process-loopback.exe')]
    : [
        path.join(appPath, 'native', 'windows-process-loopback', 'build', 'Release', 'desktop-pet-process-loopback.exe'),
        path.join(appPath, 'native', 'windows-process-loopback', 'build', 'desktop-pet-process-loopback.exe'),
      ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

class FrameDecoder {
  constructor(onFrame, onError) {
    this.buffer = Buffer.alloc(0);
    this.onFrame = onFrame;
    this.onError = onError;
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (this.buffer.length + chunk.length > MAX_BUFFER_BYTES) {
      this.buffer = Buffer.alloc(0);
      this.onError('buffer_overflow');
      return;
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= FRAME_HEADER_BYTES) {
      const magic = this.buffer.readUInt32LE(0);
      const version = this.buffer.readUInt16LE(4);
      const type = this.buffer.readUInt16LE(6);
      const sequence = Number(this.buffer.readBigUInt64LE(8));
      const ptsMs = Number(this.buffer.readBigUInt64LE(16));
      const payloadLength = this.buffer.readUInt32LE(24);
      const flags = this.buffer.readUInt32LE(28);
      if (magic !== FRAME_MAGIC || version !== FRAME_VERSION || type !== FRAME_TYPE_PCM
        || payloadLength !== PCM_FRAME_BYTES) {
        this.buffer = Buffer.alloc(0);
        this.onError('invalid_frame_header');
        return;
      }
      const totalLength = FRAME_HEADER_BYTES + payloadLength;
      if (this.buffer.length < totalLength) return;
      const pcm = Buffer.from(this.buffer.subarray(FRAME_HEADER_BYTES, totalLength));
      this.buffer = this.buffer.subarray(totalLength);
      this.onFrame({ sequence, ptsMs, flags, pcm });
    }
  }
}

function createWindowsProcessLoopbackManager({
  helperPath,
  rootProcessId,
  onFrame,
  onStatus,
  spawnProcess = spawn,
  fileExists = fs.existsSync,
}) {
  let active = null;

  const status = (event, fields = {}) => onStatus?.({ event, ...fields });

  function stop(expectedGeneration) {
    if (!active || (expectedGeneration != null && expectedGeneration !== active.generation)) return;
    const record = active;
    active = null;
    record.expectedStop = true;
    const current = record.process;
    try { current.stdin.write(Buffer.from([0])); } catch {}
    try { current.stdin.end(); } catch {}
    const forceTimer = setTimeout(() => {
      try { current.kill(); } catch {}
    }, 1_000);
    forceTimer.unref?.();
    current.once('exit', () => clearTimeout(forceTimer));
  }

  function start(nextGeneration) {
    if (!Number.isSafeInteger(nextGeneration) || nextGeneration <= 0) {
      return { ok: false, error: 'invalid_generation' };
    }
    if (!fileExists(helperPath)) return { ok: false, error: 'helper_missing' };
    stop();
    let record = null;
    const decoder = new FrameDecoder(
      (frame) => {
        if (active === record) onFrame?.({ generation: nextGeneration, ...frame });
      },
      (error) => {
        if (active !== record) return;
        status('protocol-error', { generation: nextGeneration, error });
        stop(nextGeneration);
      },
    );
    let spawned;
    try {
      spawned = spawnProcess(helperPath, [
        '--exclude-pid', String(rootProcessId),
        '--sample-rate', '48000',
        '--channels', '2',
        '--frame-ms', '20',
      ], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      return { ok: false, error: 'helper_spawn_failed' };
    }
    record = { process: spawned, generation: nextGeneration, expectedStop: false };
    active = record;
    const current = record.process;
    current.stdout.on('data', (chunk) => decoder.push(chunk));
    let stderr = '';
    current.stderr.on('data', (chunk) => {
      if (active !== record) return;
      stderr = (stderr + String(chunk)).slice(-8_192);
      let lineEnd;
      while ((lineEnd = stderr.indexOf('\n')) >= 0) {
        const line = stderr.slice(0, lineEnd).trim().slice(0, 2_048);
        stderr = stderr.slice(lineEnd + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          const safe = {
            generation: nextGeneration,
            code: String(parsed.code || '').slice(0, 96),
            droppedFrames: Number.isSafeInteger(parsed.droppedFrames) ? parsed.droppedFrames : undefined,
          };
          status('helper-status', safe);
        } catch {
          status('helper-status', { generation: nextGeneration, code: 'unparseable_status' });
        }
      }
    });
    current.once('error', () => {
      if (active !== record) return;
      active = null;
      status('helper-error', { generation: nextGeneration, error: 'helper_process_error' });
    });
    current.once('exit', (code) => {
      if (active === record) active = null;
      status('helper-exit', {
        generation: nextGeneration,
        code: Number.isInteger(code) ? code : null,
        expected: record.expectedStop,
      });
    });
    status('helper-started', { generation: nextGeneration, protocolVersion: FRAME_VERSION });
    return { ok: true, protocolVersion: FRAME_VERSION };
  }

  return { start, stop, isRunning: () => !!active };
}

module.exports = {
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  FRAME_VERSION,
  MAX_PENDING_IPC_FRAMES,
  PCM_FRAME_BYTES,
  FrameDecoder,
  createFrameDeliveryQueue,
  createWindowsProcessLoopbackManager,
  processLoopbackCapability,
  resolveHelperPath,
  windowsBuildNumber,
};
