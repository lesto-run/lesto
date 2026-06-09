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

import type { Router } from "@keel/router";

import type { ControllerClass } from "./controller";
import { WebError } from "./errors";
import type { KeelRequest, KeelResponse } from "./types";

/** What the application is built from: a router and the controllers it dispatches to. */
export interface ApplicationOptions {
  router: Router;

  /** Controllers keyed by the name used in route targets (`"posts"` in `"posts#show"`). */
  controllers: Record<string, ControllerClass>;
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

  constructor(options: ApplicationOptions) {
    this.router = options.router;
    this.controllers = options.controllers;
  }

  /**
   * Resolve and run a request.
   *
   * No matching route is a 404 — a normal response, not an error. A matched
   * route names a `controller#action`; a missing controller or a missing action
   * method is a programming error and throws a coded `WebError`.
   */
  async handle(method: string, path: string, options?: HandleOptions): Promise<KeelResponse> {
    const resolution = this.router.resolve(method, path);

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

    const request: KeelRequest = {
      method,
      path,
      params: resolution.params,
      query: options?.query ?? {},
      headers: options?.headers ?? {},
      body: options?.body,
    };

    const controller = new ControllerForName(request);

    // The action is the method named `actionName` on the instance. Index through
    // the instance as an unknown-valued record so a missing method is `undefined`
    // rather than a type error, then guard that it is actually callable.
    const action = (controller as unknown as Record<string, unknown>)[actionName];

    if (typeof action !== "function") {
      throw new WebError(
        "WEB_UNKNOWN_ACTION",
        `Controller "${controllerName}" has no action "${actionName}".`,
        { controller: controllerName, action: actionName, target: resolution.target },
      );
    }

    // Bind to the instance so the action's `this` is its controller, then await:
    // sync actions resolve immediately, async ones are awaited transparently.
    const response = await (action as (this: unknown) => KeelResponse | Promise<KeelResponse>).call(
      controller,
    );

    return response;
  }
}

/** Split a `"controller#action"` target into its two named halves. */
function splitTarget(target: string): [controller: string, action: string] {
  const hash = target.indexOf("#");

  return [target.slice(0, hash), target.slice(hash + 1)];
}
