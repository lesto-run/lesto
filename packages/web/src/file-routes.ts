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

import type { ComponentType, ReactElement, ReactNode } from "react";
import { Component, createElement, Suspense } from "react";

import { compileFileRoutes, dirKey } from "@lesto/router";
import type { DiscoveredFile, FileRoute } from "@lesto/router";

import type { Context } from "./handler-context";
import { WebError } from "./errors";
import type { Handler, Lesto } from "./lesto";
import { wrap } from "./render-page";
import type { Layout, PageDef } from "./render-page";
import type { AnyLestoResponse } from "./types";

type MaybePromise<T> = T | Promise<T>;

/**
 * A file-route `middleware.ts`'s default export — a directory-scoped GUARD that runs
 * BEFORE the nearest page's loader, down the layout chain (every `middleware` above
 * the page, outermost first), the impure twin of the `@lesto/router` convention.
 *
 * Given the request {@link Context}, a guard either:
 *   - **redirects / short-circuits before load** — return a response (`c.redirect(...)`,
 *     a 403) and the page's loader and render never run; or
 *   - **augments the loader context** — call `c.set(key, value)` (e.g. the resolved
 *     user a `middleware.ts` looked up) and return nothing, so the chain falls
 *     through to the next guard and ultimately the page's `load`, which reads the
 *     value with `c.get(key)`.
 *
 * It is exactly a `Handler` minus the explicit `next` — returning a response answers,
 * returning nothing falls through — so the applier registers it verbatim ahead of the
 * page terminal in the route's chain (where `next` auto-advances). Generic in the
 * page's `Path` so `c.param(...)` is typed to the pattern the guard sits above.
 *
 * SCOPE — a `middleware.ts` composes into the page document's GET chain. The page's
 * `.data()` / island endpoints (`/__lesto/data/*`) register as their OWN routes, so
 * they do not inherit this guard automatically — a `scope: "private"` island fetch
 * would otherwise ride a separate, unguarded route (the data most worth protecting on
 * the least-protected route). The applier does NOT auto-propagate a page's guards to
 * its `.data()` sources — closing the bypass is the author's call: `.data(source,
 * loader, guards)` takes the SAME guard chain `.page(...)` does ({@link Lesto.data}),
 * so pass the same `middleware.ts` guard(s) the page carries (import and re-pass them)
 * — or an app-level `.use()` middleware that covers `/__lesto/data/*` — so the data
 * route enforces the identical guard. Hand-written API routes register their own chains
 * too; guard those the same way.
 */
export type RouteMiddleware<Path extends string = string> = (
  c: Context<Path>,
) => MaybePromise<AnyLestoResponse | void>;

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
 * below it. A `middleware` module's `default` is a {@link RouteMiddleware} guard run
 * before the page's loader (redirect / context augmentation). A `loading` / `error`
 * / `not-found` boundary module's `default` is the component the convention renders
 * in the page's place — the Suspense fallback, the error view, or the per-route 404
 * — each a plain component (no props it relies on). The loader (the bin / the
 * generated route map) builds this map by importing each file the scan found; a test
 * hands a literal map, so the applier needs no fs.
 */
export interface LoadedRouteModule {
  /**
   * A {@link PageDef} object, a page component (named-export form), a layout, a
   * {@link RouteMiddleware} guard, or a boundary component
   * (`loading`/`error`/`not-found`).
   */
  default: PageDef | RouteComponent | RouteMiddleware;

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

    // The page's middleware chain (every `middleware.ts` above it, outermost first)
    // runs BEFORE its loader — passed as the page's guards so a redirect short-circuits
    // before render and a `c.set(...)` reaches the loader. Empty when none sits above.
    app.page(route.pattern, pageDefFor(route, modules), guardChainFor(route, modules));
  }

  return app;
}

/**
 * The file-route middleware guards that run before a page's loader, outermost first
 * — resolved from the descriptor's `middlewareDepth` (the depths whose directories
 * hold a `middleware` file, shallowest first, i.e. outermost first).
 *
 * Each depth names a directory on the path from the root to the page (the page's own
 * segments truncated to that depth); its module's `default` is the {@link RouteMiddleware}
 * guard. A guard is a `Handler` minus the explicit `next`: returning a response
 * short-circuits the chain (a redirect before load), returning nothing falls through
 * to the next guard and ultimately the page (where `next` auto-advances in `runChain`).
 * The adapter discards the guard's `next` argument, so a guard that augments context
 * with `c.set(...)` and returns nothing advances correctly.
 */
