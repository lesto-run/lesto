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

  /**
   * The full multi-value fidelity of the query string: every value a repeated key
   * carried, in arrival order (`?tag=a&tag=b` → `{ tag: ["a", "b"] }`). Optional —
   * a transport that populates it lets {@link Context.queries} return all values;
   * a transport (or a hand-built test option) that omits it degrades to the boxed
   * single {@link query} value. See {@link LestoRequest.queryAll}.
   */
  queryAll?: Record<string, readonly string[]>;

  headers?: Record<string, string>;

  body?: unknown;

  /**
   * The exact undecoded request bytes, when the transport captured them.
   *
   * `body` may be JSON-decoded into an object; `rawBody` is always the raw
   * string alongside it — needed to verify a signature (e.g. an inbound
   * webhook's HMAC) over the bytes actually sent, not a re-serialization of
   * the parsed value. Absent when the transport carried no body (an empty
   * request) or never captured raw bytes (e.g. a hand-built `HandleOptions`
   * in a test).
   *
   * Cost: for a JSON body the raw string is retained ALONGSIDE the parsed
   * `body` for the request's lifetime (~2× that body's memory); it is bounded
   * by the transport's body-size cap, and for a non-JSON body `rawBody` and
   * `body` are the same string (no extra cost).
   *
   * NOTE: `rawBody` is a UTF-8 *string*, so it is LOSSY for a body that is not
   * valid UTF-8 (an image, a protobuf, a multipart upload). Verify a binary
   * webhook's HMAC over {@link rawBytes}, never this string — a re-encode of a
   * UTF-8-decoded string is not byte-exact.
   */
  rawBody?: string;

  /**
   * The exact undecoded request bytes, when the transport captured them.
   *
   * The byte-exact companion to {@link rawBody}: the raw octets of the body as
   * they arrived on the wire, with no UTF-8 decode. This is what a signature
   * check MUST hash — an inbound webhook's HMAC is computed over the exact bytes
   * sent, and any non-UTF-8 body (an image PUT, a protobuf, a multipart file)
   * cannot be reconstructed from the {@link rawBody} string. Absent when the
   * transport carried no body (an empty request) or never captured raw bytes
   * (e.g. a hand-built `HandleOptions` in a test).
   */
  rawBytes?: Uint8Array;
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

  /**
   * Parsed query-string pairs — the last-value projection: a repeated key keeps
   * only its final value (`?tag=a&tag=b` → `{ tag: "b" }`). This is unchanged and
   * back-compatible; reach for {@link queryAll} when a key can legitimately repeat.
   */
  query: Record<string, string>;

  /**
   * Full multi-value fidelity per query key, in arrival order: every value a
   * repeated key carried (`?tag=a&tag=b` → `{ tag: ["a", "b"] }`). Optional — the
   * {@link query} last-value projection above remains the back-compatible default,
   * and this is the escape hatch for reading ALL of a repeated key's values (via
   * {@link Context.queries}). A transport that has not populated it degrades to the
   * boxed single value, never breaks.
   */
  queryAll?: Record<string, readonly string[]>;

  /**
   * Request headers, keyed by lowercased name — where a controller reads cookies.
   *
   * A single value per name: a request header that arrives REPEATED is folded by
   * the platform before Lesto ever sees it (RFC 9110 §5.2 — the recipient MAY
   * combine a repeated field into one comma-joined value). Both transports fold it:
   * the Workers `Headers` object comma-joins repeats, and node's
   * `IncomingMessage.headers` discards all but one before dispatch. A faithful
   * "every value this header carried" accessor is therefore impossible on either
   * runtime, so there is deliberately NO `headerAll` — unlike {@link queryAll},
   * where the raw query string preserves every repeat and a multimap can be honest.
   */
  headers: Record<string, string>;

  /** The decoded request body, shape unknown until a controller narrows it. */
  body: unknown;

  /**
   * The exact undecoded request bytes, when the transport captured them. See
   * {@link HandleOptions.rawBody}.
   */
  rawBody?: string;

  /**
   * The exact undecoded request bytes — the byte-exact companion to
   * {@link rawBody}. Verify a binary webhook's HMAC over THIS, never the
   * lossy UTF-8 string. See {@link HandleOptions.rawBytes}.
   */
  rawBytes?: Uint8Array;
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
