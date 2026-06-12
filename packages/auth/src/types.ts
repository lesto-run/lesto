/**
 * The shared vocabulary of @keel/auth.
 *
 * Sessions depend on these interfaces, never on a concrete store or the system
 * clock, so the substrate (memory today, SQL tomorrow) can swap without
 * touching the session logic.
 */

/** A source of the current time, in epoch milliseconds. */
export type Clock = () => number;

/** A live session: an opaque token bound to a user, with an expiry. */
export interface Session {
  token: string;

  userId: string;

  /** Epoch milliseconds after which the session is no longer valid. */
  expiresAt: number;
}

/**
 * Where sessions live. Minimal on purpose — a Map or a table both fit.
 *
 * Every verb is asynchronous (ADR 0006/0013), even when the backing work is
 * not: the in-memory store satisfies the shape by resolving immediately, and an
 * SQL table shared across nodes satisfies the same shape over a socket. No
 * `void | Promise` unions — a sync-shaped backdoor invites the half-awaited bugs
 * the no-`tsc` coverage gate cannot catch.
 */
export interface SessionStore {
  save(session: Session): Promise<void>;

  find(token: string): Promise<Session | undefined>;

  delete(token: string): Promise<void>;
}
