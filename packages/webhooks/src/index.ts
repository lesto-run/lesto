/**
 * @lesto/webhooks — signed, retried outbound webhooks on @lesto/queue, plus inbound verification.
 *
 *   // sending: `secretId` is a REFERENCE resolved to the real secret at delivery
 *   // time via the Webhooks `secrets` source; the raw secret never enters the queue.
 *   const hooks = new Webhooks({ queue, secrets });
 *   hooks.send("https://example.com/hook", "order.paid", { id: 42 }, { secretId });
 *
 *   // receiving: the deliverer signs `${timestamp}.${body}`, so verify MUST be
 *   // given the timestamp — without it the signature check fails on every real
 *   // webhook. Read `x-lesto-timestamp` as a Number and pass `{ timestamp }`.
 *   const timestamp = Number(req.headers["x-lesto-timestamp"]);
 *   if (!verify(rawBody, req.headers["x-lesto-signature"], secret, { timestamp })) reject();
 */

export {
  DEFAULT_TOLERANCE_MS,
  defaultUrlGuard,
  EVENT_HEADER,
  sign,
  SIGNATURE_HEADER,
  systemResolver,
  TIMESTAMP_HEADER,
  TRACEPARENT_HEADER,
  verify,
  WebhookError,
  Webhooks,
} from "./webhooks";
export type {
  FetchLike,
  Resolver,
  SecretSource,
  TraceparentSource,
  UrlGuard,
  VerifyOptions,
  WebhookErrorCode,
  WebhookResponse,
  WebhooksOptions,
} from "./webhooks";
