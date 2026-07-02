// The fakes here drive `BroadcastChannel.postMessage`, a single-message API with no `targetOrigin`
// (that argument belongs to `window.postMessage`); the unicorn rule cannot distinguish them.
// oxlint-disable unicorn/require-post-message-target-origin
import { serializeShapeDefinition, shapeId } from "@lesto/live-protocol";
import type { ShapeDefinition } from "@lesto/live-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserCrossTabEnvironment, createCrossTabLiveQuery, createLiveStore } from "../src/index";
import type {
  BroadcastChannelSeam,
  CrossTabEnvironment,
  LeaderStore,
  LiveEnvironment,
  LiveEventSource,
  LiveMessageEvent,
  RequestLock,
} from "../src/index";

const def: ShapeDefinition = {
  table: "todos",
  key: "id",
  columns: ["id", "rank"],
  where: [],
  orderBy: { column: "rank", direction: "asc" },
};

/** Drain microtasks/timers so a granted leadership callback (async store open) settles. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const abortError = (): Error =>
  Object.assign(new Error("The request was aborted."), { name: "AbortError" });

/** A no-op lock-granted callback, hoisted so it is a stable reference for a `toHaveBeenCalledWith`. */
const noopCallback = (): Promise<void> => Promise.resolve();

// ── A shared in-process Web Locks fake: one holder per name, the rest queued, the held lock
// released (and the next waiter promoted) when the callback's promise settles. See leader.test.ts.
function fakeLocks(): RequestLock {
  interface Waiter {
    readonly run: () => void;
    readonly reject: (error: unknown) => void;
  }

  const held = new Map<string, boolean>();
  const queues = new Map<string, Waiter[]>();

  const promote = (name: string): void => {
    const next = queues.get(name)?.shift();

    if (next === undefined) {
      held.set(name, false);

      return;
    }

    held.set(name, true);
    next.run();
  };

  return (name, options, callback) =>
    new Promise((resolve, reject) => {
      const waiter: Waiter = {
        run: () => {
          void (async () => {
            try {
              const value = await callback();

              promote(name);
              resolve(value);
            } catch (error) {
              promote(name);
              reject(error);
            }
          })();
        },
        reject,
      };

      options.signal?.addEventListener("abort", () => {
        const queue = queues.get(name);
        const index = queue?.indexOf(waiter) ?? -1;

        if (queue !== undefined && index >= 0) {
          queue.splice(index, 1);
          waiter.reject(abortError());
        }
      });

      if (held.get(name) !== true) {
        held.set(name, true);
        waiter.run();
      } else {
        (queues.get(name) ?? queues.set(name, []).get(name)!).push(waiter);
      }
    });
}

// ── A shared BroadcastChannel bus: `postMessage` structured-clones the message to every OTHER open
// channel of the same name (never the sender), like the real API. Delivery is synchronous for
// deterministic tests; the member set is snapshotted so a reentrant post/close cannot disturb it.
interface Member {
  readonly deliver: (data: unknown) => void;
  active: boolean;
}

function broadcastBus(): { openChannel: (name: string) => BroadcastChannelSeam } {
  const channels = new Map<string, Set<Member>>();

  return {
    openChannel(name) {
      const listeners = new Set<(event: { data: unknown }) => void>();
      const member: Member = {
        deliver: (data) => {
          for (const listener of listeners) listener({ data });
        },
        active: true,
      };

      const members = channels.get(name) ?? channels.set(name, new Set()).get(name)!;

      members.add(member);

      return {
        postMessage: (message) => {
          // Snapshot the live members into a list first, so a reentrant post/close during delivery
          // cannot disturb the walk (real BroadcastChannel delivery is likewise a stable fan-out).
          const targets = Array.from(members).filter((other) => other !== member && other.active);

          for (const other of targets) other.deliver(structuredClone(message));
        },
        addEventListener: (_type, listener) => listeners.add(listener),
        close: () => {
          member.active = false;
          members.delete(member);
        },
      };
    },
  };
}

// ── A driveable fake EventSource seam (the leader's sync connection). Records opened URLs and lets a
// test fire named frames by hand. Mirrors consumer.test.ts's `fakeLive`.
interface FakeSource extends LiveEventSource {
  url: string;
  closed: boolean;
  emit(type: string, data: string, lastEventId?: string): void;
}

