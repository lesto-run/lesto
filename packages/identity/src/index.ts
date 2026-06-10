/**
 * @keel/identity — Keel's batteries-included auth.
 *
 *   const identity = new Identity({
 *     secret: env.KEEL_AUTH_SECRET,
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
 *   - `@keel/auth`    — scrypt hashing, store-backed sessions, signed tokens
 *   - `@keel/orm`     — the `User` model on the SQL substrate
 *   - `@keel/migrate` — the `users` table migration
 *
 * Mail is injected as an interface so the package itself stays decoupled from
 * `@keel/mail`'s queue + worker boot; a two-line adapter wires the two
 * together at app boot.
 */

export { Identity } from "./identity";
export type { IdentityMailer, IdentityOptions } from "./identity";

export { normalizeEmail, User, usersMigration } from "./user";

export {
  clearSessionCookie,
  readCookie,
  readSessionToken,
  SESSION_COOKIE,
  sessionCookie,
} from "./cookies";

export { IdentityError, KeelError } from "./errors";
export type { IdentityErrorCode } from "./errors";
