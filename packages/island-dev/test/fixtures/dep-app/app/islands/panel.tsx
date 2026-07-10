/**
 * A LAZY island with its own third-party npm import. `synthesizeEntry` reaches a lazy
 * island through a dynamic `import()`, not a static one — so this fixture is what proves
 * the dep scanner follows the entry's dynamic imports too (a lazy island's `zod` must be
 * pre-bundled in the same single optimizer pass as an eager island's).
 */

import { z } from "zod";

import type { ReactElement } from "react";

function defineIsland<T>(options: T): T {
  return options;
}

const schema = z.object({ label: z.string() });

function Panel(): ReactElement {
  return <p>{schema.parse({ label: "ok" }).label}</p>;
}

export default defineIsland({ name: "Panel", component: Panel });
