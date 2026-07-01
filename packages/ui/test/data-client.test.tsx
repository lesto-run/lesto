// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserRevalidationEnvironment,
  defaultQueryClient,
  hydrateQueryClient,
  QueryClient,
  serializeQueryKey,
  useMutation,
  useQuery,
} from "../src/index";
import type { MutationResultApi, QueryResult, RevalidationEnvironment } from "../src/index";

// A fake revalidation seam: capture the focus/online/interval callbacks so a test
// can fire them deterministically, with spies for the unsubscribe/cancel thunks.
function fakeEnv(): {
  environment: RevalidationEnvironment;
  fireFocus: () => void;
  fireReconnect: () => void;
  fireInterval: () => void;
  intervalMs: () => number | undefined;
  cancelInterval: ReturnType<typeof vi.fn>;
} {
  let focus: (() => void) | undefined;
  let reconnect: (() => void) | undefined;
  let interval: (() => void) | undefined;
  let ms: number | undefined;
  const cancelInterval = vi.fn();

  return {
    environment: {
      onFocus(cb) {
        focus = cb;

        return vi.fn();
      },
      onReconnect(cb) {
        reconnect = cb;

        return vi.fn();
      },
      setInterval(cb, every) {
        interval = cb;
        ms = every;

        return cancelInterval;
      },
    },
    fireFocus: () => focus?.(),
    fireReconnect: () => reconnect?.(),
    fireInterval: () => interval?.(),
    intervalMs: () => ms,
    cancelInterval,
  };
}

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

// Mount a `useQuery` with options (the return value is unused — these tests assert
// on the fetcher/client, not the hook result).
function probeQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: Parameters<typeof useQuery<T>>[2],
): void {
  function Probe(): null {
    useQuery(key, fetcher, options);

    return null;
  }

  mount(createElement(Probe));
}

