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
