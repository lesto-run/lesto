/**
 * A minimal, self-contained island fixture for the bundle-size assertion
 * (`scripts/bundle-size.ts`). It depends ONLY on `@volo/ui` (`defineIsland`) and
 * `react` (`useState`) — no app data sources — so the measured client bundle is
 * the framework's own runtime weight (the island + hydration + the React/Preact
 * runtime), not an example app's payload. The island is DEFERRED (`ssr: false`,
 * the default): the measured CLIENT bundle — component + mount/hydration runtime
 * + the React/Preact runtime — is identical whether the island is deferred or
 * `ssr: true`, and deferred is the dialect-agnostic case BOTH dialects build (an
 * `ssr: true` island under `preact` is a coded build error — it needs the
 * whole-process-aliased server, not the CLI's React server).
 */

import { useState } from "react";
import type { ReactElement } from "react";

import { defineIsland } from "@volo/ui";

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
});
