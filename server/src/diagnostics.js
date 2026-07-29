import { createHash, randomUUID } from 'node:crypto';

const SECRET_KEY = /(secret|token|password|credential|authorization|api[-_]?key|cookie|sdp|candidate)$/i;
const STABLE_IDENTIFIER_KEY = /(device|participant)id$/i;
const MAX_DEPTH = 6;
const MAX_KEYS = 80;
const MAX_ARRAY = 80;
const MAX_STRING = 2_000;
const RECOVERABILITY = new Set(['automatic', 'retryable', 'user_action', 'fatal']);

function clean(value, key = '', depth = 0, seen = new WeakSet()) {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (STABLE_IDENTIFIER_KEY.test(key)) {
    const text = String(value || '');
    if (!text || text.startsWith('sha256:')) return text;
    return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
  }
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return `[binary:${value.byteLength}]`;
  if (depth >= MAX_DEPTH) return '[max-depth]';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => clean(item, '', depth + 1, seen));
  const result = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_KEYS)) {
    const cleaned = clean(childValue, childKey, depth + 1, seen);
    if (cleaned !== undefined) result[childKey] = cleaned;
  }
  return result;
}

export function normalizeServerException(error) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return clean({
      name: error.name,
      message: error.message,
      code: error.code,
      stack: error.stack,
    });
  }
  return clean({ message: String(error) });
}

export function createServerDiagnostics({
  source = 'server',
  appVersion = '0.0.1',
  runtimeSessionId = randomUUID(),
  output = console,
} = {}) {
  const write = (level, domain, event, fields = {}) => {
    const entry = clean({
      timestamp: new Date().toISOString(),
      level,
      domain,
      event,
      source,
      appVersion,
      runtimeSessionId,
      processId: process.pid,
      instanceId: process.env.NODE_APP_INSTANCE || '0',
      errorCode: fields.errorCode,
      recoverability: RECOVERABILITY.has(fields.recoverability)
        ? fields.recoverability
        : level === 'fatal' ? 'fatal' : level === 'error' ? 'retryable' : undefined,
      correlation: fields.correlation,
      context: fields.context,
      exception: fields.exception ? normalizeServerException(fields.exception) : undefined,
    });
    const line = JSON.stringify(entry);
    if (level === 'fatal' || level === 'error') output.error(line);
    else if (level === 'warn') output.warn(line);
    else output.log(line);
    return entry;
  };
  return {
    runtimeSessionId,
    info: (domain, event, fields) => write('info', domain, event, fields),
    warn: (domain, event, fields) => write('warn', domain, event, fields),
    error: (domain, event, fields) => write('error', domain, event, fields),
    fatal: (domain, event, fields) => write('fatal', domain, event, fields),
  };
}

export function normalizeHttpRoute(req) {
  if (req.route?.path) return `${req.baseUrl || ''}${req.route.path}`;
  return String(req.path || req.url || '/')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}
