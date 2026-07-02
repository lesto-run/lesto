import { serializeShapeDefinition } from "@lesto/live-protocol";
import type { ShapeDefinition } from "@lesto/live-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLiveQuery } from "../src/index";
import type { LiveEnvironment, LiveEventSource, LiveMessageEvent } from "../src/index";

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
});
