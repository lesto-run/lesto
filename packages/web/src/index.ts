/**
 * @keel/web — the MVC request-handling core.
 *
 *   const router = new Router();
 *   router.get("/posts/:id", "posts#show");
 *
 *   class PostsController extends Controller {
 *     show() {
 *       return this.json({ id: this.params.id });
 *     }
 *   }
 *
 *   const app = new Application({ router, controllers: { posts: PostsController } });
 *
 *   await app.handle("GET", "/posts/3");   // { status: 200, body: '{"id":"3"}', ... }
 */

export { Application } from "./application";
export type { ApplicationOptions, HandleOptions } from "./application";

export { Controller } from "./controller";
export type { ControllerClass } from "./controller";

// Re-exported so a caller can type the streaming options it passes to
// `Controller.streamTree` without reaching across to `@keel/ui` directly.
export type { StreamErrorSink, StreamOptions } from "@keel/ui";

export { currentContext, runWithContext } from "./context";
export type { RequestContext } from "./context";

export { runPipeline } from "./middleware";
export type { Middleware, Next } from "./middleware";

export { KeelError, WebError } from "./errors";
export type { WebErrorCode } from "./errors";

export type { AnyKeelResponse, KeelBody, KeelRequest, KeelResponse } from "./types";
