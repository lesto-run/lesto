/**
 * Apply file-based routes onto a `lesto()` app — the impure half of the
 * convention `@lesto/router`'s pure compiler sets up.
 *
 * `@lesto/router` owns the path math: it scans the convention dir (`app/`) and
 * compiles each `page`/`layout` file into an ordered {@link FileRoute} descriptor —
 * a URL pattern, its kind, and (for a page) the depths of the layouts that wrap
 * it. This module takes those descriptors plus the LOADED modules they name and
 * turns them into ordinary `.page()` registrations on a {@link Lesto} instance, so
 * a file-route and a hand-written route live on ONE router with no second engine.
 *
 * The split is deliberate: the descriptor compiler is pure and 100%-tested over
 * literal inputs with no filesystem, and the module LOADING (a dynamic `import`
 * per file) is the bin's job — this applier sees only already-resolved modules, so
 * it too is pure over its inputs. The bin's loop is the only place that touches
 * `import()`.
 *
 * Per-page layouts, not a global chain. The code-first `.layout()` adds a layout
 * to every page declared AFTER it — a single, app-wide stack. File-routes need
 * something finer: a `layout.tsx` under `listings/` wraps the listings pages but
 * NOT the marketing ones, and the chain differs per branch of the tree. So rather
 * than push onto the app's `layoutChain`, the applier composes each page's own
 * layout chain into a wrapper component and registers THAT — reusing the existing
 * `.page()` path wholesale (load, metadata, `static`, `cache` all pass through
 * untouched), with the per-branch nesting living inside the page's component.
 */

import type { ComponentType } from "react";
import { createElement } from "react";

import { compileFileRoutes, dirKey } from "@lesto/router";
import type { DiscoveredFile, FileRoute } from "@lesto/router";

import { WebError } from "./errors";
import type { Lesto } from "./lesto";
import { wrap } from "./render-page";
import type { Layout, PageDef } from "./render-page";

/**
 * One loaded route module, keyed in {@link LoadedFileRoutes} by the directory it
 * lives at. A `page` module's `default` is the {@link PageDef} that directory's
 * URL renders; a `layout` module's `default` is the {@link Layout} that wraps the
 * pages at or below it. The loader (the bin) builds this map by `import()`-ing each
 * file the scan found; a test hands a literal map, so the applier needs no fs.
 */
export interface LoadedRouteModule {
  default: PageDef | Layout;
}

/**
 * The loaded modules a route key maps to.
 *
 * The key is the file's KIND and directory joined as `"<kind>:<dir>"` — the dir
 * being the raw segments joined by `/` (`"listings/[id]"`, the root being `""`).
 * Keying by kind AS WELL AS directory is what lets a `page` and a `layout` LIVE IN
 * THE SAME directory (`listings/page.tsx` + `listings/layout.tsx`) without
 * colliding to one map entry — a directory keyed alone would lose one of the two.
 * The {@link routeKey} helper builds the key both the loader and the applier use,
 * so they never drift.
 */
export type LoadedFileRoutes = ReadonlyMap<string, LoadedRouteModule>;

/**
 * The map key for one route module: its kind and directory, `"<kind>:<dir>"`.
 *
 * Exported so the impure loader (the bin) and this applier key the SAME module the
 * same way — a `page` at `listings/` is `"page:listings"`, a `layout` there is
 * `"layout:listings"`, and the two never overwrite each other in the map.
 */
export function routeKey(kind: FileRoute["kind"], segments: ReadonlyArray<string>): string {
  return `${kind}:${dirKey(segments)}`;
}

/**
 * Compile discovered files into descriptors AND register them on `app`, loading
 * each module from the supplied `modules` map.
 *
 * This is the one call an app (or the CLI) makes: hand it the flat list the
 * scanner found, the app to register onto, and the modules those files loaded
 * into. It compiles the descriptors (pattern derivation, layout nesting, collision
 * refusal, resolution order — all in `@lesto/router`), then registers every page,
 * wrapped in its own layout chain. Returns the app for chaining, so file-routes
 * compose with hand-written ones on the same builder:
 *
 *   applyFileRoutes(lesto().get("/api/health", ok), scanned, modules)
 *     .post("/api/contact", submit);
 *
 * A descriptor naming a module the map does not hold is a wiring bug between the
 * scan and the load — the same file list must feed both — and is refused with a
 * coded {@link WebError} (`WEB_FILE_ROUTE_MODULE_MISSING`) rather than registering
 * a route with no component.
 */
