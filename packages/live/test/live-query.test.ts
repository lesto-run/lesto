import { serializeShapeDefinition } from "@lesto/live-protocol";
import type { ShapeDefinition } from "@lesto/live-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLiveQuery, createLiveStore, LiveClientError } from "../src/index";
import type { LiveEnvironment, LiveEventSource, LiveMessageEvent, LiveStore } from "../src/index";

const def: ShapeDefinition = {
  table: "posts",
  key: "id",
  columns: ["id", "rank"],
  where: [],
  orderBy: { column: "rank", direction: "asc" },
};

const expectedUrl = (path: string): string =>
  `${path}?shape=${encodeURIComponent(serializeShapeDefinition(def))}`;

// A driveable fake stream, mirroring the consumer test's — one `open` per connection.
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

// A stub for the browser's native `EventSource`, exercising `createLiveQuery`'s no-options
// path over the default browser seam.
interface StubSource {
  url: string;
  listeners: Map<string, (event: LiveMessageEvent) => void>;
  closed: boolean;
}

function stubEventSource(): { instances: StubSource[] } {
  const instances: StubSource[] = [];

  class FakeEventSource implements StubSource {
    listeners = new Map<string, (event: LiveMessageEvent) => void>();

    closed = false;

    constructor(public url: string) {
      instances.push(this);
    }

    addEventListener(type: string, listener: (event: LiveMessageEvent) => void): void {
      this.listeners.set(type, listener);
    }

    close(): void {
      this.closed = true;
    }
  }

  vi.stubGlobal("EventSource", FakeEventSource);

  return { instances };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createLiveQuery", () => {
  it("drives a snapshot and change through the fake source into the handle", () => {
    const { env, sources } = fakeLive();
    const onError = vi.fn();

    const query = createLiveQuery(def, { environment: env, path: "/data", onError });

    expect(sources[0]!.url).toBe(expectedUrl("/data"));

    const listener = vi.fn();
    const off = query.subscribe(listener);

    sources[0]!.emit("snapshot", JSON.stringify({ rows: [{ id: "a", rank: 1 }] }));
    expect(query.getSnapshot()).toEqual([{ id: "a", rank: 1 }]);
    expect(listener).toHaveBeenCalledTimes(1);

    sources[0]!.emit(
      "change",
      JSON.stringify({ op: "insert", key: "b", row: { id: "b", rank: 2 } }),
    );
    expect(query.getSnapshot()).toEqual([
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
    ]);
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    query.disconnect();
    expect(sources[0]!.closed).toBe(true);
  });

  it("opens with the browser defaults when called with no options", () => {
    const { instances } = stubEventSource();

    const query = createLiveQuery(def);

    expect(instances[0]!.url).toBe(expectedUrl("/__lesto/live-data"));

    query.disconnect();
    expect(instances[0]!.closed).toBe(true);
  });

  describe("def/store shape guard", () => {
    // A shape that serializes (and therefore `shapeId`s) differently from `def` — a different
    // table entirely, so there is no risk of an accidental hash collision muddying the test.
    const otherDef: ShapeDefinition = { ...def, table: "comments" };

    it("throws LIVE_STORE_SHAPE_MISMATCH when the store was built from a different shape", () => {
      const store = createLiveStore(otherDef);

      expect(() => createLiveQuery(def, { store })).toThrow(LiveClientError);

      try {
        createLiveQuery(def, { store });
      } catch (error) {
        expect((error as LiveClientError).code).toBe("LIVE_STORE_SHAPE_MISMATCH");
      }
    });

    it("passes when the store's shape matches def", () => {
      const { env, sources } = fakeLive();
      const store = createLiveStore(def);

      // No throw, and the subscription opens exactly as it would with the default store.
      const query = createLiveQuery(def, { store, environment: env });
      expect(sources[0]!.url).toBe(expectedUrl("/__lesto/live-data"));

      query.disconnect();
    });

    it("is unaffected on the default path (no store passed)", () => {
      const { env, sources } = fakeLive();

      // `createLiveQuery` builds its own store from THIS `def`, so `shapeId` trivially matches —
      // no throw, same behavior as before the guard existed.
      const query = createLiveQuery(def, { environment: env });
      expect(sources[0]!.url).toBe(expectedUrl("/__lesto/live-data"));

      query.disconnect();
    });

    it("skips the guard entirely when the store does not expose a shapeId (duck-typed check)", () => {
      const { env, sources } = fakeLive();

      // No hand-rolled `LiveStore` exists elsewhere in the repo, but the field is OPTIONAL on
      // the interface precisely so a store like this — one that never populates it — is not
      // forced to grow it, and is not mistakenly flagged as a mismatch either.
      const bareStore: LiveStore = {
        applySnapshot: () => {},
        applyChange: () => {},
        applyResync: () => {},
        applyOptimistic: () => {},
        clearOptimistic: () => {},
        getRows: () => [],
        getCursor: () => undefined,
        subscribe: () => () => {},
      };

      const query = createLiveQuery(def, { store: bareStore, environment: env });
      expect(sources[0]!.url).toBe(expectedUrl("/__lesto/live-data"));

      query.disconnect();
    });
  });
});
