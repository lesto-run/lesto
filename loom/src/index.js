// Public API barrel. Importing this registers the component library (side
// effect) and re-exports the engine surface.
import './components/index.jsx';

export * from './registry.js';
export * from './manifest.js';
export * from './render.jsx';
export * from './validate.js';
export { generate } from './generate.js';
