# Plan 015: Clean up SMTP `rebind` socket listeners and validate `messageId` at the transport edge

> **Executor instructions**: Follow step by step; run every verification command.
> STOP on any "STOP conditions" item. Update `plans/README.md` when done.
>
> **⚠️ DRIFT WARNING — READ BEFORE STARTING (concurrent uncommitted work).**
> As of writing, `packages/mail/src/smtp.ts` and `packages/mail/test/smtp-e2e.test.ts`
> have **UNCOMMITTED working-tree changes made by another agent/session** (the
> Studio daemon and sibling fleets commit to `main` concurrently). A `git diff
> <sha>..HEAD` drift check will **NOT** see them — run `git diff -- packages/mail/`
> (no revs) as well.
>
> That in-flight change already touches `rebind`/`bind`: it clears `this.failure`
> on rebind and adds a `'close'` handler, and its comment states the
> `'error'`/`'close'` handlers **"cannot be removed without also stripping the TLS
> transport's own listeners."** That independently confirms this plan's crash
> concern — and it means **Step 1 (the rebind half) may already be solved, and
> removing the `'error'` listener at all may be actively unsafe.**
>
> **Therefore: reconcile before you touch `rebind`.** Re-read the live `rebind`/
> `bind`. If the concurrent change is present, treat Step 1 as **superseded** —
> verify the listener-leak/stale-state concern is genuinely closed, and if so skip
> to Step 2. **Step 2 (`messageId` validation) is untouched by that work and
> remains fully valid** — it is the part of this plan you can execute regardless.
> Do NOT revert or overwrite the other agent's edits.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/mail/`
> **AND** `git diff --stat -- packages/mail/` (uncommitted).

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: correctness / security
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

Two small mail-transport hardening gaps:

1. **`rebind` listener leak (CORR-06)**: after STARTTLS, `rebind` swaps in the
   TLS socket and calls `bind()` again **without removing the plaintext socket's
   `data`/`error` listeners**. Both sockets' `data` handlers append into the same
   `this.buffer` and can settle the same `this.pending`. If the raw socket emits
   any post-upgrade `data` (or a late `error`), ciphertext/garbage can land in the
   reply buffer and mis-settle a waiting `expect()` — a protocol failure — and at
   minimum it is a listener leak on every STARTTLS send.
2. **`messageId` injection gap (CORR-07)**: the transport's edge `validate()`
   guards `to`/`subject`/`from`/`headers` but **not** `messageId`, which is then
   spliced raw into `Message-ID: <${messageId}>` and the MIME boundary. Through
   the framework `Mailer` the id is safe (`lesto-mail-<jobId>`), but
   `MailTransport`/`RenderedEmail` are **exported public surface** — a
   caller-supplied `messageId` with CRLF is header injection, and one with `"` or
   whitespace corrupts the multipart boundary. The transport's own doc says it
   "re-validates everything at the edge"; this field is the one gap.

## Current state

- `rebind` (no listener cleanup):
  ```ts
  // packages/mail/src/smtp.ts:315
  rebind(socket: SmtpSocket): void {
    this.socket = socket;
    this.buffer = "";
    this.bind();          // <-- old socket's data/error listeners still attached
  }
  // :162-165  the `finally` runs removeAllListeners() only on the FINAL socket.
  ```
- The edge `validate()` (missing `messageId`):
  ```ts
  // packages/mail/src/smtp.ts:235
  function validate(email: RenderedEmail): void {
    assertNoInjection("to", email.to, "MAIL_INVALID_ADDRESS");
    assertNoInjection("subject", email.subject, "MAIL_INVALID_HEADER");
    if (email.from !== undefined) assertNoInjection("from", email.from, "MAIL_INVALID_ADDRESS");
    if (email.headers !== undefined) assertHeaders(email.headers);
    // no messageId check
  }
  ```
- Splice sites: `smtp.ts:456` `Message-ID: <${email.messageId}>` and `:467-468`
  `boundary = lesto-${messageId}`.
- `assertNoInjection` is the existing guard used for the other fields. There is a
  second transport at `packages/mail/src/provider.ts` (the idempotency-key header
  rides `messageId` at `provider.ts:97`) — validate there too.

### Conventions to follow

- Errors carry codes — reuse `MAIL_INVALID_HEADER` for a bad `messageId`.
- The mail package is 100%-coverage-gated; unit tests use a scripted
  `FakeSocket`, and `smtp-e2e.test.ts` runs a real in-process `node:net` server —
  match those patterns; do not add real network flakiness.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Gate | `cd packages/mail && bun run typecheck && bun run lint && bun run format:check && bun run test:cov` | exit 0, 100% |

## Scope

**In scope**:
- `packages/mail/src/smtp.ts` (`rebind` cleanup + `messageId` validation)
- `packages/mail/src/provider.ts` (`messageId`/idempotency-key validation)
- `packages/mail/test/*` (add cases)

**Out of scope**:
- The dialogue-deadline / lost-wakeup logic (already fixed).
- The `Mailer` (its ids are already safe); the fix is at the transport edge.

## Steps

### Step 1: Reconcile the rebind half (likely SUPERSEDED — check first)

