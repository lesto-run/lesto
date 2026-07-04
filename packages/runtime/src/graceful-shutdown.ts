/**
 * Graceful shutdown for a long-lived Lesto server — productized so a container
 * (or a local `bun run serve`) drains cleanly on a rolling restart instead of
 * being SIGKILL'd mid-request.
 *
 * `serve()` already drains in-flight requests inside `server.close()`; what every
 * long-lived entrypoint then hand-rolls on top is the *process* lifecycle around
 * it — bind loopback by default but let a container override the host, register
 * SIGTERM + SIGINT, guard against a double signal re-entering teardown, `.catch`
 * the chain so a failing teardown still exits (never a hang to SIGKILL, never an
 * unhandled rejection), and — the one thing even the hand-rolled hardened
 * entrypoints lack — force-exit if the whole teardown itself wedges past a
 * deadline. This module owns that once, so the examples and the CLI dogfood it
 * rather than re-deriving it (three different ways, one of them missing the
 * double-signal guard).
 *
 * The full teardown timeline spans three hooks across two layers: `onShutdown`
 * (stop new work — BEFORE the drain) → `server.close()` drains, running any
 * `onDrain` from {@link ServeOptions} DURING it → `onClosed` (release resources —
 * AFTER the drain).
 *
 *   const server = await serveWithGracefulShutdown(app, {
 *     port: 3000,
 *     host: process.env.HOST ?? "127.0.0.1", // 0.0.0.0 in a container
 *     onShutdown: () => engine.stop(),        // stop new work — BEFORE the drain
 *     onClosed: () => close(),                // release resources — AFTER the drain
 *   });
 *   console.log(`listening on ${server.port}`);
 */

import type { App } from "@lesto/kernel";

import { DEFAULT_DRAIN_TIMEOUT_MS, serve } from "./server";
import type { ServeOptions, Server } from "./server";

/** The loopback address a server binds unless a caller (a container) overrides it. */
const DEFAULT_HOST = "127.0.0.1";

/**
 * How much longer the outer force-EXIT deadline sits past the socket-drain window.
 *
 * `server.close()` already force-CLOSES stragglers at `drainTimeoutMs`; this grace
 * is the extra headroom the *rest* of the teardown (an `onShutdown` that stops a
 * replication source, an `onClosed` that closes a database) gets before the whole
 * process is force-EXITED. So the default force-exit deadline is
 * `drainTimeoutMs + this`, always comfortably past the drain it wraps.
 */
const DEFAULT_FORCE_EXIT_GRACE_MS = 5_000;

/**
 * The process/timer seams {@link onShutdownSignals} touches — injected so a test
 * drives the signal handlers, the exit, and the force-exit timer WITHOUT
 * registering real handlers or killing the test process. Real defaults wire the
 * live `process` and `setTimeout`.
 */
export interface SignalDeps {
  /** Register a handler for a termination signal (real: `process.on`). */
  on(signal: "SIGINT" | "SIGTERM", handler: () => void): void;

  /** Exit the process with a status code (real: `process.exit`). */
  exit(code: number): void;

  /**
   * Schedule the force-exit callback, `unref`'d so a pending force-exit timer can
   * never itself keep the process alive (real: `setTimeout(...).unref()`).
   */
  setForceExitTimer(callback: () => void, ms: number): void;

  /** Where a teardown failure / force-exit line goes (real: `console.error`). */
  logError(message: string, error?: unknown): void;
}

/** The live seams: the real `process`, a real `unref`'d timer, and `console.error`. */
export const realSignalDeps: SignalDeps = {
  on: (signal, handler) => {
    process.on(signal, handler);
  },

  exit: (code) => {
    process.exit(code);
  },

  setForceExitTimer: (callback, ms) => {
    setTimeout(callback, ms).unref();
  },

  logError: (message, error) => {
    if (error === undefined) {
      console.error(message);

      return;
    }

    console.error(message, error);
  },
};

/** Tuning for {@link onShutdownSignals}. */
export interface ShutdownSignalOptions {
  /**
   * Force-exit(1) if the whole `teardown` chain has not settled within this many
   * ms — the backstop for a teardown step that itself wedges (a `close()` that
   * hangs, a `stop()` that never resolves). Omit to never force (the CLI's
   * `installShutdown`, whose injected `drain` is trusted to settle, does this — it
   * wants only the double-signal guard). {@link serveWithGracefulShutdown} always
   * sets it.
   */
  readonly forceExitTimeoutMs?: number;
}

/**
 * Register SIGTERM + SIGINT handlers that run `teardown` exactly once, then exit.
 *
 * The contract every long-lived Lesto process wants, in one place:
 *   - a **double-signal guard** — a second Ctrl-C (or a SIGINT then SIGTERM)
 *     while teardown is already running is a no-op, never a re-entry;
 *   - exit `0` once `teardown` resolves; on a REJECTION, log it and exit `1` —
 *     never an unhandled rejection, never a hang;
 *   - an optional **force-exit(1)** if teardown itself wedges past
 *     {@link ShutdownSignalOptions.forceExitTimeoutMs}, so a deploy's restart is
 *     never held hostage to a stuck drain until the platform SIGKILLs it.
 *
 * The signal wiring, the process exit, and the force-exit timer are the injected
 * {@link SignalDeps}, so every branch is unit-testable without touching the real
 * process. Returns nothing — it installs handlers and hands control back.
 */
