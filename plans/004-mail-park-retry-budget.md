# Plan 004: Preserve a parked mail job's retry budget instead of `maxAttempts: 1`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/mail/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: correctness
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

When a mail delivery job names a mailer that doesn't exist yet (deploy skew:
an old worker claims a job whose builder only exists on the new deploy),
`parkUnknownMailer` completes the job and **re-enqueues a delayed copy with
`maxAttempts: 1`**. The reasoning holds only while the builder is still
missing. Once the rollout settles and the mailer exists, that parked copy is a
normal delivery job — but now with a retry budget of 1. A single transient SMTP
timeout / provider 5xx on that one attempt retires it straight to `failed`
(mail errors carry no permanent-failure marker, so this is purely the attempts
cap). Deploy skew + one network blip = a silently lost verification/reset
email. The park grace period is meant to be bounded by the `parks` **counter**,
not by collapsing the delivery retry budget to 1. The fix: re-enqueue the parked
copy with the job's **original** `maxAttempts` so it keeps its real retry budget,
while the `parks` counter still bounds how many times it may park.

The queue already persists and hands the budget to the handler, so there is **no
need to thread it through the payload or `send()`**: `max_attempts` is a column
(`queue.ts:110`), hydrated onto the job as `maxAttempts` (`queue.ts:206`,
defaulted to 5 at enqueue `queue.ts:421`), and the handler receives
`context.job` (the mailer already reads `context.job.id` at `mailer.ts:320`).
Reading `context.job.maxAttempts` is one signature thread, has no fallback
ambiguity (the row's value is authoritative), and — crucially — works for jobs
**already in flight** during the deploy that ships this fix.

## Current state

- `packages/mail/src/mailer.ts` — the `Mailer` battery.
  - `send()` enqueues with the caller's options (which may set `maxAttempts`),
    but does NOT put `maxAttempts` in the payload:
    ```ts
    // packages/mail/src/mailer.ts:283
    async send<P extends JsonValue>(
      name: string,
      params: P,
      options: { maxAttempts?: number } = {},
    ): Promise<number> {
      return this.queue.enqueue(DELIVER_JOB, { mailer: name, params }, options);
    }
    ```
  - The payload type (parks is carried; maxAttempts is not):
    ```ts
    // packages/mail/src/mailer.ts:510
    interface DeliverPayload {
      readonly mailer: string;
      readonly params: JsonValue;
      readonly parks?: number;
      // ...
    }
    ```
  - The park re-enqueue that hardcodes `maxAttempts: 1`:
    ```ts
    // packages/mail/src/mailer.ts:427
    private async parkUnknownMailer(payload: DeliverPayload): Promise<void> {
      const parks = (payload.parks ?? 0) + 1;

      if (parks > this.maxUnknownMailerParks) {
        throw new MailError(
          "MAIL_UNKNOWN_MAILER",
          `No mailer named "${payload.mailer}" after ${this.maxUnknownMailerParks} parks.`,
          { mailer: payload.mailer, parks },
        );
      }

      await this.queue.enqueue(
        DELIVER_JOB,
        { mailer: payload.mailer, params: payload.params, parks },
        { delayMs: this.unknownMailerParkMs, maxAttempts: 1 },   // <-- the bug
      );
    }
    ```

### Conventions to follow

- **At-least-once, idempotent** (`CONVENTIONS.md`): a delivery that can run twice
  is safe; collapsing the retry budget defeats the queue's reliability guarantee.
- Keep the change minimal and typed (no `any`; `verbatimModuleSyntax` — use
  `import type` where relevant). Match the surrounding style in `mailer.ts`.
- The queue's own default `maxAttempts` is the fallback when the caller didn't
  set one. Do not hardcode the number if you can read the queue default; if you
  must inline a fallback, name it as a constant with a comment.

## Commands you will need

| Purpose   | Command                                     | Expected on success |
|-----------|---------------------------------------------|---------------------|
| Typecheck | `cd packages/mail && bun run typecheck`     | exit 0 |
| Test+cov  | `cd packages/mail && bun run test:cov`      | all pass, 100% cov |
| Lint      | `cd packages/mail && bun run lint`          | exit 0 |
| Format    | `cd packages/mail && bun run format:check`  | exit 0 |

## Scope

**In scope**:
- `packages/mail/src/mailer.ts`
- `packages/mail/test/*.ts` (mailer/park tests)

**Out of scope** (do NOT touch):
- `packages/mail/src/smtp.ts` and the transport layer.
- The `parks` counter semantics — it still bounds park count; only the
  delivery `maxAttempts` handling changes.
- The `MAIL_UNKNOWN_MAILER` throw and its message/details.

## Git workflow

- Commit style: `fix(mail): preserve a parked job's retry budget so a transient blip can't dead-letter a valid email`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Thread the job's `maxAttempts` into the park

`deliver(payload, context)` (`mailer.ts:317`) already has `context.job`. Pass the
job's own `maxAttempts` to `parkUnknownMailer` (add a parameter) and re-enqueue
with it, instead of the hardcoded `1`:
```ts
// deliver(): when the mailer is missing, park with the job's real budget
await this.parkUnknownMailer(payload, context.job.maxAttempts);

// parkUnknownMailer(payload, maxAttempts): the parks-bounded re-enqueue
await this.queue.enqueue(
  DELIVER_JOB,
  { mailer: payload.mailer, params: payload.params, parks },
  { delayMs: this.unknownMailerParkMs, maxAttempts },
);
```
`context.job.maxAttempts` is always defined (the queue defaults it to 5 at
enqueue, `queue.ts:421`), so there is no fallback branch and no payload/`send()`
change. Update the stale comment at `mailer.ts:441-442` to say the delivery
retry budget is preserved and the `parks` counter (not `maxAttempts`) bounds
parking.

**Verify**: `cd packages/mail && bun run typecheck` → exit 0.

### Step 2: Tests + full gate

See Test plan, then:

**Verify**:
```
cd packages/mail && bun run typecheck && bun run lint && bun run format:check && bun run test:cov
```
→ all exit 0, 100% coverage.

## Test plan

Add to the mailer test suite (find it: `ls packages/mail/test`), modeled on the
existing park tests:

1. **Budget preserved across a park**: enqueue a delivery for a not-yet-defined
   mailer with a job whose `maxAttempts` is 5 → assert the re-enqueued (parked)
   job's enqueue options carry `maxAttempts: 5` (inspect the fake queue's
   recorded `enqueue` calls). Drive `context.job.maxAttempts` via the fake
   job/context the mailer's queue handler receives.
