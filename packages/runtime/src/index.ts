/**
 * @keel/runtime — the transport tier.
 *
 * The pure, transport-free MVC core (`@keel/web`) and the assembled app
 * (`@keel/kernel`) know nothing of sockets. This package is the thin adapter
 * that stands a real node:http server in front of an `App`, plus the runner
 * that drives a `@keel/queue` worker — the two long-lived processes a Keel
 * deployment runs.
 *
 *   const server = await serve(app, { port: 0 });
 *   // ... server.port is the bound ephemeral port ...
 *   await server.close();
 *
 *   const worker = runWorker(queue, { concurrency: 4 });
 *   // ... on SIGTERM ...
 *   await worker.stop();
 */

export { toKeelRequest } from "./request";
export type { RawRequest } from "./request";

export { applyResponse } from "./response";
export type { WritableResponse } from "./response";

export { serve, DEFAULT_SECURITY_HEADERS, RECOMMENDED_CSP } from "./server";
export type {
  Server,
  ServeOptions,
  HealthOptions,
  AccessEntry,
  EtagConfig,
  RequestSpan,
  RequestTracer,
} from "./server";

export { resolveClient } from "./trust-proxy";
export type { ForwardHeaders, ResolvedClient, TrustProxy } from "./trust-proxy";

export {
  cacheControl,
  etagFor,
  etagMatches,
  hasContentHash,
  respondNotModified,
} from "./http-cache";
export type { CacheControlOptions, NotModifiedResponse } from "./http-cache";

export { runWorker } from "./worker";
export type { RunWorkerOptions } from "./worker";

export { contentTypeOf, dispatchSites, isBinaryType, staticCacheControl } from "./sites";
export type { AppHandler, DispatchSitesDeps, RequestOptions, StaticReader } from "./sites";

export { dispatchSitesDev } from "./sites-dev";
export type { DispatchSitesDevDeps } from "./sites-dev";

export { nodeStaticReader } from "./static-reader";

export { openSqlite } from "./sqlite";
export type { OpenSqlite, SqliteEngines, SqliteHandle } from "./sqlite";

export { KeelError, RuntimeError } from "./errors";
export type { RuntimeErrorCode } from "./errors";
