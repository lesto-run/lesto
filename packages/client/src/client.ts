/**
 * `createApi` — a typed, browser-safe fetch client for a Lesto app's data routes.
 *
 *   // The contract: the wire types, declared ONCE and shared by import (no
 *   // codegen, no GraphQL). In a real app these reference the same `@lesto/db`
 *   // row/insert types the server handlers use, so client and server can't drift.
 *   interface SavedResponse { user: { id: string; name: string }; saved: Listing[] }
 *
 *   interface EstateApi {
 *     "GET /mls/saved": { response: SavedResponse };
 *     "GET /mls/listings/:id": { response: Listing };
 *     "POST /mls/api/sign-out": { response: { ok: true } };
 *   }
 *
 *   const api = createApi<EstateApi>();
 *
 *   const saved = await api.get("/mls/saved");                 // SavedResponse
 *   const one = await api.get("/mls/listings/:id", { params: { id: "3" } });  // Listing
 *
 * The path is constrained to the routes the contract declares for that method,
 * the response type is inferred from the contract, and a path's `:params` are
 * required and typed via `@lesto/router`'s `PathParams` — all by inference over
 * `typeof contract`, the Hono `hc` model. Native `fetch`, no runtime dependency,
 * wires `AbortSignal`, and surfaces a non-2xx as a coded {@link ClientError}.
 */

import { wrapFetch } from "@lesto/observability";
import type { PathParams } from "@lesto/router";

import { ClientError } from "./errors";

/** The HTTP verbs the client speaks; the methods below mirror them. */
export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One route's wire types in a contract: its response, request body, and query shape. */
export interface RouteSpec {
  response?: unknown;

  body?: unknown;

  query?: Record<string, string | undefined>;
}

/**
 * An API contract: keys are `"METHOD /path"` (e.g. `"GET /mls/saved"`), values
 * are each route's {@link RouteSpec}. `createApi<Contract>()` infers everything
 * from it — no generated module, no spec file.
 */
export type ApiContract = Record<string, RouteSpec>;

/** The paths the contract declares for method `M` (the keys' path halves). */
type PathFor<C extends object, M extends ApiMethod> = {
  [K in keyof C]: K extends `${M} ${infer P}` ? P : never;
}[keyof C] &
  string;

/** The spec for method `M` + path `P`, or `never` if the contract has no such route. */
type Spec<C extends object, M extends ApiMethod, P extends string> = `${M} ${P}` extends keyof C
  ? C[`${M} ${P}`]
  : never;

type ResponseOf<S> = S extends { response: infer R } ? R : unknown;

type BodyOf<S> = S extends { body: infer B } ? B : undefined;

// Every query field is optional and may be passed `undefined` (the request layer
// skips undefined entries), so a dynamically-built query object type-checks.
type QueryOf<S> = S extends { query: infer Q }
  ? { [K in keyof Q]?: Q[K] | undefined }
  : Record<string, string | undefined> | undefined;

/** The `params` field — present and required ONLY when the path has `:segments`. */
type ParamsField<P extends string> = keyof PathParams<P> extends never
  ? { params?: undefined }
  : { params: PathParams<P> };

/** Options every request accepts. */
interface BaseOptions {
  /** Extra request headers, merged over the client's defaults. */
  headers?: Record<string, string>;

  /** An abort signal — cancels the in-flight fetch (e.g. on unmount). */
  signal?: AbortSignal;
}

type GetOptions<C extends object, P extends string> = BaseOptions &
  ParamsField<P> & { query?: QueryOf<Spec<C, "GET", P>> };

type SendOptions<C extends object, M extends ApiMethod, P extends string> = BaseOptions &
  ParamsField<P> & { query?: QueryOf<Spec<C, M, P>>; body?: BodyOf<Spec<C, M, P>> };

/**
 * The option argument is REQUIRED when the path has `:params` (so they can't be
 * forgotten) and OPTIONAL otherwise — expressed as a tuple so a param-less call
 * needs no second argument at all.
 */
