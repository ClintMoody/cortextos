/**
 * PTY output redaction.
 *
 * Secret-bearing output can reach the PTY capture stream whenever an agent
 * runs a shell command that prints credentials — curl -v against an
 * authenticated endpoint, wget --debug, openssl s_client, dumping a cookie
 * jar, etc. The PTY's OutputBuffer ring captures everything the child
 * process emits and also streams it verbatim to a persisted stdout.log.
 * Without redaction, any JWT, bearer token, or session cookie that happens
 * to appear in the agent's terminal ends up persisted to disk indefinitely.
 *
 * Origin: Roger's 2026-04-13 baseline security sweep found 16 JWTs in
 * boss/stdout.log — all curl -v verbose-mode output of the dashboard's
 * NextAuth session endpoint (`authjs.session-token=eyJ...`). Boss's initial
 * hypothesis was that a cortextOS code path was logging tokens, but the
 * actual cause is agent-level shell commands emitting the tokens on stdout
 * where the PTY captures them. The fix therefore lives at the PTY layer
 * (defense-in-depth for any future exposure via any tool) rather than in
 * an individual code path.
 *
 * Known limitation: PTY data arrives in OS-buffered chunks (typically 4KB
 * on Linux). If a chunk boundary happens to fall inside a JWT, neither
 * chunk matches the regex and the token slips through unredacted across
 * two push() calls. JWTs are typically 300-500 bytes so they fit in one
 * chunk in the overwhelming majority of real cases — all 16 leaks Roger
 * found fit in single chunks. Buffer-aware redaction (carry a trailing
 * partial-match buffer across chunks) is the follow-up if this edge case
 * ever surfaces in production. Test `chunk-boundary regression guard` in
 * output-buffer.test.ts locks this documented behavior in place so any
 * future change has to be explicit.
 */

/**
 * JWT shape: three base64url segments separated by dots, each at least
 * 10 characters long. The length qualifier prevents false positives on
 * random short alphanumeric sequences that happen to contain two dots
 * (e.g. "a.b.c" or "v1.2.3" would not match). `eyJ` prefix anchors on
 * the standard JWT header (base64 encoding of `{"alg":...` or
 * `{"typ":...`).
 */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/**
 * Redact JWT-shaped tokens from a PTY output chunk.
 *
 * Replaces each JWT with the literal string `[REDACTED_JWT]` in-place.
 * Non-token content (TUI ANSI escapes, regular stdout, shell prompts,
 * etc.) passes through unchanged. Safe to call on every PTY chunk — the
 * regex is stateless and scales linearly with input length.
 */
export function redactSecrets(data: string): string {
  return data.replace(JWT_PATTERN, '[REDACTED_JWT]');
}
