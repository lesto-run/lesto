/**
 * Rendering a page: plain React, streamed shell-first, wrapped in its layouts.
 *
 * A page is authored as an ordinary React component — not a UiNode tree (that
 * registry path is reserved for DB-driven content). Its optional `load` runs on
 * the server to produce props; `metadata` turns those props into `<head>` tags;
 * the component is wrapped in the router's layouts (outermost first) and the whole
 * document is streamed through `@lesto/ui`'s `renderPageStream`, so the shell paints
 * before a slow `<Suspense>` boundary resolves.
 *
 * Islands ride `defineIsland`'s co-located emission (ADR 0011): a `<…Island/>` in
 * the tree self-emits its shell + mount script in the same stream. When the app
 * declared a client module (`lesto().client(...)`) the document gains the head
 * module tag that runs the hydration runtime; when a data resolver is in scope
 * (`lesto().data(...)`) the page tree is wrapped in `IslandDataProvider`, so an
 * `ssr: true` island resolves its data at render and inlines it (ADR 0012 — the
 * canonical island). A data-free, client-less page is exactly the plain document
 * it always was.
 */

import { createElement } from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";

import { IslandDataProvider, LAYOUT_ATTR, renderMetadata } from "@lesto/ui";
import type { LinkSpec, MetadataEntry, MetaSpec, SourceResolver } from "@lesto/ui";
import { renderPageStream } from "@lesto/ui/server";
import type { ServerRenderer } from "@lesto/ui/server";
import type { ZodType } from "zod";

import type { Context } from "./handler-context";
import { isNotFoundSignal } from "./not-found";
import type { AnyLestoResponse } from "./types";

type MaybePromise<T> = T | Promise<T>;

/** The props a loaded page hands its component, once erased to the open runtime record. */
type LoadedProps = Record<string, unknown>;

/**
 * A page's server-side data loader: reads the context, returns the component's props.
 *
 * It also receives the page's VALIDATED search params as a second argument —
 * `def.params`'s parsed output, typed `Search` (mirror of TanStack `validateSearch`).
 * A loader that ignores it is unaffected: `(c) => …` is still a valid `PageLoad`,
 * because a function of FEWER parameters is assignable to one of more. A loader that
 * WANTS the typed search names the second parameter; `Search` is then inferred from
 * the page's `params` schema. With no `params` schema declared, `Search` is the open
 * `unknown` default (and the argument is `undefined` at runtime).
 */
export type PageLoad<Path extends string = string, Loaded = unknown, Search = unknown> = (
  c: Context<Path>,
  search: Search,
) => MaybePromise<Loaded>;

/** A wrapping layout — a component given the page (or inner layout) as `children`. */
export type Layout = ComponentType<{ children: ReactNode }>;

/** The `<head>` metadata a page declares from its loaded props. */
export interface PageMetadata {
  title?: string;

  description?: string;

  meta?: readonly MetaSpec[];

  links?: readonly LinkSpec[];
}

/**
 * The definition a `.page(path, def)` registration carries.
 *
 * `component` is the only required field — the view. `load` feeds it props;
 * `params` validates the query string at the boundary (Zod) AND, since this
 * version, TYPES the validated value into `load`'s second argument (`Search`);
 * `metadata` derives the head from the loaded props. Authorization and feature
 * gating are applied as middleware (`.use(can(...))` / `.use(gate(...))`), which
 * guards a page and its whole subtree exactly as it guards API routes.
 *
 * The `Search` generic is INFERRED from `params`: declare `params: SomeZodSchema`
 * and `load`'s `search` argument is typed to that schema's output (akin to
 * TanStack `validateSearch`). One difference to know: the input is `c.req.query`,
 * a flat `Record<string, string>` (a repeated `?a=1&a=2` is last-wins), so the
 * schema should validate STRING-keyed scalars — a `z.array(...)`/`z.number()` field
 * type-checks but rejects every real request until the value is coerced from its
 * string (use `z.coerce.number()` / a `.transform`); array query params are not
 * yet parsed. Declare no `params` and `Search` is the open `unknown`
 * default, so an existing `(c) => …` loader is unchanged AND `params` still accepts
 * any schema (`ZodType`'s `Output` is covariant, so a narrower schema assigns to the
 * `unknown` default — the file-route applier, which holds a bare `PageDef`, keeps
 * compiling). `PageProps<typeof load>` reads only `load`'s RETURN, so it is
 * unaffected by the new argument — every existing `PageProps<typeof load>` page
 * keeps compiling.
 */
