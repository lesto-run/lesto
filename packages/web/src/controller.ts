/**
 * The Controller is the unit of request handling: a class whose action methods
 * receive a request and return a response. It carries no transport state — it
 * reads a `KeelRequest` and builds a `KeelResponse` through small helpers, each
 * of which names a content type so the response is correct by construction.
 */

import { renderToStaticMarkup } from "react-dom/server";

import { renderTree } from "@keel/ui";
import type { Registry } from "@keel/ui";

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
}

/** A controller constructor, the value stored in the application's controller map. */
export type ControllerClass = new (request: KeelRequest) => Controller;