type GetArgs<C extends object, P extends string> = keyof PathParams<P> extends never
  ? [options?: GetOptions<C, P>]
  : [options: GetOptions<C, P>];

type SendArgs<
  C extends object,
  M extends ApiMethod,
  P extends string,
> = keyof PathParams<P> extends never
  ? [options?: SendOptions<C, M, P>]
  : [options: SendOptions<C, M, P>];

/** The typed client surface `createApi` returns. */
export interface Api<C extends object> {
  get<P extends PathFor<C, "GET">>(
    path: P,
    ...args: GetArgs<C, P>
  ): Promise<ResponseOf<Spec<C, "GET", P>>>;

  post<P extends PathFor<C, "POST">>(
    path: P,
    ...args: SendArgs<C, "POST", P>
  ): Promise<ResponseOf<Spec<C, "POST", P>>>;

  put<P extends PathFor<C, "PUT">>(
    path: P,
    ...args: SendArgs<C, "PUT", P>
  ): Promise<ResponseOf<Spec<C, "PUT", P>>>;

  patch<P extends PathFor<C, "PATCH">>(
    path: P,
    ...args: SendArgs<C, "PATCH", P>
  ): Promise<ResponseOf<Spec<C, "PATCH", P>>>;

  delete<P extends PathFor<C, "DELETE">>(
    path: P,
    ...args: SendArgs<C, "DELETE", P>
  ): Promise<ResponseOf<Spec<C, "DELETE", P>>>;
}

/**
 * The browser trace context the client stamps onto SAME-ORIGIN requests, so a
 * data fetch joins the page's trace (ARCHITECTURE.md §7's UI→API→DB join).
 *
 * `traceId` is the trace the page adopted from the SSR-injected
 * `lesto-traceparent` meta (read via `@lesto/observability`'s `readTraceparentMeta`).
 * Given it, `createApi` wraps its `fetch` with `@lesto/observability`'s
 * {@link wrapFetch}, which adds an outbound W3C `traceparent` (a fresh child span
 * per request) on same-origin calls only — never cross-origin, so the trace id
 * cannot leak to a third party. `origin` and `randomSpanId` are injected for tests
 * and default to the live browser origin and a `crypto`-backed id.
 */
export interface TraceContext {
  /** The page's trace id — every request carries a `traceparent` continuing it. */
  traceId: string;

  /** The same-origin gate. Defaults to the live `location.origin`. */
  origin?: string;

  /** A fresh 16-hex span id per request. Defaults to a `crypto`-backed generator. */
  randomSpanId?: () => string;
}

/** What `createApi` accepts. */
export interface ApiOptions {
  /** Prepended to every path. Default `""` (same-origin). e.g. `"https://api.example.com"`. */
  baseUrl?: string;

  /** Headers sent on every request (e.g. an auth token), overridable per call. */
  headers?: Record<string, string>;

  /** The `fetch` implementation — defaults to the global. Injected for tests/edge. */
  fetch?: typeof fetch;

  /**
   * The browser trace context to propagate (ARCHITECTURE.md §7). When set, the
   * client wraps its `fetch` so a same-origin request carries an outbound
   * `traceparent` continuing the page's trace — so the server handler joins the
   * SAME trace the page's browser RUM spans belong to. Absent → no propagation
   * (the plain client, byte-for-byte as before).
   */
  trace?: TraceContext;
}

/** The internal, erased shape of a request's options (the public types are per-route). */
interface RequestOptions {
  params?: Record<string, string | number> | undefined;

  query?: Record<string, string | undefined> | undefined;

  body?: unknown;

  headers?: Record<string, string>;

  signal?: AbortSignal;
}

/** Substitute `:name` segments in `path` from `params`, throwing if one is missing. */
function applyParams(path: string, params: Record<string, string | number> | undefined): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params?.[name];

    if (value === undefined) {
      throw new ClientError("CLIENT_MISSING_PARAM", `path "${path}" needs a value for ":${name}"`, {
        path,
        param: name,
      });
    }

    return encodeURIComponent(String(value));
  });
}

