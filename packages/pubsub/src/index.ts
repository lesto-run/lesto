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
