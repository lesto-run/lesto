/**
 * Assemble the admin panel from its parts.
 *
 * One composable `keel()` app exposes a generic CRUD admin over the
 * `@keel/admin` service as real HTTP routes:
 *
 *   GET    /admin/products            paginated + projected list (?limit=&offset=)
 *   GET    /admin/products/:id        one projected row
 *   POST   /admin/products            create  (fires the onMutation audit hook)
 *   PATCH  /admin/products/:id        update  (fires the onMutation audit hook)
 *   DELETE /admin/products/:id        destroy (fires the onMutation audit hook)
 *   GET    /admin/audit               the audit trail those writes produced
 *
 * `@keel/admin` is a programmatic CRUD backbone, not an HTTP surface — it hands
 * you `list / get / create / update / destroy` over a `@keel/db` Table and
 * leaves transport to the host. This file is that host: it maps each verb to a
 * route, lets the admin own body validation against the resource's Zod schemas
 * (ADR 0005), and translates the package's stable `AdminError` codes into HTTP
 * status codes.
 *
 * The two capabilities under test:
 *   - **Pagination + projection.** `list("products", { limit, offset })` pages by
 *     the primary key and projects each row to `{ id, ...fields }` — the
 *     resource's `fields` allow-list (`name, price, stock`) plus the PK. The
 *     `cost` column is a real, writable column deliberately left OUT of `fields`,
 *     so it never leaves a row: projection, not cosmetics.
 *   - **The `onMutation` audit hook.** Injected once at `createAdmin` time, it
 *     fires *after* every committed create/update/destroy with an
 *     `{ action, actor, resource, id, patch }` event. We wire it to write one row
 *     into the `audit_log` table, so the trail is queryable at `GET /admin/audit`.
 *
 * `buildAdminApp` is the pure routes-over-a-service factory (the unit the test
 * drives); `buildApp` is the boot wiring that stands up the db, the audit sink,
 * the admin service, runs migrations, and seeds the catalog. Built as factories
 * so the handlers close over their dependencies — no module-scoped globals.
 */

import { createAdmin, AdminError } from "@keel/admin";
import type { Admin, AuditEvent } from "@keel/admin";
import { createDb } from "@keel/db";
import type { Db } from "@keel/db";
import { createApp } from "@keel/kernel";
import type { App, KernelDatabase } from "@keel/kernel";
import { keel } from "@keel/web";
import type { Context, Keel, KeelResponse } from "@keel/web";

import {
  auditLog,
  migrations,
  productInsertSchema,
  productUpdateSchema,
  products,
  readAuditLog,
  seedProducts,
  type AuditRow,
} from "./schema";

// `productInsertSchema` / `productUpdateSchema` are the resource's validation
// contract — passed to `createAdmin` below, NOT applied here at the edge.

/** The resource name the admin and the routes both address `products` by. */
const RESOURCE = "products";

// Validation authority: the admin owns it. Each resource carries its own
// `insertSchema` / `updateSchema` (ADR 0005), and `create` / `update` parse the
// body against them before the write, raising the coded `ADMIN_VALIDATION_FAILED`
// on a bad body. So these routes hand the *raw* request body straight to the
// admin and map that one code to a 422 — rather than re-validating at the edge
// with `c.valid`, which would (a) duplicate the schema and (b) throw a `WebError`
// that this app has no boundary to catch (see the README DX finding on the
// missing request error boundary). One validation authority, one error vocabulary.

/**
 * A non-negative integer from a query/path string, or `undefined` when absent or
 * malformed. Guards the seam to `@keel/admin`: a bad `?limit=abc` or `/products/x`
 * must not reach the query as `NaN` (`Number("abc")`), which SQLite rejects with
 * `no such column: NaN`. `undefined` lets `list` fall back to its default page;
 * a bad id resolves to a clean 404.
 */
function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);

  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Map an `AdminError` code to the HTTP status the admin UI branches on. */
function statusForAdminError(error: AdminError): number {
  switch (error.code) {
    case "ADMIN_UNKNOWN_RESOURCE":
    case "ADMIN_RECORD_NOT_FOUND":
      return 404;
    case "ADMIN_VALIDATION_FAILED":
    case "ADMIN_EMPTY_UPDATE":
      return 422;
    // ADMIN_NO_PRIMARY_KEY is a construction-time error — it can never reach a
    // request handler, so it has no per-request status. 500 is the safe default.
    default:
      return 500;
  }
}

/**
 * The routes, closing over the `@keel/admin` service they front. Every handler
 * that can raise an `AdminError` funnels through `respond`, which turns the
 * stable code into a status + a JSON error body — the one place the package's
 * vocabulary meets the transport.
 */
