// Structured logging module.
// Writes JSON-style structured lines to stderr.
// Format: [timestamp] [LEVEL] message key1=value1 key2=value2

// Keys that must never appear in log output.
const REDACTED_KEYS = new Set([
  'token',
  'secret',
  'password',
  'api_key',
  'apikey',
  'authorization',
  'credentials',
]);

// Mutable context that gets merged into every log line.
let _context = {};

/**
 * Set persistent context fields (e.g. issue_id, session_id) that will be
 * included in every subsequent log entry.
 */
export function setContext(ctx) {
  _context = { ..._context, ...ctx };
}

/**
 * Replace the entire context (useful when switching issues/sessions).
 */
export function resetContext(ctx = {}) {
  _context = { ...ctx };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function timestamp() {
  return new Date().toISOString();
}

function formatFields(fields) {
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) continue;
    if (value === undefined || value === null) continue;
    const v = typeof value === 'string' && value.includes(' ') ? `"${value}"` : value;
    parts.push(`${key}=${v}`);
  }
  return parts.join(' ');
}

function log(level, message, extra = {}) {
  const fields = { ..._context, ...extra };
  const suffix = formatFields(fields);
  const line = `[${timestamp()}] [${level}] ${message}${suffix ? ' ' + suffix : ''}`;
  process.stderr.write(line + '\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function info(message, extra) {
  log('INFO', message, extra);
}

export function warn(message, extra) {
  log('WARN', message, extra);
}

export function error(message, extra) {
  log('ERROR', message, extra);
}

export function debug(message, extra) {
  if (process.env.SYMPHONY_DEBUG || process.env.DEBUG) {
    log('DEBUG', message, extra);
  }
}

export default { info, warn, error, debug, setContext, resetContext };
