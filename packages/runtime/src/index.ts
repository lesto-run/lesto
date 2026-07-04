/**
 * @lesto/runtime — the transport tier.
 *
 * The pure, transport-free MVC core (`@lesto/web`) and the assembled app
 * (`@lesto/kernel`) know nothing of sockets. This package is the thin adapter
 * that stands a real node:http server in front of an `App`, plus the runner
 * that drives a `@lesto/queue` worker — the two long-lived processes a Lesto
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

export { toLestoRequest } from "./request";
export type { RawRequest } from "./request";

export { applyResponse } from "./response";
export type { WritableResponse } from "./response";

export {
  serve,
  closeWithDrain,
  defaultLogRequest,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_SECURITY_HEADERS,
  RECOMMENDED_CSP,
} from "./server";
export type {
  Server,
  ServeOptions,
  HealthOptions,
  LiveStreamOptions,
  AccessEntry,
  EtagConfig,
  InboundTrace,
  RequestSpan,
  RequestTracer,
  TraceparentParser,
} from "./server";

export { onShutdownSignals, serveWithGracefulShutdown } from "./graceful-shutdown";
export type {
  GracefulShutdownOptions,
  ShutdownSignalOptions,
  SignalDeps,
  ServeShutdownDeps,
} from "./graceful-shutdown";

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

export { defaultWorkerErrorSink, runWorker } from "./worker";
export type { RunWorkerOptions, WorkerErrorSink } from "./worker";

export { contentTypeOf, dispatchSites, isBinaryType, staticCacheControl } from "./sites";
export type { AppHandler, DispatchSitesDeps, RequestOptions, StaticReader } from "./sites";

export { dispatchSitesDev } from "./sites-dev";
export type { DispatchSitesDevDeps } from "./sites-dev";

export { nodeStaticReader } from "./static-reader";

export { openSqlite } from "./sqlite";
export type { OpenSqlite, SqliteEngines, SqliteHandle } from "./sqlite";

export { LestoError, MutationError, RuntimeError } from "./errors";
export type { MutationErrorCode, RuntimeErrorCode } from "./errors";

export { defineMutation, mutationRoutes, MUTATION_ROUTE_PREFIX } from "./mutations";
export type {
  Mutation,
  MutationContractOf,
  MutationCsrfOptions,
  MutationDef,
  MutationMap,
  MutationResult,
  MutationRoutesOptions,
} from "./mutations";
