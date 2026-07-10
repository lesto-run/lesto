---
title: "Webhooks"
description: "Send HMAC-signed outbound webhooks as retried @lesto/queue jobs, and verify inbound webhooks against forgery and replay — with built-in SSRF guarding and opt-in Node IP pinning."
section: Batteries
order: 12
---

# Webhooks

`@lesto/webhooks` does two halves of one job: it **sends** webhooks you can't
afford to lose, and it **verifies** the ones you receive. Outbound delivery is a
[queue](/batteries/queue) job — signed with HMAC-SHA256, POSTed, and retried with
backoff until the receiver returns `2xx`. Inbound verification is the mirror
image: recompute the signature and compare in constant time. The core idea is
that a webhook crosses a trust boundary in both directions, so every send is
signed and SSRF-guarded, and every receive is checked against forgery and replay.

## Send a signed webhook

A `Webhooks` instance wraps a [`Queue`](/batteries/queue). `send` doesn't POST
anything itself — it enqueues a delivery job and returns the job id, so the HTTP
call happens on a worker, off the request path:

```ts
import { Webhooks } from "@lesto/webhooks";

const hooks = new Webhooks({ queue, secrets });

// Enqueue a signed delivery. `secretId` is a REFERENCE, not the secret.
const jobId = await hooks.send(
  "https://example.com/hook",
  "order.paid",
  { id: 42 },
  { secretId: "ep-1", maxAttempts: 5 },
);
```

The constructor registers the delivery handler on the queue for you, so the only
thing left to run is the queue's own worker (`queue.work()`) — the same worker
that drains every other job. The wire body is `{ event, data }`; the deliverer
also sets `x-lesto-event` and `x-lesto-timestamp` headers (the header names are
exported as `EVENT_HEADER` and `TIMESTAMP_HEADER`).

## Secrets are references, never rows

The signing secret is never written into a queue row. `send` persists only a
`secretId` reference; the real secret is resolved at delivery time by a
`SecretSource` you inject. A leaked queue table thus leaks no secrets:

```ts
import { Webhooks, type SecretSource } from "@lesto/webhooks";

// secretId -> raw secret. Read from env, a vault, or a `webhook_endpoints` row.
const secrets: SecretSource = (secretId) =>
  secretId === "ep-1" ? process.env.HOOK_SECRET_EP1 : undefined;

const hooks = new Webhooks({ queue, secrets });
```

Returning `undefined` means "no such secret" — delivery then fails loud with a
`WEBHOOK_SECRET_NOT_FOUND` `WebhookError` rather than silently shipping an
unsigned request. If you call `send` with a `secretId` but never configure
`secrets`, that's the same loud failure. Omit `secretId` entirely and the
delivery goes out unsigned (no `x-lesto-signature` header).

## Verify an inbound webhook

On the receiving side, `verifyRequest` does the whole check: it reads the
`x-lesto-signature` / `x-lesto-timestamp` headers, enforces the replay window,
recomputes the HMAC in constant time, and — on success — extracts `event` from
the **signed** body (never the unsigned `x-lesto-event` header, which a forger
can set to anything).

Verify over the **raw bytes**: `c.req.rawBody` is the exact undecoded request
body every Lesto transport captures. Never verify `c.req.body` — it is the
decoded value, and re-stringifying it can change whitespace or key order and
break the signature.

```ts
import { verifyRequest } from "@lesto/webhooks";

app.post("/hook", (c) => {
  const rawBody = c.req.rawBody; // the EXACT signed bytes, never c.req.body
  if (rawBody === undefined) {
    return c.json({ error: "raw body required" }, 400);
  }

  const result = verifyRequest({ body: rawBody, headers: c.req.headers }, { secret });

  if (!result.verified) {
    return c.json({ verified: false, reason: result.reason }, 401);
  }

  // result.event is set only when the signed body is an { event, data } envelope.
  // ...handle the verified payload (JSON.parse(rawBody))
});
```

A failed check carries a `reason` — `"missing_signature"`,
`"missing_timestamp"`, `"malformed_timestamp"`, `"stale_timestamp"`, or
`"signature_mismatch"` — so your receiver can tell a replayed request apart from
a forged one. The replay window is `DEFAULT_TOLERANCE_MS` (five minutes),
overridable with `toleranceMs`; `now` is injectable for tests.

For a multi-tenant receiver, pass a `SecretResolver` instead of a string:
`(ctx) => secretForTenant(ctx.headers["x-tenant"])`. It runs only after the
cheap pre-checks pass, and it fails closed — a resolver that throws or returns
no secret is a `WEBHOOK_SECRET_UNRESOLVED` error, never a silent skip.

