/**
 * The Application is the dispatch core: it routes a request to a controller
 * action and returns its response. It owns the wiring between `@keel/router`
 * (which method + path resolves where) and the registered controllers (which
 * class handles a given `controller#action` target).
 *
 * Pure over plain request/response objects — no socket, no listener. The
 * unified runtime feeds it `(method, path, { query, body })` and writes back
 * the `KeelResponse` it returns.
 */

import type { Resolution, Router } from "@keel/router";

import type { ControllerClass } from "./controller";
import { WebError } from "./errors";
import { runPipeline } from "./middleware";
import type { Middleware } from "./middleware";
import type { AnyKeelResponse, KeelRequest, KeelResponse } from "./types";

/** What the application is built from: a router and the controllers it dispatches to. */
export interface ApplicationOptions {
  router: Router;

  /** Controllers keyed by the name used in route targets (`"posts"` in `"posts#show"`). */
  controllers: Record<string, ControllerClass>;

  /**
   * The middleware that wraps every dispatch, outermost first.
   *
   * Absent (the default) means the controller dispatch runs alone — identical
   * behavior to a pipeline-free app, the backward-compatibility floor. When
   * present, each request is folded through the list before it reaches the
   * router/controller (see {@link runPipeline}).
   */
  middleware?: readonly Middleware[];
}

/** Per-request inputs the router cannot supply: the query string, headers, and body. */
export interface HandleOptions {
  query?: Record<string, string>;

  headers?: Record<string, string>;

  body?: unknown;
}

export class Application {
  private readonly router: Router;

  private readonly controllers: Record<string, ControllerClass>;

  private readonly middleware: readonly Middleware[];

  constructor(options: ApplicationOptions) {
    this.router = options.router;
    this.controllers = options.controllers;
    this.middleware = options.middleware ?? [];
  }

  /**
   * Resolve and run a request, wrapped in the configured middleware.
   *
   * The request is normalized once — including the path params the router
   * matched, so a middleware can read them — then folded through the middleware
   * onion (see {@link runPipeline}). The innermost step is the controller
   * dispatch. With no middleware the pipeline collapses to that dispatch alone,
   * so the behavior is byte-for-byte what it was before the pipeline existed.
   *
   * The declared return is the string-bodied {@link KeelResponse}: that is the
   * dispatch *contract* every caller compiles against (`@keel/kernel`'s `App`,
   * the site dispatcher, the MCP tool). A middleware may legitimately produce a
   * wider body (the transport's `applyResponse` accepts every arm), so the
   * pipeline is typed `AnyKeelResponse` internally and reconciled to the
   * contract here — the same true narrowing the static-file path already uses,
   * because the transport, not this contract, is where a non-string body is
   * actually written.
   */
  async handle(method: string, path: string, options?: HandleOptions): Promise<KeelResponse> {
    const resolution = this.router.resolve(method, path);

    // The request a middleware sees carries the params the router matched (empty
    // when nothing matched — the 404 case the terminal dispatch then answers).
    const request: KeelRequest = {
      method,
      path,
      params: resolution?.params ?? {},
      query: options?.query ?? {},
      headers: options?.headers ?? {},
      body: options?.body,
    };

    const response = await runPipeline(this.middleware, request, () =>
      this.dispatch(request, resolution),
    );

    // The dispatch contract is string-bodied; a middleware may have widened the
    // body, but a wider body is the transport's concern (it writes every arm),
    // not this contract's — so we narrow back to it, exactly as `serveStatic`
    // does for the bytes it serves.
    return response as KeelResponse;
  }

  /**
   * The innermost step: route the request to its controller action.
   *
   * Takes the resolution `handle` already computed (so the route is matched
   * once, not twice across the pipeline). No matching route is a 404 — a normal
   * response, not an error. A matched route names a `controller#action`; a
   * missing controller or a missing action method is a programming error and
   * throws a coded `WebError`.
   */
  private async dispatch(
    request: KeelRequest,
    resolution: Resolution | undefined,
  ): Promise<AnyKeelResponse> {
    // Nothing answers this method + path: a plain 404, not an exception.
    if (resolution === undefined) {
      return {
        status: 404,
        headers: { "content-type": "text/plain" },
        body: "Not Found",
      };
    }

    // A target is "controller#action" — split once into its two halves.
    const [controllerName, actionName] = splitTarget(resolution.target);

    const ControllerForName = this.controllers[controllerName];

    if (ControllerForName === undefined) {
      throw new WebError(
        "WEB_UNKNOWN_CONTROLLER",
        `No controller is registered as "${controllerName}".`,
        { controller: controllerName, target: resolution.target },
      );
    }

    const controller = new ControllerForName(request);

    // The action is the method named `actionName` on the instance. Index through
    // the instance as an unknown-valued record so a missing method is `undefined`
    // rather than a type error, then guard that it is actually callable.
    //
    // A name that lives on `Object.prototype` (`constructor`, `toString`, …) is
    // never a real action — it is an inherited built-in that exists on every
    // object. Treat it as absent so a typo'd target like `posts#constructor`
    // fails cleanly instead of invoking an unintended method.
    const action =
      actionName in Object.prototype
        ? undefined
        : (controller as unknown as Record<string, unknown>)[actionName];

    if (typeof action !== "function") {
      throw new WebError(
        "WEB_UNKNOWN_ACTION",
        `Controller "${controllerName}" has no action "${actionName}".`,
        { controller: controllerName, action: actionName, target: resolution.target },
      );
    }

    // Bind to the instance so the action's `this` is its controller, then await:
    // sync actions resolve immediately, async ones are awaited transparently.
    //
    // The action is typed to return the WIDE `AnyKeelResponse`, not a string-bodied
    // `KeelResponse`. That is the honest type: `Controller.bytes`/`streamTree` already
    // return a wide body (a `Uint8Array`/`ReadableStream`), so an action that returns
    // one is legitimate. Claiming `KeelResponse` here would launder a stream body into
    // the string contract silently — the very footgun that lets a stream reach the
    // SSG prerenderer as `[object ReadableStream]`. Dispatch keeps the wide type; the
    // narrowing back to the string contract happens once, deliberately, in `handle`
    // (where it is the load-bearing backward-compatibility move the transport, not
    // this contract, actually honors — it writes every body arm). A streamed body is
    // for the live transport; SSG callers must render with `renderTree`, never
    // `streamTree` (see `Controller.streamTree`).
    const response = await (
      action as (this: unknown) => AnyKeelResponse | Promise<AnyKeelResponse>
    ).call(controller);

    return response;
  }
}

/** Split a `"controller#action"` target into its two named halves. */
function splitTarget(target: string): [controller: string, action: string] {
  const hash = target.indexOf("#");

  return [target.slice(0, hash), target.slice(hash + 1)];
}
