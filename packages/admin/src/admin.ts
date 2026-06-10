/**
 * The admin operations layer.
 *
 *   const admin = createAdmin(db, [
 *     {
 *       name: "posts",
 *       table: posts,
 *       insertSchema: z.object({ title: z.string().min(1), body: z.string() }),
 *       updateSchema: z.object({ title: z.string().min(1).optional(), body: z.string().optional() }),
 *       fields: ["title", "body"],
 *     },
 *   ]);
 *
 *   admin.list("posts");                              // [{ id, title, body }, ...]
 *   admin.create("posts", { title: "Hi", body: "" }); // throws ADMIN_VALIDATION_FAILED
 *
 * Resolves a resource name to its `@keel/db` {@link Table} and projects every
 * row to `{ id, ...declared fields }` — the generic CRUD backbone a
 * WordPress-style admin UI sits on. CRUD reads/writes go through `@keel/db`;
 * input validation goes through each resource's Zod schemas (ADR 0005); this
 * layer owns naming, projection, primary-key resolution, and the not-found /
 * unknown-resource / validation-failed codes.
 *
 * Built as a closure factory matching the rest of the post-ADR-0004 codebase:
 * no `this`, no inheritance, the `db` handle captured in lexical scope.
 */

import { eq } from "@keel/db";
import type { Column, ColumnSpec, Db, Table } from "@keel/db";
import type { ZodType } from "zod";

import { AdminError } from "./errors";

type Record_ = Record<string, unknown>;

/** A resource is one table exposed to the admin plus its validation + projection contract. */
export interface AdminResource<TInsert = unknown, TUpdate = unknown> {
  /** The name the admin URL + API addresses this resource by. */
  readonly name: string;

  /** The `@keel/db` table this resource reads and writes. */
  readonly table: Table;

  /**
   * The Zod schema for `create` input. Validated *before* the row is written;
   * a parse failure surfaces as `ADMIN_VALIDATION_FAILED` carrying the
   * flattened Zod error.
   */
  readonly insertSchema: ZodType<TInsert>;

  /** The Zod schema for `update` input — usually the insert schema with every field optional. */
  readonly updateSchema: ZodType<TUpdate>;

  /** The columns the projection exposes. The allow-list — never widened by accident. */
  readonly fields: readonly string[];
}

/** What `resources()` and `describe()` hand back — schemas and tables stay server-side. */
interface ResourceSummary {
  readonly name: string;
  readonly fields: readonly string[];
}

/** The admin service — an object of functions; build with {@link createAdmin}. */
export interface Admin {
  resources(): ResourceSummary[];
  describe(name: string): ResourceSummary;
  list(name: string): Promise<Record_[]>;
  get(name: string, id: unknown): Promise<Record_>;
  create(name: string, attributes: unknown): Promise<Record_>;
  update(name: string, id: unknown, attributes: unknown): Promise<Record_>;
  destroy(name: string, id: unknown): Promise<void>;
}

/** Internal — what we cache per resource to avoid re-scanning the column list. */
interface ResolvedResource {
  readonly resource: AdminResource;
  readonly primaryKey: Column<unknown, boolean, boolean>;
}

/** Find the primary-key column of a table, or refuse with a coded error. */
function resolvePrimaryKey(resource: AdminResource): Column<unknown, boolean, boolean> {
  const column = resource.table.columnList.find((c) => c.spec.primaryKey);

  if (!column) {
    throw new AdminError(
      "ADMIN_NO_PRIMARY_KEY",
      `Resource "${resource.name}" maps to table "${resource.table.tableName}", which has no primary-key column.`,
      { name: resource.name, table: resource.table.tableName },
    );
  }

  return column;
}

/** A resource without its schemas/table — safe to hand to a client. */
function summarize(resource: AdminResource): ResourceSummary {
  return { name: resource.name, fields: [...resource.fields] };
}

