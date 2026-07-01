/**
 * The app-mounted local-first data handler — `GET /__lesto/live-data` (ADR 0042 Tier 4).
 *
 * Mounted by the app exactly like `@lesto/realtime`'s SSE handler — it reads the principal
 * from the per-request context and stays out of the kernel. The runtime recognizes the
 * reserved path as a long-lived stream (a second reserved path beside `/__lesto/live`), so
 * the held connection takes no in-flight slot, is never compressed, and tears down on
 * disconnect.
 *
 * Per connection the handler: resolves the principal, parses the requested shape from the
 * query (`?shape=<json>`, the protocol's trust boundary), **authorizes the bound shape**
 * (the parameter-level authz seam — a shape whose parameters resolve to another tenant's
 * resource is refused at subscribe time), then subscribes to the shape engine and streams
 * the snapshot + change tail over a long-lived `ReadableStream`. It heart-beats, optionally
 * re-authorizes the session on an interval / bounds the lifetime, and tears everything down
 * on `context.signal` disconnect. Every OUTBOUND decision is delegated to the tested
 * {@link ShapeConnection}; this file is the composition over a `ReadableStream` + timers.
 *
 * v0 note: this endpoint proves the `live()` surface and the dev loop; it is NOT the
 * per-row authorization gate (that is the v1 adversarial matrix — see ADR 0042). In v0 a
 * refused shape returns a plain 403, which is an existence side-channel the v1 model closes.
 */

import { parseShapeDefinition } from "@lesto/live-protocol";
import type { Cursor, Row, ShapeChange, ShapeDefinition } from "@lesto/live-protocol";
import type { Context, Handler } from "@lesto/web";

import { ShapeConnection } from "./connection";
import type { FrameController } from "./connection";
import { LiveServerError } from "./errors";
import type { ShapeEngine } from "./engine";

/**
 * The timer seam — injected so a test fires intervals/timeouts deterministically; defaults
 * to real, `unref`'d timers (a heartbeat must never keep the process up).
 */
export interface StreamTimers {
  setInterval(callback: () => void, ms: number): unknown;

  clearInterval(handle: unknown): void;

  setTimeout(callback: () => void, ms: number): unknown;

  clearTimeout(handle: unknown): void;
}

const realStreamTimers: StreamTimers = {
  setInterval: (callback, ms) => {
    const timer = setInterval(callback, ms);

    timer.unref();

    return timer;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);

    timer.unref();

    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The headers an SSE response carries — never cached, never transformed, never buffered. */
const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
  connection: "keep-alive",
};

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_QUEUE = 256;
const DEFAULT_REAUTH_MS = 60_000;

/**
 * A ready shape source: the snapshot to send first, and a hook to start routing the
 * change tail (buffered until the stream attaches, so nothing between subscribe and
 * first-byte is lost). Produced by {@link subscribeSource} from an engine subscription.
 */
export interface ShapeStreamSource {
  readonly snapshot: readonly Row[];

  readonly cursor: Cursor;

  /** Begin routing changes (any buffered first, then live) to `deliver`. */
  onChange(deliver: (change: ShapeChange, cursor: Cursor) => void): void;

  /** Stop the underlying engine subscription. */
  close(): void;
}

/**
 * Subscribe to the shape engine, buffering any change that arrives before the stream is
 * ready so the snapshot→tail boundary never gaps. The engine's registry validation runs
 * here (before the stream opens), so an unknown table/column surfaces as a caught error
 * the handler maps to a 4xx — not a 200 stream that immediately dies.
 */
export async function subscribeSource(
  engine: ShapeEngine,
  def: ShapeDefinition,
): Promise<ShapeStreamSource> {
  const buffered: Array<[ShapeChange, Cursor]> = [];
  let deliver: ((change: ShapeChange, cursor: Cursor) => void) | undefined;

  const sub = await engine.subscribe(def, (change, cursor) => {
    if (deliver === undefined) buffered.push([change, cursor]);
    else deliver(change, cursor);
  });

  return {
    snapshot: sub.snapshot,
    cursor: sub.cursor,
    onChange(next) {
      deliver = next;

      for (const [change, cursor] of buffered) next(change, cursor);

      buffered.length = 0;
    },
    close: sub.unsubscribe,
  };
}

