/**
 * The dashboard data source — the board island's data binding (ADR 0010 / 0012).
 *
 * An implementation-free token: a NAME and a value TYPE ({@link QueueSnapshot}),
 * no loader. The server binds the loader on the `lesto()` app
 * (`.data(dashboardSource, …)` in `app.ts`); the board island binds its `snapshot`
 * prop to it (`app/islands/queue-board.tsx`).
 *
 * `scope: "shared"` on purpose: the queue's state is the same for every operator
 * (it is not per-user), so the auto-exposed `/__lesto/data/queue` route is
 * publicly cacheable-but-revalidated rather than `no-store` — an operator's
 * browser can poll it cheaply. The canonical island still inlines the value at
 * render, so the route is the refresh/poll tier, not the first paint.
 */

import { defineDataSource } from "@lesto/ui";

import type { QueueSnapshot } from "./snapshot";

/** The live queue snapshot, the same for every operator (shared). */
export const dashboardSource = defineDataSource<QueueSnapshot>("queue", {
  scope: "shared",
});
