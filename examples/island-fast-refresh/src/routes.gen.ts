// AUTO-GENERATED from app/routes/ by lesto — do not edit.
import type { DiscoveredFile, LoadedFileRoutes, LoadedRouteModule } from "@lesto/web";

import * as m0 from "../app/routes/page";

export const files: readonly DiscoveredFile[] = [
  { kind: "page", segments: [] },
];

export const modules: LoadedFileRoutes = new Map<string, LoadedRouteModule>([
  ["page:", m0 as LoadedRouteModule],
]);

// Typed navigation: @lesto/ui reads `RegisteredRoutes` by declaration merging.
// `RoutePath` is the <Link href> form (`:param` → `${string}`, autocompleted);
// `RoutePattern` is the `route(pattern, params)` form (`:param` kept, so the
// param names stay typed). A route-less tree emits `never` for both, leaving
// `href`/`route()` unconstrained — the unchanged default.
export type RoutePath =
  | "/";
export type RoutePattern =
  | "/";

declare module "@lesto/ui" {
  interface RegisteredRoutes {
    href: RoutePath;
    pattern: RoutePattern;
  }
}
