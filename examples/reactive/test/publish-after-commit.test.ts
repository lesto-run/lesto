/**
 * The publish-after-commit ordering guard (`L-c5beede7`, ADR 0027 Phase 2).
 *
 * The reactive contract has exactly one ordering rule: a mutation publishes its
 * invalidation topic ONLY AFTER the write has committed. It is a caller convention, not a
 * framework hook — `db.transaction()` resolves after `COMMIT` (and a single-statement
 * auto-commit write resolves when it lands), so `await`ing the write IS the barrier;
 * publish on the next line. `@lesto/realtime`'s `RealtimeBus.publish` states the same rule.
 *
 * The socket-level gate (`reactive.test.ts`) drives the real app, but its in-memory store
 * is SYNCHRONOUS — the row is visible the instant it is pushed — so it cannot exercise this
 * race: a mis-ordered publish would still pass. This models an ASYNC-committing store (a
 * real DB round-trip) and pins BOTH sides of the rule:
 *
 *   - publish AFTER commit → a refetching subscriber reads its own write (read-your-writes);
 *   - publish BEFORE commit → that refetch re-caches pre-write state — the exact hazard the
 *     convention forbids.
 *
 * A regression that reorders the publish before the write's `await` flips this test red.
 */

import { describe, expect, it } from "vitest";

/** An async-committing store: `insert` resolves only once the row is visible to `read` — a
 *  stand-in for a DB write that becomes readable at `COMMIT`, one round-trip later. */
function asyncStore(): {
  read: () => readonly string[];
  insert: (row: string) => Promise<void>;
} {
  const rows: string[] = [];

  return {
    read: () => rows.slice(),
    insert: async (row) => {
      await Promise.resolve(); // the commit lands on the next microtask, not synchronously
      rows.push(row);
    },
  };
}

/** A minimal synchronous hub: `publish` invokes each subscriber inline. Inline delivery is
 *  the worst case for ordering — the refetch lands immediately, with no network latency to
 *  accidentally mask a publish that was fired before the write committed. */
function syncHub(): { subscribe: (fn: () => void) => void; publish: () => void } {
  const subs = new Set<() => void>();

  return {
    subscribe: (fn) => void subs.add(fn),
    publish: () => {
      for (const fn of subs) fn();
    },
  };
}

/**
 * Run a mutation that inserts a row and publishes its topic, in the given order, with a
 * subscriber that "refetches" (reads the store) the instant it is notified. Returns what
 * that refetch observed — i.e. whether the subscriber saw the just-written row.
 */
async function refetchAfterMutation(
  order: "publish-after-commit" | "publish-before-commit",
): Promise<readonly string[]> {
  const store = asyncStore();
  const hub = syncHub();

  let refetched: readonly string[] = [];
  hub.subscribe(() => {
    refetched = store.read();
  });

  if (order === "publish-after-commit") {
    await store.insert("hello"); // 1) the write commits...
    hub.publish(); //              2) ...THEN publish → the refetch sees it.
  } else {
    hub.publish(); //              publish BEFORE the commit → the refetch races ahead...
    await store.insert("hello"); // ...and the row lands too late to be seen.
  }

  return refetched;
}

describe("publish-after-commit ordering (ADR 0027 Phase 2)", () => {
  it("publish AFTER commit → a refetching subscriber reads its own write", async () => {
    expect(await refetchAfterMutation("publish-after-commit")).toEqual(["hello"]);
  });

  it("publish BEFORE commit → the refetch re-caches pre-write state (the race the rule forbids)", async () => {
    expect(await refetchAfterMutation("publish-before-commit")).toEqual([]);
  });
});
