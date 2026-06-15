/**
 * A minimal, self-contained island fixture for the bundle-size assertion
 * (`scripts/bundle-size.ts`). It depends ONLY on `@keel/ui` (`defineIsland`) and
 * `react` (`useState`) — no app data sources — so the measured client bundle is
 * the framework's own runtime weight (the island + hydration + the React/Preact
 * runtime), not an example app's payload. An `ssr: true` island so the measured
 * graph includes hydration, the realistic case.
 */

import { useState } from "react";
import type { ReactElement } from "react";

import { defineIsland } from "@keel/ui";

/** A trivial interactive component: the `useState` toggle proves hydration is live. */
function Counter({ start }: { start: number }): ReactElement {
  const [n, setN] = useState(start);

  return (
    <button type="button" onClick={() => setN((value) => value + 1)}>
      count: {n}
    </button>
  );
}

export default defineIsland({
  name: "Counter",
  component: Counter,
  ssr: true,
});
