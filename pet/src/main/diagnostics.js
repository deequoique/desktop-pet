const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');

const SENSITIVE_KEY = /(secret|password|credential|authorization|api.?key|access.?token|refresh.?token|audio(data|bytes|buffer|content)?|(^|_)sdp$|session.?description)/i;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const LOG_GENERATIONS = 3;
const MAX_RENDERER_PAYLOAD_BYTES = 32 * 1024;
const MAX_INCIDENTS = 10;
const MAX_INCIDENT_BREADCRUMBS = 200;
const MAX_CRASH_ARTIFACTS = 5;
const MAX_STRING_LENGTH = 4096;
const MAX_ARRAY_LENGTH = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 6;
const LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);
const RECOVERABILITY = new Set(['automatic', 'retryable', 'user_action', 'fatal']);
const DOMAINS = new Set(['app', 'config', 'socket', 'call', 'webrtc', 'media', 'tts', 'note', 'update', 'storage']);
const RENDERER_EVENT_PREFIXES = [...DOMAINS].map((domain) => `${domain}.`);
const STABLE_IDENTIFIER_KEY = /(device|participant)id$/i;

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

function diagnosticIdentifier(value) {
  const text = String(value || '');
  if (!text || text.startsWith('sha256:')) return text;
  return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

function protectStableIdentifiers(value, key = '', seen = new WeakSet()) {
  if (STABLE_IDENTIFIER_KEY.test(key)) return diagnosticIdentifier(value);
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => protectStableIdentifiers(item, '', seen));
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      protectStableIdentifiers(childValue, childKey, seen),
    ]),
  );
}

function redactDiagnosticValue(value, key = '', seen = new WeakSet()) {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (key === 'candidate' && typeof value === 'string' && /^candidate:/i.test(value)) {
    return '[RAW_ICE_CANDIDATE_OMITTED]';
  }
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

function sanitizeDiagnosticValue(value, key = '', depth = 0, seen = new WeakSet()) {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (key === 'candidate' && typeof value === 'string' && /^candidate:/i.test(value)) {
    return '[RAW_ICE_CANDIDATE_OMITTED]';
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return '[BINARY_OMITTED]';
  }
  if (typeof value === 'string') {
    const redacted = redactString(value);
    return redacted.length > MAX_STRING_LENGTH ? `${redacted.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]` : redacted;
  }
  if (value == null || ['number', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return String(value);
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_ARRAY_LENGTH)
      .map((item) => sanitizeDiagnosticValue(item, '', depth + 1, seen));
    if (value.length > MAX_ARRAY_LENGTH) result.push(`[${value.length - MAX_ARRAY_LENGTH} ITEMS OMITTED]`);
    return result;
  }
  const result = {};
  const entries = Object.entries(value);
  for (const [childKey, childValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
    result[childKey] = sanitizeDiagnosticValue(childValue, childKey, depth + 1, seen);
  }
  if (entries.length > MAX_OBJECT_KEYS) result._omittedKeys = entries.length - MAX_OBJECT_KEYS;
  return result;
}

function boundedPayload(value) {
  const sanitized = sanitizeDiagnosticValue(value == null ? {} : value);
  let serialized;
  try {
    serialized = JSON.stringify(sanitized);
  } catch {
    return { truncated: true, reason: 'serialization_failed' };
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= MAX_RENDERER_PAYLOAD_BYTES) return sanitized;
  return {
    truncated: true,
    originalBytes: bytes,
    preview: serialized.slice(0, Math.min(8192, MAX_STRING_LENGTH)),
  };
}

function normalizeException(value) {
  if (!value) return undefined;
  if (value instanceof Error) {
    return boundedPayload({
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause,
    });
  }
  if (typeof value === 'string') return { message: redactString(value).slice(0, MAX_STRING_LENGTH) };
  const normalized = boundedPayload(value);
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    return {
      ...normalized,
      message: String(normalized.message || normalized.name || 'Unknown error').slice(0, MAX_STRING_LENGTH),
    };
  }
  return { message: String(normalized) };
}

function inferDomain(event) {
  const prefix = String(event || '').split(/[.-]/, 1)[0];
  return DOMAINS.has(prefix) ? prefix : 'app';
}

function normalizeEventName(event) {
  const value = String(event || 'app.unknown').trim().slice(0, 120);
  return /^[a-z0-9][a-z0-9._-]*$/i.test(value) ? value : 'app.invalid-event';
}

function createDiagnosticEntry(eventOrInput, payload = {}, meta = {}) {
  const input = eventOrInput && typeof eventOrInput === 'object'
    ? eventOrInput
    : { event: eventOrInput, context: payload };
  const event = normalizeEventName(input.event);
  const level = LEVELS.has(input.level) ? input.level : (LEVELS.has(meta.level) ? meta.level : 'info');
  const domain = DOMAINS.has(input.domain) ? input.domain : (DOMAINS.has(meta.domain) ? meta.domain : inferDomain(event));
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    domain,
    event,
    source: String(meta.source || input.source || 'electron-main').slice(0, 64),
    appVersion: String(meta.appVersion || input.appVersion || 'unknown').slice(0, 64),
    runtimeSessionId: String(meta.runtimeSessionId || input.runtimeSessionId || 'unknown').slice(0, 128),
  };
  if (input.errorCode) entry.errorCode = String(input.errorCode).slice(0, 120);
  const recoverability = RECOVERABILITY.has(input.recoverability) ? input.recoverability : meta.recoverability;
  if (RECOVERABILITY.has(recoverability)) entry.recoverability = recoverability;
  const correlation = boundedPayload(protectStableIdentifiers(input.correlation || meta.correlation || {}));
  if (correlation && Object.keys(correlation).length) entry.correlation = correlation;
  const context = boundedPayload(protectStableIdentifiers(input.context ?? payload));
  if (context && (typeof context !== 'object' || Object.keys(context).length)) entry.context = context;
  const exception = normalizeException(input.exception);
  if (exception) entry.exception = exception;
  return redactDiagnosticValue(entry);
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

function appendDiagnosticEntry(logFile, entry) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    rotateLog(logFile);
    fs.appendFileSync(logFile, `${JSON.stringify(redactDiagnosticValue(entry))}\n`, 'utf8');
    return true;
  } catch (error) {
    console.warn('[diagnostics] log write failed:', error?.message || error);
    return false;
  }
}

