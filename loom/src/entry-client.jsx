import { hydrateRoot } from 'react-dom/client';
import './components/index.jsx'; // register the same components used on the server
import { renderTree } from './render.jsx';

// Client entry: re-render the identical tree (embedded as window.__LOOM_TREE__)
// and hydrate the server HTML. Components are pure functions of their props with
// no Date/random, so the client tree matches the server output exactly.
const tree = window.__LOOM_TREE__;
if (tree) {
  hydrateRoot(document.getElementById('app'), renderTree(tree).element);
}
