import { renderToString } from 'react-dom/server';
import './components/index.jsx'; // register components
import { renderTree } from './render.jsx';

// SSR entry: a UI tree (plain JSON) → HTML string. Called by server.js (dev)
// and by `loom render` / `loom build` (static). No model, no I/O — just the
// renderer over a saved artifact, which is why it's fast and cacheable.
export function render(tree) {
  const { element, errors } = renderTree(tree);
  return { html: renderToString(element), errors };
}
