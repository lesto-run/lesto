/**
 * @lesto/pubsub — an in-process pub/sub hub PLUS the transport-neutral WebSocket
 * fan-out core behind the `examples/pubsub` substrates: the `fanout()` send policy
 * (with backpressure) + `FanoutRegistry`, the bounded replay-ring eviction arithmetic
 * (`replayEvictionBounds`), and signed per-channel capability tokens (`mintChannelToken`
 * / `verifyChannelToken`). Dependency-free and 100%-covered.
 *
 *   const hub = new PubSub();
 *   const off = hub.subscribe("orders", (message, channel) => { ... });
 *   await hub.publish("orders", { id: 1 });
 *   off();
 */

export { PubSub } from "./pubsub";
export type { Listener, PublishResult } from "./pubsub";

export { FanoutRegistry, encodeFrame, fanout, parsePublishBody } from "./fanout";
export type {
  FanoutFrame,
  FanoutOptions,
  FanoutResult,
  FanoutSocket,
  PublishRequest,
} from "./fanout";

export { replayEvictionBounds } from "./replay";
export type { ReplayEvictionBounds, ReplayRetention } from "./replay";

export { mintChannelToken, verifyChannelToken } from "./channel-token";
export type {
  ChannelGrant,
  ChannelMode,
  ChannelTokenFailure,
  ChannelTokenResult,
} from "./channel-token";
