/**
 * `@keel/ui/client` — the browser-only runtime.
 *
 * This barrel gathers everything that touches the DOM (`document`, `window`,
 * React's client renderer) behind one subpath, so a server importer of
 * `@keel/ui` never pulls DOM code into a build that lacks the DOM lib. Mirrors
 * react-dom's server/client split.
 *
 * It re-exports the island hydration runtime and the bfcache-safe page-lifecycle
 * helper — the two pieces of client code the framework ships.
 */

export { hydrateIslands } from "./hydrate";
export type {
  Disconnect,
  HydrateOptions,
  HydrationResult,
  IslandRoot,
  MountContext,
  MountErrorSink,
  MountFn,
  ObserveFn,
  RecoverableErrorSink,
} from "./hydrate";

export { observePageLifecycle } from "./bfcache";
export type {
  LifecycleTarget,
  ObserveOptions,
  PageLifecycleHandlers,
  StopLifecycle,
} from "./bfcache";