export interface PageDef<Path extends string = string, Loaded = unknown, Search = unknown> {
  component: ComponentType<Loaded>;

  load?: PageLoad<Path, Loaded, Search>;

  params?: ZodType<Search>;

  metadata?: (loaded: Loaded) => PageMetadata;

  /**
   * Mark this page as STATIC — prerendered once and served as a cacheable file,
   * not rendered per request (ADR 0010/0012, the "auth-aware static" mode).
   *
   * A dynamic page (the default) resolves its islands' data sources AT RENDER and
   * inlines the values into the document, so a per-request page ships its
   * per-user data with no client waterfall. That is exactly WRONG for a page that
   * is built once and cached: the build-time value (e.g. "signed out", because no
   * request cookie exists at prerender) would be baked into the HTML every
   * visitor receives. A `static` page therefore renders with NO render-time
   * resolver — its islands fall back to client-side `bind` + parse-time primer,
   * fetching their per-user data fresh in the browser — and the document is left
   * cacheable (never stamped `no-store`), even on an app that has private data
   * sources. The data ENDPOINT each island fetches still carries its own
   * `no-store` (see `.data()`); only the cacheable shell is shared.
   */
  static?: boolean;

  /**
   * This page's cache posture — the per-route opt-out of the app-wide `private`
   * cache cliff (ADR 0010 §3a).
   *
   * `private`-scoped data is tracked at the APP level (`lesto().data(src, …)` with
   * any private source flips a single flag), because a streamed page can't report
   * which sources it inlined before its headers flush, and `Vary: Cookie` is not
   * honored by shared caches — "do not store" is the only safe default. The
   * conservative consequence: once ANY private source is registered, EVERY
   * dynamically rendered page is stamped `Cache-Control: private, no-store`,
   * including an island-free marketing page that inlines nothing private.
   *
   * This field lets a route opt back out. It is an explicit per-route OVERRIDE,
   * not auto-detection: the page `component` is an arbitrary React function, so
   * which `defineIsland`s it renders — and which sources they bind — is not
   * knowable at registration without rendering, and not safe to derive mid-stream
   * (see above). The author, who DOES know their page's island graph, asserts it:
   *
   * - `"auto"` (the default, or unset) — the app-wide rule above: stamp
   *   `private, no-store` iff the app has a private source AND this page renders
   *   dynamically. Safe-by-default.
   * - `"public"` — assert this page's island graph binds NO private source, so
   *   keep the default (cacheable) policy even on a private-data app. Use it for
   *   the island-free (or shared-only) marketing page the app-wide flag would
   *   otherwise make uncacheable. It only SUPPRESSES the page-document stamp; the
   *   data endpoints (`/__lesto/data/<name>`) keep their own per-source headers.
   *
   * A `static` page is already cacheable (no resolver runs), so `cache` is moot
   * there and ignored.
   */
  cache?: PageCachePolicy;
}

/**
 * A page's per-route cache posture (see {@link PageDef.cache}).
 *
 * `"auto"` follows the app-wide private-data rule (safe default); `"public"`
 * asserts the page binds no private source and stays cacheable.
 */
export type PageCachePolicy = "auto" | "public";

/**
 * The props a page component receives, inferred from its `load`.
 *
 * `PageProps<typeof load>` is `Awaited<ReturnType<typeof load>>`, so a component
 * annotates its props straight off its loader with no restatement and no codegen.
 */
export type PageProps<Load> = Load extends (...args: never[]) => infer Result
  ? Awaited<NonNullable<Result>>
  : never;

