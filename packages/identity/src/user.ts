/**
 * The `users` table — identity's only persisted entity — plus the camelCase
 * façade the rest of `@keel/identity` queries through.
 *
 * `User` itself is the legacy `@keel/orm` Model class (the constraint of the
 * current data layer; ADR 0004 plans to retire it). Everything *outside*
 * this module reads `user` instances via camelCase getters and writes via
 * the helpers below — `insertUser` / `setPasswordHash` / `markEmailVerified`
 * — which are the single place snake_case column names live.
 *
 *   id              the surrogate primary key the ORM seeds
 *   email           lower-cased, unique; the natural identifier the user types
 *   password_hash   the scrypt hash from @keel/auth's `hashPassword`
 *   email_verified_at  ISO timestamp; `null` until verification completes
 *   created_at / updated_at  the conventional pair
 *
 * Email is stored lower-cased so case-insensitive lookup works without
 * citext — lookup callers all lower-case before they query, so the column
 * comparison is literal and the same answer on SQLite and Postgres.
 */

import { Model } from "@keel/orm";
import type { Migration } from "@keel/migrate";

export class User extends Model {
  static override tableName = "users";

  static override timestamps = true;

  static override columns = ["email", "password_hash", "email_verified_at"] as const;

  get email(): string {
    return this.get("email") as string;
  }

  get passwordHash(): string {
    return this.get("password_hash") as string;
  }

  /** ISO timestamp the email was confirmed at — `null` if not yet verified. */
  get emailVerifiedAt(): string | null {
    return (this.get("email_verified_at") as string | null) ?? null;
  }

  get isEmailVerified(): boolean {
    return this.emailVerifiedAt !== null;
  }
}

/** A camelCase view of the writable fields, the shape the service speaks. */
export interface UserInput {
  readonly email: string;
  readonly passwordHash: string;
  readonly emailVerifiedAt: string | null;
}

/** Insert a user from a camelCase input. The only place snake_case keys live for writes. */
export function insertUser(input: UserInput): User {
  return User.create({
    email: input.email,
    password_hash: input.passwordHash,
    email_verified_at: input.emailVerifiedAt,
  });
}

/** Look up a user by email; `undefined` when no row matches. */
export function findUserByEmail(email: string): User | undefined {
  return User.findBy({ email });
}

/** Look up a user by id; `undefined` when no row matches. */
export function findUserById(id: number): User | undefined {
  return User.findBy({ id });
}

/** Stamp a user's password hash. */
export function setPasswordHash(user: User, passwordHash: string): void {
  user.update({ password_hash: passwordHash });
}

/** Stamp a user's `email_verified_at` timestamp. */
export function markEmailVerified(user: User, atIso: string): void {
  user.update({ email_verified_at: atIso });
}

/**
 * The migration that creates `users`. Versioned with a sortable, stable
 * prefix — `@keel/migrate` applies migrations in lexicographic order, so a
 * timestamped version lets later identity migrations slot in cleanly.
 */
export const usersMigration: { version: string; migration: Migration } = {
  version: "20260609000001_create_users",
  migration: {
    up(schema) {
      schema.createTable("users", (t) => {
        t.string("email", { null: false, unique: true });
        t.string("password_hash", { null: false });
        t.datetime("email_verified_at");
        t.timestamps();
      });
    },
    down(schema) {
      schema.dropTable("users");
    },
  },
};

/** Normalize an email to its canonical, comparable form. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
