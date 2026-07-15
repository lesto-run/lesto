# Plan 020: Add `resendVerification` so a mailer failure can't brick a new account

> **Executor instructions**: Follow step by step; run every verification command.
> STOP on any "STOP conditions" item. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat c4f6915..HEAD -- packages/identity/`
> (Re-stamped to `c4f6915`: an unrelated rate-limiter docstring edit shifted the
> identity.ts anchors by +5. The `register` **body** below is unchanged — if the
> drift check shows only that docstring region moved, the excerpt still matches;
> proceed rather than STOP.)

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (ship `resendVerification` alone; the enumeration-risky
  conflict-arm resend is dropped by default — see Step 2)
- **Depends on**: none
- **Category**: correctness
- **Planned at**: commit `c4f6915`, 2026-07-11

## Why this matters

`register` inserts the user row, then awaits `sendVerificationEmail`. A throw
after the insert (a transient mailer/queue failure) leaves a **permanently
unverifiable** account: the user can't re-register (the enumeration-safe conflict
arm sends nothing), can't log in while `requireVerifiedEmail` (default true)
holds, and `resetPassword` doesn't verify email either. The only recovery is
out-of-band. The `Mailer` battery softens this (its `send` only enqueues), but
`IdentityMailer` is an open seam and a synchronous adapter throws right here. The
fix is a first-class `resendVerification` (success-shaped and enumeration-safe,
like `requestPasswordReset`), and/or having the conflict arm re-send the link
when the colliding user is still unverified.

## Current state

- `register` (insert then email; a throw after insert strands the row). The
  register **body** is unchanged from the excerpt; only its line number moved
  (now ~`identity.ts:1020`, the `Identity` interface at ~`:636`) after an
  unrelated docstring edit:
  ```ts
  // packages/identity/src/identity.ts:1020
  async register(email, password) {
    assertValidEmail(email);
    assertValidPassword(password);
    const normalized = userRepo.normalizeEmail(email);
    if (await userRepo.findUserByEmail(db, normalized)) {
      await hasher.hashPassword(password);          // decoy work (enumeration-safe)
      return { status: "verification_sent", user: undefined };   // <-- sends nothing on a real collision
    }
    let user: User;
    try {
      user = await userRepo.insertUser(db, { email: normalized, passwordHash: await hasher.hashPassword(password), emailVerifiedAt: null });
    } catch (error) { /* only the UNIQUE-race belongs to the conflict shape; everything else must surface */ }
    // ... sendVerificationEmail(user) is awaited after this; a throw here strands the row
  }
  ```
- The `Identity` interface (`identity.ts:607-709`) has **no** resend affordance.
- `requestPasswordReset` is the enumeration-safe, success-shaped, dummy-work
  exemplar to mirror (find it in `identity.ts` — it issues one token + send and
  returns a success shape regardless of whether the user exists).

### Conventions to follow

- **Enumeration safety**: the new method must return the same success shape and
  do equal-cost work whether or not the email exists / is already verified — copy
  `requestPasswordReset`'s decoy-work pattern exactly.
- Errors carry codes; input validation stays (`assertValidEmail`).
- 100% coverage on the identity package.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Gate | `cd packages/identity && bun run typecheck && bun run lint && bun run format:check && bun run test:cov` | exit 0, 100% |

## Scope

**In scope**:
- `packages/identity/src/identity.ts` — add `resendVerification(email)` to the
  service + the `Identity` interface; optionally make the conflict arm re-send
  when the colliding user is unverified.
- `packages/identity/test/*` — add cases.

**Out of scope**:
- The KDF, session, or reset-token logic.
- `register`'s enumeration behavior for the *verified*-collision case (must stay
  success-shaped and silent).

## Steps

### Step 1: Add `resendVerification`

Mirror `requestPasswordReset`: look up the user; if it exists AND is unverified,
issue a fresh verification token + send; in all other branches (no user, or
already verified) do equal-cost decoy work and return the same success shape.
Add it to the `Identity` interface (`identity.ts:607-709`).

**Verify**: `cd packages/identity && bun run typecheck` → exit 0.

### Step 2: Do NOT add the conflict-arm resend (considered and dropped)

`resendVerification` alone fully recovers a stranded account and is
independently enumeration-safe. **Do not** also make `register`'s existing-user
arm re-send: `IdentityMailer` is an open (possibly synchronous) seam, so a
send-vs-decoy timing difference in the collision arm becomes observable and
hands an attacker an unsolicited-email lever via repeated `register`. Record it
as considered-and-dropped in the PR description; if a future need arises, it must
be designed to be equal-cost and same-shape across verified/unverified/absent.

**Verify**: n/a (nothing added here).

### Step 3: Document the residual

Add a doc comment on `register`: a mailer throw after the insert leaves the row
in place; recovery is `resendVerification`.

### Step 4: Tests + gate

**Verify**:
```
cd packages/identity && bun run typecheck && bun run lint && bun run format:check && bun run test:cov
```
→ exit 0, 100%.

## Test plan

Modeled on the existing `requestPasswordReset` / `register` tests:
1. **Resend for an unverified user** issues + sends a new verification.
2. **Resend for a nonexistent email** returns the same success shape and does
   decoy work (assert equal branches — enumeration-safe; make it non-vacuous).
3. **Resend for an already-verified user** sends nothing but returns success.
4. **register with a mailer that throws after insert** — assert the row exists
   and a subsequent `resendVerification` recovers it (documents the intended
   recovery path).
(No conflict-arm test — that path is dropped, Step 2.)

## Done criteria

- [ ] `resendVerification` exists on the service AND the `Identity` interface
- [ ] `cd packages/identity && bun run test:cov` exit 0, 100%, enumeration-safe resend tests present
- [ ] `cd packages/identity && bun run lint && bun run format:check` exit 0
- [ ] `register`'s stranded-row behavior is documented
- [ ] `plans/README.md` status row for 020 updated

## STOP conditions

Stop and report if:
- `requestPasswordReset` is not present as the enumeration-safe exemplar to
  mirror (it is, at ~`identity.ts:1319`).
- Reaching 100% coverage requires asserting on real timing — drive it with the
  injected clock / spies.

## Maintenance notes

- If `register` is ever wrapped in a transaction with the send, revisit this —
  the resend path is only needed because insert and send aren't atomic.
- Reviewer must scrutinize enumeration safety: every `resendVerification` branch
  must be equal-cost and same-shape.
