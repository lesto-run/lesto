/**
 * The plain request/response shapes the dispatch core operates over.
 *
 * Deliberately transport-free: no node:http here. The unified runtime adapts a
 * real socket into these objects later; everything in this package is a pure
 * function or class over them, so the whole MVC core is testable without a server.
 */

/**
 * Per-request inputs the router cannot supply on its own: the query string,
 * headers, and decoded body. The transport (or a test) hands these to
 * `handle(method, path, options)`; the router contributes the matched params.
 */
export interface HandleOptions {
  query?: Record<string, string>;

  headers?: Record<string, string>;

  body?: unknown;
}

/** A normalized inbound request: what the router matched, plus query and body. */
export interface LestoRequest {
  method: string;

  path: string;

  /**
   * Path params extracted by the router: a single `:id` -> `{ id: "3" }`, a
   * catch-all `*rest` -> `{ rest: ["a", "b"] }` (the `string[]` run of segments).
   */
  params: Record<string, string | string[]>;

  /** Parsed query-string pairs. */
  query: Record<string, string>;

  /** Request headers, keyed by lowercased name — where a controller reads cookies. */
  headers: Record<string, string>;

  /** The decoded request body, shape unknown until a controller narrows it. */
  body: unknown;
}

/**
 * A response body the runtime can write back verbatim.
 *
 * Three arms, in order of how common they are:
 *
 *   - `string` — the original and still-dominant case: JSON pre-serialized, HTML
 *     pre-rendered, plain text. Every existing helper (`json`/`html`/`text`/…)
 *     returns this arm, and the runtime writes it as UTF-8 exactly as before.
 *   - `Uint8Array` — raw bytes, for binary payloads a string would corrupt: an
 *     image, a font, a PDF, a WASM module. The runtime writes the bytes verbatim
 *     (no UTF-8 re-encoding), so what the controller produced is what the client
 *     receives, byte for byte.
 *   - `ReadableStream` — the Web/global stream, for a body produced incrementally
 *     (the foundation for streaming SSR and compression, built in later tiers).
 *     The runtime pipes it to the socket; because a stream cannot be hashed
 *     without consuming it, the conditional-GET ETag path skips a stream body.
 *
 * Widening, never narrowing: a `string` is still a valid `LestoBody`, so every
 * existing response and consumer keeps working unchanged.
 */
export type LestoBody = string | Uint8Array | ReadableStream;

/**
 * A response header map: a name to a single value, OR to a *list* of values.
 *
 * One header name with several values is rare but real, and `Set-Cookie` is the
 * one where it MUST NOT be flattened: per RFC 6265 every cookie is its own
 * `Set-Cookie` line, and the values cannot be comma-joined the way an ordinary
 * multi-valued header (`Vary`, `Accept`) may be — a cookie value can itself
 * contain a comma (an `Expires` date), so a joined line is ambiguous and the
 * browser drops cookies. So a response that sets a session cookie AND a CSRF
 * cookie carries `{ "set-cookie": [sessionCookie, csrfCookie] }`, and each
 * transport emits one line per element (node `writeHead` takes a string array
 * natively; a Worker calls `Headers.append` per value).
 *
 * The single-string arm is the overwhelmingly common case and is unchanged: a
 * `Content-Type`, a `Location`, every default security header is one value. The
 * array arm is purely additive — `string` is assignable to `string | string[]`,
 * so every existing header map and every consumer that reads a single value (and
 * every map literal in the codebase) keeps compiling.
 */
export type HeaderMap = Record<string, string | string[]>;

/**
 * A response the runtime can write back verbatim.
 *
 * Generic in its body kind, defaulting to `string` — so the bare `LestoResponse`
 * is exactly the string-bodied shape it has always been. That default is the
 * load-bearing backward-compatibility move: every existing reference
 * (`Promise<LestoResponse>` on the kernel's `App.handle`, the prerenderer's
 * structural `RenderResponse`, a test that does `JSON.parse(response.body)`)
 * keeps seeing `body: string` and compiles unchanged.
 *
 * The transport tier widens it where it must accept any arm: `applyResponse`,
 * the site dispatcher, and the edge adapter take a `LestoResponse<LestoBody>`, and
 * a string-bodied `LestoResponse` is assignable to that (a property's type is
 * checked covariantly, and `string` ⊆ `LestoBody`). So binary and streamed
 * responses flow through the transport without forcing every dispatch-core
 * consumer to widen with them.
 *
 * `headers` is a {@link HeaderMap}: each name carries a single string or a list
 * of values. The list arm exists so `Set-Cookie` can be a *multimap* — two
 * cookies are two `Set-Cookie` lines, never one comma-joined line a browser
 * would mangle (see {@link HeaderMap}).
 */
export interface LestoResponse<B extends LestoBody = string> {
  status: number;

  headers: HeaderMap;

  /** The response body. Defaults to a `string`; a transport may carry any {@link LestoBody}. */
  body: B;
}

/**
 * A {@link LestoResponse} that may carry any body arm — string, bytes, or stream.
 *
 * The explicit name for `LestoResponse<LestoBody>`, used by the transport seams
 * (`applyResponse`, the dispatcher, the edge adapter) and by the bytes helper,
 * so a reader sees "this accepts any body" without decoding the generic.
 */
export type AnyLestoResponse = LestoResponse<LestoBody>;
