/**
 * @lesto/pubsub — an in-process publish/subscribe hub.
 *
 *   const hub = new PubSub();
 *   const off = hub.subscribe("orders", (message, channel) => { ... });
 *   await hub.publish("orders", { id: 1 });
 *   off();
 */

export { PubSub } from "./pubsub";
export type { Listener } from "./pubsub";

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
