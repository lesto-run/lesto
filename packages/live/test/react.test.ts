// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { createLiveQuery } from "../src/index";
import type { LiveEnvironment, LiveQuery, Row, ShapeDefinition } from "../src/index";
import { useLiveQuery } from "../src/react";

const def: ShapeDefinition = {
  table: "todos",
  key: "id",
  columns: ["id", "text"],
  where: [],
  orderBy: undefined,
};

/** A fake `EventSource` seam that records each open as a distinct source and emits by hand. */
function fakeEnv() {
  const sources: Array<{
    url: string;
    listeners: Map<string, (event: { data: string }) => void>;
    closed: boolean;
  }> = [];

  const environment: LiveEnvironment = {
    open(url) {
      const source = {
        url,
        listeners: new Map<string, (event: { data: string }) => void>(),
        closed: false,
      };
      sources.push(source);

      return {
        addEventListener: (type, listener) => source.listeners.set(type, listener),
        close: () => {
          source.closed = true;
        },
      };
    },
  };

  return {
    environment,
    sources,
    emit: (index: number, type: string, data: string) =>
      sources[index]?.listeners.get(type)?.({ data }),
  };
}

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

/** Mount an element into jsdom, returning its root so a test can unmount it by hand. */
function mount(element: ReturnType<typeof createElement>): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  act(() => root.render(element));

  return root;
}

// The latest rows the hook returned — captured module-side so a test can assert on them.
let latest: readonly Row[] = [];

function Probe({ create }: { create: () => LiveQuery<Row> }): null {
  latest = useLiveQuery(create);

  return null;
}

describe("useLiveQuery", () => {
  it("opens the stream on mount, re-renders on a frame, and disconnects on unmount", () => {
    const fake = fakeEnv();
    const create = (): LiveQuery<Row> => createLiveQuery(def, { environment: fake.environment });

    const root = mount(createElement(Probe, { create }));

    // The effect ran (client-only): one stream open, empty until a frame arrives.
    expect(fake.sources).toHaveLength(1);
    expect(latest).toEqual([]);

    act(() => {
      fake.emit(
        0,
        "snapshot",
        JSON.stringify({
          rows: [
            { id: 1, text: "a" },
            { id: 2, text: "b" },
          ],
        }),
      );
    });
    expect(latest.map((row) => row.id)).toEqual([1, 2]);

    act(() => root.unmount());
    roots.length = 0; // already unmounted; keep afterEach from double-unmounting
    expect(fake.sources[0]!.closed).toBe(true);
  });

  it("reopens the stream when deps change, tearing down the previous one", () => {
    const fake = fakeEnv();

    function KeyedProbe(): null {
      const [n, setN] = useState(0);
      useLiveQuery(() => createLiveQuery(def, { environment: fake.environment }), [n]);
      // Expose a setter so the test can bump the dep from inside `act`.
      bump = () => setN((value) => value + 1);

      return null;
    }

    mount(createElement(KeyedProbe));
    expect(fake.sources).toHaveLength(1);

    act(() => bump());

    // The dep changed: the old stream closed and a fresh one opened.
    expect(fake.sources).toHaveLength(2);
    expect(fake.sources[0]!.closed).toBe(true);
    expect(fake.sources[1]!.closed).toBe(false);
  });

  it("does not reopen the stream on an unrelated re-render (the factory is read via a ref)", () => {
    const fake = fakeEnv();

    function StableProbe(): null {
      const [, setTick] = useState(0);
      // A NEW factory closure every render, but default deps `[]` → created once.
      useLiveQuery(() => createLiveQuery(def, { environment: fake.environment }));
      rerender = () => setTick((value) => value + 1);

      return null;
    }

    mount(createElement(StableProbe));
    expect(fake.sources).toHaveLength(1);

    act(() => rerender());
    act(() => rerender());

    // Still one stream — a re-render did not reopen it.
    expect(fake.sources).toHaveLength(1);
  });
});

// Setters the probes publish so a test can trigger a re-render / dep bump from inside `act`.
let bump: () => void = () => {};
let rerender: () => void = () => {};
