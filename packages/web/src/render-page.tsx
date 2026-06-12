/**
 * Rendering a page: plain React, streamed shell-first, wrapped in its layouts.
 *
 * A page is authored as an ordinary React component — not a UiNode tree (that
 * registry path is reserved for DB-driven content). Its optional `load` runs on
 * the server to produce props; `metadata` turns those props into `<head>` tags;
 * the component is wrapped in the router's layouts (outermost first) and the whole
 * document is streamed through `@keel/ui`'s `renderPageStream`, so the shell paints
 * before a slow `<Suspense>` boundary resolves.
 *
 * Islands ride `defineIsland`'s co-located emission (ADR 0011): a `<…Island/>` in
 * the tree self-emits its shell + mount script in the same stream. When the app
 * declared a client module (`keel().client(...)`) the document gains the head
 * module tag that runs the hydration runtime; when a data resolver is in scope
 * (`keel().data(...)`) the page tree is wrapped in `IslandDataProvider`, so an
 * `ssr: true` island resolves its data at render and inlines it (ADR 0012 — the
 * canonical island). A data-free, client-less page is exactly the plain document
 * it always was.
 */

import { createElement } from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";

import { IslandDataProvider, renderMetadata, renderPageStream } from "@keel/ui";
import type { LinkSpec, MetadataEntry, MetaSpec, SourceResolver } from "@keel/ui";
import type { ZodType } from "zod";

import type { Context } from "./handler-context";
import type { AnyKeelResponse } from "./types";

type MaybePromise<T> = T | Promise<T>;

/** The props a loaded page hands its component, once erased to the open runtime record. */
type LoadedProps = Record<string, unknown>;

/** A page's server-side data loader: reads the context, returns the component's props. */
export type PageLoad<Path extends string = string, Loaded = unknown> = (
  c: Context<Path>,
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
 * `params` validates the query string at the boundary (Zod); `metadata` derives
 * the head from the loaded props. Authorization and feature gating are applied as
 * middleware (`.use(can(...))` / `.use(gate(...))`), which guards a page and its
 * whole subtree exactly as it guards API routes.
 */
export interface PageDef<Path extends string = string, Loaded = unknown> {
  component: ComponentType<Loaded>;

  load?: PageLoad<Path, Loaded>;

  params?: ZodType;

  metadata?: (loaded: Loaded) => PageMetadata;
}

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
 * `keel.ts`: a single shared object whose `headers` record is mutated by
 * downstream middleware would leak one request's headers into the next malformed
 * request's 400. Each rejected request gets its own object.
 */
const badRequest = (): AnyKeelResponse => ({
  status: 400,
  headers: { "content-type": "text/plain" },
  body: "Bad Request",
});

/**
 * A hard deadline for a page's streamed render.
 *
 * React ships no default timeout, so a hung `<Suspense>` boundary — a
 * never-resolving `load`, a suspending component whose data never settles — would
 * hold the render and the socket open indefinitely: a streaming DoS. Past this
 * deadline the render is aborted (a coded `UI_STREAM_TIMEOUT`), bounding it even
 * for a still-connected client. The request's own abort signal is chained in for
 * the client-disconnect case, whichever fires first.
 */
const RENDER_DEADLINE_MS = 10_000;

/** Build the `<head>` children: the always-on charset + viewport, then the page's own tags. */
function headElements(metadata: PageMetadata): ReactElement[] {
  const entries: MetadataEntry[] = [
    { kind: "meta", spec: { charSet: "utf-8" } },
    { kind: "meta", spec: { name: "viewport", content: "width=device-width, initial-scale=1" } },
  ];

  if (metadata.title !== undefined) entries.push({ kind: "title", text: metadata.title });

  if (metadata.description !== undefined) {
    entries.push({ kind: "meta", spec: { name: "description", content: metadata.description } });
  }

  for (const spec of metadata.meta ?? []) entries.push({ kind: "meta", spec });

  for (const spec of metadata.links ?? []) entries.push({ kind: "link", spec });

  // dedupeMetadata (inside renderMetadata) keeps the last value per key and hoists
  // charset to the front, so a page's title overrides nothing it shouldn't.
  return renderMetadata(entries);
}

/** Wrap the page in its layouts, outermost first (layouts[0] is the outermost shell). */
function wrap(layouts: readonly Layout[], page: ReactElement): ReactElement {
  return layouts.reduceRight<ReactElement>(
    (child, layout) => createElement(layout, null, child),
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
 * elements). Both absent → the plain document path, byte-for-byte as before.
 */
export async function renderPageResponse(
  def: PageDef,
  c: Context,
  layouts: readonly Layout[],
  options: RenderPageOptions = {},
): Promise<AnyKeelResponse> {
  if (def.params !== undefined) {
    const parsed = def.params.safeParse(c.req.query);

    if (!parsed.success) return badRequest();

    c.set("params", parsed.data);
  }

  // The loaded props, erased to the open runtime record. `load` returns the
  // page's typed `Loaded` (the type spine threads it to the component), but the
  // renderer is generic over every page, so here it is the open shape React
  // receives — one localized erasure, not a hole in the public types.
  const loaded = ((def.load === undefined ? undefined : await def.load(c)) ?? {}) as LoadedProps;

  const page = wrap(layouts, createElement(def.component as ComponentType<LoadedProps>, loaded));

  // A render-time resolver in scope means islands inline their data (the canonical
  // island); absent, they fall back to bind + primer. Wrapping is the only seam.
  const content =
    options.resolver === undefined
      ? page
      : createElement(IslandDataProvider, { resolver: options.resolver }, page);

  const head = headElements(def.metadata === undefined ? {} : def.metadata(loaded));

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

  const stream = await renderPageStream(
    { element: documentElement, errors: [], islands: [] },
    {
      renderTimeoutMs: RENDER_DEADLINE_MS,
      ...(c.signal === undefined ? {} : { signal: c.signal }),
    },
  );

  // A dynamic page that could inline private data must not be shared-cached
  // (review 2d). Stamped here, beside the content-type, so it covers the streamed
  // body whatever it carries.
  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };

  if (options.resolver !== undefined && options.privateData === true) {
    headers["cache-control"] = "private, no-store";
  }

  return {
    status: 200,
    headers,
    body: stream,
  };
}
