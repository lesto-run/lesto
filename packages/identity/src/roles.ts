/**
 * The `user_roles` store — the durable `userId -> roles` map the operator control
 * plane resolves (ADR 0028 Phase-3 prerequisite, plan Inc 5).
 *
 * Phase 1 shipped only the `rolesOf` *seam* (`createPrincipalResolver({ rolesOf })`,
 * `@lesto/authz`): a function the app injects. That is enough for a `?role=`-free demo
 * backed by a hard-coded map, but a non-interactive agent (an MCP caller, a remote
 * token) needs roles that PERSIST and resolve per user from a real store. This is that
 * store: one row per `(user, role)` grant, read by {@link rolesOf} and written by
 * {@link grantRole} / {@link revokeRole}.
 *
 * Keyed by a free TEXT `user_id`, deliberately NOT a foreign key to `users.id`: the
 * principal's `actor` is a `string` end to end (the single coercion boundary, ADR 0028
 * Inc 1) and may name a subject this identity store never minted — an external IdP, the
 * edge's signed token. So the store stays decoupled from the integer surrogate and
 * works for any actor id. Deny-by-default is structural: a user with no rows resolves to
 * `[]`, which satisfies no permission.
 */

import {
  and,
  createTableSql,
  defineTable,
  dropTableSql,
  eq,
  integer,
  text,
  type Db,
} from "@lesto/db";
import type { Migration } from "@lesto/migrate";

export const userRoles = defineTable("user_roles", {
  // A surrogate key: `@lesto/db` exposes no composite-key seam, so a `(user, role)`
  // grant's uniqueness is enforced by `grantRole` (check-then-insert), not the schema.
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  role: text("role").notNull(),
});

/** The distinct roles a user holds — `[]` when none (deny-by-default). */
export async function rolesOf(db: Db, userId: string): Promise<string[]> {
  const rows = await db.select().from(userRoles).where(eq(userRoles.userId, userId)).all();

  // A user's roles are a SET; dedupe defensively even though `grantRole` is idempotent.
  return [...new Set(rows.map((row) => row.role))];
}

/** Grant `role` to `userId`, idempotently — a no-op when the grant already exists. */
export async function grantRole(db: Db, userId: string, role: string): Promise<void> {
  const existing = await db
    .select()
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.role, role)))
    .get();

  if (existing !== undefined) return;

  await db.insert(userRoles).values({ userId, role }).run();
}

/** Revoke `role` from `userId` — a no-op when the user never held it. */
export async function revokeRole(db: Db, userId: string, role: string): Promise<void> {
  await db
    .delete(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.role, role)))
    .run();
}

/**
 * The migration that creates `user_roles`. Value-DDL, rendered for the running
 * dialect exactly like {@link import("./user").usersMigration} — one column list,
 * the one the queries above also use.
 */
export const userRolesMigration: { version: string; migration: Migration } = {
  version: "20260624000001_create_user_roles",
  migration: {
    async up(schema) {
      await schema.execute(createTableSql(userRoles, schema.dialect));
    },
    async down(schema) {
      await schema.execute(dropTableSql(userRoles));
    },
  },
};
