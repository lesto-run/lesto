/**
 * HTTP caching primitives — `Cache-Control`, `ETag`, `Vary`, and the bodiless
 * 304 — built on node-native crypto and plain header strings.
 *
 * These are the browser-cache half of the Tier-0 perf work (see
 * `docs/PERF-SECURITY-2026.md`): immutable caching for content-hashed assets,
 * `no-cache` + conditional-GET 304 for HTML, and stale-while-revalidate /
 * stale-if-error for resilient revalidation. Everything here is a pure function
 * or a thin writer over a narrow seam, so each branch is unit-testable with no
 * socket and no disk.
 *
 * Why a separate module: caching is its own concern with its own vocabulary;
 * keeping it out of `server.ts` lets the transport tier *use* these helpers
 * without owning their policy, and lets `sites.ts` share the exact same
 * `Cache-Control` strings the dynamic path emits — one source, never two that
 * drift.
 */

import { createHash } from "node:crypto";

/**
 * The directives a {@link cacheControl} string is built from.
 *
 * A deliberately small, opinionated surface — not every RFC 7234 knob, only the
 * ones a framework actually reaches for. The two cornerstones:
 *
 *   - `immutable`: the asset's URL is content-addressed (a hash in the
 *     filename), so its bytes can never change under that URL. The browser may
 *     cache it for a year and never revalidate.
 *   - `noCache`: the resource may change at the same URL (an HTML page), so the
 *     browser must revalidate every time — but a matching ETag still yields a
 *     cheap 304 rather than a full re-download.
 *
 * `staleWhileRevalidate` / `staleIfError` let a cache serve a stale copy while
 * it refreshes in the background, or when the origin is down — the resilient
 * revalidation pattern the whole caching landscape converged on.
 */
export interface CacheControlOptions {
  /**
   * Content-addressed and frozen: `public, max-age=31536000, immutable`. When
   * set, it is the whole story and the other directives are ignored — an
   * immutable asset has no use for revalidation windows.
   */
  readonly immutable?: boolean;

  /**
   * Revalidate every time: emits `no-cache`. Pair with an ETag so a revalidation
   * that finds no change costs a 304, not a re-download. Mutually exclusive with
   * {@link maxAge} — `no-cache` already means "always check", so a freshness
   * window would be contradictory.
   */
  readonly noCache?: boolean;

  /** Whether the response may be stored by shared caches (`public`) or only the browser (`private`). */
  readonly visibility?: "public" | "private";

  /** Freshness lifetime in seconds (`max-age=…`). Ignored when {@link noCache} is set. */
  readonly maxAge?: number;

  /** Serve stale for this many seconds while revalidating in the background. */
  readonly staleWhileRevalidate?: number;

  /** Serve stale for this many seconds when the origin errors. */
  readonly staleIfError?: number;
}

/** The frozen directive every content-hashed asset gets — a year, never revalidated. */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Build a `Cache-Control` header value from a small set of directives.
 *
 * Two shapes dominate and are spelled out first as fast paths: a content-hashed
 * asset (`immutable`) and a page that must revalidate (`noCache`). Otherwise the
 * directives are assembled in canonical order — visibility, freshness, then the
 * stale-* resilience windows — so the output reads the same way every time and
 * tests can assert it verbatim.
 */
export function cacheControl(options: CacheControlOptions): string {
  // Immutable is absolute: a content-addressed URL can never change, so its
  // bytes are cacheable for a year with no revalidation. Nothing else applies.
  if (options.immutable === true) {
    return IMMUTABLE_CACHE_CONTROL;
  }

  const directives: string[] = [];

  if (options.visibility !== undefined) {
    directives.push(options.visibility);
  }

  // `no-cache` means "store it, but revalidate before every reuse" — the right
  // default for HTML, which can change at the same URL but pairs with an ETag
  // for a cheap 304. A max-age alongside it would be self-contradictory, so the
  // type makes them mutually exclusive and we honor `no-cache` here.
  if (options.noCache === true) {
    directives.push("no-cache");
  } else if (options.maxAge !== undefined) {
    directives.push(`max-age=${options.maxAge}`);
  }

  if (options.staleWhileRevalidate !== undefined) {
    directives.push(`stale-while-revalidate=${options.staleWhileRevalidate}`);
  }

  if (options.staleIfError !== undefined) {
    directives.push(`stale-if-error=${options.staleIfError}`);
  }

  return directives.join(", ");
}

