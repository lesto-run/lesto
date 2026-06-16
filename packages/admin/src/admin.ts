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
 *   admin.list("posts");                              // page 1 — [{ id, title, body }, ...]
 *   admin.list("posts", { limit: 10, offset: 10 });   // page 2
 *   admin.create("posts", { title: "Hi", body: "" }); // throws ADMIN_VALIDATION_FAILED
 *
 *   // Opt into an audit trail by injecting a hook at construction:
 *   const admin = createAdmin(db, [postsResource], {
 *     onMutation: (e) => log.info("audit", e), // { action, actor, resource, id, patch }
 *   });
 *   admin.create("posts", attrs, { actor: currentUser });
 *
 * Resolves a resource name to its `@keel/db` {@link Table} and projects every
 * row to `{ id, ...declared fields }` — the generic CRUD backbone a
 * WordPress-style admin UI sits on. CRUD reads/writes go through `@keel/db`;
 * input validation goes through each resource's Zod schemas (ADR 0005); this
 * layer owns naming, projection (the per-resource allow-list), `list`
 * pagination, primary-key resolution, an optional post-write audit hook, and
 * the not-found / unknown-resource / validation-failed / empty-update codes.
 *
 * Built as a closure factory matching the rest of the post-ADR-0004 codebase:
 * no `this`, no inheritance, the `db` handle captured in lexical scope.
 */

import { DbError, eq } from "@keel/db";
import type { Column, ColumnSpec, Db, Table } from "@keel/db";
import type { ZodType } from "zod";

import { AdminError } from "./errors";

type Record_ = Record<string, unknown>;

/** The default `list()` page size when the caller passes no `limit`. */
const DEFAULT_PAGE_SIZE = 50;

/** Paging knobs for {@link Admin.list}: a row cap and a skip count. */
export interface ListOptions {
  /** Cap the rows returned. Defaults to {@link DEFAULT_PAGE_SIZE} (50). */
  readonly limit?: number;

  /** Skip this many rows before the first returned. Defaults to `0`. */
  readonly offset?: number;
}

/** The verbs an {@link AuditEvent} reports — the three writes the admin can make. */
export type MutationAction = "create" | "update" | "destroy";

/**
 * One audit record, handed to {@link AdminOptions.onMutation} *after* a write
 * commits. The payload is everything an audit log needs to answer "who changed
 * what": the `actor` (carried by the caller — the admin layer never invents
 * identity), the `resource` name, the affected row `id`, and the `patch` that
 * was applied (the validated attributes for create/update; `undefined` for a
 * destroy, which has no patch).
 */
export interface AuditEvent {
  /** The verb that ran. */
  readonly action: MutationAction;

  /** Who performed the mutation, as supplied by the caller (`undefined` if unattributed). */
  readonly actor: unknown;

  /** The admin resource name the mutation targeted. */
  readonly resource: string;

  /** The primary-key value of the affected row. */
  readonly id: unknown;

  /** The validated attributes written (create/update); `undefined` for destroy. */
  readonly patch: Record_ | undefined;
}

/** Per-call context threaded through a mutation — today, just the audit actor. */
export interface MutationContext {
  /**
   * Who is performing the write. Passed straight through onto the
   * {@link AuditEvent}; the admin layer attributes, it does not authenticate.
   */
  readonly actor?: unknown;
}

/** Construction-time options for {@link createAdmin}. */
export interface AdminOptions {
  /**
   * Optional audit hook, invoked once *after* each successful mutation
   * (create / update / destroy). Injected — absent by default — so a host that
   * wants an audit trail wires one in, and one that does not pays nothing. A
   * throw from the hook propagates to the caller (the write has already
   * committed); keep it cheap and total, or swallow inside the hook.
   */
  readonly onMutation?: (event: AuditEvent) => void;
}

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

  /**
   * The projected rows for a resource — `{ id, ...declared fields }` each,
   * paginated. `options.limit` defaults to a sensible page size (50); pass
   * `offset` to page through. Projection is the per-resource `fields`
   * allow-list plus the primary key — undeclared columns never leave the row.
   */
  list(name: string, options?: ListOptions): Promise<Record_[]>;

  get(name: string, id: unknown): Promise<Record_>;
  create(name: string, attributes: unknown, context?: MutationContext): Promise<Record_>;
  update(
    name: string,
    id: unknown,
    attributes: unknown,
    context?: MutationContext,
  ): Promise<Record_>;
  destroy(name: string, id: unknown, context?: MutationContext): Promise<void>;
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