/** What {@link openShapeStream} needs to hold one data connection open. */
export interface ShapeStreamConfig {
  /** The ready source: snapshot + change tail + close. */
  readonly source: ShapeStreamSource;

  /** The request's abort signal — fires on client disconnect, tearing the stream down. */
  readonly signal: AbortSignal | undefined;

  /** Heartbeat interval (a `: ping` comment), under the tightest intermediary idle timeout. */
  readonly heartbeatMs: number;

  /** The per-connection outbound buffer bound — a slow client past it is dropped to resync. */
  readonly maxQueue: number;

  /** The timer seam (injected for tests). */
  readonly timers: StreamTimers;

  /** A periodic session re-authorization; returning `false` (or throwing) tears down. */
  readonly revalidate?: () => boolean | Promise<boolean>;

  /** The re-auth interval in ms (only when {@link revalidate} is set). */
  readonly reauthMs?: number;

  /** A hard cap on connection lifetime in ms; absent → unbounded. */
  readonly maxConnectionMs?: number;
}

/**
 * Open one live data stream: emit the snapshot, tail the changes, heartbeat, optionally
 * re-auth / bound the lifetime, and tear down on disconnect. Teardown is idempotent and
 * reached five ways — client disconnect (`signal` abort), the consumer cancelling, buffer
 * overflow, the TTL, or a failed re-auth — and always unsubscribes the source, clears every
 * timer, and closes the connection.
 */
export function openShapeStream(config: ShapeStreamConfig): ReadableStream<string> {
  const timerHandles: Array<{ kind: "interval" | "timeout"; handle: unknown }> = [];

  let connection: ShapeConnection | undefined;
  let torn = false;

  const teardown = (): void => {
    if (torn) return;

    torn = true;

    for (const { kind, handle } of timerHandles) {
      if (kind === "interval") config.timers.clearInterval(handle);
      else config.timers.clearTimeout(handle);
    }

    config.signal?.removeEventListener("abort", teardown);

    // The engine unsubscribe is a `Set.delete` today and cannot throw, but teardown is the
    // last line of defense: a throw here must not strand the `connection.close()` below.
    try {
      config.source.close();
    } catch {
      // A failed unsubscribe is swallowed so cleanup continues.
    }

    connection?.close();
  };

  return new ReadableStream<string>(
    {
      start(controller) {
        connection = new ShapeConnection({
          controller: controller as unknown as FrameController,
          // Overflow already closed the controller; just release the subscription/timers.
          onOverflow: teardown,
        });

        // A client that disconnected before we finished setup: tear down at once.
        if (config.signal?.aborted === true) {
          teardown();

          return;
        }

        // Snapshot first, then the change tail flows through the same connection.
        connection.snapshot(config.source.snapshot, config.source.cursor);
        config.source.onChange((change, cursor) => connection?.deliver(change, cursor));

        // Heartbeat: hold the stream open past intermediary idle timeouts.
        timerHandles.push({
          kind: "interval",
          handle: config.timers.setInterval(() => connection?.heartbeat(), config.heartbeatMs),
        });

        // Periodic re-auth (optional): a revoked/expired session is severed. `revalidate`
        // is app code, so a SYNCHRONOUS throw or a rejection both FAIL CLOSED (tear down),
        // never escaping the timer callback as an uncaught exception.
        if (config.revalidate !== undefined) {
          const revalidate = config.revalidate;

          timerHandles.push({
            kind: "interval",
            handle: config.timers.setInterval(() => {
              void (async () => {
                try {
                  if (!(await revalidate())) teardown();
                } catch {
                  teardown();
                }
              })();
            }, config.reauthMs ?? DEFAULT_REAUTH_MS),
          });
        }

        // Hard lifetime cap (optional): sever and let the client reconnect.
        if (config.maxConnectionMs !== undefined) {
          timerHandles.push({
            kind: "timeout",
            handle: config.timers.setTimeout(teardown, config.maxConnectionMs),
          });
        }

        // Disconnect teardown — the runtime aborts `signal` when the client hangs up.
        config.signal?.addEventListener("abort", teardown);
      },

      cancel() {
        teardown();
      },
    },
    new CountQueuingStrategy({ highWaterMark: config.maxQueue }),
  );
}

/** What {@link createLiveDataHttpHandlers} needs — the engine plus the app's authz seams. */
export interface LiveDataHttpOptions<P> {
  /** The shape engine the connection subscribes through. */
  readonly engine: ShapeEngine;