export function onShutdownSignals(
  teardown: () => Promise<void>,
  options: ShutdownSignalOptions = {},
  deps: SignalDeps = realSignalDeps,
): void {
  let shuttingDown = false;

  const shutdown = (): void => {
    // The double-signal guard: teardown runs once. A second signal that arrives
    // while it is in flight is dropped rather than re-entering the chain.
    if (shuttingDown) return;

    shuttingDown = true;

    // Backstop the whole teardown, not just the socket drain: if a `stop()`/
    // `close()` hangs, exit anyway rather than waiting for the platform's SIGKILL.
    if (options.forceExitTimeoutMs !== undefined) {
      const timeoutMs = options.forceExitTimeoutMs;

      deps.setForceExitTimer(() => {
        deps.logError(`graceful shutdown exceeded ${timeoutMs}ms — forcing exit`);

        deps.exit(1);
      }, timeoutMs);
    }

    void teardown().then(
      () => deps.exit(0),
      (error: unknown) => {
        deps.logError("graceful shutdown failed", error);

        deps.exit(1);
      },
    );
  };

  deps.on("SIGINT", shutdown);
  deps.on("SIGTERM", shutdown);
}

/** {@link serveWithGracefulShutdown}'s seams: {@link SignalDeps} plus the `serve` it wraps. */
export interface ServeShutdownDeps extends SignalDeps {
  serve(app: App, options: ServeOptions): Promise<Server>;
}

/** The live seams: the real signal wiring plus the real {@link serve}. */
const realServeShutdownDeps: ServeShutdownDeps = { ...realSignalDeps, serve };

/**
 * Options for {@link serveWithGracefulShutdown} — every {@link ServeOptions} knob,
 * plus the two-phase teardown hooks and the force-exit deadline.
 *
 * TWO hooks, not one, because the safe order genuinely differs across the phases
 * of a shutdown and no single point serves both: a change engine or replication
 * source must stop producing BEFORE the drain (so it is not pushing into sockets
 * being torn down / holding a WAL slot open), whereas a database handle or a
 * flush interval must be released AFTER the drain (closing it mid-flight would
 * break the very requests we are draining). So `onShutdown` runs before
 * `server.close()` and `onClosed` runs after it.
 */
export interface GracefulShutdownOptions extends ServeOptions {
  /**
   * App teardown that must run on the shutdown signal, BEFORE the server drains —
   * stop accepting/producing NEW work (a change engine, a replication source, a
   * queue worker; a "shutting down…" log). Awaited; a rejection aborts the
   * remaining teardown and exits 1.
   */
  readonly onShutdown?: () => void | Promise<void>;

  /**
   * App teardown that must run AFTER the server has drained in-flight requests —
   * release resources now that nothing is serving (close the database, stop a
   * flush interval). Awaited; a rejection exits 1. Does NOT run if an earlier
   * teardown step already failed (the process is exiting regardless).
   */
  readonly onClosed?: () => void | Promise<void>;

  /**
   * Force-exit(1) if the whole teardown (onShutdown → drain → onClosed) has not
   * settled within this many ms. Defaults to the effective `drainTimeoutMs` plus
   * a grace, so it always sits past the socket-drain window; raise it alongside
   * `drainTimeoutMs` if a slow teardown needs more room.
   */
  readonly forceExitTimeoutMs?: number;
}

/**
 * Serve a Lesto {@link App} over HTTP with a productized graceful shutdown.
 *
 * Binds loopback by default (a caller passes `host: "0.0.0.0"` in a container),
 * boots the underlying {@link serve}, and wires SIGTERM + SIGINT to a guarded,
 * force-exit-backstopped teardown (see {@link onShutdownSignals}) whose order is
 * the contract: `onShutdown` (stop new work) → `server.close()` (drain) →
 * `onClosed` (release resources) → exit 0.
 *
 * Returns the {@link Server} the moment it is listening — so the caller logs
 * `server.port` — with the signal handlers already installed. The process then
 * stays alive on the open socket until a signal arrives.
 */
export async function serveWithGracefulShutdown(
  app: App,
  options: GracefulShutdownOptions = {},
  deps: ServeShutdownDeps = realServeShutdownDeps,
): Promise<Server> {
  const { onShutdown, onClosed, forceExitTimeoutMs, host, ...serveOptions } = options;

  const drainTimeoutMs = serveOptions.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const effectiveForceExitMs = forceExitTimeoutMs ?? drainTimeoutMs + DEFAULT_FORCE_EXIT_GRACE_MS;

  const server = await deps.serve(app, { ...serveOptions, host: host ?? DEFAULT_HOST });

  onShutdownSignals(
    async () => {
      // Stop taking on new work first, THEN drain, THEN release resources — the
      // one order that serves both a pre-drain producer stop and a post-drain
      // resource release (see the hook docs above).
      await onShutdown?.();

      await server.close();

      await onClosed?.();
    },
    { forceExitTimeoutMs: effectiveForceExitMs },
    deps,
  );

  return server;
}
