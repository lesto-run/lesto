/**
 * `connectLive` / `useLive` — the browser consumer of the realtime SSE fan-out
 * (ADR 0040 Phase B) that turns a plain {@link useQuery} into a **live** one.
 *
 * It opens the app's `GET /__lesto/live` Server-Sent-Events stream and maps each
 * frame onto the {@link QueryClient}: an `invalidate` frame drops one topic (so a
 * mounted `useQuery` refetches it through its own authorized read), and a `resync`
 * frame refetches every subscribed topic (the always-correct floor when the server
 * cannot prove continuity). The wire carries a **topic, never row data** (the ADR
 * 0027 invariant); this file never sees a row.
 *
 * Decoupled from `@lesto/realtime` on purpose: this consumer only drives the
 * `QueryClient` seam and reads an `EventSource`, so `@lesto/ui` keeps no realtime
 * dependency. Opt-in and side-effect-free until called, so it tree-shakes away on a
 * page that never goes live.
 */

import { useEffect, useRef } from "react";

import { defaultQueryClient } from "./data-client";
import type { QueryClient } from "./data-client";

/** The reserved path the runtime recognizes as a long-lived stream (ADR 0040). */
const DEFAULT_LIVE_PATH = "/__lesto/live";

/**
 * The slice of an SSE message event {@link connectLive} reads — just its `data`. A
 * named `invalidate` event carries the topic here; a `resync` carries the empty
 * string. Narrow on purpose, so a fake satisfies it without a real `EventSource`.
 */
export interface LiveMessageEvent {
  readonly data: string;
}

/**
 * The slice of an `EventSource` {@link connectLive} drives — a listener for the
 * named events, and a close. The browser `EventSource` satisfies this through
 * {@link browserLiveEnvironment}; a test injects a fake.
 */
export interface LiveEventSource {
  addEventListener(
    type: "invalidate" | "resync" | "error",
    listener: (event: LiveMessageEvent) => void,
  ): void;

  close(): void;
}

/**
 * Opens a {@link LiveEventSource} for a URL — the seam through which
 * {@link connectLive} reaches `EventSource`. Injected so a test fakes the whole
 * stream and importing this module stays SSR-safe: the global `EventSource` is
 * touched only inside the default's `open`, never at import or during a render.
 */
export interface LiveEnvironment {
  open(url: string): LiveEventSource;
}

/** The default {@link LiveEnvironment} over the browser's native `EventSource`. */
export const browserLiveEnvironment: LiveEnvironment = {
  open(url) {
    const source = new EventSource(url);

    return {
      addEventListener: (type, listener) =>
        source.addEventListener(type, (event) => listener(event as MessageEvent)),

      close: () => source.close(),
    };
  },
};

/** Options for {@link connectLive}. */
export interface ConnectLiveOptions {
  /** The topics to subscribe to; each is invalidated live as the server pushes it. */
  readonly topics: readonly string[];

  /** The cache to invalidate — defaults to the shared {@link defaultQueryClient}. */
  readonly client?: QueryClient;

  /** The live-stream path the app mounted. Defaults to `/__lesto/live`. */
  readonly path?: string;

  /** The `EventSource` seam — defaults to {@link browserLiveEnvironment}. */
  readonly environment?: LiveEnvironment;

  /**
   * Notified of a stream `error` (a transient disconnect). Informational only:
   * `EventSource` reconnects on its own — resuming from its last `id:` via the
   * `Last-Event-ID` header — so a handler here need not reconnect, only observe.
   */
  readonly onError?: (event: LiveMessageEvent) => void;
}

