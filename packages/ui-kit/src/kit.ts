/**
 * `createKit` mints a fresh `Registry` with every starter component defined.
 *
 * Each call returns its own registry — no shared mutable singleton — so an app
 * can extend its kit (define extra components, override one) without bleeding
 * into another app's vocabulary. The AI then composes against exactly what this
 * registry exposes.
 */

import { Registry } from "@lesto/ui";

import { kitComponents } from "./components";

/** A new `Registry` holding the entire starter kit, in declaration order. */
export function createKit(): Registry {
  const registry = new Registry();

  for (const component of kitComponents) {
    registry.define(component);
  }

  return registry;
}
