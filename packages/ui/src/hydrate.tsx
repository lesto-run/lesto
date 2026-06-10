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
 * Everything that varies is injected, so the whole runtime is exercised under
 * jsdom with no real browser:
 *   - `root`     — where to look for shells (defaults to `document`);
 *   - `mount`    — the mount function (defaults to React's create/hydrate split);
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
import type { IslandMount } from "./island";
import type { Registry } from "./registry";

/** Where islands are looked up: anything that can query by selector. */
export interface IslandRoot {
  querySelector(selectors: string): Element | null;
}

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

/** What `hydrateIslands` did: the ids it brought to life and the ones it couldn't find. */
export interface HydrationResult {
  mounted: string[];
  missing: string[];
}

/** Optional injection seams; all default to the real browser + React. */
export interface HydrateOptions {
  root?: IslandRoot;
  mount?: MountFn;
  onRecoverableError?: RecoverableErrorSink;
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

/**
 * Hydrate every island in `manifest`, pairing each mount's `id` to its shell.
 *
 * A mount whose shell is absent from the DOM is skipped and reported in
 * `missing` (a page may legitimately render only some islands). A mount whose
 * `component` is not a registered client component is a programming error —
 * the manifest and registry have drifted — and throws
 * `UI_ISLAND_UNKNOWN_COMPONENT`.
 */
export function hydrateIslands(
  registry: Registry,
  manifest: readonly IslandMount[],
  options: HydrateOptions = {},
): HydrationResult {
  const root: IslandRoot = options.root ?? document;

  const mount: MountFn = options.mount ?? reactMount;

  const onRecoverableError: RecoverableErrorSink =
    options.onRecoverableError ?? consoleRecoverableError;

  const mounted: string[] = [];

  const missing: string[] = [];

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

    mount(container, createElement(def.component, entry.props), {
      ssr: entry.ssr,
      onRecoverableError,
    });

    mounted.push(entry.id);
  }

  return { mounted, missing };
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
