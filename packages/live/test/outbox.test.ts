import Database from "better-sqlite3";
import { adaptSyncSqlite } from "@lesto/db";
import type { SqlDatabase } from "@lesto/db";
import type { ShapeChange, ShapeDefinition } from "@lesto/live-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLiveMutations,
  createLiveStore,
  createSqliteLiveStore,
  DEFAULT_GRACE_MS,
} from "../src/index";
import type { MutationOutcome, ScheduleGrace } from "../src/index";

// The same `rank`-ordered shape the store tests use, so `getRows()` assertions read the merged
// (authorized + optimistic overlay) view in the shape's total order.
const def: ShapeDefinition = {
  table: "posts",
  key: "id",
  columns: ["id", "rank"],
  where: [],
  orderBy: { column: "rank", direction: "asc" },
};

const insert = (key: string, rank: number): ShapeChange => ({
  op: "insert",
  key,
  row: { id: key, rank },
});

const update = (key: string, rank: number): ShapeChange => ({
  op: "update",
  key,
  row: { id: key, rank },
});

/** A deterministic id generator so a test can name the entries it submits. */
function seqId(prefix = "m"): () => string {
  let n = 0;

  return () => `${prefix}${++n}`;
}

/**
 * A controllable {@link MutationSubmitter} fake: it records every replayed `(name, input)` and
 * returns the next scripted outcome (defaulting to `"ok"` once the script is exhausted). `set`
 * reprograms the outcome mid-test — e.g. flip `"retry"` (offline) → `"ok"` (reconnected).
 */
function fakeSubmitter(script: MutationOutcome[] = []) {
  const calls: Array<{ name: string; input: unknown }> = [];
  let outcome: MutationOutcome | undefined;

  const submit = vi.fn(async (name: string, input: unknown): Promise<MutationOutcome> => {
    calls.push({ name, input });

    return script.shift() ?? outcome ?? "ok";
  });

  return {
    submit,
    calls,
    set: (next: MutationOutcome) => {
      outcome = next;
    },
  };
}

/**
 * A controllable {@link ScheduleGrace}: it captures every armed grace callback instead of using a
 * real timer, so a test fires them deterministically via `fireAll` — or never, to assert the echo
 * won the hold-vs-grace race.
 */
function fakeSchedule() {
  const pending: Array<() => void> = [];

  const schedule: ScheduleGrace = (cb) => {
    pending.push(cb);
  };

  return {
    schedule,
    fireAll: () => {
      for (const cb of pending.splice(0)) cb();
    },
  };
}

// A real `SqlDatabase` over better-sqlite3 (the survives-reload tests need genuine persistence),
// tracked for teardown — identical fixture to `sqlite-store.test.ts`.
const opened: Array<() => void> = [];

afterEach(() => {
  for (const close of opened.splice(0)) close();
});

function freshDb(): SqlDatabase {
  const raw = new Database(":memory:");

  opened.push(() => raw.close());

  return adaptSyncSqlite({
    exec: async (sql) => {
      raw.exec(sql);
    },
    prepare: (sql) => {
      const stmt = raw.prepare(sql);

      return {
        run: async (params = []) => stmt.run(...params),
        get: async (params = []) => stmt.get(...params) ?? undefined,
        all: async (params = []) => stmt.all(...params) as unknown[],
      };
    },
  });
}

