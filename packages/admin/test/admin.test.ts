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
} from "@keel/db";

import { AdminError, createAdmin } from "../src/index";

import type { Admin, AdminErrorCode, AdminResource } from "../src/index";

// ---------------------------------------------------------------------------
// Test rig
//
// One in-memory SQLite per test, wrapped in @keel/db. A small fixture table
// `posts` with a "secret" column the allow-list must hide.
// ---------------------------------------------------------------------------

function adapt(raw: Database.Database): SqlDatabase {
  return {
    exec: (statement) => raw.exec(statement),
    prepare: (statement) => {
      const stmt = raw.prepare(statement);

      return {
        run: (params: unknown[] = []) => stmt.run(...(params as never[])),
        get: (params: unknown[] = []) => stmt.get(...(params as never[])),
        all: (params: unknown[] = []) => stmt.all(...(params as never[])),
      };
    },
  };
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

beforeEach(() => {
  raw = new Database(":memory:");
  const sql = adapt(raw);
  db = createDb(sql);
  db.exec(createTableSql(posts));

  admin = createAdmin(db, [postsResource]);
});

afterEach(() => {
  raw.close();
});

/** Assert the thrown error is an AdminError with the expected stable code. */
function expectCode(run: () => void, code: AdminErrorCode): void {
  try {
    run();
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

    it("throws ADMIN_UNKNOWN_RESOURCE for an unknown resource", () => {
      expectCode(() => admin.describe("widgets"), "ADMIN_UNKNOWN_RESOURCE");
    });
  });

  describe("list", () => {
    it("projects each row to id + declared fields only (secret never leaks)", () => {
      admin.create("posts", { title: "First", body: "one", secret: "hidden" });
      admin.create("posts", { title: "Second", body: "two", secret: "nope" });

      const rows = admin.list("posts");

      expect(rows).toEqual([
        { id: 1, title: "First", body: "one" },
        { id: 2, title: "Second", body: "two" },
      ]);
      expect(Object.keys(rows[0]!)).toEqual(["id", "title", "body"]);
      expect(rows[0]).not.toHaveProperty("secret");
    });
  });

  describe("get", () => {
    it("returns the projection of a found row", () => {
      const created = admin.create("posts", { title: "Hello", body: "world", secret: "x" });

      expect(admin.get("posts", created["id"])).toEqual({ id: 1, title: "Hello", body: "world" });
    });

    it("throws ADMIN_RECORD_NOT_FOUND when absent", () => {
      expectCode(() => admin.get("posts", 999), "ADMIN_RECORD_NOT_FOUND");
    });
  });

  describe("create", () => {
    it("validates, persists, and returns the projection", () => {
      const created = admin.create("posts", { title: "New", body: "fresh", secret: "s" });

      expect(created).toEqual({ id: 1, title: "New", body: "fresh" });
      expect(admin.get("posts", 1)).toEqual({ id: 1, title: "New", body: "fresh" });
    });

    it("throws ADMIN_VALIDATION_FAILED with flattened Zod issues on a bad title", () => {
      try {
        admin.create("posts", { title: "", body: "ok" });
        expect.unreachable("expected an AdminError");
      } catch (error) {
        const adminError = error as AdminError;

        expect(adminError.code).toBe("ADMIN_VALIDATION_FAILED");

        const issues = adminError.details["issues"] as { fieldErrors: Record<string, string[]> };

        expect(issues.fieldErrors["title"]).toContain("Title is required.");
      }
    });

    it("throws ADMIN_VALIDATION_FAILED for a wholly missing required field", () => {
      expectCode(() => admin.create("posts", { title: "ok" }), "ADMIN_VALIDATION_FAILED");
    });
  });

  describe("update", () => {
    it("validates, mutates, and returns the merged projection", () => {
      admin.create("posts", { title: "Old", body: "stale", secret: "s" });

      const updated = admin.update("posts", 1, { title: "Updated" });

      // `body` is untouched; `title` is the patched value.
      expect(updated).toEqual({ id: 1, title: "Updated", body: "stale" });
    });

    it("throws ADMIN_RECORD_NOT_FOUND when absent — BEFORE running the SQL update", () => {
      expectCode(() => admin.update("posts", 999, { title: "x" }), "ADMIN_RECORD_NOT_FOUND");
    });

    it("throws ADMIN_VALIDATION_FAILED on an invalid patch", () => {
      admin.create("posts", { title: "Real", body: "ok" });

      expectCode(() => admin.update("posts", 1, { title: "" }), "ADMIN_VALIDATION_FAILED");
    });
  });

  describe("destroy", () => {
    it("deletes a found row", () => {
      admin.create("posts", { title: "Doomed", body: "gone" });

      admin.destroy("posts", 1);

      expect(admin.list("posts")).toHaveLength(0);
    });

    it("throws ADMIN_RECORD_NOT_FOUND when absent", () => {
      expectCode(() => admin.destroy("posts", 999), "ADMIN_RECORD_NOT_FOUND");
    });
  });

  describe("primary-key resolution", () => {
    it("refuses a resource whose table has no primary-key column at construction time", () => {
      const noPk = defineTable("no_pk", {
        name: text("name").notNull(),
      });

      expectCode(
        () =>
          createAdmin(db, [
            {
              name: "broken",
              table: noPk,
              insertSchema: z.object({ name: z.string() }),
              updateSchema: z.object({ name: z.string().optional() }),
              fields: ["name"],
            },
          ]),
        "ADMIN_NO_PRIMARY_KEY",
      );
    });

    it("works with a non-`id` primary key (slug)", () => {
      const slugTable = defineTable("by_slug", {
        slug: text("slug").primaryKey(),
        body: text("body").notNull(),
      });
      db.exec(createTableSql(slugTable));

      const slugAdmin = createAdmin(db, [
        {
          name: "by_slug",
          table: slugTable,
          insertSchema: z.object({ slug: z.string(), body: z.string() }),
          updateSchema: z.object({ body: z.string().optional() }),
          fields: ["body"],
        },
      ]);

      slugAdmin.create("by_slug", { slug: "hello", body: "world" });

      expect(slugAdmin.get("by_slug", "hello")).toEqual({ id: "hello", body: "world" });
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
});