/**
 * A fresh 400 response.
 *
 * A FACTORY, not a shared constant, for the same reason as `notFound()` in
 * `lesto.ts`: a single shared object whose `headers` record is mutated by
 * downstream middleware would leak one request's headers into the next malformed
 * request's 400. Each rejected request gets its own object.
 */
const badRequest = (): AnyLestoResponse => ({
  status: 400,
  headers: { "content-type": "text/plain" },
  body: "Bad Request",
});

/**
 * A fresh 404 response for a `notFound()` signal the renderer catches OUTSIDE the
 * client-recovering render (a loader throw, or a Preact buffered render) — a real
 * HTTP 404 rather than a 500 (F18). A FACTORY, per the per-request-object invariant
 * {@link badRequest} keeps. The render-time streaming case keeps the not-found
 * boundary's client-recovery body and only flips the STATUS (see
 * {@link renderPageResponse}); this plain body is the loader/buffered path, where
 * no boundary can render.
 */
const notFoundResponse = (): AnyLestoResponse => ({
  status: 404,
  headers: { "content-type": "text/plain" },
  body: "Not Found",
});

/**
 * The default hard deadline for a page's streamed render.
 *
 * React ships no default timeout, so a hung `<Suspense>` boundary — a
 * never-resolving `load`, a suspending component whose data never settles — would
 * hold the render and the socket open indefinitely: a streaming DoS. Past this
 * deadline the render is aborted (a coded `UI_STREAM_TIMEOUT`), bounding it even
 * for a still-connected client. The request's own abort signal is chained in for
 * the client-disconnect case, whichever fires first.
 *
 * An app may override it per-app through `lesto().renderDeadline(ms)`, which flows
 * here as {@link RenderPageOptions.renderDeadlineMs}; this constant is the value
 * when none was configured.
 */
export const DEFAULT_RENDER_DEADLINE_MS = 10_000;

/** Build the `<head>` children: the always-on charset + viewport, then the page's own tags. */
function headElements(metadata: PageMetadata, clientStyles: string | undefined): ReactElement[] {
  const entries: MetadataEntry[] = [
    { kind: "meta", spec: { charSet: "utf-8" } },
    { kind: "meta", spec: { name: "viewport", content: "width=device-width, initial-scale=1" } },
  ];

  if (metadata.title !== undefined) entries.push({ kind: "title", text: metadata.title });

  if (metadata.description !== undefined) {
    entries.push({ kind: "meta", spec: { name: "description", content: metadata.description } });
  }

  for (const spec of metadata.meta ?? []) entries.push({ kind: "meta", spec });

  // The framework stylesheet (ADR 0037) leads the page's own links so it is the cascade
  // BASE a page-specific stylesheet overrides. Routed through `renderMetadata` (not
  // appended raw like the client module) so an identical `metadata.links` `/styles.css`
  // collapses to one (deduped by rel+href), while other stylesheets coexist.
  if (clientStyles !== undefined) {
    entries.push({ kind: "link", spec: { rel: "stylesheet", href: clientStyles } });
  }

  for (const spec of metadata.links ?? []) entries.push({ kind: "link", spec });

  // dedupeMetadata (inside renderMetadata) keeps the last value per key and hoists
  // charset to the front, so a page's title overrides nothing it shouldn't.
  return renderMetadata(entries);
}

/**
 * Wrap the page in its layouts, outermost first (layouts[0] is the outermost shell).
 *
 * Exported for `file-routes.ts`, which composes each file-route page's per-branch
 * layout chain the SAME way this renderer wraps a page's app-level layouts — one
 * definition, so the two nesting orders can never drift.
 *
 * Each layout's children are wrapped in a `data-lesto-layout="<depth>"` marker
 * ({@link LAYOUT_ATTR}, depth 0 = outermost), the boundary the client's soft-nav /
 * dev page-swap reads to do a LAYOUT-PRESERVING PARTIAL SWAP: it aligns the live and
 * fetched layout chains by shared depth and replaces only the deepest shared layout's
 * inner contents, keeping every outer layout's DOM — and the island state mounted in
 * it — across a navigation or a dev re-render (see `@lesto/ui`'s `deepestSharedLayout`).
 * The marker sits AROUND each layout's children (not its chrome), so swapping the
 * deepest shared marker's contents replaces the inner page while the layout's own DOM
 * is preserved. It is `display:contents` — present in the DOM for the swap to find,
 * but generating no box, so it never perturbs the user's layout. A page with no
 * layouts gets no marker and the runtime falls back to the full-body swap, unchanged.
 *
 * Depth is per layout CHAIN (this one `wrap` call): an app that nests an app-level
 * `.layout()` chain around a file-route `layout.tsx` chain restarts the numbering at
 * the inner chain, so the partial swap preserves the outer chain and re-renders the
 * inner one — correct, just less-preserving than a single chain; the common case
 * (one chain) numbers contiguously from 0.
 */
