/**
 * The plain request/response shapes the dispatch core operates over.
 *
 * Deliberately transport-free: no node:http here. The unified runtime adapts a
 * real socket into these objects later; everything in this package is a pure
 * function or class over them, so the whole MVC core is testable without a server.
 */

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

/** A response the runtime can write back verbatim. */
export interface KeelResponse {
  status: number;

  headers: Record<string, string>;

  /** Always a string — JSON is pre-serialized, HTML pre-rendered. */
  body: string;
}
