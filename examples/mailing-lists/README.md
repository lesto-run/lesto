# `@keel/mailing-lists` — double opt-in + broadcasts

The Ghost-style subscriber-list battery, wired into a runnable Keel app and proven
end to end. This is the gallery's per-feature QA gate for `@keel/mailing-lists`
(see `docs/plans/examples-gallery.md`): it exercises **only** that battery's real
public API, over real HTTP routes, on both axes a unit test can't reach — **local
DX** (wire it, run it) and **hosted UX** (deploy it, click it).

## What it shows

The full double opt-in journey as HTTP routes over the `createMailingLists` service:

| Route | Does |
| --- | --- |
| `POST /lists/:listId/subscribe` | Begin double opt-in — pending row + confirmation email. **Rate-limited** (the package mandates it). |
| `GET /confirm/:token` | Complete double opt-in — flips the subscriber to `subscribed`, rotating the token. |
| `POST /lists/:listId/broadcast` | Fan an issue out to every **confirmed** recipient; each email carries `List-Unsubscribe`. |
| `GET /unsubscribe/:token` | One-click opt out. |

It composes four batteries the way a real app does: `@keel/mailing-lists` (the
service), `@keel/mail` (delivery), `@keel/queue` (durable enqueue under the mailer),
and `@keel/ratelimit` (the guard in front of `subscribe`), assembled by
`@keel/kernel` and served by `@keel/runtime`. Nothing is sent inline — a worker
(`serve.ts`) or a drain loop (`run.ts`, the test) processes the mail queue.

## How to run

```bash
# In-process: dispatch the whole journey and print each email. No server.
bun run examples/mailing-lists/run.ts

# Live HTTP server (logs mail to the console by default).
bun run examples/mailing-lists/serve.ts

# The journey test (also runs in CI via `bun run examples:test`).
bun run --cwd examples/mailing-lists test
```

## How to deploy / hosted-UX QA

`serve.ts` delivers over real SMTP when `SMTP_HOST` is set. The fastest way to see
the mail land in a real inbox and click the links is a local [Mailpit](https://github.com/axllent/mailpit) sink:

```bash
# 1. A throwaway SMTP sink with a web UI on :8025, SMTP on :1025.
docker run --rm -p 8025:8025 -p 1025:1025 axllent/mailpit

# 2. Point the app at it.
SMTP_HOST=127.0.0.1 SMTP_PORT=1025 bun run examples/mailing-lists/serve.ts

# 3. Subscribe, then open http://localhost:8025, read the confirmation email,
#    and click the confirm link (it points back at the running server).
curl -X POST localhost:3000/lists/1/subscribe \
  -H 'content-type: application/json' -d '{"email":"ada@example.com"}'

# 4. Broadcast — the digest lands in Mailpit with a working List-Unsubscribe link.
curl -X POST localhost:3000/lists/1/broadcast \
  -H 'content-type: application/json' -d '{"issue":42}'
```

For a Workers deploy, swap the SMTP transport for `createFetchProviderTransport`
(`@keel/mail`) — a fetch-based provider (Resend/SES-shaped) that runs on an edge
isolate with no Node built-ins.

## QA result (2026-06-16)

**Local DX — pass.** `run.ts` drives subscribe → confirm → broadcast → unsubscribe
in-process; the confirmation token round-trips through the rendered email, the
digest carries `List-Unsubscribe`, mail flows through the real queue. Typecheck,
oxlint, oxfmt clean; 3 journey tests green.

**Hosted UX — pass.** Booted `serve.ts` on a real `node:http` server with a live
`queue.work()` worker. Over the wire: subscribe → 202, the worker delivered the
confirmation email, a same-client burst was throttled `202×5 → 429` (capacity-5
enforced with a **real per-client IP key**, no unknown-client fallback), and a
broadcast to an unconfirmed address correctly enqueued **0** — double opt-in
refusing to mail an address that never confirmed.

## DX findings (filed back to the owning plans)

The point of the gallery is to surface friction wiring the real API. This example found:

1. **The mandated rate-limit guard can't be exercised through in-process dispatch.**
   `rateLimit` keys on `currentContext()?.ip`, which `app.handle()` never
   establishes — so the guardrail the package *requires* on `subscribe` silently
   degrades to one shared bucket (and warns once) in exactly the in-process path
   this example's test and `run.ts` use. It only works per-client on the hosted leg
   (`serve.ts`), where the runtime sets the context. Compounding it: `keyFor: () =>
   string` takes no request argument, so you can't key by anything in the request
   (e.g. the email) without the ambient context. → *owner: `auth-security` /
   `ratelimit`.*

2. **`createApp` installs the durable-store schema but not the queue schema.** The
   mail battery rides `@keel/queue`, yet a `createApp({ … })` app must remember to
   call `installSchema` from `@keel/queue` itself or the first `send` hits a missing
   table. There's no kernel seam to declare "this app uses the queue." → *owner:
   `operability-dx` / kernel.*

3. **Three structurally-identical `SqlDatabase` types force a cast.** Sharing one
   connection across `@keel/db`, `@keel/kernel`, and `@keel/queue` needs
   `handle as unknown as QueueDatabase`. They should be one type (or re-export one
   another) so composing db + queue is cast-free. → *owner: `data-persistence` /
   `durable-stores`.*
