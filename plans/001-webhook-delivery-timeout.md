# Plan 001: Bound outbound webhook delivery with a timeout

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/webhooks/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security / reliability
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

Webhook destination URLs are, by design, tenant/customer-provided. The
deliverer calls `fetch` with **no timeout and no `AbortSignal`**, so a
destination that completes the TCP/TLS handshake and then never responds (or
trickles bytes) holds the delivery worker's `await` open indefinitely
(`globalThis.fetch` has no default timeout; the Node path blocks on OS-level
timeouts of minutes). A single hostile or merely slow receiver can pin shared
queue workers and starve the whole delivery pipeline — a denial-of-service on
the webhook subsystem. This is the exact hazard the SMTP transport already
closed with its whole-dialogue deadline (`packages/mail/src/smtp.ts`); the
webhook deliverer has the same at-least-once/queue-visibility exposure and no
equivalent bound. The queue's visibility window eventually reclaims the job but
does not free the worker blocked inside `fetch`.

## Current state

- `packages/webhooks/src/webhooks.ts` — the `Webhooks` battery. Relevant sites:
  - The `FetchLike` init type (no `signal`/timeout field):
    ```ts
    // packages/webhooks/src/webhooks.ts:474
    export type FetchLike = (
      url: string,
      init: {
        method: string;
        headers: Record<string, string>;
        body: string;
        redirect?: "manual";
      },
    ) => Promise<WebhookResponse>;
    ```
  - `WebhooksOptions` (where a new `deliveryTimeoutMs` option goes):
    ```ts
    // packages/webhooks/src/webhooks.ts:523
    export interface WebhooksOptions {
      readonly queue: Queue;
      readonly fetch?: FetchLike;
      readonly secrets?: SecretSource;
      readonly resolver?: Resolver;
      readonly urlGuard?: UrlGuard;
      // ...
    }
    ```
  - The constructor wiring `fetchFn`:
    ```ts
    // packages/webhooks/src/webhooks.ts:712
    constructor(options: WebhooksOptions) {
      // ...
      this.fetchFn = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    ```
  - The unguarded fetch call inside `deliver()`:
    ```ts
    // packages/webhooks/src/webhooks.ts:802
    const response = await this.fetchFn(payload.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    });
    ```
- `packages/webhooks/src/pinning-fetch.ts` — the Node IP-pinning `FetchLike`.
  It builds a `node:http`/`node:https` request and wires **no** timeout:
  ```ts
  // packages/webhooks/src/pinning-fetch.ts:191
  const request = requester(
    url,
    { method: init.method, headers: init.headers, lookup },
    (response) => { /* ... */ },
  );
  request.on("error", reject);
  request.write(init.body);
  request.end();
  ```

### Conventions to follow

- **Errors carry codes.** A timeout must surface as the existing retryable
  `WEBHOOK_DELIVERY_FAILED` (so the queue retries it like any other failed
  attempt), not a new uncoded throw. See how `deliver()` already throws it at
  `webhooks.ts:815`.
- **Inject what varies / default sensibly.** Make the deadline a
  `WebhooksOptions` field with a sane default (mirror the SMTP transport's
  deadline discipline: a few seconds, well under the queue's visibility
  window). Match the exemplar in `packages/mail/src/smtp.ts` — read its
  deadline handling before writing yours.
- Tests are deterministic and never really wait (`CONVENTIONS.md` → Testability):
  drive the timeout with an injected `FetchLike`/requester that never resolves
  plus a fake/short deadline, not a real sleep.

## Commands you will need

| Purpose   | Command                                              | Expected on success |
|-----------|------------------------------------------------------|---------------------|
| Typecheck | `cd packages/webhooks && bun run typecheck`          | exit 0, no errors   |
| Test+cov  | `cd packages/webhooks && bun run test:cov`           | all pass, 100% cov  |
| Lint      | `cd packages/webhooks && bun run lint`               | exit 0              |
| Format    | `cd packages/webhooks && bun run format:check`       | exit 0              |

To fix formatting if `format:check` fails: `bun run --filter '@lesto/webhooks' format`.

## Scope

**In scope** (the only files you should modify):
- `packages/webhooks/src/webhooks.ts`
- `packages/webhooks/src/pinning-fetch.ts`
- `packages/webhooks/test/*.ts` (the delivery test file — add cases)

**Out of scope** (do NOT touch):
- The SSRF guard, `redirect: "manual"` behavior, HMAC signing, or the secret
  resolver — none of them change.
- `packages/mail/*` — it is the reference for the pattern only; do not edit it.

## Git workflow

- Commit style: conventional, single-line — e.g.
  `fix(webhooks): bound outbound delivery with a per-request timeout`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add `signal` to the `FetchLike` init type

Add an optional `signal?: AbortSignal` field to the `FetchLike` init object
type at `webhooks.ts:474`, documented like the existing `redirect` field
(optional so older fetch stubs still type-check; the real `fetch` honors it).

**Verify**: `cd packages/webhooks && bun run typecheck` → exit 0.

### Step 2: Add a `deliveryTimeoutMs` option and thread it into `deliver()`

- Add a distinct retryable code `WEBHOOK_DELIVERY_TIMEOUT` to the
  `WebhookErrorCode` union (`webhooks.ts:91`) — do NOT fold a timeout into the
  generic `WEBHOOK_DELIVERY_FAILED`. The house pattern is a distinct, coded,
  retryable timeout (the mail transport carries `MAIL_TRANSPORT_SMTP_TIMEOUT`
  for exactly this; commit `b68afaa` exists to *preserve* that code). Callers
  branch on `code`, so erasing the slow-vs-erroring distinction is a legibility
  regression. It is retryable because permanence is marker-based
  (`queue.ts` `isPermanentFailure`), not code-based.
