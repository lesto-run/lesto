/**
 * The file-based-routing demo (ADR 0023) — proving the convention end to end.
 *
 * The framework splits file routing into a PURE half (`@lesto/router`: scan a
 * convention dir into descriptors, compile each to a `:param` pattern) and an
 * IMPURE-over-modules half (`@lesto/web`'s `applyFileRoutes`: register those
 * descriptors' loaded modules onto a `lesto()` app). This module wires both for
 * estate's `app/routes/` tree:
 *
 *   app/routes/
 *     layout.tsx                  → wraps every page below
 *     lab/gallery/page.tsx        → the route `/lab/gallery`
 *     lab/gallery/[id]/page.tsx   → the route `/lab/gallery/:id`  (typed `id`)
 *
 * Why the file LIST is declared here rather than read from disk at construction:
 * estate boots its app config the SAME way on Node (the build/dev/test path) and
 * inside a Cloudflare Worker isolate (`worker.ts` → `edge.ts`), where `node:fs`
 * does not exist. So the demo feeds `applyFileRoutes` an explicit
 * {@link DiscoveredFile} list — the very output a real `scanRoutes` over this tree
 * yields — and statically imports each module (which the edge bundler can see),
 * keeping the convention portable. `file-routes.test.ts` runs the REAL async
 * `scanRoutes` over an in-memory reader and asserts it reproduces exactly this
 * list, so the hand-declared descriptors can never silently drift from the tree.
 */

import { lesto } from "@lesto/web";
import type { Lesto } from "@lesto/web";
import { applyFileRoutes, routeKey } from "@lesto/web";
import type { DiscoveredFile, LoadedFileRoutes, LoadedRouteModule } from "@lesto/web";

import rootLayout from "../app/routes/layout";
import galleryPage from "../app/routes/lab/gallery/page";
import galleryDetailPage from "../app/routes/lab/gallery/[id]/page";

/**
 * The convention tree as the scanner discovers it: a root `layout`, a
 * `lab/gallery` page, and a `lab/gallery/[id]` page. Segments are the RAW
 * directory names — the `[id]` directory stays `"[id]"` here; `compileFileRoutes`
 * is the one place it becomes `:id`. `file-routes.test.ts` runs the real async
 * `scanRoutes` over an in-memory mirror of `app/routes/` and asserts it reproduces
 * exactly this list, so the hand-declared descriptors can never drift from disk.
 */
export const GALLERY_FILES: ReadonlyArray<DiscoveredFile> = [
  { kind: "layout", segments: [] },
  { kind: "page", segments: ["lab", "gallery"] },
  { kind: "page", segments: ["lab", "gallery", "[id]"] },
];

/**
 * Wrap a route module's default in the {@link LoadedRouteModule} shape the applier
 * expects. A page authored with its OWN typed `PageDef<Path, Props>` is narrower
 * than the map's `PageDef<string, unknown>` (its component takes specific props),
 * so this widens the entry to the open module shape — a true widening, since a
 * specific page def IS a page def the registrar can register.
 */
const moduleOf = (def: LoadedRouteModule["default"]): LoadedRouteModule => ({ default: def });

/**
 * The loaded modules keyed exactly as the applier looks them up — `routeKey(kind,
 * segments)` = `"<kind>:<dir>"`, the raw segments joined by `/`. The `[id]`
 * directory key keeps the RAW bracketed segment, matching its descriptor.
 */
export const GALLERY_MODULES: LoadedFileRoutes = new Map<string, LoadedRouteModule>([
  [routeKey("layout", []), moduleOf(rootLayout)],
  [routeKey("page", ["lab", "gallery"]), moduleOf(galleryPage as LoadedRouteModule["default"])],
  [
    routeKey("page", ["lab", "gallery", "[id]"]),
    moduleOf(galleryDetailPage as LoadedRouteModule["default"]),
  ],
]);

/**
 * The file-routed gallery as a `lesto()` sub-app, ready to `.route()` into the lab
 * zone. `applyFileRoutes` compiles the descriptors (pattern derivation, layout
 * nesting, resolution order — all in `@lesto/router`) and registers each page,
 * wrapped in its layout chain, onto a fresh app — which then composes with the
 * hand-written lab routes on one router, the whole point of the convention.
 */
export function buildGalleryRoutes(): Lesto {
  return applyFileRoutes(lesto(), GALLERY_FILES, GALLERY_MODULES);
}