function guardChainFor(route: FileRoute, modules: LoadedFileRoutes): readonly Handler[] {
  return route.middlewareDepth.map((depth) => {
    const middlewareModule = moduleAt(
      "middleware",
      route.segments.slice(0, depth),
      modules,
      route.pattern,
    );

    const guard = middlewareModule.default;

    // A `middleware.ts` that default-exports the wrong shape (an object, nothing) would
    // otherwise throw a bare `guard is not a function` per request, far from its cause —
    // and silently FAIL OPEN for an auth guard. Refuse it loudly at registration, like
    // toPageDef does for a malformed page.
    if (typeof guard !== "function") {
      throw new WebError(
        "WEB_FILE_ROUTE_INVALID_MIDDLEWARE",
        `file-route "${route.pattern}" middleware must default-export a function`,
        { pattern: route.pattern, depth },
      );
    }

    // Adapt the guard to a `Handler`: drop `next` (the chain auto-advances on a void
    // return), so a fall-through guard runs the page and a responding guard answers.
    return (c) => (guard as RouteMiddleware)(c);
  });
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
    files.map(async (file) => {
      try {
        return [routeKey(file.kind, file.segments), await load(file.kind, file.segments)] as const;
      } catch (cause) {
        // A throw / syntax error / bad import INSIDE a route file would otherwise
        // abort the whole command with a raw stack that never names the file.
        // Re-raise a coded error that does — the courtesy the sites/content loaders
        // already give.
        throw new WebError(
          "WEB_FILE_ROUTE_LOAD_FAILED",
          `the ${file.kind} module at "${dirKey(file.segments) || "<root>"}" failed to load: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { kind: file.kind, dir: dirKey(file.segments), cause },
        );
      }
    }),
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
 * imported from `<importBase>/<…segments>/<kind>`. EVERY discovered kind is emitted
 * — `page`, `layout`, and the `loading`/`error`/`not-found` boundaries — so a
 * file-routed app's boundaries work on Workers too (the applier reads them from the
 * same map). The keys are the SAME {@link routeKey} the applier looks up, computed
 * here so the generated map needs no key logic of its own. Output is deterministic —
 * sorted by key, by CODE POINT (not locale), so regenerating an unchanged tree is
 * byte-stable on any host.
 */
export function generateRouteManifest(
  files: ReadonlyArray<DiscoveredFile>,
  options: { readonly importBase: string },
): string {
  // Validate the SAME way the runtime applier does (catch-all/optional/group
  // segments, duplicate routes/params) so codegen fails loud here rather than
  // emitting a manifest that bundles cleanly but throws when it is applied. The
  // compiled routes also feed the `RoutePath` type emitted below.
  const compiled = compileFileRoutes(files);

  // Sort by code point, NOT locale: a host's `LANG`/collation must never change
  // the generated bytes (the freshness guard regenerates under Node, the build
  // under Bun). Keys are distinct — `compileFileRoutes` refused duplicates above —
  // so a total order over distinct strings needs no equal case.
  const sorted = [...files].toSorted((a, b) =>
    byCodePoint(routeKey(a.kind, a.segments), routeKey(b.kind, b.segments)),
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
    "",
    "// Typed navigation: @lesto/ui reads `RegisteredRoutes` by declaration merging.",
    "// `RoutePath` is the <Link href> form (`:param` → `${string}`, autocompleted);",
    "// `RoutePattern` is the `route(pattern, params)` form (`:param` kept, so the",
    "// param names stay typed). A route-less tree emits `never` for both, leaving",
    "// `href`/`route()` unconstrained — the unchanged default.",
    ...routePathLines(compiled),
    ...routePatternLines(compiled),
    "",
    'declare module "@lesto/ui" {',
    "  interface RegisteredRoutes {",
    "    href: RoutePath;",
    "    pattern: RoutePattern;",
    "  }",
    "}",
  ].join("\n")}\n`;
}

/**
 * Compare two strings by CODE POINT, not locale — a total order over DISTINCT
 * strings (`-1`/`1`, no equal case), for the manifest's deterministic sorts. A
 * host's `LANG`/collation must never change the generated bytes (the freshness
 * guard regenerates under Node, the build under Bun), so `localeCompare` is wrong
 * here. Shared by the file-key sort and the `RoutePath` member sort, so both branches
 * are covered by either sort's tests.
 */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : 1;
}

/**
 * The `RoutePath` union member(s) for a compiled page pattern: a static pattern is
 * a string-literal type (`"/lab/gallery"`); a `:param`/`*catchAll` pattern a
 * template-literal with each one a `${string}` slot (`` `/lab/gallery/${string}` ``,
 * `` `/docs/${string}` ``) — the shape a `<Link href>` is actually written as, so an
 * interpolated `/lab/gallery/${id}` (or a `/docs/${a}/${b}` deep catch-all link)
 * matches. An OPTIONAL catch-all ALSO serves its PARENT path (zero segments), so it
 * contributes that literal too — else `<Link href="/docs">` for `/docs/*slug?` is
 * not a known route (and would false-error under `<StrictLink>`).
 */
function routePathMembers(pattern: string): readonly string[] {
  const member = routePathMember(pattern);

  const optional = /^(.*)\/\*[A-Za-z_][A-Za-z0-9_]*\?$/.exec(pattern);

  if (optional === null) return [member];

  // The parent the optional catch-all collapses to — the root "/" when the catch-all
  // is the only segment, else the prefix before it (the `(.*)` always captures).
  // Templated like any other pattern, so a `:param` in the parent stays a `${string}`
  // slot, not a literal.
  const prefix = optional[1] as string;

  return [routePathMember(prefix === "" ? "/" : prefix), member];
}

/** One `RoutePath` member: a static literal, or a `${string}`-slotted template for `:param`/`*catchAll`. */
function routePathMember(pattern: string): string {
  if (!/[:*]/.test(pattern)) return JSON.stringify(pattern);

  return `\`${pattern
    .replace(/\*[A-Za-z_][A-Za-z0-9_]*\??/g, "${string}")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "${string}")}\``;
}

/**
 * The `export type RoutePath = …` source lines for a manifest — the deduped,
 * code-point-sorted union of every PAGE pattern's {@link routePathMembers} (a
 * `layout` registers no URL, so it contributes none). A route-less tree yields
 * `never`, so the `@lesto/ui` augmentation leaves `href` as `string`. Sorting by
 * member text keeps the generated bytes stable across reader orderings, the same
 * determinism guarantee the imports/map above hold.
 */
function routePathLines(routes: ReadonlyArray<FileRoute>): readonly string[] {
  const members = [
    ...new Set(
      routes
        .filter((route) => route.kind === "page")
        .flatMap((route) => routePathMembers(route.pattern)),
    ),
  ].toSorted(byCodePoint);

  if (members.length === 0) return ["export type RoutePath = never;"];

  return [
    "export type RoutePath =",
    ...members.map((member, i) => `  | ${member}${i === members.length - 1 ? ";" : ""}`),
  ];
}

/**
 * The `export type RoutePattern = …` source lines — like {@link routePathLines} but
 * each PAGE pattern is emitted as a plain string-literal with its `:param` segments
 * KEPT (`"/lab/gallery/:id"`), the form `route(pattern, params)` takes so
 * `@lesto/router`'s `PathParams` can read the param names off it.
 *
 * CATCH-ALL patterns (`*rest`) are EXCLUDED: the typed `route()` builder only
 * substitutes `:name` segments, so blessing a `route("/docs/*rest", …)` call would
 * return a literal, un-built URL. Excluding them makes that call a `tsc` error
 * instead — a catch-all is linked via an interpolated `<Link href>` (whose
 * `RoutePath` DOES carry it as `${string}`), not the strict builder. A route-less
 * (or all-catch-all) tree yields `never`. Deduped and code-point-sorted.
 */
function routePatternLines(routes: ReadonlyArray<FileRoute>): readonly string[] {
  const members = [
    ...new Set(
      routes
        .filter((route) => route.kind === "page" && !route.pattern.includes("*"))
        .map((route) => JSON.stringify(route.pattern)),
    ),
  ].toSorted(byCodePoint);

  if (members.length === 0) return ["export type RoutePattern = never;"];

  return [
    "export type RoutePattern =",
    ...members.map((member, i) => `  | ${member}${i === members.length - 1 ? ";" : ""}`),
  ];
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
function toPageDef(module: LoadedRouteModule, pattern: string): PageDef {
  const exported: unknown = module.default;

  // The named-export form: the default IS the component.
  if (typeof exported === "function") {
    return {
      component: exported as PageDef["component"],
      ...(module.load === undefined ? {} : { load: module.load }),
      ...(module.params === undefined ? {} : { params: module.params }),
      ...(module.metadata === undefined ? {} : { metadata: module.metadata }),
      ...(module.static === undefined ? {} : { static: module.static }),
      ...(module.cache === undefined ? {} : { cache: module.cache }),
    };
  }

  // The object form must be a real `PageDef`. A page file that default-exports
  // `null`, a value, or an object with no `component` (a common authoring slip)
  // would otherwise register a route that renders nothing — or 500s — per request,
  // far from its cause. Refuse it loudly at registration instead.
  if (
    exported === null ||
    typeof exported !== "object" ||
    typeof (exported as { component?: unknown }).component !== "function"
  ) {
    throw new WebError(
      "WEB_FILE_ROUTE_INVALID_PAGE",
      `file-route "${pattern}" must default-export a page component or a PageDef with a component`,
      { pattern },
    );
  }

  return exported as PageDef;
}

/**
 * The sentinel a page throws to render its nearest `not-found` boundary instead of
 * its own output — the file-route convention's `notFound()` signal.
 *
 * A page (or a component it renders) calls `notFound()` to mean "this URL matched a
 * route, but the thing it addresses does not exist" (a `/listings/:id` for an id
 * with no row). Throwing during render unwinds to the nearest {@link NotFoundBoundary}
 * (the page's nearest `not-found.tsx`), which renders that boundary's component —
 * the per-route 404 view — rather than the generic transport 404. The signal is a
 * distinct symbol-branded class so the boundary catches ONLY this, never masking a
 * real bug as a 404 (a thrown `TypeError` still hits the `error` boundary).
 */
const NOT_FOUND_SIGNAL = Symbol.for("lesto.file-route.notFound");

/** A thrown `notFound()` signal — branded so {@link NotFoundBoundary} catches only it. */
class NotFoundSignal extends Error {
  readonly [NOT_FOUND_SIGNAL] = true;

  constructor() {
    super("notFound() was called");

    this.name = "NotFoundSignal";
  }
}

/**
 * Signal "this matched route addresses nothing" from inside a page (or layout)
 * component's RENDER, rendering the nearest `not-found.tsx` boundary.
 *
 * Throws the {@link NotFoundSignal} sentinel, which unwinds to the page's nearest
 * {@link NotFoundBoundary}. Use it during render where the resource a resolved
 * route names is absent — read the loaded value and call it if missing:
 * `if (props.row === undefined) notFound();`. Returns `never`, so TypeScript
 * narrows the value as present after the call.
 *
 * Two honest limits today (tracked follow-ups in docs/plans/dx-parity.md W5, NOT
 * regressions): (1) it works from RENDER, not from a `load` loader — a loader runs
 * before the boundary exists, so a `notFound()` thrown there propagates as a 500;
 * return the absence to the component and call `notFound()` there. (2) Under React's
 * streaming SSR the boundary recovers on the CLIENT, so the 404 view appears after
 * hydration and the HTTP status stays 200 (a crawler / no-JS client sees an empty 200).
 */
export function notFound(): never {
  throw new NotFoundSignal();
}

/** True iff `value` is the branded `notFound()` sentinel (never an ordinary error). */
function isNotFoundSignal(value: unknown): value is NotFoundSignal {
  return value instanceof Error && NOT_FOUND_SIGNAL in value;
}

/**
 * The props a boundary component receives — its rendered children, the `Fallback`
 * to show when it trips, and a `claims` predicate that decides whether a caught
 * error is THIS boundary's to handle. `children` is OPTIONAL because `createElement`
 * supplies it positionally (its third argument), not in the props object.
 */
interface BoundaryProps {
  Fallback: ComponentType<unknown>;

  /** True iff a caught error is this boundary's to render `Fallback` for. */
  claims: (error: unknown) => boolean;

  children?: ReactNode;
}

/** A boundary's caught state: the error and whether this boundary claims it. */
interface BoundaryState {
  caught: { readonly error: unknown } | undefined;
}

/**
 * A render boundary that, when a descendant throws, renders `Fallback` if the error
 * is THIS boundary's (`claims(error)`) or RE-THROWS it otherwise — so the right
 * boundary in the stack handles each error kind.
 *
 * A class component is the only way React catches a render error (there is no hook
 * twin). Two instances compose the convention: the `error.tsx` boundary claims
 * every error EXCEPT the `notFound()` signal (which it re-throws so the 404 boundary
 * above can render); the `not-found.tsx` boundary claims ONLY that signal (re-throwing
 * any real error so the `error` boundary handles it). Under React's streaming SSR a
 * boundary recovers on the CLIENT after hydration (the SSR isolates the subtree); the
 * Suspense wrap (see {@link wrapBoundaries}) keeps the throw from tearing down the
 * shell — the same client-recovery model as Next's `error.tsx`.
 */
export class FileRouteBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { caught: undefined };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    // Record the error; `render` decides (via `claims`) whether to show the fallback
    // or re-throw to the next boundary up — the props are not available here.
    return { caught: { error } };
  }

  override render(): ReactNode {
    const caught = this.state.caught;

    if (caught === undefined) return this.props.children;

    // Our error → render the per-route fallback; anyone else's → re-throw so the
    // next boundary in the stack catches it (error ↔ not-found cross-over).
    if (this.props.claims(caught.error)) return createElement(this.props.Fallback);

    throw caught.error;
  }
}

/** The `error.tsx` boundary claims every error but the `notFound()` signal. */
export const claimsError = (error: unknown): boolean => !isNotFoundSignal(error);

/** The `not-found.tsx` boundary claims ONLY the `notFound()` signal. */
export const claimsNotFound = (error: unknown): boolean => isNotFoundSignal(error);

/**
 * Build the {@link PageDef} to register for one page descriptor: its own module's
 * def, with its layout chain AND its nearest `loading`/`error`/`not-found`
 * boundaries composed into the component.
 *
 * The page's `load`, `metadata`, `params`, `static`, and `cache` all ride through
 * from the authored def untouched — only the `component` is replaced by one that
 * renders the original wrapped, so the per-branch nesting is invisible to the rest
 * of the page pipeline (it sees an ordinary `PageDef`).
 *
 * The nesting, OUTERMOST first: layouts (the whole chain), then the `not-found`
 * boundary, then the `error` boundary, then the `loading` Suspense fallback,
 * innermost the page itself. Order matters — the `error` boundary sits BELOW
 * `not-found` so a `notFound()` thrown during render passes the error boundary
 * (which re-throws the signal) and is caught by the 404 boundary; the `loading`
 * Suspense sits innermost so the page's own suspends reveal the fallback while
 * a deeper error still bubbles to the `error` boundary above it.
 */
function pageDefFor(route: FileRoute, modules: LoadedFileRoutes): PageDef {
  const pageModule = moduleAt("page", route.segments, modules, route.pattern);

  const def = toPageDef(pageModule, route.pattern);

  // `compileFileRoutes` sets `layoutDepth` + `boundaries` on EVERY page descriptor
  // (empty when nothing sits above it), and this function is only ever called for a
  // page (the applier filters to `kind === "page"`). The empty cases produce no
  // wrapper, so an unbounded page is registered exactly as before.
  const layouts = layoutChainFor(route, modules);
  const boundaries = boundaryComponentsFor(route, modules);

  const hasBoundary =
    boundaries.loading !== undefined ||
    boundaries.error !== undefined ||
    boundaries["not-found"] !== undefined;

  // Nothing wraps this page → its def is registered as-is.
  if (layouts.length === 0 && !hasBoundary) return def;

  const inner = def.component;

  // The composed component: render the authored page, wrap it in its boundaries
  // (innermost-first), then nest it through each layout outermost-first — reusing
  // render-page's own `wrap` for the layout chain (the SAME nesting the renderer
  // applies to app layouts), so the two orders never drift.
  const wrapped: ComponentType<unknown> = (props: unknown) => {
    const page = createElement(inner as ComponentType<unknown>, props as Record<string, unknown>);

    return wrap(layouts, wrapBoundaries(page, boundaries));
  };

  return { ...def, component: wrapped as PageDef["component"] };
}

/** The boundary components resolved for a page, each absent when it has none above it. */
interface ResolvedBoundaries {
  loading?: ComponentType<unknown>;
  error?: ComponentType<unknown>;
  "not-found"?: ComponentType<unknown>;
}

/** An empty Suspense fallback for the SSR-isolation wrap when no `loading` is declared. */
const NoFallback = (): null => null;

/**
 * Wrap a rendered page element in its nearest boundaries, innermost-first.
 *
 * The nesting, innermost-first: a `<Suspense>` (the loading fallback), then the
 * `error` boundary, then the `not-found` boundary outermost — so a `notFound()`
 * thrown in the page bubbles past the error boundary (which re-throws the signal)
 * to the 404 boundary, a genuine throw is caught by the error boundary, and a
 * suspended render reveals the loading fallback.
 *
 * THE SUSPENSE IS LOAD-BEARING for the error/not-found boundaries under streaming
 * SSR, not just for `loading`. React's `renderToReadableStream` REJECTS the whole
 * render if a throw escapes to the shell (outside every `<Suspense>`); inside a
 * boundary it instead isolates that subtree (emitting client-recovery markers) and
 * keeps the shell. So whenever an `error`/`not-found` boundary is present we wrap
 * the page in a Suspense even without a `loading` file (an empty fallback), so a
 * page throw never tears down the document — the error/404 boundary then renders
 * its view on the CLIENT after hydration (the same model as Next's client `error.tsx`).
 * A `loading` file supplies a real fallback for that same Suspense.
 */
function wrapBoundaries(page: ReactElement, boundaries: ResolvedBoundaries): ReactElement {
  let node: ReactElement = page;

  const needsErrorIsolation =
    boundaries.error !== undefined || boundaries["not-found"] !== undefined;

  // A Suspense is added when the page declares `loading`, OR when an error/not-found
  // boundary needs the shell-isolation it provides under streaming SSR (above).
  if (boundaries.loading !== undefined || needsErrorIsolation) {
    const fallback = createElement(boundaries.loading ?? NoFallback);

    node = createElement(Suspense, { fallback }, node);
  }

  if (boundaries.error !== undefined) {
    node = createElement(
      FileRouteBoundary,
      { Fallback: boundaries.error, claims: claimsError },
      node,
    );
  }

  if (boundaries["not-found"] !== undefined) {
    node = createElement(
      FileRouteBoundary,
      { Fallback: boundaries["not-found"], claims: claimsNotFound },
      node,
    );
  }

  return node;
}

/**
 * Resolve a page's nearest `loading`/`error`/`not-found` boundary components from
 * its `boundaries` depths — each the `default` export of the boundary module at the
 * named depth, or absent when the page has none of that kind above it.
 *
 * The compiler computed the NEAREST depth per kind (the deepest matching directory,
 * so a deeper file overrides a shallower); here we load that one module. A boundary
 * module's `default` is its component (the named-export idiom — a `loading.tsx`
 * just `export default`s the spinner), looked up the same `routeKey` way layouts are.
 */
function boundaryComponentsFor(route: FileRoute, modules: LoadedFileRoutes): ResolvedBoundaries {
  const resolved: ResolvedBoundaries = {};

  for (const kind of ["loading", "error", "not-found"] as const) {
    const depth = route.boundaries[kind];

    if (depth === undefined) continue;

    const module = moduleAt(kind, route.segments.slice(0, depth), modules, route.pattern);

    resolved[kind] = module.default as ComponentType<unknown>;
  }

  return resolved;
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
