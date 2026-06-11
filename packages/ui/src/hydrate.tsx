/**
 * The client runtime: turn a static page's islands live.
 *
 * After the server ships HTML with `<div data-keel-island="id">…</div>` shells
 * and a manifest of `IslandMount`s, the browser calls `hydrateIslands`. For each
 * mount it finds the matching shell by id and brings it to life with the
 * manifest's props — the moment a prerendered page becomes auth-aware,
 * per-visitor, without re-rendering the rest of the page.
 *
 * Two mount strategies, chosen per island by the manifest's `ssr` flag — because
 * the server emits two different shells (see `render.tsx`'s `buildIsland`):
 *
 *   - **Deferred island (`ssr: false`) → `createRoot().render()`.** The server
 *     could not render the real component (it depends on the signed-in user the
 *     prerender never knew), so the shell holds only a *fallback*. `hydrateRoot`
 *     demands the server and client markup match; against a fallback it would
 *     throw a hydration mismatch — strictly worse than the status quo. So we mount
 *     fresh into the shell, swapping the fallback for the live render.
 *
 *   - **SSR-able island (`ssr: true`) → `hydrateRoot()`.** Here the server
 *     rendered the component's REAL output into the shell, so the client reuses
 *     that DOM instead of re-rendering it: real hydration, React 19's hydration
 *     resilience, and the path that later unlocks selective hydration. A
 *     recoverable error (a benign mismatch React patched, or a server-thrown
 *     error it recovered from) is routed to an injectable sink rather than
 *     silently swallowed.
 *
 * The choice is the manifest's, never a guess: the server is the only side that
 * knows which shell it shipped, so it tells the client. We NEVER `hydrateRoot` a
 * fallback-only shell.
 *
 * An island may also defer WHEN it mounts. The manifest's `strategy` chooses:
 *   - **`"load"` (default / absent) → mount now.** Today's only path, untouched.
 *   - **`"visible"` → mount on first intersection.** We do NOT mount the island
 *     yet; we observe its container and mount it (then stop observing) the first
 *     time it scrolls into view — Astro's `client:visible` analogue. For Keel's
 *     deferred Account island this also defers its on-mount `/mls/api/session`
 *     fetch until the region is actually seen, so an above-the-fold prerender
 *     does not fan out a request for every below-the-fold island on load.
 *
 * Byte deferral is the declaration's choice, not the strategy's: an island whose
 * def carries an eager `component` already shipped its code in the main bundle
 * (so `"visible"` defers only its mount WORK), while a lazy `load` def fetches
 * its component as its own chunk at mount time — the per-island code-splitting
 * that makes `"visible"` defer BYTES too. The runtime treats a lazy island like
 * a visible one in its result: found, pending, reported under `deferred`, with
 * the eventual mount (or failure) appended to the caller-held arrays.
 *
 * Everything that varies is injected, so the whole runtime is exercised under
 * jsdom with no real browser:
 *   - `root`     — where to look for shells (defaults to `document`);
 *   - `mount`    — the mount function (defaults to React's create/hydrate split);
 *   - `observe`  — how a `"visible"` island waits for its region (defaults to an
 *                  `IntersectionObserver`); injectable so the lazy path is tested
 *                  under jsdom, which has no real `IntersectionObserver`;
 *   - `onRecoverableError` — the hydration-error sink (defaults to `console.error`).
 *
 * It is honest about React: this registry renders to React everywhere else, so an
 * island mounts with React. A different client framework would ship its own
 * runtime over the SAME manifest — that is the point of keeping the manifest a
 * plain data contract.
 */

import { createElement } from "react";
import type { ReactElement } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";

import { UiError } from "./errors";
import { ISLAND_ATTR } from "./island";
import type { ClientComponentDef, IslandMount } from "./island";
import type { Registry } from "./registry";

/** Where islands are looked up: anything that can query by selector. */
export interface IslandRoot {
  querySelector(selectors: string): Element | null;
}

