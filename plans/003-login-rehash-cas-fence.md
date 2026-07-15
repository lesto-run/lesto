# Plan 003: Fence login-rehash against a concurrent password reset (compare-and-swap)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c4f6915..HEAD -- packages/identity/`
> (This plan was re-stamped to `c4f6915` after an unrelated rate-limiter
> docstring edit shifted the identity.ts line anchors by +5; the excerpts below
> are current. If `git diff` shows further changes, compare excerpts before
> proceeding.)
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: correctness / security
- **Planned at**: commit `c4f6915`, 2026-07-11

## Why this matters

On a successful login, `identity.login()` transparently upgrades a stale
password hash: it re-derives the just-proven plaintext and persists it via
`setPasswordHash`, an **unconditional** `UPDATE … WHERE id = ?`.
`resetPassword` writes through the same unconditional helper. These two writes
have no fence between them, so this sequence loses data:

1. A login with the *old* password is in flight (its hash `needsRehash` — the
   exact migration corpus this repo runs via `pbkdf2MigrationHasher`). It reads
   the old hash and spends ~one KDF derive re-hashing the old plaintext.
2. Concurrently, `resetPassword` verifies its token against the old hash,
   derives the new-password hash, and writes it.
3. If the login's rehash write lands *after* the reset's, the row reverts to a
   hash of the **old** password — silently undoing the reset. And
   revoke-on-reset has already killed the user's sessions, so nothing signals
   the reversion.

The window is ~one KDF derive (~150 ms on Node, wider on edge PBKDF2), but it
is on the authentication surface and it reverts a security-motivated reset. The
fix is a compare-and-swap on the rehash path only: write the upgraded hash iff
the stored hash is still the one we proved against. A lost CAS just means the
upgrade retries on the next login — which is already the documented posture.

## Current state

- `packages/identity/src/user.ts` — the `users` table + write helpers. The
  unconditional setter and the `@lesto/db` primitives it uses:
  ```ts
  // packages/identity/src/user.ts:21 (imports — note eq is here; you will add `and`)
  import {
    createTableSql, defineTable, dropTableSql, eq, integer, text,
    type Db, type InferRow,
  } from "@lesto/db";

  // packages/identity/src/user.ts:84
  /** Stamp a user's password hash + bump `updatedAt`. */
  export async function setPasswordHash(db: Db, id: number, passwordHash: string): Promise<void> {
    await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date().toISOString() })
      .where(eq(users.id, id))
      .run();
  }
  ```
- `packages/identity/src/identity.ts` — the service. `userRepo` is a namespace
  import (`import * as userRepo from "./user"` at `identity.ts:97`), so a new
  helper is called as `userRepo.setPasswordHashIf(...)`. The rehash path:
  ```ts
  // packages/identity/src/identity.ts:1252
  if (hasher.needsRehash(user.passwordHash)) {
    const previousHash = user.passwordHash;
    let rehashed: string | undefined;

    try {
      rehashed = await hasher.hashPassword(password);
      await userRepo.setPasswordHash(db, user.id, rehashed);   // <-- unconditional
    } catch {
      rehashed = undefined;
    }

    // Announce the cost transition ONLY when the rehash actually persisted.
    if (rehashed !== undefined) {
      await emit({ type: "password_rehashed", /* ... */ });
    }
  }
  ```
- `resetPassword` writes through the same helper (leave it unconditional):
  ```ts
  // packages/identity/src/identity.ts:1386
  await userRepo.setPasswordHash(db, user.id, newHash);
  ```

### Conventions / exemplar to follow

- The `@lesto/db` update chain returns `{ changes: number }` — this is how you
  detect whether the CAS matched. `and` and `eq` are exported from `@lesto/db`
  (`packages/db/src/index.ts:61`). The queue already uses this exact idiom for
  compare-and-swap: `packages/queue/src/queue.ts:1128` (`return result.changes > 0;`)
  and `queue.ts:1165` (`if (root.changes === 0)`). Match it.
- Keep `setPasswordHashIf` structurally identical to `setPasswordHash` (same
  `updatedAt` stamping via `new Date().toISOString()`) — do not "fix" the
  clock convention here; that is a separate, out-of-scope cleanup.
- **Errors carry codes**; a lost CAS is NOT an error — it returns `false`, no
  throw.

## Commands you will need

| Purpose   | Command                                          | Expected on success |
|-----------|--------------------------------------------------|---------------------|
| Typecheck | `cd packages/identity && bun run typecheck`      | exit 0 |
| Test+cov  | `cd packages/identity && bun run test:cov`       | all pass, 100% cov |
| Lint      | `cd packages/identity && bun run lint`           | exit 0 |
| Format    | `cd packages/identity && bun run format:check`   | exit 0 |

## Scope

**In scope**:
- `packages/identity/src/user.ts` (add `setPasswordHashIf`)
- `packages/identity/src/identity.ts` (use it on the rehash path only)
- `packages/identity/test/*.ts` (add the CAS/race tests)

**Out of scope** (do NOT touch):
- `resetPassword`'s write — it stays unconditional. Only the login rehash gets
  the CAS.
- The `password_rehashed` event shape, the KDF selection, the timing-decoy
  logic, or the `Clock`/`new Date()` inconsistency.

## Git workflow

