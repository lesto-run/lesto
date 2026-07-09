/**
 * TOTP second-factor storage — the two tables identity persists a factor in,
 * plus the small repo helpers the service calls.
 *
 *   totp_factors   one enrolled TOTP secret per user (UNIQUE user_id), with the
 *                  `confirmed_at` instant set once the user proves the first code.
 *   recovery_codes N single-use, KDF-hashed backup codes per user (scrypt on Node,
 *                  PBKDF2 on the edge).
 *
 * Both are `@lesto/db` schema *values* (ADR 0004): the value backs the migration
 * DDL and the inferred row type, so the column list has one source of truth. They
 * use the richer column types ADR 0018 (Increment 1) added — `timestamp`
 * (epoch-ms ⇄ `Date`) for the temporal columns — instead of the string-by-
 * convention timestamps the older `users` table predates.
 *
 * A TOTP *secret* is the one credential that cannot be one-way hashed: the
 * verifier must recompute the live code, so it holds the secret in recoverable
 * form (ADR 0020). At-rest protection of that secret column is the deployment's
 * encryption job. Recovery *codes*, by contrast, are stored only as their
 * `hashPassword` digests (scrypt on Node, PBKDF2 on the edge) — a DB snapshot
 * yields no usable codes.
 *
 * The `user_id` columns are plain `integer` references for now; a real
 * `references(() => users.id)` foreign key lands when ADR 0018 Increment 2 ships
 * FKs. Promoting the column to an FK is schema-only and non-breaking.
 */

import {
  boolean,
  createTableSql,
  defineTable,
  dropTableSql,
  eq,
  integer,
  text,
  timestamp,
  and,
  isNull,
  type Db,
  type InferRow,
} from "@lesto/db";
import type { Migration } from "@lesto/migrate";

/** A user's single enrolled TOTP factor. `confirmed = false` until the first code proves it. */
export const totpFactors = defineTable("totp_factors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().unique(),
  secret: text("secret").notNull(),
  confirmed: boolean("confirmed").notNull(),
  confirmedAt: timestamp("confirmed_at"),
  // The RFC 6238 step counter of the last code we *accepted* for this factor
  // (`floor(epochSeconds / timeStep)`), or `null` before the first success.
  // Verification refuses a code whose matched step is ≤ this, so a code observed
  // on the wire cannot be replayed inside its still-live ±window (RFC 6238 §5.2).
  lastUsedStep: integer("last_used_step"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/** One single-use recovery code, stored only as its KDF hash; `usedAt` set on consumption. */
export const recoveryCodes = defineTable("recovery_codes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  codeHash: text("code_hash").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull(),
});

/** A TOTP factor row. */
export type TotpFactor = InferRow<typeof totpFactors>;

/** A recovery-code row. */
export type RecoveryCode = InferRow<typeof recoveryCodes>;

/** Find a user's TOTP factor, or `undefined` if they have not enrolled. */
export async function findTotpFactor(db: Db, userId: number): Promise<TotpFactor | undefined> {
  return await db.select().from(totpFactors).where(eq(totpFactors.userId, userId)).get();
}

/**
 * Upsert an *unconfirmed* TOTP factor for a user with a freshly generated secret.
 *
 * Enrolling again before confirmation replaces the prior unconfirmed secret (the
 * delete-then-insert keeps the `UNIQUE user_id` invariant without a dialect-
 * specific `ON CONFLICT`). Returns the inserted row.
 */
export async function upsertUnconfirmedFactor(
  db: Db,
  userId: number,
  secret: string,
): Promise<TotpFactor> {
  const now = new Date();

  await db.delete(totpFactors).where(eq(totpFactors.userId, userId)).run();

  return await db
    .insert(totpFactors)
    .values({
      userId,
      secret,
      confirmed: false,
      confirmedAt: null,
      lastUsedStep: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/** Mark a factor confirmed, stamping `confirmedAt` + bumping `updatedAt`. */
export async function confirmFactor(db: Db, userId: number): Promise<void> {
  const now = new Date();

  await db
    .update(totpFactors)
    .set({ confirmed: true, confirmedAt: now, updatedAt: now })
    .where(eq(totpFactors.userId, userId))
    .run();
}

/**
 * Persist the step counter of a just-accepted TOTP code so a replay inside the
 * live ±window is refused next time (RFC 6238 §5.2). Bumps `updatedAt`.
 */
export async function recordTotpStep(db: Db, userId: number, step: number): Promise<void> {
  await db
    .update(totpFactors)
    .set({ lastUsedStep: step, updatedAt: new Date() })
    .where(eq(totpFactors.userId, userId))
    .run();
}

/** Replace a user's recovery codes with a fresh batch of hashes. */
export async function replaceRecoveryCodes(
  db: Db,
  userId: number,
  hashes: readonly string[],
): Promise<void> {
  const now = new Date();

  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();

  for (const codeHash of hashes) {
    await db.insert(recoveryCodes).values({ userId, codeHash, usedAt: null, createdAt: now }).run();
  }
}

/** Every still-unused recovery code for a user. */
export async function findUnusedRecoveryCodes(db: Db, userId: number): Promise<RecoveryCode[]> {
  return await db
    .select()
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
    .all();
}

/**
 * Atomically claim a recovery code: stamp `usedAt` only while it is still unused
 * (`WHERE id = ? AND used_at IS NULL`). Returns `true` iff this call won the
 * claim — a `changes` of 0 means a concurrent consumer already spent it, so the
 * caller must treat it as "lost the race" and refuse. This closes the
 * check-then-mark TOCTOU: two requests racing the same code both find it unused
 * in `findUnusedRecoveryCodes`, but only one conditional UPDATE flips a row.
 */
export async function markRecoveryCodeUsed(db: Db, id: number): Promise<boolean> {
  const { changes } = await db
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(recoveryCodes.id, id), isNull(recoveryCodes.usedAt)))
    .run();

  return changes > 0;
}

/**
 * The migration that creates the TOTP tables. Versioned after `usersMigration`
 * so it applies in order; renders against the running dialect like the users one.
 */
export const totpMigration: { version: string; migration: Migration } = {
  version: "20260618000001_create_totp_factors",
  migration: {
    async up(schema) {
      await schema.execute(createTableSql(totpFactors, schema.dialect));
      await schema.execute(createTableSql(recoveryCodes, schema.dialect));
    },
    async down(schema) {
      await schema.execute(dropTableSql(recoveryCodes));
      await schema.execute(dropTableSql(totpFactors));
    },
  },
};