/**
 * How a `"visible"` island waits for its region to enter the viewport.
 *
 * Given the island's container and a callback to run when it becomes visible, an
 * observer starts watching and returns a `disconnect` function that tears the
 * watching down. The observer MAY fire `onVisible` more than once (a real
 * `IntersectionObserver` fires on every viewport entry); the runtime guards
 * re-entry so the mount runs exactly once, then calls `disconnect` to stop the
 * watching. An `ObserveFn` therefore need not be one-shot itself.
 *
 * It is its own injectable seam (not folded into `mount`) for the same reason
 * `mount` is one: jsdom has no real `IntersectionObserver`, so the lazy path is
 * untestable without substituting a fake here. The default
 * ({@link intersectionObserve}) wraps the browser's `IntersectionObserver`.
 */
export type ObserveFn = (container: Element, onVisible: () => void) => Disconnect;

/** Stop an {@link ObserveFn} from watching — idempotent by contract. */
export type Disconnect = () => void;

/**
 * How to bring one island to life. `ssr` tells the mount whether the container
 * already holds the component's server-rendered output (hydrate it) or only a
 * fallback (mount fresh). `onRecoverableError` is the sink the hydrate path wires
 * to React's recoverable-error callback.
 */
export type MountFn = (container: Element, element: ReactElement, context: MountContext) => void;

/** The non-element inputs a mount needs to choose and configure its strategy. */
export interface MountContext {
  ssr: boolean;
  onRecoverableError: RecoverableErrorSink;
}

/** Where hydration's recoverable errors go — wired to React's `onRecoverableError`. */
export type RecoverableErrorSink = (error: unknown, errorInfo: { componentStack?: string }) => void;

/**
 * Where a *fatal* per-island mount error goes — the throw a single island's
 * mount raised, which we catch so the rest of the page still hydrates.
 *
 * This is distinct from `RecoverableErrorSink`: that one carries React's
 * already-recovered hydration mismatches (the mount succeeded, React patched the
 * DOM); this one carries a mount that genuinely failed (it threw and that island
 * is dead). The id of the island whose mount threw rides along so the caller can
 * tell which region is broken.
 */
export type MountErrorSink = (error: unknown, info: { id: string; component: string }) => void;

/**
 * What `hydrateIslands` did: the ids it brought to life, the ones it couldn't
 * find a shell for, and the ones whose mount threw.
 *
 * `failed` is the resilience seam: one island's mount throwing no longer aborts
 * the loop, so a single broken region cannot dark out every island after it in
 * the manifest. A page with no broken islands gets an empty `failed`, so the
 * common case reads exactly as before plus one always-empty array.
 *
 * `deferred` reports the islands found in the DOM that we did NOT finish
 * mounting synchronously — a `"visible"` island waiting on its intersection
 * observer, or a lazy (`load`) island whose chunk is still in flight. Each will
 * mount (and surface its own throw or load failure to `onMountError`) AFTER this
 * call has returned. It is its own list precisely because a deferred island is
 * neither `mounted` (no work finished) nor `missing` (its shell is present) nor
 * `failed` (nothing failed yet): conflating it with any of those would lie about
 * the page's state. A page of eager `"load"` islands gets an empty `deferred`,
 * so the common case reads exactly as before plus one always-empty array.
 */
export interface HydrationResult {
  mounted: string[];
  missing: string[];
  failed: string[];
  deferred: string[];
}

/** Optional injection seams; all default to the real browser + React. */
export interface HydrateOptions {
  root?: IslandRoot;
  mount?: MountFn;
  observe?: ObserveFn;
  onRecoverableError?: RecoverableErrorSink;
  onMountError?: MountErrorSink;
}

/**
 * Real-React default: hydrate the shell when the server rendered the real
 * component into it, otherwise mount fresh over the fallback.
 *
 * The branch is the whole point — `hydrateRoot` reuses the server DOM and would
 * throw against a fallback, `createRoot` replaces it. We only ever hydrate when
 * the manifest says the server shipped matching markup.
 */
