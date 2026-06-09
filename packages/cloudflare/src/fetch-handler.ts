/**
 * Run a Keel app inside a Cloudflare Worker.
 *
 * A Worker is a single function: `fetch(Request) => Response`. Keel's dispatcher
 * is already a pure `(method, path, options) => KeelResponse` — no node:http, no
 * sockets — so putting Keel on the edge is just *adapting the shapes*: a Web
 * `Request` in, a Web `Response` out, the same dispatch in between. No second
 * server, no divergent code path; the edge runs the very function the node
 * server runs.
 *
 * The one piece of logic that lives here (and mirrors the node server) is body
 * decoding: text by default, parsed when the content-type says JSON, with a
 * malformed JSON body answered as a 400 rather than thrown.
 */

import type { KeelResponse } from "@keel/web";

/** The per-request inputs the dispatcher reads, the same shape the node server passes. */
export interface EdgeRequestOptions {
  readonly query: Record<string, string>;

  readonly headers: Record<string, string>;

  readonly body: unknown;
}

/** The pure dispatcher a Worker fronts — `dispatchSites` / `app.handle` satisfy it. */
export type EdgeDispatch = (
  method: string,
  path: string,
  options: EdgeRequestOptions,
) => Promise<KeelResponse>;

/** Flatten a URL's search params to a record; the last value wins on repeats. */
function queryFrom(params: URLSearchParams): Record<string, string> {
  const query: Record<string, string> = {};

  for (const [key, value] of params) {
    query[key] = value;
  }

  return query;
}

/** Flatten Web `Headers` to a record. Keys arrive already lowercased. */
function headersFrom(headers: Headers): Record<string, string> {
  const flat: Record<string, string> = {};

  headers.forEach((value, key) => {
    flat[key] = value;
  });

  return flat;
}

/** A decoded body, or the signal that a declared-JSON body did not parse. */
type Decoded = { readonly ok: true; readonly body: unknown } | { readonly ok: false };

/**
 * Decode the request body the way a controller expects it.
 *
 * Empty is `undefined` (no body, not an empty string); a JSON content-type is
 * parsed, and a parse failure is a *client* error the caller turns into a 400 —
 * never an exception. Anything else stays the raw text.
 */
async function decodeBody(request: Request, contentType: string | undefined): Promise<Decoded> {
  const text = await request.text();

  if (text.length === 0) {
    return { ok: true, body: undefined };
  }

  if (contentType !== undefined && contentType.startsWith("application/json")) {
    try {
      return { ok: true, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: false };
    }
  }

  return { ok: true, body: text };
}

/**
 * Adapt a Keel dispatcher into a Worker `fetch` handler.
 *
 * Parses the `Request` into the dispatcher's `(method, path, options)`, calls
 * it, and writes the `KeelResponse` back as a Web `Response` — headers and all,
 * so a `Set-Cookie` set by the app survives to the browser. A malformed JSON
 * body short-circuits to 400 before dispatch.
 */
export function toFetchHandler(dispatch: EdgeDispatch): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);

    const headers = headersFrom(request.headers);

    const decoded = await decodeBody(request, headers["content-type"]);

    if (!decoded.ok) {
      return new Response("Bad Request", { status: 400 });
    }

    const response = await dispatch(request.method, url.pathname, {
      query: queryFrom(url.searchParams),
      headers,
      body: decoded.body,
    });

    return new Response(response.body, { status: response.status, headers: response.headers });
  };
}
