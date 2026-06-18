import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTableSql, defineTable, integer, text } from "@lesto/db";

import { MigrateError, Migrator, Schema } from "../src/index";

import type { Migration, MigrationEntry, SqlDatabase, SqlStatement } from "../src/index";

// Schema-as-value test tables (the one DDL system). `createTableSql(t, dialect)`
// renders these; the value layer's own rendering is exhaustively tested in
// @lesto/db, so here we only prove the migrator runs and orders the DDL.
const posts = defineTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  createdAt: text("created_at"),
  updatedAt: text("updated_at"),
});

const usersTable = defineTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
});

let database: Database.Database;
let db: SqlDatabase;

// A ~6-line adapter wrapping better-sqlite3 in our minimal SqlDatabase shape.
// better-sqlite3's variadic `run(...params)` / `all(...params)` become our
// positional `run(params?)` / `all(params?)`.
beforeEach(() => {
  database = new Database(":memory:");

  db = makeDb();
});

// A ~20-line adapter wrapping better-sqlite3 in our minimal async SqlDatabase
// shape. The engine is synchronous; the seam is Promise-returning (ADR 0006),
// so each terminal trivially wraps a sync call in `async`. better-sqlite3's
// variadic `run(...params)` / `all(...params)` become our positional
// `run(params?)` / `all(params?)`. `transaction` is the real BEGIN/COMMIT/
// ROLLBACK over the single connection — the seam-owned primitive the migrator
// now relies on instead of raw exec("BEGIN"). Closes over the suite's
// `database` handle (recreated per test by beforeEach).
function makeDb(): SqlDatabase {
  const self: SqlDatabase = {
    exec: async (sql) => {
      database.exec(sql);
    },
    prepare: (sql): SqlStatement => {
      const stmt = database.prepare(sql);

      return {
        run: async (params = []) => stmt.run(...params),
        all: async (params = []) => stmt.all(...params),
      };
    },
    transaction: async (fn) => {
      database.exec("BEGIN");

      try {
        const out = await fn(self);

        database.exec("COMMIT");

        return out;
      } catch (error) {
        // Undo the partial work, then re-raise the original failure. ROLLBACK
        // over this single in-memory connection cannot itself fail, so no inner
        // guard is needed here.
        database.exec("ROLLBACK");

        throw error;
      }
    },
  };

  return self;
}

afterEach(() => {
  database.close();
});

/**
 * A Postgres-SHAPED fake over the same in-memory SQLite engine: it intercepts the
 * `pg_advisory_xact_lock` statement (which SQLite has no function for), recording
 * it into `lockLog`, and passes every other statement through to the real engine.
 * This lets the `dialect: "postgres"` migrator paths run against SQLite while
 * proving the transaction-level advisory lock brackets the whole run. (There is
 * no unlock to record: a transaction-level lock releases automatically at
 * COMMIT/ROLLBACK — see {@link Migrator}'s `withMigrationLock`.)
 */
function makePgFake(lockLog: string[]): SqlDatabase {
  const passthrough = makeDb();

  // Mirror the real `@lesto/pg` adapter's transaction nesting: the TOP-LEVEL db
  // brackets BEGIN/COMMIT, but a transaction-scoped handle runs a nested
  // `transaction` FLAT (Postgres has no nested BEGIN). The SQLite fake would
  // otherwise throw "cannot start a transaction within a transaction" when the
  // advisory-lock outer span wraps the per-migration inner spans.
  const advisory = (sql: string): SqlStatement | undefined => {
    if (!sql.includes("pg_advisory_xact_lock")) return undefined;

    return {
      run: async () => {
        lockLog.push("lock");

        return { changes: 0 };
      },
      all: async () => [],
    };
  };

  const prepare = (sql: string): SqlStatement => advisory(sql) ?? passthrough.prepare(sql);

  // Mirror real `@lesto/pg`: the migrator pins ONE connection (the advisory-lock
  // span) and runs every migration FLAT on it (`transaction: inner => inner(tx)`),
  // so the whole run is one transaction. We model that here: only the OUTERMOST
  // transaction issues a real BEGIN/COMMIT (via the passthrough); deeper ones run
  // flat on the same handle — exactly the nesting the real adapter performs.
  let depth = 0;
  const self: SqlDatabase = {
    exec: passthrough.exec,
    prepare,
    transaction: async (fn) => {
      if (depth > 0) return fn(self);

      depth += 1;
      try {
        return await passthrough.transaction(() => fn(self));
      } finally {
        depth -= 1;
      }
    },
  };

  return self;
}

