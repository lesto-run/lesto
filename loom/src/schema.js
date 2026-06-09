// Loom's prop-schema primitives. A component declares its props with these;
// the same declaration powers THREE things at once:
//   1. runtime validation/coercion when rendering a UI tree,
//   2. the machine-readable manifest the AI reads, and
//   3. a JSON Schema that constrains the AI's output so it physically cannot
//      emit an invalid component (used as an Anthropic tool input_schema).
//
// This single-source-of-truth is what makes the engine "AI-native": the thing
// that documents a component, validates it, and bounds the model are the same.

// Validate + coerce a single value against a prop spec. Returns { ok, value, error }.
export function validateProp(spec, value) {
  if (value === undefined || value === null) {
    if (spec.required) return { ok: false, error: 'is required' };
    if ('default' in spec) return { ok: true, value: spec.default };
    return { ok: true, value: undefined };
  }

  switch (spec.type) {
    case 'string':
      return { ok: true, value: String(value) };
    case 'number': {
      const n = Number(value);
      if (Number.isNaN(n)) return { ok: false, error: `expected a number, got ${JSON.stringify(value)}` };
      return { ok: true, value: n };
    }
    case 'boolean':
      return { ok: true, value: Boolean(value) };
    case 'enum':
      if (!spec.values.includes(value)) {
        return { ok: false, error: `must be one of ${spec.values.join(', ')}` };
      }
      return { ok: true, value };
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, error: 'expected an object' };
      }
      return { ok: true, value };
    case 'array':
      if (!Array.isArray(value)) return { ok: false, error: 'expected an array' };
      return { ok: true, value };
    default:
      return { ok: true, value };
  }
}

// Validate a whole props object against a component's prop specs.
// Unknown props are dropped (safe-by-default), not errored on — the AI may
// hallucinate an extra key and we'd rather render than crash.
export function validateProps(propSpecs = {}, props = {}) {
  const out = {};
  const errors = [];
  for (const [name, spec] of Object.entries(propSpecs)) {
    const res = validateProp(spec, props[name]);
    if (!res.ok) {
      errors.push(`prop "${name}" ${res.error}`);
    } else if (res.value !== undefined) {
      out[name] = res.value;
    }
  }
  return { props: out, errors };
}

// Convert one prop spec into a JSON Schema fragment.
function propToJsonSchema(spec) {
  const base = {};
  if (spec.description) base.description = spec.description;
  switch (spec.type) {
    case 'string': return { type: 'string', ...base };
    case 'number': return { type: 'number', ...base };
    case 'boolean': return { type: 'boolean', ...base };
    case 'enum': return { type: 'string', enum: spec.values, ...base };
    case 'object': return { type: 'object', ...base };
    case 'array': return { type: 'array', ...base };
    default: return { ...base };
  }
}

// Build the JSON Schema for a single component node:
//   { type: "Button", props: {...}, children: [...] }
// `childRef` is a $ref string pointing at the recursive node schema.
export function componentNodeSchema(def, childRef) {
  const properties = {
    type: { const: def.name },
  };
  const required = ['type'];

  const propProps = {};
  const propRequired = [];
  for (const [name, spec] of Object.entries(def.props || {})) {
    propProps[name] = propToJsonSchema(spec);
    if (spec.required) propRequired.push(name);
  }
  if (Object.keys(propProps).length) {
    properties.props = {
      type: 'object',
      properties: propProps,
      ...(propRequired.length ? { required: propRequired } : {}),
      additionalProperties: false,
    };
    if (propRequired.length) required.push('props');
  }

  if (def.children) {
    properties.children = {
      type: 'array',
      items: { $ref: childRef },
    };
  }

  return {
    type: 'object',
    title: def.name,
    ...(def.description ? { description: def.description } : {}),
    properties,
    required,
    additionalProperties: false,
  };
}
