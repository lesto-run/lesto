import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createDb,
  createTableSql,
  defineTable,
  integer,
  text,
  type Db,
  type SqlDatabase,
} from "@lesto/db";

import { definePolicy } from "@lesto/authz/policy";

import { AdminError, createAdmin } from "../src/index";

import type {
  Admin,
  AdminErrorCode,
  AdminOptions,
  AdminPolicy,
  AdminResource,
  AuditEvent,
} from "../src/index";

// The loud opt-out: the existing behavioral suite is authorization-agnostic, so it
// runs ungoverned. The `describe("governance")` block at the bottom exercises a real
// policy. `as const` keeps the `{ ungoverned: true }` literal in the policy union.
const UNGOVERNED = { ungoverned: true } as const;

// ---------------------------------------------------------------------------
// Test rig
//
// One in-memory SQLite per test, wrapped in @lesto/db. A small fixture table
// `posts` with a "secret" column the allow-list must hide. The @lesto/db
// terminals are async (ADR 0006): the synchronous better-sqlite3 engine is
// wrapped so each terminal resolves a Promise (zero latency); prepare() stays
// sync, and `transaction()` brackets BEGIN/COMMIT over the single connection.
// ---------------------------------------------------------------------------

function adapt(raw: Database.Database): SqlDatabase {
  const adapted: SqlDatabase = {
    exec: async (statement) => {
      raw.exec(statement);
    },
    prepare: (statement) => {
      const stmt = raw.prepare(statement);

      return {
        run: async (params: unknown[] = []) => stmt.run(...(params as never[])),
        get: async (params: unknown[] = []) => stmt.get(...(params as never[])),
        all: async (params: unknown[] = []) => stmt.all(...(params as never[])),
      };
    },
    transaction: async (fn) => {
      raw.exec("BEGIN");

      try {
        const out = await fn(adapted);
        raw.exec("COMMIT");

        return out;
      } catch (error) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* preserve the original error */
        }

        throw error;
      }
    },
  };

  return adapted;
}

const posts = defineTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  secret: text("secret"),
});

const insertSchema = z.object({
  title: z.string().min(1, "Title is required."),
  body: z.string(),
  secret: z.string().optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  secret: z.string().optional(),
});

const postsResource: AdminResource = {
  name: "posts",
  table: posts,
  insertSchema,
  updateSchema,
  fields: ["title", "body"],
};

let raw: Database.Database;
let db: Db;
let admin: Admin;

beforeEach(async () => {
  raw = new Database(":memory:");
  const sql = adapt(raw);
  db = createDb(sql);
  await db.exec(createTableSql(posts));

  admin = createAdmin(db, [postsResource], { policy: UNGOVERNED });
});

afterEach(() => {
  raw.close();
});

/**
 * Assert the operation fails with an AdminError carrying the expected stable
 * code. `run` may throw synchronously (e.g. the `createAdmin` constructor) or
 * reject (the async CRUD terminals) — `await` collapses both into one path.
 */
