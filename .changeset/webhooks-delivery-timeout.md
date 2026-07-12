---
"@lesto/webhooks": minor
---

Outbound webhook delivery is now bounded by a per-request timeout.

A slow or hostile tenant URL could previously hold a `fetch` open indefinitely, pinning the queue worker that drives delivery — a tenant-triggerable denial of service against the delivery pipeline. Delivery now attaches `AbortSignal.timeout(deliveryTimeoutMs)` (default `10_000`ms, comfortably under the queue's visibility window) to the request, and the node pinning-fetch path threads the signal through to `node:http`/`node:https` so an abort destroys the socket rather than leaking it.

A timeout surfaces as a distinct, retryable `WEBHOOK_DELIVERY_TIMEOUT` error (new `WebhookErrorCode` member) carrying `{ url, timeoutMs, cause }` — it is *not* marked a permanent failure, so the queue retries it like any transient error. The mapping is structural, not name-based: `AbortSignal.timeout()` rejects with a `TimeoutError` on the fetch/undici/workerd path but an `AbortError` on Node's `http.request`, and a coded transport error (e.g. the SSRF guard's `WEBHOOK_URL_BLOCKED`) is re-thrown untouched rather than being masked as a timeout.

Configure via the new `deliveryTimeoutMs` option on `WebhooksOptions`.
