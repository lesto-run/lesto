import React from 'react';
import { getComponent, hasComponent, childAllowed } from './registry.js';
import { validateProps } from './schema.js';

// Turn a Loom UI tree (plain JSON) into a real React element tree.
//
//   render({ type: 'Page', children: [ { type: 'Hero', props: {...} } ] })
//
// Every node is validated against the registry as it's rendered. Invalid or
// unknown nodes degrade gracefully instead of throwing: in dev they render a
// visible diagnostic, in production they render nothing. One bad node never
// takes down the page.

const isDev = (typeof process !== 'undefined' && process.env && process.env.NODE_ENV !== 'production');

// A per-node error boundary so a component that throws at runtime is contained.
class NodeBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return isDev ? <Diagnostic kind="threw" detail={`<${this.props.type}> threw: ${this.state.error.message}`} /> : null;
    }
    return this.props.children;
  }
}

function Diagnostic({ kind, detail }) {
  return (
    <div style={{
      border: '1px dashed #ef4444', background: '#fef2f2', color: '#991b1b',
      borderRadius: 8, padding: '8px 12px', font: '13px ui-monospace, monospace', margin: '4px 0',
    }} data-loom-error={kind}>⚠ {detail}</div>
  );
}

// Render a list of children, collecting any structural warnings.
function renderChildren(parentDef, children, ctx, keyPrefix) {
  if (!Array.isArray(children)) return null;
  return children.map((child, i) => renderNode(child, ctx, `${keyPrefix}.${i}`, parentDef));
}

// The core recursive renderer. `parentDef` (when present) lets us enforce
// allowed-children rules declared by the parent component.
export function renderNode(node, ctx = {}, key = '0', parentDef = null) {
  // Text/number leaves are allowed anywhere.
  if (node == null) return null;
  if (typeof node === 'string' || typeof node === 'number') return node;

  if (typeof node !== 'object' || !node.type) {
    return isDev ? <Diagnostic key={key} kind="malformed" detail={`malformed node: ${JSON.stringify(node).slice(0, 80)}`} /> : null;
  }

  const { type } = node;

  if (!hasComponent(type)) {
    if (ctx.onError) ctx.onError({ type: 'unknown-component', component: type });
    return isDev ? <Diagnostic key={key} kind="unknown" detail={`unknown component <${type}>`} /> : null;
  }

  const def = getComponent(type);

  // Enforce the parent's children policy (e.g. PricingTier accepts no children).
  if (parentDef && !childAllowed(parentDef, type)) {
    if (parentDef.children === false) {
      if (ctx.onError) ctx.onError({ type: 'unexpected-child', parent: parentDef.name, child: type });
      return isDev ? <Diagnostic key={key} kind="child" detail={`<${parentDef.name}> does not accept children`} /> : null;
    }
    if (ctx.onError) ctx.onError({ type: 'disallowed-child', parent: parentDef.name, child: type });
    return isDev ? <Diagnostic key={key} kind="child" detail={`<${type}> not allowed inside <${parentDef.name}>`} /> : null;
  }

  // Validate + coerce props against the component's schema.
  const { props, errors } = validateProps(def.props, node.props || {});
  if (errors.length && ctx.onError) {
    ctx.onError({ type: 'invalid-props', component: type, errors });
  }
  // A missing *required* prop is the one prop error we won't render through.
  const hasFatalPropError = errors.some((e) => e.includes('is required'));
  if (hasFatalPropError) {
    return isDev ? <Diagnostic key={key} kind="props" detail={`<${type}>: ${errors.join('; ')}`} /> : null;
  }

  const children = def.children ? renderChildren(def, node.children, ctx, key) : null;

  let rendered;
  try {
    rendered = def.render(props, children, ctx);
  } catch (err) {
    if (ctx.onError) ctx.onError({ type: 'render-threw', component: type, message: err.message });
    return isDev ? <Diagnostic key={key} kind="threw" detail={`<${type}> threw: ${err.message}`} /> : null;
  }

  return <NodeBoundary key={key} type={type}>{rendered}</NodeBoundary>;
}

// Public entry: render a whole tree. Returns { element, errors }.
export function renderTree(tree, options = {}) {
  const errors = [];
  const ctx = { ...options.ctx, onError: (e) => errors.push(e) };
  const element = renderNode(tree, ctx, 'root');
  return { element, errors };
}

// Convenience React component: <LoomTree tree={...} />
export function LoomTree({ tree, ctx }) {
  return renderTree(tree, { ctx }).element;
}
