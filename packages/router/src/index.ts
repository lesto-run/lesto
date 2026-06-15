/**
 * @keel/router — the route-matching substrate for Keel's code-first `keel()` app.
 *
 *   const table = new RouteTable<Handler>();
 *   table.add("GET", "/posts/:id", handler);
 *   table.match("GET", "/posts/3");   // { value: handler, params: { id: "3" } }
 *
 * The pattern compiler (`compile`) and type-level param inference (`ParamKeys` /
 * `PathParams`) give `keel()` handlers their `c.param(...)` keys with no codegen.
 */

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
