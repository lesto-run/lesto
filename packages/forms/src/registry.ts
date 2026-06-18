/**
 * A @lesto/ui Registry preloaded with the form components, so a form tree
 * validates and renders against a vetted vocabulary with no extra wiring.
 */

import { Registry } from "@lesto/ui";

import { formComponents } from "./components";

/** Build a fresh Registry containing Form, Field, and Submit. */
export function createFormRegistry(): Registry {
  const registry = new Registry();

  for (const component of formComponents()) {
    registry.define(component);
  }

  return registry;
}