function fakeLive(): { env: LiveEnvironment; sources: FakeSource[] } {
  const sources: FakeSource[] = [];

  const env: LiveEnvironment = {
    open(url) {
      const listeners = new Map<string, (event: LiveMessageEvent) => void>();

      const source: FakeSource = {
        url,
        closed: false,
        addEventListener: (type, listener) => listeners.set(type, listener),
        close: () => {
          source.closed = true;
        },
        emit: (type, data, lastEventId = "") => listeners.get(type)?.({ data, lastEventId }),
      };

      sources.push(source);

      return source;
    },
  };

  return { env, sources };
}

/** A test "tab": its coordinator over the shared lock + broadcast bus, plus its own connection seam. */
interface Tab {
  readonly query: ReturnType<typeof createCrossTabLiveQuery>;
  readonly live: { env: LiveEnvironment; sources: FakeSource[] };
}

interface Harness {
  readonly requestLock: RequestLock;
  readonly openChannel: (name: string) => BroadcastChannelSeam;
  spawn(extra?: Parameters<typeof createCrossTabLiveQuery>[1]): Tab;
}

function harness(): Harness {
  const requestLock = fakeLocks();
  const { openChannel } = broadcastBus();
  const environment: CrossTabEnvironment = { requestLock, openChannel };

  return {
    requestLock,
    openChannel,
    spawn(extra) {
      const live = fakeLive();
      const query = createCrossTabLiveQuery(def, {
        environment,
        liveEnvironment: live.env,
        ...extra,
      });

      return { query, live };
    },
  };
}