/**
 * Detect a content hash (fingerprint) in a built asset's filename.
 *
 * The build writes content-addressed assets as `name.<hash>.ext` — the hash is
 * a run of lowercase hex/base-ish characters between dots, long enough to be a
 * digest and not a version like `app.v2.js`. When a filename carries one, the
 * URL is frozen and the asset is safe to cache `immutable`; when it does not (a
 * plain `index.html`, a hand-named `app.js`), it must revalidate.
 *
 * Conservative on purpose: a false negative just means an asset revalidates
 * when it could have been frozen (correct, only slower); a false positive would
 * freeze a mutable URL for a year (a correctness bug), so we require a hash
 * segment of at least eight characters to claim a fingerprint.
 */
export function hasContentHash(filePath: string): boolean {
  // The last path segment is the filename; directories never carry the hash.
  const fileName = filePath.slice(filePath.lastIndexOf("/") + 1);

  // `name.<hash>.ext`: a dotted segment of >= 8 hex chars sitting before the
  // final extension. Anchored between dots so a long word in the name can't pose
  // as a digest, and the trailing `.ext` is required so a bare hash isn't matched.
  return /\.[a-f0-9]{8,}\.[a-z0-9]+$/i.test(fileName);
}

/**
 * Compute an ETag for a response body via SHA-1.
 *
 * SHA-1 is the conventional, fast choice for ETags — this is a cache key for
 * change detection, never a security boundary, so collision-resistance against
 * an adversary is not the bar; speed and stability are. The digest is truncated
 * to 27 base64url characters (160 bits of input, ample for distinguishing
 * bodies) and wrapped in quotes per the HTTP grammar.
 *
 * A `weak` tag is prefixed with `W/` — declaring the entity *semantically*
 * equivalent rather than byte-identical, which is the honest claim when a
 * response is, say, compressed differently on the wire than when hashed.
 */
export function etagFor(body: string, options: { weak?: boolean | undefined } = {}): string {
  const digest = createHash("sha1").update(body).digest("base64url").slice(0, 27);

  const tag = `"${digest}"`;

  return options.weak === true ? `W/${tag}` : tag;
}

/**
 * Whether a request's `If-None-Match` matches the response's ETag.
 *
 * A conditional GET sends the ETag it already holds; if it still matches, the
 * body is unchanged and we answer a bodiless 304 instead of resending it. We
 * compare per RFC 7232's *weak* rule — `W/"x"` and `"x"` match — because a 304
 * only promises semantic equivalence, not byte-identity, and we split a
 * comma-separated list so a client offering several cached tags still matches.
 * A literal `*` matches any current representation.
 */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;

  const wanted = stripWeak(etag);

  return ifNoneMatch
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || stripWeak(candidate) === wanted);
}

/** Drop a leading `W/` so weak and strong forms of the same tag compare equal. */
function stripWeak(etag: string): string {
  return etag.startsWith("W/") ? etag.slice(2) : etag;
}

/**
 * The slice of a node:http `ServerResponse` {@link respondNotModified} writes
 * through — narrow on purpose, so a fake satisfies it in a unit test.
 *
 * A 304 is the one response that must carry headers but *no* body, which is why
 * it cannot go through {@link applyResponse} (whose `end` takes a string body).
 * It writes the validators (ETag, Cache-Control, Vary) and ends the socket with
 * nothing on the wire — the client reuses what it already cached.
 */
export interface NotModifiedResponse {
  writeHead(status: number, headers: Record<string, string>): void;

  end(): void;
}

/**
 * Answer a conditional GET with `304 Not Modified` and an empty body.
 *
 * Per RFC 7232 a 304 echoes the headers that would govern caching — the ETag
 * the client matched on, plus any `Cache-Control`/`Vary` — but sends no body,
 * which is the whole point: the bytes are already in the client's cache. We do
 * NOT route this through `applyResponse`, because that always writes a string
 * body; a 304 must `end()` with nothing.
 *
 * The headers we echo are the ones hardened for the *200* this 304 stands in
 * for, so we strip `Content-Length` before writing them: a positive declared
 * length on a bodiless response is a framing inconsistency a client may read as
 * a truncated body. No code in the stack sets `Content-Length` today, so this is
 * cheap insurance against a future caller — the invariant ("a 304 never declares
 * a body length") now lives here rather than resting on nobody upstream ever
 * setting it.
 */
export function respondNotModified(
  res: NotModifiedResponse,
  headers: Record<string, string>,
): void {
  res.writeHead(304, withoutContentLength(headers));

  res.end();
}

/**
 * Drop any `Content-Length` entry, regardless of header casing.
 *
 * Headers arrive lowercased through our own stack, but an app may set any
 * casing on a response it owns, so we match case-insensitively and rebuild the
 * map rather than deleting a single known key.
 */
function withoutContentLength(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-length"),
  );
}
