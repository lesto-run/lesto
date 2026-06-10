/**
 * The Controller is the unit of request handling: a class whose action methods
 * receive a request and return a response. It carries no transport state — it
 * reads a `KeelRequest` and builds a `KeelResponse` through small helpers, each
 * of which names a content type so the response is correct by construction.
 */

import { renderToStaticMarkup } from "react-dom/server";

import { renderPage, renderPageStream, renderTree } from "@keel/ui";
import type { Registry, StreamOptions } from "@keel/ui";

import type { AnyKeelResponse, KeelRequest, KeelResponse } from "./types";

export class Controller {
  // The request is immutable for the lifetime of the controller; an action
  // reads it but never reassigns it, so it stays private behind a getter.
  private readonly currentRequest: KeelRequest;

  constructor(request: KeelRequest) {
    this.currentRequest = request;
  }

  /** The request this controller is handling. */
  get request(): KeelRequest {
    return this.currentRequest;
  }

  /** Shorthand for the path params the router extracted. */
  get params(): Record<string, string> {
    return this.currentRequest.params;
  }

  /** A JSON response — `data` is serialized and tagged `application/json`. */
  json(data: unknown, status = 200): KeelResponse {
    return {
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    };
  }

  /** A plain-text response. */
  text(body: string, status = 200): KeelResponse {
    return {
      status,
      headers: { "content-type": "text/plain" },
      body,
    };
  }

  /**
   * A raw-bytes response — for content a string would corrupt.
   *
   * An image, a font, a PDF: their bytes are not text, so re-encoding them
   * through a `string` mangles them. This hands the runtime a `Uint8Array` it
   * writes to the socket verbatim, tagged with the caller's `contentType`. The
   * caller names the type because only it knows what the bytes are — there is no
   * extension to infer from here, unlike the static-file path.
   */
  bytes(data: Uint8Array, contentType: string, status = 200): AnyKeelResponse {
    return {
      status,
      headers: { "content-type": contentType },
      body: data,
    };
  }

  /** An HTML response from a pre-rendered markup string. */
  html(body: string, status = 200): KeelResponse {
    return {
      status,
      headers: { "content-type": "text/html" },
      body,
    };
  }

  /** A redirect — defaults to 302, carrying the target in `Location`. */
  redirect(location: string, status = 302): KeelResponse {
    return {
      status,
      headers: { Location: location },
      body: "",
    };
  }

  /**
   * Render an AI-emitted UI tree to HTML against a vetted registry.
   *
   * `@keel/ui` turns the tree into a React element (degrading unknown nodes
   * safely), which we SSR with `renderToStaticMarkup`. A null element — a tree
   * that produced nothing — yields an empty body rather than a crash.
   */
  renderTree(registry: Registry, tree: unknown, status = 200): KeelResponse {
    const { element } = renderTree(registry, tree);

    const body = element === null ? "" : renderToStaticMarkup(element);

    return this.html(body, status);
  }

  /**
   * Stream a UI tree to HTML, flushing the shell before slow children resolve.
   *
   * The streaming twin of {@link renderTree}: instead of buffering the whole body
   * into a string, it builds the page (manifest and all) and hands back a response
   * whose `body` is the live `ReadableStream` from `@keel/ui`'s `renderPageStream`.
   * The transport pipes that stream straight to the socket, so the shell paints
   * immediately and each `<Suspense>` boundary reveals as its data settles.
   *
   * The choice is the CALLER's: `renderTree` for a buffered string (crawlers,
   * SSG, an error page that must branch on status), `streamTree` for progressive
   * delivery to a human. Both share the same registry/tree/island contract — a
   * streamed page carries the hydration markers an `ssr: true` island needs,
   * because React's stream renderer emits them.
   *
   * Returns the wider {@link AnyKeelResponse} because a `ReadableStream` body is
   * not the string-default `KeelResponse` — the transport's `applyResponse`
   * accepts every body arm, and ETag/304 already skips a stream (it cannot be
   * hashed without draining it). One structural constraint the caller owns: once
   * the shell flushes, status and headers are on the wire and cannot change, so a
   * post-shell error can only be logged/aborted via `options.onError` — never
   * turned into a different status.
   *
   * NOT FOR STATIC RENDERING. A `streamTree` body is a live stream for the
   * transport; it is never appropriate to PRERENDER. The SSG/crawler path consumes
   * a response's `body` as a finished string (e.g. `@keel/sites` `prerenderSite`
   * reads `response.body` and writes it to disk), and a `ReadableStream` there
   * stringifies to `"[object ReadableStream]"`. The dispatch core keeps the wide
   * body type precisely so this is not laundered into the string contract silently
   * — but the type alone cannot stop an un-annotated action from reaching the
   * prerenderer. A static page MUST use {@link renderTree} (or `@keel/ui`'s
   * `renderPageStreamToString`, which buffers to a complete string and now throws
   * `UI_STREAM_INCOMPLETE` rather than emit a degraded one); `streamTree` is for a
   * human reading a live response, full stop.
   */
  async streamTree(
    registry: Registry,
    tree: unknown,
    options: StreamOptions = {},
    status = 200,
  ): Promise<AnyKeelResponse> {
    const page = renderPage(registry, tree);

    const body = await renderPageStream(page, options);

    return {
      status,
      headers: { "content-type": "text/html" },
      body,
    };
  }
}

/** A controller constructor, the value stored in the application's controller map. */
export type ControllerClass = new (request: KeelRequest) => Controller;