2. **Default budget**: a job with the queue-default `maxAttempts` (5) → the
   parked copy re-enqueues with 5, NOT `1`.
3. **`parks` still bounds parking**: unchanged behavior — after
   `maxUnknownMailerParks` parks the job throws `MAIL_UNKNOWN_MAILER` (branch on
   `code`).
4. Make the "not 1" assertion non-vacuous: confirm the test would go red if the
   old `maxAttempts: 1` were restored.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd packages/mail && bun run typecheck` exits 0
- [ ] `cd packages/mail && bun run test:cov` exits 0, 100% coverage, new budget tests present and passing
- [ ] `cd packages/mail && bun run lint && bun run format:check` exit 0
- [ ] `grep -n "maxAttempts: 1" packages/mail/src/mailer.ts` returns no matches
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row for 004 updated

## STOP conditions

Stop and report back if:

- `parkUnknownMailer` / `send` / `DeliverPayload` do not match the "Current
  state" excerpts (drift).
- The queue's `enqueue` signature does not accept `{ delayMs, maxAttempts }`
  options as shown (verify against `packages/queue/src/queue.ts:397`).
- Omitting `maxAttempts` does not fall back to the queue default (i.e. the
  queue treats a missing option as `1`) — report; the fix then needs the
  explicit default constant.

## Maintenance notes

- If mail ever gains a `PERMANENT_FAILURE`-style marker, the retry budget and
  the park counter should both defer to it (a permanent failure should not
  consume parks or retries).
- Reviewer should confirm the `parks` bound is untouched and that a caller's
  explicit `maxAttempts` survives a park round-trip.
