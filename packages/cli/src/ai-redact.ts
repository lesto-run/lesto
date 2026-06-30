/**
 * The redaction stage for the in-preview AI surface (ADR 0033 Phase 1 #5).
 *
 * The Cmd-K chat overlay and the "Ask Claude to fix" button assemble a read-only
 * full-stack context payload (route, handler `file:line`, the last request's
 * `traceId`, the content collections, the open `DevError`) and forward it to an
 * EXTERNAL LLM. That payload is NOT "RUM-equivalent paths+timing": a `DevError`'s
 * `stack`/`message` carry absolute filesystem paths and frequently secret-shaped
 * tokens (`run.ts:139-145`), SQL text carries literal bind values, and the console
 * carries raw app output. None of that may leave the process.
 *
 * `redactContext` is the stage that strips it. It is a PURE transform — same input,
 * same output; no I/O, no clock, no randomness, and it NEVER throws (a redactor that
 * can throw is a redactor that can be bypassed). Every string field is run through
 * the same {@link redactString} pass, so a new field can never silently skip
 * redaction. The bridge (`ai-bridge.ts`, Inc 3) and the fix-this button
 * (`dev-overlay.ts`, Inc 5) call this BEFORE the seam sees the payload; the coded
 * refusal that guards a redactor-BYPASS path lives on the bridge, not here, because
 * this transform's contract is precisely that it cannot fail.
 *
 * The four rules, applied in order to every string (order matters — paths and SQL
 * binds are stripped before the high-entropy token sweep, so a stripped path token
 * isn't double-flagged):
 *   1. Absolute filesystem paths → `<path>` (POSIX `/Users…`/`/home…`/any
 *      `/seg/seg…`, Windows `C:\…`, and UNC `\\host\share\…`), so no machine/home
 *      path or internal share name escapes.
 *   2. SQL bind values → the query SHAPE only: a quoted literal becomes `?`, a bare
 *      numeric literal in a value position becomes `?`.
 *   3. Env/secret-shaped tokens → `<redacted>`: `KEY=`/`SECRET=`/`TOKEN=`/`PASSWORD=`
 *      assignments, `Bearer <token>` headers, connection-string credentials, AWS
 *      access-key ids (`AKIA…`/`ASIA…`, which sit below the entropy floor), and long
 *      high-entropy hex/base64 runs.
 *   4. Raw browser-console lines are DROPPED entirely in Phase 1 (their structured
 *      ingest is a deferred phase that must re-pass this stage).
 *
 * This is DEFENSE IN DEPTH on a dev-only, inspect-only PREVIEW surface, not a perfect
 * exfiltration guard: it scrubs the common, high-signal secret/path SHAPES. Broadening
 * to the long tail of vendor key prefixes and sub-entropy-floor tokens is tracked
 * separately (it wants its own test-vector corpus).
 */

/** The open dev error the overlay holds — the same shape `run.ts` broadcasts. */
export interface RedactableDevError {
  readonly source: string;

  readonly message: string;

  readonly stack?: string;
}

/**
 * The read-only context payload the overlay assembles and the bridge forwards.
 *
 * Defined here (not imported from the not-yet-built `ai-context.ts`, Inc 4a) so the
 * redactor owns the exact shape it guarantees to scrub; Inc 4a's assembler conforms
 * to it. Every textual field listed here is redacted; `consoleLines` is dropped.
 */
export interface AiContextPayload {
  /** The current route/path the overlay was opened on. */
  readonly route: string;

  /** The handler `file:line` (`data-lesto-loc`, ADR 0032 Phase 2), when present. */
  readonly handlerLocation?: string;

  /** The last request's trace id — the ID only, never span text (ADR 0031). */
  readonly traceId?: string;

  /** The content collection names exposed by `list_content_collections`. */
  readonly collections?: readonly string[];

  /** The open dev error overlay payload, when "Ask Claude to fix" forwards one. */
  readonly devError?: RedactableDevError;

  /** Recent SQL the request ran — redacted to query SHAPE only (binds stripped). */
  readonly sql?: readonly string[];

  /**
   * Raw browser-console lines. DROPPED entirely in Phase 1 — present on the input
   * type only so the assembler can carry them up to (and no further than) this stage.
   */
  readonly consoleLines?: readonly string[];
}

