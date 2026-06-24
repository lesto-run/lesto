/**
 * A faithful island SHAPE for the Fast-Refresh transform test: a local stateful
 * component wrapped in a `defineIsland({...})` call as the default export — exactly
 * how a real Lesto island is authored (`export default defineIsland(...)`). The
 * factory is stubbed locally so the fixture needs only `react`; what we are testing
 * is whether `@vitejs/plugin-react` treats a `default export = <factory call>` module
 * as a refresh BOUNDARY (state preserved) rather than a reload-propagating module —
 * a STATIC decision that does not depend on what the factory actually returns.
 */

import { useState } from "react";
import type { ReactElement } from "react";

interface IslandOptions {
  name: string;
  component: () => ReactElement;
}

function defineIsland(options: IslandOptions): () => ReactElement {
  return options.component;
}

function Counter(): ReactElement {
  const [count, setCount] = useState(0);

  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}

export default defineIsland({ name: "Counter", component: Counter });