/** Append a query string built from the defined entries of `query` (undefined skipped). */
function applyQuery(url: string, query: Record<string, string | undefined> | undefined): string {
  if (query === undefined) return url;

  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.append(key, value);
  }

  const qs = search.toString();

  return qs === "" ? url : `${url}?${qs}`;
}

/** The same-origin gate for trace propagation — the live browser origin, or a stub off-browser. */
function defaultOrigin(): string {
  return typeof location === "undefined" ? "http://localhost" : location.origin;
}

/**
 * A fresh 16-hex span id for an outbound `traceparent`, drawn from `crypto` when
 * present (the browser ships it), falling back to `Math.random` where it is not.
 *
 * A span id is a correlation key, not a security token, so the weaker fallback is
 * acceptable rather than failing propagation outright on an ancient runtime.
 */
function defaultSpanId(): string {
  const api = typeof crypto === "undefined" ? undefined : crypto;

  if (api?.getRandomValues !== undefined) {
    const bytes = new Uint8Array(8);

    api.getRandomValues(bytes);

    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  let out = "";

  for (let i = 0; i < 8; i++) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }

  return out;
}

/** Read a response body as JSON, or as text when it is not JSON (used on the error path). */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (text === "") return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Build a typed client over a contract `C`.
 *
 * Every method shares one request path: substitute params, build the query,
 * JSON-encode an object body, send through the configured `fetch`, and either
 * return the parsed JSON (typed to the route's `response`) or throw a coded
 * {@link ClientError} carrying the status and parsed body for a non-2xx answer.
 */
export function createApi<C extends object>(options: ApiOptions = {}): Api<C> {
  const baseUrl = options.baseUrl ?? "";

  // When a trace context is configured, wrap `fetch` so a same-origin request
  // carries an outbound `traceparent` continuing the page's trace (the UI→API
  // join). The wrapper is `@lesto/observability`'s `wrapFetch`, so client and the
  // browser RUM runtime propagate identically. Absent → the bare configured fetch.
  const fetchImpl =
    options.trace === undefined
      ? (options.fetch ?? fetch)
      : wrapFetch({
          traceId: options.trace.traceId,
          origin: options.trace.origin ?? defaultOrigin(),
          randomSpanId: options.trace.randomSpanId ?? defaultSpanId,
          fetchImpl: options.fetch ?? fetch,
        });

  const baseHeaders = options.headers ?? {};

  const request = async (
    method: ApiMethod,
    path: string,
    requestOptions: RequestOptions = {},
  ): Promise<unknown> => {
    const url =
      baseUrl + applyQuery(applyParams(path, requestOptions.params), requestOptions.query);

    const headers: Record<string, string> = { ...baseHeaders, ...requestOptions.headers };

    // Encode an object body as JSON; a string body is sent verbatim (the caller
    // owns its content-type). A content-type the caller set is never overwritten.
    let body: string | undefined;

    if (requestOptions.body !== undefined) {
      if (typeof requestOptions.body === "string") {
        body = requestOptions.body;
      } else {
        body = JSON.stringify(requestOptions.body);
        headers["content-type"] ??= "application/json";
      }
    }

    const response = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
    });

    if (!response.ok) {
      throw new ClientError("CLIENT_HTTP_ERROR", `${method} ${url} → ${response.status}`, {
        status: response.status,
        body: await readBody(response),
      });
    }

    // 204 No Content carries no body; everything else is parsed as JSON.
    return response.status === 204 ? undefined : ((await response.json()) as unknown);
  };

  return {
    get: (path, ...args) => request("GET", path, args[0] as RequestOptions),
    post: (path, ...args) => request("POST", path, args[0] as RequestOptions),
    put: (path, ...args) => request("PUT", path, args[0] as RequestOptions),
    patch: (path, ...args) => request("PATCH", path, args[0] as RequestOptions),
    delete: (path, ...args) => request("DELETE", path, args[0] as RequestOptions),
  } as Api<C>;
}
