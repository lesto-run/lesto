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
import type { ReactElement, ReactNode } from "react";

import { ISLAND_ATTR } from "./island";
import type { ClientComponentDef, IslandMount } from "./island";
import { isNodeObject } from "./node";
import { validateProps } from "./props";
import type { Registry } from "./registry";
import { assertSerializable } from "./serialize";

/** One thing the renderer couldn't render, located by `path`. */
export interface RenderError {
  path: string;
  type: string;
}

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
 * Build an island's server footprint: a marked wrapper element holding the
 * optional fallback, plus (when a page is being built) its manifest entry.
 *
 * Props are validated against the client schema and asserted serializable; a
 * non-serializable prop is contained as a `render_threw` diagnostic, exactly
 * like a server component that throws, so the island degrades to nothing rather
 * than crashing the surrounding page.
 */
function buildIsland(
  walk: Walk,
  client: ClientComponentDef,
  rawProps: Record<string, unknown>,
  path: string,
): ReactElement | null {
  // A declared schema filters and coerces, exactly like a server component; an
  // island without one is trusted to pass its props straight to the wire (the
  // serialize guard below is the only gate). Either way, the props we ship are
  // the props the client will receive — nothing is dropped silently behind the
  // schema's back.
  const props = client.props === undefined ? rawProps : validateProps(client.props, rawProps).props;

  try {
    const serializable = assertSerializable(client.name, props);

    // Only a page build cares about the manifest; `renderTree` leaves it absent.
    walk.islands?.push({ id: path, component: client.name, props: serializable });

    const fallback = client.fallback?.(props);

    return createElement("div", { key: path, [ISLAND_ATTR]: path }, fallback as ReactNode);
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
