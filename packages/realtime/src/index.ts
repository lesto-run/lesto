/**
 * @lesto/realtime — the cross-process topic bus + SSE fan-out (ADR 0040) behind the
 * in-process `@lesto/pubsub` hub. This entry exposes the pure cores landed so far:
 *
 *   - {@link ReplayRing} — the resume-cursor missed-message core (`(instanceId, generation,
 *     index)` cursor with resync-by-default);
 *   - {@link Transport} — the cross-process transport seam the Postgres / edge backends
 *     implement.
 *
 * The Postgres `LISTEN/NOTIFY` transport and the `createRealtimeHttpHandlers` SSE endpoint
 * compose these and land in later increments of the same package.
 */

export { ReplayRing } from "./replay-ring";
export type { Cursor, Reconcile, ReplayRingOptions } from "./replay-ring";
export type { Transport } from "./transport";
