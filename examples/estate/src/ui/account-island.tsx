/**
 * Compatibility re-export: the Account island's canonical home moved to
 * `app/islands/account.tsx` (ADR 0011 Increment 2 — estate adopts the one-island-
 * per-file `app/islands/` convention `@keel/assets` synthesizes the client entry
 * from). Pages and tests that import the named `AccountIsland` keep working
 * through this shim; new code should import the default from `app/islands/`.
 */

export { default as AccountIsland } from "../../app/islands/account";
