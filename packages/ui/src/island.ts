/**
 * Islands — client-hydrated regions inside an otherwise static tree.
 *
 * The premise of *auth-aware static*: a page is prerendered to HTML once, but a
 * few regions ("My Account", a cart count, a live price) must resolve on the
 * client, per-visitor, after hydration. An island is the boundary between the
 * two worlds.
 *
 * The author's experience stays uniform: an island is an ordinary `UiNode`. Its
 * `type` names a *client* component the registry knows about, and its `props`
 * are plain JSON that will cross the server -> client wire. The `island(...)`
 * helper is sugar for writing that node by hand.
 *
 * A client component is declared with `defineClient` and differs from a server
 * `ComponentDef` in three honest ways:
 *   - it carries no server `render`; the only thing the server can emit is an
 *     optional `fallback` placeholder (skeleton, last-known value, nothing);
 *   - its real implementation is a React `component`, mounted on the client;
 *   - the engine treats its `props` as a wire payload — they MUST be
 *     JSON-serializable, since a function or a class instance cannot survive the
 *     trip to the browser.
 */

import type { ComponentType, ReactNode } from "react";

import type { PropSpec, UiNode } from "./types";

/**
 * A client component: the unit an island mounts on the browser.
 *
 * `props` is an optional `PropSpec` schema, validated exactly like a server
 * component's props (required/enum/coercion all reuse the same validator).
 * `fallback` renders the server-side placeholder; absent, the island ships an
 * empty shell to be filled in on hydration.
 */
export interface ClientComponentDef {
  name: string;
  description?: string;
  props?: Record<string, PropSpec>;
  component: ComponentType<Record<string, unknown>>;
  fallback?: (props: Record<string, unknown>) => ReactNode;
}

/**
 * One hydration target: enough for ANY client runtime to find the marked DOM
 * element and mount the right component with the right props. This is the wire
 * contract between `renderPage` (server) and `hydrateIslands` (client).
 */
export interface IslandMount {
  id: string;
  component: string;
  props: Record<string, unknown>;
}

/** The attribute that marks an island's wrapper element for hydration. */
export const ISLAND_ATTR = "data-keel-island";

/**
 * Author an island node by hand-free sugar: `island("Account", { plan: "pro" })`.
 * It is exactly the `UiNode` you would have written — nothing magic, so it
 * composes as a child anywhere a node is allowed.
 */
export function island(name: string, props: Record<string, unknown> = {}): UiNode {
  return { type: name, props };
}
