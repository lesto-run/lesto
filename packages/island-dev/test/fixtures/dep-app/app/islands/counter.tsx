/**
 * A plain island: its only npm import is the framework runtime, which the dialect's
 * `optimizeDeps.include` already pre-bundles. The control in the pair.
 */

import { useState } from "react";
import type { ReactElement } from "react";

function defineIsland<T>(options: T): T {
  return options;
}

function Counter(): ReactElement {
  const [count, setCount] = useState(0);

  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}

export default defineIsland({ name: "Counter", component: Counter });