/**
 * Open a live subscription: stream `(topic, cursor)` invalidations from the app's
 * `GET /__lesto/live` SSE endpoint and drive {@link QueryClient.invalidateTopic}, so
 * a mounted `useQuery` refetches the instant a peer's write dirties one of its topics
 * — "live `useQuery`" (ADR 0027 Phase 2 over the ADR 0040 transport).
 *
 * `EventSource` handles reconnect and the resume cursor (`Last-Event-ID`) natively
 * and ignores the heartbeat comments, so this consumer only maps the two named
 * events onto the cache: an `invalidate` frame's `data` is the single topic to drop;
 * a `resync` frame refetches every subscribed topic.
 *
 * Unauthorized topics are **not** an error here: the server drops them silently — no
 * delivery, no timing signal (ADR 0040's `selectAuthorizedTopics`) — so a client that
 * asks for a topic it may not see simply never receives it, and this consumer never
 * learns the difference.
 *
 * Returns a disconnect thunk — call it on unmount (or use {@link useLive}, which
 * does). Framework-agnostic; the React lifetime lives in {@link useLive}.
 */
export function connectLive(options: ConnectLiveOptions): () => void {
  const client = options.client ?? defaultQueryClient;
  const path = options.path ?? DEFAULT_LIVE_PATH;
  const environment = options.environment ?? browserLiveEnvironment;
  const { topics, onError } = options;

  const query = new URLSearchParams({ topics: topics.join(",") });

  const source = environment.open(`${path}?${query.toString()}`);

  // An `invalidate` frame's `data` is the single topic to drop and refetch.
  source.addEventListener("invalidate", (event) => {
    void client.invalidateTopic(event.data);
  });

  // A `resync` frame carries no topic: refetch everything this connection subscribes to.
  source.addEventListener("resync", () => {
    void client.invalidateTopics(topics);
  });

  // A stream error is informational (EventSource reconnects itself); forward it only
  // when the caller asked to observe.
  if (onError !== undefined) {
    source.addEventListener("error", onError);
  }

  return () => source.close();
}

/** Options for {@link useLive} — everything {@link connectLive} takes but the topics. */
export type UseLiveOptions = Omit<ConnectLiveOptions, "topics">;

/**
 * The island hook: hold a live subscription for `topics` open while the component is
 * mounted, re-subscribing when the topic SET changes and disconnecting on unmount. A
 * thin {@link connectLive} wrapper — the effect owns the connection's lifetime.
 *
 * SSR-safe: the connection is opened from an effect (never during render), so a
 * server render neither touches `EventSource` nor holds a stream. Pair it with a
 * `useQuery` reading the same topics and the query goes live.
 *
 * **One connection per call — call it ONCE, high in a view.** Unlike `useQuery` (which
 * dedupes by key), each `useLive` opens its OWN `EventSource`. Calling it in many
 * components — e.g. once per list row — opens many streams and can exhaust the browser's
 * per-origin connection budget and the server's per-IP stream cap. Subscribe to every
 * topic a view needs in a single `useLive` at the top of that view.
 *
 * **Options are read when the subscription opens and must be STABLE across renders.**
 * Only a change to the topic SET reopens the stream; a new `client`/`path`/`environment`/
 * `onError` identity on a later render is ignored. Pass a stable `client` (not
 * `new QueryClient()` per render) — the same expectation `useQuery` has of its `client`.
 */
export function useLive(topics: readonly string[], options?: UseLiveOptions): void {
  // Topics through a ref so the effect re-runs only when the SET changes (keyed by
  // `topicsKey`), not on every render's fresh array identity. Joined on "," — the wire
  // delimiter a topic can never contain — so the key is unambiguous (a space-joined key
  // would collide `["a b"]` with `["a", "b"]`).
  const topicsRef = useRef(topics);
  topicsRef.current = topics;
  const topicsKey = topics.join(",");

  // The latest options through a ref, so a new `client`/`onError` closure identity
  // does not tear down and reopen the stream — only a topic-set change does.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const o: UseLiveOptions = optionsRef.current ?? {};

    return connectLive({
      topics: topicsRef.current,
      ...(o.client !== undefined ? { client: o.client } : {}),
      ...(o.path !== undefined ? { path: o.path } : {}),
      ...(o.environment !== undefined ? { environment: o.environment } : {}),
      ...(o.onError !== undefined ? { onError: o.onError } : {}),
    });
  }, [topicsKey]);
}
