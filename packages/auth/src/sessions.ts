import { generateToken } from "./token";
import { systemClock } from "./time";

import type { Clock, Session, SessionStore } from "./types";

/** A Map-backed session store — the default substrate for tests and dev. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  save(session: Session): void {
    this.sessions.set(session.token, session);
  }

  find(token: string): Session | undefined {
    return this.sessions.get(token);
  }

  delete(token: string): void {
    this.sessions.delete(token);
  }
}

export interface SessionsOptions {
  store: SessionStore;

  clock?: Clock;
}

/**
 * The session lifecycle: mint, verify, revoke.
 *
 * Expiry is decided against an injected clock so tests are deterministic. A
 * session that has expired is deleted on first sight — verification is also the
 * sweep, so dead rows don't accumulate.
 */
export class Sessions {
  private readonly store: SessionStore;

  private readonly clock: Clock;

  constructor(options: SessionsOptions) {
    this.store = options.store;
    this.clock = options.clock ?? systemClock;
  }

  /** Mint a session for a user, valid for `ttlMs` from now. */
  create(userId: string, ttlMs: number): Session {
    const session: Session = {
      token: generateToken(),
      userId,
      expiresAt: this.clock() + ttlMs,
    };

    this.store.save(session);

    return session;
  }

  /**
   * Resolve a token to its live session.
   *
   * Returns undefined for an unknown token, and for an expired one — which it
   * also deletes on the way out.
   */
  verify(token: string): Session | undefined {
    const session = this.store.find(token);

    if (session === undefined) return undefined;

    if (this.clock() >= session.expiresAt) {
      this.store.delete(token);

      return undefined;
    }

    return session;
  }

  /** Invalidate a session immediately, whether or not it exists. */
  revoke(token: string): void {
    this.store.delete(token);
  }
}
