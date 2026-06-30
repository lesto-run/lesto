/**
 * @lesto/realtime — the cross-process topic bus + SSE fan-out (ADR 0040) behind the
 * in-process `@lesto/pubsub` hub. It carries invalidation **topics**, never row
 * data (the ADR 0027 invariant); ADR 0027 Phase 2's "live `useQuery`" rides it.
 *
 *   - {@link ReplayRing} — the resume-cursor missed-message core (`(instanceId,
 *     generation, index)` cursor with resync-by-default).
 *   - {@link Transport} — the cross-process transport seam; {@link PostgresTransport}
 *     is the `LISTEN/NOTIFY` implementation, fed a `pg.Client` by
 *     {@link createPgListenClientFactory}.
 *   - {@link createRealtimeBus} — wires a transport to the ring + hub (the bridge
 *     that records the global cursor and fans out).
 *   - {@link createRealtimeHttpHandlers} — the app-mounted `GET /__lesto/live` SSE
 *     handler; {@link openLiveStream} is the stream core it drives.
 *   - the SSE codec ({@link encodeCursor} / {@link invalidateFrame} / …) and the
 *     {@link LiveConnection} per-connection outbound logic.
 */

export { ReplayRing } from "./replay-ring";
export type { Cursor, Reconcile, ReplayRingOptions } from "./replay-ring";

export type { Transport } from "./transport";

export { DEFAULT_CHANNEL, PostgresTransport } from "./pg-transport";
export type { PgListenClient, PgNotification, PostgresTransportOptions } from "./pg-transport";

export { createPgListenClientFactory } from "./pg-client";
export type { PgClientConfig } from "./pg-client";

export { createRealtimeBus } from "./bus";
export type { RealtimeBus, RealtimeBusOptions } from "./bus";

export { LiveConnection } from "./connection";
export type { FrameController, LiveConnectionOptions } from "./connection";

export { selectAuthorizedTopics } from "./authz";
export type { TopicSelection } from "./authz";

export {
  commentFrame,
  decodeCursor,
  encodeCursor,
  invalidateFrame,
  parseTopics,
  resyncFrame,
} from "./sse";

export { createRealtimeHttpHandlers, openLiveStream } from "./http-handlers";
export type {
  LiveStreamConfig,
  RealtimeHttpHandlers,
  RealtimeHttpOptions,
  TimerSeam,
} from "./http-handlers";