export function wrap(layouts: readonly Layout[], page: ReactElement): ReactElement {
  return layouts.reduceRight<ReactElement>(
    (child, layout, depth) =>
      createElement(
        layout,
        null,
        createElement(
          "div",
          { [LAYOUT_ATTR]: String(depth), style: { display: "contents" } },
          child,
        ),
      ),
    page,
  );
}

/** Per-render island wiring: the data resolver and the client module to head-tag. */
export interface RenderPageOptions {
  /** The render-time data resolver — wraps the page tree in `IslandDataProvider` (ADR 0012). */
  resolver?: SourceResolver;

  /** The app's client module src — emitted as a head `<script type="module">` (ADR 0011). */
  clientModule?: string;

  /**
   * The app's framework stylesheet src — emitted as a head `<link rel="stylesheet">`
   * (ADR 0037), the matched sibling of {@link clientModule}. Routed through
   * `renderMetadata`, so it dedupes against an identical `metadata.links` entry while
   * coexisting with a page's other stylesheets.
   */
  clientStyles?: string;

  /**
   * Whether the app declares any `private`-scoped data source (ADR 0010 §3a).
   *
   * When true, a dynamically rendered page MAY inline per-user bytes into the
   * document, so the response is stamped `Cache-Control: private, no-store` —
   * the document carries the same defense the data *endpoint* already has
   * (chief-architect review 2d: a framework that refuses a bare per-user JSON GET
   * must not emit a bare per-user HTML doc). Conservative by necessity: the page
   * streams, so which sources resolved is not known when headers are emitted, and
   * `Vary: Cookie` is not honored by shared caches — "do not store" is the only
   * safe defense. An app with only `shared` sources is left cacheable.
   */
  privateData?: boolean;

  /**
   * The server-render dialect (ADR 0008's matched pair). Absent, or a `"react"`
   * renderer, streams the document shell-first through React 19's
   * `renderToReadableStream` (with the render-deadline + client-disconnect abort
   * the streaming path provides). A `"preact"` renderer (set when the client
   * bundle is built under the `react`→`preact/compat` alias) renders the document
   * BUFFERED with this renderer's `renderToString` — the markup the Preact client
   * hydrates against — because Preact's server renderer has no streaming twin with
   * the same onError/abort surface, so v1 takes the simpler-correct buffered path.
   * The renderer and the client alias never diverge because ONE config key
   * (`ui.dialect`) drives both, and a mismatch is refused at wiring time
   * (`WEB_DIALECT_MISMATCH`), before any request is served.
   */
  serverRenderer?: ServerRenderer;

  /**
   * The hard deadline (ms) for this page's streamed render — the app-level
   * override of {@link DEFAULT_RENDER_DEADLINE_MS}, set through
   * `lesto().renderDeadline(ms)`. Chained with the request's own abort signal
   * (whichever fires first aborts the render), so an app on a slow data tier can
   * lengthen the bound, or a latency-sensitive one tighten it, without forking
   * the renderer. Absent → the default. Only the React streaming path observes a
   * render deadline; the Preact buffered path has no streaming twin to bound.
   */
  renderDeadlineMs?: number;

