/**
 * Mahyar Music — shared worker diagnostics helpers.
 *
 * Used by BOTH sides of the music worker boundary:
 *  - bot.ts          (parent: captures worker stdout/stderr, reports failures)
 *  - worker-main.ts  (child: emits per-step startup diagnostics)
 *
 * Everything that can ever be printed, tailed or forwarded goes through
 * `sanitizeText()` first. The music flow handles presigned S3 URLs, LiveKit
 * tokens, API keys and secrets; none of those may reach the logs.
 */

/** Upper bound for retained stream tails (per stream, in characters). */
export const TAIL_LIMIT = 8_000;

/**
 * Keys whose values must never appear in diagnostics, case-insensitively.
 * Matched as `key=value`, `key: value` or `key:value` pairs.
 */
const SENSITIVE_KEYS = [
  'api[_-]?key',
  'api[_-]?secret',
  'secret',
  'token',
  'access[_-]?token',
  'password',
  'passwd',
  'authorization',
  'signature',
  'sig',
  'credential[s]?',
  'x-amz-[a-z-]+',
  'session',
  'cookie'
];

const SENSITIVE_PAIR = new RegExp(`(${SENSITIVE_KEYS.join('|')})\\s*[:=]\\s*([^\\s&"',;)]+)`, 'gi');

/** JWT-shaped blobs (LiveKit tokens, S3 session tokens, …): eyJ<base64>.<base64>.<base64> */
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;

/** Authorization header values: `Bearer <anything>` / `Basic <anything>`. */
const AUTH_HEADER = /\b(bearer|basic)\s+\S+/gi;

/** Long hex secrets (64+ chars) such as S3 signatures or API secrets. */
const LONG_HEX = /\b[0-9a-f]{64,}\b/gi;

/**
 * Redact the query string of any URL (http(s), ws(s) or a bare presigned S3
 * path with a query) while keeping scheme/host/path — the path alone is
 * enough to diagnose a bad storage key, the query is where secrets live.
 */
function redactUrlQueries(text: string): string {
  return text
    // absolute URLs
    .replace(/\b(?:https?|wss?):\/\/[^\s'"<>]*\?[^\s'"<>]*/gi, (match) => match.replace(/\?.*$/, '?<redacted>'))
    // bare object paths with presigned query (e.g. music/track 1.mp3?X-Amz-...);
    // the path class allows spaces so filenames with spaces are covered too;
    // `+` (not `*`) so an already-collapsed `?<redacted>` is not matched again
    .replace(/([\w ./-]{4,}\.(?:mp3|ogg|wav|m4a|flac|aac|opus|webm))\?[^\s'"<>]+/gi, (_m, path: string) => `${path}?<redacted>`);
}

/**
 * Make arbitrary worker output safe for logs:
 *  - collapse URL query strings FIRST (presigned parameters, tokens) — before
 *    any other rule inserts `<redacted>` markers, which would otherwise stop
 *    the URL matcher early and leave query fragments behind;
 *  - replace configured secrets with `***`;
 *  - mask JWTs, long hex secrets and sensitive key/value pairs;
 *  - strip ANSI escapes (keeps Railway deploy logs readable).
 * Never throws; always returns a string.
 */
export function sanitizeText(text: string, secrets: Array<string | undefined> = []): string {
  let out = redactUrlQueries(String(text ?? ''));
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join('***');
      // URL-encoded forms too (secrets can appear inside query strings)
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) out = out.split(encoded).join('***');
    }
  }
  out = out
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(JWT_LIKE, '***')
    .replace(AUTH_HEADER, '$1 ***')
    .replace(LONG_HEX, '***')
    .replace(SENSITIVE_PAIR, (_m, key: string) => `${key}=<redacted>`);
  return out;
}

/** Keep only the last `limit` characters of a stream tail. */
export function boundedTail(current: string, chunk: string, limit: number = TAIL_LIMIT): string {
  return (current + chunk).slice(-limit);
}

/** Last `lines` non-empty lines of a tail, joined for a single-line log field. */
export function tailSummary(tail: string, lines = 4): string {
  return tail
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(' | ');
}

/** Redacted host:port of a LiveKit URL — enough to spot a wrong region, no credentials. */
export function urlHost(url: string | undefined | null): string {
  if (!url) return '(not set)';
  try {
    const parsed = new URL(url.replace(/^ws(s):/, 'http$1:'));
    return `${parsed.protocol.replace(/^http/, 'ws')}//${parsed.host}`;
  } catch {
    return '(unparseable URL)';
  }
}

/** Best-effort glibc vs musl report for the current process. */
export function libcFlavor(): string {
  try {
    const report = (process as unknown as { report?: { getReport?: () => { header?: { glibcVersionRuntime?: string; glibcVersionCompiler?: string } } } }).report;
    const glibc = report?.getReport?.().header?.glibcVersionRuntime;
    if (glibc) return `glibc ${glibc}`;
  } catch { /* report unavailable */ }
  return 'glibc/musl unknown (report unavailable)';
}