- Add `readonly deliveryTimeoutMs?: number;` to `WebhooksOptions` (doc comment:
  the default and the "must be well under the queue visibility window"
  constraint).
- Store it on the instance in the constructor with a default. **Pick one
  number and state it**: the SMTP exemplar defaults to `20_000` ms
  (`packages/mail/src/smtp.ts:100`); a webhook default of `10_000` ms is a
  reasonable choice — the load-bearing rule is only that it sits well under the
  queue visibility window.
- In `deliver()` (`webhooks.ts:802`), pass
  `signal: AbortSignal.timeout(this.deliveryTimeoutMs)` in the fetch init.
- **Map the timeout by structure, NOT by exception name.** `AbortSignal.timeout()`
  rejects with a `DOMException` named **`"TimeoutError"`** on the default
  `globalThis.fetch`/undici/workerd path, but the Node `http.request({signal})`
  path rejects with **`"AbortError"`** — so keying the catch on
  `err.name === "AbortError"` MISSES the real production timeout on the default
  path. Instead: wrap `await this.fetchFn(...)` and map **any** non-`WebhookError`
  throw to `WEBHOOK_DELIVERY_TIMEOUT` with `{ url: payload.url }` in `details`;
  a `WebhookError` already thrown (e.g. the non-ok 3xx/redirect branch) must
  pass through unchanged.

**Verify**: `cd packages/webhooks && bun run typecheck` → exit 0.

### Step 3: Honor the signal on the Node pinning path

In `nodePinningFetch` (`pinning-fetch.ts:162`), pass the incoming
`init.signal` through to the request so an abort destroys the socket. Node's
`http.request`/`https.request` accept a `signal` option — thread it into the
requester options object at `pinning-fetch.ts:193`
(`{ method, headers, lookup, signal: init.signal }`) and ensure an aborted
request rejects (Node emits an `AbortError` on `request`'s `error`, which the
existing `request.on("error", reject)` already forwards). If the
`HttpRequester`/`nodeRequester` type does not already allow a `signal` option,
widen it minimally.

**Verify**: `cd packages/webhooks && bun run typecheck` → exit 0.

### Step 4: Tests

See the Test plan below, then:

**Verify**: `cd packages/webhooks && bun run test:cov` → all pass, 100%
coverage (lines/branches/functions/statements).

### Step 5: Full local gate for this package

**Verify**:
```
cd packages/webhooks && bun run typecheck && bun run lint && bun run format:check && bun run test:cov
```
→ every command exits 0.

## Test plan

- In the existing webhook delivery test file (find it:
  `ls packages/webhooks/test`), add cases modeled on the current delivery
  tests:
  1. **Timeout → retryable failure**: inject a `FetchLike` that **honors
     `init.signal`** — it must reject with `init.signal.reason` when the signal
     aborts (do NOT use a never-resolving stub that ignores the signal: the
     timeout lives *inside* the signal handed to `fetchFn`, so a stub that
     ignores it never rejects and the test deadlocks). Set a very short
     `deliveryTimeoutMs` and assert the delivery flow throws
     `WEBHOOK_DELIVERY_TIMEOUT` (branch on `code`, never the message). Cover
     both a `TimeoutError`-shaped reason and an `AbortError`-shaped reason so
     the structural mapping (not name-matching) is exercised.
  2. **Signal is passed**: assert the injected `FetchLike` receives a
     `signal` in its init (an `AbortSignal`).
  3. **Happy path unaffected**: a fast 2xx still succeeds with the timeout
     configured.
  4. **Node pinning path**: if the pinning-fetch tests use a fake requester,
     add one asserting the `signal` reaches the requester options; keep it
     deterministic (no real network).
- Follow the structural pattern of the existing tests in the same directory;
  do not introduce real timers or real sockets.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd packages/webhooks && bun run typecheck` exits 0
- [ ] `cd packages/webhooks && bun run test:cov` exits 0, 100% coverage, new
      timeout tests present and passing
- [ ] `cd packages/webhooks && bun run lint && bun run format:check` exit 0
- [ ] `grep -n "AbortSignal" packages/webhooks/src/webhooks.ts` shows the
      deadline is wired into `deliver()`
- [ ] `grep -n "WEBHOOK_DELIVERY_TIMEOUT" packages/webhooks/src/webhooks.ts`
      shows the distinct retryable code (not folded into `WEBHOOK_DELIVERY_FAILED`)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row for 001 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `deliver()` / `FetchLike` / `nodePinningFetch` code does not match the
  "Current state" excerpts (drift).
- Threading `signal` into the Node requester requires changing the SSRF pinning
  logic (`pinnedLookup`) itself — that is out of scope; report instead.
- 100% coverage cannot be reached without asserting on a real timer/socket
  (it should not — the timeout is driven by an injected fetch and a short
  deadline).

## Maintenance notes

- If a future change lets the queue configure per-endpoint visibility windows,
  the `deliveryTimeoutMs` default must stay strictly below the smallest one, or
  a slow endpoint can still outlive its lease.
- Reviewer should confirm the timeout maps to a **retryable** failure (not a
  terminal one) so a transiently-slow endpoint is retried, and that the SSRF
  `redirect: "manual"` semantics are untouched.
