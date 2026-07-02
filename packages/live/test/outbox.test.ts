import Database from "better-sqlite3";
import { adaptSyncSqlite } from "@lesto/db";
import type { SqlDatabase } from "@lesto/db";
import type { ShapeChange, ShapeDefinition } from "@lesto/live-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLiveMutations, createLiveStore, createSqliteLiveStore } from "../src/index";
import type { MutationOutcome } from "../src/index";

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
  it("applies a write optimistically and, online, drains it as the authorized mutation POST", async () => {
    const store = createLiveStore(def);
    store.applySnapshot([{ id: "a", rank: 1 }]);
    const seam = fakeSubmitter();
    const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId() });

    const id = mutations.submit({
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

    // Replayed as the app's own mutation POST (name + input verbatim), then acked → overlay cleared.
    expect(seam.calls).toEqual([{ name: "addPost", input: { text: "b" } }]);
    expect(mutations.pending()).toBe(0);
    // The authorized echo lands over the normal wire under the same key — modeled here by the row
    // already being present in the authorized set; after the overlay clears, it still shows once.
    expect(store.getRows()).toEqual([{ id: "a", rank: 1 }]);
  });

  it("a flush over an empty queue does not wedge later drains (the startup-flush path)", async () => {
    // The app flushes on startup / on every `online` event, often with nothing pending — a drain
    // that settles synchronously. A later submit MUST still drain: if the empty flush latched its
    // (resolved) promise as the re-entry guard, this submit would silently never send.
    const store = createLiveStore(def);
    const seam = fakeSubmitter();
    const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId() });

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

    // Rejected → the optimistic row is gone and nothing is left queued (replaying it would only be
    // refused again). The authorized row (never edited) shows through.
    expect(mutations.pending()).toBe(0);
    expect(store.getRows()).toEqual([{ id: "a", rank: 1 }]);
  });

  it("an offline write stays optimistic and pending until a later flush succeeds", async () => {
    const store = createLiveStore(def);
    const seam = fakeSubmitter();
    seam.set("retry"); // offline: every submit fails transport
    const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId() });

    mutations.submit({ name: "addPost", input: { text: "b" }, optimistic: insert("b", 2) });
    await mutations.flush();

    // Still shown, still queued — the write is not lost, just not yet reconciled.
    expect(store.getRows()).toEqual([{ id: "b", rank: 2 }]);
    expect(mutations.pending()).toBe(1);

    // Reconnect: the next flush drains it.
    seam.set("ok");
    await mutations.flush();
    expect(mutations.pending()).toBe(0);
    expect(store.getRows()).toEqual([]);
  });

  it("drains in submission order and stops at the first retry, preserving order", async () => {
    const store = createLiveStore(def);
    // First entry ok, second retry → the third must NOT be attempted (FIFO, no reordering).
    const seam = fakeSubmitter(["ok", "retry"]);
    const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId() });

    mutations.submit({ name: "one", optimistic: insert("a", 1) });
    mutations.submit({ name: "two", optimistic: insert("b", 2) });
    mutations.submit({ name: "three", optimistic: insert("c", 3) });

    await mutations.flush();

    // Only `one` (ok) and `two` (retry) were attempted; `three` waits behind the retry.
    expect(seam.calls.map((c) => c.name)).toEqual(["one", "two"]);
    expect(mutations.pending()).toBe(2); // two + three
    expect(store.getRows()).toEqual([
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

    const a = mutations.submit({ name: "n", optimistic: insert("a", 1) });
    const b = mutations.submit({ name: "n", optimistic: insert("b", 2) });

    expect(typeof a).toBe("string");
    expect(a).not.toBe(b); // crypto.randomUUID — distinct per submit
  });

  it("an explicit id is honored (idempotency key)", () => {
    const store = createLiveStore(def);
    const seam = fakeSubmitter();
    seam.set("retry");
    const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId() });

    const id = mutations.submit({ id: "explicit-1", name: "n", optimistic: insert("a", 1) });
    expect(id).toBe("explicit-1");
  });

  describe("durability (a durable store)", () => {
    it("an offline write survives reload and drains on reconnect", async () => {
      const db = freshDb();

      // Session 1: go offline, submit, let the durable log persist.
      const store1 = await createSqliteLiveStore({ def, db });
      const offline = fakeSubmitter();
      offline.set("retry");
      const m1 = createLiveMutations({ store: store1, submit: offline.submit, newId: seqId() });

      m1.submit({ name: "addPost", input: { text: "b" }, optimistic: insert("b", 2) });
      await m1.flush();
      await store1.whenIdle(); // ensure the outbox row is durably written
      expect(m1.pending()).toBe(1);

      // Session 2 (a reload): a fresh store + outbox over the same durable engine. The optimistic
      // write is repainted from the persisted log BEFORE any reconnect…
      const store2 = await createSqliteLiveStore({ def, db });
      const online = fakeSubmitter(); // reconnected
      const m2 = createLiveMutations({ store: store2, submit: online.submit, newId: seqId() });

      expect(m2.pending()).toBe(1);
      expect(store2.getRows()).toEqual([{ id: "b", rank: 2 }]);

      // …then a flush replays it through the authorized POST and clears it, durably.
      await m2.flush();
      expect(online.calls).toEqual([{ name: "addPost", input: { text: "b" } }]);
      expect(m2.pending()).toBe(0);
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

    it("an acked write is removed from the durable log", async () => {
      const db = freshDb();
      const store = await createSqliteLiveStore({ def, db });
      const seam = fakeSubmitter(); // online, acks
      const mutations = createLiveMutations({ store, submit: seam.submit, newId: seqId() });

      mutations.submit({ name: "addPost", input: 1, optimistic: insert("b", 2) });
      await mutations.flush();
      await store.whenIdle();

      expect((await createSqliteLiveStore({ def, db })).outbox?.load()).toEqual([]);
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
