/**
 * The `users` table — identity's only persisted entity — as a `@keel/db`
 * schema value, plus the small helper functions identity calls.
 *
 *   id              the surrogate primary key SQLite auto-assigns
 *   email           lower-cased, unique; the natural identifier the user types
 *   passwordHash    the scrypt hash from @keel/auth's `hashPassword`
 *   emailVerifiedAt ISO timestamp; `null` until verification completes
 *   createdAt       ISO timestamp; stamped by `insertUser` (no DB trigger)
 *   updatedAt       ISO timestamp; stamped by every write helper
 *
 * Email is stored lower-cased so case-insensitive lookup works without
 * citext — lookup callers all lower-case before they query, so the column
 * comparison is literal and the same answer on SQLite and Postgres.
 *
 * The schema *value* (`users`) backs both the migration's `CREATE TABLE` and
 * the inferred row type (`User = InferRow<typeof users>`), so the column
 * list has exactly one source of truth.
 */

import {
  createTableSql,
  defineTable,
  dropTableSql,
  eq,
  integer,
  text,
  type Db,
  type InferRow,
} from "@keel/db";
import type { Migration } from "@keel/migrate";

export const users = defineTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: text("email_verified_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** A user row — the shape SELECT yields and identity passes around. */
export type User = InferRow<typeof users>;

/** A camelCase view of the writable fields, the shape the service speaks. */
export interface UserInput {
  readonly email: string;
  readonly passwordHash: string;
  readonly emailVerifiedAt: string | null;
}

/** True iff the user has clicked the verification link. */
export function isEmailVerified(user: User): boolean {
  return user.emailVerifiedAt !== null;
}

/** Insert a user, stamping `createdAt` / `updatedAt`, and return the row. */
export async function insertUser(db: Db, input: UserInput): Promise<User> {
  const now = new Date().toISOString();

  return await db
    .insert(users)
    .values({
      email: input.email,
      passwordHash: input.passwordHash,
      emailVerifiedAt: input.emailVerifiedAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/** Look up a user by email; `undefined` when no row matches. */
export async function findUserByEmail(db: Db, email: string): Promise<User | undefined> {
  return await db.select().from(users).where(eq(users.email, email)).get();
}

/** Look up a user by id; `undefined` when no row matches. */
export async function findUserById(db: Db, id: number): Promise<User | undefined> {
  return await db.select().from(users).where(eq(users.id, id)).get();
}

/** Stamp a user's password hash + bump `updatedAt`. */
export async function setPasswordHash(db: Db, id: number, passwordHash: string): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date().toISOString() })
    .where(eq(users.id, id))
    .run();
}

/** Stamp a user's `emailVerifiedAt` + bump `updatedAt`. */
export async function markEmailVerified(db: Db, id: number, atIso: string): Promise<void> {
  await db
    .update(users)
    .set({ emailVerifiedAt: atIso, updatedAt: new Date().toISOString() })
    .where(eq(users.id, id))
    .run();
}

/** Delete a user row by id. Used in tests; production deletes go through a service flow. */
export async function deleteUser(db: Db, id: number): Promise<void> {
  await db.delete(users).where(eq(users.id, id)).run();
}

/** Normalize an email to its canonical, comparable form. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The migration that creates `users`. Versioned with a sortable, stable
 * prefix — `@keel/migrate` applies migrations in lexicographic order, so a
 * timestamped version lets later identity migrations slot in cleanly.
 *
 * Crucially, `up`/`down` execute the *schema-as-value's* DDL — exactly one
 * column list lives in this file, and it's the one queries also use.
 */
export const usersMigration: { version: string; migration: Migration } = {
  version: "20260609000001_create_users",
  migration: {
    async up(schema) {
      await schema.execute(createTableSql(users));
    },
    async down(schema) {
      await schema.execute(dropTableSql(users));
    },
  },
};
