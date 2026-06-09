/**
 * The client runtime: turn a static page's islands live.
 *
 * After the server ships HTML with `<div data-keel-island="id">…fallback…</div>`
 * shells and a manifest of `IslandMount`s, the browser calls `hydrateIslands`.
 * For each mount it finds the matching shell by id and mounts the real React
 * component into it with the manifest's props — the moment a prerendered page
 * becomes auth-aware, per-visitor, without re-rendering the rest of the page.
 *
 * Why `createRoot().render()` and NOT `hydrateRoot()`? An island's whole purpose
 * is that the client renders something the SERVER COULD NOT — the signed-in user
 * the prerender knew nothing about. So the server shell holds a *fallback*, not
 * the component's real output, and `hydrateRoot` (which demands the two match)
 * would throw a hydration mismatch. We mount fresh into the shell, swapping the
 * fallback for the live render. The fallback is the prerendered placeholder; the
 * mount is the live truth.
 *
 * Everything that varies is injected, so the whole runtime is exercised under
 * jsdom with no real browser:
 *   - `root`     — where to look for shells (defaults to `document`);
 *   - `hydrate`  — the mount function (defaults to React's `createRoot().render`).
 *
 * It is honest about React: this registry renders to React everywhere else, so
 * an island mounts with React. A different client framework would ship its own
 * runtime over the SAME manifest — that is the point of keeping the manifest a
 * plain data contract.
 */

import { createElement } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { UiError } from "./errors";
import { ISLAND_ATTR } from "./island";
import type { IslandMount } from "./island";
import type { Registry } from "./registry";

/** Where islands are looked up: anything that can query by selector. */
export interface IslandRoot {
  querySelector(selectors: string): Element | null;
}

/** Mount a React element into an island's shell container. */
export type HydrateFn = (container: Element, element: ReactElement) => void;

/** What `hydrateIslands` did: the ids it brought to life and the ones it couldn't find. */
export interface HydrationResult {
  mounted: string[];
  missing: string[];
}

/** Optional injection seams; both default to the real browser + React. */
export interface HydrateOptions {
  root?: IslandRoot;
  hydrate?: HydrateFn;
}

/** Real-React default: mount `element` into the shell, replacing its fallback. */
const reactMount: HydrateFn = (container, element) => {
  createRoot(container).render(element);
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

  const hydrate: HydrateFn = options.hydrate ?? reactMount;

  const mounted: string[] = [];

  const missing: string[] = [];

  for (const mount of manifest) {
    const def = registry.getClient(mount.component);

    if (def === undefined) {
      throw new UiError(
        "UI_ISLAND_UNKNOWN_COMPONENT",
        `island manifest names an unregistered client component "${mount.component}"`,
        { id: mount.id, component: mount.component },
      );
    }

    const container = root.querySelector(`[${ISLAND_ATTR}="${quoteAttrValue(mount.id)}"]`);

    // No shell for this id: the page didn't render it. Skip, don't fail.
    if (container === null) {
      missing.push(mount.id);

      continue;
    }

    hydrate(container, createElement(def.component, mount.props));

    mounted.push(mount.id);
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
