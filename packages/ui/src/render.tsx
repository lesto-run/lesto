/**
 * tree -> React (+ optionally, the island hydration manifest).
 *
 * The renderer turns a validated JSON tree into a React element against the
 * registry. It degrades safely: an unknown or malformed node renders nothing
 * (and is reported), and a component whose own `render()` throws is contained
 * here — at build time — rather than crashing the whole tree. The renderer
 * itself NEVER throws.
 *
 * Why contain the throw eagerly instead of leaning on a React error boundary?
 * Because boundaries only fire during client reconciliation — server rendering
 * (`renderToStaticMarkup`) lets a throw propagate straight out. A try/catch
 * around each component's render is the one mechanism that holds on both sides.
 *
 * Islands ride the SAME walk. Where a node's `type` names a *client* component,
 * the server cannot run it — it emits a marked wrapper element carrying an
 * optional server `fallback`, and (when building a page) records the mount in a
 * manifest the browser later hydrates. `renderTree` keeps its exact shape and
 * behavior: an island renders its static fallback and is invisible to callers
 * that never asked for a manifest. `renderPage` is the additive door to the
 * manifest.
 */

import { createElement, Fragment } from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";

import { ISLAND_ATTR } from "./island";
import type { ClientComponentDef, IslandMount } from "./island";
import { islandMount } from "./mount";
import { isNodeObject } from "./node";
import { validateProps } from "./props";
import type { Registry } from "./registry";

/** One thing the renderer couldn't render, located by `path`. */
export interface RenderError {
  path: string;
  type: string;
}

/**
 * The injectable server-render dialect: the two functions {@link renderPageMarkup}
 * needs to serialize a built {@link Page} to body HTML.
 *
 * It is the SAME two-function surface `react-dom/server` exposes (`renderToString`
 * + `renderToStaticMarkup`), narrowed to what this module calls — so the default
 * is a thin pass-through and every existing caller is byte-for-byte unchanged.
 *
 * Why a seam at all? An `ssr: true` island ships its real server render into the
 * shell for the client to `hydrateRoot`, and hydration only succeeds when the
 * server- and client-emitted markup agree. React and Preact emit DIFFERENT
 * hydration markup (notably how they delimit adjacent text segments), so a page
 * whose client bundle is Preact (the opt-in `react`→`preact/compat` alias, ADR
 * 0007) MUST be server-rendered by Preact too, or every `ssr: true` island
 * mismatches on hydration. This seam lets the caller pick the dialect that matches
 * its client; the default keeps the React dialect this engine has always emitted.
 *
 * It mirrors `hydrate.tsx`'s injectable `mount` seam: the thing that varies by
 * runtime is injected, never reached for as a global, so both halves of the
 * hydration contract are chosen by the same explicit decision.
 *
 * The `dialect` tag names which client this renderer's markup is meant to hydrate
 * against (`"react"` / `"preact"`). It is the load-bearing half of ADR 0008's
 * matched pair: the wiring that turns a single `ui.dialect` key into a client
 * alias AND a server renderer compares this tag to the client dialect and refuses
 * a mismatch (client Preact + server React) with a coded error, so the
 * silently-mismatching hydration this seam exists to prevent can never be wired.
 */
export interface ServerRenderer {
  /** Which client this renderer's markup hydrates against — the matched-pair tag. */
  dialect: "react" | "preact";
  renderToString(node: ReactElement): string;
  renderToStaticMarkup(node: ReactElement): string;
}

/**
 * The default dialect: React's own `react-dom/server`. Statically imported (not
 * lazy) because it is this engine's baseline renderer — the one the tests, the
 * stream path, and the deploy all already use — so there is nothing to defer.
 * Selecting a different dialect (e.g. {@link ./server-preact}) is the caller's
 * explicit opt-in via {@link renderPageMarkup}'s `renderer` argument.
 */
export const reactServerRenderer: ServerRenderer = {
  dialect: "react",
  renderToStaticMarkup,
  renderToString,
};

/**
 * The mutable scratch a single render walk threads through itself: the errors it
 * accumulates and, only when a page is being built, the island manifest it fills.
 */
