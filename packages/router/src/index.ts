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

// The generic matcher the `keel()` builder dispatches over, plus the shared
// pattern compiler and the type-level param inference that gives handlers their
// `c.param(...)` keys with no codegen.
export { RouteTable } from "./table";
export type { Match } from "./table";
export { compile, escapeRegExp, PARAM_SEGMENT } from "./compile";
export type { CompiledPattern } from "./compile";
export type { ParamKeys, PathParams } from "./params";

export { KeelError, RouterError } from "./errors";
export type { RouterErrorCode } from "./errors";