/** The redacted payload — same fields, scrubbed; `consoleLines` is always gone. */
export interface RedactedContext {
  readonly route: string;

  readonly handlerLocation?: string;

  readonly traceId?: string;

  readonly collections?: readonly string[];

  readonly devError?: RedactableDevError;

  readonly sql?: readonly string[];
}

/** The placeholder a stripped absolute path collapses to. */
const PATH_PLACEHOLDER = "<path>";

/** The placeholder a secret-shaped token collapses to. */
const SECRET_PLACEHOLDER = "<redacted>";

/** The placeholder a stripped SQL bind literal collapses to. */
const BIND_PLACEHOLDER = "?";

/**
 * Absolute filesystem paths: a POSIX run of `/segment` parts (so `/Users/ryan/app`
 * or `/home/x/app/[id].tsx` collapses, route-param `[…]` brackets and `~` included,
 * but a lone URL path like `/posts` does NOT — it needs at least two segments to read
 * as a machine path), and a Windows `C:\dir\file` drive path. A trailing `:line:col`
 * is kept OUTSIDE the match so a stack frame's line number survives (`<path>:3:7`).
 */
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\[^\s:?*"<>|]+|\/(?:[\w.@%~+[\]-]+\/)+[\w.@%~+[\]-]+)/g;

/**
 * A Windows UNC path (`\\server\share\dir\file`) — distinct from the drive path above
 * and missed by it. UNC paths leak internal network topology (the server + share
 * names), so they collapse to `<path>` too. Requires at least the `\\host\share` head.
 */
const UNC_PATH = /\\\\[^\s\\?*"<>|]+\\[^\s?*"<>|]+/g;

/**
 * `KEY=`/`SECRET=`/`TOKEN=`/`PASSWORD=`/`PWD=` style assignments — the value (to the
 * next whitespace, quote, or separator) is the secret. Case-insensitive; the key name
 * is kept so the shape stays legible (`API_KEY=<redacted>`).
 */
const ENV_ASSIGNMENT = /\b([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PWD))\s*[=:]\s*\S+/gi;

/** `Bearer <token>` / `Basic <token>` authorization headers. */
const BEARER_TOKEN = /\b(Bearer|Basic)\s+[\w.~+/=-]+/gi;

/**
 * `scheme://user:password@host` connection-string credentials — strip the userinfo.
 * The password class allows `@` (matching greedily to the LAST `@` before the host) so
 * a password that itself contains `@` (`user:p@ss@host`) doesn't truncate the match and
 * leak `ss@host`; the `:password` requirement keeps a path-`@` (`https://h/a@b`) from
 * being mistaken for credentials.
 */
const CONNECTION_CREDENTIALS = /([a-z][\w+.-]*:\/\/)[^/\s:@]+:[^/\s]+@/gi;

/**
 * An AWS access-key id — `AKIA`/`ASIA` + 16 upper-alphanumerics (20 chars total). It
 * sits BELOW the 24-char high-entropy floor, so the generic sweep misses it, yet its
 * prefix is unambiguous (zero false positives) and it routinely rides in stack traces.
 */
const AWS_ACCESS_KEY = /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g;

/**
 * A long high-entropy run — a 24+ char hex or base64url token (env secrets, signing
 * keys, opaque bearer values that escaped the patterns above). The 24-char floor is
 * what separates a secret from an ordinary identifier/word, so this never eats a
 * normal `requestId` or a short hash.
 */
const HIGH_ENTROPY = /\b[A-Za-z0-9_+/=-]{24,}\b/g;

/** A single-quoted SQL string literal — its CONTENTS are the bind value to strip. */
const SQL_STRING_LITERAL = /'(?:[^']|'')*'/g;

/**
 * A bare numeric literal in a value position (`= 42`, `IN (1, 2)`, `VALUES (10)`) —
 * the operator/separator/paren is kept, the number becomes `?`. Anchored on a
 * preceding `=`/`(`/`,`/whitespace-keyword boundary so a column like `col2` or an
 * identifier digit is never touched.
 */
