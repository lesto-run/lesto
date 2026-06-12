/**
 * @keel/auth — in-house authentication primitives on node:crypto.
 *
 *   const hash = hashPassword("correct horse battery staple");
 *   verifyPassword("correct horse battery staple", hash); // true
 *
 *   const sessions = new Sessions({ store: new MemorySessionStore() });
 *   const session = await sessions.create("user_1", 60_000);
 *   await sessions.verify(session.token); // the live session
 *   await sessions.revoke(session.token);
 *
 * OAuth / social sign-in via better-auth is a future adapter, out of scope here.
 */

export { hashPassword, verifyPassword } from "./password";

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
