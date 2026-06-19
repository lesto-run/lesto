/**
 * The model-facing description of the registry.
 *
 * `treeJsonSchema` emits a JSON Schema an AI can be constrained to: a UI node is
 * either a bare string (a text leaf) or one of the registered components — a
 * `oneOf` whose variants each pin `type` to a const and describe their props.
 * Each variant lives in its own `#/$defs/<name>` entry so a children allow-list
 * can `$ref` exactly the components it permits — the children narrowing mirrors
 * the runtime `validateTree` `allowsChild` policy, no looser. `componentCatalog`
 * is the friendlier prose summary for a model's system prompt.
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

/** Does any of a component's props carry `required: true`? */
function hasRequiredProp(specs: Record<string, PropSpec>): boolean {
  return Object.values(specs).some((spec) => spec.required === true);
}

/**
 * Does a component accept children at all?
 *
 * `true` admits any registered component; a non-empty allow-list admits only its
 * members; `false` (and the degenerate empty list) is a leaf. Leaves get no
 * `children` property, so the model is constrained no more loosely than the
 * validator's missing/forbidden-child checks enforce.
 */
function acceptsChildren(policy: ChildrenPolicy): boolean {
  if (policy === true) return true;

  if (policy === false) return false;

  return policy.length > 0;
}

/** A bare string is the universal text leaf — valid as a child of ANY parent. */
const stringLeaf = { type: "string" };

/**
 * The `#/$defs/<name>` ref for one component variant.
 *
 * Component names are opaque strings, so the name is JSON-Pointer-escaped
 * (`~` → `~0`, `/` → `~1`, in that order) before it goes into the ref — the def
 * itself is keyed by the raw name (object keys are unrestricted), but a `$ref`
 * is a JSON Pointer and must encode those two characters to resolve.
 */
function componentRef(name: string): { $ref: string } {
  const pointer = name.replaceAll("~", "~0").replaceAll("/", "~1");

  return { $ref: `#/$defs/${pointer}` };
}

/**
 * The `items` schema for a children-accepting component, mirroring `allowsChild`.
 *
 *   - `policy === true`  → the full node union (any string leaf or component).
 *   - allow-list `[A,B]` → ONLY the named variants, plus the string leaf.
 *
 * The allow-list case is the correctness pin: `validateTree`'s `allowsChild`
 * only consults the list for *node objects* (`isNodeObject(child)`), so a bare
 * string leaf is always permitted and a component child must be a list member.
 * We mirror that exactly — `oneOf: [stringLeaf, ...refs to listed components]` —
 * so a tree the runtime would reject for a disallowed child cannot pass the
 * schema either. A listed name with no registered `$def` can never be satisfied
 * (the runtime flags it `unknown_component`), so we drop it rather than emit a
 * dangling `$ref`; the admitted set stays exactly what `allowsChild` *and*
 * `validateTree` together accept.
 */
function childItemsSchema(policy: ChildrenPolicy, registered: ReadonlySet<string>): object {
  // `true`: any node. Keep the full union ref so the tree nests arbitrarily.
  // (Only ever called for children-accepting policies, so `false` never lands
  // here — but a list is the only other shape, so we narrow on that.)
  if (!Array.isArray(policy)) return { $ref: "#/$defs/node" };

  const allowed = policy.filter((name) => registered.has(name)).map(componentRef);

  // A string child is always allowed (allowsChild is guarded by isNodeObject),
  // so the leaf is a member alongside each listed, registered component.
  return { oneOf: [stringLeaf, ...allowed] };
}

/** The full JSON Schema fragment for one component variant. */
function componentVariant(def: ComponentDef, registered: ReadonlySet<string>): object {
  return {
    type: "object",
    properties: {
      type: { const: def.name },
      props: propsObjectSchema(def.props),

      // Only children-accepting components advertise a `children` array; leaves
      // omit it so the schema is as strict as the runtime policy. The `items`
      // schema is narrowed to the allow-list when there is one (see
      // `childItemsSchema`) so the schema matches `allowsChild` exactly.
      ...(acceptsChildren(def.children)
        ? { children: { type: "array", items: childItemsSchema(def.children, registered) } }
        : {}),
    },
    // A component with required props must require the `props` object itself —
    // otherwise the nested `props.required` never bites (a model could omit
    // `props` wholesale, passing the schema yet failing `validateTree`'s
    // missing-required-prop check). The two must agree, so require `props` here.
    required: hasRequiredProp(def.props) ? ["type", "props"] : ["type"],
    additionalProperties: false,
  };
}

/**
 * The recursive JSON Schema for a whole UI tree rooted at `#/$defs/node`.
 *
 * A node is a string leaf OR any one registered component. Each component gets
 * its own `#/$defs/<name>` entry (so an allow-list can `$ref` individual
 * variants); the `node` def is the `oneOf` of the string leaf and every variant.
 * A component that accepts children also gets a `children` array whose `items`
 * mirror the runtime `allowsChild` policy: the full node union for `children:
 * true`, or a `oneOf` of just the allowed variants (plus the string leaf) for an
 * allow-list — so a tree `validateTree` rejects for a disallowed child cannot
 * pass the emitted schema either. A leaf omits `children` entirely.
 */
export function treeJsonSchema(registry: Registry): object {
  const defs = registry.all();

  const registered = new Set(defs.map((def) => def.name));

  // One `$def` per component so an allow-list `oneOf` can reference individual
  // variants by name; the `node` union refs them all (plus the string leaf).
  const componentDefs: Record<string, object> = {};

  for (const def of defs) {
    componentDefs[def.name] = componentVariant(def, registered);
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $ref: "#/$defs/node",
    $defs: {
      node: { oneOf: [stringLeaf, ...defs.map((def) => componentRef(def.name))] },
      ...componentDefs,
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
