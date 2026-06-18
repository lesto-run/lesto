/**
 * The handler context — the single `c` a route handler receives.
 *
 * Where the old `Controller` was a class you subclassed, `Context` is a value
 * passed in: it wraps the immutable {@link VoloRequest}, exposes typed readers
 * for params / query / headers, and builds a {@link VoloResponse} through small
 * helpers that each name a content type so a response is correct by construction.
 * A handler returns the response it builds — there is no mutable `res` to forget
 * to send — which keeps the dispatch core pure and the streaming/edge paths clean.
 *
 * Generic in the route's path so `c.param(name)` only accepts the `:param` names
 * the pattern actually declares (see `@volo/router`'s `PathParams`). That is the
 * front of Volo's end-to-end typing: the compiler knows the keys, with no codegen.
 */

import type { ParamKeys } from "@volo/router";
import type { ZodType } from "zod";

import { currentContext } from "./context";
import type { AnyVoloResponse, VoloBody, VoloRequest, VoloResponse } from "./types";
import { validateBody } from "./validate";

export class Context<Path extends string = string> {
  // The request is immutable for the lifetime of the context; a handler reads it
  // but never reassigns it, so it stays private behind a getter.
  private readonly currentRequest: VoloRequest;

  // The request-scoped variable bag — what `c.set`/`c.get` read and write. A
  // plain Map, distinct from the ambient `RequestContext` (which carries the
  // transport's requestId/ip/signal): this is the handler's own scratch space,
  // for a middleware to hand a value (the resolved user, a parsed token) to the
  // handler downstream of it.
  private readonly vars = new Map<string, unknown>();

  constructor(request: VoloRequest) {
    this.currentRequest = request;
  }

  /** The request this context is handling. */
  get req(): VoloRequest {
    return this.currentRequest;
  }

  /** The request method (`"GET"`, `"POST"`, …). */
  get method(): string {
    return this.currentRequest.method;
  }

  /** The matched request path. */
  get path(): string {
    return this.currentRequest.path;
  }

  /**
   * Fires when the request is abandoned (client disconnect, socket torn down).
   * Read from the ambient {@link RequestContext} the transport established;
   * `undefined` outside a transport-opened request (a test, a background task).
   */
  get signal(): AbortSignal | undefined {
    return currentContext()?.signal;
  }

  /**
   * A path param the router captured.
   *
   * Typed to the pattern's `:param` names — `c.param("id")` compiles for
   * `"/listings/:id"` and a typo'd key does not. The string overload is the
   * escape hatch for a dynamically-built name; for a matched route the value is
   * always present, but the wide overload is honestly `string | undefined`.
   */
  param(name: ParamKeys<Path>): string;
  param(name: string): string | undefined;
  param(name: string): string | undefined {
    return this.currentRequest.params[name];
  }

  /** A query-string value by key, or `undefined` when absent. */
  query(name: string): string | undefined {
    return this.currentRequest.query[name];
  }

  /** A request header by name (case-insensitive), or `undefined` when absent. */
  header(name: string): string | undefined {
    return this.currentRequest.headers[name.toLowerCase()];
  }

  /**
   * Validate the request body against a Zod schema, returning the parsed value.
   *
   * Boundary validation per ADR 0005: a failure throws the coded `WebError` the
   * shared error boundary maps to 422, so everything past this call is trusted.
   */
  valid<T>(schema: ZodType<T>): T {
    return validateBody(schema, this.currentRequest);
  }

  /** Stash a request-scoped value for a handler downstream to read with {@link get}. */
  set(key: string, value: unknown): void {
    this.vars.set(key, value);
  }

  /** Read a value a middleware stashed with {@link set}, or `undefined` if unset. */
  get<T = unknown>(key: string): T | undefined {
    return this.vars.get(key) as T | undefined;
  }

  /** A JSON response — `data` is serialized and tagged `application/json`. */
  json(data: unknown, status = 200): VoloResponse {
    return {
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    };
  }

  /** A plain-text response. */
  text(body: string, status = 200): VoloResponse {
    return {
      status,
      headers: { "content-type": "text/plain" },
      body,
    };
  }

  /** An HTML response from a pre-rendered markup string. */
  html(body: string, status = 200): VoloResponse {
    return {
      status,
      headers: { "content-type": "text/html" },
      body,
    };
  }

  /** A redirect — defaults to 302, carrying the target in `Location`. */
  redirect(location: string, status = 302): VoloResponse {
    return {
      status,
      headers: { Location: location },
      body: "",
    };
  }

  /**
   * A raw-bytes response — for content a string would corrupt (an image, a font,
   * a PDF). The runtime writes the `Uint8Array` to the socket verbatim, tagged
   * with the caller's `contentType`.
   */
  bytes(data: Uint8Array, contentType: string, status = 200): AnyVoloResponse {
    return {
      status,
      headers: { "content-type": contentType },
      body: data,
    };
  }

  /**
   * A streamed response — the runtime pipes the {@link ReadableStream} to the
   * socket as it produces bytes. The foundation the `.page` renderer flushes a
   * shell through; `contentType` defaults to HTML, the dominant streamed case.
   */
  stream(body: ReadableStream, contentType = "text/html", status = 200): AnyVoloResponse {
    return {
      status,
      headers: { "content-type": contentType },
      body: body as VoloBody,
    };
  }
}
