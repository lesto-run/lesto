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
 * A route module's default when it is a component rather than a {@link PageDef}
 * object — a page component (the named-export form) or a layout. `ComponentType`
 * over `never` props accepts any component (props are contravariant), so a
 * concretely-typed `({ listings }) => …` page and a `({ children }) => …` layout
 * both assign here; {@link toPageDef} and the layout chain narrow at the use site.
 */
type RouteComponent = ComponentType<never>;

/**
 * One loaded route module, keyed in {@link LoadedFileRoutes} by the directory it
 * lives at.
 *
 * A `page` module may export its definition in EITHER shape — {@link toPageDef}
 * folds both to one `PageDef`:
 *   - **named-export form** (idiomatic, Next/Remix-style): `export default` the
 *     component, with optional named `load` / `metadata` / `params` / `static` /
 *     `cache` exports; or
 *   - **object form**: `export default` a whole {@link PageDef}.
 * A `layout` module's `default` is the {@link Layout} that wraps the pages at or
 * below it. The loader (the bin / the generated route map) builds this map by
 * importing each file the scan found; a test hands a literal map, so the applier
 * needs no fs.
 */
export interface LoadedRouteModule {
  /** A {@link PageDef} object, a page component (named-export form), or a layout. */
  default: PageDef | RouteComponent;

  /**
   * The page component's cross-cutting concerns, as named exports — read only when
   * `default` is the component. Ignored for the object form (which carries them on
   * the `PageDef`) and for a layout (which has none).
   */
  load?: PageDef["load"];
  params?: PageDef["params"];
  metadata?: PageDef["metadata"];
  static?: PageDef["static"];
  cache?: PageDef["cache"];
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
 * Resolve a discovered file to its module — the one impure seam of the scan→apply
 * pipeline. The CLI wires a real `import()` (`(kind, segments) => import(path)`); a
 * test hands a fake. Keeping it injected is what lets {@link loadFileRoutes} stay
 * pure over its inputs and 100%-testable with no filesystem.
 */
export type RouteModuleLoader = (
  kind: FileRoute["kind"],
  segments: ReadonlyArray<string>,
) => Promise<LoadedRouteModule>;

/**
 * Build the {@link LoadedFileRoutes} map a scan produced — `import()`-ing each
 * file through the injected {@link RouteModuleLoader} and keying it the way
 * {@link applyFileRoutes} reads it. The imports run in parallel; the keys are the
 * same `routeKey` the applier looks up, so the scan and the load never drift.
 *
 *   const files = await scanRoutes(reader, "app/routes");
 *   const modules = await loadFileRoutes(files, (kind, segs) => import(pathOf(kind, segs)));
 *   applyFileRoutes(app, files, modules);
 */
export async function loadFileRoutes(
  files: ReadonlyArray<DiscoveredFile>,
  load: RouteModuleLoader,
): Promise<LoadedFileRoutes> {
  const entries = await Promise.all(
    files.map(
      async (file) =>
        [routeKey(file.kind, file.segments), await load(file.kind, file.segments)] as const,
    ),
  );

  return new Map(entries);
}

/**
 * Generate the source of a STATIC route manifest from a scan — the edge's answer
 * to "drop a file → it routes" where `loadFileRoutes`'s runtime `import()` can't
 * go (a Cloudflare Worker has no `node:fs`, and its bundler must SEE every import
 * statically). The CLI/build writes this string to a `routes.gen.ts` the app and
 * the Worker both import; the bundler then folds the routes into the edge bundle.
 * This is the same move Astro / TanStack / React Router make — a generated route
 * tree of literal imports — and it replaces any hand-maintained file list/map.
 *
 * `importBase` is the path from the generated file to the convention dir
 * (`"../app/routes"` for a `src/routes.gen.ts` over `app/routes/`); each module is
 * imported from `<importBase>/<…segments>/<kind>`. The keys are the SAME
 * {@link routeKey} the applier looks up, computed here so the generated map needs
 * no key logic of its own. Output is deterministic (sorted by key) so regenerating
 * an unchanged tree is byte-stable.
 */
export function generateRouteManifest(
  files: ReadonlyArray<DiscoveredFile>,
  options: { readonly importBase: string },
): string {
  const sorted = [...files].toSorted((a, b) =>
    routeKey(a.kind, a.segments).localeCompare(routeKey(b.kind, b.segments)),
  );

  const imports = sorted.map(
    (file, i) =>
      // JSON.stringify the specifier: a directory name is interpolated raw, so a
      // segment with a quote/backslash/newline would otherwise emit malformed TS.
      // (Segments are the project's own dir names — not a security boundary — but a
      // clean string literal that fails to resolve beats broken source.)
      `import * as m${i} from ${JSON.stringify(`${options.importBase}/${[...file.segments, file.kind].join("/")}`)};`,
  );

  const fileLines = sorted.map(
    (file) =>
      `  { kind: ${JSON.stringify(file.kind)}, segments: ${JSON.stringify(file.segments)} },`,
  );

  const mapLines = sorted.map(
    (file, i) =>
      `  [${JSON.stringify(routeKey(file.kind, file.segments))}, m${i} as LoadedRouteModule],`,
  );

  return `${[
    "// AUTO-GENERATED from app/routes/ by lesto — do not edit.",
    'import type { DiscoveredFile, LoadedFileRoutes, LoadedRouteModule } from "@lesto/web";',
    "",
    ...imports,
    "",
    "export const files: readonly DiscoveredFile[] = [",
    ...fileLines,
    "];",
    "",
    "export const modules: LoadedFileRoutes = new Map<string, LoadedRouteModule>([",
    ...mapLines,
    "]);",
  ].join("\n")}\n`;
}

/**
 * Normalize a page module to a {@link PageDef}, accepting both authoring shapes.
 *
 * A function `default` is the **named-export form**: the default IS the component,
 * so assemble the `PageDef` from it plus the module's named `load` / `metadata` /
 * `params` / `static` / `cache`. A non-function `default` is already a `PageDef`
 * **object** — used verbatim, the original form. The discriminator is `typeof`: a
 * component is a function (function or class), a `PageDef` is a plain object. This
 * is what lets a `page.tsx` `export default` its component with named siblings —
 * the Next/Remix idiom — while every existing `export default <PageDef>` page keeps
 * working unchanged.
 */
function toPageDef(module: LoadedRouteModule): PageDef {
  const exported = module.default;

  if (typeof exported !== "function") return exported;

  return {
    component: exported as PageDef["component"],
    ...(module.load === undefined ? {} : { load: module.load }),
    ...(module.params === undefined ? {} : { params: module.params }),
    ...(module.metadata === undefined ? {} : { metadata: module.metadata }),
    ...(module.static === undefined ? {} : { static: module.static }),
    ...(module.cache === undefined ? {} : { cache: module.cache }),
  };
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

  const def = toPageDef(pageModule);

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
