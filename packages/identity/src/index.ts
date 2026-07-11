/**
 * @lesto/identity — Lesto's batteries-included auth.
 *
 *   const db = createDb(sqlAdapter);
 *
 *   const identity = createIdentity({
 *     db,
 *     secret: env.LESTO_AUTH_SECRET,
 *     mailer: { sendVerificationEmail, sendPasswordResetEmail },
 *     verificationUrl: (token) => `https://app.com/verify?token=${token}`,
 *     resetUrl:        (token) => `https://app.com/reset?token=${token}`,
 *   });
 *
 *   await identity.register("ada@example.com", "correct horse battery staple");
 *   await identity.verifyEmail(tokenFromLink);
 *   const result = await identity.login("ada@example.com", "correct horse battery staple");
 *   // `result.status` is "authenticated" (session minted) or "totp_required"
 *   // (a confirmed 2FA factor — complete it with `completeTotpChallenge`).
 *
 * Composes:
 *   - `@lesto/auth`    — password hashing (scrypt on Node, PBKDF2 on edge), store-backed sessions, signed tokens
 *   - `@lesto/db`      — the `users` schema, typed queries, and DDL
 *   - `@lesto/migrate` — the `users` table migration shape
 *
 * Mail is injected as an interface so the package itself stays decoupled
 * from `@lesto/mail`'s queue + worker boot; a two-line adapter wires the two
 * together at app boot.
 *
 * **Install {@link identityMigrations}, not a hand-picked subset.** `login()`
 * reads the caller's confirmed-factor state on every call, so a deployment
 * that installs only `usersMigration` gets a raw, uncoded "no such table:
 * totp_factors" driver error the first time a password verifies. The
 * individual migration exports remain available for a caller composing its
 * own ordered set, but {@link identityMigrations} is the one array a fresh
 * install should hand its `Migrator`.
 */

import type { MigrationEntry } from "@lesto/migrate";

import { grantRole, revokeRole, rolesOf, userRoles, userRolesMigration } from "./roles";
import {
  confirmFactor,
  findTotpFactor,
  findUnusedRecoveryCodes,
  markRecoveryCodeUsed,
  recoveryCodes,
  replaceRecoveryCodes,
  totpFactors,
  totpMigration,
  upsertUnconfirmedFactor,
} from "./totp";
import {
  deleteUser,
  findUserByEmail,
  findUserById,
  insertUser,
  isEmailVerified,
  markEmailVerified,
  normalizeEmail,
  setPasswordHash,
  users,
  usersMigration,
} from "./user";

import type { RecoveryCode, TotpFactor } from "./totp";
import type { User, UserInput } from "./user";

export { createIdentity, pbkdf2MigrationHasher } from "./identity";
export type {
  Identity,
  IdentityEvent,
  IdentityMailer,
  IdentityOptions,
  LoginResult,
  PasswordHasher,
  PasswordHashCost,
} from "./identity";

export {
  deleteUser,
  findUserByEmail,
  findUserById,
  insertUser,
  isEmailVerified,
  markEmailVerified,
  normalizeEmail,
  setPasswordHash,
  users,
  usersMigration,
};
export type { User, UserInput };

export {
  confirmFactor,
  findTotpFactor,
  findUnusedRecoveryCodes,
  markRecoveryCodeUsed,
  recoveryCodes,
  replaceRecoveryCodes,
  totpFactors,
  totpMigration,
  upsertUnconfirmedFactor,
};
export type { RecoveryCode, TotpFactor };

export { grantRole, revokeRole, rolesOf, userRoles, userRolesMigration };

export {
  clearSessionCookie,
  readCookie,
  readSessionToken,
  SESSION_COOKIE,
  sessionCookie,
} from "./cookies";

export { IdentityError, LestoError } from "./errors";
export type { IdentityErrorCode } from "./errors";

/**
 * The complete, correctly ordered migration set `@lesto/identity` requires —
 * the canonical "install these" bundle for a fresh app, so a consumer cannot
 * forget a table `login()` (or roles) silently depends on:
 *
 *   1. {@link usersMigration}      — the `users` table.
 *   2. {@link totpMigration}       — `totp_factors` + `recovery_codes`.
 *      `login()` reads confirmed-factor state on EVERY call (not just for
 *      apps that use 2FA), so skipping this migration throws a raw, uncoded
 *      "no such table: totp_factors" driver error the first time a password
 *      verifies.
 *   3. {@link userRolesMigration}  — `user_roles`, for apps resolving
 *      principal roles from this store (ADR 0028).
 *
 * This is purely ADDITIVE: the individual exports above remain available for
 * a caller that wants to compose its own ordered set (e.g. interleaving app
 * migrations between them). Hand this array straight to a `Migrator` (whose
 * `sql` is the raw `SqlDatabase` handle, NOT the `createDb` query builder
 * `createIdentity` takes):
 *
 *   import { identityMigrations } from "@lesto/identity";
 *   import { Migrator } from "@lesto/migrate";
 *
 *   await new Migrator(sql, identityMigrations).migrate();
 *
 * These are the table migrations `@lesto/identity` itself owns. A deployment
 * using the DURABLE session / rate-limit stores (not the in-memory defaults)
 * also installs those stores' schemas via `installSessionSchema` /
 * `installRateLimitSchema` from `@lesto/auth` / `@lesto/ratelimit` — those are
 * schema installers, not `MigrationEntry`s, so they live outside this bundle.
 */
export const identityMigrations: readonly MigrationEntry[] = [
  usersMigration,
  totpMigration,
  userRolesMigration,
];
