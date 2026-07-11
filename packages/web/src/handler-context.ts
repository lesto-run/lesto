/**
 * The handler context — the single `c` a route handler receives.
 *
 * Where the old `Controller` was a class you subclassed, `Context` is a value
 * passed in: it wraps the immutable {@link LestoRequest}, exposes typed readers
 * for params / query / headers, and builds a {@link LestoResponse} through small
 * helpers that each name a content type so a response is correct by construction.
 * A handler returns the response it builds — there is no mutable `res` to forget
 * to send — which keeps the dispatch core pure and the streaming/edge paths clean.
 *
 * Generic in the route's path so `c.param(name)` only accepts the `:param` names
 * the pattern actually declares (see `@lesto/router`'s `PathParams`). That is the
 * front of Lesto's end-to-end typing: the compiler knows the keys, with no codegen.
 */

import type { CatchAllParamKeys, SingleParamKeys } from "@lesto/router";
import type { ZodType } from "zod";

import { currentContext } from "./context";
import type { AnyLestoResponse, LestoBody, LestoRequest, LestoResponse } from "./types";
import { validateBody } from "./validate";

/**
 * A {@link LestoResponse} that REMEMBERS, at the type level, the value its body was
 * serialized from — the read-path counterpart to `@lesto/runtime`'s `Mutation`
 * phantom carrier.
 *
 * At runtime it is exactly a string-bodied `LestoResponse` (`c.json` JSON-encodes
 * the value, as it always has). The extra `__json` carrier is a PHANTOM — optional,
 * never written, erased at emit — present only so a typed route builder can read
 * the handler's response shape off `typeof handler`'s return, exactly as
 * `MutationContractOf` reads a mutation's `__output`. Because the carrier is
 * optional, a `TypedResponse<T>` is still assignable everywhere a `LestoResponse`
 * is, so existing handlers and consumers compile unchanged.
 */
export interface TypedResponse<Json> extends LestoResponse {
  /** Phantom: the value `c.json` serialized, so a route builder can project the wire type. */
  readonly __json?: Json;
}

/** The value a {@link TypedResponse} carries, or `never` for a plain (untyped) response. */
export type JsonOf<R> = R extends TypedResponse<infer J> ? J : never;

export class Context<Path extends string = string> {
  // The request is immutable for the lifetime of the context; a handler reads it
  // but never reassigns it, so it stays private behind a getter.
  private readonly currentRequest: LestoRequest;

  // The request-scoped variable bag — what `c.set`/`c.get` read and write. A
  // plain Map, distinct from the ambient `RequestContext` (which carries the
  // transport's requestId/ip/signal): this is the handler's own scratch space,
  // for a middleware to hand a value (the resolved user, a parsed token) to the
  // handler downstream of it.
  private readonly vars = new Map<string, unknown>();

  // The status a PAGE render should answer with, when a loader/component overrode
  // the default 200 via {@link status}. Undefined = the render's own status stands
  // (200, or a 404 the renderer derives from a `notFound()` signal). Read by
  // `render-page.ts`; it has no effect on the `c.json`/`c.text`/… helpers, which
  // already carry their own status.
  private pageStatus: number | undefined;

  constructor(request: LestoRequest) {
    this.currentRequest = request;
  }

  /** The request this context is handling. */
  get req(): LestoRequest {
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
   * Typed to the pattern's param names — `c.param("id")` compiles for
   * `"/listings/:id"` and a typo'd key does not — and to each name's VALUE type: a
   * single `:param` is a `string`, a `*catchAll` the `string[]` run of segments it
   * spanned. Two narrow overloads keep that split without a Path-dependent RETURN
   * (which would break `Handler<P>` variance). The string overload is the escape
   * hatch for a dynamically-built name; its type is `string | undefined`, but BEWARE
   * a catch-all key reached this way is a `string[]` at RUNTIME — so a string guard
   * like `c.param(dynamicName) === x` reads false against a catch-all. Use the typed
   * key (the first two overloads) whenever the name is statically known.
   */
  param(name: CatchAllParamKeys<Path>): string[];
  param(name: SingleParamKeys<Path>): string;
  param(name: string): string | undefined;
  param(name: string): string | string[] | undefined {
    return this.currentRequest.params[name];
  }

  /** A query-string value by key, or `undefined` when absent. */
  query(name: string): string | undefined {
    return this.currentRequest.query[name];
  }

  /** Every value a repeated query key carried, in order; [] when absent. */
  queries(name: string): readonly string[] {
    const all = this.currentRequest.queryAll?.[name];
    if (all !== undefined) return all;
    const single = this.currentRequest.query[name];
    return single === undefined ? [] : [single];
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

  /**
   * Set the HTTP status a PAGE render answers with — the seam a `load` loader (or a
   * component, before it renders) uses to override the default 200 (e.g.
   * `c.status(404)` for a resource that resolved to nothing, `c.status(410)` for a
   * gone one). The renderer reads {@link statusOverride} after `load` runs.
   *
   * It governs the page-render path only; an API handler already sets its status on
   * the response it returns (`c.json(data, 201)`), so it has no need of this.
   */
  status(code: number): void {
    this.pageStatus = code;
  }

  /**
   * The status a loader/component set via {@link status}, or `undefined` when none
   * was set (the render's own status stands). Read by the page renderer.
   */
  get statusOverride(): number | undefined {
    return this.pageStatus;
  }

  /**
   * A JSON response — `data` is serialized and tagged `application/json`.
   *
   * The return is a {@link TypedResponse} that carries `data`'s type in a phantom
   * (runtime-identical to before: the body is `JSON.stringify(data)`). That carrier
   * is what lets `apiRoutes()` project a handler's response shape into a client
   * contract WITHOUT codegen — the read-path mirror of typed mutations. A handler
   * that returns `c.json(...)` therefore drift-proofs the client by construction.
   */
  json<Data>(data: Data, status = 200): TypedResponse<Data> {
    return {
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    };
  }

  /** A plain-text response. */
  text(body: string, status = 200): LestoResponse {
    return {
      status,
      headers: { "content-type": "text/plain" },
      body,
    };
  }

  /** An HTML response from a pre-rendered markup string. */
  html(body: string, status = 200): LestoResponse {
    return {
      status,
      headers: { "content-type": "text/html" },
      body,
    };
  }

  /** A redirect — defaults to 302, carrying the target in `Location`. */
  redirect(location: string, status = 302): LestoResponse {
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
  bytes(data: Uint8Array, contentType: string, status = 200): AnyLestoResponse {
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
  stream(body: ReadableStream, contentType = "text/html", status = 200): AnyLestoResponse {
    return {
      status,
      headers: { "content-type": contentType },
      body: body as LestoBody,
    };
  }
}
