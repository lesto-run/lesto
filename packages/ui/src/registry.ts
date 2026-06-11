/**
 * The registry is the vetted vocabulary: only components defined here can ever
 * appear in a rendered tree. The AI proposes; the registry disposes.
 */

import { UiError } from "./errors";
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
   *
   * The eager/lazy union is re-checked at runtime for un-typed callers: a def
   * must carry `component` or `load` (else there is nothing to ever mount), and
   * `ssr: true` demands an eager `component` (the server cannot SSR a component
   * it does not hold — a lazy island's server shell is only its fallback).
   */
  defineClient(def: ClientComponentDef): this {
    // Read the discriminant fields through a widened view: to the compiler the
    // union already forbids these states (the branches would narrow `def` to
    // `never`), but an un-typed caller can still hand us a def that violates
    // them, and a clear coded error beats a downstream undefined-component
    // crash at hydrate time.
    const declared: { component?: unknown; load?: unknown; ssr?: unknown } = def;

    if (declared.component === undefined && declared.load === undefined) {
      throw new UiError(
        "UI_CLIENT_COMPONENT_MISSING",
        `client component "${def.name}" declares neither "component" nor "load" — nothing to mount`,
        { name: def.name },
      );
    }

    if (declared.ssr === true && declared.component === undefined) {
      throw new UiError(
        "UI_CLIENT_SSR_NEEDS_COMPONENT",
        `client component "${def.name}" is ssr: true but lazy — the server cannot render a component it does not hold`,
        { name: def.name },
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
