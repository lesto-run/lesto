/**
 * @keel/router — a RESTful router for Keel.
 *
 *   const router = new Router();
 *   router.root("home#index");
 *   router.resources("posts", (posts) => posts.resources("comments"));
 *
 *   router.resolve("GET", "/posts/3");          // { target: "posts#show", params: { id: "3" } }
 *   router.pathFor("post", { id: 42 });         // "/posts/42"
 */

export { Router } from "./router";
export type { RouteInfo, RouteOptions, Resolution } from "./router";

export { KeelError, RouterError } from "./errors";
export type { RouterErrorCode } from "./errors";
