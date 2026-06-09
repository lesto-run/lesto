/**
 * @keel/openapi — generate an OpenAPI 3.1 document from a @keel/router Router.
 *
 *   const router = new Router();
 *   router.resources("posts");
 *
 *   const spec = toOpenApi(router, { title: "Blog", version: "1.0.0" });
 *   const json = toJson(spec);
 */

export { toJson, toOpenApi } from "./openapi";
export type { OpenApiInfo } from "./openapi";
