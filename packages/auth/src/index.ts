/**
 * @lesto/auth — in-house authentication primitives on node:crypto.
 *
 *   const hash = await hashPassword("correct horse battery staple");
 *   await verifyPassword("correct horse battery staple", hash); // true
 *   needsRehash(hash); // false — minted under the current cost
 *
 *   const sessions = new Sessions({ store: new MemorySessionStore() });
 *   const session = await sessions.create("user_1", 60_000);
 *   await sessions.verify(session.token); // the live session
 *   await sessions.revoke(session.token);
 *
 *   const secret = generateTotpSecret();           // RFC 6238 base32 secret
 *   verifyTotp(secret, totpCode(secret)!);          // second-factor primitive
 *   const codes = generateRecoveryCodes();          // single-use, scrypt-hashed at rest
 *
 * OAuth / social sign-in via better-auth is a future adapter, out of scope here.
 * WebAuthn/passkey + magic-link factors are designed in ADR 0020 (follow-ups).
 */

export { hashPassword, needsRehash, verifyPassword } from "./password";

// The explicit per-algorithm backends, for callers that must pin one (e.g. minting
// PBKDF2 from Node for a DB an edge app will read; see the cross-runtime caveat in
// `./password`) rather than take the runtime-selected default the facade above
// provides. Verification needs no such pin — `verifyPassword` already dispatches on
// the stored hash's own prefix — but these shipped public in 0.1.4, so they stay.
export { hashPasswordScrypt, needsRehashScrypt, verifyPasswordScrypt } from "./password-scrypt";
export {
  EDGE_MAX_ITERATIONS,
  hashPasswordWeb,
  needsRehashWeb,
  verifyPasswordWeb,
} from "./password-web";
export type { HashPasswordWebOptions } from "./password-web";

export { isWorkerd, selectPasswordAlgorithm } from "./runtime";
export type { PasswordAlgorithm } from "./runtime";

export { sha256 } from "./hash";

export { generateToken } from "./token";

export { generateTotpSecret, totpCode, totpKeyUri, verifyTotp, verifyTotpStep } from "./totp";
export type { TotpKeyUriOptions, TotpOptions, TotpVerifyOptions } from "./totp";

export { generateRecoveryCodes, hashRecoveryCodes, verifyRecoveryCode } from "./recovery-codes";

export { MemorySessionStore, Sessions } from "./sessions";
export type { SessionsOptions } from "./sessions";

export { installSessionSchema, sqlSessionStore } from "./sql-session-store";
export type { SqlSessionStore } from "./sql-session-store";

export { SignedSessions } from "./signed-sessions";
export type { SignedClaim, SignedSessionsOptions } from "./signed-sessions";

export { systemClock } from "./time";

export { AuthError, LestoError } from "./errors";
export type { AuthErrorCode } from "./errors";

export type { Clock, Session, SessionStore, SqlDatabase, SqlStatement } from "./types";
