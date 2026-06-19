/**
 * `@lesto/ui/client` — the browser-only runtime.
 *
 * This barrel gathers everything that touches the DOM (`document`, `window`,
 * React's client renderer) behind one subpath, so a server importer of
 * `@lesto/ui` never pulls DOM code into a build that lacks the DOM lib. Mirrors
 * react-dom's server/client split.
 *
 * It re-exports the island hydration runtime and the bfcache-safe page-lifecycle
 * helper — the two pieces of client code the framework ships.
 */

export { hydrateDocumentIslands, hydrateIslands } from "./hydrate";
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

// Client-side soft navigation (ADR 0024): the browser runtime half of `<Link>`.
// `enableSoftNav` installs the delegated click listener that fetches + swaps the
// next page, re-hydrates its islands, and wires Back/Forward — all over injected
// seams, so it lives behind the DOM-only `/client` subpath alongside the hydration
// runtime it composes. `<Link>` and the DOM-free contract ship from the isomorphic
// barrel; everything that touches `fetch`/`document`/`history` is here.
export { enableSoftNav } from "./softnav";
export type {
  DisableSoftNav,
  FetchedPage,
  PageFetcher,
  PageSwapper,
  PopStateTarget,
  Rehydrate,
  ScrollPosition,
  SoftNavEvent,
  SoftNavHistory,
  SoftNavKind,
  SoftNavOptions,
  SoftNavWindow,
} from "./softnav";