/** Read the columns of a table as { name -> type, notnull } for assertions. */
const tableInfo = (name: string): { name: string; type: string; notnull: number }[] =>
  database.prepare(`PRAGMA table_info(${name})`).all() as {
    name: string;
    type: string;
    notnull: number;
  }[];

const indexList = (table: string): { name: string; unique: number }[] =>
  database.prepare(`PRAGMA index_list(${table})`).all() as {
    name: string;
    unique: number;
  }[];

describe("Schema", () => {
  it("runs value-DDL CREATE TABLE via execute(createTableSql)", async () => {
    const schema = new Schema(db);

    await schema.execute(createTableSql(posts, schema.dialect));

    const cols = tableInfo("posts");

    expect(cols.map((c) => c.name)).toEqual(["id", "title", "created_at", "updated_at"]);
    expect(cols.find((c) => c.name === "title")?.notnull).toBe(1);
  });

  it("dropTable removes the table", async () => {
    const schema = new Schema(db);

    await schema.execute(createTableSql(usersTable, schema.dialect));
    await schema.dropTable("users");

    expect(() => database.prepare("SELECT * FROM users").all()).toThrow();
  });

  it("exposes its dialect so a value-DDL migration renders postgres DDL", async () => {
    let emitted = "";
    const capture: SqlDatabase = {
      exec: async (sql) => {
        emitted = sql;
      },
      prepare: () => {
        throw new Error("unused");
      },
      transaction: () => {
        throw new Error("unused");
      },
    };

    const schema = new Schema(capture, "postgres");

    // The dialect is readable so a value-DDL migration can render for it.
    expect(schema.dialect).toBe("postgres");

    await schema.execute(createTableSql(usersTable, schema.dialect));

    expect(emitted).toBe(
      'CREATE TABLE "users" ("id" BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY, "email" TEXT NOT NULL)',
    );
  });

  it("defaults its dialect to sqlite", () => {
    expect(new Schema(db).dialect).toBe("sqlite");
  });

  it("addColumn renders modifiers and grows the table", async () => {
    const schema = new Schema(db);

    await schema.execute(createTableSql(posts, schema.dialect));

    await schema.addColumn("posts", "views", "INTEGER", { null: false, default: 0 });

    const views = tableInfo("posts").find((c) => c.name === "views");

    expect(views?.type).toBe("INTEGER");
    expect(views?.notnull).toBe(1);
  });

  it("addColumn renders the UNIQUE modifier in the emitted SQL", async () => {
    // SQLite refuses ALTER TABLE ADD of a UNIQUE column, so we assert the SQL
    // the schema emits rather than executing it.
    let emitted = "";

    const capture: SqlDatabase = {
      exec: async (sql) => {
        emitted = sql;
      },
      prepare: () => {
        throw new Error("unused");
      },
      transaction: () => {
        throw new Error("unused");
      },
    };

    await new Schema(capture).addColumn("posts", "slug", "TEXT", { unique: true });

    expect(emitted).toBe("ALTER TABLE posts ADD COLUMN slug TEXT UNIQUE");
  });

  it("addColumn with no opts adds a plain column", async () => {
    const schema = new Schema(db);

    await schema.execute(createTableSql(posts, schema.dialect));

    await schema.addColumn("posts", "body", "TEXT");

    expect(tableInfo("posts").map((c) => c.name)).toContain("body");
  });

  it("addColumn renders string and boolean defaults", async () => {
    const schema = new Schema(db);

    await schema.execute(createTableSql(posts, schema.dialect));

    await schema.addColumn("posts", "status", "TEXT", { default: "draft" });
    await schema.addColumn("posts", "published", "INTEGER", { default: true });
    await schema.addColumn("posts", "archived", "INTEGER", { default: false });

    const names = tableInfo("posts").map((c) => c.name);

    expect(names).toContain("status");
    expect(names).toContain("published");
    expect(names).toContain("archived");
  });

  it("addIndex over a single column with a custom name and unique flag", async () => {
    const schema = new Schema(db);

    await schema.execute(createTableSql(posts, schema.dialect));

    await schema.addIndex("posts", "title", { unique: true, name: "by_slug" });

    const index = indexList("posts").find((i) => i.name === "by_slug");

    expect(index?.unique).toBe(1);
  });

  it("addIndex over an array of columns with a generated name", async () => {
    const schema = new Schema(db);

    const withAuthor = defineTable("posts", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      title: text("title"),
      authorId: integer("author_id"),
    });

    await schema.execute(createTableSql(withAuthor, schema.dialect));

    await schema.addIndex("posts", ["author_id", "title"]);

    const names = indexList("posts").map((i) => i.name);

    expect(names).toContain("idx_posts_author_id_title");
  });

  it("execute runs arbitrary SQL", async () => {
    const schema = new Schema(db);

    await schema.execute("CREATE TABLE raw (id INTEGER)");

    expect(tableInfo("raw").map((c) => c.name)).toEqual(["id"]);
  });
});

