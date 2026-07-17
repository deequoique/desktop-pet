const fs = require('fs');
const path = require('path');

const SENSITIVE_KEY = /(secret|password|credential|authorization|api.?key|access.?token|refresh.?token|audio(data|bytes|buffer|content)?)/i;
const MAX_LOG_BYTES = 1024 * 1024;
const LOG_GENERATIONS = 2;

function clampScale(value, min = 0.3, max = 1.5) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(max, Math.max(min, parsed));
}

function clampBoundsToWorkArea(bounds, workArea) {
  const width = Math.max(1, Math.round(Number(bounds.width) || 1));
  const height = Math.max(1, Math.round(Number(bounds.height) || 1));
  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = Math.max(minX, workArea.x + workArea.width - width);
  const maxY = Math.max(minY, workArea.y + workArea.height - height);
  return {
    x: Math.min(maxX, Math.max(minX, Math.round(Number(bounds.x) || 0))),
    y: Math.min(maxY, Math.max(minY, Math.round(Number(bounds.y) || 0))),
    width,
    height,
  };
}

function redactString(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_API_KEY]')
    .replace(/((?:room[_-]?secret|api[_-]?key|password|credential|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function redactDiagnosticValue(value, key = '', seen = new WeakSet()) {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return '[BINARY_OMITTED]';
  }
  if (typeof value === 'string') return redactString(value);
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item, '', seen));
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = redactDiagnosticValue(childValue, childKey, seen);
  }
  return result;
}

function rotateLog(logFile, maxBytes = MAX_LOG_BYTES, generations = LOG_GENERATIONS) {
  try {
    if (!fs.existsSync(logFile) || fs.statSync(logFile).size < maxBytes) return;
    for (let index = generations; index >= 1; index -= 1) {
      const source = index === 1 ? logFile : `${logFile}.${index - 1}`;
      const target = `${logFile}.${index}`;
      if (!fs.existsSync(source)) continue;
      try { fs.unlinkSync(target); } catch {}
      fs.renameSync(source, target);
    }
  } catch (error) {
    console.warn('[diagnostics] log rotation failed:', error?.message || error);
  }
}

function appendDiagnostic(logFile, event, payload = {}) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    rotateLog(logFile);
    const entry = redactDiagnosticValue({
      timestamp: new Date().toISOString(),
      event: String(event || 'unknown'),
      payload,
    });
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch (error) {
    console.warn('[diagnostics] log write failed:', error?.message || error);
    return false;
  }
}

function readDiagnosticLogs(logFile, generations = LOG_GENERATIONS) {
  const files = [];
  for (let index = generations; index >= 1; index -= 1) files.push(`${logFile}.${index}`);
  files.push(logFile);
  return files.flatMap((file) => {
    try {
      if (!fs.existsSync(file)) return [];
      return [{ name: path.basename(file), content: redactString(fs.readFileSync(file, 'utf8')) }];
    } catch (error) {
      return [{ name: path.basename(file), error: redactString(error?.message || String(error)) }];
    }
  });
}

module.exports = {
  appendDiagnostic,
  clampBoundsToWorkArea,
  clampScale,
  readDiagnosticLogs,
  redactDiagnosticValue,
  redactString,
};
