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
export interface KeelRequest {
  method: string;

  path: string;

  /** Path params extracted by the router (e.g. `:id` -> `{ id: "3" }`). */
  params: Record<string, string>;

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
 * Widening, never narrowing: a `string` is still a valid `KeelBody`, so every
 * existing response and consumer keeps working unchanged.
 */
export type KeelBody = string | Uint8Array | ReadableStream;

/**
 * A response the runtime can write back verbatim.
 *
 * Generic in its body kind, defaulting to `string` — so the bare `KeelResponse`
 * is exactly the string-bodied shape it has always been. That default is the
 * load-bearing backward-compatibility move: every existing reference
 * (`Promise<KeelResponse>` on the kernel's `App.handle`, the prerenderer's
 * structural `RenderResponse`, a test that does `JSON.parse(response.body)`)
 * keeps seeing `body: string` and compiles unchanged.
 *
 * The transport tier widens it where it must accept any arm: `applyResponse`,
 * the site dispatcher, and the edge adapter take a `KeelResponse<KeelBody>`, and
 * a string-bodied `KeelResponse` is assignable to that (a property's type is
 * checked covariantly, and `string` ⊆ `KeelBody`). So binary and streamed
 * responses flow through the transport without forcing every dispatch-core
 * consumer to widen with them.
 */
export interface KeelResponse<B extends KeelBody = string> {
  status: number;

  headers: Record<string, string>;

  /** The response body. Defaults to a `string`; a transport may carry any {@link KeelBody}. */
  body: B;
}

/**
 * A {@link KeelResponse} that may carry any body arm — string, bytes, or stream.
 *
 * The explicit name for `KeelResponse<KeelBody>`, used by the transport seams
 * (`applyResponse`, the dispatcher, the edge adapter) and by the bytes helper,
 * so a reader sees "this accepts any body" without decoding the generic.
 */
export type AnyKeelResponse = KeelResponse<KeelBody>;
