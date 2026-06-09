/**
 * The model-facing description of the registry.
 *
 * `treeJsonSchema` emits a JSON Schema an AI can be constrained to: a UI node is
 * either a bare string (a text leaf) or one of the registered components — a
 * `oneOf` whose variants pin `type` to a const and recursively allow children
 * back at the same node definition. `componentCatalog` is the friendlier prose
 * summary for a model's system prompt.
 */

import { UiError } from "./errors";
import type { Registry } from "./registry";
import type { ChildrenPolicy, ComponentDef, PropSpec, PropType } from "./types";

/** Map a `PropType` to the JSON Schema fragment that describes it. */
function propSchema(spec: PropSpec): Record<string, unknown> {
  const base = jsonTypeFor(spec.type, spec);

  // Carry the human description through to the model when present.
  return spec.description === undefined ? base : { ...base, description: spec.description };
}

/** The bare JSON Schema type fragment for a prop, before description is added. */
function jsonTypeFor(type: PropType, spec: PropSpec): Record<string, unknown> {
  if (type === "enum") {
    // An enum without values is unbuildable: we'd emit a schema that admits
    // nothing. Refuse loudly so the registry author fixes the spec.
    if (spec.values === undefined) {
      throw new UiError("UI_INVALID_ENUM_SPEC", "enum prop spec has no values", {
        type,
      });
    }

    return { type: "string", enum: [...spec.values] };
  }

  if (type === "object") return { type: "object" };

  if (type === "array") return { type: "array" };

  // string / number / boolean map straight across.
  return { type };
}

/** The `properties` + `required` shape for one component's props. */
function propsObjectSchema(specs: Record<string, PropSpec>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  const required: string[] = [];

  for (const [name, spec] of Object.entries(specs)) {
    properties[name] = propSchema(spec);

    if (spec.required === true) required.push(name);
  }

  // Only attach `required` when there is something to require — a cleaner schema.
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required }),
  };
}

/**
 * Does a component accept children at all?
 *
 * `true` admits any registered component; a non-empty allow-list admits only its
 * members; `false` (and the degenerate empty list) is a leaf. The schema mirrors
 * the runtime `validateTree` policy exactly — leaves get no `children` property,
 * so the model is constrained no more loosely than the validator enforces.
 */
function acceptsChildren(policy: ChildrenPolicy): boolean {
  if (policy === true) return true;

  if (policy === false) return false;

  return policy.length > 0;
}

/**
 * The recursive JSON Schema for a whole UI tree rooted at `#/$defs/node`.
 *
 * A node is a string leaf OR any one registered component. Each component
 * variant fixes `type` to its name and describes its props. A component that
 * accepts children also gets a `children` array that `$ref`s back at the node
 * def — so the tree nests arbitrarily; a leaf omits `children` entirely.
 */
export function treeJsonSchema(registry: Registry): object {
  const nodeRef = { $ref: "#/$defs/node" };

  const variants = registry.all().map((def) => ({
    type: "object",
    properties: {
      type: { const: def.name },
      props: propsObjectSchema(def.props),

      // Only children-accepting components advertise a `children` array; leaves
      // omit it so the schema is as strict as the runtime policy.
      ...(acceptsChildren(def.children) ? { children: { type: "array", items: nodeRef } } : {}),
    },
    required: ["type"],
    additionalProperties: false,
  }));

  // A bare string is the universal text leaf.
  const stringLeaf = { type: "string" };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: "#/$defs/node",
    $defs: {
      node: { oneOf: [stringLeaf, ...variants] },
    },
  };
}

/** A compact, model-friendly summary of every component in the registry. */
export function componentCatalog(registry: Registry): object[] {
  return registry.all().map(catalogEntry);
}

/** One component's entry in the catalog — only the fields that carry information. */
function catalogEntry(def: ComponentDef): Record<string, unknown> {
  const props = Object.fromEntries(
    Object.entries(def.props).map(([name, spec]) => [name, catalogProp(spec)]),
  );

  return {
    name: def.name,
    children: def.children,
    props,
    ...(def.description === undefined ? {} : { description: def.description }),
  };
}

/** One prop's entry in the catalog — only the fields that carry information. */
function catalogProp(spec: PropSpec): Record<string, unknown> {
  return {
    type: spec.type,
    ...(spec.required === true ? { required: true } : {}),
    ...(spec.values === undefined ? {} : { values: [...spec.values] }),
    ...(spec.default === undefined ? {} : { default: spec.default }),
    ...(spec.description === undefined ? {} : { description: spec.description }),
  };
}
