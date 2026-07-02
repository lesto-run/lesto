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
 * exfiltration guard: it scrubs the common, high-signal secret/path SHAPES, including an
 * explicit list of vendor key prefixes that sit BELOW the generic entropy floor
 * ({@link VENDOR_SECRET}). The genuinely long tail beyond that list stays entropy-gated.
 * The SAME secret + SQL sweep also guards a dev-tool RESULT before it is reflected into the
 * overlay reply — {@link redactToolOutput}, which is structure-aware (it does NOT collapse
 * route paths the way the context redactor does, so `describe_app`'s routes survive).
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

/**
 * The phantom brand that makes {@link RedactedContext} a NOMINAL type: it exists only in the
 * type system (never at runtime), and the sole value that carries it is {@link redactContext}'s
 * return (via the one sanctioned cast at that boundary). So a raw {@link AiContextPayload} —
 * structurally identical but unbranded — is NOT assignable where a `RedactedContext` is required.
 */
declare const redactedBrand: unique symbol;

/**
 * The redacted payload — same fields, scrubbed; `consoleLines` is always gone. BRANDED so it
 * cannot be forged: the AI bridge requires this type as a turn's input, and the only way to
 * obtain one is to run a payload through {@link redactContext}. This is the type-level guard
 * the ADR promises — the model can never receive a non-redacted payload (a compile error, not
 * a convention).
 */
export interface RedactedContext {
  /** Phantom brand — type-only, never present at runtime; see {@link redactedBrand}. */
  readonly [redactedBrand]: true;

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
 * Known VENDOR secret shapes worth catching by explicit, near-zero-false-positive prefix —
 * several sit BELOW the 24-char {@link HIGH_ENTROPY} floor (short test keys) and all are more
 * legible caught by name than left to the entropy heuristic. Each arm is anchored on an
 * unambiguous prefix and requires a long, mostly-contiguous body, so an ordinary hyphenated
 * slug (`sk-really-long-component-name`) — which lacks a 20+ CONTIGUOUS alphanumeric run — does
 * not match. Runs BEFORE the generic entropy sweep so a prefixed key collapses as one unit; the
 * entropy sweep backstops any high-entropy tail an arm does not fully span. The long tail beyond
 * this list stays entropy-gated, and over-redaction is the safe direction on this surface.
 */
const VENDOR_SECRET = new RegExp(
  [
    String.raw`\b[srp]k_(?:live|test)_[0-9A-Za-z]{16,}`, // Stripe secret / restricted / publishable
    String.raw`\bwhsec_[0-9A-Za-z]{16,}`, // Stripe webhook signing secret
    String.raw`\bgh[pousr]_[0-9A-Za-z]{20,}`, // GitHub PAT / OAuth / user / server / refresh
    String.raw`\bgithub_pat_[0-9A-Za-z_]{20,}`, // GitHub fine-grained PAT
    String.raw`\bglpat-[0-9A-Za-z_-]{16,}`, // GitLab personal access token
    String.raw`\bxox[baprs]-[0-9A-Za-z-]{10,}`, // Slack bot / user / app / refresh token
    String.raw`\bAIza[0-9A-Za-z_-]{35}`, // Google API key
    String.raw`\bya29\.[0-9A-Za-z_-]{20,}`, // Google OAuth access token
    String.raw`\bsk-(?:proj-|ant-)?[0-9A-Za-z]{20,}`, // OpenAI / Anthropic (contiguous body → slug-safe)
    String.raw`\bnpm_[0-9A-Za-z]{20,}`, // npm automation token
    String.raw`\bSG\.[0-9A-Za-z_-]{20,}\.[0-9A-Za-z_-]{20,}`, // SendGrid API key
    String.raw`\bdo[opr]_v1_[0-9a-f]{20,}`, // DigitalOcean token
  ].join("|"),
  "g",
);

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
 * The DETERMINISTIC secret shapes: `KEY=…` assignments, `Bearer …` headers, connection-string
 * credentials, known vendor key prefixes ({@link VENDOR_SECRET}), and AWS access-key ids — each
 * collapses to `<redacted>` (assignments keep their key name for legibility). Every arm is
 * anchored on an explicit shape, so — unlike the generic {@link HIGH_ENTROPY} sweep, whose class
 * spans `/` — NONE of them matches a long route/URL path. This is the subset
 * {@link redactToolOutput} reuses to strip a secret from a tool result's string leaf while
 * leaving that result's routes intact.
 */
function stripKnownSecretShapes(input: string): string {
  return input
    .replace(ENV_ASSIGNMENT, (_match, key: string) => `${key}=${SECRET_PLACEHOLDER}`)
    .replace(BEARER_TOKEN, (_match, scheme: string) => `${scheme} ${SECRET_PLACEHOLDER}`)
    .replace(CONNECTION_CREDENTIALS, (_match, scheme: string) => `${scheme}${SECRET_PLACEHOLDER}@`)
    .replace(VENDOR_SECRET, SECRET_PLACEHOLDER)
    .replace(AWS_ACCESS_KEY, SECRET_PLACEHOLDER);
}

/**
 * Redact env/secret-shaped tokens for the context payload: the deterministic shapes above run
 * first ({@link stripKnownSecretShapes}, so a below-floor prefixed key is caught by its shape,
 * not missed by the heuristic), then the generic {@link HIGH_ENTROPY} sweep catches any long
 * opaque tail left over. The context redactor runs this AFTER {@link stripAbsolutePaths}, so the
 * entropy sweep never sees a filesystem path — that matters because its class spans `/`.
 */
export function stripSecretTokens(input: string): string {
  return stripKnownSecretShapes(input).replace(HIGH_ENTROPY, SECRET_PLACEHOLDER);
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
  //
  // The ONE sanctioned cast to the branded `RedactedContext`: this function IS the redaction
  // boundary, so it is the only place allowed to mint the type. The brand is phantom (type-only),
  // so the runtime object is exactly `redacted` — no symbol key is ever added.
  return redacted as RedactedContext;
}

/**
 * Redact one string leaf of a dev-tool RESULT. Unlike {@link redactString}, it strips only the
 * SQL binds and the DETERMINISTIC secret shapes ({@link stripKnownSecretShapes}) — deliberately
 * NOT {@link stripAbsolutePaths} and NOT the generic {@link HIGH_ENTROPY} sweep. Both of those
 * would destroy the signal a tool result exists to surface: a result's multi-segment paths are
 * app ROUTES (`/blog/:slug`, `/api/v2/users/:id`) — legitimate structure, not a filesystem leak
 * — and a long route (`/api/v2/organizations/settings`) is itself a 24+ char run in the entropy
 * sweep's `/`-spanning class, so it too would collapse to `<redacted>`. The named/structured
 * shapes catch the real output risk (a secret-shaped token or SQL bind a future data-bearing
 * read tool could echo) without touching routes; the untamed high-entropy tail is out of scope
 * here — over-redacting routes is worse, and the reply is same-origin, token-gated, and never
 * reaches an LLM in Phase 1.
 */
function redactOutputString(input: string): string {
  return stripKnownSecretShapes(stripSqlBindValues(input));
}

/** A value is a plain JSON object iff its prototype is `Object.prototype` or null. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;

  return proto === Object.prototype || proto === null;
}

/** Walk one node of a tool result, redacting string leaves; `seen` breaks reference cycles. */
function redactOutputValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactOutputString(value);

  // Non-object leaves (number/boolean/undefined/bigint/symbol) carry no secret text — pass through.
  if (value === null || typeof value !== "object") return value;

  // A cycle: stop recursing and hand back the node as-is. The reply path's `safeStringify`
  // still reports the (unchanged) cycle as unserializable — this guard only prevents a stack blow.
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactOutputValue(item, seen));

  // A non-plain object (Date, Map, class instance) is left intact for `safeStringify` to render —
  // walking its own-keys would silently drop its data (e.g. a Date's entries are empty).
  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = redactOutputValue(entry, seen);

  return out;
}

/**
 * Redact a dev-tool RESULT before it is reflected into the overlay reply (ADR 0033,
 * L-01d526da). Phase 1's one inspect tool (`describe_app`) returns app STRUCTURE only, so
 * nothing leaks today — but this is the guard that must exist BEFORE a data-bearing read tool
 * (recent-requests, tail-logs, content reads) is added to the bridge's `READ_TOOL_ALLOWLIST`,
 * so growing that allowlist is a one-line change, not a security review.
 *
 * Structure-aware and structure-preserving: it walks arbitrary JSON, scrubs every STRING leaf
 * through {@link redactOutputString} (secret + SQL-bind sweeps, but not path-collapse — routes
 * survive), and leaves object keys, array shapes, and non-string leaves untouched. Pure and
 * total like the rest of this module: it neither reads the world nor throws (reference cycles
 * are broken, so a pathological result cannot blow the stack — the reply's `safeStringify`
 * still renders a cyclic result as unserializable).
 */
export function redactToolOutput(value: unknown): unknown {
  return redactOutputValue(value, new WeakSet());
}
