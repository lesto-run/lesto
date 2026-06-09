import type { KeelRequest } from "@keel/web";

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

/** Flatten URLSearchParams into a plain record; the last value wins on repeats. */
function parseQuery(search: string): Record<string, string> {
  const query: Record<string, string> = {};

  for (const [key, value] of new URLSearchParams(search)) {
    query[key] = value;
  }

  return query;
}

/**
 * Decode the body by its declared content-type.
 *
 * JSON content-types are parsed into a value; everything else stays the raw
 * string. An empty body is `undefined` regardless of type — there is nothing to
 * decode, and a controller should see "no body", not an empty string.
 */
function parseBody(contentType: string | undefined, body: string): unknown {
  if (body.length === 0) {
    return undefined;
  }

  if (contentType !== undefined && contentType.startsWith("application/json")) {
    return JSON.parse(body) as unknown;
  }

  return body;
}

/**
 * Normalize a raw socket request into the transport-free {@link KeelRequest}
 * the dispatch core operates over.
 *
 * Pure: no I/O, no clock, no router. `params` is left empty — the router fills
 * it during dispatch when it matches the path against a route pattern.
 */
export function toKeelRequest(input: RawRequest): KeelRequest {
  // The base is a throwaway: only the path and query of a relative URL matter.
  const url = new URL(input.url, "http://localhost");

  const body = parseBody(headerValue(input.headers, "content-type"), input.body);

  return {
    method: input.method,
    path: url.pathname,
    params: {},
    query: parseQuery(url.search),
    body,
  };
}
