# examples/webhooks — signed delivery + verified receipt over HTTP

Wires **`@lesto/webhooks`** behind real HTTP routes, both directions: signed,
queue-retried, **SSRF-guarded** outbound delivery, and inbound `verifyRequest()`
over the raw body that rejects forged, replayed, and unsigned requests.

## What it shows

One app plays both sides of a webhook exchange.

| Route            | Behavior                                                                                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /orders`   | Places an order and `hooks.send`s a signed `order.paid` webhook to the customer's `subscriberUrl` — a `@lesto/queue` job, HMAC-signed over `${timestamp}.${body}`, SSRF-guarded, with the secret held as a `secretId` reference (never in the queue row). |
| `POST /incoming` | The receiver: `verifyRequest()`s the timestamp-bound signature over `c.req.rawBody` — the exact undecoded request bytes — before recording the event.                                                                                                    |
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

`run.ts`/the test dispatch delivery **in-process** via an injected `FetchLike`
that hands the exact signed bytes straight to `/incoming` as `rawBody` — no
network, no ports. `serve.ts` proves the SAME `/incoming` route also verifies
correctly behind a **real** `node:http` socket, and `test/hosted.test.ts` proves
it behind the real Cloudflare edge decode (`toFetchHandler`) — in every case the
signature is checked over `c.req.rawBody`, the exact undecoded bytes, populated
by every transport (see the DX finding, now RESOLVED).

Only `@lesto/webhooks`' public API is used for signing/guarding/verifying
(`Webhooks`, `verifyRequest`, `sign`, the header constants, the `FetchLike` /
`Resolver` / `SecretSource` types); delivery rides `@lesto/queue`; routes are
`@lesto/web`; the database is `@lesto/runtime`'s `openSqlite`.

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

`test/hosted.test.ts` is the anti-false-green companion: every test above drives
`/incoming` through the in-process `app.handle`, which never decodes a body (so
`rawBody === body` there and the seam through a real edge/node decode is never
exercised). It instead wraps the same app in a real kernel `App` (`createApp`,
secure defaults ON) and adapts it with `@lesto/cloudflare`'s `toFetchHandler`,
then POSTs a genuinely-signed `Request` — proving `c.req.rawBody` survives the
real edge→kernel→handle chain end to end, with no server and no network.

## How to deploy / run the hosted leg

```bash
bun run examples/webhooks/serve.ts
```

`buildApp` returns a bare `@lesto/web` app — `serve.ts` wraps it with
`@lesto/kernel`'s `createApp` and serves THAT behind a real `node:http` server
(`@lesto/runtime`'s `serveWithGracefulShutdown`), with a `queue.work()` worker
draining outbound deliveries continuously (mirroring
`examples/mailing-lists/serve.ts`). The outbound leg is unchanged from `run.ts`
(delivery still hands signed bytes to `/incoming` in-process, no real network
hop); what's new is that `/incoming` now runs behind an **actual socket** — a
real client connects, this server reads bytes off the wire, and `c.req.rawBody`
still carries the exact bytes `verifyRequest` hashes:

```bash
curl -X POST localhost:3000/orders -H 'content-type: application/json' \
  -d '{"orderId":"ord_1","amountCents":2500,"subscriberUrl":"https://hooks.example.com/incoming"}'
curl localhost:3000/received
```

**Note:** an INVALID-JSON `application/json` body 400s in `@lesto/runtime`'s
`parseBody` before `/incoming` (or any handler) ever runs — fine for real
webhook senders, which always send valid JSON; it only matters if you're
hand-crafting a deliberately malformed request against the receiver directly
(see `serve.ts`'s doc comment for a hand-signed curl recipe).

**Not run in this sandbox** — starting a server is blocked here. `serve.ts` is
typechecked and oxlint/oxfmt-clean, and its wiring (`buildApp` → `createApp` →
`serveWithGracefulShutdown`) mirrors the pattern every hosted `serve.ts` in the
gallery uses; running it against a real client is a manual follow-up.

## DX findings

1. **~~`@lesto/web`/`@lesto/runtime` give a controller no raw request body.~~
   RESOLVED.** `HandleOptions.rawBody` / `LestoRequest.rawBody` now carry the
   exact undecoded request bytes end to end: `@lesto/runtime`'s `toLestoRequest`
   (node) and `@lesto/cloudflare`'s `decodeBody` (edge) both populate it
   alongside the JSON-decoded `body`, and the kernel's `App.handle` threads it
   straight through. `/incoming` now reads `c.req.rawBody` — real on every
   transport, not just the in-process one — which is what unblocked the hosted
   `serve.ts` leg above and the `test/hosted.test.ts` proof. **Blast radius this
   fixes:** _body-signature inbound receivers_ (Stripe/GitHub/Slack/Shopify-style
   webhooks) — the canonical batteries-included use case.
2. **~~`verify` has no receiver-side secret resolution.~~ PARTLY RESOLVED.**
   `@lesto/webhooks` now ships `verifyRequest({ body, headers }, { secret })` —
   a turnkey inbound helper that reads the signature/timestamp headers, tells
   apart *why* a request failed (`missing_signature` / `missing_timestamp` /
   `malformed_timestamp` / `stale_timestamp` / `signature_mismatch`), and safely
   extracts `event` from the signed body. `/incoming` no longer hand-rolls any of
   that (see `src/app.ts`). **Still open:** resolving a `secretId` from the
   request itself is infeasible by design — the deliverer sends no
   secret/endpoint-id header — so the receiver still supplies its `secret`
   out-of-band (here, one shared constant); a real deploy looks it up by
   registered endpoint (e.g. from the request's source IP or a path segment).
