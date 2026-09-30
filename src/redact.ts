/**
 * Remove secrets from errors before they cross a trust boundary (log, API or
 * Telegram). Some scraper helpers include the entire POST body in parse errors,
 * which can contain a plaintext password after DPAPI has been opened.
 */
const SECRET_KEYS =
  '(?:password|pass|sisma|token|otp(?:LongTerm)?Token|id|misparZihuy|kodMishtamesh|cardSuffix|card6Digits|username)';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactSecrets(input: unknown, knownSecrets: Iterable<string> = []): string {
  let text = input instanceof Error ? input.message : String(input ?? '');

  // Exact replacement is the strongest protection: it also catches a secret in
  // an unexpected field or response body. Ignore tiny values to avoid turning a
  // normal error into a wall of [REDACTED].
  const values = [...new Set([...knownSecrets].map(String).filter((v) => v.length >= 3).flatMap(value => [
    value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2),
  ]))].sort(
    (a, b) => b.length - a.length,
  );
  for (const value of values) text = text.replace(new RegExp(escapeRegExp(value), 'g'), '[REDACTED]');

  // Defence in depth for errors produced before the caller has the credential
  // list. Covers JSON, query-string and object-inspection shapes.
  text = text
    .replace(/\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED]')
    .replace(/dpapi:[A-Za-z0-9+/=]{20,}/g, '[REDACTED]')
    .replace(new RegExp(`("${SECRET_KEYS}"\\s*:\\s*")[^"]*(")`, 'giu'), '$1[REDACTED]$2')
    .replace(new RegExp(`('(?:${SECRET_KEYS})'\\s*:\\s*')[^']*(')`, 'giu'), '$1[REDACTED]$2')
    .replace(new RegExp(`((?:^|[?&\\s,])${SECRET_KEYS}\\s*[=:]\\s*)[^&\\s,}]+`, 'giu'), '$1[REDACTED]');

  // Provider responses can be very large HTML documents. They are useless in a
  // dashboard log and increase the chance of persisting personal data.
  return text.length > 2_000 ? `${text.slice(0, 2_000)}… [truncated]` : text;
}

export function safeErrorMessage(error: unknown, knownSecrets: Iterable<string> = []): string {
  return redactSecrets(error instanceof Error ? error.message : error, knownSecrets);
}