/** The single frame a leader's connection is driven with. */
const emitSnapshot = (tab: Tab, rows: readonly unknown[], cursor = ""): void =>
  tab.live.sources[0]!.emit("snapshot", JSON.stringify({ rows }), cursor);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createCrossTabLiveQuery", () => {
  it("makes a lone tab the leader and opens exactly one connection", async () => {
    const h = harness();
    const a = h.spawn();

    await tick();

    // The lone tab won the lock and opened its sync connection.
    expect(a.live.sources).toHaveLength(1);

    emitSnapshot(a, [{ id: "x", rank: 1 }]);
    expect(a.query.getSnapshot()).toEqual([{ id: "x", rank: 1 }]);
  });

  it("keeps followers connection-less and mirrors the leader's rendered slice", async () => {
    const h = harness();
    const a = h.spawn();

    await tick();

    const b = h.spawn();

    await tick();

    // Only the leader has a connection; the follower has none.
    expect(a.live.sources).toHaveLength(1);
    expect(b.live.sources).toHaveLength(0);

    emitSnapshot(a, [{ id: "x", rank: 1 }], "v1:sysA:1:10");

    // The follower re-renders from the leader's broadcast, no connection of its own.
    expect(b.query.getSnapshot()).toEqual([{ id: "x", rank: 1 }]);
  });

  it("hands a late-joining follower the current state via the hello handshake", async () => {
    const h = harness();
    const a = h.spawn();

    await tick();

    // The leader syncs BEFORE the follower joins, then goes quiet (no further change).
    emitSnapshot(a, [{ id: "x", rank: 1 }], "v1:sysA:1:10");

    const b = h.spawn();

    await tick();

    // On construction the follower said hello; the leader answered with the current slice.
    expect(b.query.getSnapshot()).toEqual([{ id: "x", rank: 1 }]);
  });

  it("fails over to a follower on leader disconnect and RESUMES from the broadcast cursor", async () => {
    const h = harness();
    const a = h.spawn();

    await tick();

    const b = h.spawn();

    await tick();

    emitSnapshot(a, [{ id: "x", rank: 1 }], "v1:sysA:1:42");
    expect(b.query.getSnapshot()).toEqual([{ id: "x", rank: 1 }]);

    // The leader tab goes away — its lock releases and the follower is promoted.
    a.query.disconnect();
    await tick();

    // The promoted tab opened the ONE connection, seeded with the mirrored view (no flash) …
    expect(b.live.sources).toHaveLength(1);
    expect(b.query.getSnapshot()).toEqual([{ id: "x", rank: 1 }]);

    // … and resumed from the last broadcast cursor rather than re-snapshotting from scratch.
    const base = `?shape=${encodeURIComponent(serializeShapeDefinition(def))}`;
    expect(b.live.sources[0]!.url).toBe(
      `/__lesto/live-data${base}&lastEventId=${encodeURIComponent("v1:sysA:1:42")}`,
    );

    // The new leader now drives updates for everyone.
    emitSnapshot(
      b,
      [
        { id: "x", rank: 1 },
        { id: "y", rank: 2 },
      ],
      "v1:sysA:1:43",
    );
    expect(b.query.getSnapshot()).toEqual([
      { id: "x", rank: 1 },
      { id: "y", rank: 2 },
    ]);
  });

  it("a follower with no leader data yet renders empty", async () => {
    const h = harness();
    const a = h.spawn();

    await tick();

    const b = h.spawn();

    await tick();

    // A leader with no data has nothing to broadcast, so the follower is simply empty.
    expect(a.query.getSnapshot()).toEqual([]);
    expect(b.query.getSnapshot()).toEqual([]);
  });

  it("closes a follower's channel on disconnect without disturbing the leader", async () => {
    const h = harness();
    const a = h.spawn();

    await tick();

    const b = h.spawn();

    await tick();

    b.query.disconnect();

    emitSnapshot(a, [{ id: "x", rank: 1 }]);

    // The leader updates; the disconnected follower no longer receives broadcasts.
    expect(a.query.getSnapshot()).toEqual([{ id: "x", rank: 1 }]);
    expect(b.query.getSnapshot()).toEqual([]);
  });

  it("leaves a durable leader store's hydrated slice authoritative (no seed-over) and disposes it", async () => {
    const h = harness();

    // A "durable" leader store that comes up already holding a persisted slice.
    const hydrated = createLiveStore(def);

    hydrated.applySnapshot([{ id: "persisted", rank: 5 }], "v1:sysA:1:99");

    const dispose = vi.fn();
    const createLeaderStore = (): LeaderStore => ({ store: hydrated, dispose });

    const a = h.spawn({ createLeaderStore });

    await tick();

    // The hydrated slice was NOT overwritten by an (empty) follower seed.
    expect(a.query.getSnapshot()).toEqual([{ id: "persisted", rank: 5 }]);
    // It resumed from the hydrated cursor.
    expect(a.live.sources[0]!.url).toContain(`lastEventId=${encodeURIComponent("v1:sysA:1:99")}`);

    a.query.disconnect();
    await tick();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("forwards a leader stream error to onStreamError", async () => {
    const h = harness();
    const onStreamError = vi.fn();
    const a = h.spawn({ onStreamError });

    await tick();

    a.live.sources[0]!.emit("error", "");
    expect(onStreamError).toHaveBeenCalledTimes(1);
  });

  it("reports a leadership setup failure to onError and yields the lock", async () => {
    const h = harness();
    const onError = vi.fn();
    const boom = new Error("OPFS open failed");

    const a = h.spawn({
      onError,
      createLeaderStore: () => {
        throw boom;
      },
    });

    await tick();

    expect(onError).toHaveBeenCalledWith(boom);
    // The failed leader never opened a connection …
    expect(a.live.sources).toHaveLength(0);

    // … and gave the lock back, so the next tab wins it.
    const b = h.spawn();

    await tick();

    expect(b.live.sources).toHaveLength(1);

    // The failed tab RECOVERS as a follower — its `acting` was reset on the throw, so it mirrors the
    // new leader's broadcasts rather than becoming a zombie that ignores them.
    emitSnapshot(b, [{ id: "x", rank: 1 }]);
    expect(a.query.getSnapshot()).toEqual([{ id: "x", rank: 1 }]);
  });

  it("abandons the half-built term when disconnect() lands during the async store open", async () => {
    const h = harness();
    const dispose = vi.fn();

    // Gate the leader-store open so we can disconnect mid-`await createLeaderStore()`.
    let openLeaderStore!: () => void;
    const opened = new Promise<void>((resolve) => {
      openLeaderStore = resolve;
    });
    const createLeaderStore = async (): Promise<LeaderStore> => {
      await opened;

      return { store: createLiveStore(def), dispose };
    };

    const a = h.spawn({ createLeaderStore });

    // The lock is granted and `onLeadership` is parked at the await; disconnect before the store opens.
    a.query.disconnect();
    openLeaderStore();
    await tick();

    // The half-built term was abandoned: no connection opened, and the just-created store was disposed.
    expect(a.live.sources).toHaveLength(0);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("abandons the half-built term with a dispose-less store during the async open", async () => {
    const h = harness();

    let openLeaderStore!: () => void;
    const opened = new Promise<void>((resolve) => {
      openLeaderStore = resolve;
    });
    // No `dispose` — the in-memory-shaped store; exercises the bail's dispose-absent path.
    const createLeaderStore = async (): Promise<LeaderStore> => {
      await opened;

      return { store: createLiveStore(def) };
    };

    const a = h.spawn({ createLeaderStore });

    a.query.disconnect();
    openLeaderStore();
    await tick();

    expect(a.live.sources).toHaveLength(0);
  });

  it("reports a rejecting dispose to onError instead of leaking an unhandled rejection", async () => {
    const h = harness();
    const onError = vi.fn();
    const boom = new Error("OPFS close failed");
    const createLeaderStore = (): LeaderStore => ({
      store: createLiveStore(def),
      dispose: () => Promise.reject(boom),
    });

    const a = h.spawn({ onError, createLeaderStore });

    await tick();

    a.query.disconnect();
    await tick();

    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("reports a publish (structured-clone) failure to onError without aborting frame processing", async () => {
    // A channel whose `postMessage` throws on a snapshot (an unclonable optimistic row would do this
    // in a real browser) but not on the `hello` handshake, so construction still succeeds.
    const requestLock = fakeLocks();
    const { openChannel } = broadcastBus();
    const environment: CrossTabEnvironment = {
      requestLock,
      openChannel(name) {
        const inner = openChannel(name);

        return {
          ...inner,
          postMessage: (message) => {
            if ((message as { t?: string }).t === "snapshot") throw new Error("DataCloneError");

            inner.postMessage(message);
          },
        };
      },
    };

    const onError = vi.fn();
    const live = fakeLive();
    const query = createCrossTabLiveQuery(def, {
      environment,
      liveEnvironment: live.env,
      onError,
    });

    await tick();

    // The leader's initial `publish()` throws inside the store notification; it is caught and reported,
    // and the frame still applied (the store is not left half-updated).
    live.sources[0]!.emit("snapshot", JSON.stringify({ rows: [{ id: "x", rank: 1 }] }));
    expect(onError).toHaveBeenCalled();
    expect(query.getSnapshot()).toEqual([{ id: "x", rank: 1 }]);

    query.disconnect();
  });

  it("resumes from the cursor when the promoted follower's mirrored view is empty-but-cursored", async () => {
    const h = harness();
    const a = h.spawn();

    await tick();

    const b = h.spawn();

    await tick();

    // The leader reaches an EMPTY slice at an advanced cursor (every row deleted), and the follower
    // mirrors that (0 rows, real cursor).
    emitSnapshot(a, [], "v1:sysA:1:77");
    expect(b.query.getSnapshot()).toEqual([]);

    a.query.disconnect();
    await tick();

    // The promoted follower seeds the cursor even with no rows, so it RESUMES rather than re-snapshots.
    expect(b.live.sources[0]!.url).toContain(`lastEventId=${encodeURIComponent("v1:sysA:1:77")}`);
  });

  it("ignores a malformed / wrong-shape frame delivered to a follower", async () => {
    const h = harness();
    const a = h.spawn();

    await tick();

    const b = h.spawn();

    await tick();

    emitSnapshot(a, [{ id: "x", rank: 1 }]);
    expect(b.query.getSnapshot()).toEqual([{ id: "x", rank: 1 }]);

    // A rogue peer posts junk on the follower's channel: a bad `t`, and a snapshot with a non-array
    // `rows`. Both are ignored (the narrowing guard), so the follower keeps its last good slice and
    // `applySnapshot` never throws on malformed data.
    const rogue = h.openChannel(`lesto-live:${shapeId(def)}`);

    rogue.postMessage({ t: "bogus" });
    rogue.postMessage({ t: "snapshot", rows: 42, cursor: "" });

    expect(b.query.getSnapshot()).toEqual([{ id: "x", rank: 1 }]);
  });

  it("routes the leader's connection through a custom path", async () => {
    const h = harness();
    const a = h.spawn({ path: "/custom-live" });

    await tick();

    expect(a.live.sources[0]!.url).toBe(
      `/custom-live?shape=${encodeURIComponent(serializeShapeDefinition(def))}`,
    );
  });

  it("respects custom lock/channel names, ignores a rogue snapshot while leading, and tolerates junk", async () => {
    const h = harness();
    const a = h.spawn({ lockName: "lk", channelName: "ch" });

    await tick();

    emitSnapshot(a, [{ id: "x", rank: 1 }]);
    expect(a.query.getSnapshot()).toEqual([{ id: "x", rank: 1 }]);

    // A rogue peer on the same channel: the leader ignores a snapshot (it owns the truth) and an
    // empty message is dropped by the `message === undefined` guard.
    const rogue = h.openChannel("ch");

    rogue.postMessage({ t: "snapshot", rows: [{ id: "evil", rank: 9 }], cursor: "" });
    rogue.postMessage(undefined);
    // A follower receiving a hello (its `leaderPublish` is undefined) is a no-op.
    const b = h.spawn({ lockName: "lk", channelName: "ch" });

    await tick();
    rogue.postMessage({ t: "hello" });

    expect(a.query.getSnapshot()).toEqual([{ id: "x", rank: 1 }]);
    expect(b.query.getSnapshot()).toEqual([{ id: "x", rank: 1 }]);
  });

  it("notifies subscribers on a mutation and stops after unsubscribe", async () => {
    const h = harness();
    const a = h.spawn();

    await tick();

    const listener = vi.fn();
    const unsubscribe = a.query.subscribe(listener);

    emitSnapshot(a, [{ id: "x", rank: 1 }]);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    emitSnapshot(a, [{ id: "y", rank: 2 }]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("uses browserCrossTabEnvironment + browser EventSource by default (stubbed globals)", async () => {
    // Stub the three browser globals the all-defaults path reaches: Web Locks, BroadcastChannel,
    // EventSource. This covers the `?? browserCrossTabEnvironment` default AND the omitted
    // liveEnvironment/path branches in one integration pass.
    const requestLock = fakeLocks();
    const { openChannel } = broadcastBus();

    class FakeBroadcastChannel {
      private readonly seam: BroadcastChannelSeam;

      constructor(name: string) {
        this.seam = openChannel(name);
      }

      postMessage(message: unknown): void {
        this.seam.postMessage(message);
      }

      addEventListener(type: "message", listener: (event: { data: unknown }) => void): void {
        this.seam.addEventListener(type, listener);
      }

      close(): void {
        this.seam.close();
      }
    }

    const eventSources: { url: string; listeners: Map<string, (e: LiveMessageEvent) => void> }[] =
      [];

    class FakeEventSource {
      listeners = new Map<string, (e: LiveMessageEvent) => void>();

      constructor(public url: string) {
        eventSources.push(this);
      }

      addEventListener(type: string, listener: (e: LiveMessageEvent) => void): void {
        this.listeners.set(type, listener);
      }

      close(): void {}
    }

    vi.stubGlobal("navigator", { locks: { request: requestLock } });
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    vi.stubGlobal("EventSource", FakeEventSource);

    const query = createCrossTabLiveQuery(def);

    await tick();

    // The default env elected this tab leader and opened a browser EventSource connection.
    expect(eventSources).toHaveLength(1);

    eventSources[0]!.listeners.get("snapshot")!({
      data: JSON.stringify({ rows: [{ id: "x", rank: 1 }] }),
      lastEventId: "",
    });
    expect(query.getSnapshot()).toEqual([{ id: "x", rank: 1 }]);

    query.disconnect();
  });

  it("exposes browserCrossTabEnvironment as the default seam", () => {
    // Drive the default seam's methods directly, like consumer.test's browserLiveEnvironment check.
    const posted: unknown[] = [];
    const received: unknown[] = [];
    let closed = false;

    class FakeBroadcastChannel {
      constructor(public name: string) {}

      postMessage(message: unknown): void {
        posted.push(message);
      }

      addEventListener(_type: string, listener: (e: { data: unknown }) => void): void {
        listener({ data: { t: "hello" } });
      }

      close(): void {
        closed = true;
      }
    }

    const request = vi.fn(() => Promise.resolve());

    vi.stubGlobal("navigator", { locks: { request } });
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);

    const channel = browserCrossTabEnvironment.openChannel(`lesto-live:${shapeId(def)}`);

    channel.addEventListener("message", (event) => received.push(event.data));
    channel.postMessage({ t: "hello" });
    channel.close();

    expect(posted).toEqual([{ t: "hello" }]);
    expect(received).toEqual([{ t: "hello" }]);
    expect(closed).toBe(true);

    void browserCrossTabEnvironment.requestLock("L", {}, noopCallback);
    expect(request).toHaveBeenCalledWith("L", {}, noopCallback);
  });
});