- Commit style: `fix(identity): fence login-rehash with a compare-and-swap so a concurrent reset can't be reverted`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add `setPasswordHashIf` to `user.ts`

- Add `and` to the `@lesto/db` import.
- Add a helper that writes only when the stored hash still equals the expected
  one, returning whether it matched:
  ```ts
  /**
   * Stamp a new password hash iff the stored hash still equals `expectedCurrentHash`
   * (compare-and-swap). Returns true when the row was updated. A false return means
   * the stored hash changed under us (e.g. a concurrent reset) — the caller must not
   * treat that as a persisted upgrade.
   */
  export async function setPasswordHashIf(
    db: Db,
    id: number,
    passwordHash: string,
    expectedCurrentHash: string,
  ): Promise<boolean> {
    const { changes } = await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date().toISOString() })
      .where(and(eq(users.id, id), eq(users.passwordHash, expectedCurrentHash)))
      .run();

    return changes > 0;
  }
  ```

**Verify**: `cd packages/identity && bun run typecheck` → exit 0.

### Step 2: Use the CAS on the login rehash path

In the rehash block (now at `identity.ts:1252` after an unrelated docstring
edit — the excerpt content still matches), **keep the existing
`if (rehashed !== undefined)` emit block verbatim** and change only the setter:
swap `setPasswordHash` → `setPasswordHashIf`, and null out `rehashed` on a lost
CAS so the existing gate suppresses the emit:
```ts
if (hasher.needsRehash(user.passwordHash)) {
  const previousHash = user.passwordHash;
  let rehashed: string | undefined;

  try {
    rehashed = await hasher.hashPassword(password);
    // Lost CAS (a concurrent reset landed) → treat as "not persisted": null out
    // so the existing `if (rehashed !== undefined)` emit gate stays silent and
    // the upgrade retries on the next login.
    if (!(await userRepo.setPasswordHashIf(db, user.id, rehashed, previousHash))) {
      rehashed = undefined;
    }
  } catch {
    rehashed = undefined;
  }

  // UNCHANGED: keep the existing `if (rehashed !== undefined) { await emit({ type:
  // "password_rehashed", ... }) }` block exactly as it is.
}
```
Do NOT introduce a separate `persisted` boolean: `describeHashCost(rehashed)`
in the emit body requires a `string`, and a boolean gate would not narrow
`rehashed: string | undefined` → `bun run typecheck` would fail. Reusing the
existing `if (rehashed !== undefined)` narrowing is what keeps the typecheck
green.

**Verify**: `cd packages/identity && bun run typecheck` → exit 0.

### Step 3: Tests + full gate

See Test plan, then:

**Verify**:
```
cd packages/identity && bun run typecheck && bun run lint && bun run format:check && bun run test:cov
```
→ every command exits 0, 100% coverage.

## Test plan

Add to the identity test suite (find the file: `ls packages/identity/test`),
modeled on the existing login/reset tests:

1. **CAS matches (happy path)**: a login with a `needsRehash` hash and no
   concurrent write persists the upgrade and emits `password_rehashed`.
2. **CAS loses to a concurrent reset**: simulate the race by having the stored
   hash change between the login's read and its write — e.g. spy on
   `userRepo.setPasswordHashIf` (the namespace import exists specifically so
   test code can `vi.spyOn(userRepo, …)`, see `identity.ts:93`) to return
   `false`, or mutate the fake DB row's hash before the CAS runs. Assert:
   - the login still **succeeds** (the rehash is best-effort),
   - **no** `password_rehashed` event is emitted,
   - the stored hash is the reset's new hash, not the rehash.
3. **`setPasswordHashIf` unit test** in the user-helper tests: returns `true`
   and updates when the expected hash matches; returns `false` and leaves the
   row untouched when it does not.
4. Branch on event `type` / error `code`, never on message strings.

Ensure the new false-return branch is covered (100% gate) — construct the
mismatch and confirm the test goes red if the CAS is removed (avoid a vacuous
assertion, per this repo's traps).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd packages/identity && bun run typecheck` exits 0
- [ ] `cd packages/identity && bun run test:cov` exits 0, 100% coverage, new CAS/race tests present and passing
- [ ] `cd packages/identity && bun run lint && bun run format:check` exit 0
- [ ] `grep -n "setPasswordHashIf" packages/identity/src/identity.ts` shows it used on the rehash path
- [ ] `grep -n "setPasswordHash\b" packages/identity/src/identity.ts` still shows the unconditional setter used by `resetPassword` (line ~1386)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row for 003 updated

## STOP conditions

Stop and report back if:

- The rehash block or `setPasswordHash` does not match the "Current state"
  excerpts (drift).
- `@lesto/db`'s update chain does not return `{ changes }` at this version
  (the excerpt says it does — `packages/db/src/queries.ts:660`); if it doesn't,
  report rather than inventing a SELECT-then-write (which reintroduces the race).
- Reaching 100% coverage would require asserting on real timing/wall-clock
  waits — it should not; drive the race with a spy/fake, not a real delay.

## Maintenance notes

- If `resetPassword` ever gains its own rehash/upgrade step, it must use the
  same CAS or a transaction — two unconditional writers reintroduce the bug.
- Reviewer should confirm `resetPassword` stayed unconditional and that the
  `password_rehashed` emit is gated on the CAS result (a lost CAS must be
  silent, not an error).
