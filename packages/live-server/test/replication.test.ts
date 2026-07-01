import { describe, expect, it, vi } from "vitest";

import { createPgReplicationSource, DEFAULT_SLOT, LiveServerError } from "../src/index";
import type {
  DecodedChange,
  PgReplicationClient,
  ReplicationChange,
  SystemIdentity,
} from "../src/index";

// ---------------------------------------------------------------------------
// Test rig: a fake replication client that records the four replication commands, lets a
// test emit decoded changes / errors, and drives the connection lifecycle — so every
// change-source branch (identity stamping, slot lifecycle, reconnect/backoff, error routing)
// is reachable without a live Postgres WAL stream.
// ---------------------------------------------------------------------------

class FakeReplicationClient implements PgReplicationClient {
  connected = false;

  ended = false;

  /** The `(systemId, timelineId)` this connection's `IDENTIFY_SYSTEM` returns (tunable per client). */
  identity: SystemIdentity = { systemId: "sys-1", timelineId: 1 };

  createdSlots: string[] = [];

  droppedSlots: string[] = [];

  replications: Array<{ slot: string; startLsn: string | undefined }> = [];

  connectImpl: () => Promise<void> = async () => {
    this.connected = true;
  };

  dropSlotImpl: (slot: string) => Promise<void> = async (slot) => {
    this.droppedSlots.push(slot);
  };

  endImpl: () => Promise<void> = async () => {
    this.ended = true;
  };

  #change: ((change: DecodedChange) => void) | undefined;

  #error: ((error: Error) => void) | undefined;

  connect(): Promise<void> {
    return this.connectImpl();
  }

  async identifySystem(): Promise<SystemIdentity> {
    return this.identity;
  }

  async createSlot(slot: string): Promise<void> {
    this.createdSlots.push(slot);
  }

  dropSlot(slot: string): Promise<void> {
    return this.dropSlotImpl(slot);
  }

  async startReplication(slot: string, startLsn?: string): Promise<void> {
    this.replications.push({ slot, startLsn });
  }

  on(event: "change" | "error", listener: (arg: never) => void): unknown {
    if (event === "change") this.#change = listener as (change: DecodedChange) => void;
    else this.#error = listener as (error: Error) => void;

    return this;
  }

  end(): Promise<void> {
    return this.endImpl();
  }

  emitChange(change: DecodedChange): void {
    this.#change?.(change);
  }

  emitError(error: Error): void {
    this.#error?.(error);
  }
}

/** A `createClient` that records every minted client so a test can inspect the reconnect chain. */
function tracking(prepare?: (client: FakeReplicationClient, index: number) => void): {
  createClient: () => PgReplicationClient;
  clients: FakeReplicationClient[];
} {
  const clients: FakeReplicationClient[] = [];

  return {
    createClient: () => {
      const client = new FakeReplicationClient();
      prepare?.(client, clients.length);
      clients.push(client);

      return client;
    },
    clients,
  };
}

/** Flush pending microtasks so an async reconnect chain settles. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Collect every change a source delivers. */
function collector(): { onChange: (c: ReplicationChange) => void; changes: ReplicationChange[] } {
  const changes: ReplicationChange[] = [];

  return { onChange: (change) => changes.push(change), changes };
}

const insert: DecodedChange = {
  op: "insert",
  table: "messages",
  commitLSN: "0/16B3748",
  newImage: { id: 1, roomId: 1, body: "hi" },
};