function appendDiagnostic(logFile, event, payload = {}, meta = {}) {
  return appendDiagnosticEntry(logFile, createDiagnosticEntry(event, payload, meta));
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

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(redactDiagnosticValue(value), null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function incidentFingerprint(entry) {
  const topFrame = String(entry.exception?.stack || '').split('\n', 2)[1] || '';
  return createHash('sha256')
    .update(`${entry.errorCode || entry.event}|${entry.source}|${topFrame}`)
    .digest('hex')
    .slice(0, 24);
}

function readIncidents(incidentFile) {
  const value = readJson(incidentFile, []);
  return Array.isArray(value) ? value.slice(-MAX_INCIDENTS) : [];
}

function recordIncident(incidentFile, entry, breadcrumbs = [], snapshot = {}) {
  try {
    const incidents = readIncidents(incidentFile);
    const fingerprint = incidentFingerprint(entry);
    const existing = incidents.find((incident) => incident.fingerprint === fingerprint && incident.status === 'pending');
    if (existing) {
      existing.lastSeenAt = entry.timestamp;
      existing.count = Number(existing.count || 1) + 1;
      existing.level = entry.level;
      existing.context = entry.context;
      existing.exception = entry.exception;
      existing.breadcrumbs = breadcrumbs.slice(-MAX_INCIDENT_BREADCRUMBS);
      existing.snapshot = boundedPayload(snapshot);
      writeJsonAtomic(incidentFile, incidents.slice(-MAX_INCIDENTS));
      return existing;
    }
    const incident = {
      id: randomUUID(),
      fingerprint,
      status: 'pending',
      firstSeenAt: entry.timestamp,
      lastSeenAt: entry.timestamp,
      count: 1,
      level: entry.level,
      domain: entry.domain,
      event: entry.event,
      errorCode: entry.errorCode || `${entry.domain}_unexpected`,
      source: entry.source,
      recoverability: entry.recoverability,
      message: entry.exception?.message || entry.errorCode || entry.event,
      correlation: entry.correlation,
      context: entry.context,
      exception: entry.exception,
      breadcrumbs: breadcrumbs.slice(-MAX_INCIDENT_BREADCRUMBS),
      snapshot: boundedPayload(snapshot),
    };
    incidents.push(incident);
    writeJsonAtomic(incidentFile, incidents.slice(-MAX_INCIDENTS));
    return incident;
  } catch (error) {
    console.warn('[diagnostics] incident write failed:', error?.message || error);
    return null;
  }
}

function acknowledgeIncidents(incidentFile, id, resolution = 'dismissed') {
  try {
    const incidents = readIncidents(incidentFile);
    let changed = false;
    for (const incident of incidents) {
      if (incident.status !== 'pending' || (id && incident.id !== id)) continue;
      incident.status = resolution;
      incident.resolvedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) writeJsonAtomic(incidentFile, incidents);
    return changed;
  } catch (error) {
    console.warn('[diagnostics] incident update failed:', error?.message || error);
    return false;
  }
}

function validateRendererDiagnosticInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'invalid_payload' };
  let serialized;
  try { serialized = JSON.stringify(input); } catch { return { ok: false, error: 'invalid_payload' }; }
  if (Buffer.byteLength(serialized) > MAX_RENDERER_PAYLOAD_BYTES) return { ok: false, error: 'payload_too_large' };
  const event = normalizeEventName(input.event);
  if (!RENDERER_EVENT_PREFIXES.some((prefix) => event.startsWith(prefix))) {
    return { ok: false, error: 'invalid_event' };
  }
  const domain = DOMAINS.has(input.domain) ? input.domain : inferDomain(event);
  if (!event.startsWith(`${domain}.`)) return { ok: false, error: 'domain_mismatch' };
  return {
    ok: true,
    value: {
      event,
      domain,
      level: LEVELS.has(input.level) ? input.level : 'info',
      ...(input.errorCode ? { errorCode: String(input.errorCode).slice(0, 120) } : {}),
      ...(RECOVERABILITY.has(input.recoverability) ? { recoverability: input.recoverability } : {}),
      correlation: boundedPayload(input.correlation || {}),
      context: boundedPayload(input.context || {}),
      ...(input.exception ? { exception: normalizeException(input.exception) } : {}),
    },
  };
}

