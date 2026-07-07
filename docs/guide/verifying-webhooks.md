# Verifying inbound webhooks

The reference implementation is [`examples/webhooks`](../../examples/webhooks)
— read [its README](../../examples/webhooks/README.md) and
[`src/app.ts`](../../examples/webhooks/src/app.ts) alongside this guide for a
runnable, tested receiver. This page is the rule, plus how to apply it to two
real third-party providers: **Stripe** and **GitHub**.

## The rule

> **Verify over `c.req.rawBody`. Never over `c.req.body`.**
>
> `c.req.body` is the JSON-**decoded** value. Re-serializing it (`JSON.stringify`)
> does not reliably reproduce the exact bytes the sender signed — key order,
> whitespace, number formatting, and Unicode escaping can all differ — so an
> HMAC computed over `JSON.stringify(c.req.body)` can mismatch a **genuine**
> webhook (a false rejection) or, worse, give you false confidence that you're
> checking something when you're really just checking your own re-encoding.
> `c.req.rawBody` is the exact undecoded request bytes the transport received —
> the only thing whose HMAC can match what the sender actually signed.

This is not a theoretical footgun. It's the exact thing that blocked hosted
webhook receivers in this repo: before `@lesto/web`'s `LestoRequest.rawBody` /
`HandleOptions.rawBody` existed, a controller had no way to get at the raw
bytes at all, only the decoded `body` — see DX finding #1 in the
[`examples/webhooks` README](../../examples/webhooks/README.md#dx-findings)
for the (now-resolved) history.

## Where `rawBody` comes from

```ts
export interface LestoRequest {
  // ...
  body: unknown; // JSON-decoded (or the raw string, for non-JSON content)
  rawBody?: string; // exact undecoded bytes, when the transport captured them
}
```

Every transport populates it whenever a request carries a body: `@lesto/runtime`'s
node dispatch, `@lesto/cloudflare`'s edge decode, and the in-process
`app.handle(...)` all set `rawBody` alongside the decoded `body`. It's
`undefined` only when there was no body at all (a `GET`, an empty `POST`) or a
caller hand-built request options without it (e.g. a unit test).

Because it can be absent, every receiver route should guard it explicitly —
this is the real "switch" to reach for, not a config flag:

```ts
const rawBody = c.req.rawBody;
if (rawBody === undefined) {
  return c.json({ error: "raw body required to verify the signature." }, 400);
}
```

That's the exact pattern `examples/webhooks/src/app.ts`'s `/incoming` route
uses. See [Cost](#cost-its-automatic-not-opt-in), below, for why you don't need
to (and can't) turn this on per route — it's already happening for you.

## Verifying your own scheme: `verifyRequest`

If the sender is another Lesto app using `@lesto/webhooks`' `Webhooks.send`,
use `verifyRequest` — it already knows the `x-lesto-signature` /
`x-lesto-timestamp` header pair and the `{ event, data }` envelope:

```ts
import { verifyRequest } from "@lesto/webhooks";

app.post("/incoming", (c) => {
  const rawBody = c.req.rawBody;
  if (rawBody === undefined) {
    return c.json({ error: "raw body required to verify the signature." }, 400);
  }

  const result = verifyRequest({ body: rawBody, headers: c.req.headers }, { secret });

  if (!result.verified) {
    return c.json({ verified: false, reason: result.reason }, 401);
  }

  // result.event comes from the SIGNED body, never the unsigned x-lesto-event header.
  return c.json({ verified: true }, 200);
});
```

`result.reason` tells apart *why* verification failed —
`missing_signature` / `missing_timestamp` / `malformed_timestamp` /
`stale_timestamp` / `signature_mismatch` — so you can log or respond
differently for "no signature at all" vs. "someone tampered with the body."

`verifyRequest` is opinionated about Lesto's own header names and envelope
shape, though, so it isn't directly reusable against a third-party provider
that ships its own header and signature format. For those, drop to the
provider-agnostic primitive underneath: `verify(body, signature, secret,
options?)` — a constant-time HMAC check with no assumptions about header
names. Both examples below build the exact string the provider signed, then
hand it to `verify`.

## Stripe: `Stripe-Signature`

Stripe sends a `Stripe-Signature` header shaped like
`t=<unix-seconds>,v1=<hex-hmac>` (there can be a trailing deprecated `v0=...`
too — ignore it) and signs `${t}.${rawBody}` with your endpoint's webhook
signing secret.

```ts
import { verify } from "@lesto/webhooks";

const STRIPE_TOLERANCE_SECONDS = 5 * 60;

function parseStripeSignatureHeader(header: string): { t?: string; v1?: string } {
  const fields = new Map(
    header.split(",").map((pair) => {
      const [key, value] = pair.split("=", 2);
      return [key, value] as const;
    }),
  );

  return { t: fields.get("t"), v1: fields.get("v1") };
}

app.post("/webhooks/stripe", (c) => {
  const rawBody = c.req.rawBody; // NEVER c.req.body here
  if (rawBody === undefined) {
    return c.json({ error: "raw body required to verify the signature." }, 400);
  }

  const header = c.req.headers["stripe-signature"];
  if (header === undefined) {
    return c.json({ error: "missing Stripe-Signature header." }, 400);
  }

  const { t, v1 } = parseStripeSignatureHeader(header);
  if (t === undefined || v1 === undefined) {
    return c.json({ error: "malformed Stripe-Signature header." }, 400);
  }

  // Stripe's timestamp is unix SECONDS — check freshness before doing any HMAC work.
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(ageSeconds) || ageSeconds > STRIPE_TOLERANCE_SECONDS) {
    return c.json({ error: "stale Stripe-Signature timestamp." }, 401);
  }

  // Reconstruct the EXACT string Stripe signed, then let `verify` do the
  // constant-time compare — never `===` on hex strings.
  const signedPayload = `${t}.${rawBody}`;
  if (!verify(signedPayload, v1, STRIPE_WEBHOOK_SECRET)) {
    return c.json({ error: "signature mismatch." }, 401);
  }

  const event = JSON.parse(rawBody) as { type: string; data: unknown };
  // ... dispatch on event.type
  return c.json({ received: true }, 200);
});
```

Two details that only bite if you skip them:

- `t` is seconds, not milliseconds. Don't feed it straight into `verify`'s own
  `options.timestamp` (which `signedPayload()` treats as millisecond-scale for
  Lesto's own scheme) — build the `${t}.${rawBody}` string yourself and call
  `verify` in its plain body/signature/secret form.
- Header names are case-insensitive over the wire but `c.req.headers` keys are
  lowercased, so read `"stripe-signature"`, not `"Stripe-Signature"`.

## GitHub: `X-Hub-Signature-256`

GitHub signs the raw body directly — no timestamp binding — and sends
`X-Hub-Signature-256: sha256=<hex-hmac>`.

```ts
import { verify } from "@lesto/webhooks";

app.post("/webhooks/github", (c) => {
  const rawBody = c.req.rawBody; // NEVER c.req.body here
  if (rawBody === undefined) {
    return c.json({ error: "raw body required to verify the signature." }, 400);
  }

  const header = c.req.headers["x-hub-signature-256"];
  if (header === undefined || !header.startsWith("sha256=")) {
    return c.json({ error: "missing or malformed X-Hub-Signature-256 header." }, 400);
  }

  const signature = header.slice("sha256=".length);

  // GitHub signs the body directly — no timestamp — so this is verify's
  // legacy body-only form (no `options` argument).
  if (!verify(rawBody, signature, GITHUB_WEBHOOK_SECRET)) {
    return c.json({ error: "signature mismatch." }, 401);
  }

  const event = c.req.headers["x-github-event"]; // e.g. "push", "pull_request"
  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  // ... dispatch on event
  return c.json({ received: true }, 200);
});
```

GitHub has no built-in replay window (no signed timestamp), so if replay
matters for your use case, track and reject already-seen delivery ids
(`X-GitHub-Delivery`) yourself.

## Cost: it's automatic, not opt-in

`rawBody` isn't a per-route flag you flip on — every transport captures it
automatically whenever a request has a body, right alongside the decoded
`body`. From the `HandleOptions.rawBody` doc in
[`packages/web/src/types.ts`](../../packages/web/src/types.ts):

> Cost: for a JSON body the raw string is retained ALONGSIDE the parsed `body`
> for the request's lifetime (~2× that body's memory); it is bounded by the
> transport's body-size cap, and for a non-JSON body `rawBody` and `body` are
> the same string (no extra cost).

Concretely: `@lesto/runtime` defaults `maxBodyBytes` and `maxJsonBodyBytes` to
1 MiB each, so the worst case is ~2 MiB retained per in-flight request with a
JSON body — bounded, not unbounded, and paid whether or not a given route
actually reads `rawBody`. There's nothing to configure to "turn it on"; the
only thing a receiver route does is guard for its absence (see
[Where `rawBody` comes from](#where-rawbody-comes-from)) and read it instead
of `body` when verifying a signature.

## Multi-tenant receivers

A single receiver route that serves many tenants or many upstream sources —
each provisioned with its own signing secret — needs to resolve *which*
secret to check against. Pass `verifyRequest` a **secret resolver** in place
of a static string: a `(ctx) => string | Promise<string>` that returns the
signing secret for this request. When `secret` is a resolver, `verifyRequest`
is asynchronous (you `await` it):

```ts
const result = await verifyRequest(
  { body: rawBody, headers: c.req.headers },
  {
    secret: async (ctx) => {
      // ctx extends the verify input: { body, headers, signature, timestamp }.
      // Pick the tenant from the request, then load that tenant's secret.
      const tenantId = ctx.headers.get("x-tenant-id") ?? "";
      const secret = await secretsByTenant.get(tenantId);
      if (!secret) throw new Error(`no secret for tenant ${tenantId}`);
      return secret;
    },
  },
);
```

The resolver is **fail-closed**: if it throws *or* returns an empty secret,
`verifyRequest` rejects with a `WebhookError` (`code: "WEBHOOK_SECRET_UNRESOLVED"`,
the original error preserved on `cause`) — it never falls through to an
unverified "pass". Malformed/stale requests are rejected *before* the resolver
runs, so an obviously-bad request never triggers a secret lookup.

It is safe to derive the tenant id from the still-unverified request (a header,
a path segment, even a field in the body) **to select which secret to try** —
because verification then runs with that secret, so a forger who names a tenant
whose secret they don't hold still fails the HMAC. What you must never do is
treat the payload's *contents* as authenticated, or skip verification, before
the HMAC passes.