// Let queued microtasks (the mount-effect fetch) settle inside `act`.
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
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

  it("retries on a fresh mount after a transient error (no terminal stale error)", async () => {
    const client = new QueryClient();
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    let call = 0;
    const fetcher = vi.fn(() => (++call === 1 ? d1.promise : d2.promise));
    const ref: { current: QueryResult<string> | null } = { current: null };

    function Probe(): null {
      ref.current = useQuery("listing:9", fetcher, { client });

      return null;
    }

    // First mount → the fetch rejects → the snapshot caches an error.
    const container1 = document.createElement("div");
    document.body.append(container1);
    const root1 = createRoot(container1);
    act(() => root1.render(createElement(Probe)));
    await act(async () => {
      d1.reject(new Error("transient"));
      await d1.promise.catch(() => {});
    });
    expect(client.getSnapshot("listing:9").status).toBe("error");

    // Unmount, then REMOUNT on the same client+key → the effect sees `error` and
    // refetches (where the old `idle`-only guard would have shown a stale error).
    act(() => root1.unmount());
    const container2 = document.createElement("div");
    document.body.append(container2);
    const root2 = createRoot(container2);
    roots.push(root2);
    act(() => root2.render(createElement(Probe)));
    await act(async () => {
      d2.resolve("recovered");
      await d2.promise;
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ref.current?.data).toBe("recovered");
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

  it("invalidates the declared topics on success, refetching subscribed keys", async () => {
    const client = new QueryClient();
    const qf = vi.fn(() => Promise.resolve("list"));
    await client.fetch("list", qf);
    client.registerTopics("list", ["posts"]);

    const ref = setup(async () => "ok", { client, invalidates: ["posts"] });
    await act(async () => {
      await ref.current?.mutate(undefined as never);
    });

    expect(qf).toHaveBeenCalledTimes(2);
  });

  it("does nothing for an empty invalidates list", async () => {
    const client = new QueryClient();
    const qf = vi.fn(() => Promise.resolve("v"));
    await client.fetch("k", qf);
    client.registerTopics("k", ["t"]);

    const ref = setup(async () => "ok", { client, invalidates: [] });
    await act(async () => {
      await ref.current?.mutate(undefined as never);
    });

    expect(qf).toHaveBeenCalledTimes(1);
  });

  it("invalidates on the default client when no client option is given", async () => {
    const qf = vi.fn(() => Promise.resolve("v"));
    await defaultQueryClient.fetch("mut-default-key", qf);
    const off = defaultQueryClient.registerTopics("mut-default-key", ["mut-default-topic"]);

    const ref = setup(async () => "ok", { invalidates: ["mut-default-topic"] });
    await act(async () => {
      await ref.current?.mutate(undefined as never);
    });

    expect(qf).toHaveBeenCalledTimes(2);
    off();
  });
});

describe("QueryClient — topics", () => {
  it("invalidateTopic refetches every key registered to it", async () => {
    const client = new QueryClient();
    const f = vi.fn(() => Promise.resolve("v"));
    await client.fetch("k", f);
    client.registerTopics("k", ["posts"]);

    await client.invalidateTopic("posts");

    expect(f).toHaveBeenCalledTimes(2);
  });

  it("invalidates a key registered under two topics exactly once", async () => {
    const client = new QueryClient();
    const f = vi.fn(() => Promise.resolve("v"));
    await client.fetch("k", f);
    client.registerTopics("k", ["a", "b"]);

    await client.invalidateTopics(["a", "b"]);

    expect(f).toHaveBeenCalledTimes(2); // one extra refetch, not two
  });

  it("invalidateTopic on an unknown topic resolves and refetches nothing", async () => {
    const client = new QueryClient();

    await expect(client.invalidateTopic("nobody")).resolves.toBeUndefined();
  });

  it("resets a registered-but-never-fetched key to idle on topic invalidation", async () => {
    const client = new QueryClient();
    client.setData("k", "stale"); // success, but no remembered fetcher
    client.registerTopics("k", ["t"]);

    await client.invalidateTopic("t");

    expect(client.getSnapshot("k")).toEqual({ status: "idle" });
  });

  it("reference-counts registration: a key leaves a topic only on the last unregister", async () => {
    const client = new QueryClient();
    const f = vi.fn(() => Promise.resolve("v"));
    await client.fetch("k", f);
    const offA = client.registerTopics("k", ["t"]);
    const offB = client.registerTopics("k", ["t"]);

    offA();
    await client.invalidateTopic("t"); // still registered by B
    expect(f).toHaveBeenCalledTimes(2);

    offB();
    await client.invalidateTopic("t"); // last reader gone → no refetch
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("unregister is idempotent (a second call is a no-op)", () => {
    const client = new QueryClient();
    const off = client.registerTopics("k", ["t"]);

    off();
    expect(() => off()).not.toThrow();
  });

  it("a redundant unregister of one key is harmless while another keeps the topic", async () => {
    const client = new QueryClient();
    const f = vi.fn(() => Promise.resolve("v"));
    await client.fetch("k2", f);

    const offK1 = client.registerTopics("k1", ["t"]);
    client.registerTopics("k2", ["t"]); // k2 keeps topic "t" alive

    offK1(); // removes k1
    offK1(); // k1 already gone, "t" still present (k2) — a no-op, not a throw

    await client.invalidateTopic("t");
    expect(f).toHaveBeenCalledTimes(2); // k2 still registered → refetched
  });
});

describe("QueryClient — staleTime / isStale", () => {
  it("treats a never-fetched key as stale", () => {
    const client = new QueryClient();

    expect(client.isStale("k", 1000)).toBe(true);
  });

  it("measures staleness against the injected clock", async () => {
    let now = 1000;
    const client = new QueryClient(() => now);
    await client.fetch("k", () => Promise.resolve("v")); // fetchedAt = 1000

    expect(client.isStale("k", 5000)).toBe(false); // 0 elapsed

    now = 5999; // 4999 elapsed
    expect(client.isStale("k", 5000)).toBe(false);

    now = 6000; // exactly 5000 elapsed
    expect(client.isStale("k", 5000)).toBe(true);
  });
});

describe("useQuery — background revalidation", () => {
  it("revalidates a stale cached key on mount when staleTime is set", async () => {
    let now = 0;
    const client = new QueryClient(() => now);
    const f = vi.fn(() => Promise.resolve("v"));
    await client.fetch("k", f); // fetchedAt 0, 1 call
    now = 10_000;

    probeQuery("k", f, { client, staleTime: 5000 });
    await flush();

    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not revalidate a still-fresh cached key on mount", async () => {
    let now = 0;
    const client = new QueryClient(() => now);
    const f = vi.fn(() => Promise.resolve("v"));
    await client.fetch("k", f);
    now = 1000; // < staleTime

    probeQuery("k", f, { client, staleTime: 5000 });
    await flush();

    expect(f).toHaveBeenCalledTimes(1);
  });

  it("refetches on window focus (no staleTime ⇒ always stale on the event)", async () => {
    const env = fakeEnv();
    const client = new QueryClient();
    const f = vi.fn(() => Promise.resolve("v"));
    await client.fetch("k", f); // cached success, 1 call

    probeQuery("k", f, { client, refetchOnWindowFocus: true, environment: env.environment });
    await flush();

    await act(async () => {
      env.fireFocus();
      await Promise.resolve();
    });

    expect(f).toHaveBeenCalledTimes(2);
  });

  it("refetches on reconnect", async () => {
    const env = fakeEnv();
    const client = new QueryClient();
    const f = vi.fn(() => Promise.resolve("v"));
    await client.fetch("k", f);

    probeQuery("k", f, { client, refetchOnReconnect: true, environment: env.environment });
    await flush();

    await act(async () => {
      env.fireReconnect();
      await Promise.resolve();
    });

    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not refetch on focus while the value is still fresh", async () => {
    let now = 0;
    const env = fakeEnv();
    const client = new QueryClient(() => now);
    const f = vi.fn(() => Promise.resolve("v"));
    await client.fetch("k", f);

    probeQuery("k", f, {
      client,
      refetchOnWindowFocus: true,
      staleTime: 5000,
      environment: env.environment,
    });
    await flush();

    now = 1000; // still fresh
    await act(async () => {
      env.fireFocus();
      await Promise.resolve();
    });

    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not refetch on focus before the first success", async () => {
    const env = fakeEnv();
    const client = new QueryClient();
    const d = deferred<string>();
    const f = vi.fn(() => d.promise);

    probeQuery("k", f, { client, refetchOnWindowFocus: true, environment: env.environment });

    // The mount fetch is in flight (loading), not success → focus is a no-op.
    await act(async () => {
      env.fireFocus();
      await Promise.resolve();
    });
    expect(f).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve("v");
      await d.promise;
    });
  });

  it("registers its topics while mounted so a topic invalidation refetches it", async () => {
    const client = new QueryClient();
    const f = vi.fn(() => Promise.resolve("v"));

    probeQuery("post:1", f, { client, topics: ["posts"] });
    await flush();
    expect(f).toHaveBeenCalledTimes(1); // initial mount load

    await act(async () => {
      await client.invalidateTopic("posts");
    });

    expect(f).toHaveBeenCalledTimes(2); // the mounted reader refetched
  });

  it("registers nothing for an empty topics array", async () => {
    const client = new QueryClient();
    const f = vi.fn(() => Promise.resolve("v"));

    probeQuery("k", f, { client, topics: [] });
    await flush();

    await act(async () => {
      await client.invalidateTopic("anything");
    });

    expect(f).toHaveBeenCalledTimes(1); // never registered → no extra refetch
  });

  it("polls on refetchInterval and cancels the timer on unmount", async () => {
    const env = fakeEnv();
    const client = new QueryClient();
    const f = vi.fn(() => Promise.resolve("v"));

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Probe(): null {
      useQuery("k", f, { client, refetchInterval: 1000, environment: env.environment });

      return null;
    }

    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await Promise.resolve();
    });

    expect(env.intervalMs()).toBe(1000);
    expect(f).toHaveBeenCalledTimes(1); // mount load

    await act(async () => {
      env.fireInterval();
      await Promise.resolve();
    });
    expect(f).toHaveBeenCalledTimes(2); // one poll

    act(() => root.unmount());
    expect(env.cancelInterval).toHaveBeenCalledTimes(1);
  });
});

