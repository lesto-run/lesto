/**
 * @volo/openapi — generate an OpenAPI 3.1 document from a Volo app's route list.
 *
 *   const spec = toOpenApi(app.routes(), { title: "Blog", version: "1.0.0" });
 *   const json = toJson(spec);
 */

export { toJson, toOpenApi } from "./openapi";
export type { OpenApiInfo, OpenApiOptions, RouteEntry } from "./openapi";