describe("createPgReplicationSource — start", () => {
  it("connects, IDENTIFY_SYSTEMs, creates the slot, and starts replication (first start, default slot)", async () => {
    const { createClient, clients } = tracking();
    const source = createPgReplicationSource({ createClient });

    expect(source.identity).toBeUndefined(); // nothing captured before start

    await source.start();

    const client = clients[0]!;
    expect(client.connected).toBe(true);
    expect(client.createdSlots).toEqual([DEFAULT_SLOT]);
    expect(client.replications).toEqual([{ slot: DEFAULT_SLOT, startLsn: undefined }]);
    expect(source.identity).toEqual({ systemId: "sys-1", timelineId: 1 });

    await source.stop();
  });

  it("honors a custom slot and forwards startLsn to START_REPLICATION (the Inc4 resume seam)", async () => {
    const { createClient, clients } = tracking();
    const source = createPgReplicationSource({
      createClient,
      slot: "app_live",
      startLsn: "0/16B3748",
    });

    await source.start();

    expect(clients[0]!.createdSlots).toEqual(["app_live"]);
    expect(clients[0]!.replications).toEqual([{ slot: "app_live", startLsn: "0/16B3748" }]);

    await source.stop();
  });

  it("refuses a double start with a coded error (a second start would re-CREATE the slot)", async () => {
    const source = createPgReplicationSource({ createClient: () => new FakeReplicationClient() });

    await source.start();

    await expect(source.start()).rejects.toBeInstanceOf(LiveServerError);
    await expect(source.start()).rejects.toMatchObject({
      code: "LIVE_SERVER_REPLICATION_ALREADY_STARTED",
    });

    await source.stop();
  });

  it("refuses a start after stop — stop is terminal (the slot is dropped)", async () => {
    const source = createPgReplicationSource({ createClient: () => new FakeReplicationClient() });

    await source.start();
    await source.stop();

    await expect(source.start()).rejects.toMatchObject({ code: "LIVE_SERVER_REPLICATION_STOPPED" });
  });
});

describe("createPgReplicationSource — change decode + identity stamping", () => {
  it("stamps commitLSN + system identity and shapes an insert as newImage-only", async () => {
    const { createClient, clients } = tracking();
    const source = createPgReplicationSource({ createClient });
    const sink = collector();
    source.onChange(sink.onChange);

    await source.start();
    clients[0]!.emitChange(insert);

    expect(sink.changes).toEqual([
      {
        op: "insert",
        table: "messages",
        commitLSN: "0/16B3748",
        systemId: "sys-1",
        timelineId: 1,
        newImage: { id: 1, roomId: 1, body: "hi" },
      },
    ]);
    // An insert has no old image — modeled precisely, not stamped with an empty one.
    expect(sink.changes[0]).not.toHaveProperty("oldImage");

    await source.stop();
  });

  it("shapes an update as both images, stamped", async () => {
    const { createClient, clients } = tracking();
    const source = createPgReplicationSource({ createClient });
    const sink = collector();
    source.onChange(sink.onChange);

    await source.start();
    clients[0]!.emitChange({
      op: "update",
      table: "messages",
      commitLSN: "0/2",
      newImage: { id: 1, roomId: 2 },
      oldImage: { id: 1, roomId: 1 },
    });

    expect(sink.changes).toEqual([
      {
        op: "update",
        table: "messages",
        commitLSN: "0/2",
        systemId: "sys-1",
        timelineId: 1,
        newImage: { id: 1, roomId: 2 },
        oldImage: { id: 1, roomId: 1 },
      },
    ]);

    await source.stop();
  });

  it("shapes a delete as oldImage-only, stamped", async () => {
    const { createClient, clients } = tracking();
    const source = createPgReplicationSource({ createClient });
    const sink = collector();
    source.onChange(sink.onChange);

    await source.start();
    clients[0]!.emitChange({
      op: "delete",
      table: "messages",
      commitLSN: "0/3",
      oldImage: { id: 1, roomId: 1 },
    });

    expect(sink.changes[0]).toEqual({
      op: "delete",
      table: "messages",
      commitLSN: "0/3",
      systemId: "sys-1",
      timelineId: 1,
      oldImage: { id: 1, roomId: 1 },
    });
    // A delete has no new image.
    expect(sink.changes[0]).not.toHaveProperty("newImage");

    await source.stop();
  });

  it("emits the FULL, UNFILTERED feed — every change reaches every sink, none is dropped", async () => {
    const { createClient, clients } = tracking();
    const source = createPgReplicationSource({ createClient });
    const a = collector();
    const b = collector();
    source.onChange(a.onChange);
    source.onChange(b.onChange);

    await source.start();

    // Changes across tables/tenants a shape would later filter — the SOURCE filters none.
    clients[0]!.emitChange({
      op: "insert",
      table: "messages",
      commitLSN: "0/1",
      newImage: { id: 1, roomId: 1 },
    });
    clients[0]!.emitChange({
      op: "insert",
      table: "messages",
      commitLSN: "0/2",
      newImage: { id: 2, roomId: 999 },
    });
    clients[0]!.emitChange({
      op: "delete",
      table: "orders",
      commitLSN: "0/3",
      oldImage: { id: 7 },
    });

    expect(a.changes).toHaveLength(3);
    expect(b.changes).toHaveLength(3);
    expect(a.changes.map((c) => c.commitLSN)).toEqual(["0/1", "0/2", "0/3"]);

    await source.stop();
  });

  it("stops delivering to an unsubscribed change handler", async () => {
    const { createClient, clients } = tracking();
    const source = createPgReplicationSource({ createClient });
    const sink = collector();
    const off = source.onChange(sink.onChange);

    await source.start();
    clients[0]!.emitChange(insert);
    off();
    clients[0]!.emitChange({ ...insert, commitLSN: "0/after-off" });

    expect(sink.changes).toHaveLength(1);

    await source.stop();
  });

  it("stops routing to an unsubscribed error handler", async () => {
    const { createClient, clients } = tracking();
    const kept = vi.fn();
    const source = createPgReplicationSource({ createClient, delay: async () => {} });
    source.onError(kept);
    const off = source.onError(vi.fn());

    await source.start();
    off(); // the second handler leaves before any error is routed
    clients[0]!.emitError(new Error("boom"));
    await flush();

    expect(kept).toHaveBeenCalledOnce();

    await source.stop();
  });
});