async function expectCode(run: () => unknown, code: AdminErrorCode): Promise<void> {
  try {
    await run();
    expect.unreachable("expected an AdminError to be thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(AdminError);
    expect((error as AdminError).code).toBe(code);
  }
}

describe("createAdmin", () => {
  describe("resources", () => {
    it("summarizes every resource as name + fields, without table/schemas", () => {
      expect(admin.resources()).toEqual([{ name: "posts", fields: ["title", "body"] }]);
    });
  });

  describe("describe", () => {
    it("summarizes a known resource", () => {
      expect(admin.describe("posts")).toEqual({ name: "posts", fields: ["title", "body"] });
    });

    it("throws ADMIN_UNKNOWN_RESOURCE for an unknown resource", async () => {
      await expectCode(() => admin.describe("widgets"), "ADMIN_UNKNOWN_RESOURCE");
    });
  });

  describe("list", () => {
    it("projects each row to id + declared fields only (secret never leaks)", async () => {
      await admin.create("posts", { title: "First", body: "one", secret: "hidden" });
      await admin.create("posts", { title: "Second", body: "two", secret: "nope" });

      const rows = await admin.list("posts");

      expect(rows).toEqual([
        { id: 1, title: "First", body: "one" },
        { id: 2, title: "Second", body: "two" },
      ]);
      expect(Object.keys(rows[0]!)).toEqual(["id", "title", "body"]);
      expect(rows[0]).not.toHaveProperty("secret");
    });

    it("paginates with limit + offset, ordered by the primary key", async () => {
      for (let i = 1; i <= 5; i++) {
        await admin.create("posts", { title: `Post ${i}`, body: `body ${i}` });
      }

      const page1 = await admin.list("posts", { limit: 2, offset: 0 });
      const page2 = await admin.list("posts", { limit: 2, offset: 2 });
      const page3 = await admin.list("posts", { limit: 2, offset: 4 });

      expect(page1.map((r) => r["id"])).toEqual([1, 2]);
      expect(page2.map((r) => r["id"])).toEqual([3, 4]);
      expect(page3.map((r) => r["id"])).toEqual([5]);
    });

    it("applies offset alone (limit falls back to the default page size)", async () => {
      for (let i = 1; i <= 3; i++) {
        await admin.create("posts", { title: `Post ${i}`, body: "b" });
      }

      const rows = await admin.list("posts", { offset: 1 });

      expect(rows.map((r) => r["id"])).toEqual([2, 3]);
    });

    it("caps rows at the default page size (50) when no limit is given", async () => {
      for (let i = 1; i <= 51; i++) {
        await admin.create("posts", { title: `Post ${i}`, body: "b" });
      }

      const rows = await admin.list("posts");

      expect(rows).toHaveLength(50);
      expect(rows.at(-1)?.["id"]).toBe(50);
    });

    it("still hides undeclared columns on a paginated page", async () => {
      await admin.create("posts", { title: "First", body: "one", secret: "hidden" });

      const rows = await admin.list("posts", { limit: 1, offset: 0 });

      expect(rows[0]).toEqual({ id: 1, title: "First", body: "one" });
      expect(rows[0]).not.toHaveProperty("secret");
    });
  });

  describe("get", () => {
    it("returns the projection of a found row", async () => {
      const created = await admin.create("posts", { title: "Hello", body: "world", secret: "x" });

      expect(await admin.get("posts", created["id"])).toEqual({
        id: 1,
        title: "Hello",
        body: "world",
      });
    });

    it("throws ADMIN_RECORD_NOT_FOUND when absent", async () => {
      await expectCode(() => admin.get("posts", 999), "ADMIN_RECORD_NOT_FOUND");
    });
  });

  describe("create", () => {
    it("validates, persists, and returns the projection", async () => {
      const created = await admin.create("posts", { title: "New", body: "fresh", secret: "s" });

      expect(created).toEqual({ id: 1, title: "New", body: "fresh" });
      expect(await admin.get("posts", 1)).toEqual({ id: 1, title: "New", body: "fresh" });
    });

    it("throws ADMIN_VALIDATION_FAILED with flattened Zod issues on a bad title", async () => {
      try {
        await admin.create("posts", { title: "", body: "ok" });
        expect.unreachable("expected an AdminError");
      } catch (error) {
        const adminError = error as AdminError;

        expect(adminError.code).toBe("ADMIN_VALIDATION_FAILED");

        const issues = adminError.details["issues"] as { fieldErrors: Record<string, string[]> };

        expect(issues.fieldErrors["title"]).toContain("Title is required.");
      }
    });

    it("throws ADMIN_VALIDATION_FAILED for a wholly missing required field", async () => {
      await expectCode(() => admin.create("posts", { title: "ok" }), "ADMIN_VALIDATION_FAILED");
    });
  });

  describe("update", () => {
    it("validates, mutates, and returns the merged projection", async () => {
      await admin.create("posts", { title: "Old", body: "stale", secret: "s" });

      const updated = await admin.update("posts", 1, { title: "Updated" });

      // `body` is untouched; `title` is the patched value.
      expect(updated).toEqual({ id: 1, title: "Updated", body: "stale" });
    });

    it("throws ADMIN_RECORD_NOT_FOUND when absent — BEFORE running the SQL update", async () => {
      await expectCode(() => admin.update("posts", 999, { title: "x" }), "ADMIN_RECORD_NOT_FOUND");
    });

    it("throws ADMIN_VALIDATION_FAILED on an invalid patch", async () => {
      await admin.create("posts", { title: "Real", body: "ok" });

      await expectCode(() => admin.update("posts", 1, { title: "" }), "ADMIN_VALIDATION_FAILED");
    });

    it("maps @lesto/db's DB_EMPTY_UPDATE to ADMIN_EMPTY_UPDATE for an empty patch", async () => {
      // The update schema makes every field optional, so `{}` passes
      // validation; @lesto/db then refuses the no-column UPDATE with
      // DB_EMPTY_UPDATE, which the admin re-codes to its own stable code.
      await admin.create("posts", { title: "Real", body: "ok" });

      try {
        await admin.update("posts", 1, {});
        expect.unreachable("expected an AdminError");
      } catch (error) {
        const adminError = error as AdminError;

        expect(adminError.code).toBe("ADMIN_EMPTY_UPDATE");
        expect(adminError.details["cause"]).toBe("DB_EMPTY_UPDATE");
      }
    });

    it("re-throws a non-empty-update db error unchanged", async () => {
      // The catch around the UPDATE only re-codes DB_EMPTY_UPDATE; every other
      // failure must propagate verbatim. We drive that with a stub Db whose
      // pre-check SELECT succeeds (so we reach the UPDATE) but whose UPDATE run
      // rejects with a plain driver error.
      const boom = new Error("driver exploded");
      const stubDb = {
        select: () => ({
          from: () => ({
            where: () => ({ get: async () => ({ id: 1, title: "Real", body: "ok" }) }),
          }),
        }),
        update: () => ({
          set: () => ({
            where: () => ({
              run: async () => {
                throw boom;
              },
            }),
          }),
        }),
      } as unknown as Db;

      const stubAdmin = createAdmin(stubDb, [postsResource], { policy: UNGOVERNED });

      await expect(stubAdmin.update("posts", 1, { title: "x" })).rejects.toBe(boom);
    });
  });

  describe("destroy", () => {
    it("deletes a found row", async () => {
      await admin.create("posts", { title: "Doomed", body: "gone" });

      await admin.destroy("posts", 1);

      expect(await admin.list("posts")).toHaveLength(0);
    });

    it("throws ADMIN_RECORD_NOT_FOUND when absent", async () => {
      await expectCode(() => admin.destroy("posts", 999), "ADMIN_RECORD_NOT_FOUND");
    });
  });

  describe("primary-key resolution", () => {
    it("refuses a resource whose table has no primary-key column at construction time", async () => {
      const noPk = defineTable("no_pk", {
        name: text("name").notNull(),
      });

      await expectCode(
        () =>
          createAdmin(
            db,
            [
              {
                name: "broken",
                table: noPk,
                insertSchema: z.object({ name: z.string() }),
                updateSchema: z.object({ name: z.string().optional() }),
                fields: ["name"],
              },
            ],
            { policy: UNGOVERNED },
          ),
        "ADMIN_NO_PRIMARY_KEY",
      );
    });

    it("works with a non-`id` primary key (slug)", async () => {
      const slugTable = defineTable("by_slug", {
        slug: text("slug").primaryKey(),
        body: text("body").notNull(),
      });
      await db.exec(createTableSql(slugTable));

      const slugAdmin = createAdmin(
        db,
        [
          {
            name: "by_slug",
            table: slugTable,
            insertSchema: z.object({ slug: z.string(), body: z.string() }),
            updateSchema: z.object({ body: z.string().optional() }),
            fields: ["body"],
          },
        ],
        { policy: UNGOVERNED },
      );

      await slugAdmin.create("by_slug", { slug: "hello", body: "world" });

      expect(await slugAdmin.get("by_slug", "hello")).toEqual({ id: "hello", body: "world" });
    });
  });

  describe("onMutation audit hook", () => {
    it("does not require a hook — mutations run with none injected", async () => {
      // The default `admin` from beforeEach is built WITHOUT an onMutation hook;
      // the create/update/destroy below must each complete cleanly.
      const created = await admin.create("posts", { title: "Quiet", body: "b" });
      await admin.update("posts", created["id"], { title: "Hushed" });

      await expect(admin.destroy("posts", created["id"])).resolves.toBeUndefined();
    });

    it("emits create/update/destroy events with actor, resource, id, and patch", async () => {
      const events: AuditEvent[] = [];
      const audited = createAdmin(db, [postsResource], {
        policy: UNGOVERNED,
        onMutation: (event) => events.push(event),
      });

      const actor = { id: "u-1", email: "ada@example.com" };

      const created = await audited.create(
        "posts",
        { title: "New", body: "fresh", secret: "s" },
        { actor },
      );
      await audited.update("posts", created["id"], { title: "Edited" }, { actor });
      await audited.destroy("posts", created["id"], { actor });

      expect(events).toEqual([
        {
          action: "create",
          actor,
          resource: "posts",
          id: 1,
          // The patch is the VALIDATED attributes — `secret` was accepted by
          // the insert schema even though projection hides it.
          patch: { title: "New", body: "fresh", secret: "s" },
        },
        { action: "update", actor, resource: "posts", id: 1, patch: { title: "Edited" } },
        { action: "destroy", actor, resource: "posts", id: 1, patch: undefined },
      ]);
    });

    it("reports an undefined actor when no context is passed", async () => {
      const events: AuditEvent[] = [];
      const audited = createAdmin(db, [postsResource], {
        policy: UNGOVERNED,
        onMutation: (event) => events.push(event),
      });

      await audited.create("posts", { title: "Anon", body: "b" });

      expect(events[0]).toMatchObject({ action: "create", actor: undefined, resource: "posts" });
    });

    it("does NOT emit when a mutation fails (validation rejects before the write)", async () => {
      const events: AuditEvent[] = [];
      const audited = createAdmin(db, [postsResource], {
        policy: UNGOVERNED,
        onMutation: (event) => events.push(event),
      });

      await expectCode(() => audited.create("posts", { title: "" }), "ADMIN_VALIDATION_FAILED");

      expect(events).toHaveLength(0);
    });
  });

  describe("AdminError", () => {
    it("carries a stable code and frozen details", () => {
      try {
        admin.describe("widgets");
        expect.unreachable("expected an AdminError");
      } catch (error) {
        const adminError = error as AdminError;

        expect(adminError.name).toBe("AdminError");
        expect(adminError.details).toEqual({ name: "widgets" });
        expect(Object.isFrozen(adminError.details)).toBe(true);
      }
    });
  });

  describe("governance (per-verb authz gating)", () => {
    const policy = definePolicy({
      roles: ["viewer", "editor", "admin"],
      can: {
        "posts:read": ["viewer", "editor", "admin"],
        "posts:create": ["editor", "admin"],
        "posts:update": ["editor", "admin"],
        "posts:destroy": ["admin"],
      },
    });

    // The same fixture resource, now declaring a permission per verb.
    const governedResource: AdminResource = {
      ...postsResource,
      permissions: {
        read: "posts:read",
        create: "posts:create",
        update: "posts:update",
        destroy: "posts:destroy",
      },
    };

    // Principals as the resolver would hand them in: `{ actor, actorRoles }`.
    const viewer = { actor: "u-viewer", actorRoles: ["viewer"] };
    const editor = { actor: "u-editor", actorRoles: ["editor"] };
    const operator = { actor: "u-admin", actorRoles: ["admin"] };

    let governed: Admin;

    beforeEach(() => {
      governed = createAdmin(db, [governedResource], { policy });
    });

    it("allows list + get when the actor's roles grant read", async () => {
      await governed.create("posts", { title: "Visible", body: "b" }, editor);

      expect(await governed.list("posts", undefined, viewer)).toEqual([
        { id: 1, title: "Visible", body: "b" },
      ]);
      expect(await governed.get("posts", 1, viewer)).toEqual({
        id: 1,
        title: "Visible",
        body: "b",
      });
    });

    it("denies a read for an actor with no granting role (deny-by-default)", async () => {
      // No context → no roles → the declared read permission is refused.
      try {
        await governed.list("posts");
        expect.unreachable("expected ADMIN_FORBIDDEN");
      } catch (error) {
        const err = error as AdminError;

        expect(err.code).toBe("ADMIN_FORBIDDEN");
        expect(err.details).toMatchObject({
          resource: "posts",
          action: "list",
          permission: "posts:read",
        });
      }
    });

    it("allows an editor to create/update and the audit carries the resolved actor", async () => {
      const events: AuditEvent[] = [];
      const auditedGoverned = createAdmin(db, [governedResource], {
        policy,
        onMutation: (event) => events.push(event),
      });

      const created = await auditedGoverned.create("posts", { title: "Draft", body: "b" }, editor);
      await auditedGoverned.update("posts", created["id"], { title: "Revised" }, editor);

      expect(events.map((e) => ({ action: e.action, actor: e.actor }))).toEqual([
        { action: "create", actor: "u-editor" },
        { action: "update", actor: "u-editor" },
      ]);
    });

    it("denies create for a viewer (lacks posts:create) with ADMIN_FORBIDDEN details", async () => {
      try {
        await governed.create("posts", { title: "Nope", body: "b" }, viewer);
        expect.unreachable("expected ADMIN_FORBIDDEN");
      } catch (error) {
        const err = error as AdminError;

        expect(err.code).toBe("ADMIN_FORBIDDEN");
        expect(err.details).toMatchObject({
          resource: "posts",
          action: "create",
          permission: "posts:create",
        });
      }
    });

    it("gates destroy to admin — an editor is refused, the operator succeeds", async () => {
      await governed.create("posts", { title: "Doomed", body: "b" }, editor);

      await expectCode(() => governed.destroy("posts", 1, editor), "ADMIN_FORBIDDEN");

      await expect(governed.destroy("posts", 1, operator)).resolves.toBeUndefined();
      expect(await governed.list("posts", undefined, viewer)).toHaveLength(0);
    });

    it("refuses an unattributed governed write even when the roles would grant it", async () => {
      // Roles present but no actor — the resolver is the sole actor source, so the
      // write is refused before any policy check (and never reaches the audit hook).
      try {
        await governed.create("posts", { title: "Ghost", body: "b" }, { actorRoles: ["editor"] });
        expect.unreachable("expected ADMIN_FORBIDDEN");
      } catch (error) {
        const err = error as AdminError;

        expect(err.code).toBe("ADMIN_FORBIDDEN");
        expect(err.details).toMatchObject({
          resource: "posts",
          action: "create",
          reason: "unattributed",
        });
      }
    });

    it("carries the resolved actor into the audit for all three governed verbs", async () => {
      // The operator's role grants create/update/destroy, so one principal drives a
      // full mutation lifecycle — proving onMutation receives the resolved actor for
      // every write verb under a governed policy (ADR 0028 Phase 1, attribution).
      const events: AuditEvent[] = [];
      const auditedGoverned = createAdmin(db, [governedResource], {
        policy,
        onMutation: (event) => events.push(event),
      });

      const created = await auditedGoverned.create(
        "posts",
        { title: "Draft", body: "b" },
        operator,
      );
      await auditedGoverned.update("posts", created["id"], { title: "Revised" }, operator);
      await auditedGoverned.destroy("posts", created["id"], operator);

      expect(events.map((e) => ({ action: e.action, actor: e.actor }))).toEqual([
        { action: "create", actor: "u-admin" },
        { action: "update", actor: "u-admin" },
        { action: "destroy", actor: "u-admin" },
      ]);
    });

    it("an unattributed governed write never reaches onMutation", async () => {
      // The acceptance criterion in the flesh: the refusal happens before the write,
      // so the audit hook on a governed admin sees nothing for an unattributed write.
      const events: AuditEvent[] = [];
      const auditedGoverned = createAdmin(db, [governedResource], {
        policy,
        onMutation: (event) => events.push(event),
      });

      await expectCode(
        () =>
          auditedGoverned.create(
            "posts",
            { title: "Ghost", body: "b" },
            { actorRoles: ["editor"] },
          ),
        "ADMIN_FORBIDDEN",
      );

      expect(events).toHaveLength(0);
    });

    it("denies any verb a resource declares no permission for (fail-closed)", async () => {
      const undeclared = createAdmin(db, [{ ...postsResource, permissions: {} }], { policy });

      // read is undeclared → list is denied even for the operator.
      try {
        await undeclared.list("posts", undefined, operator);
        expect.unreachable("expected ADMIN_FORBIDDEN");
      } catch (error) {
        const err = error as AdminError;

        expect(err.code).toBe("ADMIN_FORBIDDEN");
        expect(err.details["permission"]).toBeUndefined();
        expect(err.details).toMatchObject({ resource: "posts", action: "list" });
      }

      // create is undeclared too → denied past the (satisfied) attribution gate.
      await expectCode(
        () => undeclared.create("posts", { title: "x", body: "y" }, operator),
        "ADMIN_FORBIDDEN",
      );
    });

    it("authorizes BEFORE validation — an unauthorized bad-input create is FORBIDDEN, not VALIDATION_FAILED", async () => {
      // The empty title would fail validation, but the viewer is refused first.
      await expectCode(() => governed.create("posts", { title: "" }, viewer), "ADMIN_FORBIDDEN");
    });

    it("authorizes BEFORE the db is touched — an unauthorized update on a missing row is FORBIDDEN, not NOT_FOUND", async () => {
      await expectCode(
        () => governed.update("posts", 999, { title: "x" }, viewer),
        "ADMIN_FORBIDDEN",
      );
    });

    it("ungoverned bypasses declared permissions entirely (the loud opt-out)", async () => {
      const open = createAdmin(db, [governedResource], { policy: UNGOVERNED });

      // No context, no roles — yet every verb runs, because gating is off.
      await open.create("posts", { title: "Free", body: "b" });
      expect(await open.list("posts")).toHaveLength(1);
      await expect(open.destroy("posts", 1)).resolves.toBeUndefined();
    });

    it("refuses { ungoverned: false } loudly — a falsy opt-out must NOT silently fail open", async () => {
      // The discriminator keys on VALUE, not presence: `{ ungoverned: false }` reads
      // as "governance on" to a human, so it must be refused, never treated as opt-out.
      // (A JS caller / dynamically-built options bag is the realistic source — hence the cast.)
      await expectCode(
        () =>
          createAdmin(db, [governedResource], {
            policy: { ungoverned: false } as unknown as AdminPolicy,
          }),
        "ADMIN_INVALID_POLICY",
      );
    });

    it("refuses an absent policy at construction (a JS caller bypassing the required type)", async () => {
      await expectCode(
        () => createAdmin(db, [postsResource], {} as unknown as AdminOptions),
        "ADMIN_INVALID_POLICY",
      );
    });
  });
});
