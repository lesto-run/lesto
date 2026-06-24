/**
 * The admin operations layer.
 *
 *   const admin = createAdmin(
 *     db,
 *     [
 *       {
 *         name: "posts",
 *         table: posts,
 *         insertSchema: z.object({ title: z.string().min(1), body: z.string() }),
 *         updateSchema: z.object({ title: z.string().min(1).optional(), body: z.string().optional() }),
 *         fields: ["title", "body"],
 *         permissions: { read: "posts:read", create: "posts:write", update: "posts:write", destroy: "posts:write" },
 *       },
 *     ],
 *     { policy }, // a @lesto/authz Policy — or { ungoverned: true } to opt out loudly
 *   );
 *
 *   admin.list("posts", undefined, principal);        // page 1 — checks "posts:read"
 *   admin.list("posts", { limit: 10, offset: 10 }, principal); // page 2
 *   admin.create("posts", { title: "Hi", body: "" }, principal); // gated, then ADMIN_VALIDATION_FAILED
 *
 *   // Opt into an audit trail by injecting a hook at construction:
 *   const admin = createAdmin(db, [postsResource], {
 *     policy,
 *     onMutation: (e) => log.info("audit", e), // { action, actor, resource, id, patch }
 *   });
 *   admin.create("posts", attrs, principal); // principal = getPrincipal(c) = { actor, actorRoles }
 *
 * Resolves a resource name to its `@lesto/db` {@link Table} and projects every
 * row to `{ id, ...declared fields }` — the generic CRUD backbone a
 * WordPress-style admin UI sits on. CRUD reads/writes go through `@lesto/db`;
 * input validation goes through each resource's Zod schemas (ADR 0005); this
 * layer owns naming, projection (the per-resource allow-list), `list`
 * pagination, primary-key resolution, an optional post-write audit hook, and
 * the not-found / unknown-resource / validation-failed / empty-update codes.
 *
 * Built as a closure factory matching the rest of the post-ADR-0004 codebase:
 * no `this`, no inheritance, the `db` handle captured in lexical scope.
 */

import { DbError, eq } from "@lesto/db";
import type { Column, ColumnSpec, Db, Table } from "@lesto/db";
import type { Policy } from "@lesto/authz";
import type { ZodType } from "zod";

import { AdminError } from "./errors";

type Record_ = Record<string, unknown>;

/** The default `list()` page size when the caller passes no `limit`. */
const DEFAULT_PAGE_SIZE = 50;

/** Every verb the admin gates — the three writes plus the two reads. */
type Verb = "list" | "get" | MutationAction;

/** Which {@link ResourcePermissions} key each verb is gated by (`list`/`get` share `read`). */
const PERMISSION_OF: Record<Verb, keyof ResourcePermissions> = {
  list: "read",
  get: "read",
  create: "create",
  update: "update",
  destroy: "destroy",
};

/** The mutating verbs — the ones a governed write-attribution check applies to. */
const WRITES: ReadonlySet<Verb> = new Set<Verb>(["create", "update", "destroy"]);

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

/**
 * Per-call context threaded through every verb — the resolved principal.
 *
 * Both fields come from the `@lesto/authz` principal resolver (the *sole* source,
 * ADR 0028 Phase 1): the caller reads `getPrincipal(c)` and hands the `{ actor,
 * actorRoles }` straight in. `actor` is attribution (who) — passed onto the
 * {@link AuditEvent}; `actorRoles` is authorization (what they may do) — the input
 * to the per-verb policy check. The admin layer attributes and gates; it does not
 * authenticate or invent identity.
 */
export interface MutationContext {
  /**
   * Who is performing the operation. Passed onto the {@link AuditEvent}; a
   * governed *write* with no actor is refused as unattributed.
   */
  readonly actor?: unknown;

  /** The roles the actor holds — checked against the resource's declared permission. */
  readonly actorRoles?: readonly string[];
}

/**
 * The authorization policy gating every admin verb — or `{ ungoverned: true }`,
 * the single, loud, greppable opt-out.
 *
 * There is deliberately no "absent policy ⇒ open" path: a host either hands
 * {@link createAdmin} a real {@link Policy} (governed — every verb is checked) or
 * names the opt-out explicitly, so an admin is never *silently* fail-open. The
 * policy is a plain `@lesto/authz` value the app builds with `definePolicy`; this
 * package type-imports the contract only and never touches `@lesto/web`.
 */
export type AdminPolicy = Policy<string, string> | { readonly ungoverned: true };

/** Construction-time options for {@link createAdmin}. */
export interface AdminOptions {
  /**
   * The authorization policy every verb is gated by — **required**. Pass a
   * `@lesto/authz` {@link Policy}, or `{ ungoverned: true }` to opt out loudly.
   * There is no default: omitting it is a type error, not a silent fail-open.
   */
  readonly policy: AdminPolicy;

  /**
   * Optional audit hook, invoked once *after* each successful mutation
   * (create / update / destroy). Injected — absent by default — so a host that
   * wants an audit trail wires one in, and one that does not pays nothing. A
   * throw from the hook propagates to the caller (the write has already
   * committed); keep it cheap and total, or swallow inside the hook.
   */
  readonly onMutation?: (event: AuditEvent) => void;
}

