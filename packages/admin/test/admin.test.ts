import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Model, resetConnection, useDatabase } from "@keel/orm";

import { Admin, AdminError } from "../src/index";

import type { AdminErrorCode } from "../src/index";
import type { SqlDatabase, SqlStatement } from "@keel/orm";

// The DI boundary: the ORM speaks "array of positional params"; this adapter
// maps that onto better-sqlite3's variadic bind — the same seam the ORM tests use.
function adapt(raw: Database.Database): SqlDatabase {
  return {
    prepare(sql: string): SqlStatement {
      const statement = raw.prepare(sql);

      return {
        run: (params = []) => statement.run(...(params as never[])),
        get: (params = []) => statement.get(...(params as never[])),
        all: (params = []) => statement.all(...(params as never[])),
      };
    },
  };
}

class Post extends Model {
  static override validations = { title: { presence: true } };
}

let raw: Database.Database;
let admin: Admin;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(`
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, body TEXT, secret TEXT
    );
  `);
  useDatabase(adapt(raw));

  admin = new Admin([{ name: "posts", model: Post, fields: ["title", "body"] }]);
});

afterEach(() => {
  resetConnection();
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

describe("Admin", () => {
  describe("resources", () => {
    it("summarizes every resource as name + fields, without the model", () => {
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
    it("projects each record to only id + declared fields", () => {
      Post.create({ title: "First", body: "one", secret: "hidden" });
      Post.create({ title: "Second", body: "two", secret: "nope" });

      const rows = admin.list("posts");

      expect(rows).toEqual([
        { id: 1, title: "First", body: "one" },
        { id: 2, title: "Second", body: "two" },
      ]);

      // the allow-list holds: an undeclared column never leaks
      expect(Object.keys(rows[0]!)).toEqual(["id", "title", "body"]);
      expect(rows[0]).not.toHaveProperty("secret");
    });
  });

  describe("get", () => {
    it("returns the projection of a found record", () => {
      const created = Post.create({ title: "Hello", body: "world", secret: "x" });

      expect(admin.get("posts", created.id)).toEqual({ id: 1, title: "Hello", body: "world" });
    });

    it("throws ADMIN_RECORD_NOT_FOUND when absent", () => {
      expectCode(() => admin.get("posts", 999), "ADMIN_RECORD_NOT_FOUND");
    });
  });

  describe("create", () => {
    it("persists and returns the projection", () => {
      const created = admin.create("posts", { title: "New", body: "fresh", secret: "s" });

      expect(created).toEqual({ id: 1, title: "New", body: "fresh" });
      expect(Post.find(1).get("title")).toBe("New");
    });
  });

  describe("update", () => {
    it("mutates a found record and returns the projection", () => {
      const created = Post.create({ title: "Old", body: "stale", secret: "s" });

      const updated = admin.update("posts", created.id, { title: "Updated" });

      expect(updated).toEqual({ id: 1, title: "Updated", body: "stale" });
      expect(Post.find(1).get("title")).toBe("Updated");
    });

    it("throws ADMIN_RECORD_NOT_FOUND when absent", () => {
      expectCode(() => admin.update("posts", 999, { title: "x" }), "ADMIN_RECORD_NOT_FOUND");
    });
  });

  describe("destroy", () => {
    it("deletes a found record", () => {
      const created = Post.create({ title: "Doomed", body: "gone", secret: "s" });

      admin.destroy("posts", created.id);

      expect(Post.all().all()).toHaveLength(0);
    });

    it("throws ADMIN_RECORD_NOT_FOUND when absent", () => {
      expectCode(() => admin.destroy("posts", 999), "ADMIN_RECORD_NOT_FOUND");
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
