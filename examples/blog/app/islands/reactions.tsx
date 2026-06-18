/**
 * The Reactions island — the canonical Lesto island (ADR 0012).
 *
 *   ssr: true   → the server renders the REAL component into the shell;
 *   data        → its `counts` prop is resolved AT RENDER and inlined (0 RTT);
 *   the client `hydrateRoot`s the byte-identical markup and keeps it live.
 *
 * `Reactions` is a pure function of its props — there is no `fetch`-in-effect, so
 * no waterfall has a site to exist at. The local "👍" toggle is `useState`: it
 * does nothing until hydration, so a working toggle is the visible proof the
 * island hydrated (not just painted its server markup). Typed via review F8 —
 * `counts` is bound to `reactionsSource`, so NO cast is needed.
 */

import { useState } from "react";
import type { ReactElement } from "react";

import { defineIsland } from "@lesto/ui";

import { reactionsSource } from "../../src/reactions-source";

/** One post's like badge with a local "did I react" toggle. */
function ReactionBadge({ slug, count }: { slug: string; count: number }): ReactElement {
  const [reacted, setReacted] = useState(false);

  return (
    <button
      type="button"
      className="reaction"
      data-slug={slug}
      aria-pressed={reacted}
      onClick={() => setReacted((was) => !was)}
    >
      👍 {count + (reacted ? 1 : 0)}
    </button>
  );
}

/** A like badge per post, fed entirely by the resolved `counts` prop. */
export function Reactions({ counts }: { counts: Record<string, number> }): ReactElement {
  return (
    <p className="reactions">
      {Object.entries(counts).map(([slug, count]) => (
        <ReactionBadge key={slug} slug={slug} count={count} />
      ))}
    </p>
  );
}

/** The canonical island: server-rendered, with its data inlined at render time. */
export default defineIsland({
  name: "Reactions",
  component: Reactions,
  ssr: true,
  data: { counts: reactionsSource },
});
