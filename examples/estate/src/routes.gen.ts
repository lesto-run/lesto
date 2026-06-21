// AUTO-GENERATED from app/routes/ by lesto — do not edit.
import type { DiscoveredFile, LoadedFileRoutes, LoadedRouteModule } from "@lesto/web";

import * as m0 from "../app/routes/layout";
import * as m1 from "../app/routes/lab/gallery/page";
import * as m2 from "../app/routes/lab/gallery/[id]/page";

export const files: readonly DiscoveredFile[] = [
  { kind: "layout", segments: [] },
  { kind: "page", segments: ["lab","gallery"] },
  { kind: "page", segments: ["lab","gallery","[id]"] },
];

export const modules: LoadedFileRoutes = new Map<string, LoadedRouteModule>([
  ["layout:", m0 as LoadedRouteModule],
  ["page:lab/gallery", m1 as LoadedRouteModule],
  ["page:lab/gallery/[id]", m2 as LoadedRouteModule],
]);

// Typed navigation: @lesto/ui reads `RegisteredRoutes` by declaration merging.
// `RoutePath` is the <Link href> form (`:param` → `${string}`, autocompleted);
// `RoutePattern` is the `route(pattern, params)` form (`:param` kept, so the
// param names stay typed). A route-less tree emits `never` for both, leaving
// `href`/`route()` unconstrained — the unchanged default.
export type RoutePath =
  | "/lab/gallery"
  | `/lab/gallery/${string}`;
export type RoutePattern =
  | "/lab/gallery"
  | "/lab/gallery/:id";

declare module "@lesto/ui" {
  interface RegisteredRoutes {
    href: RoutePath;
    pattern: RoutePattern;
  }
}