/** Project a row down to `{ id, ...declared fields }` — the allow-list in action. */
function project(resource: AdminResource, row: Record_, pkSpec: ColumnSpec): Record_ {
  // `byColumn` is built from `defineTable` and always contains every column
  // in the table, the primary key included — so the lookup is total.
  const pkKey = resource.table.byColumn[pkSpec.name]!;
  const projected: Record_ = { id: row[pkKey] };

  for (const field of resource.fields) {
    projected[field] = row[field];
  }

  return projected;
}

/** Validate `attributes` against `schema`, or throw a coded validation error. */
function validate<T>(resourceName: string, schema: ZodType<T>, attributes: unknown): T {
  const parsed = schema.safeParse(attributes);

  if (!parsed.success) {
    throw new AdminError("ADMIN_VALIDATION_FAILED", `Validation failed for ${resourceName}.`, {
      name: resourceName,
      issues: parsed.error.flatten(),
    });
  }

  return parsed.data;
}

export function createAdmin(db: Db, resources: readonly AdminResource[]): Admin {
  // Resolve every resource's primary-key column up front. A missing PK fails
  // *now*, not on the first request — startup-time errors are cheaper to fix.
  const byName = new Map<string, ResolvedResource>(
    resources.map((resource) => [
      resource.name,
      { resource, primaryKey: resolvePrimaryKey(resource) },
    ]),
  );

  const resolve = (name: string): ResolvedResource => {
    const entry = byName.get(name);

    if (!entry) {
      throw new AdminError("ADMIN_UNKNOWN_RESOURCE", `No admin resource named "${name}".`, {
        name,
      });
    }

    return entry;
  };

  const fetchRow = async (entry: ResolvedResource, id: unknown): Promise<Record_> => {
    const row = await db
      .select()
      .from(entry.resource.table)
      .where(eq(entry.primaryKey, id as never))
      .get();

    if (!row) {
      throw new AdminError(
        "ADMIN_RECORD_NOT_FOUND",
        `No ${entry.resource.name} record with ${entry.primaryKey.spec.name}=${String(id)}.`,
        { name: entry.resource.name, id },
      );
    }

    return row as Record_;
  };

  return {
    resources(): ResourceSummary[] {
      return [...byName.values()].map((entry) => summarize(entry.resource));
    },

    describe(name) {
      return summarize(resolve(name).resource);
    },

    async list(name) {
      const entry = resolve(name);
      const rows = (await db.select().from(entry.resource.table).all()) as Record_[];

      return rows.map((row) => project(entry.resource, row, entry.primaryKey.spec));
    },

    async get(name, id) {
      const entry = resolve(name);

      return project(entry.resource, await fetchRow(entry, id), entry.primaryKey.spec);
    },

    async create(name, attributes) {
      const entry = resolve(name);
      // Validation is sync and runs BEFORE the awaited write.
      const data = validate(name, entry.resource.insertSchema, attributes);

      const row = (await db
        .insert(entry.resource.table)
        .values(data as never)
        .returning()
        .get()) as Record_;

      return project(entry.resource, row, entry.primaryKey.spec);
    },

    async update(name, id, attributes) {
      const entry = resolve(name);
      // Validation is sync and runs BEFORE the awaited write.
      const data = validate(name, entry.resource.updateSchema, attributes);

      // Confirm the row exists *before* the update — gives us the
      // not-found code instead of a silently-zero-rows-affected update.
      await fetchRow(entry, id);

      await db
        .update(entry.resource.table)
        .set(data as never)
        .where(eq(entry.primaryKey, id as never))
        .run();

      // Re-read so the projection reflects the merged state, not the patch.
      return project(entry.resource, await fetchRow(entry, id), entry.primaryKey.spec);
    },

    async destroy(name, id) {
      const entry = resolve(name);

      // Same pre-check as update — the not-found code is more useful than
      // a quiet zero-changes delete.
      await fetchRow(entry, id);

      await db
        .delete(entry.resource.table)
        .where(eq(entry.primaryKey, id as never))
        .run();
    },
  };
}
