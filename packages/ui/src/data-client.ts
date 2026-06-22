/**
 * Client data hooks — `useQuery` / `useMutation` over a tiny shared cache.
 *
 * The smallest credible step toward Weft (ADR 0027), and no more: islands today
 * hand-roll `useState`+`useEffect` to fetch (a re-implemented loading/error
 * machine per island, no sharing) and re-build a mutation client per submit. These
 * hooks replace that with one cache that gives:
 *
 *   - **in-flight dedupe** — N components asking for the same key while a request
 *     is in flight share ONE request, not N;
 *   - **an explicit-invalidation cache** — a resolved key stays cached until a
 *     mutation (or a manual `refetch`) invalidates it, so a re-mount or a sibling
 *     reading the same key paints instantly;
 *   - **`useMutation`** — `{ mutate, isPending, error, data }` with optimistic
 *     update + rollback and an `onSuccess` hook that typically invalidates keys.
 *
 * What this is NOT (so the doc never over-promises): it is NOT full Weft. There is
 * no schema-INFERRED invalidation (a mutation does not know which queries it
 * dirties — you invalidate by key, explicitly), no normalized `(table, pk)` store,
 * and no automatic background revalidation. Those are the ADR 0027 bet; this is the
 * thin hook layer that an app can adopt now and that Weft can later back.
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
 * (for dedupe), the last fetcher per key (so `invalidate` can refetch), and the
 * per-key subscriber sets — kept OUT of the snapshot so a re-render is driven only
 * by a value change.
 */
export class QueryClient {
  readonly #snapshots = new Map<string, QuerySnapshot<unknown>>();

  readonly #inflight = new Map<string, Promise<unknown>>();

  readonly #fetchers = new Map<string, () => Promise<unknown>>();

  readonly #listeners = new Map<string, Set<() => void>>();

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

    const promise = fetcher().then(
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

    this.#inflight.set(key, promise);

    // A deduped caller may never attach a handler; swallow the rejection on the
    // STORED branch so it raises no `unhandledrejection`. The error is already on
    // the snapshot, and a direct awaiter still sees the re-thrown rejection above.
    promise.catch(() => {});

    return promise;
  }

  /**
   * Invalidate `key`: drop its cached value and refetch with its last fetcher, so
   * every mounted `useQuery(key)` re-renders fresh. Explicit-only — a mutation
   * names the keys it dirties; there is no inferred invalidation (that is Weft). A
   * key never fetched (no remembered fetcher) is simply reset to idle.
   */
  invalidate(key: string): Promise<unknown> | undefined {
    const fetcher = this.#fetchers.get(key);

    if (fetcher === undefined) {
      this.#publish(key, IDLE_SNAPSHOT);

      return undefined;
    }

    return this.fetch(key, fetcher);
  }

  /** Publish a new snapshot for `key` and notify its subscribers. */
  #publish(key: string, snapshot: QuerySnapshot<unknown>): void {
    this.#snapshots.set(key, snapshot);

    const set = this.#listeners.get(key);

    if (set !== undefined) for (const listener of set) listener();
  }
}

/** The cache every hook shares unless given its own `client` — the common case. */
export const defaultQueryClient = new QueryClient();

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
 * while a SUCCESS stays cached (the dedupe/cache win). The fetch fires once per
 * mount / key-change (the effect deps are only `[client, keyStr]`), never per
 * render, so there is no retry storm; an in-mount retry is a manual
 * {@link QueryResult.refetch}.
 */
export function useQuery<T>(
  key: QueryKey,
  fetcher: () => Promise<T>,
  options?: { client?: QueryClient },
): QueryResult<T> {
  const client = options?.client ?? defaultQueryClient;
  const keyStr = serializeQueryKey(key);

  // The latest fetcher closure, read through a ref so `refetch`/the effect always
  // run the current one without re-subscribing when the closure identity changes.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

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
    // terminal stale error. A `loading`/`success` key is left alone: a sibling
    // already has it in flight or cached (the dedupe at mount time).
    const status = client.getSnapshot(keyStr).status;

    if (status === "idle" || status === "error") {
      void client.fetch(keyStr, () => fetcherRef.current());
    }
  }, [client, keyStr]);

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

  /** Run after success — typically `client.invalidate(key)` to revalidate reads. */
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
 * style). Supports an optimistic `onMutate` (with rollback on failure) and an
 * `onSuccess`/`onError` pair (the former usually invalidates queries).
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

    const rollback = optionsRef.current?.onMutate?.(input);

    try {
      const data = await fnRef.current(input);

      setState({ status: "success", data });
      optionsRef.current?.onSuccess?.(data, input);

      return data;
    } catch (error) {
      // Undo the optimistic write (if any), publish the error, notify — no re-throw.
      if (typeof rollback === "function") rollback();

      setState({ status: "error", error });
      optionsRef.current?.onError?.(error, input);

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
