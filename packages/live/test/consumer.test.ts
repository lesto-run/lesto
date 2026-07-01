import { serializeShapeDefinition } from "@lesto/live-protocol";
import type { ShapeDefinition } from "@lesto/live-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserLiveEnvironment,
  connectLiveData,
  createLiveStore,
  DEFAULT_LIVE_DATA_PATH,
} from "../src/index";
import type { LiveEnvironment, LiveEventSource, LiveMessageEvent } from "../src/index";

const def: ShapeDefinition = {
  table: "posts",
  key: "id",
  columns: ["id", "rank"],
  where: [],
  orderBy: { column: "rank", direction: "asc" },
};

// The URL `connectLiveData` builds for `def` — the encoded serialized shape in the query.
const expectedUrl = (path: string): string =>
  `${path}?shape=${encodeURIComponent(serializeShapeDefinition(def))}`;

// A driveable fake stream: records the opened URL, lets a test fire named events by hand,
// and records the close. One `open` per `connectLiveData` call.
interface FakeSource extends LiveEventSource {
  url: string;
  closed: boolean;
  emit(type: string, data: string): void;
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
        emit: (type, data) => listeners.get(type)?.({ data }),
      };

      sources.push(source);

      return source;
    },
  };

  return { env, sources };
}

// A stub for the browser's native `EventSource`, so the default `browserLiveEnvironment`
// path is exercised without a real one. Captures each constructed instance.
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

describe("connectLiveData", () => {
  it("opens with the encoded shape and applies a snapshot into the store", () => {
    const store = createLiveStore(def);
    const { env, sources } = fakeLive();

    const off = connectLiveData({ def, store, environment: env });

    expect(sources).toHaveLength(1);
    expect(sources[0]!.url).toBe(expectedUrl(DEFAULT_LIVE_DATA_PATH));

    sources[0]!.emit("snapshot", JSON.stringify({ rows: [{ id: "a", rank: 1 }] }));
    expect(store.getRows()).toEqual([{ id: "a", rank: 1 }]);

    off();
    expect(sources[0]!.closed).toBe(true);
  });

  it("applies a change frame and drops the slice on a resync frame", () => {
    const store = createLiveStore(def);
    const { env, sources } = fakeLive();

    connectLiveData({ def, store, environment: env });

    sources[0]!.emit(
      "change",
      JSON.stringify({ op: "insert", key: "a", row: { id: "a", rank: 1 } }),
    );
    expect(store.getRows()).toEqual([{ id: "a", rank: 1 }]);

    sources[0]!.emit("resync", "");
    expect(store.getRows()).toEqual([]);
  });

  it("resyncs and forwards a malformed snapshot AND change to onError", () => {
    const store = createLiveStore(def);
    const onError = vi.fn();
    const { env, sources } = fakeLive();

    connectLiveData({ def, store, environment: env, onError });

    // Seed a good snapshot, then a corrupt one drops the slice to the safe floor.
    sources[0]!.emit("snapshot", JSON.stringify({ rows: [{ id: "a", rank: 1 }] }));
    sources[0]!.emit("snapshot", "not json");
    expect(store.getRows()).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);

    // A corrupt change is treated the same way — resync, then forward.
    sources[0]!.emit("snapshot", JSON.stringify({ rows: [{ id: "b", rank: 2 }] }));
    sources[0]!.emit("change", "not json");
    expect(store.getRows()).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("resyncs on a malformed frame even with no onError, without throwing", () => {
    const store = createLiveStore(def);
    const { env, sources } = fakeLive();

    connectLiveData({ def, store, environment: env });

    sources[0]!.emit("snapshot", JSON.stringify({ rows: [{ id: "a", rank: 1 }] }));
    sources[0]!.emit("snapshot", "not json");
    expect(store.getRows()).toEqual([]);

    sources[0]!.emit("change", "not json");
    expect(store.getRows()).toEqual([]);
  });

  it("forwards a stream error to onError on a custom path", () => {
    const store = createLiveStore(def);
    const onError = vi.fn();
    const { env, sources } = fakeLive();

    connectLiveData({ def, store, environment: env, path: "/data", onError });

    expect(sources[0]!.url).toBe(expectedUrl("/data"));

    sources[0]!.emit("error", "");
    expect(onError).toHaveBeenCalledWith({ data: "" });
  });

  it("uses the browser EventSource when no environment is given", () => {
    const { instances } = stubEventSource();
    const store = createLiveStore(def);

    const off = connectLiveData({ def, store });

    expect(instances[0]!.url).toBe(expectedUrl(DEFAULT_LIVE_DATA_PATH));

    // Fire the native event through the wrapper the default environment registered.
    instances[0]!.listeners.get("snapshot")!({
      data: JSON.stringify({ rows: [{ id: "a", rank: 1 }] }),
    });
    expect(store.getRows()).toEqual([{ id: "a", rank: 1 }]);

    off();
    expect(instances[0]!.closed).toBe(true);
  });

  it("exposes browserLiveEnvironment as the default seam", () => {
    // Same coverage of the default seam, but through the exported value directly.
    const { instances } = stubEventSource();

    const source = browserLiveEnvironment.open(expectedUrl(DEFAULT_LIVE_DATA_PATH));
    expect(instances).toHaveLength(1);

    source.close();
    expect(instances[0]!.closed).toBe(true);
  });
});
