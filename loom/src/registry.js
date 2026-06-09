// The component registry — the closed set of components the AI is allowed to
// use. A component is { name, description, props, children, render }. Nothing
// outside the registry can ever be rendered from a UI tree, which is the whole
// safety model: the AI composes from vetted primitives, never arbitrary code.

const components = new Map();

// defineComponent('Button', {
//   description: 'A call-to-action button.',
//   props: { label: { type: 'string', required: true }, ... },
//   children: false,            // false | true (any) | [allowedTypeNames]
//   render: (props, children, ctx) => <button>...</button>,
// })
export function defineComponent(name, def) {
  if (!name || typeof name !== 'string') throw new Error('Component name must be a string');
  if (typeof def.render !== 'function') throw new Error(`Component "${name}" needs a render() function`);
  components.set(name, {
    name,
    description: def.description || '',
    props: def.props || {},
    children: def.children ?? false,
    render: def.render,
  });
  return name;
}

export function getComponent(name) {
  return components.get(name);
}

export function hasComponent(name) {
  return components.has(name);
}

export function allComponents() {
  return [...components.values()];
}

export function componentNames() {
  return [...components.keys()];
}

// Test/util helper — wipe the registry (used so tests start clean).
export function resetRegistry() {
  components.clear();
}

// Is `childType` allowed inside `parentName`?
export function childAllowed(parentDef, childType) {
  if (parentDef.children === true) return true;
  if (Array.isArray(parentDef.children)) return parentDef.children.includes(childType);
  return false;
}