/**
 * The permission each gated verb requires on a governed {@link AdminResource} —
 * one `@lesto/authz` permission string per verb (`list` and `get` share `read`).
 *
 * Every key is optional, and a verb a resource declares *no* permission for is
 * denied under a governed policy (governance is opt-in per verb, fail-closed). The
 * whole field is ignored when the admin is constructed `{ ungoverned: true }`.
 */
export interface ResourcePermissions {
  /** The permission `list` and `get` require — the two read verbs. */
  readonly read?: string;

  /** The permission `create` requires. */
  readonly create?: string;

  /** The permission `update` requires. */
  readonly update?: string;

  /** The permission `destroy` requires. */
  readonly destroy?: string;
}

/** A resource is one table exposed to the admin plus its validation + projection contract. */
export interface AdminResource<TInsert = unknown, TUpdate = unknown> {
  /** The name the admin URL + API addresses this resource by. */
  readonly name: string;

  /**
   * The per-verb permissions this resource is gated by under a governed policy.
   * Optional; an undeclared verb is denied when governed, and the whole field is
   * irrelevant under `{ ungoverned: true }`.
   */
  readonly permissions?: ResourcePermissions;

  /** The `@lesto/db` table this resource reads and writes. */
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
   *
   * Under a governed policy the `read` permission is checked against
   * `context.actorRoles` first; pass the resolved principal to authorize the read.
   */
  list(name: string, options?: ListOptions, context?: MutationContext): Promise<Record_[]>;

  get(name: string, id: unknown, context?: MutationContext): Promise<Record_>;
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
  options: AdminOptions,
): Admin {
  const { onMutation, policy } = options;

  // Governed unless the caller named the loud opt-out. `governedPolicy` is the
  // single gate source: `undefined` ⇒ ungoverned (no checks, legacy behavior);
  // otherwise every verb is authorized against it. There is no third "no policy"
  // state — `options.policy` is required — so the admin can never be silently open.
  const governedPolicy: Policy<string, string> | undefined =
    "ungoverned" in policy ? undefined : policy;

  // Resolve every resource's primary-key column up front. A missing PK fails
  // *now*, not on the first request — startup-time errors are cheaper to fix.
  const byName = new Map<string, ResolvedResource>(
    resources.map((resource) => [
      resource.name,
      { resource, primaryKey: resolvePrimaryKey(resource) },
    ]),
  );

  // Gate one verb under the governed policy, BEFORE validation or any db touch —
  // an unauthorized caller learns nothing about the input or whether the row
  // exists. A no-op when ungoverned. Three fail-closed rules, in order: a governed
  // write needs a resolved actor; an undeclared verb is denied; otherwise the
  // actor's roles must grant the resource's declared permission.
  const authorize = (
    entry: ResolvedResource,
    verb: Verb,
    context: MutationContext | undefined,
  ): void => {
    if (governedPolicy === undefined) return;

    const permission = entry.resource.permissions?.[PERMISSION_OF[verb]];

    // The principal resolver is the SOLE actor source (ADR 0028 Phase 1): a
    // governed write with no resolved actor is refused outright — no caller-supplied
    // identity is honored, and an unattributed write never reaches the audit hook.
    if (WRITES.has(verb) && context?.actor === undefined) {
      throw new AdminError(
        "ADMIN_FORBIDDEN",
        `Refusing an unattributed ${verb} on "${entry.resource.name}": a governed write needs a resolved actor.`,
        { resource: entry.resource.name, action: verb, permission, reason: "unattributed" },
      );
    }

    // A verb the resource declares no permission for fails closed — governance is
    // opt-in per verb, never open-by-omission.
    if (permission === undefined) {
      throw new AdminError(
        "ADMIN_FORBIDDEN",
        `Resource "${entry.resource.name}" declares no permission for ${verb}; denied under a governed policy.`,
        { resource: entry.resource.name, action: verb, permission: undefined },
      );
    }

    // The policy decision: does some role the actor holds grant the permission?
    if (!governedPolicy.allows(context?.actorRoles, permission)) {
      throw new AdminError(
        "ADMIN_FORBIDDEN",
        `${verb} on "${entry.resource.name}" requires "${permission}", which the actor's roles do not grant.`,
        { resource: entry.resource.name, action: verb, permission },
      );
    }
  };

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

    async list(name, listOptions = {}, context) {
      const entry = resolve(name);
      authorize(entry, "list", context);
      const limit = listOptions.limit ?? DEFAULT_PAGE_SIZE;
      const offset = listOptions.offset ?? 0;

      // Order by the primary key so paging is stable across calls — without a
      // deterministic order, `offset` would skip arbitrary rows. @lesto/db
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

    async get(name, id, context) {
      const entry = resolve(name);
      authorize(entry, "get", context);

      return project(entry.resource, await fetchRow(entry, id), entry.primaryKey.spec);
    },

    async create(name, attributes, context) {
      const entry = resolve(name);
      authorize(entry, "create", context);
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
      authorize(entry, "update", context);
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
        // @lesto/db as `DB_EMPTY_UPDATE`. Re-code it to the admin's own stable
        // code so callers (the admin UI, the API) branch on one vocabulary and
        // never see a leaked @lesto/db code; chain the original as the cause.
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
      authorize(entry, "destroy", context);

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
