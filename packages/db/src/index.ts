/**
 * @lesto/db — a Drizzle-shaped, typed query DSL over the minimal SQL surface.
 *
 *   // 1. Define the schema. The value is the source of truth for both
 *   //    on-disk DDL and the TS types every query gets back.
 *
 *   import { defineTable, integer, text } from "@lesto/db";
 *
 *   export const users = defineTable("users", {
 *     id: integer("id").primaryKey({ autoIncrement: true }),
 *     email: text("email").notNull().unique(),
 *     passwordHash: text("password_hash").notNull(),
 *     emailVerifiedAt: text("email_verified_at"),
 *   });
 *
 *   type User = InferRow<typeof users>;
 *   //   { id: number; email: string; passwordHash: string; emailVerifiedAt: string | null }
 *
 *   // 2. Build a Db over your driver — explicit, no global.
 *
 *   import { createDb, eq } from "@lesto/db";
 *   const db = createDb(sqlAdapter);
 *
 *   // 3. Query through the schema value. `users.email` is the typed column
 *   //    reference; `eq(users.email, 1)` is a TypeScript error.
 *
 *   const user = await db.select().from(users).where(eq(users.email, "ada@example.com")).get();
 *   const created = await db.insert(users).values({ email, passwordHash }).returning().get();
 *   await db.update(users).set({ passwordHash: next }).where(eq(users.id, created.id)).run();
 *
 *   // 4. The same value backs the migration's DDL — no duplicate column lists.
 *
 *   import { createTableSql } from "@lesto/db";
 *   migrator.add({ up: (s) => s.execute(createTableSql(users)) });
 *
 * The shape is deliberately Drizzle-flavored — schema-as-value, typed
 * columns, explicit db, no inheritance — but the implementation is Lesto's
 * (small, no Drizzle Kit dependency, no driver lock-in). See
 * `docs/adr/0004-data-layer-style.md` for the why.
 */

export { integer, real, text } from "./columns";
export type {
  CellType,
  Column,
  ColumnBuilder,
  ColumnSpec,
  IsOptionalOnInsert,
  SqlType,
} from "./columns";

export { defineTable } from "./table";
export type { ColumnMap, InferInsert, InferRow, InferUpdate, Table } from "./table";

export { createTableSql, dropTableSql } from "./ddl";
export type { Dialect } from "./ddl";

export { and, eq, gt, gte, inList, isNotNull, isNull, like, lt, lte, ne, or } from "./conditions";
export type { Condition } from "./conditions";

export { createDb } from "./queries";
export type { Db, DbOptions, QueryEvent, SelectQuery } from "./queries";

export type { SqlDatabase, SqlStatement } from "./sql";

export { DbError, LestoError } from "./errors";
export type { DbErrorCode } from "./errors";