export function createAdmin(
  db: Db,
  resources: readonly AdminResource[],
  options: AdminOptions = {},
): Admin {
  const { onMutation } = options;

  // Resolve every resource's primary-key column up front. A missing PK fails
  // *now*, not on the first request — startup-time errors are cheaper to fix.
  const byName = new Map<string, ResolvedResource>(
    resources.map((resource) => [
      resource.name,
      { resource, primaryKey: resolvePrimaryKey(resource) },
    ]),
  );

  // Emit an audit event for a committed write. A no-op when no hook is
  // injected, so the un-audited path stays free.
  const audit = (
    action: MutationAction,
    entry: ResolvedResource,
    id: unknown,
    patch: Record_ | undefined,
    context: MutationContext | undefined,
  ): void => {
    onMutation?.({
      action,
      actor: context?.actor,
      resource: entry.resource.name,
      id,
      patch,
    });
  };

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

    async list(name, listOptions = {}) {
      const entry = resolve(name);
      const limit = listOptions.limit ?? DEFAULT_PAGE_SIZE;
      const offset = listOptions.offset ?? 0;

      // Order by the primary key so paging is stable across calls — without a
      // deterministic order, `offset` would skip arbitrary rows. @keel/db
      // always selects `*`; the column allow-list is applied here in `project`.
      const rows = (await db
        .select()
        .from(entry.resource.table)
        .orderBy(entry.primaryKey)
        .limit(limit)
        .offset(offset)
        .all()) as Record_[];

      return rows.map((row) => project(entry.resource, row, entry.primaryKey.spec));
    },

    async get(name, id) {
      const entry = resolve(name);

      return project(entry.resource, await fetchRow(entry, id), entry.primaryKey.spec);
    },

    async create(name, attributes, context) {
      const entry = resolve(name);
      // Validation is sync and runs BEFORE the awaited write.
      const data = validate(name, entry.resource.insertSchema, attributes);

      const row = (await db
        .insert(entry.resource.table)
        .values(data as never)
        .returning()
        .get()) as Record_;

      const projected = project(entry.resource, row, entry.primaryKey.spec);

      audit("create", entry, projected["id"], data as Record_, context);

      return projected;
    },

    async update(name, id, attributes, context) {
      const entry = resolve(name);
      // Validation is sync and runs BEFORE the awaited write.
      const data = validate(name, entry.resource.updateSchema, attributes);

      // Confirm the row exists *before* the update — gives us the
      // not-found code instead of a silently-zero-rows-affected update.
      await fetchRow(entry, id);

      try {
        await db
          .update(entry.resource.table)
          .set(data as never)
          .where(eq(entry.primaryKey, id as never))
          .run();
      } catch (error) {
        // An update whose validated patch sets no known column reaches
        // @keel/db as `DB_EMPTY_UPDATE`. Re-code it to the admin's own stable
        // code so callers (the admin UI, the API) branch on one vocabulary and
        // never see a leaked @keel/db code; chain the original as the cause.
        if (error instanceof DbError && error.code === "DB_EMPTY_UPDATE") {
          throw new AdminError(
            "ADMIN_EMPTY_UPDATE",
            `Update of ${entry.resource.name} ${entry.primaryKey.spec.name}=${String(id)} set no fields. Supply at least one declared field.`,
            { name: entry.resource.name, id, cause: error.code },
          );
        }

        throw error;
      }

      // Re-read so the projection reflects the merged state, not the patch.
      const projected = project(entry.resource, await fetchRow(entry, id), entry.primaryKey.spec);

      audit("update", entry, id, data as Record_, context);

      return projected;
    },

    async destroy(name, id, context) {
      const entry = resolve(name);

      // Same pre-check as update — the not-found code is more useful than
      // a quiet zero-changes delete.
      await fetchRow(entry, id);

      await db
        .delete(entry.resource.table)
        .where(eq(entry.primaryKey, id as never))
        .run();

      // A destroy has no patch to report.
      audit("destroy", entry, id, undefined, context);
    },
  };
}