describe("Migrator", () => {
  // A small, ordered set of migrations. `002` is reversible; `001` is not, so we
  // can exercise rollback both with and without a `down`.
  const createPosts: Migration = {
    up: async (s) => {
      await s.execute(createTableSql(posts, s.dialect));
    },
  };

  const createUsers: Migration = {
    up: async (s) => {
      await s.execute(createTableSql(usersTable, s.dialect));
    },
    down: async (s) => {
      await s.dropTable("users");
    },
  };

  // Declared out of version order to prove the migrator sorts before running.
  const migrations: MigrationEntry[] = [
    { version: "002_create_users", migration: createUsers },
    { version: "001_create_posts", migration: createPosts },
  ];

  it("applies pending migrations in version order and is idempotent", async () => {
    const migrator = new Migrator(db, migrations);

    expect(await migrator.migrate()).toEqual(["001_create_posts", "002_create_users"]);

    // Both tables now exist.
    expect(tableInfo("posts").length).toBeGreaterThan(0);
    expect(tableInfo("users").length).toBeGreaterThan(0);

    // A second run applies nothing.
    expect(await migrator.migrate()).toEqual([]);
  });

  it("status reflects applied and pending versions", async () => {
    const migrator = new Migrator(db, migrations);

    expect(await migrator.status()).toEqual([
      { version: "001_create_posts", applied: false },
      { version: "002_create_users", applied: false },
    ]);

    await migrator.migrate();

    expect(await migrator.status()).toEqual([
      { version: "001_create_posts", applied: true },
      { version: "002_create_users", applied: true },
    ]);
  });

  it("rollback runs down() of the most recent and removes its record", async () => {
    const migrator = new Migrator(db, migrations);

    await migrator.migrate();

    expect(await migrator.rollback()).toBe("002_create_users");

    // down() dropped the users table, and the record is gone.
    expect(() => database.prepare("SELECT * FROM users").all()).toThrow();
    expect((await migrator.status()).find((s) => s.version === "002_create_users")?.applied).toBe(
      false,
    );
  });

  it("rollback of a migration without down() still removes the record", async () => {
    const migrator = new Migrator(db, migrations);

    await migrator.migrate();
    await migrator.rollback(); // drops 002_create_users

    // 001 has no down; the posts table survives but the record is cleared.
    expect(await migrator.rollback()).toBe("001_create_posts");
    expect(tableInfo("posts").length).toBeGreaterThan(0);
    expect((await migrator.status()).every((s) => !s.applied)).toBe(true);
  });

  it("rollback returns undefined when nothing is applied", async () => {
    const migrator = new Migrator(db, migrations);

    expect(await migrator.rollback()).toBeUndefined();
  });

  it("threads its dialect into every migration's Schema (up and down)", async () => {
    const seen: string[] = [];
    const recordDialect: MigrationEntry = {
      version: "001_record",
      migration: {
        up: async (s) => {
          seen.push(`up:${s.dialect}`);
        },
        down: async (s) => {
          seen.push(`down:${s.dialect}`);
        },
      },
    };

    // Postgres dialect → migrate runs under the advisory lock; the fake handles
    // the lock SQL the SQLite engine lacks.
    const migrator = new Migrator(makePgFake([]), [recordDialect], { dialect: "postgres" });

    await migrator.migrate();
    await migrator.rollback();

    expect(seen).toEqual(["up:postgres", "down:postgres"]);
  });

  it("postgres: takes the xact advisory lock as the first statement of the run", async () => {
    const lockLog: string[] = [];
    const seen: string[] = [];
    const migrator = new Migrator(
      makePgFake(lockLog),
      [
        {
          version: "001",
          migration: {
            up: async () => {
              // The lock is held WHILE the migration runs.
              seen.push(lockLog.join(","));
            },
          },
        },
      ],
      { dialect: "postgres" },
    );

    await migrator.migrate();

    // The transaction-level lock is taken once, before the body; it has no
    // explicit unlock — COMMIT/ROLLBACK releases it (see withMigrationLock).
    expect(seen).toEqual(["lock"]);
    expect(lockLog).toEqual(["lock"]);
  });

  it("postgres: runs the whole body on the pinned lock connection (no second checkout → no max:1 deadlock)", async () => {
    // The deadlock this guards: the lock span pins ONE connection via
    // this.db.transaction; if migrate() then opened a SECOND this.db.transaction
    // per migration, a `max: 1` pool would wait forever for a connection the lock
    // already holds. The fix threads the lock's pinned `tx` into the body so each
    // per-migration span runs FLAT on it. This fake makes the top-level checkout
    // observable: the OUTER transaction (the lock span) increments `checkouts`;
    // the nested per-migration transaction must run flat (depth > 0) and NOT
    // check out again. With the bug it would be 1 (lock) + 1 (migration) = 2.
    let checkouts = 0;
    let depth = 0;
    const passthrough = makeDb();
    const lockLog: string[] = [];

    const fake: SqlDatabase = {
      exec: passthrough.exec,
      prepare: (sql): SqlStatement => {
        if (sql.includes("pg_advisory_xact_lock")) {
          return {
            run: async () => {
              lockLog.push("lock");

              return { changes: 0 };
            },
            all: async () => [],
          };
        }

        return passthrough.prepare(sql);
      },
      // A nested transaction runs FLAT on the same handle (Postgres has no nested
      // BEGIN) and passes `self` as `tx` — mirroring `@lesto/pg`'s
      // `transaction: inner => inner(tx)`. Only the OUTERMOST call is a real
      // checkout.
      transaction: async (fn) => {
        if (depth > 0) return fn(fake);

        checkouts += 1;
        depth += 1;
        try {
          return await passthrough.transaction(() => fn(fake));
        } finally {
          depth -= 1;
        }
      },
    };

    const migrator = new Migrator(
      fake,
      [
        { version: "001", migration: { up: async () => {} } },
        { version: "002", migration: { up: async () => {} } },
      ],
      { dialect: "postgres" },
    );

    expect(await migrator.migrate()).toEqual(["001", "002"]);

    // Exactly ONE top-level checkout (the lock span), even with two migrations —
    // proof the per-migration spans ran flat on the pinned connection.
    expect(checkouts).toBe(1);
    expect(lockLog).toEqual(["lock"]);
  });

  it("postgres: a throwing migration rolls the locked span back (no stranded lock)", async () => {
    const lockLog: string[] = [];
    const migrator = new Migrator(
      makePgFake(lockLog),
      [
        {
          version: "001_boom",
          migration: {
            up: async () => {
              throw new Error("boom");
            },
          },
        },
      ],
      { dialect: "postgres" },
    );

    await expect(migrator.migrate()).rejects.toThrow("boom");

    // The xact lock was taken once; ROLLBACK (which the rejecting span triggers)
    // releases it — no explicit unlock, nothing to strand.
    expect(lockLog).toEqual(["lock"]);
  });

  it("sqlite (default): runs no advisory lock — relies on the single-connection FIFO", async () => {
    const lockLog: string[] = [];
    const migrator = new Migrator(makePgFake(lockLog), [
      { version: "001", migration: { up: async () => {} } },
    ]);

    await migrator.migrate();

    expect(lockLog).toEqual([]);
  });

  it("defaults to the sqlite dialect when no option is passed", async () => {
    let seen = "";
    const migrator = new Migrator(db, [
      {
        version: "001_record",
        migration: {
          up: async (s) => {
            seen = s.dialect;
          },
        },
      },
    ]);

    await migrator.migrate();

    expect(seen).toBe("sqlite");
  });

  // M6: a migration's up() and its version record must be one atomic unit.
  it("rolls back a failing migration's DDL and leaves no record, keeping earlier ones", async () => {
    // 001 succeeds. 002's up() creates a table then throws — proving the
    // db.transaction span ROLLED BACK: the partial DDL is undone and no record
    // is written for the failure, while 001 (applied earlier in the SAME run,
    // its own committed transaction) stays applied. This forces the rollback
    // branch of the seam's transaction().
    const half = defineTable("half", { id: integer("id").primaryKey({ autoIncrement: true }) });
    const failing: Migration = {
      up: async (s) => {
        await s.execute(createTableSql(half, s.dialect));

        throw new Error("boom");
      },
    };

    const migrator = new Migrator(db, [
      { version: "001_create_posts", migration: createPosts },
      { version: "002_boom", migration: failing },
    ]);

    // (a) the failure rejects.
    await expect(migrator.migrate()).rejects.toThrow("boom");

    // (b) no schema_migrations row for the failing version.
    const recorded = database.prepare("SELECT version FROM schema_migrations").all() as {
      version: string;
    }[];

    expect(recorded.map((r) => r.version)).toEqual(["001_create_posts"]);

    // (c) the DDL the failing migration started was rolled back.
    expect(() => database.prepare("SELECT * FROM half").all()).toThrow();

    // (d) the migration applied earlier in the same run remains applied.
    expect(tableInfo("posts").length).toBeGreaterThan(0);
    expect((await migrator.status()).find((s) => s.version === "001_create_posts")?.applied).toBe(
      true,
    );
  });

  // M5: the latest-applied version is authoritative from the DB, not from the
  // loaded entries — rolling back must never reverse the wrong migration.
  it("refuses to roll back when the latest applied migration's definition is missing", async () => {
    // Apply both with a full migrator.
    await new Migrator(db, migrations).migrate();

    // A new migrator that has lost the definition of 002 (file deleted) while
    // the DB still records it applied.
    const partial = new Migrator(db, [{ version: "001_create_posts", migration: createPosts }]);

    let thrown: unknown;

    try {
      await partial.rollback();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MigrateError);
    expect((thrown as MigrateError).code).toBe("MIGRATE_MISSING_MIGRATION");
    expect((thrown as MigrateError).details["version"]).toBe("002_create_users");

    // It must NOT have rolled back the older 001 instead.
    expect((await partial.status()).find((s) => s.version === "001_create_posts")?.applied).toBe(
      true,
    );

    const recorded = database.prepare("SELECT version FROM schema_migrations").all() as {
      version: string;
    }[];

    expect(recorded.map((r) => r.version).toSorted()).toEqual([
      "001_create_posts",
      "002_create_users",
    ]);
  });
});
