import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Migrator, Schema, TableBuilder } from "../src/index";

import type { Migration, MigrationEntry, SqlDatabase, SqlStatement } from "../src/index";

let database: Database.Database;
let db: SqlDatabase;

// A ~6-line adapter wrapping better-sqlite3 in our minimal SqlDatabase shape.
// better-sqlite3's variadic `run(...params)` / `all(...params)` become our
// positional `run(params?)` / `all(params?)`.
beforeEach(() => {
  database = new Database(":memory:");

  db = {
    exec: (sql) => database.exec(sql),
    prepare: (sql): SqlStatement => {
      const stmt = database.prepare(sql);

      return {
        run: (params = []) => stmt.run(...params),
        all: (params = []) => stmt.all(...params),
      };
    },
  };
});

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
  it("createTable emits a usable CREATE TABLE", () => {
    const schema = new Schema(db);

    schema.createTable("posts", (t) => {
      t.string("title", { null: false });
      t.timestamps();
    });

    const cols = tableInfo("posts");

    expect(cols.map((c) => c.name)).toEqual(["id", "title", "created_at", "updated_at"]);
    expect(cols.find((c) => c.name === "title")?.notnull).toBe(1);
  });

  it("dropTable removes the table", () => {
    const schema = new Schema(db);

    schema.createTable("temp", (t) => t.string("x"));
    schema.dropTable("temp");

    expect(() => database.prepare("SELECT * FROM temp").all()).toThrow();
  });

  it("addColumn renders modifiers and grows the table", () => {
    const schema = new Schema(db);

    schema.createTable("posts", (t) => t.string("title"));

    schema.addColumn("posts", "views", "INTEGER", { null: false, default: 0 });

    const views = tableInfo("posts").find((c) => c.name === "views");

    expect(views?.type).toBe("INTEGER");
    expect(views?.notnull).toBe(1);
  });

  it("addColumn renders the UNIQUE modifier in the emitted SQL", () => {
    // SQLite refuses ALTER TABLE ADD of a UNIQUE column, so we assert the SQL
    // the schema emits rather than executing it.
    let emitted = "";

    const capture: SqlDatabase = {
      exec: (sql) => {
        emitted = sql;
      },
      prepare: () => {
        throw new Error("unused");
      },
    };

    new Schema(capture).addColumn("posts", "slug", "TEXT", { unique: true });

    expect(emitted).toBe("ALTER TABLE posts ADD COLUMN slug TEXT UNIQUE");
  });

  it("addColumn with no opts adds a plain column", () => {
    const schema = new Schema(db);

    schema.createTable("posts", (t) => t.string("title"));

    schema.addColumn("posts", "body", "TEXT");

    expect(tableInfo("posts").map((c) => c.name)).toContain("body");
  });

  it("addColumn renders string and boolean defaults", () => {
    const schema = new Schema(db);

    schema.createTable("posts", (t) => t.string("title"));

    schema.addColumn("posts", "status", "TEXT", { default: "draft" });
    schema.addColumn("posts", "published", "INTEGER", { default: true });
    schema.addColumn("posts", "archived", "INTEGER", { default: false });

    const names = tableInfo("posts").map((c) => c.name);

    expect(names).toContain("status");
    expect(names).toContain("published");
    expect(names).toContain("archived");
  });

  it("addIndex over a single column with a custom name and unique flag", () => {
    const schema = new Schema(db);

    schema.createTable("posts", (t) => t.string("slug"));

    schema.addIndex("posts", "slug", { unique: true, name: "by_slug" });

    const index = indexList("posts").find((i) => i.name === "by_slug");

    expect(index?.unique).toBe(1);
  });

  it("addIndex over an array of columns with a generated name", () => {
    const schema = new Schema(db);

    schema.createTable("posts", (t) => {
      t.string("title");
      t.integer("author_id");
    });

    schema.addIndex("posts", ["author_id", "title"]);

    const names = indexList("posts").map((i) => i.name);

    expect(names).toContain("idx_posts_author_id_title");
  });

  it("execute runs arbitrary SQL", () => {
    const schema = new Schema(db);

    schema.execute("CREATE TABLE raw (id INTEGER)");

    expect(tableInfo("raw").map((c) => c.name)).toEqual(["id"]);
  });
});

describe("Migrator", () => {
  // A small, ordered set of migrations. `002` is reversible; `001` is not, so we
  // can exercise rollback both with and without a `down`.
  const createPosts: Migration = {
    up: (s) => s.createTable("posts", (t) => t.string("title")),
  };

  const createUsers: Migration = {
    up: (s) => s.createTable("users", (t) => t.string("email")),
    down: (s) => s.dropTable("users"),
  };

  // Declared out of version order to prove the migrator sorts before running.
  const migrations: MigrationEntry[] = [
    { version: "002_create_users", migration: createUsers },
    { version: "001_create_posts", migration: createPosts },
  ];

  it("applies pending migrations in version order and is idempotent", () => {
    const migrator = new Migrator(db, migrations);

    expect(migrator.migrate()).toEqual(["001_create_posts", "002_create_users"]);

    // Both tables now exist.
    expect(tableInfo("posts").length).toBeGreaterThan(0);
    expect(tableInfo("users").length).toBeGreaterThan(0);

    // A second run applies nothing.
    expect(migrator.migrate()).toEqual([]);
  });

  it("status reflects applied and pending versions", () => {
    const migrator = new Migrator(db, migrations);

    expect(migrator.status()).toEqual([
      { version: "001_create_posts", applied: false },
      { version: "002_create_users", applied: false },
    ]);

    migrator.migrate();

    expect(migrator.status()).toEqual([
      { version: "001_create_posts", applied: true },
      { version: "002_create_users", applied: true },
    ]);
  });

  it("rollback runs down() of the most recent and removes its record", () => {
    const migrator = new Migrator(db, migrations);

    migrator.migrate();

    expect(migrator.rollback()).toBe("002_create_users");

    // down() dropped the users table, and the record is gone.
    expect(() => database.prepare("SELECT * FROM users").all()).toThrow();
    expect(migrator.status().find((s) => s.version === "002_create_users")?.applied).toBe(false);
  });

  it("rollback of a migration without down() still removes the record", () => {
    const migrator = new Migrator(db, migrations);

    migrator.migrate();
    migrator.rollback(); // drops 002_create_users

    // 001 has no down; the posts table survives but the record is cleared.
    expect(migrator.rollback()).toBe("001_create_posts");
    expect(tableInfo("posts").length).toBeGreaterThan(0);
    expect(migrator.status().every((s) => !s.applied)).toBe(true);
  });

  it("rollback returns undefined when nothing is applied", () => {
    const migrator = new Migrator(db, migrations);

    expect(migrator.rollback()).toBeUndefined();
  });
});