export function applyFileRoutes(
  app: Lesto,
  files: ReadonlyArray<DiscoveredFile>,
  modules: LoadedFileRoutes,
): Lesto {
  const compiled = compileFileRoutes(files);

  for (const route of compiled) {
    if (route.kind !== "page") continue;

    app.page(route.pattern, pageDefFor(route, modules));
  }

  return app;
}

/**
 * Build the {@link PageDef} to register for one page descriptor: its own module's
 * def, with its layout chain composed into the component (outermost layout first).
 *
 * The page's `load`, `metadata`, `params`, `static`, and `cache` all ride through
 * from the authored def untouched — only the `component` is replaced by one that
 * renders the original wrapped in its layouts, so the per-branch nesting is
 * invisible to the rest of the page pipeline (it sees an ordinary `PageDef`).
 */
function pageDefFor(route: FileRoute, modules: LoadedFileRoutes): PageDef {
  const pageModule = moduleAt("page", route.segments, modules, route.pattern);

  const def = pageModule.default as PageDef;

  // `compileFileRoutes` sets `layoutDepth` on EVERY page descriptor (an empty
  // array when no layout sits above it), and this function is only ever called for
  // a page (the applier filters to `kind === "page"`). The optional field is for
  // LAYOUT descriptors, which never reach this path — so an empty list is the
  // honest reading of "a page with no `layoutDepth`," and it produces no wrapper.
  const layouts = layoutChainFor(route, modules);

  // No layouts above this page → its def is registered as-is; nothing to wrap.
  if (layouts.length === 0) return def;

  const inner = def.component;

  // The composed component: render the authored page, then nest it through each
  // layout outermost-first. Layouts take `children`; the page takes its loaded
  // props — so we wrap the rendered page element, not the component, reusing
  // render-page's own `wrap` (the SAME nesting the renderer applies to app layouts).
  const wrapped: ComponentType<unknown> = (props: unknown) =>
    wrap(layouts, createElement(inner as ComponentType<unknown>, props as Record<string, unknown>));

  return { ...def, component: wrapped as PageDef["component"] };
}

/**
 * The layout components that wrap a page, outermost first — resolved from the
 * descriptor's `layoutDepth` (the depths whose directories hold a `layout` file,
 * shallowest first).
 *
 * Each depth names a directory on the path from the root to the page (the page's
 * own segments truncated to that depth); its module's `default` is the layout. The
 * shallowest-first order the compiler produced is exactly outermost-first, so the
 * chain feeds {@link nest} unchanged.
 */
function layoutChainFor(route: FileRoute, modules: LoadedFileRoutes): ReadonlyArray<Layout> {
  return route.layoutDepth.map((depth) => {
    const layoutModule = moduleAt("layout", route.segments.slice(0, depth), modules, route.pattern);

    return layoutModule.default as Layout;
  });
}

/**
 * Look up a route module by kind + directory, refusing a miss by code.
 *
 * The scan and the load must be fed the SAME file list, so a descriptor whose
 * module was not loaded is a wiring bug, not a routing one — surfaced as a coded
 * {@link WebError} naming the kind, the directory, and the route it broke, rather
 * than a downstream "default of undefined" crash at render. The `details.key` is
 * the exact map key the loader must provide, so the fix is unambiguous.
 */
function moduleAt(
  kind: FileRoute["kind"],
  segments: ReadonlyArray<string>,
  modules: LoadedFileRoutes,
  pattern: string,
): LoadedRouteModule {
  const key = routeKey(kind, segments);

  const found = modules.get(key);

  if (found === undefined) {
    throw new WebError(
      "WEB_FILE_ROUTE_MODULE_MISSING",
      `file-route "${pattern}" needs the ${kind} module at "${dirKey(segments) || "<root>"}" (key "${key}"), which was not loaded — the scan and the loader must see the same files`,
      { key, kind, pattern },
    );
  }

  return found;
}
