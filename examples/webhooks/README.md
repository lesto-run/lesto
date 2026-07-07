# examples/webhooks — signed delivery + verified receipt over HTTP

Wires **`@lesto/webhooks`** behind real HTTP routes, both directions: signed,
queue-retried, **SSRF-guarded** outbound delivery, and inbound `verify()` over the
raw body that rejects forged, replayed, and unsigned requests.

## What it shows

One app plays both sides of a webhook exchange.

| Route            | Behavior                                                                                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /orders`   | Places an order and `hooks.send`s a signed `order.paid` webhook to the customer's `subscriberUrl` — a `@lesto/queue` job, HMAC-signed over `${timestamp}.${body}`, SSRF-guarded, with the secret held as a `secretId` reference (never in the queue row). |
| `POST /incoming` | The receiver: `verify()`s the timestamp-bound signature over the **raw body** before recording the event.                                                                                                                                                 |
| `GET /received`  | The webhooks the receiver accepted.                                                                                                                                                                                                                       |

- **Outbound is a queue job.** `POST /orders` returns `202` with a job id;
  nothing is delivered until the queue runs. Delivery signs, guards the URL, and
  POSTs — retrying on non-2xx.
- **The SSRF guard is real.** `subscriberUrl` is attacker-influenced (a customer
  registers it), so a URL pointing at `169.254.169.254` (cloud metadata),
  loopback, or RFC1918 is refused — a **permanent** failure, retired after one
  attempt, never retried, with **no connection ever attempted** to the private
  address (the guard runs before `fetch`). The test asserts the delivery `fetch`
  was never called _and_ points the blocked URL at the real `/incoming` route, so
  a bypassed guard would deliver-and-verify (`done`, recorded) and fail the test —
  the assertion genuinely discriminates. Only DNS is injected (deterministic, no
  network); the guard logic is `@lesto/webhooks`' default.
- **Inbound verification is genuine.** A correctly-signed request is accepted; a
  tampered body, a replay past the five-minute window, and an unsigned request are
  all `401`.

Delivery is dispatched **in-process** by an injected `FetchLike` that hands the
exact signed bytes straight to `/incoming` — so there is no port to open and,
crucially, the **raw body survives** for verification (see the DX finding).

Only `@lesto/webhooks`' public API is used for signing/guarding/verifying
(`Webhooks`, `verify`, `sign`, the header constants, the `FetchLike` / `Resolver`
/ `SecretSource` types); delivery rides `@lesto/queue`; routes are `@lesto/web`;
the database is `@lesto/runtime`'s `openSqlite`.

## How to run

```bash
bun run examples/webhooks/run.ts
```

Delivers one webhook to the public demo endpoint (verified + received) and one to
the metadata address (refused by the guard, nothing received), printing the queue
outcome and the receiver's inbox at each step.

## How it's tested (the QA gate)

```bash
bun run --filter '@lesto/example-webhooks' test
```

`test/webhooks.test.ts` asserts, over HTTP: end-to-end sign → queue → deliver →
verify; the SSRF guard refusing the metadata address (`failed`, nothing received);
and the inbound receiver accepting a genuine request while rejecting a tampered
body, a stale replay, and an unsigned one.

## DX findings

1. **`@lesto/web`/`@lesto/runtime` give a controller no raw request body.**
   `toLestoRequest` JSON-decodes an `application/json` body and discards the raw
   string; `LestoRequest` exposes only the decoded value. But an HMAC signature is
   over the **exact bytes** — re-`JSON.stringify`ing the parsed body is fragile
   (key order, whitespace, number formatting). This example verifies correctly
   only because the in-process dispatch hands the raw string to `handle`, which
   does not decode it. A **hosted** receiver behind `@lesto/runtime`'s HTTP server
   would break. → route to `core-runtime`/`@lesto/web`: expose a `rawBody` (or a
   "skip-decode" content-type opt-in) so signature verification works on the
   deployed edge. **This is why the hosted-receiver leg is deferred**, not shipped
   as a broken `serve.ts`. **Blast radius:** this affects _body-signature inbound
   receivers_ (Stripe/GitHub/Slack/Shopify-style webhooks) — the canonical
   batteries-included use case. It does **not** affect the auth stack (identity
   tokens + signed sessions HMAC self-contained claims, not the request body) or
   the MCP transport (constant-time compare of a _bearer token_, not a body
   signature), both verified.
2. **`verify` has no receiver-side secret resolution.** The sender has a
   `SecretSource` (`secretId` → secret); the receiver has to look its secret up by
   hand (here, one shared constant). A symmetric inbound helper — resolve the
   endpoint's secret from an id carried on the request, then verify — would make
   the receive side as turnkey as the send side. → `@lesto/webhooks`.
