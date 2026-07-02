/**
 * `@lesto/ui/server` — the server-render half of the engine.
 *
 * Everything here imports `react-dom/server` (or its Preact twin,
 * `preact-render-to-string`) directly or transitively: the buffered and streamed
 * page renderers and the two server-render dialects. It is split out of the core
 * `@lesto/ui` barrel for one load-bearing reason — a CLIENT bundle that imports
 * `@lesto/ui` (for `Registry`, `defineIsland`, the island/data tokens) must NEVER
 * drag `react-dom/server` into the browser graph. React's `react-dom/server` is
 * ~60 KB gzip of code the browser never runs (the browser only *hydrates*), and
 * before this split the barrel pulled it into every client bundle, defeating the
 * whole point of the opt-in ~10 KB Preact dialect (ADR 0007/0008).
 *
 * So the rule is mechanical: anything that calls `renderToString` /
 * `renderToStaticMarkup` / `renderToReadableStream` lives behind this subpath; a
 * server (the `@lesto/web` page renderer, estate's `document.ts`) reaches for it
 * explicitly. The core barrel stays isomorphic — safe to import from a module the
 * client bundle reaches.
 *
 * Mirrors `@lesto/ui/client` (the browser-only hydration runtime) and
 * `react-dom`'s own server/client split.
 */

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

// The Preact server-render dialect — the matched pair (ADR 0008) for a client
// bundle built under the `react`→`preact/compat` alias. An OPTIONAL peer
// (`preact-render-to-string`), present only when an adopter chooses Preact, so a
// default React server never drags Preact's renderer into its build.
export { preactServerRenderer } from "./server-preact";

// Resource hints + LCP/modulepreload conventions over React 19's native APIs.
// These import the resource functions from bare `react-dom` and only emit markup
// during an SSR render (an SSR document-head concern, never called client-side),
// so they live behind this server subpath — off the isomorphic barrel — to keep
// `react-dom` out of the client/island bundle's import graph entirely.
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
