/**
 * `connectLiveData` — the browser consumer of the local-first data stream (ADR 0042 Tier
 * 4, v0). It opens the app's `GET /__lesto/live-data` Server-Sent-Events endpoint for a
 * bound shape and maps each frame onto a {@link LiveStore}: a `snapshot` replaces the whole
 * slice, a `change` sets/removes one row, and a `resync` drops the slice to await the next
 * snapshot. Unlike `@lesto/ui`'s `connectLive` (which drives a `QueryClient` off a
 * *topic*), this wire carries auth-scoped ROW DATA — the deliberate ADR 0042 vs 0027 split.
 *
 * The `EventSource` seam is injected exactly like `@lesto/ui/src/live.ts`, for the same two
 * reasons: a test drives the whole stream through a fake, and importing this module stays
 * SSR-safe because the global `EventSource` is touched only inside the default's `open`,
 * never at import or during a render. This file keeps no React dependency — the store it
 * drives is framework-agnostic, and the React binding lives in `@lesto/ui`.
 */

import {
  decodeChangeData,
  decodeSnapshotData,
  serializeShapeDefinition,
} from "@lesto/live-protocol";
import type { ShapeDefinition } from "@lesto/live-protocol";

import type { LiveStore } from "./store";

/** The reserved path the runtime recognizes as the local-first data stream (ADR 0042). */
export const DEFAULT_LIVE_DATA_PATH = "/__lesto/live-data";

/**
 * The slice of an SSE message event this consumer reads — its `data` and its `lastEventId`
 * (the frame's resume cursor). A `snapshot` carries the row set in `data`, a `change` one row
 * op; narrow on purpose so a fake satisfies it without a real `EventSource`.
 *
 * **The cursor is forwarded, never interpreted.** The native `EventSource` carries the frame's
 * cursor as `MessageEvent.lastEventId` and transparently echoes it back as the reconnect
 * `Last-Event-ID` header — the *in-session* resume that needs no help from us. ADR 0042 Inc5
 * adds the *cross-reload* half: {@link connectLiveData} hands `lastEventId` straight to the
 * store so a durable store can persist it atomically with the rows (the read-your-writes
 * linchpin). The one invariant preserved from Inc4: this module treats the cursor as an
 * **opaque round-tripped string** — it forwards it and never reads, compares, or parses it. The
 * server (`@lesto/live-server`'s `encodeResumeCursor`, and the poll path's `pollCursor`) owns
 * the token's shape, which is exactly why Inc4 could upgrade the wire from a `v0:` counter to a
 * `v1:(systemId, timelineId, LSN)` token additively. Do not add cursor *parsing/comparison*
 * here — that interpretation belongs server-side, and keeping it out is what let the wire
 * evolve without a client change.
 */
export interface LiveMessageEvent {
  readonly data: string;

  /**
   * The frame's opaque resume cursor (the SSE `id:` line). Present on every `snapshot`/`change`
   * frame our server emits; the empty string on a frame with no `id:` (e.g. a bare `error`
   * event forwarded to `onError`). Forwarded to the store verbatim, never parsed here.
   */
  readonly lastEventId: string;
}

/**
 * The slice of an `EventSource` {@link connectLiveData} drives — a listener for the named
 * data events, and a close. The browser `EventSource` satisfies this through
 * {@link browserLiveEnvironment}; a test injects a fake.
 */
export interface LiveEventSource {
  addEventListener(
    type: "snapshot" | "change" | "resync" | "error",
    listener: (event: LiveMessageEvent) => void,
  ): void;

  close(): void;
}

/**
 * Opens a {@link LiveEventSource} for a URL — the seam through which
 * {@link connectLiveData} reaches `EventSource`. Injected so a test fakes the whole stream
 * and importing this module stays SSR-safe: the global `EventSource` is touched only inside
 * the default's `open`, never at import or during a render.
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

/** Options for {@link connectLiveData}. */
export interface ConnectLiveDataOptions {
  /** The bound shape to subscribe to — serialized into the subscribe request's query. */
  readonly def: ShapeDefinition;

  /** The store each frame is applied to. */
  readonly store: LiveStore;

  /** The data-stream path the app mounted. Defaults to `/__lesto/live-data`. */
  readonly path?: string;

  /** The `EventSource` seam — defaults to {@link browserLiveEnvironment}. */
  readonly environment?: LiveEnvironment;

  /**
   * Notified of a stream `error` (a transient disconnect), and of a corrupt frame that
   * forced a resync. Informational: `EventSource` reconnects on its own — resuming from its
   * last `id:` via `Last-Event-ID` — so a handler here need not reconnect, only observe.
   */
  readonly onError?: (event: LiveMessageEvent) => void;
}

/**
 * Open a live data subscription: stream the `snapshot` + `change` tail for `def` from the
 * app's `GET /__lesto/live-data` SSE endpoint and drive `store`, so a UI reading the store
 * reflects a peer's committed write the instant the server pushes it.
 *
 * The URL binds the shape in the query — `?shape=<url-encoded serialized definition>` — the
 * protocol's trust boundary the server re-validates and authorizes at subscribe time.
 *
 * ROBUSTNESS: a `snapshot`/`change` decoder throws `LiveProtocolError` on a malformed frame.
 * That is caught and dropped to the safe floor — `store.applyResync()` clears the slice and
 * the reconnect (or the next snapshot) re-establishes it — rather than crashing the consumer
 * or mis-applying a bad frame; the corruption is forwarded to `onError` when observed.
 *
 * Returns a disconnect thunk — call it to close the stream. Framework-agnostic; the React
 * lifetime lives in `@lesto/ui`.
 */
export function connectLiveData(options: ConnectLiveDataOptions): () => void {
  const { def, store, onError } = options;
  const path = options.path ?? DEFAULT_LIVE_DATA_PATH;
  const environment = options.environment ?? browserLiveEnvironment;

  const source = environment.open(
    `${path}?shape=${encodeURIComponent(serializeShapeDefinition(def))}`,
  );

  // A `snapshot` frame carries the shape's whole authorized row set — replace the slice, stamped
  // at the frame's cursor (forwarded opaquely) so a durable store persists rows + position atomically.
  source.addEventListener("snapshot", (event) => {
    try {
      store.applySnapshot(decodeSnapshotData(event.data).rows, event.lastEventId);
    } catch {
      store.applyResync();
      onError?.(event);
    }
  });

  // A `change` frame carries one insert / update / delete-from-shape — apply it at its commit cursor.
  source.addEventListener("change", (event) => {
    try {
      store.applyChange(decodeChangeData(event.data), event.lastEventId);
    } catch {
      store.applyResync();
      onError?.(event);
    }
  });

  // A `resync` frame carries no data: drop the local slice and await the next snapshot.
  source.addEventListener("resync", () => {
    store.applyResync();
  });

  // A stream error is informational (EventSource reconnects itself); forward it only when
  // the caller asked to observe.
  if (onError !== undefined) {
    source.addEventListener("error", onError);
  }

  return () => source.close();
}
