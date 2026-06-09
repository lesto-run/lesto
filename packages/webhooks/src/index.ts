/**
 * @keel/webhooks — signed, retried outbound webhooks on @keel/queue, plus inbound verification.
 *
 *   const hooks = new Webhooks({ queue });
 *   hooks.send("https://example.com/hook", "order.paid", { id: 42 }, { secret });
 *
 *   // receiving:
 *   if (!verify(rawBody, req.headers["x-keel-signature"], secret)) reject();
 */

export {
  defaultUrlGuard,
  EVENT_HEADER,
  sign,
  SIGNATURE_HEADER,
  systemResolver,
  verify,
  WebhookError,
  Webhooks,
} from "./webhooks";
export type {
  FetchLike,
  Resolver,
  SecretSource,
  UrlGuard,
  WebhookErrorCode,
  WebhookResponse,
  WebhooksOptions,
} from "./webhooks";