describe("browserRevalidationEnvironment", () => {
  it("fires onFocus for window focus and a visible visibilitychange, then unsubscribes", () => {
    const cb = vi.fn();
    const off = browserRevalidationEnvironment.onFocus(cb);

    window.dispatchEvent(new Event("focus"));
    expect(cb).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new Event("visibilitychange")); // jsdom default: visible
    expect(cb).toHaveBeenCalledTimes(2);

    off();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("ignores a visibilitychange while the tab is hidden", () => {
    const cb = vi.fn();
    const off = browserRevalidationEnvironment.onFocus(cb);

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cb).not.toHaveBeenCalled();

    Reflect.deleteProperty(document, "visibilityState"); // restore the prototype getter
    off();
  });

  it("fires onReconnect for the online event, then unsubscribes", () => {
    const cb = vi.fn();
    const off = browserRevalidationEnvironment.onReconnect(cb);

    window.dispatchEvent(new Event("online"));
    expect(cb).toHaveBeenCalledTimes(1);

    off();
    window.dispatchEvent(new Event("online"));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("schedules a repeating callback and cancels it", () => {
    vi.useFakeTimers();

    try {
      const cb = vi.fn();
      const cancel = browserRevalidationEnvironment.setInterval(cb, 1000);

      vi.advanceTimersByTime(2500);
      expect(cb).toHaveBeenCalledTimes(2);

      cancel();
      vi.advanceTimersByTime(2000);
      expect(cb).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("QueryClient — prime (SSR seeding from the parse-time primer)", () => {
  it("seeds a key from an in-flight promise: loading, then success — and does NOT remember it as the fetcher", async () => {
    const client = new QueryClient();
    const primer = deferred<string>();

    client.prime("k", primer.promise);
    // The primed key shows loading (the parse-time fetch is still in flight), no data.
    expect(client.getSnapshot("k")).toEqual({ status: "loading", data: undefined });

    primer.resolve("Ada");
    await Promise.resolve();
    expect(client.getSnapshot("k")).toEqual({ status: "success", data: "Ada" });

    // A one-shot primer must never be REPLAYED by invalidate: prime left no fetcher,
    // so invalidating the key (no mounted reader) resets it to idle, not to stale data.
    expect(client.invalidate("k")).toBeUndefined();
    expect(client.getSnapshot("k")).toEqual({ status: "idle" });
  });

  it("lets a useQuery that mounts on a primed key issue no request of its own", async () => {
    const client = new QueryClient();
    const primer = deferred<string>();
    const fetcher = vi.fn(() => Promise.resolve("from-fetcher"));

    client.prime("GET /session", primer.promise);
    // The reader mounts while the primer is still in flight: it observes the `loading`
    // snapshot, so its mount effect kicks no fetch — the primer's result is its value.
    probeQuery("GET /session", fetcher, { client });
    await flush();
    expect(fetcher).not.toHaveBeenCalled();

    primer.resolve("from-primer");
    await flush();
    expect(client.getSnapshot("GET /session")).toEqual({ status: "success", data: "from-primer" });
  });

  it("is a no-op when the key already holds a value (never clobbers live state)", () => {
    const client = new QueryClient();
    const primer = deferred<string>();
    client.setData("k", "existing");

    client.prime("k", primer.promise);

    // Untouched: still the existing success value, not dropped back to loading.
    expect(client.getSnapshot("k")).toEqual({ status: "success", data: "existing" });
  });

  it("is a no-op when a request is already in flight (the live fetch wins)", async () => {
    const client = new QueryClient();
    const inflight = deferred<string>();
    const primer = deferred<string>();

    void client.fetch("k", () => inflight.promise);
    client.prime("k", primer.promise); // ignored — a fetch is already in flight

    inflight.resolve("from-fetch");
    await Promise.resolve();
    expect(client.getSnapshot("k")).toEqual({ status: "success", data: "from-fetch" });

    // The ignored primer never becomes the value, even after it later resolves.
    primer.resolve("from-primer");
    await Promise.resolve();
    expect(client.getSnapshot("k")).toEqual({ status: "success", data: "from-fetch" });
  });

  it("routes a rejected primer to the error snapshot, and can re-prime after an error", async () => {
    const client = new QueryClient();
    const first = deferred<string>();

    client.prime("k", first.promise);
    first.reject(new Error("gone"));
    await Promise.resolve();
    expect(client.getSnapshot("k")).toMatchObject({ status: "error" });

    // Re-prime is allowed once the failed attempt settled (not in flight, no value) —
    // this also exercises priming a key that already carries a (non-success) snapshot.
    const second = deferred<string>();
    client.prime("k", second.promise);
    expect(client.getSnapshot("k")).toEqual({ status: "loading", data: undefined });

    second.resolve("recovered");
    await Promise.resolve();
    expect(client.getSnapshot("k")).toEqual({ status: "success", data: "recovered" });
  });
});

describe("hydrateQueryClient", () => {
  afterEach(() => {
    // Unstub BEFORE touching window (a stubbed `undefined` window can't be indexed).
    vi.unstubAllGlobals();
    delete window.__lestoData;
  });

  it("seeds only the primed sources, mapping each source name to its useQuery key", async () => {
    const client = new QueryClient();
    const session = deferred<string>();
    const items = deferred<string[]>();
    window.__lestoData = { session: session.promise, items: items.promise };

    hydrateQueryClient(client, {
      session: "GET /session",
      items: ["items", 3], // a tuple key is serialized exactly as useQuery serializes it
      missing: "GET /missing", // mapped but not primed → skipped
    });

    // Primed sources are now in flight under their mapped keys...
    expect(client.getSnapshot("GET /session").status).toBe("loading");
    expect(client.getSnapshot(serializeQueryKey(["items", 3])).status).toBe("loading");
    // ...and an unprimed mapped source is left untouched.
    expect(client.getSnapshot("GET /missing")).toEqual({ status: "idle" });

    session.resolve("Ada");
    items.resolve(["a", "b"]);
    await Promise.resolve();
    expect(client.getSnapshot("GET /session")).toEqual({ status: "success", data: "Ada" });
    expect(client.getSnapshot(serializeQueryKey(["items", 3]))).toEqual({
      status: "success",
      data: ["a", "b"],
    });
  });

  it("is a no-op when the primer never ran (window present, no __lestoData)", () => {
    const client = new QueryClient();
    delete window.__lestoData;

    hydrateQueryClient(client, { session: "GET /session" });

    expect(client.getSnapshot("GET /session")).toEqual({ status: "idle" });
  });

  it("is a no-op on the server (no window)", () => {
    const client = new QueryClient();
    vi.stubGlobal("window", undefined);

    expect(() => hydrateQueryClient(client, { session: "GET /session" })).not.toThrow();
    expect(client.getSnapshot("GET /session")).toEqual({ status: "idle" });
  });
});
