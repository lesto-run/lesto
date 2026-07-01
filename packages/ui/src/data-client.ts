/**
 * Client data hooks — `useQuery` / `useMutation` over a tiny shared cache.
 *
 * The client-local layer of the reactive data layer (ADR 0027 Phase 1): islands
 * otherwise hand-roll `useState`+`useEffect` to fetch (a re-implemented loading/error
 * machine per island, no sharing) and re-build a mutation client per submit. These
 * hooks replace that with one cache that gives:
 *
 *   - **in-flight dedupe** — N components asking for the same key while a request
 *     is in flight share ONE request, not N;
 *   - **an explicit-invalidation cache** — by KEY (`invalidate(key)`) or by **topic**:
 *     a mutation declares the topics it dirties (`invalidates: ["posts"]`) and a query
 *     subscribes to topics (`useQuery(key, fetcher, { topics: ["posts"] })`). The client
 *     keeps a **topic → keys** registry; invalidating a topic refetches every mounted
 *     reader registered under it. Still EXPLICIT — the writer names the topic; nothing is
 *     schema-inferred. The keyspaces are NOT unified (a `useQuery` key, a `@lesto/client`
 *     `"METHOD /path"` key, and a `defineDataSource` name stay independent); the **topic**
 *     is the addressable unit, decoupled from any key format — which is exactly what the
 *     later server-push phase targets.
 *   - **opt-in background revalidation** — `staleTime`, refetch-on-focus,
 *     refetch-on-reconnect, and a polling `refetchInterval`, with the focus/online/timer
 *     events behind an injected {@link RevalidationEnvironment} seam (so it is testable and
 *     SSR-safe, and absent when not opted into — the default behaviour is unchanged);
 *   - **`useMutation`** — `{ mutate, isPending, error, data }` with optimistic
 *     update + rollback, a declarative `invalidates` (the topics to drop on success), and
 *     an `onSuccess` hook.
 *
 * What this is NOT (so the doc never over-promises): it is NOT the full reactive
 * layer. Topic invalidation is EXPLICIT, never schema-INFERRED (a mutation declares its
 * topics; the client does not derive them from the rows a write touched). There is no
 * normalized `(table, pk)` store and no cache EVICTION — a key's snapshot + last-fetcher
 * live for the page's lifetime (bounded by the distinct keys an app queries; fine for a
 * per-session SPA). The push that makes a topic invalidation cross processes / tabs /
 * clients (LISTEN/NOTIFY + browser fan-out) and durable storage are the later ADR 0027
 * phases; the topic registry defined here is the seam they build on.
 *
 * Decoupled by design: the hooks never import `@lesto/client`. The caller passes a
 * `fetcher` / `mutationFn` thunk (typically closing over a `createApi` /
 * `createMutationClient` call), so this stays in the isomorphic `@lesto/ui` core
 * with no new dependency and no server code dragged into the browser bundle.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/** A query key: a string, or a tuple serialized to one (the `["listing", id]` form). */
export type QueryKey = string | readonly (string | number | boolean)[];

/** A cache entry's lifecycle. `idle` = never fetched (or invalidated to empty). */
export type QueryStatus = "idle" | "loading" | "success" | "error";

/**
 * The immutable snapshot a `useQuery` subscriber reads. A NEW object is published
 * on every change (never mutated in place) so `useSyncExternalStore` re-renders
 * exactly when the value changes and never loops on a stable read.
 */
export interface QuerySnapshot<T> {
  readonly status: QueryStatus;

  readonly data?: T;

  readonly error?: unknown;
}

/** The single shared "nothing here yet" snapshot — one frozen ref for every idle key. */
const IDLE_SNAPSHOT: QuerySnapshot<never> = Object.freeze({ status: "idle" });

/** Serialize a {@link QueryKey} to its cache string — a tuple becomes JSON. */
export function serializeQueryKey(key: QueryKey): string {
  return typeof key === "string" ? key : JSON.stringify(key);
}

