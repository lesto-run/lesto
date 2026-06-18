/**
 * The two tables this example stands up, as `@lesto/db` schema values, plus the
 * migrations the kernel runs on boot and the helpers `run.ts` / the test call.
 *
 * `products` is the resource the admin panel manages — the table `@lesto/admin`
 * lists, projects, and mutates. It carries a deliberately sensitive `cost`
 * column the projection allow-list must HIDE: the admin resource declares
 * `fields: ["name", "price", "stock"]`, so `cost` never leaves a row through
 * `list` / `get`, proving projection is real and not cosmetic.
 *
 * `auditLog` is where the `onMutation` hook lands. `@lesto/admin` does not own a
 * sink — it hands you an {@link AuditEvent} after each committed write and lets
 * the host decide where it goes. Here it goes into a real table, so the audit
 * trail is queryable over HTTP (`GET /admin/audit`) and the test can assert the
 * exact `{ action, resource, id, actor }` the hook fired with.
 *
 * Both tables are plain `@lesto/db` schema values (no `extends Model`), migrated
 * through `createApp({ migrations })` — the same shape `examples/blog` uses.
 */

import {
  createTableSql,
  defineTable,
  dropTableSql,
  integer,
  text,
  type Db,
  type InferRow,
} from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";
import { z } from "zod";

/**
 * The catalog the admin manages. `cost` is the hidden column — present in the
 * table and writable, but excluded from the resource's projection `fields`, so
 * it never surfaces through the admin's `list` / `get`.
 */
export const products = defineTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  price: integer("price").notNull(),
  stock: integer("stock").notNull(),
  cost: integer("cost").notNull(),
});

/** A product row, as SELECT yields it (every column, `cost` included). */
export type Product = InferRow<typeof products>;

/**
 * The audit sink the `onMutation` hook writes to. One row per committed admin
 * write. `action` is the verb (`create` / `update` / `destroy`), `resource` the
 * admin resource name, `recordId` the affected row's primary key (stringified —
 * a PK may be an int or a slug), `actor` who did it (stringified for storage),
 * and `at` an ISO timestamp the host stamps. This is the shape an audit-trail
 * UI reads back.
 */
export const auditLog = defineTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  action: text("action").notNull(),
  resource: text("resource").notNull(),
  recordId: text("record_id").notNull(),
  actor: text("actor").notNull(),
  at: text("at").notNull(),
});

/** An audit row, as the `GET /admin/audit` route reads it back. */
export type AuditRow = InferRow<typeof auditLog>;

/** The Zod schema fronting `create`. The admin validates the body against this. */
export const productInsertSchema = z.object({
  name: z.string().min(1, "Name is required."),
  price: z.number().int().nonnegative(),
  stock: z.number().int().nonnegative(),
  // `cost` is writable (it is a real column) but never projected back out.
  cost: z.number().int().nonnegative(),
});

/** The `update` schema — every field optional, the usual "patch" shape. */
export const productUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  price: z.number().int().nonnegative().optional(),
  stock: z.number().int().nonnegative().optional(),
  cost: z.number().int().nonnegative().optional(),
});

/** The migration entries `createApp({ migrations })` runs on boot. */
export const migrations: MigrationEntry[] = [
  {
    version: "001_create_products",
    migration: {
      up: (schema) => schema.execute(createTableSql(products)),
      down: (schema) => schema.execute(dropTableSql(products)),
    },
  },
  {
    version: "002_create_audit_log",
    migration: {
      up: (schema) => schema.execute(createTableSql(auditLog)),
      down: (schema) => schema.execute(dropTableSql(auditLog)),
    },
  },
];

/** The rows the boot seeds, so a fresh panel has something to page through. */
export const SEED_PRODUCTS: readonly {
  name: string;
  price: number;
  stock: number;
  cost: number;
}[] = [
  { name: "Lesto Tee", price: 2500, stock: 120, cost: 800 },
  { name: "Hull Sticker Pack", price: 500, stock: 1000, cost: 90 },
  { name: "Rudder Mug", price: 1500, stock: 64, cost: 600 },
  { name: "Mast Hoodie", price: 6000, stock: 40, cost: 2200 },
  { name: "Deck Cap", price: 2000, stock: 0, cost: 700 },
];

/** Insert the seed catalog directly through `@lesto/db` (bypassing the admin's hook). */
export async function seedProducts(db: Db): Promise<number> {
  for (const product of SEED_PRODUCTS) {
    await db.insert(products).values(product).run();
  }

  return SEED_PRODUCTS.length;
}

/** Read the audit trail back, newest first — what `GET /admin/audit` returns. */
export function readAuditLog(db: Db): Promise<AuditRow[]> {
  return db.select().from(auditLog).orderBy(auditLog.id, "desc").all();
}