  /**
   * The W3C `traceparent` for THIS request's server span, injected into the head
   * as `<meta name="lesto-traceparent" content="00-…">` (ARCHITECTURE.md §7).
   *
   * This is the browser→server join: the browser RUM runtime
   * (`@lesto/observability`'s `startBrowserRum`) reads this meta and adopts its
   * trace id, so every span the browser emits — navigation, resource, web-vital —
   * lands UNDER the same `http.request` span the server already recorded. One
   * trace, UI → API → DB. Absent (tracing off, or a static page rendered before any
   * request span exists) → no meta, and the browser roots its own trace instead.
   * The value is a spec-valid traceparent string; the framework builds it from the
   * request span's ids, so this option carries no PII and is safe in cached markup
   * only when the trace it names is the request's own.
   */
  traceparent?: string;
}

/**
 * Render a page registration to a streamed HTML response.
 *
 * Validates the query against `def.params` (a malformed query is a 400, before
 * any work), runs `load` for the component's props, wraps the component in its
 * layouts, and streams the full `<html>` document — head metadata and all —
 * shell-first. The request's abort signal is forwarded so a disconnected client
 * cancels the render rather than holding the socket.
 *
 * `options.resolver`, when set, wraps the page tree in `IslandDataProvider` so a
 * data-bound island resolves at render. `options.clientModule`, when set, appends
 * the head module tag that boots the hydration runtime (after the metadata
 * elements). `options.serverRenderer`, when set, selects the Preact buffered
 * dialect instead of React streaming (ADR 0008's matched pair). All absent → the
 * plain React-streamed document path, byte-for-byte as before.
 */
