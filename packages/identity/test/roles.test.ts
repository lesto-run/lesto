/**
 * The `user_roles` store — the durable `userId -> roles` map (ADR 0028 Inc 5).
 *
 * Pins the store's contract: roles persist and resolve per user, a user with no
 * grants resolves to `[]` (deny-by-default), grant is idempotent, revoke removes,
 * and the migration's `up`/`down` create and drop the table.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDb } from "@lesto/db";
import type { Db, SqlDatabase } from "@lesto/db";
import { Migrator } from "@lesto/migrate";

import { grantRole, revokeRole, rolesOf, userRolesMigration } from "../src/index";

// ---------------------------------------------------------------------------
// Test rig — one in-memory SQLite per test wrapped in the `@lesto/db` async
// `SqlDatabase` shape (the same adapter the rest of the identity suite uses).
// ---------------------------------------------------------------------------

let raw: Database.Database;
let sql: SqlDatabase;
let db: Db;

function adapt(database: Database.Database): SqlDatabase {
  const adapted: SqlDatabase = {
    exec: async (statement) => {
      database.exec(statement);
    },
    prepare: (statement) => {
      const stmt = database.prepare(statement);

      return {
        run: async (params: unknown[] = []) => stmt.run(...(params as never[])),
        get: async (params: unknown[] = []) => stmt.get(...(params as never[])),
        all: async (params: unknown[] = []) => stmt.all(...(params as never[])),
      };
    },
    transaction: async (fn) => {
      database.exec("BEGIN");

      try {
        const out = await fn(adapted);
        database.exec("COMMIT");

        return out;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          /* preserve the original error */
        }

        throw error;
      }
    },
  };

  return adapted;
}

beforeEach(async () => {
  raw = new Database(":memory:");
  sql = adapt(raw);
  db = createDb(sql);

  await new Migrator(sql, [userRolesMigration]).migrate();
});

afterEach(() => {
  raw.close();
});

describe("rolesOf", () => {
  it("resolves the roles a user has been granted", async () => {
    await grantRole(db, "u-1", "admin");
    await grantRole(db, "u-1", "editor");

    expect((await rolesOf(db, "u-1")).toSorted()).toEqual(["admin", "editor"]);
  });

  it("returns [] for a user with no grants (deny-by-default)", async () => {
    await grantRole(db, "u-1", "admin");

    // A different user has no rows — the structural deny-by-default.
    expect(await rolesOf(db, "nobody")).toEqual([]);
  });

  it("scopes roles to their user — no cross-user leakage", async () => {
    await grantRole(db, "u-1", "admin");
    await grantRole(db, "u-2", "viewer");

    expect(await rolesOf(db, "u-1")).toEqual(["admin"]);
    expect(await rolesOf(db, "u-2")).toEqual(["viewer"]);
  });
});

describe("grantRole", () => {
  it("persists a grant so a later resolve sees it", async () => {
    await grantRole(db, "u-1", "admin");

    expect(await rolesOf(db, "u-1")).toEqual(["admin"]);
  });

  it("is idempotent — granting the same role twice keeps one row", async () => {
    await grantRole(db, "u-1", "admin");
    await grantRole(db, "u-1", "admin");

    expect(await rolesOf(db, "u-1")).toEqual(["admin"]);
  });
});

describe("revokeRole", () => {
  it("removes a held role", async () => {
    await grantRole(db, "u-1", "admin");
    await grantRole(db, "u-1", "editor");

    await revokeRole(db, "u-1", "admin");

    expect(await rolesOf(db, "u-1")).toEqual(["editor"]);
  });

  it("is a no-op when the user never held the role", async () => {
    await grantRole(db, "u-1", "admin");

    await revokeRole(db, "u-1", "viewer");

    expect(await rolesOf(db, "u-1")).toEqual(["admin"]);
  });
});

describe("userRolesMigration", () => {
  it("down drops the user_roles table", async () => {
    const migrator = new Migrator(sql, [userRolesMigration]);

    expect(await migrator.rollback()).toBe(userRolesMigration.version);
    expect(() => raw.prepare("SELECT * FROM user_roles").all()).toThrow();
  });
});
