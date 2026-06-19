/**
 * The queue operator board — the canonical Lesto island (ADR 0012).
 *
 *   ssr: true   → the server renders the REAL board into the shell;
 *   data        → its `snapshot` prop is resolved AT RENDER and inlined (0 RTT);
 *   the client `hydrateRoot`s the byte-identical markup and keeps it interactive.
 *
 * The board is a pure function of its `snapshot` prop — there is no fetch-in-effect,
 * so no waterfall has a site to exist at. The interactive bit is the status-tab
 * filter: `useState` over which status to spotlight. It does nothing until
 * hydration, so a working tab is the visible proof the island hydrated (not just
 * painted its server markup). Typed via `defineIsland`'s data binding, so the JSX
 * (`<QueueBoardIsland />`) needs no `snapshot` prop and no cast.
 *
 * This island is the READ surface. The retry/discard MANAGEMENT actions are HTTP
 * routes (`POST /queue/jobs/:id/retry`, `DELETE /queue/jobs/:id`) the operator's
 * client posts to — a real deploy would wire the buttons to them; here the board
 * renders the inspectable state and the routes are proven by the HTTP tests.
 */

import { useState } from "react";
import type { ReactElement } from "react";

import { defineIsland } from "@lesto/ui";

import { dashboardSource } from "../../src/dashboard-source";
import type { QueueSnapshot } from "../../src/snapshot";

/** The lifecycle states the board offers as tabs, in operator-priority order. */
const TABS = ["failed", "running", "ready", "blocked", "done"] as const;

type Tab = (typeof TABS)[number];

/** One status tab with its live count; clicking it spotlights that status. */
function StatusTab({
  status,
  count,
  active,
  onPick,
}: {
  status: Tab;
  count: number;
  active: boolean;
  onPick: (status: Tab) => void;
}): ReactElement {
  return (
    <button
      type="button"
      className="queue-tab"
      data-status={status}
      aria-pressed={active}
      onClick={() => onPick(status)}
    >
      {status}: {count}
    </button>
  );
}

/** The whole board: tabs over the counts, a backlog line, the DLQ + throughput panels. */
export function QueueBoard({ snapshot }: { snapshot: QueueSnapshot }): ReactElement {
  // The spotlight tab. Defaults to "failed" — the status an operator opens the
  // board to look at first. Local state, so it is inert until hydration.
  const [tab, setTab] = useState<Tab>("failed");

  return (
    <section className="queue-board">
      <h1>Queue operator dashboard</h1>

      <nav className="queue-tabs">
        {TABS.map((status) => (
          <StatusTab
            key={status}
            status={status}
            count={snapshot.counts[status] ?? 0}
            active={status === tab}
            onPick={setTab}
          />
        ))}
      </nav>

      <p className="queue-backlog" data-depth={snapshot.depth}>
        backlog depth {snapshot.depth}
        {snapshot.oldestReadyAgeMs === null
          ? " (idle)"
          : ` · oldest waiting ${snapshot.oldestReadyAgeMs}ms`}
      </p>

      <p className="queue-spotlight" data-tab={tab}>
        showing {snapshot.counts[tab] ?? 0} {tab} job(s)
      </p>

      <section className="queue-dlq">
        <h2>Failed (DLQ / poison)</h2>

        {snapshot.failed.length === 0 ? (
          <p className="queue-empty">no failed jobs</p>
        ) : (
          <ul>
            {snapshot.failed.map((job) => (
              <li key={job.id} className="queue-failed" data-job-id={job.id}>
                #{job.id} {job.name} — attempt {job.attempts}/{job.maxAttempts}
                {job.lastError === null ? "" : ` — ${job.lastError}`}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="queue-throughput">
        <h2>Throughput</h2>

        <p className="queue-total-runs" data-total={snapshot.totalRuns}>
          {snapshot.totalRuns} run(s) processed
        </p>

        <ul>
          {snapshot.recentRuns.map((run, index) => (
            <li key={`${run.jobId}-${index}`} className="queue-run" data-outcome={run.outcome}>
              #{run.jobId} {run.name} → {run.outcome} ({run.durationMs}ms)
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}

/** The canonical island: server-rendered, with its snapshot inlined at render time. */
export default defineIsland({
  name: "QueueBoard",
  component: QueueBoard,
  ssr: true,
  data: { snapshot: dashboardSource },
});