interface Walk {
  registry: Registry;
  errors: RenderError[];
  islands: IslandMount[] | undefined;
}

/** Build the React element for a tree, plus the list of nodes that degraded. */
export function renderTree(
  registry: Registry,
  tree: unknown,
): { element: ReactElement | null; errors: RenderError[] } {
  const walk: Walk = { registry, errors: [], islands: undefined };

  const element = build(walk, tree, "$");

  return { element, errors: walk.errors };
}

/** A fully built page: the HTML element tree plus the islands to hydrate. */
export interface Page {
  element: ReactElement | null;
  errors: RenderError[];
  islands: IslandMount[];
}

/**
 * Render a tree AND collect its island hydration manifest in one walk.
 *
 * This is `renderTree` plus the wire payload: every island in the tree yields an
 * `IslandMount { id, component, props }` whose `id` matches the `data-keel-island`
 * attribute on its wrapper, so the client can pair DOM to data. Server-only and
 * additive — existing `renderTree` callers are untouched.
 */
export function renderPage(registry: Registry, tree: unknown): Page {
  const islands: IslandMount[] = [];

  const walk: Walk = { registry, errors: [], islands };

  const element = build(walk, tree, "$");

  return { element, errors: walk.errors, islands };
}

/**
 * Serialize a built {@link Page} to its body HTML, choosing the React server
 * renderer that the page's own hydration contract requires.
 *
 * This is where the framework's headline feature lives or dies. An `ssr: true`
 * island ships its REAL server render into the shell so the client can
 * `hydrateRoot` it — reuse the DOM, no re-render. But `hydrateRoot` matches the
 * server tree to the client tree by walking *text-segment comment markers*
 * (`<!-- -->`) that React emits between adjacent text children. `renderToString`
 * emits those markers; `renderToStaticMarkup` deliberately STRIPS them (its
 * markup is for documents that will never hydrate). Hydrating
 * `renderToStaticMarkup` output therefore mismatches the instant a component
 * renders two or more adjacent text segments under one parent (`'Hi, ', name`),
 * firing `onRecoverableError` and forcing React to re-render the whole island —
 * defeating `ssr: true` entirely. Single-text-child trees happen to survive,
 * which is exactly the trap: the common shape (interpolated text) is the broken
 * one.
 *
 * So the rule is mechanical, never a guess: **if any island in the manifest is
 * `ssr: true`, the body MUST be rendered with `renderToString`** to keep the
 * hydration markers the client needs. A page with no SSR islands (pure static,
 * or only deferred `createRoot` islands whose shells are mounted fresh and never
 * hydrated) uses `renderToStaticMarkup` — smaller, marker-free output, and the
 * deferred shells are replaced wholesale so their markers are irrelevant.
 *
 * A page whose element degraded to `null` has no body to render.
 *
 * The `renderer` is the dialect seam. It DEFAULTS to {@link reactServerRenderer}
 * (real `react-dom/server`), so every existing caller — estate's `document.ts`,
 * the render/hydrate/stream tests — is byte-for-byte unchanged. A page whose
 * client bundle is Preact passes the Preact adapter (`@keel/ui/server`) so
 * the server emits the same markup the Preact client will hydrate against; only
 * then is an `ssr: true` island safe under the `preact/compat` alias.
 */
export function renderPageMarkup(
  page: Page,
  renderer: ServerRenderer = reactServerRenderer,
): string {
  if (page.element === null) return "";

  // The manifest is the single source of truth for which renderer is safe: it is
  // the same data the client reads to decide hydrate-vs-mount, so server and
  // client can never disagree about whether markers were emitted. WHICH dialect
  // emits those markers is the `renderer`'s business; this rule (markers iff any
  // ssr island) is identical across dialects.
  const needsHydrationMarkers = page.islands.some((island) => island.ssr);

  return needsHydrationMarkers
    ? renderer.renderToString(page.element)
    : renderer.renderToStaticMarkup(page.element);
}

