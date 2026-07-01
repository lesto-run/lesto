// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserLiveEnvironment,
  connectLive,
  defaultQueryClient,
  QueryClient,
  useLive,
} from "../src/index";
import type { LiveEnvironment, LiveEventSource, LiveMessageEvent } from "../src/index";

// A driveable fake stream: records the opened URL, lets a test fire named events by
// hand, and records the close. One `open` per `connectLive` call.
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

// A stub for the browser's native `EventSource` (jsdom has none), so the default
// `browserLiveEnvironment` path is exercised. Captures each constructed instance.
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

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());

  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// A probe that captures nothing (module-scope, so it is not recreated per render):
// exercises `useLive`'s no-options path over the default browser seam.
function BareProbe(): null {
  useLive(["y"]);

  return null;
}

// Mount a probe into jsdom and return its root so a test can unmount it by hand.
function mount(element: ReturnType<typeof createElement>): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  act(() => root.render(element));

  return root;
}

describe("connectLive", () => {
  it("opens the live path with the encoded topics and invalidates on an `invalidate` frame", () => {
    const client = new QueryClient();
    const invalidateTopic = vi.spyOn(client, "invalidateTopic");
    const { env, sources } = fakeLive();

    const off = connectLive({
      topics: ["org:1:posts", "org:1:comments"],
      client,
      environment: env,
    });

    expect(sources).toHaveLength(1);
    expect(sources[0]!.url).toBe("/__lesto/live?topics=org%3A1%3Aposts%2Corg%3A1%3Acomments");

    sources[0]!.emit("invalidate", "org:1:posts");
    expect(invalidateTopic).toHaveBeenCalledWith("org:1:posts");

    off();
    expect(sources[0]!.closed).toBe(true);
  });

  it("refetches every subscribed topic on a `resync` frame", () => {
    const client = new QueryClient();
    const invalidateTopics = vi.spyOn(client, "invalidateTopics");
    const { env, sources } = fakeLive();

    connectLive({ topics: ["a", "b"], client, environment: env });

    sources[0]!.emit("resync", "");
    expect(invalidateTopics).toHaveBeenCalledWith(["a", "b"]);
  });

  it("forwards a stream error to onError, on a custom path", () => {
    const onError = vi.fn();
    const { env, sources } = fakeLive();

    connectLive({
      topics: ["a"],
      client: new QueryClient(),
      environment: env,
      path: "/live",
      onError,
    });

    expect(sources[0]!.url).toBe("/live?topics=a");

    sources[0]!.emit("error", "");
    expect(onError).toHaveBeenCalledWith({ data: "" });
  });

  it("defaults to the shared defaultQueryClient when no client is given", () => {
    const invalidateTopic = vi.spyOn(defaultQueryClient, "invalidateTopic");
    const { env, sources } = fakeLive();

    connectLive({ topics: ["t"], environment: env });

    sources[0]!.emit("invalidate", "t");
    expect(invalidateTopic).toHaveBeenCalledWith("t");
  });

  it("uses the browser EventSource when no environment is given", () => {
    const { instances } = stubEventSource();
    const client = new QueryClient();
    const invalidateTopic = vi.spyOn(client, "invalidateTopic");

    const off = connectLive({ topics: ["z"], client });

    expect(instances[0]!.url).toBe("/__lesto/live?topics=z");

    // Fire the native event through the wrapper the default environment registered.
    instances[0]!.listeners.get("invalidate")!({ data: "z" });
    expect(invalidateTopic).toHaveBeenCalledWith("z");

    off();
    expect(instances[0]!.closed).toBe(true);
  });

  it("exposes browserLiveEnvironment as the default seam", () => {
    // Same coverage of the default seam, but through the exported value directly.
    const { instances } = stubEventSource();

    const source = browserLiveEnvironment.open("/__lesto/live?topics=x");
    expect(instances).toHaveLength(1);

    source.close();
    expect(instances[0]!.closed).toBe(true);
  });
});

describe("useLive", () => {
  it("subscribes on mount and disconnects on unmount", () => {
    const { env, sources } = fakeLive();
    const client = new QueryClient();

    function Probe(): null {
      useLive(["a", "b"], { environment: env, client });

      return null;
    }

    const root = mount(createElement(Probe));

    expect(sources).toHaveLength(1);
    expect(sources[0]!.url).toContain("topics=a%2Cb");
    expect(sources[0]!.closed).toBe(false);

    act(() => root.unmount());
    expect(sources[0]!.closed).toBe(true);
  });

  it("re-subscribes only when the topic SET changes", () => {
    const { env, sources } = fakeLive();
    const client = new QueryClient();

    let setTopics!: (topics: string[]) => void;

    function Probe(): null {
      const [topics, setter] = useState<string[]>(["a"]);
      setTopics = setter;
      useLive(topics, { environment: env, client });

      return null;
    }

    mount(createElement(Probe));
    expect(sources).toHaveLength(1);

    // A change to the SET tears down the old stream and opens a new one.
    act(() => setTopics(["a", "b"]));
    expect(sources).toHaveLength(2);
    expect(sources[0]!.closed).toBe(true);
    expect(sources[1]!.url).toContain("topics=a%2Cb");

    // Re-rendering with the SAME set does not reopen (the effect key is unchanged).
    act(() => setTopics(["a", "b"]));
    expect(sources).toHaveLength(2);
  });

  it("distinguishes topic sets a space-join would collide (unambiguous key)", () => {
    const { env, sources } = fakeLive();
    const client = new QueryClient();

    let setTopics!: (topics: string[]) => void;

    function Probe(): null {
      const [topics, setter] = useState<string[]>(["a b"]);
      setTopics = setter;
      useLive(topics, { environment: env, client });

      return null;
    }

    mount(createElement(Probe));
    expect(sources).toHaveLength(1);

    // `["a b"]` and `["a", "b"]` share a SPACE-joined key but are different sets — the
    // comma-joined key keeps them distinct, so this reopens the stream.
    act(() => setTopics(["a", "b"]));
    expect(sources).toHaveLength(2);
    expect(sources[0]!.closed).toBe(true);
  });

  it("threads path + onError through and holds without an explicit client", () => {
    const onError = vi.fn();
    const { env, sources } = fakeLive();

    function Probe(): null {
      useLive(["x"], { environment: env, path: "/sse", onError });

      return null;
    }

    mount(createElement(Probe));

    expect(sources[0]!.url).toBe("/sse?topics=x");

    sources[0]!.emit("error", "");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("opens with the browser defaults when called with no options", () => {
    const { instances } = stubEventSource();

    mount(createElement(BareProbe));

    expect(instances[0]!.url).toBe("/__lesto/live?topics=y");
  });
});
