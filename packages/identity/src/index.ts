/**
 * @volo/identity — Volo's batteries-included auth.
 *
 *   const db = createDb(sqlAdapter);
 *
 *   const identity = createIdentity({
 *     db,
 *     secret: env.VOLO_AUTH_SECRET,
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
 *   - `@volo/auth`    — scrypt hashing, store-backed sessions, signed tokens
 *   - `@volo/db`      — the `users` schema, typed queries, and DDL
 *   - `@volo/migrate` — the `users` table migration shape
 *
 * Mail is injected as an interface so the package itself stays decoupled
 * from `@volo/mail`'s queue + worker boot; a two-line adapter wires the two
 * together at app boot.
 */

export { createIdentity } from "./identity";
export type { Identity, IdentityEvent, IdentityMailer, IdentityOptions } from "./identity";

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
  clearSessionCookie,
  readCookie,
  readSessionToken,
  SESSION_COOKIE,
  sessionCookie,
} from "./cookies";

export { IdentityError, VoloError } from "./errors";
export type { IdentityErrorCode } from "./errors";
