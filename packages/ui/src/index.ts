/**
 * @lesto/ui — the AI-native UI rendering engine's ISOMORPHIC core.
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
 *
 * This barrel is deliberately isomorphic: NOTHING here imports `react-dom/server`,
 * so a client bundle that pulls `@lesto/ui` (for `Registry`, `defineIsland`, the
 * island/data tokens) never drags React's ~60 KB server renderer into the
 * browser. The server-render surface — `renderPage`/`renderPageMarkup`/`renderTree`,
 * the streaming renderers, and the React/Preact server dialects — lives behind the
 * `@lesto/ui/server` subpath; the browser-only hydration runtime behind
 * `@lesto/ui/client`. Mirrors `react-dom`'s own server/client split (ADR 0008).
 */

export { Registry } from "./registry";

export { validateProps } from "./props";

export { componentCatalog, treeJsonSchema } from "./schema";

export { validateTree } from "./validate";
export type { TreeError } from "./validate";

// The server-render surface (`renderPage`/`renderPageMarkup`/`renderTree`, the
// streaming renderers, the React/Preact `ServerRenderer` dialects) is NOT
// re-exported here — it imports `react-dom/server` and so lives behind the
// `@lesto/ui/server` subpath, keeping this barrel client-safe.

export { assertClientDef, island, ISLAND_ATTR, ISLAND_MOUNT_ATTR } from "./island";
export type { ClientComponentDef, HydrationStrategy, IslandMount } from "./island";

// Self-describing islands for the `.page` path (ADR 0011) — THE CANONICAL island
// authoring path. A component that emits its own shell + co-located mount script
// + data primer, so islands need no page-wide manifest walk. Every `.page`/
// `lesto()` app (estate, blog) authors islands this way; its client half is
// `hydrateDocumentIslands` (the `@lesto/ui/client` subpath), and `@lesto/assets`
// synthesizes the client entry from a one-`defineIsland`-per-file `app/islands/`
// convention. The Registry/`island()`/`renderPage`/`hydrateIslands` array form
// below is now the DEMOTED niche (ADR 0011 Increment 2): it serves the AI-/DB-
// driven `UiNode` content tree, where a `type` is a JSON string a model emitted
// and the page is a walked manifest — NOT a hand-authored React `.page`.
export { defineIsland } from "./define-island";
export type { IslandComponent, IslandDef } from "./define-island";

export { islandMount } from "./mount";

// Island data sources (ADR 0010): declared data, framework-owned delivery.
// `defineDataSource` is the isomorphic token; `dataSourceHref`/`DATA_ROUTE_PREFIX`
// + `dataPrimerScript` are the STATIC-tier server delivery seams (the client half
// lives in `@lesto/ui/client`'s hydration runtime).
export { DATA_ROUTE_PREFIX, dataPrimerScript, dataSourceHref, defineDataSource } from "./data";
export type { DataSource, DataSourceScope, IslandBind } from "./data";

// The render-time source resolver (ADR 0012): the DYNAMIC-tier delivery that runs
// loaders during the render and inlines the values — feeding the canonical
// `ssr: true` island's server markup. Server-only (it wraps the page tree in a
// React context the `.page` renderer provides); NOT in the client barrel.
export { createSourceResolver, IslandDataContext, IslandDataProvider } from "./data-resolve";
export type { SourceResolver } from "./data-resolve";

// The audited seam for inlining island JSON into a `<script>`: escapes the
// breakout characters `JSON.stringify` leaves raw. ALL island-manifest emission
// MUST go through this — never a bare stringify or a `String.replace` splice.
// `serializeScriptJson` is the canonical per-island form (one mount object, used
// by `defineIsland`'s co-located mount script); `serializeManifest` is the
// page-wide ARRAY form, now scoped to the DEMOTED Registry/`UiNode` content path
// (ADR 0011 Increment 2) where `renderPage` collects every island into one
// `#lesto-islands` manifest.
export { serializeManifest, serializeScriptJson } from "./serialize";

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

// Soft navigation's authoring half (ADR 0024): `<Link>` is an ordinary `<a>` that
// the client runtime upgrades to a fetch-and-swap when present, and a normal
// navigation when not — so it is isomorphic (renders the same anchor on server and
// client) and lives in this core barrel. It pulls only the DOM-FREE contract
// (`./softnav-contract`: the opt-out attribute + the click/anchor shapes both
// halves read), never the browser runtime — so a server build that imports
// `@lesto/ui` for `<Link>` drags in no `fetch`/`DOMParser`/`document`. The RUNTIME
// half (`enableSoftNav` + its injection seams) is browser-only and lives behind
// `@lesto/ui/client`.
export { Link } from "./link";
export type { LinkProps } from "./link";
export { route } from "./route";
export type {
  HrefFor,
  KnownPatterns,
  ParamArgs,
  PatternsOf,
  RegisteredRoutes,
  RouteHref,
} from "./routes";
export { eligibleAnchor, RELOAD_ATTR } from "./softnav-contract";
export type { SoftNavAnchor, SoftNavClick } from "./softnav-contract";

// The hydration runtime and bfcache-safe lifecycle are browser-only (they touch
// `document`/`window`), so they live behind the `@lesto/ui/client` subpath —
// server-side importers of `@lesto/ui` never pull DOM code into a build without
// the DOM lib. Mirrors react-dom's server/client split.

export { LestoError, UiError } from "./errors";
export type { UiErrorCode } from "./errors";

export type { ChildrenPolicy, ComponentDef, PropSpec, PropType, UiNode } from "./types";
