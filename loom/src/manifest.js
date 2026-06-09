import { allComponents } from './registry.js';
import { componentNodeSchema } from './schema.js';

// Compile the live registry into the artifacts the AI consumes.
//
// The headline is treeJsonSchema(): a single recursive JSON Schema describing
// EVERY valid UI tree. Handed to a model as a tool's input_schema, it makes
// invalid output structurally impossible — the model can only pick registered
// component types and schema-valid props. That's the core of "AI-native".

// A recursive JSON Schema: a node is a oneOf over all registered components,
// and any component's `children` array $refs back to the same node definition.
export function treeJsonSchema() {
  const NODE = '#/$defs/node';
  const defs = {};
  const variants = [];

  for (const def of allComponents()) {
    const schema = componentNodeSchema(def, NODE);
    defs[def.name] = schema;
    variants.push({ $ref: `#/$defs/${def.name}` });
  }

  // A node may also be a bare string (text leaf).
  defs.node = { oneOf: [...variants, { type: 'string' }] };

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'LoomUITree',
    description: 'A renderable Loom UI tree. The root should be a Page component.',
    $defs: defs,
    $ref: NODE,
  };
}

// A compact, model-friendly catalog of components and their props. Useful in a
// system prompt as the "API reference" the model designs against.
export function componentCatalog() {
  return allComponents().map((c) => ({
    type: c.name,
    description: c.description,
    acceptsChildren: c.children === true ? 'any' : Array.isArray(c.children) ? c.children : false,
    props: Object.fromEntries(
      Object.entries(c.props).map(([name, spec]) => [
        name,
        {
          type: spec.type === 'enum' ? `enum(${spec.values.join('|')})` : spec.type,
          required: !!spec.required,
          ...(spec.description ? { description: spec.description } : {}),
          ...('default' in spec ? { default: spec.default } : {}),
        },
      ])
    ),
  }));
}

// A human-readable markdown reference (for docs and `loom manifest --markdown`).
export function manifestMarkdown() {
  const lines = ['# Loom Component Manifest', ''];
  for (const c of allComponents()) {
    lines.push(`## \`${c.name}\``);
    if (c.description) lines.push('', c.description);
    const ch = c.children === true ? 'any components' : Array.isArray(c.children) ? c.children.map((x) => `\`${x}\``).join(', ') : 'none';
    lines.push('', `**Accepts children:** ${ch}`, '');
    const props = Object.entries(c.props);
    if (props.length) {
      lines.push('| prop | type | required | default | description |', '|---|---|---|---|---|');
      for (const [name, s] of props) {
        const type = s.type === 'enum' ? `enum(${s.values.join(' \\| ')})` : s.type;
        lines.push(`| \`${name}\` | ${type} | ${s.required ? 'yes' : ''} | ${'default' in s ? `\`${JSON.stringify(s.default)}\`` : ''} | ${s.description || ''} |`);
      }
    } else {
      lines.push('_No props._');
    }
    lines.push('');
  }
  return lines.join('\n');
}
