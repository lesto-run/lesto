/**
 * The SSE browser fan-out (ADR 0040 Phase B): the app-mounted `GET /__lesto/live`
 * handler and the live-stream core it drives.
 *
 * Mounted by the app exactly like `@lesto/mcp`'s `createMcpHttpHandlers` — it reads
 * the principal from the per-request context and stays out of the kernel. The
 * runtime recognizes the reserved path as a long-lived stream (the response kind
 * landed in `@lesto/runtime`), so the held connection takes no in-flight slot, is
 * never compressed, and tears down on disconnect.
 *
 * Per connection the handler: resolves the principal, parses the requested topics
 * and the resume cursor, authorizes each topic (dropping — not failing — the
 * unauthorized, closing the change-timing side-channel), then opens a long-lived
 * `ReadableStream` that reconciles the cursor (precise replay or coarse resync),
 * subscribes the authorized topics to the in-process hub, heart-beats, optionally
 * re-authorizes on an interval / bounds the lifetime, and tears everything down on
 * `context.signal` disconnect. Every DECISION is delegated to a tested pure module
 * ({@link selectAuthorizedTopics}, {@link LiveConnection}, the SSE codec); this file
 * is the composition over a `ReadableStream` + timers, tested against an injected
 * timer seam and a real hub.
 */

import type { PubSub } from "@lesto/pubsub";
import type { Context, Handler, LestoResponse } from "@lesto/web";

import { selectAuthorizedTopics } from "./authz";
import { LiveConnection } from "./connection";
import { decodeCursor, parseTopics } from "./sse";
import type { FrameController } from "./connection";
import type { Cursor, ReplayRing } from "./replay-ring";

/**
 * The timer seam — injected so a test fires intervals/timeouts deterministically;
 * defaults to real, `unref`'d timers (a heartbeat must never keep the process up).
 */
export interface TimerSeam {
  setInterval(callback: () => void, ms: number): unknown;

  clearInterval(handle: unknown): void;

  setTimeout(callback: () => void, ms: number): unknown;

  clearTimeout(handle: unknown): void;
}

const realTimers: TimerSeam = {
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
  // Defeat a buffering reverse proxy (nginx/ingress) that would otherwise hold frames.
  "x-accel-buffering": "no",
  connection: "keep-alive",
};

const DEFAULT_MAX_TOPICS = 64;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_QUEUE = 256;
const DEFAULT_REAUTH_MS = 60_000;

/** What {@link openLiveStream} needs to hold one connection open. */
export interface LiveStreamConfig {
  /** The in-process hub (channels = topics, message = the ring-assigned {@link Cursor}). */
  readonly hub: PubSub;

  /** The process replay ring — read to reconcile the resume cursor. */
  readonly ring: ReplayRing;

  /** The topics this connection subscribes to (already authorized). */
  readonly authorizedTopics: readonly string[];

  /** The resume cursor (decoded `Last-Event-ID`), or `undefined` for a fresh client. */
  readonly since: Cursor | undefined;

  /** The request's abort signal — fires on client disconnect, tearing the stream down. */
  readonly signal: AbortSignal | undefined;

  /** Heartbeat interval (a `: ping` comment), under the tightest intermediary idle timeout. */
  readonly heartbeatMs: number;

  /** The per-connection outbound buffer bound — a slow client past it is dropped to resync. */
  readonly maxQueue: number;

  /** The timer seam (injected for tests). */
  readonly timers: TimerSeam;

  /**
   * A periodic re-authorization (ADR 0040 step 4 / `L-85655d2c`): re-resolves
   * session validity so a revoked/expired session has its stream severed. Absent →
   * no periodic re-auth (connect-time authz only). Returning `false` tears down.
   */
  readonly revalidate?: () => boolean | Promise<boolean>;

  /** The re-auth interval in ms (only used when {@link revalidate} is set). */
  readonly reauthMs?: number;

  /**
   * A hard cap on connection lifetime in ms: the stream is severed and the client
   * transparently reconnects (re-authorizing). Absent → unbounded (the heartbeat
   * and disconnect teardown still apply).
   */
  readonly maxConnectionMs?: number;
}

/**
 * Open one live SSE stream: reconcile the cursor, subscribe the authorized topics,
 * heartbeat, optionally re-auth / bound the lifetime, and tear down on disconnect.
 *
 * The returned `ReadableStream<string>` uses a counting strategy with a high-water
 * mark of `maxQueue`, so the controller's `desiredSize` IS the bounded outbound
 * queue: when a slow client exhausts it, {@link LiveConnection} drops that one
 * connection to a `resync` and closes — never stalling the shared delivery stream.
 *
 * Teardown is idempotent and reached three ways: client disconnect (`signal`
 * abort), the consumer cancelling the stream, overflow, the TTL, or a failed
 * re-auth. It unsubscribes every topic, clears every timer, and closes the
 * connection.
 */
