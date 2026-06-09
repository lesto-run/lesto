/** Shared guard for distinguishing a UI node object from a string leaf or junk. */

import type { UiNode } from "./types";

/** Is `value` a UiNode-shaped object (vs a string leaf, array, or null)? */
export function isNodeObject(value: unknown): value is UiNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
