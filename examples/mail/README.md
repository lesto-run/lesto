# examples/mail — transactional email on the Cloudflare edge

Wires **`@lesto/mail`** to **Cloudflare Email Sending** so a Cloudflare Worker
sends transactional email through the platform's `send_email` binding — no API
keys, no third-party provider. Delivery rides **`@lesto/queue`** over **D1**, and
because a Worker has no long-running worker loop, `POST /send` drains the queue
**in-request** and reports an honest verdict.

## What it shows

| Route         | Behavior                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /health` | Reports the wired transport (`cloudflare-email`) and sender (`hello@lesto.run`) — no send.           |
| `POST /send`  | `{ "to": "..." }` — enqueue the `welcome` email, drain the queue, return `{ jobId, delivered, error? }`. |

The `welcome` template supplies `html` **and** `text` (a `multipart/alternative`,
the deliverability default). The new transport
(`createCloudflareEmailTransport`, shipped in `@lesto/mail`) bridges Lesto's
string `from` to the binding's `{ email, name }` shape and **fails closed**: when
the binding rejects a send (most commonly because the sender domain isn't
onboarded yet), it throws a coded `CloudflareEmailError`, the queue records it,
and `POST /send` returns `delivered: false` with the reason — it never pretends.

## How it's tested (the QA gate)

```bash
bun run --filter '@lesto/example-mail' test
```

`test/mail.test.ts` drives the routes in-process over the **real edge transport**
(`createCloudflareEmailTransport`) fed a **fake `send_email` binding**, proving
the whole chain — enqueue → in-request drain → transport → binding — plus the
fail-closed verdict when the binding rejects. The `@lesto/mail` transport itself
is unit-tested to 100% in `packages/mail/test/cloudflare.test.ts`.

## Run the Node leg (serve.ts)

```bash
bun run examples/mail/serve.ts
curl -X POST localhost:3000/send -H 'content-type: application/json' -d '{"to":"you@example.com"}'
```

The Cloudflare `send_email` binding is **edge-only**, so this Node leg can't use
it — it runs the SAME app with a different transport: Resend when `RESEND_API_KEY`
is set, otherwise a transport that logs each rendered email so it runs out of the
box.

## Deploy to Cloudflare (the edge leg) — LIVE, with one manual hop

```bash
bun run examples/mail/deploy   # bun alchemy.run.ts
```

`alchemy.run.ts` (ADR 0044) declares the Worker + a D1 database + the
`EmailSender()` binding (→ `env.EMAIL`). After `finalize()`, a post-deploy smoke
asserts the Worker **deploys, boots, and serves `GET /health` → 200** — which
means `bootMail`, including the **D1 queue-schema install**, succeeded on the real
edge substrate. CI runs exactly this on every push to main
(`.github/workflows/deploy-examples.yml`).

**Honest claim — what's live vs. the manual hop:**

- ✅ **Live and machine-checked:** the Worker deploys, boots, and installs its D1
  queue schema (`GET /health` → 200). The enqueue → drain → transport → fail-closed
  chain is proven by the local test over a fake binding, not by the deploy.
- ✋ **The one manual hop:** a *real send* needs the `from` domain onboarded to
  Cloudflare Email Sending —

  ```bash
  wrangler email sending enable lesto.run
  # then add the SPF / DKIM / DMARC DNS records it prints
  ```

  and confirming delivery means reading the destination inbox, which CI can't do.
  So the deploy does **not** assert a delivered email (that would be a vacuous
  green). Until the domain is onboarded, `POST /send` returns `delivered: false`
  with the failure reason (the transport error message) — the same "one unautomated
  hop" honesty as `examples/estate`'s deploy.
