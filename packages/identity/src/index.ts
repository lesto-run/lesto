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
 *   const { session } = identity.login("ada@example.com", "correct horse battery staple");
 *
 * Composes:
 *   - `@lesto/auth`    — password hashing (scrypt on Node, PBKDF2 on edge), store-backed sessions, signed tokens
 *   - `@lesto/db`      — the `users` schema, typed queries, and DDL
 *   - `@lesto/migrate` — the `users` table migration shape
 *
 * Mail is injected as an interface so the package itself stays decoupled
 * from `@lesto/mail`'s queue + worker boot; a two-line adapter wires the two
 * together at app boot.
 */

export { createIdentity, pbkdf2MigrationHasher } from "./identity";
export type {
  Identity,
  IdentityEvent,
  IdentityMailer,
  IdentityOptions,
  PasswordHasher,
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
} from "./user";
export type { User, UserInput } from "./user";

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
} from "./totp";
export type { RecoveryCode, TotpFactor } from "./totp";

export { grantRole, revokeRole, rolesOf, userRoles, userRolesMigration } from "./roles";

export {
  clearSessionCookie,
  readCookie,
  readSessionToken,
  SESSION_COOKIE,
  sessionCookie,
} from "./cookies";

export { IdentityError, LestoError } from "./errors";
export type { IdentityErrorCode } from "./errors";