/**
 * The cache + request coordinator a set of `useQuery`/`useMutation` hooks share.
 *
 * One instance backs every hook by default ({@link defaultQueryClient}); a test
 * (or an app wanting an isolated cache) constructs its own and passes it via the
 * hook's `client` option. Holds the published snapshots, the in-flight promises
 * (for dedupe), the last fetcher per key (so `invalidate` can refetch), the
 * per-key subscriber sets — kept OUT of the snapshot so a re-render is driven only
 * by a value change — the per-key "last fetched at" stamp (for `staleTime`), and the
 * **topic → keys** registry (for topic invalidation).
 *
 * `now` is injected for testability: a fake clock drives `staleTime` math without real
 * time. It defaults to `Date.now`.
 */
export class QueryClient {
  readonly #snapshots = new Map<string, QuerySnapshot<unknown>>();

  readonly #inflight = new Map<string, Promise<unknown>>();

  readonly #fetchers = new Map<string, () => Promise<unknown>>();

  readonly #listeners = new Map<string, Set<() => void>>();

  /** When `key` last became `success` — used by {@link isStale} for `staleTime`. */
  readonly #fetchedAt = new Map<string, number>();

  /** topic -> (key -> mount count): the readers registered to each topic. N mounted
   *  readers of one key under one topic register once; the key leaves the topic only
   *  when the last reader unmounts. The single source of truth for topic membership. */
  readonly #topicKeyCounts = new Map<string, Map<string, number>>();

  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The current published snapshot for `key` — the shared idle one until it has one. */
  getSnapshot(key: string): QuerySnapshot<unknown> {
    return this.#snapshots.get(key) ?? IDLE_SNAPSHOT;
  }

  /** Subscribe to `key`'s snapshot changes; returns an unsubscribe that prunes empty sets. */
  subscribe(key: string, listener: () => void): () => void {
    let set = this.#listeners.get(key);

    if (set === undefined) {
      set = new Set();
      this.#listeners.set(key, set);
    }

    set.add(listener);

    return () => {
      set.delete(listener);

      if (set.size === 0) this.#listeners.delete(key);
    };
  }

  /** Read the cached value for `key` (used by an optimistic update to snapshot/rollback). */
  getData(key: string): unknown {
    return this.#snapshots.get(key)?.data;
  }

  /** Publish `data` as `key`'s value (an optimistic write, or priming a known value). */
  setData(key: string, data: unknown): void {
    this.#publish(key, { status: "success", data });
  }

  /**
   * Fetch `key` through `fetcher`, SHARING an in-flight request: a second caller
   * while a request is pending gets the same promise and issues no second request.
   * A settled key always starts a fresh request (a `refetch`). The latest fetcher
   * is remembered so {@link invalidate} can refetch without the caller re-passing it.
   */
  fetch(key: string, fetcher: () => Promise<unknown>): Promise<unknown> {
    this.#fetchers.set(key, fetcher);

    const existing = this.#inflight.get(key);

    if (existing !== undefined) return existing;

    // Keep the prior value visible while reloading (a refetch shows stale-then-fresh,
    // not a flash of empty). A first load has no prior value, so `data` is undefined.
    const previous = this.#snapshots.get(key);

    this.#publish(key, { status: "loading", data: previous?.data });

    return this.#track(key, fetcher());
  }

