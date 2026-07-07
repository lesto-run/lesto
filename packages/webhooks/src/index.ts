/**
 * @lesto/webhooks — signed, retried outbound webhooks on @lesto/queue, plus inbound verification.
 *
 *   // sending: `secretId` is a REFERENCE resolved to the real secret at delivery
 *   // time via the Webhooks `secrets` source; the raw secret never enters the queue.
 *   const hooks = new Webhooks({ queue, secrets });
 *   hooks.send("https://example.com/hook", "order.paid", { id: 42 }, { secretId });
 *
 *   // receiving: verifyRequest reads the signature/timestamp headers, checks
 *   // replay tolerance, and extracts `event` from the SIGNED body — pass it the
 *   // exact raw request bytes (e.g. `c.req.rawBody`), never a re-serialized body.
 *   const result = verifyRequest({ body: rawBody, headers: req.headers }, { secret });
 *   if (!result.verified) reject(result.reason);
 */

export {
  DEFAULT_TOLERANCE_MS,
  defaultUrlGuard,
  EVENT_HEADER,
  isPrivateAddress,
  sign,
  SIGNATURE_HEADER,
  systemResolver,
  TIMESTAMP_HEADER,
  TRACEPARENT_HEADER,
  verify,
  verifyRequest,
  WebhookError,
  Webhooks,
} from "./webhooks";
export type {
  FetchLike,
  Resolver,
  SecretSource,
  TraceparentSource,
  UrlGuard,
  VerifyFailureReason,
  VerifyOptions,
  VerifyRequestInput,
  VerifyRequestOptions,
  VerifyRequestResult,
  WebhookErrorCode,
  WebhookResponse,
  WebhooksOptions,
} from "./webhooks";
export { nodePinningFetch, pinnedLookup } from "./pinning-fetch";
export type {
  HttpRequester,
  NodePinningFetchOptions,
  PinnedClientRequest,
  PinnedResponse,
} from "./pinning-fetch";