export function buildAdminApp(deps: { admin: Admin; db: Db }): Keel {
  const { admin, db } = deps;

  /** Run an admin op; on an `AdminError`, answer with its mapped status + details. */
  const respond = async (
    c: Context,
    op: () => Promise<unknown>,
    okStatus = 200,
  ): Promise<KeelResponse> => {
    try {
      return c.json(await op(), okStatus);
    } catch (error) {
      if (error instanceof AdminError) {
        return c.json(
          { error: error.code, message: error.message, details: error.details },
          statusForAdminError(error),
        );
      }

      throw error;
    }
  };

  return keel()
    .get("/admin/products", async (c) => {
      // Paging comes off the query string, parsed defensively: a malformed
      // `?limit=abc` becomes `undefined` → `list`'s default page, never `NaN`
      // (which reaches the query as `no such column: NaN`). Absent → page one.
      // Keys are set only when present: `exactOptionalPropertyTypes` rejects an
      // explicit `undefined` for the optional `limit?` / `offset?`.
      const limit = toInt(c.query("limit"));
      const offset = toInt(c.query("offset"));

      const options: { limit?: number; offset?: number } = {};
      if (limit !== undefined) options.limit = limit;
      if (offset !== undefined) options.offset = offset;

      const rows = await admin.list(RESOURCE, options);

      // Echo the effective paging back so a UI can render "showing N, offset M".
      return c.json({ rows, limit: options.limit ?? null, offset: options.offset ?? 0 });
    })
    .get("/admin/products/:id", (c) => {
      const id = toInt(c.param("id"));
      if (id === undefined) return c.json({ error: "ADMIN_RECORD_NOT_FOUND" }, 404);

      return respond(c, () => admin.get(RESOURCE, id));
    })
    .post("/admin/products", (c) => {
      // The actor is carried by the host (a real app reads it off the session);
      // here a header stands in so the audit trail records *who*. The admin layer
      // attributes — it never authenticates — so passing it through is the contract.
      const actor = c.header("x-admin-actor") ?? "anonymous";

      // The raw body goes straight to the admin, which validates it against the
      // resource's `insertSchema` and raises `ADMIN_VALIDATION_FAILED` on a miss.
      return respond(c, () => admin.create(RESOURCE, c.req.body, { actor }), 201);
    })
    .patch("/admin/products/:id", (c) => {
      const id = toInt(c.param("id"));
      if (id === undefined) return c.json({ error: "ADMIN_RECORD_NOT_FOUND" }, 404);

      const actor = c.header("x-admin-actor") ?? "anonymous";

      return respond(c, () => admin.update(RESOURCE, id, c.req.body, { actor }));
    })
    .delete("/admin/products/:id", (c) => {
      const id = toInt(c.param("id"));
      if (id === undefined) return c.json({ error: "ADMIN_RECORD_NOT_FOUND" }, 404);

      const actor = c.header("x-admin-actor") ?? "anonymous";

      return respond(c, async () => {
        await admin.destroy(RESOURCE, id, { actor });

        return { deleted: id };
      });
    })
    .get("/admin/audit", async (c) => {
      const rows: AuditRow[] = await readAuditLog(db);

      return c.json({ rows });
    });
}

/** What `buildApp` returns: the booted app plus the handles run.ts / serve / tests need. */
export interface Booted {
  app: App;
  db: Db;
  admin: Admin;
  seeded: number;
}

export interface BuildOptions {
  /** The kernel database handle (from `@keel/runtime`'s `openSqlite`). */
  handle: KernelDatabase;

  /** Seed the demo catalog after migrate. Defaults to `true`. */
  seed?: boolean;
}

/**
 * The `onMutation` audit hook, closed over the `db` it writes to.
 *
 * `@keel/admin` invokes this *after* each committed write with a structured
 * {@link AuditEvent}. We persist one `audit_log` row per event — stamping `at`
 * (the admin layer reports the change, not the clock) and stringifying `id` +
 * `actor` (a PK may be an int or a slug; an actor is opaque to the admin). The
 * insert is fire-and-forget: the hook's signature is synchronous (`(e) => void`),
 * and a throw would propagate to the caller *after* the write already committed,
 * so we swallow a sink failure rather than fail a succeeded mutation. That trade
 * is a DX finding (see README) — the hook can't await, so an async sink races.
 */
function makeAuditHook(db: Db): (event: AuditEvent) => void {
  return (event: AuditEvent): void => {
    void db
      .insert(auditLog)
      .values({
        action: event.action,
        resource: event.resource,
        recordId: String(event.id),
        actor: String(event.actor),
        at: new Date().toISOString(),
      })
      .run()
      .catch((error: unknown) => {
        // The write already committed; a broken audit sink must not crash the
        // request. A real app routes this to its logger/alerting.
        console.error("[audit] failed to persist mutation event:", error);
      });
  };
}

/**
 * Boot the whole thing: wrap the handle as a typed `Db`, run migrations through
 * the kernel, build the `@keel/admin` service with the audit hook wired in, and
 * seed the catalog so a fresh panel has rows to page through.
 */
export async function buildApp(options: BuildOptions): Promise<Booted> {
  const { handle } = options;
  const db = createDb(handle);

  // Build the admin over the `products` table with its validation + projection
  // contract, and inject the audit hook so every write is recorded.
  const admin = createAdmin(
    db,
    [
      {
        name: RESOURCE,
        table: products,
        insertSchema: productInsertSchema,
        updateSchema: productUpdateSchema,
        // The projection allow-list. `cost` is a real column but absent here, so
        // it never leaves a row through list / get — projection in action.
        fields: ["name", "price", "stock"],
      },
    ],
    { onMutation: makeAuditHook(db) },
  );

  // The kernel runs the table migrations before dispatch is live.
  const app = await createApp({
    db: handle,
    app: buildAdminApp({ admin, db }),
    migrations,
  });

  const seeded = options.seed === false ? 0 : await seedProducts(db);

  return { app, db, admin, seeded };
}

// Re-export the bits the entrypoints (`run.ts`) reach for, so they import from
// one place — the example's own surface, never `@keel/admin`'s internals.
export { readAuditLog } from "./schema";
export type { AuditRow, Product } from "./schema";