  /**
   * Seed `key` from an ALREADY-in-flight request — the parse-time data primer
   * (`window.__lestoData[source]`; see {@link hydrateQueryClient}). Registers the
   * promise as `key`'s in-flight request so a `useQuery(key)` that mounts during
   * hydration DEDUPES its own fetch onto it (no second network request) and paints
   * the value the instant the parse-time fetch lands — no `JS → fetch → data`
   * waterfall.
   *
   * Unlike {@link fetch} it does NOT remember the promise as the refetch fetcher: a
   * one-shot primer must never be replayed by {@link invalidate} (that would re-serve
   * the pre-write value); the real fetcher is recorded when the reader mounts. A
   * no-op if `key` is already loading (a request is in flight) or already holds a
   * value — priming never clobbers live state.
   */
  prime(key: string, promise: Promise<unknown>): void {
    if (this.#inflight.has(key) || this.getSnapshot(key).status === "success") return;

    this.#publish(key, { status: "loading", data: this.#snapshots.get(key)?.data });

    this.#track(key, promise);
  }

  /**
   * Invalidate `key`: drop its cached value and refetch with its last fetcher, so
   * every mounted `useQuery(key)` re-renders fresh. Explicit-only — a mutation
   * names the keys (or topics) it dirties; there is no inferred invalidation (a later
   * ADR 0027 phase). A key never fetched (no remembered fetcher) is simply reset to idle.
   */
  invalidate(key: string): Promise<unknown> | undefined {
    const fetcher = this.#fetchers.get(key);

    if (fetcher === undefined) {
      this.#publish(key, IDLE_SNAPSHOT);

      return undefined;
    }

    return this.fetch(key, fetcher);
  }

  /**
   * Register `key` as a reader of every `topic`, so a later {@link invalidateTopic}
   * refetches it. Returns an unregister thunk (call on unmount). Reference-counted: M
   * mounted readers of the same key+topic register once; the key leaves the topic only
   * when the last unregisters. The registry holds only currently-mounted readers.
   */
  registerTopics(key: string, topics: readonly string[]): () => void {
    for (const topic of topics) {
      let counts = this.#topicKeyCounts.get(topic);

      if (counts === undefined) {
        counts = new Map();
        this.#topicKeyCounts.set(topic, counts);
      }

      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return () => {
      for (const topic of topics) {
        const counts = this.#topicKeyCounts.get(topic);

        if (counts === undefined) continue;

        const remaining = (counts.get(key) ?? 0) - 1;

        if (remaining > 0) {
          counts.set(key, remaining);

          continue;
        }

        counts.delete(key);

        if (counts.size === 0) this.#topicKeyCounts.delete(topic);
      }
    };
  }

  /** Invalidate every key registered to `topic`. The seam the server-push phase targets. */
  invalidateTopic(topic: string): Promise<void> {
    return this.invalidateTopics([topic]);
  }

  /**
   * Invalidate every key registered to ANY of `topics` (a mutation's `invalidates`).
   * A key dirtied by two topics is invalidated once. Resolves when every refetch settles.
   */
  invalidateTopics(topics: readonly string[]): Promise<void> {
    const keys = new Set<string>();

    for (const topic of topics) {
      const counts = this.#topicKeyCounts.get(topic);

      if (counts !== undefined) for (const key of counts.keys()) keys.add(key);
    }

    const pending: Array<Promise<unknown>> = [];

    for (const key of keys) {
      const promise = this.invalidate(key);

      if (promise !== undefined) pending.push(promise);
    }

    return Promise.all(pending).then(() => undefined);
  }

  /**
   * Whether `key`'s cached value is older than `staleTimeMs` (by the injected clock).
   * A key that never succeeded is considered stale. The hook guards its calls with a
   * `success` check, so the caller controls when this matters.
   */
  isStale(key: string, staleTimeMs: number): boolean {
    const at = this.#fetchedAt.get(key);

    return at === undefined ? true : this.#now() - at >= staleTimeMs;
  }

  /**
   * Wire a request `promise` into `key`'s lifecycle: settle it to `success`/`error`,
   * clear the in-flight slot, and store it for dedupe. Shared by {@link fetch} (which
   * also remembers the fetcher) and {@link prime} (which does not). The STORED branch
   * swallows its rejection so a deduped caller that never attaches a handler raises no
   * `unhandledrejection`; a direct awaiter still sees the re-thrown rejection.
   */
  #track(key: string, promise: Promise<unknown>): Promise<unknown> {
    const tracked = promise.then(
      (data) => {
        this.#inflight.delete(key);
        this.#publish(key, { status: "success", data });

        return data;
      },
      (error: unknown) => {
        this.#inflight.delete(key);
        this.#publish(key, { status: "error", error });

        throw error;
      },
    );

    this.#inflight.set(key, tracked);

    tracked.catch(() => {});

    return tracked;
  }

  /** Publish a new snapshot for `key`, stamp its fetch time on success, and notify subscribers. */
  #publish(key: string, snapshot: QuerySnapshot<unknown>): void {
    this.#snapshots.set(key, snapshot);

    if (snapshot.status === "success") this.#fetchedAt.set(key, this.#now());

    const set = this.#listeners.get(key);

    if (set !== undefined) for (const listener of set) listener();
  }
}

/** The cache every hook shares unless given its own `client` — the common case. */
export const defaultQueryClient = new QueryClient();

