/**
 * @keel/ui — the AI-native UI rendering engine core.
 *
 *   const registry = new Registry()
 *     .define({ name: "Box", props: {}, children: true, render: (_p, kids) => <div>{kids}</div> });
 *
 *   const schema  = treeJsonSchema(registry);   // constrain the model's output
 *   const catalog = componentCatalog(registry); // describe it in the prompt
 *
 *   const tree = { type: "Box", children: ["hello"] };   // the AI emits plain JSON
 *
 *   const { valid, errors } = validateTree(registry, tree);   // pure, React-free
 *   const { element }       = renderTree(registry, tree);     // tree -> React, safe
 */

export { Registry } from "./registry";

export { validateProps } from "./props";

export { componentCatalog, treeJsonSchema } from "./schema";

export { validateTree } from "./validate";
export type { TreeError } from "./validate";

export { reactServerRenderer, renderPage, renderPageMarkup, renderTree } from "./render";
export type { Page, RenderError, ServerRenderer } from "./render";

// Streaming SSR: a live shell-first stream for humans, plus a buffered `allReady`
// exit for crawlers/SSG. Additive over `renderPageMarkup` (which stays the
// dependency-light buffered API). Server-safe — React's stream renderer runs on
// Node as of React 19.2.
export { renderPageStream, renderPageStreamToString } from "./stream";
export type {
  ErrorInfo,
  ReactRenderStream,
  RenderToReadableStream,
  StreamErrorSink,
  StreamOptions,
} from "./stream";

export { island, ISLAND_ATTR } from "./island";
export type { ClientComponentDef, HydrationStrategy, IslandMount } from "./island";

// Island data sources (ADR 0010): declared data, framework-owned delivery.
// `defineDataSource` is the isomorphic token; `dataSourceHref`/`DATA_ROUTE_PREFIX`
// + `dataPrimerScript` + `resolveIslandData` are the server-side delivery seams
// (the client half lives in `@keel/ui/client`'s hydration runtime).
export {
  DATA_ROUTE_PREFIX,
  dataPrimerScript,
  dataSourceHref,
  defineDataSource,
  resolveIslandData,
} from "./data";
export type { DataSource, IslandBind } from "./data";

// The audited seam for inlining the island manifest into a `<script>`: escapes
// the breakout characters `JSON.stringify` leaves raw. Manifest emission MUST go
// through this — never a bare stringify or a `String.replace` splice.
export { serializeManifest } from "./serialize";

// Resource hints + LCP/modulepreload conventions over React 19's native APIs.
// Server-safe: the `react-dom` resource functions are isomorphic and only emit
// markup during an SSR render.
export {
  lcpImage,
  modulePreload,
  preconnect,
  prefetchDNS,
  preinit,
  preinitModule,
  preload,
} from "./resources";
export type {
  LcpImageProps,
  PreconnectOptions,
  PreinitModuleOptions,
  PreinitOptions,
  PreloadOptions,
  ResourceRegistrar,
} from "./resources";

// Document metadata helpers + the dedup convention React's hoist-without-dedupe
// leaves to the framework. Pure: React elements / data in, data out.
export { dedupeMetadata, link, meta, renderMetadata, renderMetadataEntry, title } from "./metadata";
export type {
  CharsetMeta,
  LinkSpec,
  MetadataEntry,
  MetaSpec,
  NamedMeta,
  PropertyMeta,
} from "./metadata";

// The hydration runtime and bfcache-safe lifecycle are browser-only (they touch
// `document`/`window`), so they live behind the `@keel/ui/client` subpath —
// server-side importers of `@keel/ui` never pull DOM code into a build without
// the DOM lib. Mirrors react-dom's server/client split.

export { KeelError, UiError } from "./errors";
export type { UiErrorCode } from "./errors";

export type { ChildrenPolicy, ComponentDef, PropSpec, PropType, UiNode } from "./types";
