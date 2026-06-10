import { Model } from "@keel/orm";
import type { Migration } from "@keel/migrate";

/**
 * The `users` table — identity's only persisted entity.
 *
 *   id              the surrogate primary key the ORM seeds
 *   email           lower-cased, unique; the natural identifier the user types
 *   password_hash   the scrypt hash from @keel/auth's `hashPassword`
 *   email_verified_at  ISO timestamp; `null` until verification completes
 *   created_at / updated_at  the conventional pair
 *
 * Email is stored lower-cased so case-insensitive lookup works without citext —
 * lookup callers (register/login/reset) all lower-case before they query, so the
 * column comparison is literal and the same answer on SQLite and Postgres.
 */
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

/**
 * The migration that creates `users`. Versioned with a sortable, stable prefix —
 * `@keel/migrate` applies migrations in lexicographic order, so a timestamped
 * version lets later identity migrations slot in cleanly.
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
