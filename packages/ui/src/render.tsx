/**
 * tree -> React.
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
 */

import { createElement, Fragment } from "react";
import type { ReactElement, ReactNode } from "react";

import { isNodeObject } from "./node";
import { validateProps } from "./props";
import type { Registry } from "./registry";

/** One thing the renderer couldn't render, located by `path`. */
export interface RenderError {
  path: string;
  type: string;
}

/** Build the React element for a tree, plus the list of nodes that degraded. */
export function renderTree(
  registry: Registry,
  tree: unknown,
): { element: ReactElement | null; errors: RenderError[] } {
  const errors: RenderError[] = [];

  const element = build(registry, tree, "$", errors);

  return { element, errors };
}

/** Recursively build one node into a React element, collecting render errors. */
function build(
  registry: Registry,
  node: unknown,
  path: string,
  errors: RenderError[],
): ReactElement | null {
  // A bare string leaf becomes a text node, wrapped so the return type stays a
  // uniform ReactElement (callers get ReactElement | null, never raw strings).
  if (typeof node === "string") {
    return createElement(Fragment, { key: path }, node);
  }

  // Malformed: not a string, not a node object. Render nothing, report it.
  if (!isNodeObject(node)) {
    errors.push({ path, type: "invalid_node" });

    return null;
  }

  const def = registry.get(node.type);

  // Unknown component: nothing vetted to render. Degrade to nothing.
  if (def === undefined) {
    errors.push({ path, type: "unknown_component" });

    return null;
  }

  const { props } = validateProps(def.props, node.props ?? {});

  const childNodes: ReactNode = (node.children ?? []).map((child, index) =>
    build(registry, child, `${path}.children[${index}]`, errors),
  );

  // Contain the component's own render: a throw becomes a reported diagnostic,
  // never an exception that escapes `renderTree`.
  return safeRender(def.render, props, childNodes, path, errors);
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