  /** Resolve the acting principal from the request context (the app's own gate). */
  readonly resolvePrincipal: (c: Context) => P | Promise<P>;

  /**
   * Authorize the **bound** shape for the principal — the parameter-level authz seam. A
   * shape whose bound parameters resolve to another tenant's resource must be refused
   * here (ADR 0042 acceptance matrix (a)). Return `false` to refuse.
   */
  readonly authorizeShape: (principal: P, shape: ShapeDefinition) => boolean | Promise<boolean>;

  /** Heartbeat interval in ms. Defaults to 30s. */
  readonly heartbeatMs?: number;

  /** Per-connection outbound buffer bound. Defaults to 256. */
  readonly maxQueue?: number;

  /** Periodic session re-auth; `false` severs the stream. */
  readonly revalidate?: (principal: P) => boolean | Promise<boolean>;

  /** Re-auth interval in ms (only when {@link revalidate} is set). Defaults to 60s. */
  readonly reauthMs?: number;

  /** Hard connection-lifetime cap in ms. Absent → unbounded. */
  readonly maxConnectionMs?: number;

  /** Notified when a shape is refused (unauthorized) or malformed, for logging. */
  readonly onDenied?: (principal: P, reason: string) => void;

  /** The timer seam (injected for tests); defaults to real, `unref`'d timers. */
  readonly timers?: StreamTimers;
}

/** The app-mounted local-first data handler. */
export interface LiveDataHttpHandlers {
  /** Mount at `GET /__lesto/live-data` — the row-data stream. */
  readonly liveData: Handler;
}

/** A coded JSON error response (a non-stream body the runtime negotiates normally). */
function errorResponse(status: number, code: string, message: string) {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ error: { code, message } }),
  };
}

/**
 * Build the app-mounted local-first data handler.
 *
 * Generic over the principal type `P` so the package needs no `@lesto/authz` dependency —
 * the app supplies `resolvePrincipal` and `authorizeShape`. Mount the returned `liveData`
 * handler at `GET /__lesto/live-data` (the reserved path the runtime recognizes as a
 * long-lived stream).
 */
export function createLiveDataHttpHandlers<P>(
  options: LiveDataHttpOptions<P>,
): LiveDataHttpHandlers {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
  const timers = options.timers ?? realStreamTimers;

  const liveData: Handler = async (c) => {
    const principal = await options.resolvePrincipal(c);

    const shapeParam = c.query("shape");
    if (shapeParam === undefined) {
      options.onDenied?.(principal, "missing-shape");

      return errorResponse(400, "LIVE_DATA_MISSING_SHAPE", "Provide a `shape` query parameter.");
    }

    let def: ShapeDefinition;
    try {
      def = parseShapeDefinition(shapeParam);
    } catch {
      options.onDenied?.(principal, "invalid-shape");

      return errorResponse(
        400,
        "LIVE_DATA_INVALID_SHAPE",
        "The `shape` parameter is not a valid shape definition.",
      );
    }

    if (!(await options.authorizeShape(principal, def))) {
      options.onDenied?.(principal, "forbidden");

      return errorResponse(403, "LIVE_DATA_FORBIDDEN", "You are not authorized for this shape.");
    }

    // Subscribe BEFORE opening the stream so a registry error (unknown table/column,
    // non-unique key) is a clean 400, not a 200 stream that dies on first byte.
    let source: ShapeStreamSource;
    try {
      source = await subscribeSource(options.engine, def);
    } catch (error) {
      if (error instanceof LiveServerError) {
        options.onDenied?.(principal, error.code);

        return errorResponse(400, error.code, error.message);
      }

      throw error;
    }

    const body = openShapeStream({
      source,
      signal: c.signal,
      heartbeatMs,
      maxQueue,
      timers,
      ...(options.revalidate === undefined
        ? {}
        : { revalidate: () => options.revalidate!(principal) }),
      ...(options.reauthMs === undefined ? {} : { reauthMs: options.reauthMs }),
      ...(options.maxConnectionMs === undefined
        ? {}
        : { maxConnectionMs: options.maxConnectionMs }),
    });

    return { status: 200, headers: { ...SSE_HEADERS }, body };
  };

  return { liveData };
}