function beginDiagnosticSession(sessionFile, session) {
  const previous = readJson(sessionFile, null);
  try {
    writeJsonAtomic(sessionFile, {
      status: 'active',
      runtimeSessionId: session.runtimeSessionId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      appVersion: session.appVersion,
    });
  } catch (error) {
    console.warn('[diagnostics] session marker write failed:', error?.message || error);
  }
  return previous?.status === 'active' ? previous : null;
}

function completeDiagnosticSession(sessionFile, runtimeSessionId) {
  try {
    writeJsonAtomic(sessionFile, {
      status: 'clean',
      runtimeSessionId,
      pid: process.pid,
      endedAt: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    console.warn('[diagnostics] clean session marker failed:', error?.message || error);
    return false;
  }
}

function readCrashArtifactMetadata(directory, limit = MAX_CRASH_ARTIFACTS) {
  try {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(directory, entry.name);
        const stat = fs.statSync(file);
        return {
          name: entry.name,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
      .slice(0, limit);
  } catch (error) {
    return [{ error: redactString(error?.message || String(error)) }];
  }
}

module.exports = {
  LOG_GENERATIONS,
  MAX_CRASH_ARTIFACTS,
  MAX_INCIDENT_BREADCRUMBS,
  MAX_INCIDENTS,
  MAX_LOG_BYTES,
  MAX_RENDERER_PAYLOAD_BYTES,
  acknowledgeIncidents,
  appendDiagnostic,
  appendDiagnosticEntry,
  beginDiagnosticSession,
  boundedPayload,
  clampBoundsToWorkArea,
  clampScale,
  completeDiagnosticSession,
  createDiagnosticEntry,
  diagnosticIdentifier,
  readCrashArtifactMetadata,
  readDiagnosticLogs,
  readIncidents,
  recordIncident,
  redactDiagnosticValue,
  redactString,
  rotateLog,
  sanitizeDiagnosticValue,
  validateRendererDiagnosticInput,
};
