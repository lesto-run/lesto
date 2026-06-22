// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultQueryClient,
  QueryClient,
  serializeQueryKey,
  useMutation,
  useQuery,
} from "../src/index";
import type { MutationResultApi, QueryResult } from "../src/index";

// A promise whose resolution the test controls — lets us assert the loading state
// BETWEEN the render that kicks the fetch and the settle that resolves it.
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// React render harness (mirrors hydrate.test.tsx): mount a probe into jsdom and
// expose the hook's latest return through a mutable ref so a test can read state
// and call the imperative `refetch`/`mutate`.
// ---------------------------------------------------------------------------
const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());

  vi.restoreAllMocks();
});

function mount(element: ReturnType<typeof createElement>): void {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  act(() => root.render(element));
}

describe("serializeQueryKey", () => {
  it("returns a string key verbatim and JSON-encodes a tuple key", () => {
    expect(serializeQueryKey("listing:3")).toBe("listing:3");
    expect(serializeQueryKey(["listing", 3, true])).toBe('["listing",3,true]');
  });
});

describe("QueryClient — cache, dedupe, invalidation", () => {
  it("returns the one frozen idle snapshot for an unknown key", () => {
    const client = new QueryClient();
    const snap = client.getSnapshot("missing");

    expect(snap).toEqual({ status: "idle" });
    // Same shared reference every read (so useSyncExternalStore never loops).
    expect(client.getSnapshot("other")).toBe(snap);
  });

  it("notifies subscribers on publish and prunes the set on the last unsubscribe", () => {
    const client = new QueryClient();
    const a = vi.fn();
    const b = vi.fn();

    const offA = client.subscribe("k", a);
    const offB = client.subscribe("k", b);

    client.setData("k", 1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offA(); // set still has `b` → kept
    client.setData("k", 2);
    expect(a).toHaveBeenCalledTimes(1); // no longer notified
    expect(b).toHaveBeenCalledTimes(2);

    offB(); // set now empty → pruned; a later publish notifies no one (no listeners)
    expect(() => client.setData("k", 3)).not.toThrow();
  });

  it("reads cached data, or undefined for an unknown key", () => {
    const client = new QueryClient();

    expect(client.getData("k")).toBeUndefined();
    client.setData("k", { id: "3" });
    expect(client.getData("k")).toEqual({ id: "3" });
  });

  it("dedupes concurrent fetches of the same key into one request", async () => {
    const client = new QueryClient();
    const fetcher = vi.fn(() => Promise.resolve("v"));

    const [a, b] = await Promise.all([client.fetch("k", fetcher), client.fetch("k", fetcher)]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a).toBe("v");
    expect(b).toBe("v");
    expect(client.getSnapshot("k")).toEqual({ status: "success", data: "v" });
  });

  it("shows loading with NO prior data on first load, and stale-then-fresh on refetch", async () => {
    const client = new QueryClient();
    const first = deferred<string>();

    const p1 = client.fetch("k", () => first.promise);
    expect(client.getSnapshot("k")).toEqual({ status: "loading", data: undefined });

    first.resolve("one");
    await p1;
    expect(client.getSnapshot("k")).toEqual({ status: "success", data: "one" });

    // Refetch (settled key → fresh request): the prior value stays visible while loading.
    const second = deferred<string>();
    const p2 = client.fetch("k", () => second.promise);
    expect(client.getSnapshot("k")).toEqual({ status: "loading", data: "one" });

    second.resolve("two");
    await p2;
    expect(client.getSnapshot("k")).toEqual({ status: "success", data: "two" });
  });

  it("publishes an error snapshot and re-throws to a direct awaiter (no unhandledrejection)", async () => {
    const client = new QueryClient();
    const boom = new Error("down");

    await expect(client.fetch("k", () => Promise.reject(boom))).rejects.toBe(boom);
    expect(client.getSnapshot("k")).toEqual({ status: "error", error: boom });
  });

  it("invalidate refetches a known key with its last fetcher", async () => {
    const client = new QueryClient();
    const fetcher = vi.fn(() => Promise.resolve("fresh"));

    await client.fetch("k", fetcher);
    await client.invalidate("k");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(client.getSnapshot("k")).toEqual({ status: "success", data: "fresh" });
  });

  it("invalidate on a never-fetched key resets it to idle and returns undefined", () => {
    const client = new QueryClient();
    client.setData("k", "stale");

    const result = client.invalidate("k");

    expect(result).toBeUndefined();
    expect(client.getSnapshot("k")).toEqual({ status: "idle" });
  });
});

describe("useQuery", () => {
  it("kicks the fetch from an effect, shows loading, then the data", async () => {
    const client = new QueryClient();
    const d = deferred<{ title: string }>();
    const fetcher = vi.fn(() => d.promise);
    const ref: { current: QueryResult<{ title: string }> | null } = { current: null };

    function Probe(): null {
      ref.current = useQuery("listing", fetcher, { client });

      return null;
    }

    mount(createElement(Probe));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ref.current?.isLoading).toBe(true);
    expect(ref.current?.data).toBeUndefined();

    await act(async () => {
      d.resolve({ title: "Loft" });
      await d.promise;
    });

    expect(ref.current?.isLoading).toBe(false);
    expect(ref.current?.data).toEqual({ title: "Loft" });
  });

  it("surfaces a rejected fetch as `error` with isLoading false", async () => {
    const client = new QueryClient();
    const d = deferred<string>();
    const ref: { current: QueryResult<string> | null } = { current: null };

    function Probe(): null {
      ref.current = useQuery("k", () => d.promise, { client });

      return null;
    }

    mount(createElement(Probe));

    await act(async () => {
      d.reject(new Error("nope"));
      await d.promise.catch(() => {});
    });

    expect(ref.current?.isLoading).toBe(false);
    expect((ref.current?.error as Error | undefined)?.message).toBe("nope");
  });

  it("dedupes at mount — two components on one key fetch once", () => {
    const client = new QueryClient();
    const fetcher = vi.fn(() => new Promise<string>(() => {}));

    function Probe(): null {
      useQuery("shared", fetcher, { client });

      return null;
    }

    mount(createElement("div", null, createElement(Probe), createElement(Probe)));

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refetch forces a fresh request", async () => {
    const client = new QueryClient();
    let n = 0;
    const fetcher = vi.fn(() => Promise.resolve(`v${(n += 1)}`));
    const ref: { current: QueryResult<string> | null } = { current: null };

    function Probe(): null {
      ref.current = useQuery("k", fetcher, { client });

      return null;
    }

    mount(createElement(Probe));
    await act(async () => {
      await Promise.resolve();
    });
    expect(ref.current?.data).toBe("v1");

    await act(async () => {
      ref.current?.refetch();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ref.current?.data).toBe("v2");
  });

  it("re-subscribes when the key changes", async () => {
    const client = new QueryClient();
    const fetcher = vi.fn((id: string) => Promise.resolve(`data:${id}`));
    let setId: ((id: string) => void) | undefined;
    const ref: { current: QueryResult<string> | null } = { current: null };

    function Probe(): null {
      const [id, set] = useState("a");
      setId = set;
      ref.current = useQuery(["item", id], () => fetcher(id), { client });

      return null;
    }

    mount(createElement(Probe));
    await act(async () => {
      await Promise.resolve();
    });
    expect(ref.current?.data).toBe("data:a");

    await act(async () => {
      setId?.("b");
      await Promise.resolve();
    });

    expect(ref.current?.data).toBe("data:b");
    expect(fetcher).toHaveBeenCalledWith("b");
  });

  it("uses the default shared client when none is supplied", async () => {
    const key = `default-client-test-${serializeQueryKey(["k", 1])}`;
    const ref: { current: QueryResult<string> | null } = { current: null };

    function Probe(): null {
      ref.current = useQuery(key, () => Promise.resolve("via-default"));

      return null;
    }

    mount(createElement(Probe));
    await act(async () => {
      await Promise.resolve();
    });

    expect(ref.current?.data).toBe("via-default");
    expect(defaultQueryClient.getData(key)).toBe("via-default");
  });
});

describe("useMutation", () => {
  function setup<I, T>(
    fn: (input: I) => Promise<T>,
    options?: Parameters<typeof useMutation<I, T>>[1],
  ): { current: MutationResultApi<I, T> | null } {
    const ref: { current: MutationResultApi<I, T> | null } = { current: null };

    function Probe(): null {
      ref.current = useMutation(fn, options);

      return null;
    }

    mount(createElement(Probe));

    return ref;
  }

  it("runs an optimistic update, succeeds, and invokes onSuccess", async () => {
    const rollback = vi.fn();
    const onMutate = vi.fn(() => rollback);
    const onSuccess = vi.fn();

    const ref = setup(async (input: { note: string }) => ({ saved: input.note }), {
      onMutate,
      onSuccess,
    });

    let returned: unknown;
    await act(async () => {
      returned = await ref.current?.mutate({ note: "hi" });
    });

    expect(onMutate).toHaveBeenCalledWith({ note: "hi" });
    expect(rollback).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledWith({ saved: "hi" }, { note: "hi" });
    expect(ref.current?.data).toEqual({ saved: "hi" });
    expect(ref.current?.isPending).toBe(false);
    expect(returned).toEqual({ saved: "hi" });
  });

  it("flips isPending true while the request is in flight", async () => {
    const d = deferred<string>();
    const ref = setup(() => d.promise);

    act(() => {
      void ref.current?.mutate(undefined as never);
    });
    expect(ref.current?.isPending).toBe(true);

    await act(async () => {
      d.resolve("done");
      await d.promise;
    });
    expect(ref.current?.isPending).toBe(false);
    expect(ref.current?.data).toBe("done");
  });

  it("rolls back the optimistic update and reports the error on failure", async () => {
    const rollback = vi.fn();
    const onError = vi.fn();
    const boom = new Error("rejected");

    const ref = setup(() => Promise.reject(boom), { onMutate: () => rollback, onError });

    let returned: unknown = "sentinel";
    await act(async () => {
      returned = await ref.current?.mutate("x");
    });

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom, "x");
    expect(ref.current?.error).toBe(boom);
    expect(ref.current?.status).toBe("error");
    expect(returned).toBeUndefined();
  });

  it("skips rollback when onMutate returns nothing", async () => {
    const ref = setup(() => Promise.reject(new Error("e")), { onMutate: () => undefined });

    await act(async () => {
      await ref.current?.mutate("x");
    });

    expect(ref.current?.status).toBe("error");
  });

  it("works with no options on both the success and error paths", async () => {
    const okRef = setup((input: number) => Promise.resolve(input * 2));
    await act(async () => {
      await okRef.current?.mutate(21);
    });
    expect(okRef.current?.data).toBe(42);

    const errRef = setup(() => Promise.reject(new Error("e")));
    await act(async () => {
      await errRef.current?.mutate(undefined as never);
    });
    expect(errRef.current?.status).toBe("error");
  });

  it("reset clears back to idle", async () => {
    const ref = setup((input: string) => Promise.resolve(input));

    await act(async () => {
      await ref.current?.mutate("v");
    });
    expect(ref.current?.status).toBe("success");

    act(() => ref.current?.reset());
    expect(ref.current?.status).toBe("idle");
    expect(ref.current?.data).toBeUndefined();
  });
});
