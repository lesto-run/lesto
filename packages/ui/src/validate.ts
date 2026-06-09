/**
 * Pure, React-free validation of a UI tree against the registry.
 *
 * It walks the tree and reports, with a JSON-pointer-ish `path` for each issue:
 *   - an unknown component type
 *   - a missing required prop
 *   - a child that the parent's `ChildrenPolicy` forbids
 *
 * It never renders and never throws — it returns a verdict the caller acts on.
 */

import { isNodeObject } from "./node";
import { validateProps } from "./props";
import type { Registry } from "./registry";
import type { ChildrenPolicy } from "./types";

/** One thing wrong with the tree, located by `path`. */
export interface TreeError {
  path: string;
  type: string;
  detail?: string;
}

/** Does `policy` permit a child of component type `childType`? */
function allowsChild(policy: ChildrenPolicy, childType: string): boolean {
  // `true` = any registered component; `false` = none; a list = only its members.
  if (policy === true) return true;

  if (policy === false) return false;

  return policy.includes(childType);
}

/** Validate a tree. Pure: no throws, no React. */
export function validateTree(
  registry: Registry,
  tree: unknown,
): { valid: boolean; errors: TreeError[] } {
  const errors: TreeError[] = [];

  walk(registry, tree, "$", errors);

  return { valid: errors.length === 0, errors };
}

/** Recursively check one node and its children, appending to `errors`. */
function walk(registry: Registry, node: unknown, path: string, errors: TreeError[]): void {
  // A bare string is always a valid text leaf — nothing to check.
  if (typeof node === "string") return;

  // Anything else that isn't a node object is malformed.
  if (!isNodeObject(node)) {
    errors.push({ path, type: "invalid_node", detail: "node must be a string or an object" });

    return;
  }

  const def = registry.get(node.type);

  // Unknown component: we can't validate props or children against nothing.
  if (def === undefined) {
    errors.push({ path, type: "unknown_component", detail: node.type });

    return;
  }

  // Required props, via the shared validator (enum/required rules live there).
  const { errors: propErrors } = validateProps(def.props, node.props ?? {});

  for (const detail of propErrors) {
    errors.push({ path, type: "invalid_props", detail });
  }

  const children = node.children ?? [];

  for (const [index, child] of children.entries()) {
    const childPath = `${path}.children[${index}]`;

    // A non-string child must be an allowed component type for this parent.
    if (isNodeObject(child) && !allowsChild(def.children, child.type)) {
      errors.push({ path: childPath, type: "disallowed_child", detail: child.type });
    }

    walk(registry, child, childPath, errors);
  }
}