/** Recursively build one node into a React element, collecting render errors. */
function build(walk: Walk, node: unknown, path: string): ReactElement | null {
  // A bare string leaf becomes a text node, wrapped so the return type stays a
  // uniform ReactElement (callers get ReactElement | null, never raw strings).
  if (typeof node === "string") {
    return createElement(Fragment, { key: path }, node);
  }

  // Malformed: not a string, not a node object. Render nothing, report it.
  if (!isNodeObject(node)) {
    walk.errors.push({ path, type: "invalid_node" });

    return null;
  }

  // An island short-circuits the server component path: the client owns it.
  const client = walk.registry.getClient(node.type);

  if (client !== undefined) {
    return buildIsland(walk, client, node.props ?? {}, path);
  }

  const def = walk.registry.get(node.type);

  // Unknown component: nothing vetted to render. Degrade to nothing.
  if (def === undefined) {
    walk.errors.push({ path, type: "unknown_component" });

    return null;
  }

  const { props } = validateProps(def.props, node.props ?? {});

  const childNodes: ReactNode = (node.children ?? []).map((child, index) =>
    build(walk, child, `${path}.children[${index}]`),
  );

  // Contain the component's own render: a throw becomes a reported diagnostic,
  // never an exception that escapes the walk.
  return safeRender(def.render, props, childNodes, path, walk.errors);
}

/**
 * Build an island's server footprint: a marked wrapper element holding either the
 * fallback (deferred island) or the component's real output (an `ssr` island),
 * plus (when a page is being built) its manifest entry.
 *
 * Props are validated against the client schema and asserted serializable; a
 * non-serializable prop is contained as a `render_threw` diagnostic, exactly
 * like a server component that throws, so the island degrades to nothing rather
 * than crashing the surrounding page.
 *
 * The shell contents are the crux of the hydration contract. A deferred island
 * (`ssr` falsy) holds only the fallback — the client mounts the live component
 * fresh, so the two need not match. An `ssr` island holds the component's actual
 * server render, which the client then `hydrateRoot`s — the markup MUST match, so
 * the same `component` runs on both sides with the same wire props. The `ssr`
 * flag rides into the manifest so the client picks the right mount without
 * guessing.
 */
function buildIsland(
  walk: Walk,
  client: ClientComponentDef,
  rawProps: Record<string, unknown>,
  path: string,
): ReactElement | null {
  try {
    // The mount shape (validated + serializable props, ssr, the optional
    // strategy/bind) is authored once in `islandMount`, shared with the `.page`
    // path's `defineIsland` so the two emit byte-identical wire entries. Building
    // it is the serialize guard `buildIsland` contains — a non-serializable prop
    // throws here and the island is reported, never crashing the page render.
    const { mount, props } = islandMount(client, rawProps, path);

    // Only a page build cares about the manifest; `renderTree` leaves it absent.
    walk.islands?.push(mount);

    // An `ssr` island ships its REAL output (the markup the client will hydrate
    // and find unchanged); a deferred island ships only its fallback placeholder.
    //
    // The ssr component is placed LAZILY (`createElement`, not an eager call):
    // an island's `component` is a full React component that may use hooks, so it
    // can only be run by React's renderer (during the caller's
    // `renderToStaticMarkup`), never invoked as a plain function here. This keeps
    // the renderer's invariant honest — *building* the element tree never throws;
    // the island's own render runs when React renders the tree.
    const contents: ReactNode = mount.ssr
      ? createElement(client.component as ComponentType<Record<string, unknown>>, mount.props)
      : (client.fallback?.(props) as ReactNode);

    return createElement("div", { key: path, [ISLAND_ATTR]: path }, contents);
  } catch {
    walk.errors.push({ path, type: "render_threw" });

    return null;
  }
}

/** Invoke a component's render, containing any throw as a reported error. */
function safeRender(
  render: (props: Record<string, unknown>, children: ReactNode) => ReactElement,
  props: Record<string, unknown>,
  children: ReactNode,
  path: string,
  errors: RenderError[],
): ReactElement | null {
  try {
    const element = render(props, children);

    // Re-key so React can place sibling elements without a missing-key warning.
    return createElement(Fragment, { key: path }, element);
  } catch {
    errors.push({ path, type: "render_threw" });

    return null;
  }
}