const SQL_NUMERIC_LITERAL = /([=(,]\s*)\d+(\.\d+)?\b/g;

/**
 * Strip absolute filesystem paths, keeping a trailing `:line:col` so stack frames
 * stay useful. A Windows or POSIX absolute path collapses to `<path>`.
 */
export function stripAbsolutePaths(input: string): string {
  return input.replace(ABSOLUTE_PATH, PATH_PLACEHOLDER).replace(UNC_PATH, PATH_PLACEHOLDER);
}

/**
 * Reduce a SQL string to its query SHAPE: every single-quoted literal and bare
 * numeric value becomes `?`, so the structure is legible to the model but no bind
 * value (which routinely carries PII/tokens) ever leaves the process.
 */
export function stripSqlBindValues(input: string): string {
  return input
    .replace(SQL_STRING_LITERAL, BIND_PLACEHOLDER)
    .replace(SQL_NUMERIC_LITERAL, (_match, lead: string) => `${lead}${BIND_PLACEHOLDER}`);
}

/**
 * Redact env/secret-shaped tokens: `KEY=…` assignments, `Bearer …` headers,
 * connection-string credentials, AWS access-key ids, and long high-entropy runs all
 * collapse to `<redacted>` (assignments keep their key name for legibility).
 */
export function stripSecretTokens(input: string): string {
  return input
    .replace(ENV_ASSIGNMENT, (_match, key: string) => `${key}=${SECRET_PLACEHOLDER}`)
    .replace(BEARER_TOKEN, (_match, scheme: string) => `${scheme} ${SECRET_PLACEHOLDER}`)
    .replace(CONNECTION_CREDENTIALS, (_match, scheme: string) => `${scheme}${SECRET_PLACEHOLDER}@`)
    .replace(AWS_ACCESS_KEY, SECRET_PLACEHOLDER)
    .replace(HIGH_ENTROPY, SECRET_PLACEHOLDER);
}

/**
 * Run one string through the full redaction pass — paths, then SQL binds, then
 * secret tokens. Order is deliberate: paths and binds are normalized first so the
 * high-entropy sweep doesn't double-flag a fragment another rule already handled.
 * Pure and total: any string in, a scrubbed string out, never a throw.
 */
export function redactString(input: string): string {
  return stripSecretTokens(stripSqlBindValues(stripAbsolutePaths(input)));
}

/** Redact a `DevError`'s textual fields (its `source` is an enum, left as-is). */
function redactDevError(error: RedactableDevError): RedactableDevError {
  const stack = error.stack === undefined ? undefined : redactString(error.stack);

  return {
    source: error.source,
    message: redactString(error.message),
    // Only carry `stack` when the input had one — keep the optional field optional.
    ...(stack === undefined ? {} : { stack }),
  };
}

/**
 * Redact a context payload before it can be forwarded to an external LLM.
 *
 * Runs the full {@link redactString} pass over every textual field, reduces SQL to
 * its bind-free shape, and DROPS `consoleLines` entirely (Phase 1). Optional fields
 * stay optional — an absent field is absent in the output, never `undefined`-stamped
 * — so the redacted payload is a faithful, scrubbed mirror of the input. Pure and
 * total: it neither reads the world nor throws.
 */
export function redactContext(payload: AiContextPayload): RedactedContext {
  const redacted: {
    route: string;
    handlerLocation?: string;
    traceId?: string;
    collections?: readonly string[];
    devError?: RedactableDevError;
    sql?: readonly string[];
  } = { route: redactString(payload.route) };

  if (payload.handlerLocation !== undefined) {
    redacted.handlerLocation = redactString(payload.handlerLocation);
  }

  // The trace id is an opaque id, not free text — but it is still run through the
  // pass so a malformed/oversized value can never carry a secret out.
  if (payload.traceId !== undefined) redacted.traceId = redactString(payload.traceId);

  if (payload.collections !== undefined) {
    redacted.collections = payload.collections.map(redactString);
  }

  if (payload.devError !== undefined) redacted.devError = redactDevError(payload.devError);

  if (payload.sql !== undefined) {
    redacted.sql = payload.sql.map((statement) => redactString(statement));
  }

  // `consoleLines` is intentionally never copied — Phase 1 drops raw console output.
  return redacted;
}