/**
 * Seed a {@link QueryClient} from the parse-time data primer, so a `useQuery(key)`
 * that mounts during hydration paints the server-fetched value with no second request
 * and no `JS → fetch → data` waterfall.
 *
 * The primer (`dataPrimerScript`, ADR 0010) kicks each `defineDataSource` fetch at
 * HTML-parse time and stores the in-flight PROMISE on `window.__lestoData[source]`.
 * This hands each such promise to {@link QueryClient.prime}, so the matching
 * `useQuery` dedupes its mount-time fetch onto the already-running request.
 *
 * `sourceToKey` names the correspondence from a primer source name to the `useQuery`
 * key its reader passes: the keyspaces are decoupled by design (a source name, a
 * `@lesto/client` `"METHOD /path"`, and a `useQuery` key are independent), so the
 * caller — which knows both — declares the mapping. Sources that were not primed are
 * skipped. A no-op on the server (no `window`) and when nothing was primed; safe to
 * call once during client setup, before mounting islands.
 */
export function hydrateQueryClient(
  client: QueryClient,
  sourceToKey: Readonly<Record<string, QueryKey>>,
): void {
  if (typeof window === "undefined") return;

  const primed = window.__lestoData;

  if (primed === undefined) return;

  for (const [source, key] of Object.entries(sourceToKey)) {
    const promise = primed[source];

    if (promise !== undefined) client.prime(serializeQueryKey(key), promise);
  }
}

/**
 * The focus / online / timer events that drive background revalidation, injected so
 * the hook stays testable (a fake env, no real time or DOM events) and SSR-safe (the
 * methods are only ever called from a client-only effect, never during render).
 */
export interface RevalidationEnvironment {
  /** Call `cb` when the tab regains focus / becomes visible. Returns an unsubscribe. */
  onFocus(cb: () => void): () => void;

  /** Call `cb` when the browser comes back online. Returns an unsubscribe. */
  onReconnect(cb: () => void): () => void;

  /** Call `cb` every `ms` until the returned cancel thunk runs (the poll loop). */
  setInterval(cb: () => void, ms: number): () => void;
}

/** The default {@link RevalidationEnvironment} over real `window`/`document` events + timers. */
export const browserRevalidationEnvironment: RevalidationEnvironment = {
  onFocus(cb) {
    const onVisible = (): void => {
      if (document.visibilityState === "visible") cb();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", cb);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", cb);
    };
  },

  onReconnect(cb) {
    window.addEventListener("online", cb);

    return () => window.removeEventListener("online", cb);
  },

  setInterval(cb, ms) {
    const id = setInterval(cb, ms);

    return () => clearInterval(id);
  },
};

/** Options for {@link useQuery} — cache selection, topic subscription, and revalidation. */
export interface QueryOptions {
  /** The cache to read/write — defaults to the shared {@link defaultQueryClient}. */
  client?: QueryClient;

  /** Topics this query reads; invalidating any of them refetches this key while mounted. */
  topics?: readonly string[];

  /**
   * Treat a cached value younger than this (ms) as fresh. When set, a mount or a
   * focus/reconnect event refetches only if the value is older. Absent ⇒ no
   * staleness-driven refetch (the default; a cached success is never auto-refetched).
   */
  staleTime?: number;

  /** Refetch when the tab regains focus (gated by {@link QueryOptions.staleTime}). */
  refetchOnWindowFocus?: boolean;

  /** Refetch when the browser comes back online (gated by {@link QueryOptions.staleTime}). */
  refetchOnReconnect?: boolean;

  /** Poll: refetch every this-many ms while mounted (ignores `staleTime` — it is a poll). */
  refetchInterval?: number;

  /** The focus/online/timer seam — defaults to {@link browserRevalidationEnvironment}. */
  environment?: RevalidationEnvironment;
}

/** What `useQuery` returns. `data` is undefined until the first success. */
export interface QueryResult<T> {
  data: T | undefined;

  error: unknown;

  isLoading: boolean;

  /** Force a fresh fetch (deduped against any request already in flight). */
  refetch: () => void;
}