describe("createLiveMutations — optimistic offline writes (Inc6)", () => {
  it("applies a write optimistically and, online, drains it — held (shown) until its echo lands", async () => {
    const store = createLiveStore(def);
    store.applySnapshot([{ id: "a", rank: 1 }]);
    const seam = fakeSubmitter();
    const { schedule } = fakeSchedule();
    const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId(), schedule });

    const { id } = mutations.submit({
      name: "addPost",
      input: { text: "b" },
      optimistic: insert("b", 2),
    });

    // Shown the instant it is made — before any network round-trip settles.
    expect(id).toBe("m1");
    expect(store.getRows()).toEqual([
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ]);

    await mutations.flush();

    // Replayed as the app's own mutation POST (name + input verbatim), then ACKED. The optimistic row
    // is NOT cleared on ack — it is HELD (still shown), so there is no read-your-writes flash in the
    // window before the authoritative echo lands (`L-436724ba`).
    expect(seam.calls).toEqual([{ name: "addPost", input: { text: "b" } }]);
    expect(mutations.pending()).toBe(0); // held, not pending
    expect(store.getRows()).toEqual([
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ]);

    // The authoritative echo (same key) lands over the wire → the held entry clears atomically, and
    // `b` is now sourced from the authorized set. No frame ever dropped it.
    store.applyChange(insert("b", 2));
    expect(store.getRows()).toEqual([
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ]);
  });

  it("a flush over an empty queue does not wedge later drains (the startup-flush path)", async () => {
    // The app flushes on startup / on every `online` event, often with nothing pending — a drain
    // that settles synchronously. A later submit MUST still drain: if the empty flush latched its
    // (resolved) promise as the re-entry guard, this submit would silently never send.
    const store = createLiveStore(def);
    const seam = fakeSubmitter();
    const { schedule } = fakeSchedule();
    const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId(), schedule });

    await mutations.flush(); // empty — completes synchronously
    expect(seam.calls).toEqual([]);

    mutations.submit({ name: "addPost", input: { text: "b" }, optimistic: insert("b", 2) });
    await mutations.flush();

    expect(seam.calls).toEqual([{ name: "addPost", input: { text: "b" } }]);
    expect(mutations.pending()).toBe(0);
  });

  it("a server-rejected write rolls back locally", async () => {
    const store = createLiveStore(def);
    store.applySnapshot([{ id: "a", rank: 1 }]);
    const seam = fakeSubmitter(["rejected"]);
    const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId() });

    mutations.submit({ name: "addPost", input: { text: "b" }, optimistic: insert("b", 2) });
    expect(store.getRows()).toEqual([
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ]);

    await mutations.flush();

    // Rejected → the optimistic row is gone immediately (not held) and nothing is left queued
    // (replaying it would only be refused again). The authorized row (never edited) shows through.
    expect(mutations.pending()).toBe(0);
    expect(store.getRows()).toEqual([{ id: "a", rank: 1 }]);
  });

  it("an offline write stays optimistic and pending until a later flush succeeds", async () => {
    const store = createLiveStore(def);
    const seam = fakeSubmitter();
    seam.set("retry"); // offline: every submit fails transport
    const { schedule } = fakeSchedule();
    const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId(), schedule });

    mutations.submit({ name: "addPost", input: { text: "b" }, optimistic: insert("b", 2) });
    await mutations.flush();

    // Still shown, still queued — the write is not lost, just not yet reconciled.
    expect(store.getRows()).toEqual([{ id: "b", rank: 2 }]);
    expect(mutations.pending()).toBe(1);

    // Reconnect: the next flush drains it → acked → HELD (still shown, no longer queued), awaiting
    // its echo.
    seam.set("ok");
    await mutations.flush();
    expect(mutations.pending()).toBe(0);
    expect(store.getRows()).toEqual([{ id: "b", rank: 2 }]);
  });

  it("drains in submission order and stops at the first retry, preserving order", async () => {
    const store = createLiveStore(def);
    // First entry ok, second retry → the third must NOT be attempted (FIFO, no reordering).
    const seam = fakeSubmitter(["ok", "retry"]);
    const { schedule } = fakeSchedule();
    const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId(), schedule });

    mutations.submit({ name: "one", optimistic: insert("a", 1) });
    mutations.submit({ name: "two", optimistic: insert("b", 2) });
    mutations.submit({ name: "three", optimistic: insert("c", 3) });

    await mutations.flush();

    // Only `one` (ok) and `two` (retry) were attempted; `three` waits behind the retry.
    expect(seam.calls.map((c) => c.name)).toEqual(["one", "two"]);
    expect(mutations.pending()).toBe(2); // two + three (one is held, not pending)
    // `one` is held (acked, shown), `two`/`three` are pending (shown) — all three visible.
    expect(store.getRows()).toEqual([
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
      { id: "c", rank: 3 },
    ]);
  });

  it("a throwing submit seam is treated as a transient retry (reported, entry kept)", async () => {
    const store = createLiveStore(def);
    const onError = vi.fn();
    const submit = vi.fn(async () => {
      throw new Error("network down");
    });
    const mutations = createLiveMutations({ store, submit, onError, newId: seqId() });

    mutations.submit({ name: "addPost", optimistic: insert("b", 2) });
    await mutations.flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(mutations.pending()).toBe(1);
    expect(store.getRows()).toEqual([{ id: "b", rank: 2 }]);
  });

  it("a throwing seam with no onError is swallowed (the entry is still kept)", async () => {
    const store = createLiveStore(def);
    const submit = vi.fn(async (): Promise<MutationOutcome> => {
      throw new Error("boom");
    });
    const mutations = createLiveMutations({ store, submit, newId: seqId() });

    mutations.submit({ name: "addPost", optimistic: insert("b", 2) });
    await expect(mutations.flush()).resolves.toBeUndefined();
    expect(mutations.pending()).toBe(1);
  });

  it("mints a unique client id when the caller supplies none (default newId)", () => {
    const store = createLiveStore(def);
    const seam = fakeSubmitter();
    seam.set("retry"); // keep them queued so nothing drains mid-assert
    const mutations = createLiveMutations({ store, submit: seam.submit });

    const { id: a } = mutations.submit({ name: "n", optimistic: insert("a", 1) });
    const { id: b } = mutations.submit({ name: "n", optimistic: insert("b", 2) });

    expect(typeof a).toBe("string");
    expect(a).not.toBe(b); // crypto.randomUUID — distinct per submit
  });

  it("an explicit id is honored (idempotency key)", () => {
    const store = createLiveStore(def);
    const seam = fakeSubmitter();
    seam.set("retry");
    const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId() });

    const { id } = mutations.submit({ id: "explicit-1", name: "n", optimistic: insert("a", 1) });
    expect(id).toBe("explicit-1");
  });

  it("resolves the per-write durable signal at once against a non-durable store", async () => {
    // No `outbox` capability → nothing to persist → `durable` is already-resolved (the write is as
    // durable as it will ever get: session memory). It must never hang a `saved`-confirmation await.
    const store = createLiveStore(def);
    const seam = fakeSubmitter();
    seam.set("retry");
    const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId() });

    const { durable } = mutations.submit({ name: "n", optimistic: insert("a", 1) });

    await expect(durable).resolves.toBeUndefined();
  });

  describe("held overlay: hold-until-echo, grace backstop, key reuse (L-436724ba)", () => {
    it("the grace backstop clears a held write whose echo never lands", async () => {
      const store = createLiveStore(def);
      store.applySnapshot([{ id: "a", rank: 1 }]);
      const seam = fakeSubmitter();
      const { schedule, fireAll } = fakeSchedule();
      const mutations = createLiveMutations({
        store,
        submit: seam.submit,
        newId: seqId(),
        schedule,
      });

      mutations.submit({ name: "addPost", optimistic: insert("b", 2) });
      await mutations.flush();

      // Held after ack — shown, awaiting an echo that (for a write not in this shape) never comes.
      expect(store.getRows()).toEqual([
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
      ]);

      // Grace expires → the held overlay clears, revealing the authorized truth. Its worst case is
      // exactly the pre-fix behavior (a late-cleared row), never incorrectness.
      fireAll();
      expect(store.getRows()).toEqual([{ id: "a", rank: 1 }]);
    });

    it("uses a real setTimeout grace backstop by default (fake timers)", async () => {
      vi.useFakeTimers();

      try {
        const store = createLiveStore(def);
        const seam = fakeSubmitter();
        // No injected `schedule` — exercise the default `setTimeout`-backed grace.
        const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId() });

        mutations.submit({ name: "n", optimistic: insert("b", 2) });
        await mutations.flush();
        expect(store.getRows()).toEqual([{ id: "b", rank: 2 }]); // held

        vi.advanceTimersByTime(DEFAULT_GRACE_MS);
        expect(store.getRows()).toEqual([]); // the default grace timer fired and cleared it
      } finally {
        vi.useRealTimers();
      }
    });

    it("a grace timer that fires after the echo already settled the write is a no-op", async () => {
      const store = createLiveStore(def);
      const seam = fakeSubmitter();
      const { schedule, fireAll } = fakeSchedule();
      const mutations = createLiveMutations({
        store,
        submit: seam.submit,
        newId: seqId(),
        schedule,
      });

      mutations.submit({ name: "n", optimistic: insert("b", 2) });
      await mutations.flush(); // ok → held, grace armed (captured, not yet fired)

      // The echo lands first, settling the held entry.
      store.applyChange(insert("b", 2));
      expect(store.getRows()).toEqual([{ id: "b", rank: 2 }]);

      // Now the (already-obsolete) grace timer fires — a harmless no-op, not a double-clear.
      fireAll();
      expect(store.getRows()).toEqual([{ id: "b", rank: 2 }]);
    });

    it("an echo for an older held write does not clear a newer pending write to the same key", async () => {
      const store = createLiveStore(def);
      const seam = fakeSubmitter(["ok", "retry"]); // m1 acks (held), m2 stays pending
      const { schedule } = fakeSchedule();
      const mutations = createLiveMutations({
        store,
        submit: seam.submit,
        newId: seqId(),
        schedule,
      });

      mutations.submit({ name: "one", optimistic: update("a", 2) });
      mutations.submit({ name: "two", optimistic: update("a", 3) });
      await mutations.flush();

      expect(store.getRows()).toEqual([{ id: "a", rank: 3 }]); // newest (m2) shown
      expect(mutations.pending()).toBe(1); // m2 still queued

      // m1's echo (a → rank 2) lands. It settles the held m1 but must NOT clear m2's pending view.
      store.applyChange(update("a", 2));
      expect(store.getRows()).toEqual([{ id: "a", rank: 3 }]); // m2's optimistic value still shown
      expect(mutations.pending()).toBe(1);
    });

    it("a resync leaves a held write shown; the grace backstop still bounds it", async () => {
      const store = createLiveStore(def);
      store.applySnapshot([{ id: "a", rank: 1 }]);
      const seam = fakeSubmitter();
      const { schedule, fireAll } = fakeSchedule();
      const mutations = createLiveMutations({
        store,
        submit: seam.submit,
        newId: seqId(),
        schedule,
      });

      mutations.submit({ name: "n", optimistic: insert("b", 2) });
      await mutations.flush(); // held
      expect(store.getRows()).toEqual([
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
      ]);

      // A resync abandons the authorized slice but must not strand the held write…
      store.applyResync();
      expect(store.getRows()).toEqual([{ id: "b", rank: 2 }]);

      // …and the grace backstop still clears it (no permanent leak).
      fireAll();
      expect(store.getRows()).toEqual([]);
    });
  });

  describe("durability (a durable store)", () => {
    it("an offline write survives reload and drains on reconnect", async () => {
      const db = freshDb();
      const { schedule } = fakeSchedule();

      // Session 1: go offline, submit, let the durable log persist.
      const store1 = await createSqliteLiveStore({ def, db });
      const offline = fakeSubmitter();
      offline.set("retry");
      const m1 = createLiveMutations({
        store: store1,
        submit: offline.submit,
        newId: seqId(),
        schedule,
      });

      m1.submit({ name: "addPost", input: { text: "b" }, optimistic: insert("b", 2) });
      await m1.flush();
      await store1.whenIdle(); // ensure the outbox row is durably written
      expect(m1.pending()).toBe(1);

      // Session 2 (a reload): a fresh store + outbox over the same durable engine. The optimistic
      // write is repainted from the persisted log BEFORE any reconnect…
      const store2 = await createSqliteLiveStore({ def, db });
      const online = fakeSubmitter(); // reconnected
      const m2 = createLiveMutations({
        store: store2,
        submit: online.submit,
        newId: seqId(),
        schedule,
      });

      expect(m2.pending()).toBe(1);
      expect(store2.getRows()).toEqual([{ id: "b", rank: 2 }]);

      // …then a flush replays it through the authorized POST, which acks → HELD (still shown).
      await m2.flush();
      expect(online.calls).toEqual([{ name: "addPost", input: { text: "b" } }]);
      expect(m2.pending()).toBe(0);

      // The echo lands → the held entry + its durable row clear.
      store2.applyChange(insert("b", 2));
      await store2.whenIdle();

      // A third reload sees an empty outbox — the write reconciled for good.
      const store3 = await createSqliteLiveStore({ def, db });
      expect(store3.outbox?.load()).toEqual([]);
    });

    it("preserves submission order in the durable log when a subscriber re-submits during the notification", async () => {
      // The re-entrant path: a store subscriber (a UI render, say) submits a SECOND write from
      // inside the FIRST write's optimistic-apply notification. The durable append must be enqueued
      // BEFORE that notification, else the re-entrant submit's append lands ahead of the first's —
      // inverting the log order, which `hydrate` replays by rowid.
      const db = freshDb();
      const store = await createSqliteLiveStore({ def, db });
      const seam = fakeSubmitter();
      seam.set("retry"); // stay "offline" so nothing is removed — we inspect the persisted order
      const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId() });

      let reentered = false;
      store.subscribe(() => {
        if (reentered) return;
        reentered = true;
        mutations.submit({ name: "second", optimistic: insert("b", 2) });
      });

      mutations.submit({ name: "first", optimistic: insert("a", 1) });
      await mutations.flush();
      await store.whenIdle();

      const reloaded = await createSqliteLiveStore({ def, db });
      expect(reloaded.outbox?.load().map((e) => e.name)).toEqual(["first", "second"]);
    });

    it("the per-write durable signal resolves once THIS entry is on disk (no whole-store whenIdle)", async () => {
      const db = freshDb();
      const store = await createSqliteLiveStore({ def, db });
      const seam = fakeSubmitter();
      seam.set("retry"); // stay offline so the entry is not drained/removed before we inspect it
      const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId() });

      const { id, durable } = mutations.submit({
        name: "addPost",
        input: { text: "b" },
        optimistic: insert("b", 2),
      });

      // Await ONLY this write's signal — not `store.whenIdle()`. A fresh store over the same engine
      // must now hydrate the entry, proving the append committed by the time `durable` resolved.
      await durable;

      const reloaded = await createSqliteLiveStore({ def, db });
      expect(reloaded.outbox?.load().map((e) => e.id)).toEqual([id]);
    });

    it("an acked write is held in the durable log until its echo, then removed", async () => {
      const db = freshDb();
      const { schedule } = fakeSchedule();
      const store = await createSqliteLiveStore({ def, db });
      const seam = fakeSubmitter(); // online, acks
      const mutations = createLiveMutations({
        store,
        submit: seam.submit,
        newId: seqId(),
        schedule,
      });

      mutations.submit({ name: "addPost", input: 1, optimistic: insert("b", 2) });
      await mutations.flush();
      await store.whenIdle();

      // Acked → HELD, not removed: a reload still rebuilds it (as held) so the write survives the gap.
      expect((await createSqliteLiveStore({ def, db })).outbox?.load()).toEqual([
        { id: "m1", name: "addPost", input: 1, optimistic: insert("b", 2), held: true },
      ]);

      // The echo lands → the held entry + its durable row clear.
      store.applyChange(insert("b", 2));
      await store.whenIdle();
      expect((await createSqliteLiveStore({ def, db })).outbox?.load()).toEqual([]);
    });

    it("a server-rejected write clears the overlay and its durable row (durable store)", async () => {
      const db = freshDb();
      const store = await createSqliteLiveStore({ def, db });
      const seam = fakeSubmitter(["rejected"]);
      const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId() });

      store.applySnapshot([{ id: "a", rank: 1 }], "v1:s:1:1");
      await store.whenIdle();
      mutations.submit({ name: "n", input: 1, optimistic: insert("b", 2) });
      await mutations.flush();
      await store.whenIdle();

      expect(store.getRows()).toEqual([{ id: "a", rank: 1 }]); // rolled back
      expect((await createSqliteLiveStore({ def, db })).outbox?.load()).toEqual([]); // durable row gone
    });

    it("the grace backstop drops the held write's durable row too", async () => {
      const db = freshDb();
      const { schedule, fireAll } = fakeSchedule();
      const store = await createSqliteLiveStore({ def, db });
      const seam = fakeSubmitter();
      const mutations = createLiveMutations({
        store,
        submit: seam.submit,
        newId: seqId(),
        schedule,
      });

      mutations.submit({ name: "n", input: 1, optimistic: insert("b", 2) });
      await mutations.flush(); // ok → held (durable held = 1)
      await store.whenIdle();

      fireAll(); // grace → clears overlay + durable row
      await store.whenIdle();
      expect((await createSqliteLiveStore({ def, db })).outbox?.load()).toEqual([]);
    });

    it("a reload rebuilds a held write as held — shown, not re-queued, not re-submitted", async () => {
      const db = freshDb();
      const { schedule } = fakeSchedule();

      // Session 1: submit online, ack → held (durable held = 1), NOT removed.
      const store1 = await createSqliteLiveStore({ def, db });
      const online1 = fakeSubmitter();
      const m1 = createLiveMutations({
        store: store1,
        submit: online1.submit,
        newId: seqId(),
        schedule,
      });
      m1.submit({ name: "addPost", input: { text: "b" }, optimistic: insert("b", 2) });
      await m1.flush();
      await store1.whenIdle();
      expect(m1.pending()).toBe(0); // held

      // Session 2 (reload): the held write repaints as held (shown) but is NOT queued for replay.
      const store2 = await createSqliteLiveStore({ def, db });
      const online2 = fakeSubmitter();
      const m2 = createLiveMutations({
        store: store2,
        submit: online2.submit,
        newId: seqId(),
        schedule,
      });

      expect(m2.pending()).toBe(0); // held, not queued
      expect(store2.getRows()).toEqual([{ id: "b", rank: 2 }]);

      // A flush must NOT re-submit an already-accepted write.
      await m2.flush();
      expect(online2.calls).toEqual([]);
      expect(store2.getRows()).toEqual([{ id: "b", rank: 2 }]); // still held
    });
  });

  it("degrades to a session-only queue against a non-durable store (no outbox capability)", async () => {
    // The in-memory store exposes no `outbox`, so the queue is session-only — but the optimistic
    // apply, drain, and rollback all still work; only the survives-reload guarantee is absent.
    const store = createLiveStore(def);
    expect(store.outbox).toBeUndefined();

    const seam = fakeSubmitter(["rejected"]);
    const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId() });

    mutations.submit({ name: "n", optimistic: insert("a", 1) });
    await mutations.flush();
    expect(mutations.pending()).toBe(0);
    expect(store.getRows()).toEqual([]);
  });
});
