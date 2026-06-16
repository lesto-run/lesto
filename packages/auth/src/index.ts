/**
 * @keel/auth — in-house authentication primitives on node:crypto.
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
 * OAuth / social sign-in via better-auth is a future adapter, out of scope here.
 */

export { hashPassword, needsRehash, verifyPassword } from "./password";

export { generateToken } from "./token";

export { MemorySessionStore, Sessions } from "./sessions";
export type { SessionsOptions } from "./sessions";

export { installSessionSchema, sqlSessionStore } from "./sql-session-store";
export type { SqlSessionStore } from "./sql-session-store";

export { SignedSessions } from "./signed-sessions";
export type { SignedClaim, SignedSessionsOptions } from "./signed-sessions";

export { systemClock } from "./time";

export { AuthError, KeelError } from "./errors";
export type { AuthErrorCode } from "./errors";

export type { Clock, Session, SessionStore, SqlDatabase, SqlStatement } from "./types";
