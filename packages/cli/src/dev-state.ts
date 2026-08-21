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
 * `MCP_REQUEST_NOT_RETAINED` case.
 *
 * ADR 0048 Phase 0.2 added the second half that sentence used to disclaim: the
 * bounded TRACE ring (`trace-ring.ts`), keyed by `traceId` and holding the real
 * spans — server spans and the browser-span receiver's payloads alike. It is
 * COMPOSED here rather than wired separately for two reasons: `@lesto/mcp` still
 * takes exactly ONE reader, so every dev tool keeps the same build-time gate (no
 * reader, no tools, no dev surface anywhere off `lesto dev`); and this is the only
 * place holding BOTH rings, which is what lets a `requestId` from the access ring
 * resolve to a `traceId` in the span ring.
 */

import type { AccessEntry } from "@lesto/runtime";

import { createTraceRing, NOT_RETAINED } from "./trace-ring";
import type { TraceRingOptions, TraceRingReader, TraceRingWriter } from "./trace-ring";
import type { DevError } from "./run";

/** Default capacity for the log and request rings — bounded so memory can't grow unbounded. */
export const DEFAULT_DEV_RING_CAPACITY = 200;

/** The last `n` entries of a ring, oldest-first; `[]` for a non-positive `n`. */
const tail = <T>(ring: readonly T[], n: number): T[] =>
  n <= 0 ? [] : ring.slice(Math.max(0, ring.length - n));

/** The reader half the dev MCP tools consume (mirrored structurally by `@lesto/mcp`'s own seam). */
export interface DevStateReader extends TraceRingReader {
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
export interface DevStateWriter extends TraceRingWriter {
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
 * `recentRequests`, `spanFor`, and the `requestId` → `traceId` resolution), AND —
 * by default — the number of traces the composed trace ring retains. Aligning those
 * two is not cosmetic: the workflow the dev tools advertise is "take a `requestId`
 * from `get_recent_requests`, hand it to `get_trace`", so a shorter trace window
 * would answer `retained: false` for most of the requests the other tool just
 * reported. It is an ALIGNMENT, not a guarantee — traces with no request behind
 * them (a browser-rooted RUM trace, a background job) share the same window — but
 * it removes the systematic mismatch. `traceRing` overrides either cap.
 */
export function createDevState(
  capacity: number = DEFAULT_DEV_RING_CAPACITY,
  traceRing: TraceRingOptions = {},
): DevState {
  let currentError: DevError | undefined;
  const logs: string[] = [];
  const requests: AccessEntry[] = [];

  const traces = createTraceRing({ traceCapacity: capacity, ...traceRing });

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

    recordSpan: (span) => traces.recordSpan(span),

    getDiagnostics: () => currentError,
    recentRequests: (n) => tail(requests, n),
    recentLogs: (n) => tail(logs, n),
    spanFor: (requestId) => requests.find((entry) => entry.requestId === requestId),
    // The one place that holds BOTH rings, and therefore the one place a
    // `requestId` becomes a `traceId`: the runtime stamps the trace on the access
    // entry beside the request span, so the correlation is read from the server's
    // own record — never from a span attribute a client-supplied browser span
    // could set. A request served untraced (a 400 on an unparsable target, an
    // in-flight shed, the first byte of a long-lived stream) carries no trace, and
    // answers as not retained.
    retainedTrace: (selector) => {
      if (selector.traceId !== undefined || selector.requestId === undefined) {
        return traces.retainedTrace(selector);
      }

      const traceId = requests.find((entry) => entry.requestId === selector.requestId)?.traceId;

      return traceId === undefined ? NOT_RETAINED : traces.retainedTrace({ traceId });
    },
  };
}