describe("createPgReplicationSource — reconnect", () => {
  it("on a client error, ends the old client and re-streams on a fresh one WITHOUT re-creating the slot, re-reading identity", async () => {
    const { createClient, clients } = tracking((client, index) => {
      // The reconnect (2nd client) lands after a same-cluster failover: timeline bumps.
      if (index === 1) client.identity = { systemId: "sys-1", timelineId: 2 };
    });
    const onError = vi.fn();
    const source = createPgReplicationSource({
      createClient,
      delay: async () => {},
      reconnectMs: 5,
    });
    source.onError(onError);
    const sink = collector();
    source.onChange(sink.onChange);

    await source.start();
    expect(clients).toHaveLength(1);

    clients[0]!.emitError(new Error("connection lost"));
    await flush();

    expect(onError).toHaveBeenCalledOnce();
    expect(clients[0]!.ended).toBe(true);
    expect(clients).toHaveLength(2);
    expect(clients[1]!.connected).toBe(true);
    // The slot persists in Postgres across the drop — reconnect must NOT re-create it.
    expect(clients[1]!.createdSlots).toEqual([]);
    expect(clients[1]!.replications).toEqual([{ slot: DEFAULT_SLOT, startLsn: undefined }]);
    // Identity was re-read on the new connection — a change now carries the new timeline.
    expect(source.identity).toEqual({ systemId: "sys-1", timelineId: 2 });
    clients[1]!.emitChange(insert);
    expect(sink.changes[0]!.timelineId).toBe(2);

    await source.stop();
  });

  it("retries when a reconnect attempt itself fails, then succeeds", async () => {
    const { createClient, clients } = tracking((client, index) => {
      // The FIRST reconnect's client (index 1) fails to connect; the next works.
      if (index === 1) {
        client.connectImpl = async () => {
          throw new Error("db still down");
        };
      }
    });
    const onError = vi.fn();
    const source = createPgReplicationSource({ createClient, delay: async () => {} });
    source.onError(onError);

    await source.start();
    clients[0]!.emitError(new Error("connection lost"));
    await flush();

    expect(clients).toHaveLength(3);
    expect(clients[1]!.connected).toBe(false);
    expect(clients[2]!.connected).toBe(true);
    expect(clients[2]!.createdSlots).toEqual([]); // still never re-created
    // Reported the original error plus the failed reconnect attempt.
    expect(onError.mock.calls.length).toBeGreaterThanOrEqual(2);

    await source.stop();
  });

  it("collapses overlapping error events into a single reconnect session", async () => {
    let releaseDelay!: () => void;
    const { createClient, clients } = tracking();
    const source = createPgReplicationSource({
      createClient,
      // A backoff held open so a SECOND error lands mid-reconnect (the race the guard closes).
      delay: () =>
        new Promise<void>((resolve) => {
          releaseDelay = resolve;
        }),
    });

    await source.start();

    clients[0]!.emitError(new Error("reset"));
    clients[0]!.emitError(new Error("reset again"));
    await flush();

    releaseDelay();
    await flush();

    // Exactly one fresh client — not two (one orphaned).
    expect(clients).toHaveLength(2);
    expect(clients[1]!.connected).toBe(true);

    await source.stop();
  });

  it("does not resurrect a source stopped during the reconnect backoff, and still drops the slot", async () => {
    let releaseDelay!: () => void;
    const { createClient, clients } = tracking();
    const source = createPgReplicationSource({
      createClient,
      delay: () =>
        new Promise<void>((resolve) => {
          releaseDelay = resolve;
        }),
    });

    await source.start();
    clients[0]!.emitError(new Error("connection lost"));
    await flush();

    // Stop while the backoff is pending: the slot is dropped even mid-reconnect.
    await source.stop();
    expect(clients[0]!.droppedSlots).toEqual([DEFAULT_SLOT]);

    releaseDelay();
    await flush();

    expect(clients).toHaveLength(1); // the reconnect bailed — no second client
  });

  it("uses the real backoff delay when none is injected", async () => {
    const { createClient, clients } = tracking();
    const source = createPgReplicationSource({ createClient, reconnectMs: 1 });

    await source.start();
    clients[0]!.emitError(new Error("connection lost"));

    // Wait out the real 1ms backoff (plus slack) and let the reconnect settle.
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(clients).toHaveLength(2);
    expect(clients[1]!.connected).toBe(true);

    await source.stop();
  });

  it("a late client error after stop does not start a reconnect", async () => {
    const { createClient, clients } = tracking();
    const source = createPgReplicationSource({ createClient, delay: async () => {} });

    await source.start();
    await source.stop();

    clients[0]!.emitError(new Error("late error"));
    await flush();

    expect(clients).toHaveLength(1);
  });
});