export async function renderPageResponse(
  def: PageDef,
  c: Context,
  layouts: readonly Layout[],
  options: RenderPageOptions = {},
): Promise<AnyLestoResponse> {
  // The page's VALIDATED search params, when it declared a `params` schema. The
  // parsed value is both stashed (`c.get("params")`, the prior contract) AND passed
  // typed into `load`'s second argument (the new typed-search seam). `undefined`
  // when no schema is declared — exactly the `Search` default, so a `(c) => …`
  // loader sees no change.
  let search: unknown;

  if (def.params !== undefined) {
    const parsed = def.params.safeParse(c.req.query);

    if (!parsed.success) return badRequest();

    search = parsed.data;
    c.set("params", parsed.data);
  }

  // The loaded props, erased to the open runtime record. `load` returns the
  // page's typed `Loaded` (the type spine threads it to the component), but the
  // renderer is generic over every page, so here it is the open shape React
  // receives — one localized erasure, not a hole in the public types. `load` is
  // called with the validated `search` as its second argument; the public `PageDef`
  // types it `Search`, but the erased `def` here fixes `Search = undefined`, so the
  // loader is read at the open `(c, search: unknown)` signature at this one
  // boundary — the same erasure `.page()` makes when it stores the def.
  const load = def.load as ((c: Context, search: unknown) => MaybePromise<unknown>) | undefined;

  let loaded: LoadedProps;

  try {
    loaded = ((load === undefined ? undefined : await load(c, search)) ?? {}) as LoadedProps;
  } catch (error) {
    // `notFound()` thrown from a LOADER runs before the component (and its
    // `not-found.tsx` boundary) exists, so it cannot render that boundary — but it
    // must answer a real 404, not the 500 an uncaught throw would become (F18).
    // Prefer calling `notFound()` from render for the styled boundary view.
    if (isNotFoundSignal(error)) return notFoundResponse();

    throw error;
  }

  const page = wrap(layouts, createElement(def.component as ComponentType<LoadedProps>, loaded));

  // A render-time resolver in scope means islands inline their data (the canonical
  // island); absent, they fall back to bind + primer. Wrapping is the only seam.
  const content =
    options.resolver === undefined
      ? page
      : createElement(IslandDataProvider, { resolver: options.resolver }, page);

  const head = headElements(
    def.metadata === undefined ? {} : def.metadata(loaded),
    options.clientStyles,
  );

  // The browser→server trace join (ARCHITECTURE.md §7): stamp the request span's
  // `traceparent` into the head so the browser RUM runtime adopts its trace id and
  // its spans parent on the server request span. Emitted BEFORE the client module
  // so the meta is already in the document when the hydration entry reads it.
  if (options.traceparent !== undefined) {
    head.push(createElement("meta", { name: "lesto-traceparent", content: options.traceparent }));
  }

  // The client module boots hydration: a deferred head `type="module"` script,
  // after the metadata, so every co-located mount script is present when it runs.
  if (options.clientModule !== undefined) {
    head.push(createElement("script", { type: "module", src: options.clientModule }));
  }

  const documentElement = createElement(
    "html",
    { lang: "en" },
    createElement("head", null, ...head),
    createElement("body", null, content),
  );

  // The base status: 200, or a loader/component override set via `c.status(...)`
  // (F18 — the seam a `load` uses to answer, say, a 410 or a custom code). A
  // render-time `notFound()` still forces a 404 below, whichever this is.
  let status = c.statusOverride ?? 200;

  // The matched-pair fork (ADR 0008). React (the default, and an explicit React
  // renderer): stream shell-first through React 19's `renderToReadableStream`,
  // with the render deadline + client-disconnect abort the streaming path
  // provides. Preact: render BUFFERED to a string with the dialect's
  // `renderToString` — the markup the Preact client hydrates against — because
  // Preact's server renderer has no streaming twin carrying the same
  // onError/abort surface, so v1 takes the simpler-correct buffered path. Both
  // produce the same document content; only React gets progressive flush.
  let body: AnyLestoResponse["body"];

  if (options.serverRenderer !== undefined && options.serverRenderer.dialect === "preact") {
    // Preact renders buffered: a `notFound()` thrown in render propagates out of
    // `renderToString` (no client-recovery twin), so catch it and answer a 404.
    try {
      body = options.serverRenderer.renderToString(documentElement);
    } catch (error) {
      if (isNotFoundSignal(error)) return notFoundResponse();

      throw error;
    }
  } else {
    // React streaming: a `notFound()` thrown in render reaches the stream's error
    // sink (React switches that subtree to client recovery and keeps the shell). We
    // flip the response STATUS to 404 — so a crawler / no-JS client sees a real 404
    // — while the JS client still recovers the `not-found.tsx` boundary from the
    // streamed shell (F18: the fix for the empty-200-to-crawlers bug). Any OTHER
    // render error stays observable on the console, as the default sink did — the
    // one seam the buffered `renderPageStreamToString` uses to detect an incomplete
    // document does not exist on the live stream (the shell headers are already
    // committed), so the status flip is only sound for a signal raised while the
    // shell is still rendering (a synchronous `notFound()` in the page).
    let notFoundSignalled = false;

    const onError = (error: unknown): void => {
      if (isNotFoundSignal(error)) {
        notFoundSignalled = true;

        return;
      }

      console.error("[lesto] streamed render error", error);
    };

    try {
      body = await renderPageStream(
        { element: documentElement, errors: [], islands: [] },
        {
          onError,
          renderTimeoutMs: options.renderDeadlineMs ?? DEFAULT_RENDER_DEADLINE_MS,
          ...(c.signal === undefined ? {} : { signal: c.signal }),
        },
      );
    } catch (error) {
      // A `notFound()` with NO `not-found.tsx` boundary above it escapes to the
      // shell, so `renderPageStream` REJECTS (the shell itself errored) rather than
      // client-recovering. There is no boundary view to stream, so answer a plain
      // 404 — still a real 404, never the 500 the bare throw would become.
      if (isNotFoundSignal(error)) return notFoundResponse();

      throw error;
    }

    // The page threw `notFound()` under a boundary: React kept the shell (streaming
    // it for the client to recover the boundary view) and reported the signal to
    // `onError`. Flip the STATUS to 404 so a crawler / no-JS client sees a real 404.
    if (notFoundSignalled) status = 404;
  }

  // A dynamic page that could inline private data must not be shared-cached
  // (review 2d). Stamped here, beside the content-type, so it covers the body
  // whatever it carries (streamed or buffered).
  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };

  if (options.resolver !== undefined && options.privateData === true) {
    headers["cache-control"] = "private, no-store";
  }

  return {
    status,
    headers,
    body,
  };
}