**First: re-read the live `rebind`/`bind` and `git diff -- packages/mail/`.** A
concurrent uncommitted change (see the drift warning) already reworked this area:
it clears `this.failure` on rebind and adds a `'close'` handler, deliberately
*keeping* the `'error'`/`'close'` handlers attached because they "cannot be
removed without also stripping the TLS transport's own listeners."

- **If that change is present**: Step 1 is **superseded**. Do NOT add listener
  removal — the other agent's comment is correct, and stripping the `'error'`
  handler from the still-live underlying socket is exactly the crash this plan was
  worried about (a listener-less `'error'` is an uncaught exception that `send()`'s
  `try/catch` cannot catch). Confirm the stale-state concern is closed by their
  `this.failure = undefined` on rebind, then **skip to Step 2**.
- **If it is NOT present** (the working tree was reverted/committed differently):
  the residual concern is only the **`'data'` listener** accumulating across the
  upgrade (both sockets' `data` handlers append to the same `this.buffer`). Remove
  **only** `'data'` — never `'error'` — via named handler references:
  ```ts
  rebind(socket: SmtpSocket): void {
    this.socket.off("data", this.onData);   // ONLY data. Never 'error' (see above).
    this.socket = socket;
    this.buffer = "";
    this.failure = undefined;               // a fresh socket carries no failure yet
    this.bind();
  }
  ```
  (`SmtpSocket` already exposes the listener methods — `smtp.ts:39` — no cast needed.)

**Verify**: `cd packages/mail && bun run typecheck` → exit 0. If superseded, record
that in the PR and move on — do not manufacture a change.

### Step 2: Validate `messageId` at both transport edges

Add `assertNoInjection("messageId", email.messageId, "MAIL_INVALID_HEADER")` to
`smtp.ts`'s `validate()` and the analogous point in `provider.ts` (where
`messageId` becomes the idempotency-key header). **`assertNoInjection` rejects
only CR/LF** (`mailer.ts:493`), which closes header injection but leaves the
boundary-corruption vector this plan cites open (a `messageId` with `"` or
whitespace splits the MIME part, since `boundary=lesto-${messageId}` at
`smtp.ts:468`). So **also require a token-only charset check** for `messageId`
(no `"`/whitespace) — this is a required part of the fix, not optional; the
framework's own `lesto-mail-<jobId>` ids (numeric jobId) pass it.

**Verify**: `cd packages/mail && bun run typecheck` → exit 0.

### Step 3: Tests + gate

**Verify**:
```
cd packages/mail && bun run typecheck && bun run lint && bun run format:check && bun run test:cov
```
→ exit 0, 100%.

## Test plan

Add to `packages/mail/test`, modeled on the existing transport/validate tests:
1. **`messageId` with a CRLF is rejected** with `MAIL_INVALID_HEADER` (branch on
   `code`) at the transport (construct a `RenderedEmail` directly — the public
   surface — not via the Mailer). Do the same for `provider.ts`.
2. **rebind cleanup + no-crash**: assert `rebind` calls `off("data", …)` /
   `off("error", …)` on the OLD socket (not `removeAllListeners`). **Crucially,
   add a crash-regression test**: after `rebind`, emit an `'error'` on the OLD
   socket and assert the process does not throw an uncaught exception (the old
   socket must still have a swallowing/owned `'error'` path, OR the test proves
   our targeted `off` left any TLS-owned listener intact). This is the test that
   catches the `removeAllListeners()` crash — make it red if Step 1 reverts to a
   blanket removal.
3. **boundary charset**: a `messageId` containing `"` or whitespace is rejected
   (`MAIL_INVALID_HEADER`), closing the MIME-boundary vector.
3. **Happy path**: a framework-minted `messageId` still delivers.

## Done criteria

- [ ] `cd packages/mail && bun run test:cov` exit 0, 100%, new cases present and red-without-the-fix
- [ ] `cd packages/mail && bun run lint && bun run format:check` exit 0
- [ ] `grep -n "messageId" packages/mail/src/smtp.ts packages/mail/src/provider.ts` shows a validation call at each edge
- [ ] `grep -n "removeAllListeners" packages/mail/src/smtp.ts` shows it is NOT
      called in `rebind` (a blanket removal is the crash bug — never ship it)
- [ ] The rebind half is either superseded by the concurrent change (recorded in
      the PR) or removes ONLY the `'data'` listener
- [ ] A post-rebind `'error'` on the old socket does not crash (regression test present)
- [ ] `plans/README.md` status row for 015 updated

## STOP conditions

Stop and report if:
- The excerpts don't match (drift).
- `smtp-e2e.test.ts` does NOT exercise a real STARTTLS upgrade (check first): the
  `FakeSocket` unit tests cannot see the post-upgrade crash, so if there's no real
  TLS-upgrade e2e case, add one (a `node:net`→`tls` upgrade on `127.0.0.1:0`) —
  otherwise this is the false-oracle split AGENTS.md warns about (green unit test,
  crash in prod).

## Maintenance notes

- If a future transport is added, its `validate()` must cover `messageId` too —
  consider a shared `validateRenderedEmail(email)` the transports call, so the
  field list has one source of truth.
- Reviewer should confirm the `messageId` guard is at the **transport** edge
  (public surface), not only in the Mailer.
