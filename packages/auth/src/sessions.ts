import { generateToken } from "./token";
import { systemClock } from "./time";

import type { Clock, Session, SessionStore } from "./types";

/** A Map-backed session store — the default substrate for tests and dev. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  async save(session: Session): Promise<void> {
    this.sessions.set(session.token, session);
  }

  async find(token: string): Promise<Session | undefined> {
    return this.sessions.get(token);
  }

  async delete(token: string): Promise<void> {
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
 * sweep, so dead rows don't accumulate. The store may now be an SQL table shared
 * across nodes (ADR 0013), so every store call is awaited.
 */
export class Sessions {
  private readonly store: SessionStore;

  private readonly clock: Clock;

  constructor(options: SessionsOptions) {
    this.store = options.store;
    this.clock = options.clock ?? systemClock;
  }

  /** Mint a session for a user, valid for `ttlMs` from now. */
  async create(userId: string, ttlMs: number): Promise<Session> {
    const session: Session = {
      token: generateToken(),
      userId,
      expiresAt: this.clock() + ttlMs,
    };

    await this.store.save(session);

    return session;
  }

  /**
   * Resolve a token to its live session.
   *
   * Returns undefined for an unknown token, and for an expired one — which it
   * also deletes on the way out.
   */
  async verify(token: string): Promise<Session | undefined> {
    const session = await this.store.find(token);

    if (session === undefined) return undefined;

    if (this.clock() >= session.expiresAt) {
      await this.store.delete(token);

      return undefined;
    }

    return session;
  }

  /** Invalidate a session immediately, whether or not it exists. */
  async revoke(token: string): Promise<void> {
    await this.store.delete(token);
  }
}