const reactMount: MountFn = (container, element, context) => {
  if (context.ssr) {
    hydrateRoot(container, element, { onRecoverableError: context.onRecoverableError });

    return;
  }

  createRoot(container).render(element);
};

/** Default sink: surface a recoverable hydration error on the console, don't hide it. */
const consoleRecoverableError: RecoverableErrorSink = (error) => {
  console.error("[keel/ui] recoverable hydration error", error);
};

/** Default sink: surface a fatal per-island mount error, naming the dead island. */
const consoleMountError: MountErrorSink = (error, info) => {
  console.error(`[keel/ui] island "${info.id}" (${info.component}) failed to mount`, error);
};

/**
 * Default observer: a real `IntersectionObserver` that fires `onVisible` the
 * first time any part of the container intersects the viewport.
 *
 * Teardown is the RUNTIME's job, not this observer's: an `ObserveFn` returns a
 * `disconnect` and the runtime calls it after the one-shot mount. Keeping the
 * teardown in one place (the caller) means every observer — this default and any
 * injected fake — is torn down identically, and an injected observer that does
 * not self-disconnect is still cleaned up. So this default does not disconnect
 * itself on intersection; it just reports the `disconnect` handle and lets the
 * runtime drive it.
 */
const intersectionObserve: ObserveFn = (container, onVisible) => {
  const observer = new IntersectionObserver((entries) => {
    // `isIntersecting` is the standard "is any of it on screen" predicate; we act
    // on the first entry that reports true and ignore the leave/partial events.
    if (entries.some((entry) => entry.isIntersecting)) {
      onVisible();
    }
  });

  observer.observe(container);

  return () => observer.disconnect();
};

/**
 * Hydrate every island in `manifest`, pairing each mount's `id` to its shell.
 *
 * A mount whose shell is absent from the DOM is skipped and reported in
 * `missing` (a page may legitimately render only some islands). A mount whose
 * `component` is not a registered client component is a programming error —
 * the manifest and registry have drifted — and throws
 * `UI_ISLAND_UNKNOWN_COMPONENT`. That throw is deliberately NOT caught: a
 * manifest/registry mismatch is a build-time bug affecting the whole page, not a
 * per-visitor runtime fault, so failing loud at the first drifted id is correct.
 *
 * A mount that *throws at runtime* (a component that blows up during its initial
 * render) is a different animal: it dents one region, not the build. We catch it,
 * route it to `onMountError`, record the id in `failed`, and keep going — so a
 * single broken island can never dark out every island that follows it in the
 * manifest. This mirrors React's own per-root hydration resilience at the
 * island-orchestration layer above it.
 *
 * A `"visible"` island (the manifest's `strategy`) takes neither branch
 * synchronously: instead of mounting it now we set up an intersection observer
 * and record it in `deferred`. The SAME mount-and-contain logic runs when the
 * region is first seen, so a deferred island that throws is still caught and
 * routed to `onMountError` — just later, when its callback fires. Because that
 * fire happens after this function has returned, its result is reflected by
 * mutating the returned `mounted`/`failed` arrays (the caller holds the
 * reference): the synchronous return value reports the deferred id under
 * `deferred`, and the post-intersection mount appends to `mounted` or `failed`.
 */
