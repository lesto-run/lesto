import { useState } from "react";
import type { ReactElement } from "react";

import { defineIsland } from "@lesto/ui";

/**
 * A trivial interactive island. The local `count` is exactly what Fast Refresh must
 * PRESERVE: click to increment, then edit this file (e.g. change the label below) — the
 * new code applies WITHOUT resetting the count and without a full page reload. The
 * `data-testid` is the handle the e2e drives.
 */
function Counter({ start }: { start: number }): ReactElement {
  const [count, setCount] = useState(start);

  return (
    <button type="button" data-testid="counter" onClick={() => setCount((n) => n + 1)}>
      count: {count}
    </button>
  );
}

/** Deferred island: the server paints the fallback, the Preact client mounts Counter fresh. */
export default defineIsland({
  name: "Counter",
  component: Counter,
  fallback: ({ start }: { start: number }) => (
    <button type="button" data-testid="counter">
      count: {start}
    </button>
  ),
});