The lower-level pieces are exported too: `sign(body, secret)` produces a
signature directly, and `verify(body, signature, secret, { timestamp })` is the
bare constant-time check — if you use it, you must read and pass the timestamp
yourself.

## Destination URLs are SSRF-guarded

Webhook URLs are user-controlled, so before each delivery the worker runs an SSRF
guard. The default `defaultUrlGuard` allows only `http`/`https` to a host whose
**every** resolved address is public — loopback, RFC1918, link-local (including
the cloud metadata endpoint `169.254.169.254`), and other reserved ranges are
refused. Blocking on *any* private address closes the obvious DNS-rebinding
bypass. The deliverer also sets `redirect: "manual"`, so a guarded public URL
can't `302` the request onward to a private endpoint after the guard ran — a `3xx`
is a delivery failure, never a followed hop.

A blocked URL fails permanently (it would resolve to the same refused address on
every attempt), so the queue retires it after one attempt instead of burning the
whole retry schedule. The verdict is injectable via the `urlGuard` option if you
genuinely need internal delivery.

```ts
import { isPrivateAddress, defaultUrlGuard } from "@lesto/webhooks";

isPrivateAddress("169.254.169.254"); // true — refused
isPrivateAddress("93.184.216.34"); //  false — allowed
```

## Closing the DNS-rebinding gap (Node)

The default guard resolves the host, then the platform `fetch` resolves it again —
a hostile DNS server could answer "public" to the guard and "private" to the
connect in the gap between. For Node, `nodePinningFetch()` removes the gap: it
resolves once inside the socket's connect-time lookup, validates every address
with the same `isPrivateAddress` rule, and lets the socket connect only to that
validated set. TLS still verifies against the original hostname (only the connect
address is pinned). Opt in:

```ts
import { Webhooks, nodePinningFetch } from "@lesto/webhooks";

const hooks = new Webhooks({ queue, secrets, fetch: nodePinningFetch() });
```

This is Node-only (it uses `node:http`/`node:https`). The default delivery `fetch`
stays the portable global `fetch` so the Workers edge build is unaffected.

## Notes and gotchas

- **Verify the raw bytes.** Always hand `verifyRequest` the exact bytes from
  `c.req.rawBody`, never the decoded `c.req.body` — re-serialization can change
  whitespace or key order and break the signature.
- **Trust the signed body, not the headers.** `verifyRequest` reports `event`
  from the signed `{ event, data }` payload; the `x-lesto-event` header is
  unsigned convenience metadata. Branch on `result.event`.
- **Low-level `verify` needs the timestamp.** The deliverer signs
  `${timestamp}.${body}`, so `verify(body, sig, secret)` with no options checks a
  *body-only* signature and will reject a real Lesto webhook. Prefer
  `verifyRequest`, which reads the headers for you.
- **Secrets never hit the queue.** Only `secretId` is persisted; the real secret
  is resolved at delivery time. A missing secret is a loud
  `WEBHOOK_SECRET_NOT_FOUND`, not a silent unsigned send.
- **Non-2xx is a failed attempt.** Any response outside `200–299` (including a
  manual `3xx`) throws `WEBHOOK_DELIVERY_FAILED`, which the queue retries with
  backoff up to `maxAttempts`. A blocked URL throws `WEBHOOK_URL_BLOCKED` and is
  retired permanently after one attempt.
- **Errors are coded.** Every failure is a `WebhookError` with a
  `WebhookErrorCode` (`WEBHOOK_DELIVERY_FAILED`, `WEBHOOK_SECRET_NOT_FOUND`,
  `WEBHOOK_SECRET_UNRESOLVED`, `WEBHOOK_URL_BLOCKED`), so callers can branch on
  `instanceof WebhookError`.
- **Tracing is opt-in.** Pass a `traceparent` source and the captured W3C
  `traceparent` rides the queue payload and is emitted on the outbound POST, so
  the receiver joins the enqueuing request's trace. See
  [Observability](/batteries/observability).

See the runnable
[`examples/webhooks`](https://github.com/lesto-run/lesto/tree/main/examples/webhooks)
for both halves wired end to end — a signed send through the queue and a
receiver that `verifyRequest`s it over `c.req.rawBody`. For the worker that
actually drains deliveries, and how retries and `maxAttempts` behave, see
[Background jobs & queues](/batteries/queue).