export function hydrateIslands(
  registry: Registry,
  manifest: readonly IslandMount[],
  options: HydrateOptions = {},
): HydrationResult {
  const root: IslandRoot = options.root ?? document;

  const mount: MountFn = options.mount ?? reactMount;

  const observe: ObserveFn = options.observe ?? intersectionObserve;

  const onRecoverableError: RecoverableErrorSink =
    options.onRecoverableError ?? consoleRecoverableError;

  const onMountError: MountErrorSink = options.onMountError ?? consoleMountError;

  const mounted: string[] = [];

  const missing: string[] = [];

  const failed: string[] = [];

  const deferred: string[] = [];

  // Render one resolved component into its container and contain its throw,
  // shared by every path (eager, lazy, on-intersection) so each gets identical
  // resilience. It reads and mutates the result arrays above by closure, which
  // is why a post-return mount still lands in `mounted`/`failed`.
  const finish = (
    entry: IslandMount,
    component: NonNullable<ClientComponentDef["component"]>,
    container: Element,
  ): void => {
    try {
      mount(container, createElement(component, entry.props), {
        ssr: entry.ssr,
        onRecoverableError,
      });

      mounted.push(entry.id);
    } catch (error) {
      // One island's mount threw. Route it to the sink, mark it failed, and keep
      // hydrating the rest — a broken region must not take the page down with it.
      onMountError(error, { id: entry.id, component: entry.component });

      failed.push(entry.id);
    }
  };

  // Mount one island now (eager `component`) or kick off its chunk fetch (lazy
  // `load`) and mount when it lands. Returns whether the mount completed
  // synchronously: a lazy island reports `"later"` so the caller records it as
  // deferred — its code is still in flight when this call returns, and its
  // outcome (mounted or failed) is appended to the result arrays on arrival. A
  // rejected load is the same animal as a throwing mount — that island is dead,
  // the page is not — so it routes to `onMountError` and `failed` identically.
  const mountOne = (
    entry: IslandMount,
    def: ClientComponentDef,
    container: Element,
  ): "now" | "later" => {
    if (def.component !== undefined) {
      finish(entry, def.component, container);

      return "now";
    }

    def.load().then(
      (component) => finish(entry, component, container),
      (error: unknown) => {
        onMountError(error, { id: entry.id, component: entry.component });

        failed.push(entry.id);
      },
    );

    return "later";
  };

  for (const entry of manifest) {
    const def = registry.getClient(entry.component);

    if (def === undefined) {
      throw new UiError(
        "UI_ISLAND_UNKNOWN_COMPONENT",
        `island manifest names an unregistered client component "${entry.component}"`,
        { id: entry.id, component: entry.component },
      );
    }

    const container = root.querySelector(`[${ISLAND_ATTR}="${quoteAttrValue(entry.id)}"]`);

    // No shell for this id: the page didn't render it. Skip, don't fail.
    if (container === null) {
      missing.push(entry.id);

      continue;
    }

    // A `"visible"` island defers its mount work until its region is seen. We
    // observe the container and mount on first intersection; everything else
    // (including an absent `strategy`) is the eager default and mounts now.
    if (entry.strategy === "visible") {
      deferred.push(entry.id);

      // The runtime owns the one-shot: it mounts on the first `onVisible`,
      // ignores any later ones (a real IntersectionObserver fires on every
      // entry), and then disconnects to stop watching. Holding the guard and the
      // teardown here keeps every observer — real or injected — behaving the same.
      let mountedOnce = false;

      const disconnect = observe(container, () => {
        if (mountedOnce) return;

        mountedOnce = true;

        mountOne(entry, def, container);

        disconnect();
      });

      continue;
    }

    // An eager island mounts now; a lazy one ("later") has its chunk in flight —
    // report it deferred, exactly like a visible island whose mount is pending.
    if (mountOne(entry, def, container) === "later") {
      deferred.push(entry.id);
    }
  }

  return { mounted, missing, failed, deferred };
}

/**
 * Escape an id for the *quoted* value of an attribute selector.
 *
 * Ids are tree paths like `$.children[0]`. Inside the double quotes of
 * `[data-keel-island="…"]`, the special grammar (`[`, `]`, `.`) is inert — only
 * a literal `"` or `\` would break out of the string, so those alone are
 * escaped. We do it by hand rather than reach for `CSS.escape`, which is not
 * present in every runtime this code must run under (notably bare jsdom).
 */
function quoteAttrValue(value: string): string {
  return value.replaceAll(/["\\]/g, "\\$&");
}
