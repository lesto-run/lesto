// AUTO-GENERATED from app/routes/ by lesto — do not edit.
import type { DiscoveredFile, LoadedFileRoutes, LoadedRouteModule } from "@lesto/web";

import * as m0 from "../app/routes/layout";
import * as m1 from "../app/routes/lab/gallery/more/(notes)/layout";
import * as m2 from "../app/routes/lab/gallery/secret/middleware";
import * as m3 from "../app/routes/lab/gallery/page";
import * as m4 from "../app/routes/lab/gallery/[id]/page";
import * as m5 from "../app/routes/lab/gallery/more/page";
import * as m6 from "../app/routes/lab/gallery/more/(notes)/about/page";
import * as m7 from "../app/routes/lab/gallery/more/filter/[[...facets]]/page";
import * as m8 from "../app/routes/lab/gallery/more/path/[...crumbs]/page";
import * as m9 from "../app/routes/lab/gallery/secret/page";

export const files: readonly DiscoveredFile[] = [
  { kind: "layout", segments: [] },
  { kind: "layout", segments: ["lab","gallery","more","(notes)"] },
  { kind: "middleware", segments: ["lab","gallery","secret"] },
  { kind: "page", segments: ["lab","gallery"] },
  { kind: "page", segments: ["lab","gallery","[id]"] },
  { kind: "page", segments: ["lab","gallery","more"] },
  { kind: "page", segments: ["lab","gallery","more","(notes)","about"] },
  { kind: "page", segments: ["lab","gallery","more","filter","[[...facets]]"] },
  { kind: "page", segments: ["lab","gallery","more","path","[...crumbs]"] },
  { kind: "page", segments: ["lab","gallery","secret"] },
];

export const modules: LoadedFileRoutes = new Map<string, LoadedRouteModule>([
  ["layout:", m0 as LoadedRouteModule],
  ["layout:lab/gallery/more/(notes)", m1 as LoadedRouteModule],
  ["middleware:lab/gallery/secret", m2 as LoadedRouteModule],
  ["page:lab/gallery", m3 as LoadedRouteModule],
  ["page:lab/gallery/[id]", m4 as LoadedRouteModule],
  ["page:lab/gallery/more", m5 as LoadedRouteModule],
  ["page:lab/gallery/more/(notes)/about", m6 as LoadedRouteModule],
  ["page:lab/gallery/more/filter/[[...facets]]", m7 as LoadedRouteModule],
  ["page:lab/gallery/more/path/[...crumbs]", m8 as LoadedRouteModule],
  ["page:lab/gallery/secret", m9 as LoadedRouteModule],
]);

// Typed navigation: @lesto/ui reads `RegisteredRoutes` by declaration merging.
// `RoutePath` is the <Link href> form (`:param` → `${string}`, autocompleted);
// `RoutePattern` is the `route(pattern, params)` form (`:param` kept, so the
// param names stay typed). A route-less tree emits `never` for both, leaving
// `href`/`route()` unconstrained — the unchanged default.
export type RoutePath =
  | "/lab/gallery"
  | "/lab/gallery/more"
  | "/lab/gallery/more/about"
  | "/lab/gallery/more/filter"
  | "/lab/gallery/secret"
  | `/lab/gallery/${string}`
  | `/lab/gallery/more/filter/${string}`
  | `/lab/gallery/more/path/${string}`;
export type RoutePattern =
  | "/lab/gallery"
  | "/lab/gallery/:id"
  | "/lab/gallery/more"
  | "/lab/gallery/more/about"
  | "/lab/gallery/secret";

declare module "@lesto/ui" {
  interface RegisteredRoutes {
    href: RoutePath;
    pattern: RoutePattern;
  }
}
