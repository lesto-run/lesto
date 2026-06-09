/**
 * The registry is the vetted vocabulary: only components defined here can ever
 * appear in a rendered tree. The AI proposes; the registry disposes.
 */

import type { ComponentDef } from "./types";

/** A mutable, fluent catalog of the components the engine is allowed to render. */
export class Registry {
  // Insertion order is preserved so `all()` and the generated schema read
  // predictably, in the order a human declared them.
  private readonly byName = new Map<string, ComponentDef>();

  /** Register a component. Last definition for a name wins. Chainable. */
  define(def: ComponentDef): this {
    this.byName.set(def.name, def);

    return this;
  }

  /** Look up a component by its `type` name, or `undefined` if unknown. */
  get(name: string): ComponentDef | undefined {
    return this.byName.get(name);
  }

  /** Is this component name registered? */
  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Every registered component, in declaration order. */
  all(): ComponentDef[] {
    return [...this.byName.values()];
  }
}
