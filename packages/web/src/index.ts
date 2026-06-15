/**
 * @keel/web — the code-first request-handling core.
 *
 *   const app = keel()
 *     .get("/posts/:id", (c) => c.json({ id: c.param("id") }))
 *     .page("/posts/:id", { load, component: PostScene });
 *
 *   await app.handle("GET", "/posts/3");   // { status: 200, body: '{"id":"3"}', ... }
 */

// The code-first router + handler context — Keel's request-handling surface.
export { applyUiDialect, fromRequestMiddleware, keel, Keel } from "./keel";
export type { Handler, UiDialect } from "./keel";
export { Context } from "./handler-context";

// Page rendering: the lean route contract (load / params / metadata / access /
// flags) plus the props/layout/metadata types a page is authored against.
export type { Layout, PageDef, PageLoad, PageMetadata, PageProps } from "./render-page";

export type { HandleOptions } from "./types";

// Re-exported so a caller can type the streaming options a page render forwards
// (the `onError` sink, bootstrap modules) without reaching across to `@keel/ui`.
export type { StreamErrorSink, StreamOptions } from "@keel/ui/server";

export { currentContext, runWithContext } from "./context";
export type { RequestContext } from "./context";

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

export { KeelError, WebError } from "./errors";
export type { WebErrorCode } from "./errors";

export { validateBody } from "./validate";

export type { AnyKeelResponse, KeelBody, KeelRequest, KeelResponse } from "./types";
