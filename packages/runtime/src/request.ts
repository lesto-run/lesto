import type { LestoRequest } from "@lesto/web";

import { RuntimeError } from "./errors";

/** The raw transport-level input the http server hands us, before normalization. */
export interface RawRequest {
  method: string;

  url: string;

  headers: Record<string, string | string[] | undefined>;

  /** The full request body, already read off the socket as a string. */
  body: string;
}

/** Read a header case-insensitively; the first value wins when it arrived as a list. */
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== target) {
      continue;
    }

    const value = headers[key];

    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }

  return undefined;
}

/**
 * Flatten raw socket headers into a plain record the dispatch core can read.
 *
 * Keys are lowercased (HTTP headers are case-insensitive); a header that arrived
 * as a list keeps its first value; an absent value is dropped. This is the form
 * a controller reads — `request.headers["cookie"]`.
 */
function parseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const flat: Record<string, string> = {};

  for (const key of Object.keys(headers)) {
    const value = headers[key];

    if (value === undefined) continue;

    flat[key.toLowerCase()] = Array.isArray(value) ? (value[0] ?? "") : value;
  }

  return flat;
}

/**
 * Parse URLSearchParams into BOTH projections in one pass.
 *
 *   - `query` — the last-value record: a repeated key keeps its final value
 *     (`?tag=a&tag=b` → `{ tag: "b" }`), the back-compatible shape.
 *   - `queryAll` — the full multimap: every value a repeated key carried, in
 *     arrival order (`?tag=a&tag=b` → `{ tag: ["a", "b"] }`), the escape hatch
 *     `c.queries(name)` reads.
 *
 * `queryAll` is a NULL-PROTOTYPE object (mirroring `params` in
 * {@link toLestoRequest}): on a plain `{}`, `?constructor=x` would make
 * `(queryAll[key] ??= [])` read the inherited `Function` and the subsequent
 * `.push` throw — a prototype-pollution DoS. `Object.create(null)` has no such
 * inherited keys, so any attacker-chosen key is an own data property.
 */
function parseQuery(search: string): {
  query: Record<string, string>;
  queryAll: Record<string, string[]>;
} {
  const query: Record<string, string> = {};
  const queryAll: Record<string, string[]> = Object.create(null) as Record<string, string[]>;

  for (const [key, value] of new URLSearchParams(search)) {
    query[key] = value;
    (queryAll[key] ??= []).push(value);
  }

  return { query, queryAll };
}

/**
 * Decode the body by its declared content-type.
 *
 * JSON content-types are parsed into a value; everything else stays the raw
 * string. An empty body is `undefined` regardless of type — there is nothing to
 * decode, and a controller should see "no body", not an empty string.
 *
 * Malformed JSON is a *client* error, not ours: an unhandled `SyntaxError` from
 * `JSON.parse` would otherwise reject the request promise and crash the process
 * (Node >=22 exits on an unhandled rejection). We catch it and raise a typed
 * `RuntimeError` the server maps to a 400 — the invariant being that no
 * attacker-supplied bytes can ever escape as an uncaught throw.
 */
function parseBody(contentType: string | undefined, body: string): unknown {
  if (body.length === 0) {
    return undefined;
  }

  if (contentType !== undefined && contentType.startsWith("application/json")) {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new RuntimeError("RUNTIME_INVALID_JSON", "Request body is not valid JSON.");
    }
  }

  return body;
}

/**
 * The throwaway base a relative (origin-form) request target is resolved against —
 * only its path and query matter, but its authority is the yardstick
 * {@link parseRequestTarget} checks a smuggled authority against.
 */
const THROWAWAY_BASE = "http://localhost";

/**
 * Parse a raw request target into a URL, refusing anything but an origin-form path.
 *
 * A well-formed HTTP request to an APP server carries an origin-form target — an
 * absolute path beginning with a single `/` (RFC 9112 §3.2.1). Two other shapes
 * are an authority-confusion / proxy-ACL-bypass hazard here and are refused with a
 * coded {@link RuntimeError} (`RUNTIME_INVALID_REQUEST_TARGET`), before the target
 * can route:
 *
 *   - **Authority-form confusion** — a target beginning `//` (or the `/\`
 *     backslash variant WHATWG treats the same) is parsed as `//authority/path`,
 *     so `//evil/admin` silently becomes host `evil` + path `/admin`. A front
 *     proxy that ACL-matches the RAW target (which does not begin `/admin`) would
 *     forward it, and the app would then route `/admin` — the authority discarded,
 *     the ACL bypassed.
 *   - **Absolute-form** (`http://host/…`) — only a forward proxy legitimately
 *     receives it; honoring it on an app server likewise lets a target's authority
 *     diverge from its routed path.
 *
 * The gate is belt-and-braces: the raw target must start with a single `/` (which
 * rejects absolute-form and the `//`/`/\` authority shapes syntactically), AND the
 * parsed authority must still be the throwaway base's — so any parser trick that
 * smuggled a different host through is caught semantically too. Callers that need
 * only the pathname (`pathOf`) share this so the reject is identical on every path.
 */
export function parseRequestTarget(target: string): URL {
  const url = new URL(target, THROWAWAY_BASE);

  const originForm =
    target.startsWith("/") &&
    !target.startsWith("//") &&
    !target.startsWith("/\\") &&
    url.host === "localhost";

  if (!originForm) {
    throw new RuntimeError(
      "RUNTIME_INVALID_REQUEST_TARGET",
      `Request target is not an origin-form path: "${target}".`,
      { target },
    );
  }

  return url;
}

/**
 * Normalize a raw socket request into the transport-free {@link LestoRequest}
 * the dispatch core operates over.
 *
 * Pure: no I/O, no clock, no router. `params` is left empty — the router fills
 * it during dispatch when it matches the path against a route pattern. An
 * authority-form/absolute request target is refused here (see
 * {@link parseRequestTarget}) rather than allowed to smuggle a path past a proxy.
 */
export function toLestoRequest(input: RawRequest): LestoRequest {
  // The base is a throwaway: only the path and query of an origin-form target
  // matter — and a smuggled authority is refused, not silently discarded.
  const url = parseRequestTarget(input.url);

  const body = parseBody(headerValue(input.headers, "content-type"), input.body);

  const { query, queryAll } = parseQuery(url.search);

  return {
    method: input.method,
    path: url.pathname,
    params: {},
    query,
    queryAll,
    headers: parseHeaders(input.headers),
    body,
    ...(input.body.length === 0 ? {} : { rawBody: input.body }),
  };
}
