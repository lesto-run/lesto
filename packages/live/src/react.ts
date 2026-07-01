/**
 * `useLiveQuery` — the React binding for `live()` (ADR 0042 Tier 4, v0).
 *
 * A {@link LiveQuery} is `{ subscribe, getSnapshot, disconnect }` — deliberately the shape a
 * React external store wants — but `createLiveQuery` / `live().query()` open the SSE stream
 * EAGERLY, and a browser `EventSource` exists neither during SSR nor in Node. So this hook
 * takes a **factory** and calls it inside an effect: the stream is created only on the client,
 * after mount, and torn down on unmount — never touched on the server, which renders the empty
 * set. (That is also why it reads through `getSnapshot` in an effect rather than
 * `useSyncExternalStore`, whose `subscribe`/`getSnapshot` must be available synchronously.)
 *
 * `deps` is the re-subscribe key, exactly like `useEffect`'s: pass the values the shape is
 * bound to (a room id, a filter) so a change tears the old stream down and opens a new one.
 * The factory itself is read through a ref, so a fresh closure identity each render does NOT
 * reopen the stream — only `deps` does (the same contract `@lesto/ui`'s `useLive` has of its
 * options).
 *
 * This lives on the `@lesto/live/react` subpath, not the core entry, so importing `@lesto/live`
 * pulls in no React; `react` is an OPTIONAL peer dependency this subpath alone needs.
 */

import { useEffect, useRef, useState } from "react";
import type { DependencyList } from "react";

import type { Row } from "@lesto/live-protocol";

import type { LiveQuery } from "./live-query";

/** The stable empty slice a not-yet-connected (or server) render returns. */
const EMPTY: readonly never[] = [];

/**
 * Subscribe a component to a `live()` query and re-render it as rows stream in. The `create`
 * factory is invoked once per `deps` change, inside an effect (client-only), and its stream is
 * disconnected on unmount or before re-creating.
 */
export function useLiveQuery<R extends Row = Row>(
  create: () => LiveQuery<R>,
  deps: DependencyList = [],
): readonly R[] {
  const [rows, setRows] = useState<readonly R[]>(EMPTY);

  // The factory through a ref, so a new closure identity on a later render does not reopen the
  // stream — only a `deps` change does.
  const createRef = useRef(create);
  createRef.current = create;

  useEffect(() => {
    const query = createRef.current();

    // The store's `getSnapshot` is a stable reference between mutations, so `setRows` bails out
    // of a re-render when nothing changed — one `sync` per real change, none on a no-op.
    const sync = (): void => setRows(query.getSnapshot());

    const unsubscribe = query.subscribe(sync);
    sync();

    return () => {
      unsubscribe();
      query.disconnect();
    };
    // `deps` is the caller's re-subscribe key; `create` is intentionally read via the ref.
  }, deps);

  return rows;
}
