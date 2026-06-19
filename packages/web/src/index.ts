/**
 * @lesto/web — the code-first request-handling core.
 *
 *   const app = lesto()
 *     .get("/posts/:id", (c) => c.json({ id: c.param("id") }))
 *     .page("/posts/:id", { load, component: PostScene });
 *
 *   await app.handle("GET", "/posts/3");   // { status: 200, body: '{"id":"3"}', ... }
 */

// The code-first router + handler context — Lesto's request-handling surface.
export { applyUiDialect, fromRequestMiddleware, lesto, Lesto } from "./lesto";
export type { Handler, UiDialect } from "./lesto";
export { Context } from "./handler-context";

// Page rendering: the lean route contract (load / params / metadata / access /
// flags) plus the props/layout/metadata types a page is authored against.
export { DEFAULT_RENDER_DEADLINE_MS } from "./render-page";
export type {
  Layout,
  PageCachePolicy,
  PageDef,
  PageLoad,
  PageMetadata,
  PageProps,
  RenderPageOptions,
} from "./render-page";

// The client-error beacon receiver — a built-in route on every `lesto()` app, plus
// the sink seam the observability wave wires to OTLP. The event is PII-free by
// construction (component names + counts only).
export {
  CLIENT_ERRORS_ROUTE,
  defaultClientErrorSink,
  MAX_CLIENT_ERROR_BYTES,
  normalizeClientError,
} from "./client-errors";
export type { ClientErrorEvent, ClientErrorSink } from "./client-errors";

// The browser-RUM span receiver — a built-in route on every `lesto()` app, plus the
// sink seam the observability wiring points at `traces.seams.onBrowserSpan`. Each
// span carries the SSR-injected server trace id, so a browser span lands in the
// same collector as the server `http.request` span (ARCHITECTURE.md §7). PII-free
// by construction (same-origin paths + timing numbers + vital values only).
export {
  BROWSER_SPANS_ROUTE,
  defaultBrowserSpanSink,
  MAX_ATTRIBUTE_CHARS,
  MAX_BROWSER_SPANS_BYTES,
  normalizeBrowserSpan,
  normalizeBrowserSpans,
} from "./browser-spans";
export type { BrowserSpanSink } from "./browser-spans";

export type { HandleOptions } from "./types";

// Re-exported so a caller can type the streaming options a page render forwards
// (the `onError` sink, bootstrap modules) without reaching across to `@lesto/ui`.
export type { StreamErrorSink, StreamOptions } from "@lesto/ui/server";

export { currentContext, currentRequestSpan, runWithContext } from "./context";
export type { RequestContext, RequestContextSpan } from "./context";

export { runPipeline } from "./middleware";
export type { Middleware, Next } from "./middleware";

// Transport-neutral response hardening, shared by the node server and the edge
// adapter so neither runtime drifts: default security headers, the opt-in
// CSP/COEP knobs, and the error→status/body mapping.
export {
  bodyForStatus,
  DEFAULT_SECURITY_HEADERS,
  RECOMMENDED_CSP,
  securityDefaults,
  statusForError,
  withSecurityHeaders,
} from "./harden";
export type { SecurityHeaderOptions } from "./harden";

// File-based routing: apply the convention `@lesto/router` scans + compiles onto a
// `lesto()` app, so a `app/listings/[id]/page.tsx` registers the same typed route
// `.page("/listings/:id", …)` would (ADR 0023). The pure scan/compile lives in
// `@lesto/router`; this applies the descriptors over already-loaded modules.
export { applyFileRoutes, routeKey } from "./file-routes";
export type { LoadedFileRoutes, LoadedRouteModule } from "./file-routes";

// Re-export the scan's descriptor type from `@lesto/router`, so an app that calls
// `applyFileRoutes` gets the `DiscoveredFile` shape it must pass from the SAME
// barrel — it never needs to reach past `@lesto/web` into the router for the one
// type the applier consumes.
export type { DiscoveredFile } from "@lesto/router";

export { LestoError, WebError } from "./errors";
export type { WebErrorCode } from "./errors";

export { validateBody } from "./validate";

export type { AnyLestoResponse, LestoBody, LestoRequest, LestoResponse } from "./types";
