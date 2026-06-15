import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MigrateError, Migrator, Schema, TableBuilder } from "../src/index";

import type { Migration, MigrationEntry, SqlDatabase, SqlStatement } from "../src/index";

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

describe("TableBuilder", () => {
  it("seeds an autoincrement id and renders every column type", () => {
    const t = new TableBuilder();

    t.string("title");
    t.text("body");
    t.integer("views");
    t.boolean("published");
    t.float("rating");
    t.datetime("seen_at");

    expect(t.build()).toBe(
      [
        "id INTEGER PRIMARY KEY AUTOINCREMENT",
        "title TEXT",
        "body TEXT",
        "views INTEGER",
        "published INTEGER",
        "rating REAL",
        "seen_at TEXT",
      ].join(", "),
    );
  });

  it("adds a reference column without a foreign key by default", () => {
    const t = new TableBuilder();

    t.references("author");

    expect(t.build()).toBe("id INTEGER PRIMARY KEY AUTOINCREMENT, author_id INTEGER");
  });

  it("adds a foreign key only when asked", () => {
    const t = new TableBuilder();

    t.references("author", { foreignKey: true });

    expect(t.build()).toBe(
      [
        "id INTEGER PRIMARY KEY AUTOINCREMENT",
        "author_id INTEGER",
        "FOREIGN KEY(author_id) REFERENCES authors(id)",
      ].join(", "),
    );
  });

  it("adds created_at and updated_at via timestamps()", () => {
    const t = new TableBuilder();

    t.timestamps();

    expect(t.build()).toBe(
      "id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, updated_at TEXT",
    );
  });

  it("postgres: identity key + BIGINT integer/boolean/reference columns", () => {
    const t = new TableBuilder("postgres");

    t.integer("views");
    t.boolean("published");
    t.references("author", { foreignKey: true });

    expect(t.build()).toBe(
      [
        "id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY",
        "views BIGINT",
        "published BIGINT",
        "author_id BIGINT",
        "FOREIGN KEY(author_id) REFERENCES authors(id)",
      ].join(", "),
    );
  });

  it("renders null:false, unique, and every default literal flavor", () => {
    const t = new TableBuilder();

    t.string("name", { null: false });
    t.string("slug", { unique: true });
    t.string("status", { default: "draft" });
    t.string("quote", { default: "it's" });
    t.integer("views", { default: 0 });
    t.boolean("published", { default: true });
    t.boolean("archived", { default: false });

    expect(t.build()).toBe(
      [
        "id INTEGER PRIMARY KEY AUTOINCREMENT",
        "name TEXT NOT NULL",
        "slug TEXT UNIQUE",
        "status TEXT DEFAULT 'draft'",
        "quote TEXT DEFAULT 'it''s'",
        "views INTEGER DEFAULT 0",
        "published INTEGER DEFAULT 1",
        "archived INTEGER DEFAULT 0",
      ].join(", "),
    );
  });
});

describe("Schema", () => {
  it("createTable emits a usable CREATE TABLE", async () => {
    const schema = new Schema(db);

    await schema.createTable("posts", (t) => {
      t.string("title", { null: false });
      t.timestamps();
    });

    const cols = tableInfo("posts");

    expect(cols.map((c) => c.name)).toEqual(["id", "title", "created_at", "updated_at"]);
    expect(cols.find((c) => c.name === "title")?.notnull).toBe(1);
  });

  it("dropTable removes the table", async () => {
    const schema = new Schema(db);

    await schema.createTable("temp", (t) => t.string("x"));
    await schema.dropTable("temp");

    expect(() => database.prepare("SELECT * FROM temp").all()).toThrow();
  });

  it("exposes its dialect and renders postgres DDL through createTable", async () => {
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

    await schema.createTable("posts", (t) => t.string("title", { null: false }));

    expect(emitted).toBe(
      "CREATE TABLE posts (id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY, title TEXT NOT NULL)",
    );
  });

  it("defaults its dialect to sqlite", () => {
    expect(new Schema(db).dialect).toBe("sqlite");
  });

  it("addColumn renders modifiers and grows the table", async () => {
    const schema = new Schema(db);

    await schema.createTable("posts", (t) => t.string("title"));

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

    await schema.createTable("posts", (t) => t.string("title"));

    await schema.addColumn("posts", "body", "TEXT");

    expect(tableInfo("posts").map((c) => c.name)).toContain("body");
  });

  it("addColumn renders string and boolean defaults", async () => {
    const schema = new Schema(db);

    await schema.createTable("posts", (t) => t.string("title"));

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

    await schema.createTable("posts", (t) => t.string("slug"));

    await schema.addIndex("posts", "slug", { unique: true, name: "by_slug" });

    const index = indexList("posts").find((i) => i.name === "by_slug");

    expect(index?.unique).toBe(1);
  });

  it("addIndex over an array of columns with a generated name", async () => {
    const schema = new Schema(db);

    await schema.createTable("posts", (t) => {
      t.string("title");
      t.integer("author_id");
    });

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
      await s.createTable("posts", (t) => t.string("title"));
    },
  };

  const createUsers: Migration = {
    up: async (s) => {
      await s.createTable("users", (t) => t.string("email"));
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

    const migrator = new Migrator(db, [recordDialect], { dialect: "postgres" });

    await migrator.migrate();
    await migrator.rollback();

    expect(seen).toEqual(["up:postgres", "down:postgres"]);
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
    const failing: Migration = {
      up: async (s) => {
        await s.createTable("half", (t) => t.string("x"));

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
