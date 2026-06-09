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

export { KeelError, WebError } from "./errors";
export type { WebErrorCode } from "./errors";

export type { KeelRequest, KeelResponse } from "./types";
