/**
 * The registry is the vetted vocabulary: only components defined here can ever
 * appear in a rendered tree. The AI proposes; the registry disposes.
 */

import { assertClientDef } from "./island";
import type { ClientComponentDef } from "./island";
import type { ComponentDef } from "./types";

/**
 * Where a cross-namespace shadowing warning goes. A name resolves to exactly ONE
 * thing, so registering a server component over an existing client one of the
 * same name (or vice versa) silently changes which side of the wire that `type`
 * lives on — a likely copy-paste/rename slip, not an intent. We warn (never
 * throw: last-write-wins is a legitimate redefinition) so the slip is loud.
 * Injectable, defaulting to `console.warn`, so the warning is asserted in a test
 * without spying on the global (the codebase's seam-not-global pattern).
 */
export type ShadowWarn = (message: string) => void;

const consoleShadowWarn: ShadowWarn = (message) => console.warn(`[lesto/ui] ${message}`);

/**
 * A mutable, fluent catalog of the components the engine is allowed to render.
 *
 * Two flavors live side by side: ordinary server components (`define`) that
 * render to HTML in place, and *client* components (`defineClient`) that mark an
 * island — a region the server stubs out and the browser later hydrates. Both
 * share one namespace, because at the authoring layer an island is just another
 * node `type`; the registry is what remembers which side of the wire it belongs
 * to.
 */
export class Registry {
  // Insertion order is preserved so `all()` and the generated schema read
  // predictably, in the order a human declared them.
  private readonly byName = new Map<string, ComponentDef>();

  private readonly clientsByName = new Map<string, ClientComponentDef>();

  private readonly warn: ShadowWarn;

  /**
   * @param warn where a cross-namespace shadowing warning goes (default
   * `console.warn`). Injectable so a test asserts the warning without spying on
   * the global; an app rarely sets it.
   */
  constructor(warn: ShadowWarn = consoleShadowWarn) {
    this.warn = warn;
  }

  /**
   * Register a server component. Last definition for a name wins. Chainable.
   * A name resolves to exactly one thing, so this shadows any client component
   * of the same name (the inverse of `defineClient`) — and warns when it does,
   * since flipping a `type` from an island to a server component is almost
   * always a rename/copy-paste slip, not intent.
   */
  define(def: ComponentDef): this {
    if (this.clientsByName.has(def.name)) {
      this.warn(
        `server component "${def.name}" shadows a client component of the same name — ` +
          `a name resolves to one thing, so the island is no longer reachable`,
      );
    }

    this.byName.set(def.name, def);
    this.clientsByName.delete(def.name);

    return this;
  }

  /**
   * Register a client component — an island. Last definition for a name wins.
   * Chainable. A name may be a server component OR a client one, never both;
   * declaring a client shadows any server component of the same name and vice
   * versa, so a `type` resolves to exactly one thing — and warns when it crosses
   * the namespace, the same loud-when-likely-wrong as {@link define}.
   *
   * The eager/lazy union is re-checked at runtime for un-typed callers via the
   * shared {@link assertClientDef} (the rule lives once, so this path and the
   * `.page` `defineIsland` path refuse identical broken unions identically).
   *
   * The parameter is the ERASED {@link ClientComponentDef}, ON PURPOSE — the
   * item-9/F8 phantom-type deferral (ADR 0012) is resolved here by *decision*,
   * not by faking generics: the typed island authoring path is `defineIsland`
   * (whose `IslandDef<P, D>` links each `DataSource<P[K]>` to the component's
   * props and narrows the returned component to the unbound remainder). The
   * Registry is the DB-/AI-content niche the manifest path now serves (ADR 0011
   * Increment 2): its storage is a `Map<string, ClientComponentDef>` and its
   * consumers (the `UiNode` walk, `getClient(name)`) are stringly by their nature
   * — a `type` is a JSON string the model emitted — so a prop/data generic on
   * this method would be cosmetic, erased the instant the def enters the map.
   * `Island.island` (a `ClientComponentDef`) flows straight in; the type safety
   * already happened at `defineIsland`.
   */
  defineClient(def: ClientComponentDef): this {
    assertClientDef(def);

    if (this.byName.has(def.name)) {
      this.warn(
        `client component "${def.name}" shadows a server component of the same name — ` +
          `a name resolves to one thing, so the server component is no longer reachable`,
      );
    }

    this.clientsByName.set(def.name, def);
    this.byName.delete(def.name);

    return this;
  }

  /** Look up a server component by its `type` name, or `undefined` if unknown. */
  get(name: string): ComponentDef | undefined {
    return this.byName.get(name);
  }

  /** Look up a client component (island) by name, or `undefined` if unknown. */
  getClient(name: string): ClientComponentDef | undefined {
    return this.clientsByName.get(name);
  }

  /** Is this name a registered server component? */
  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Is this name a registered client component (island)? */
  hasClient(name: string): boolean {
    return this.clientsByName.has(name);
  }

  /** Every registered server component, in declaration order. */
  all(): ComponentDef[] {
    return [...this.byName.values()];
  }

  /** Every registered client component (island), in declaration order. */
  clients(): ClientComponentDef[] {
    return [...this.clientsByName.values()];
  }
}