/**
 * Subscribe a component to `key`, fetching it through `fetcher` when the key is
 * uncached. Concurrent callers of the same key share one request; a settled value
 * stays cached until invalidated. SSR-safe: the fetch is kicked from an effect
 * (never during render), so a server render reads the idle snapshot and never
 * fetches — the client-only data island (`ssr: false`) is the intended caller.
 *
 * `isLoading` is true while uncached or in flight. A FRESH mount of an uncached
 * OR previously-errored key kicks a fetch — so navigating away and back to a
 * listing that failed transiently retries (matching a plain mount-effect fetch),
 * while a SUCCESS stays cached (the dedupe/cache win) UNLESS a `staleTime` is set and
 * the value has aged past it. The fetch fires once per mount / key-change (the effect
 * deps are only `[client, keyStr, staleTime]`), never per render, so there is no retry
 * storm; an in-mount retry is a manual {@link QueryResult.refetch}.
 *
 * Opt-in background revalidation ({@link QueryOptions}): `staleTime`,
 * `refetchOnWindowFocus`, `refetchOnReconnect`, and a polling `refetchInterval`, all
 * wired through the injected {@link RevalidationEnvironment}. None of it runs unless
 * opted into — the default is the explicit-invalidation behaviour above. A query may
 * also declare the `topics` it reads, so a mutation's topic invalidation refetches it.
 */
export function useQuery<T>(
  key: QueryKey,
  fetcher: () => Promise<T>,
  options?: QueryOptions,
): QueryResult<T> {
  const client = options?.client ?? defaultQueryClient;
  const keyStr = serializeQueryKey(key);

  const topics = options?.topics;
  const staleTime = options?.staleTime;
  const refetchOnWindowFocus = options?.refetchOnWindowFocus ?? false;
  const refetchOnReconnect = options?.refetchOnReconnect ?? false;
  const refetchInterval = options?.refetchInterval;
  const environment = options?.environment ?? browserRevalidationEnvironment;

  // The latest fetcher closure, read through a ref so `refetch`/the effect always
  // run the current one without re-subscribing when the closure identity changes.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Topics through a ref so the registration effect re-runs only when the topic SET
  // changes (keyed by `topicsKey`), not on every render's fresh array identity.
  const topicsRef = useRef(topics);
  topicsRef.current = topics;
  const topicsKey = topics === undefined ? "" : topics.join(" ");

  // One getSnapshot for both client and server reads (same idle/cached value), so
  // there is a single function to cover and no SSR/CSR snapshot divergence.
  const getSnapshot = useCallback(
    () => client.getSnapshot(keyStr) as QuerySnapshot<T>,
    [client, keyStr],
  );

  const snapshot = useSyncExternalStore(
    useCallback((onChange) => client.subscribe(keyStr, onChange), [client, keyStr]),
    getSnapshot,
    getSnapshot,
  );

  useEffect(() => {
    // Fetch on a fresh mount when the key is uncached (`idle`) OR previously
    // errored — so a remount retries a transient failure rather than showing a
    // terminal stale error. A cached `success` is left alone UNLESS a `staleTime`
    // is set and the value has aged past it (then revalidate on mount).
    const status = client.getSnapshot(keyStr).status;

    if (
      status === "idle" ||
      status === "error" ||
      (status === "success" && staleTime !== undefined && client.isStale(keyStr, staleTime))
    ) {
      void client.fetch(keyStr, () => fetcherRef.current());
    }
  }, [client, keyStr, staleTime]);

  useEffect(() => {
    // Register while mounted so a topic invalidation refetches this key; re-runs only
    // when the topic SET changes (keyed by `topicsKey`, not the array's render identity).
    const current = topicsRef.current;

    if (current === undefined || current.length === 0) return undefined;

    return client.registerTopics(keyStr, current);
  }, [client, keyStr, topicsKey]);

  useEffect(() => {
    const offs: Array<() => void> = [];

    // Revalidate on an event only when the cached value is success and stale (an
    // absent `staleTime` means "always stale on the event" — i.e. refetch every time).
    const revalidate = (): void => {
      if (
        client.getSnapshot(keyStr).status === "success" &&
        client.isStale(keyStr, staleTime ?? 0)
      ) {
        void client.fetch(keyStr, () => fetcherRef.current());
      }
    };

    if (refetchOnWindowFocus) offs.push(environment.onFocus(revalidate));
    if (refetchOnReconnect) offs.push(environment.onReconnect(revalidate));

    if (refetchInterval !== undefined) {
      offs.push(
        environment.setInterval(() => {
          void client.fetch(keyStr, () => fetcherRef.current());
        }, refetchInterval),
      );
    }

    return () => {
      for (const off of offs) off();
    };
  }, [
    client,
    keyStr,
    staleTime,
    refetchOnWindowFocus,
    refetchOnReconnect,
    refetchInterval,
    environment,
  ]);

  const refetch = useCallback(() => {
    void client.fetch(keyStr, () => fetcherRef.current());
  }, [client, keyStr]);

  return {
    data: snapshot.data,
    error: snapshot.error,
    isLoading: snapshot.status === "idle" || snapshot.status === "loading",
    refetch,
  };
}

