/**
 * The registry is the vetted vocabulary: only components defined here can ever
 * appear in a rendered tree. The AI proposes; the registry disposes.
 */

import type { ClientComponentDef } from "./island";
import type { ComponentDef } from "./types";

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

  /**
   * Register a server component. Last definition for a name wins. Chainable.
   * A name resolves to exactly one thing, so this shadows any client component
   * of the same name (the inverse of `defineClient`).
   */
  define(def: ComponentDef): this {
    this.byName.set(def.name, def);
    this.clientsByName.delete(def.name);

    return this;
  }

  /**
   * Register a client component — an island. Last definition for a name wins.
   * Chainable. A name may be a server component OR a client one, never both;
   * declaring a client shadows any server component of the same name and vice
   * versa, so a `type` resolves to exactly one thing.
   */
  defineClient(def: ClientComponentDef): this {
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
