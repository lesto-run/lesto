/**
 * The reactions data source — the blog's island data binding (ADR 0010 / 0012).
 *
 * An implementation-free token: a NAME and a value TYPE, no loader. The server
 * binds the loader on the `keel()` app (`.data(reactionsSource, …)` in `app.ts`);
 * the Reactions island binds a prop to it (`app/islands/reactions.tsx`). The map
 * is post-slug → like count.
 *
 * `scope: "shared"` on purpose: the counts are the same for every visitor (not
 * per-user), so the auto-exposed `/__keel/data/reactions` route is publicly
 * cacheable-but-revalidated (`public, max-age=0, must-revalidate`) rather than
 * `no-store`. This exercises the non-default scope and its cache header — the
 * canonical island still inlines the value at render, so the route is the
 * primer/`visible` fallback tier, not the hot path here.
 */

import { defineDataSource } from "@keel/ui";

/** Post-slug → like count, the same for every visitor (shared). */
export const reactionsSource = defineDataSource<Record<string, number>>("reactions", {
  scope: "shared",
});