/** `useMutation`'s lifecycle. `idle` until the first `mutate`. */
export type MutationStatus = "idle" | "pending" | "success" | "error";

/** Options for {@link useMutation} — the optimistic + invalidate hooks. */
export interface MutationOptions<Input, Data> {
  /**
   * Run BEFORE the request (the optimistic write, typically `client.setData`).
   * Return a rollback thunk and it is invoked if the request fails — so an
   * optimistic update is undone on error. Return nothing to skip rollback.
   */
  onMutate?: (input: Input) => (() => void) | void;

  /**
   * The topics this mutation dirties. On success the client invalidates every key
   * registered to them — the declarative alternative to hand-calling `invalidate`.
   */
  invalidates?: readonly string[];

  /** The cache `invalidates` targets — defaults to the shared {@link defaultQueryClient}. */
  client?: QueryClient;

  /** Run after success (after `invalidates`) — for side effects beyond revalidation. */
  onSuccess?: (data: Data, input: Input) => void;

  /** Run after a failed request (after any rollback). */
  onError?: (error: unknown, input: Input) => void;
}

/** What `useMutation` returns. */
export interface MutationResultApi<Input, Data> {
  /** Run the mutation. Resolves to the data on success, or `undefined` on error
   *  (the error lands on {@link error}) — so a caller needs no try/catch. */
  mutate: (input: Input) => Promise<Data | undefined>;

  /** Clear back to idle (drop the last result/error). */
  reset: () => void;

  data: Data | undefined;

  error: unknown;

  isPending: boolean;

  status: MutationStatus;
}

/**
 * Manage one write: `mutate(input)` flips `isPending`, runs `mutationFn`, and lands
 * the result on `data` or the throw on `error` (never re-thrown — the result-union
 * style). Supports an optimistic `onMutate` (with rollback on failure), a declarative
 * `invalidates` (the topics dropped on success), and an `onSuccess`/`onError` pair.
 *
 * `mutationFn` may itself return a discriminated result (e.g. a `@lesto/client`
 * mutation's `{ ok, … }` union) — that union simply becomes `data`; throw inside
 * `mutationFn` to drive the `error` path instead.
 */
export function useMutation<Input, Data>(
  mutationFn: (input: Input) => Promise<Data>,
  options?: MutationOptions<Input, Data>,
): MutationResultApi<Input, Data> {
  const [state, setState] = useState<{ status: MutationStatus; data?: Data; error?: unknown }>({
    status: "idle",
  });

  // Latest fn/options through refs so `mutate` is a stable callback but always
  // sees the current closure (props captured by the island, e.g. the current row).
  const fnRef = useRef(mutationFn);
  fnRef.current = mutationFn;

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const mutate = useCallback(async (input: Input): Promise<Data | undefined> => {
    setState({ status: "pending" });

    const opts = optionsRef.current;
    const rollback = opts?.onMutate?.(input);

    try {
      const data = await fnRef.current(input);

      setState({ status: "success", data });

      // Declarative revalidation first (drop the dirtied topics' keys), then the
      // success side-effect hook.
      if (opts?.invalidates !== undefined && opts.invalidates.length > 0) {
        void (opts.client ?? defaultQueryClient).invalidateTopics(opts.invalidates);
      }

      opts?.onSuccess?.(data, input);

      return data;
    } catch (error) {
      // Undo the optimistic write (if any), publish the error, notify — no re-throw.
      if (typeof rollback === "function") rollback();

      setState({ status: "error", error });
      opts?.onError?.(error, input);

      return undefined;
    }
  }, []);

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return {
    mutate,
    reset,
    data: state.data,
    error: state.error,
    isPending: state.status === "pending",
    status: state.status,
  };
}
