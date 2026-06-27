/**
 * The bounded live-dev-state ring (ADR 0032 Phase 1) — the keystone the dev MCP
 * tools and the `lesto dev` watcher both sit on.
 *
 * A pure, fixed-size in-memory record the watcher FILLS (the current build/reload
 * error, recent log lines, recent served requests) and the read-only dev tools
 * READ. No socket, no fs, no process — a struct builder exactly like
 * `dev-overlay.ts`, so it is fully unit-testable; the bin injects it into `runDev`
 * (the writer) and the dev MCP context (the reader).
 *
 * Every ring is capped — deny-by-default, so a long dev session can never grow
 * memory unbounded. The request ring doubles as the deferred Phase-3
 * `explain_request` producer: `spanFor` looks a `requestId` up in the retained
 * window, and a request that has aged out of the ring is the
 * `MCP_REQUEST_NOT_RETAINED` case. (Phase 1 retains the access record per request;
 * a richer per-request span tree is ADR 0031 / Phase 3 — this plan mints no spans
 * of its own beyond the access-log entries the seam fills.)
 */

import type { AccessEntry } from "@lesto/runtime";

import type { DevError } from "./run";

/** Default capacity for the log and request rings — bounded so memory can't grow unbounded. */
export const DEFAULT_DEV_RING_CAPACITY = 200;

/** The last `n` entries of a ring, oldest-first; `[]` for a non-positive `n`. */
const tail = <T>(ring: readonly T[], n: number): T[] =>
  n <= 0 ? [] : ring.slice(Math.max(0, ring.length - n));

/** The reader half the dev MCP tools consume (mirrored structurally by `@lesto/mcp`'s own seam). */
export interface DevStateReader {
  /** The current build/reload error, or `undefined` when the last change succeeded. */
  getDiagnostics(): DevError | undefined;

  /** The most recent served requests, oldest-first, capped at `n` (or the ring size). */
  recentRequests(n: number): AccessEntry[];

  /** The most recent dev log lines, oldest-first, capped at `n` (or the ring size). */
  recentLogs(n: number): string[];

  /** The retained access record for a `requestId`, or `undefined` when it has aged out. */
  spanFor(requestId: string): AccessEntry | undefined;
}

/** The writer half the dev watcher (`runDev`) feeds. */
export interface DevStateWriter {
  /** Record (or clear, with `undefined`) the current build/reload error. */
  setError(error: DevError | undefined): void;

  /** Append a dev log line to the bounded ring. */
  appendLog(line: string): void;

  /** Record one served request — the access-log seam feeds this. */
  recordRequest(entry: AccessEntry): void;
}

/** The full live-dev-state ring — writer + reader over one bounded store. */
export interface DevState extends DevStateReader, DevStateWriter {}

/**
 * Build a bounded live-dev-state ring.
 *
 * `capacity` caps BOTH the log ring and the request ring (the request ring backs
 * both `recentRequests` and `spanFor`); past it, the oldest entry is dropped.
 */
export function createDevState(capacity: number = DEFAULT_DEV_RING_CAPACITY): DevState {
  let currentError: DevError | undefined;
  const logs: string[] = [];
  const requests: AccessEntry[] = [];

  const pushBounded = <T>(ring: T[], value: T): void => {
    ring.push(value);

    if (ring.length > capacity) ring.shift();
  };

  return {
    setError: (error) => {
      currentError = error;
    },
    appendLog: (line) => pushBounded(logs, line),
    recordRequest: (entry) => pushBounded(requests, entry),

    getDiagnostics: () => currentError,
    recentRequests: (n) => tail(requests, n),
    recentLogs: (n) => tail(logs, n),
    spanFor: (requestId) => requests.find((entry) => entry.requestId === requestId),
  };
}
