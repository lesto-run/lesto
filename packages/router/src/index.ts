/**
 * @lesto/router — the route-matching substrate for Lesto's code-first `lesto()` app.
 *
 *   const table = new RouteTable<Handler>();
 *   table.add("GET", "/posts/:id", handler);
 *   table.match("GET", "/posts/3");   // { value: handler, params: { id: "3" } }
 *
 * Captured params are URL-decoded at match time, so `/posts/a%2Fb` binds the one
 * param `"a/b"` (a `%2F` never smuggles a path separator) and a malformed `%`
 * refuses with a coded `RouterError` the web tier maps to a 400 (see `RouteTable`).
 * `pathFor` is the inverse — it encodes params back into a path that round-trips.
 *
 * The pattern compiler (`compile`) and type-level param inference (`ParamKeys` /
 * `PathParams`) give `lesto()` handlers their `c.param(...)` keys with no codegen.
 */

// The generic matcher the `lesto()` builder dispatches over, plus the shared
// pattern compiler and the type-level param inference that gives handlers their
// `c.param(...)` keys with no codegen.
export { pathFor, RouteTable } from "./table";
export type { Match } from "./table";
export { compile, escapeRegExp, PARAM_SEGMENT } from "./compile";
export type { CompiledPattern } from "./compile";
export type { CatchAllParamKeys, ParamKeys, PathParams, SingleParamKeys } from "./params";

// The file-based routing convention: scan a conventional dir (`app/`) into ordered
// route descriptors that compile to the same `:param` patterns above, so a
// file-route and a hand-written route share one router (the applier lives in
// `@lesto/web`'s `applyFileRoutes`, over these descriptors).
export { compileFileRoutes, dirKey, ROUTE_FILE_NAMES } from "./file-routes";
export type { DiscoveredFile, FileRoute, FileRouteKind } from "./file-routes";
export { scanRoutes } from "./scan";
export type { DirEntry, DirReader } from "./scan";

export { LestoError, RouterError } from "./errors";
export type { RouterErrorCode } from "./errors";
