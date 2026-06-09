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

/** Where sessions live. Minimal on purpose — a Map or a table both fit. */
export interface SessionStore {
  save(session: Session): void;

  find(token: string): Session | undefined;

  delete(token: string): void;
}