export function openLiveStream(config: LiveStreamConfig): ReadableStream<string> {
  const { hub, ring, authorizedTopics, since, signal, timers } = config;

  const unsubscribes: Array<() => void> = [];
  const timerHandles: Array<{ kind: "interval" | "timeout"; handle: unknown }> = [];

  let connection: LiveConnection | undefined;
  let torn = false;

  const teardown = (): void => {
    if (torn) return;

    torn = true;

    for (const off of unsubscribes) off();

    for (const { kind, handle } of timerHandles) {
      if (kind === "interval") timers.clearInterval(handle);
      else timers.clearTimeout(handle);
    }

    signal?.removeEventListener("abort", teardown);

    connection?.close();
  };

  return new ReadableStream<string>(
    {
      start(controller) {
        connection = new LiveConnection({
          ring,
          // A `ReadableStreamDefaultController<string>` structurally satisfies
          // FrameController (desiredSize / enqueue / close).
          controller: controller as unknown as FrameController,
          // Overflow already closed the controller; just release the subscriptions/timers.
          onOverflow: teardown,
        });

        // A client that disconnected before we finished setup: tear down at once.
        if (signal?.aborted === true) {
          teardown();

          return;
        }

        // Emit the initial replay/resync for the resume cursor.
        connection.open(since);

        // Subscribe each authorized topic; the hub message IS the ring-assigned cursor.
        for (const topic of authorizedTopics) {
          const off = hub.subscribe(topic, (message) => {
            connection?.deliver(topic, message as Cursor);
          });

          unsubscribes.push(off);
        }

        // Heartbeat: hold the stream open past intermediary idle timeouts.
        timerHandles.push({
          kind: "interval",
          handle: timers.setInterval(() => connection?.heartbeat(), config.heartbeatMs),
        });

        // Periodic re-auth (optional): a revoked/expired session is severed.
        // `revalidate` is app code, so it may throw SYNCHRONOUSLY or reject — both
        // must FAIL CLOSED (sever the stream), never escape the timer callback as an
        // uncaught exception/rejection. Calling it inside `.then(() => …)` funnels a
        // sync throw into the rejection path, and the `.catch` tears down on either.
        if (config.revalidate !== undefined) {
          const revalidate = config.revalidate;

          timerHandles.push({
            kind: "interval",
            handle: timers.setInterval(() => {
              void (async () => {
                try {
                  // `await` makes a SYNCHRONOUS throw from `revalidate()` land in
                  // this `catch` too, not just an async rejection.
                  if (!(await revalidate())) teardown();
                } catch {
                  // A revalidation error is treated as "no longer valid" — sever.
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
            handle: timers.setTimeout(teardown, config.maxConnectionMs),
          });
        }

        // Disconnect teardown — the runtime aborts `signal` with
        // `RUNTIME_CLIENT_DISCONNECTED` when the client hangs up.
        signal?.addEventListener("abort", teardown);
      },

      // The consumer cancelled (the runtime tore the body down): same teardown.
      cancel() {
        teardown();
      },
    },
    new CountQueuingStrategy({ highWaterMark: config.maxQueue }),
  );
}

/** What {@link createRealtimeHttpHandlers} needs — the hub/ring plus the app's authz seams. */
export interface RealtimeHttpOptions<P> {
  /** The in-process hub the transport feeds (channels = topics). */
  readonly hub: PubSub;

  /** The process replay ring. */
  readonly ring: ReplayRing;

  /** Resolve the acting principal from the request context (the app's own gate). */
  readonly resolvePrincipal: (c: Context) => P | Promise<P>;

  /**
   * Authorize one topic for the principal — principal→tenant-scope, the net-new
   * seam (`L-85655d2c`). An unauthorized topic is dropped, not fatal.
   */
  readonly authorizeTopic: (principal: P, topic: string) => boolean | Promise<boolean>;

  /** Max topics one connection may subscribe to. Defaults to 64. */
  readonly maxTopicsPerConnection?: number;

  /** Heartbeat interval in ms. Defaults to 30s. */
  readonly heartbeatMs?: number;

  /** Per-connection outbound buffer bound. Defaults to 256. */
  readonly maxQueue?: number;

  /** Periodic re-auth (`L-85655d2c`): re-resolve session validity; `false` severs the stream. */
  readonly revalidate?: (principal: P) => boolean | Promise<boolean>;

  /** Re-auth interval in ms (only when {@link revalidate} is set). Defaults to 60s. */
  readonly reauthMs?: number;

  /** Hard connection-lifetime cap in ms. Absent → unbounded. */
  readonly maxConnectionMs?: number;

  /** Notified of dropped (unauthorized / over-cap) topics, for logging. */
  readonly onDropped?: (principal: P, topics: readonly string[]) => void;

  /** The timer seam (injected for tests); defaults to real, `unref`'d timers. */
  readonly timers?: TimerSeam;
}

/** The app-mounted realtime handler(s). */
export interface RealtimeHttpHandlers {
  /** Mount at `GET /__lesto/live` — the SSE fan-out. */
  readonly live: Handler;
}

/**
 * Build the app-mounted realtime handler for the SSE fan-out.
 *
 * Generic over the principal type `P` so the package needs no `@lesto/authz`
 * dependency — the app supplies `resolvePrincipal` and `authorizeTopic`. Mount the
 * returned `live` handler at `GET /__lesto/live` (the reserved path the runtime
 * recognizes as a long-lived stream).
 */
export function createRealtimeHttpHandlers<P>(
  options: RealtimeHttpOptions<P>,
): RealtimeHttpHandlers {
  const maxTopics = options.maxTopicsPerConnection ?? DEFAULT_MAX_TOPICS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
  const timers = options.timers ?? realTimers;

  const live: Handler = async (c): Promise<LestoResponse<ReadableStream>> => {
    const principal = await options.resolvePrincipal(c);

    const requested = parseTopics(c.query("topics"));

    const { authorized, dropped } = await selectAuthorizedTopics(
      principal,
      requested,
      options.authorizeTopic,
      maxTopics,
    );

    // Dropped topics are not fatal — the connection still opens for what the
    // principal may see — but the drop is surfaced for logging.
    if (dropped.length > 0) options.onDropped?.(principal, dropped);

    // The resume cursor: `Last-Event-ID` (EventSource's native reconnect header),
    // falling back to an explicit `?lastEventId=` for a non-EventSource client.
    const since = decodeCursor(c.header("last-event-id") ?? c.query("lastEventId"));

    const body = openLiveStream({
      hub: options.hub,
      ring: options.ring,
      authorizedTopics: authorized,
      since,
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

  return { live };
}
