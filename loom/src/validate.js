import { getComponent, hasComponent, childAllowed } from './registry.js';
import { validateProps } from './schema.js';

// A pure, React-free pass over a UI tree. Used by the generation pipeline to
// (a) verify a model's output is renderable, and (b) optionally "repair" it by
// dropping invalid nodes so a single bad branch doesn't sink an otherwise good
// page. Mirrors the rules the renderer enforces at draw time.

// Returns { valid, errors, repaired }.
export function validateTree(tree) {
  const errors = [];
  const repaired = walk(tree, errors, 'root', null);
  return { valid: errors.length === 0, errors, repaired };
}

function walk(node, errors, path, parentDef) {
  if (node == null) return null;
  if (typeof node === 'string' || typeof node === 'number') return node;

  if (typeof node !== 'object' || !node.type) {
    errors.push({ path, type: 'malformed', detail: 'node is not an object with a `type`' });
    return null;
  }

  if (!hasComponent(node.type)) {
    errors.push({ path, type: 'unknown-component', component: node.type });
    return null;
  }

  const def = getComponent(node.type);

  if (parentDef && !childAllowed(parentDef, node.type)) {
    errors.push({ path, type: 'disallowed-child', parent: parentDef.name, child: node.type });
    return null;
  }

  const { props, errors: propErrors } = validateProps(def.props, node.props || {});
  for (const e of propErrors) {
    errors.push({ path, type: 'invalid-prop', component: node.type, detail: e });
  }
  // Drop the node only if a required prop is missing.
  if (propErrors.some((e) => e.includes('is required'))) return null;

  const out = { type: node.type };
  if (Object.keys(props).length) out.props = props;

  if (def.children && Array.isArray(node.children)) {
    out.children = node.children
      .map((c, i) => walk(c, errors, `${path}.children[${i}]`, def))
      .filter((c) => c !== null);
  }
  return out;
}
