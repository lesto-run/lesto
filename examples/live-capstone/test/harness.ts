/**
 * The capstone's live-stream test harness — shared by the bun-script acceptance gate
 * (`acceptance.pg.ts`, the real Postgres path) and the vitest dev-parity leg
 * (`acceptance.sqlite.test.ts`, the SQLite poll). Two clients over one SSE-over-`fetch` core:
 *
 *   - {@link openSse} — a RAW frame client (frames + `waitFor` + `close`), for asserting the wire
 *     directly (the authz matrix, the resume decision). Ported from `examples/live/test`, extended to
 *     capture each frame's `id:` cursor (the resume linchpin) and to seed a reconnect's `lastEventId`.
 *   - {@link fetchLiveEnvironment} — a {@link LiveEnvironment} that drives the REAL `@lesto/live`
 *     `connectLiveData` / `createLiveQuery` over `fetch` instead of a browser `EventSource`. This is
 *     the honesty upgrade the capstone ratified: the offline-reconcile assertions run through the
 *     actual client store + consumer code path, not a hand-rolled wire client.
 *
 * The one thing a `fetch` SSE shim does NOT replicate is `EventSource`'s automatic in-session
 * reconnect — deliberately: the offline-reconcile test holds ONE connection open the whole time, and
 * the resume test reconnects EXPLICITLY (a fresh {@link openSse} with a seeded `lastEventId`), so the
 * absence of auto-reconnect is correct, not a gap.
 */

import type { LiveEnvironment, LiveEventSource, LiveMessageEvent } from "@lesto/live";

/** One parsed SSE event: its `event:` type, joined `data:` payload, and `id:` cursor (empty if none). */
export interface Frame {
  readonly event: string;
  readonly data: string;
  readonly id: string;
}

/** Parse one SSE event block (`event:`/`data:`/`id:` lines); a bare `:` comment yields `undefined`. */
export function parseFrame(raw: string): Frame | undefined {
  let event = "message";
  let data = "";
  let id = "";
  let saw = false;

  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");

    if (field === "event") {
      event = value;
      saw = true;
    } else if (field === "data") {
      data = data === "" ? value : `${data}\n${value}`;
      saw = true;
    } else if (field === "id") {
      id = value;
      saw = true;
    }
  }

  return saw ? { event, data, id } : undefined;
}

/** A live SSE client: the frames seen so far, a `waitFor`, and a clean disconnect. */
export interface SseClient {
  readonly frames: Frame[];
  waitFor(pred: (frame: Frame) => boolean, ms?: number): Promise<Frame>;
  close(): void;
}

/** Read an SSE `ReadableStream` into `onFrame`, buffering across chunk/`\n\n` boundaries. */
function pumpSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: Frame) => void,
): { cancel: () => void } {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");

        while (boundary >= 0) {
          const frame = parseFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");

          if (frame !== undefined) onFrame(frame);
        }
      }
    } catch {
      // The read rejects when the caller aborts — the intended teardown, not a failure.
    }
  })();

  return { cancel: () => void reader.cancel().catch(() => {}) };
}

/**
 * Open a live SSE connection and read its frames in the background until closed. Appends `&user=` (the
 * demo's auth scope) and, when resuming, `&lastEventId=` (the reconnect cursor the server reconciles).
 */
export async function openSse(
  base: string,
  path: string,
  options: { readonly user?: string; readonly lastEventId?: string } = {},
): Promise<SseClient> {
  const controller = new AbortController();

  let url = `${base}${path}`;
  if (options.user !== undefined) url += `&user=${encodeURIComponent(options.user)}`;
  if (options.lastEventId !== undefined)
    url += `&lastEventId=${encodeURIComponent(options.lastEventId)}`;

  const response = await fetch(url, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });

  const frames: Frame[] = [];
  const waiters: Array<{ pred: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];

  pumpSse(response.body as ReadableStream<Uint8Array>, (frame) => {
    frames.push(frame);

    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(frame)) waiters.splice(i, 1)[0]!.resolve(frame);
    }
  });

  return {
    frames,
    waitFor(pred, ms = 2000) {
      const existing = frames.find(pred);

      if (existing !== undefined) return Promise.resolve(existing);

      return new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.indexOf(entry);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error("SSE waitFor timed out"));
        }, ms);

        const entry = {
          pred,
          resolve: (frame: Frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        };

        waiters.push(entry);
      });
    },
    close: () => controller.abort(),
  };
}

/**
 * A {@link LiveEnvironment} that drives the REAL `@lesto/live` consumer over `fetch` — the seam
 * `connectLiveData`/`createLiveQuery` reach `EventSource` through. `open(url)` connects to
 * `base + url` (appending the demo's `&user=` scope), then dispatches each SSE frame to the
 * consumer's `snapshot`/`change`/`resync`/`error` listeners as a {@link LiveMessageEvent}
 * (`{ data, lastEventId }`) — so the actual client store applies real frames.
 */
export function fetchLiveEnvironment(base: string, user: string): LiveEnvironment {
  return {
    open(url: string): LiveEventSource {
      const controller = new AbortController();
      const listeners = new Map<string, Set<(event: LiveMessageEvent) => void>>();

      const dispatch = (type: string, event: LiveMessageEvent): void => {
        for (const listener of listeners.get(type) ?? []) listener(event);
      };

      const fullUrl = `${base}${url}&user=${encodeURIComponent(user)}`;

      void fetch(fullUrl, { headers: { accept: "text/event-stream" }, signal: controller.signal })
        .then((response) =>
          pumpSse(response.body as ReadableStream<Uint8Array>, (frame) => {
            dispatch(frame.event, { data: frame.data, lastEventId: frame.id });
          }),
        )
        .catch(() => dispatch("error", { data: "", lastEventId: "" }));

      return {
        addEventListener(type, listener) {
          let set = listeners.get(type);

          if (set === undefined) {
            set = new Set();
            listeners.set(type, set);
          }

          set.add(listener);
        },
        close: () => controller.abort(),
      };
    },
  };
}
