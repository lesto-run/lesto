import { sha256 } from "./hash";

import type { Session, SessionStore, SqlDatabase } from "./types";

/** The single table every SQL-backed session store reads and writes. */
const TABLE = "lesto_sessions";

/**
 * A SQL session store, plus the two by-row affordances the SQL backing makes
 * cheap (and a memory store would not).
 *
 * `deleteByUserId` is the wiring `IdentityOptions.revokeUserSessions` wants — the
 * `user_id` index exists precisely for it. `deleteExpired` is the sweep: `verify`
 * already deletes expired tokens on sight, so only never-again-presented tokens
 * accumulate; the caller runs this on whatever cadence it likes. Neither is on the
 * core three-verb {@link SessionStore} interface — a memory store would need a
 * second index for a feature most callers never use.
 */
export interface SqlSessionStore extends SessionStore {
  deleteByUserId(userId: string): Promise<number>;
  deleteExpired(now: number): Promise<number>;
}

/**
 * Create the session table and its indexes if they are not already there.
 *
 * Idempotent (every statement is `IF NOT EXISTS`), so it is safe to run at every
 * boot after the migrator. `expires_at` is **`BIGINT`, not `INTEGER`** — epoch-ms
 * is ~1.8e12, which overflows Postgres int4 (~2.1e9); BIGINT gives SQLite 64-bit
 * INTEGER affinity and PG int8. The `user_id` index serves `deleteByUserId`; the
 * `expires_at` index serves `deleteExpired`.
 *
 * The `token` column holds `sha256(token)`, never the plaintext (see
 * {@link sqlSessionStore}) — the schema is identical either way (a TEXT primary
 * key), so existing deployments need no migration; new rows simply land hashed.
 */
export async function installSessionSchema(db: SqlDatabase): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    )
  `);

  await db.exec(`CREATE INDEX IF NOT EXISTS ${TABLE}_user_id ON ${TABLE} (user_id)`);

  await db.exec(`CREATE INDEX IF NOT EXISTS ${TABLE}_expires_at ON ${TABLE} (expires_at)`);
}

/** The shape a session row comes back as. `expires_at` may arrive string-typed. */
interface SessionRow {
  user_id: string;
  expires_at: number | string;
}

/**
 * A SQL-backed {@link SessionStore}.
 *
 * Statements are prepared **eagerly at construction** — `prepare()` is sync
 * (ADR 0006) and sessions never transact, so pool-level prepared statements are
 * correct here (every verb is a single statement that runs through the pool with
 * no transaction to escape). The rate-limit store (which transacts) must instead
 * prepare per-transaction on `tx`; this is the deliberate opposite of that.
 *
 * **Tokens are hashed at rest.** The `token` column stores `sha256(token)`, not
 * the plaintext: `save` hashes before INSERT, and `find`/`delete` hash the
 * presented token before they look it up. SHA-256 is deterministic, so the same
 * plaintext always finds its own row — the hashing is invisible to callers, who
 * keep passing and receiving the plaintext token (`find` returns the very token
 * it was handed). The point is the *snapshot*: a leaked database dump now holds
 * only digests, and a digest cannot be replayed as a bearer token (you cannot
 * invert SHA-256 to recover the value a client must present). The token's 256
 * bits of `randomBytes` entropy mean an unsalted hash is enough — there is no
 * password to brute-force. `deleteByUserId` and `deleteExpired` key on `user_id`
 * / `expires_at`, never the token, so they are unaffected.
 */
export function sqlSessionStore(db: SqlDatabase): SqlSessionStore {
  const upsert = db.prepare(`
    INSERT INTO ${TABLE} (token, user_id, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at
  `);

  const selectByToken = db.prepare(`SELECT user_id, expires_at FROM ${TABLE} WHERE token = ?`);

  const deleteByToken = db.prepare(`DELETE FROM ${TABLE} WHERE token = ?`);

  const deleteByUser = db.prepare(`DELETE FROM ${TABLE} WHERE user_id = ?`);

  const deleteExpiredBefore = db.prepare(`DELETE FROM ${TABLE} WHERE expires_at < ?`);

  return {
    async save(session: Session) {
      // Store the digest, never the plaintext. The row is keyed by sha256(token)
      // so a DB snapshot holds nothing replayable.
      await upsert.run([sha256(session.token), session.userId, session.expiresAt]);
    },

    async find(token) {
      const row = (await selectByToken.get([sha256(token)])) as SessionRow | undefined;

      if (row === undefined) return undefined;

      // node-postgres returns BIGINT as a string (no int8 parser registered),
      // so coerce every numeric column on read — `clock() >= expiresAt` must
      // compare numbers on both drivers. We return the *plaintext* token the
      // caller handed us (the row only stored its digest), so hashing stays
      // invisible to the session layer.
      return { token, userId: String(row.user_id), expiresAt: Number(row.expires_at) };
    },

    async delete(token) {
      await deleteByToken.run([sha256(token)]);
    },

    async deleteByUserId(userId) {
      const { changes } = await deleteByUser.run([userId]);

      return changes;
    },

    async deleteExpired(now) {
      const { changes } = await deleteExpiredBefore.run([now]);

      return changes;
    },
  };
}