describe("createPgReplicationSource — stop + slot lifecycle", () => {
  it("drops the slot and ends the client, and is idempotent", async () => {
    const client = new FakeReplicationClient();
    const source = createPgReplicationSource({ createClient: () => client });

    await source.start();
    await source.stop();

    expect(client.droppedSlots).toEqual([DEFAULT_SLOT]);
    expect(client.ended).toBe(true);

    await source.stop(); // idempotent — no second drop
    expect(client.droppedSlots).toEqual([DEFAULT_SLOT]);
  });

  it("stop before start is a no-op (no client to drop or end, no throw)", async () => {
    const source = createPgReplicationSource({ createClient: () => new FakeReplicationClient() });

    await expect(source.stop()).resolves.toBeUndefined();
  });

  it("skips the slot drop when start failed before the slot was created", async () => {
    const client = new FakeReplicationClient();
    client.connectImpl = async () => {
      throw new Error("connect refused");
    };
    const source = createPgReplicationSource({ createClient: () => client });

    // First start fails at connect — before CREATE_REPLICATION_SLOT, so no slot exists.
    await expect(source.start()).rejects.toThrow("connect refused");

    await source.stop();
    expect(client.droppedSlots).toEqual([]); // nothing to drop
    expect(client.ended).toBe(true); // but the half-open connection is still ended
  });

  it("routes a dropSlot failure through onError without throwing", async () => {
    const client = new FakeReplicationClient();
    client.dropSlotImpl = async () => {
      throw new Error("drop failed");
    };
    const onError = vi.fn();
    const source = createPgReplicationSource({ createClient: () => client });
    source.onError(onError);

    await source.start();

    await expect(source.stop()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(client.ended).toBe(true); // the end still runs after a failed drop
  });

  it("routes an end failure through onError without throwing", async () => {
    const client = new FakeReplicationClient();
    client.endImpl = async () => {
      throw new Error("end failed");
    };
    const onError = vi.fn();
    const source = createPgReplicationSource({ createClient: () => client });
    source.onError(onError);

    await source.start();

    await expect(source.stop()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("createPgReplicationSource — defaults", () => {
  it("works with no onChange / onError registered (the no-op default sinks)", async () => {
    const { createClient, clients } = tracking();
    const source = createPgReplicationSource({ createClient, delay: async () => {} });

    await source.start();

    // A change with no change sink, and an error with no error sink, must not throw.
    clients[0]!.emitChange(insert);
    clients[0]!.emitError(new Error("boom"));
    await flush();

    // The error still drove a reconnect (a fresh client) — routed to zero sinks, not thrown.
    expect(clients).toHaveLength(2);

    await source.stop();
  });
});

// ---------------------------------------------------------------------------
// Review hardening (red-team findings on 1e52054): a client `error` during the FIRST start must
// not launch a background reconnect (Finding A — else a zombie loop or an orphaned WAL-pinning
// slot the caller never sees), a stop() racing the first open must not orphan a slot (Finding B),
// and a throwing error sink must not crash the source. The fake couples connect/query failures to
// an error event and drives stop() from inside an await, reproducing interleavings a live `pg`
// exhibits but the happy-path fake did not.
// ---------------------------------------------------------------------------

describe("createPgReplicationSource — first-start error does not spawn a hidden reconnect", () => {
  it("a client error BEFORE the slot is created leaves only the rejected start() — no background reconnect", async () => {
    const { createClient, clients } = tracking((client, index) => {
      if (index === 0) {
        client.connectImpl = async () => {
          client.connected = true;
          // A real socket failure rejects the in-flight command AND emits an error event.
          client.emitError(new Error("socket died mid-connect"));
          throw new Error("connect failed");
        };
      }
    });
    const onError = vi.fn();
    const source = createPgReplicationSource({ createClient, delay: async () => {} });
    source.onError(onError);

    await expect(source.start()).rejects.toThrow("connect failed");
    await flush();

    // No second client: streaming was never established, so the error did not reconnect.
    expect(clients).toHaveLength(1);
    expect(clients[0]!.createdSlots).toEqual([]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("a client error AFTER the slot is created does not resurrect the source; stop() drops the orphan", async () => {
    const { createClient, clients } = tracking((client, index) => {
      if (index === 0) {
        client.startReplication = async () => {
          // The slot exists by now; the stream fails and the socket also errors.
          client.emitError(new Error("stream failed after CREATE_SLOT"));
          throw new Error("start replication failed");
        };
      }
    });
    const onError = vi.fn();
    const source = createPgReplicationSource({ createClient, delay: async () => {} });
    source.onError(onError);

    await expect(source.start()).rejects.toThrow("start replication failed");
    await flush();

    expect(clients).toHaveLength(1); // no reconnect resurrected the discarded source
    expect(clients[0]!.createdSlots).toEqual([DEFAULT_SLOT]);

    // The slot the failed start created is cleanable — stop() drops it rather than orphan WAL.
    await source.stop();
    expect(clients[0]!.droppedSlots).toEqual([DEFAULT_SLOT]);
  });
});

describe("createPgReplicationSource — a stop() racing the first open never orphans a slot", () => {
  it("stop during the first connect aborts before CREATE_SLOT (no slot created)", async () => {
    let source!: ReturnType<typeof createPgReplicationSource>;
    const { createClient, clients } = tracking((client, index) => {
      if (index === 0) {
        client.connectImpl = async () => {
          client.connected = true;
          await source.stop(); // a SIGTERM lands during a slow connect
        };
      }
    });
    source = createPgReplicationSource({ createClient, delay: async () => {} });

    await source.start(); // resolves cleanly on the now-stopped source
    await flush();

    expect(clients[0]!.createdSlots).toEqual([]);
    expect(clients[0]!.ended).toBe(true);
    expect(clients).toHaveLength(1);
  });

  it("stop during IDENTIFY_SYSTEM aborts before CREATE_SLOT (no slot created)", async () => {
    let source!: ReturnType<typeof createPgReplicationSource>;
    const { createClient, clients } = tracking((client, index) => {
      if (index === 0) {
        client.identifySystem = async () => {
          await source.stop();
          return client.identity;
        };
      }
    });
    source = createPgReplicationSource({ createClient, delay: async () => {} });

    await source.start();
    await flush();

    expect(clients[0]!.createdSlots).toEqual([]);
    expect(clients[0]!.ended).toBe(true);
    expect(clients).toHaveLength(1);
  });

  it("stop just after CREATE_SLOT drops the slot it created and never starts replication", async () => {
    let source!: ReturnType<typeof createPgReplicationSource>;
    const { createClient, clients } = tracking((client, index) => {
      if (index === 0) {
        const realCreate = client.createSlot.bind(client);
        client.createSlot = async (slot: string) => {
          await realCreate(slot); // records the slot as created
          await source.stop(); // ...then stop races before START_REPLICATION
        };
      }
    });
    source = createPgReplicationSource({ createClient, delay: async () => {} });

    await source.start();
    await flush();

    expect(clients[0]!.createdSlots).toEqual([DEFAULT_SLOT]);
    expect(clients[0]!.droppedSlots).toEqual([DEFAULT_SLOT]); // the abort dropped it — no orphan
    expect(clients[0]!.replications).toEqual([]); // never reached START_REPLICATION
    expect(clients).toHaveLength(1);
  });

  it("a failed drop during a stop-raced open is best-effort — attempted, swallowed, still ends the client", async () => {
    let source!: ReturnType<typeof createPgReplicationSource>;
    // The drop attempted by the abort throws; because stop() already ran (and cleared its sinks),
    // the failure has nowhere to route — it must be swallowed, never thrown, and the client still ends.
    const dropSpy = vi.fn(async () => {
      throw new Error("drop failed mid-open");
    });
    const { createClient, clients } = tracking((client, index) => {
      if (index === 0) {
        client.dropSlotImpl = dropSpy;
        const realCreate = client.createSlot.bind(client);
        client.createSlot = async (slot: string) => {
          await realCreate(slot);
          await source.stop();
        };
      }
    });
    source = createPgReplicationSource({ createClient, delay: async () => {} });

    await expect(source.start()).resolves.toBeUndefined();
    await flush();

    expect(dropSpy).toHaveBeenCalledWith(DEFAULT_SLOT); // the abort attempted the drop
    expect(clients[0]!.ended).toBe(true); // end still runs after a failed drop
  });

  it("routes an end failure during a stop-raced open through onError (never thrown)", async () => {
    let source!: ReturnType<typeof createPgReplicationSource>;
    const onError = vi.fn();
    const { createClient } = tracking((client, index) => {
      if (index === 0) {
        client.endImpl = async () => {
          throw new Error("end failed mid-open");
        };
        client.connectImpl = async () => {
          client.connected = true;
          await source.stop();
        };
      }
    });
    source = createPgReplicationSource({ createClient, delay: async () => {} });
    source.onError(onError);

    await expect(source.start()).resolves.toBeUndefined();
    await flush();

    expect(onError).toHaveBeenCalled();
  });
});

describe("createPgReplicationSource — a throwing error sink cannot crash the source", () => {
  it("swallows a throwing onError handler and still runs the others", async () => {
    const { createClient, clients } = tracking();
    const good = vi.fn();
    const source = createPgReplicationSource({ createClient, delay: async () => {} });
    source.onError(() => {
      throw new Error("bad sink");
    });
    source.onError(good);

    await source.start();

    expect(() => clients[0]!.emitError(new Error("boom"))).not.toThrow();
    await flush();

    expect(good).toHaveBeenCalledWith(expect.any(Error));

    await source.stop();
  });
});
