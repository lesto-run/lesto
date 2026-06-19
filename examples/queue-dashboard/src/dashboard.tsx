/**
 * The dashboard page — a plain React component.
 *
 * The `.page` renderer runs no loader for this page (its data comes from the
 * island's `dashboardSource` binding, resolved at render), wraps the component in
 * the app's layouts, and streams the whole `<html>` document. The page itself is
 * a thin shell around the board island — the island carries the live snapshot.
 *
 * `<QueueBoardIsland />` is the canonical island (ADR 0012): an `ssr: true` island
 * whose `snapshot` data is resolved at render and inlined. It takes no props here —
 * its only prop (`snapshot`) is supplied by the framework from `dashboardSource`,
 * which the typed `defineIsland` reflects, so the JSX needs no `snapshot`.
 */

import type { ReactElement } from "react";

import QueueBoardIsland from "../app/islands/queue-board";

export function DashboardPage(): ReactElement {
  return (
    <main className="dashboard">
      <QueueBoardIsland />
    </main>
  );
}
