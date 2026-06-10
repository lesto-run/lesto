import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  and,
  createDb,
  createTableSql,
  DbError,
  defineTable,
  dropTableSql,
  eq,
  integer,
  isNotNull,
  isNull,
  ne,
  or,
  real,
  text,
} from "../src/index";

import type { Db, InferInsert, InferRow, InferUpdate, SqlDatabase } from "../src/index";

// ---------------------------------------------------------------------------
// Test rig
//
// One in-memory SQLite per test, adapted to the package's `SqlDatabase`
// interface. better-sqlite3's variadic `run(...args)` becomes the positional
// `run(params?)` the layer above expects.
// ---------------------------------------------------------------------------

let raw: Database.Database;
let sql: SqlDatabase;
let db: Db;

function adapt(database: Database.Database): SqlDatabase {
  return {
    exec: (statement) => database.exec(statement),
    prepare: (statement) => {
      const stmt = database.prepare(statement);

      return {
        run: (params = []) => stmt.run(...(params as never[])),
        get: (params = []) => stmt.get(...(params as never[])),
        all: (params = []) => stmt.all(...(params as never[])),
      };
    },
  };
}

// The fixture schema every test uses. Spans every column type, both
// nullability states, primary key + auto-increment, unique, default.
const users = defineTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: text("email_verified_at"),
  score: integer("score").default(0),
  rating: real("rating"),
});

beforeEach(() => {
  raw = new Database(":memory:");
  sql = adapt(raw);
  db = createDb(sql);
  db.exec(createTableSql(users));
});

afterEach(() => {
  raw.close();
});

// ---------------------------------------------------------------------------
// columns + table + inference
// ---------------------------------------------------------------------------

describe("defineTable", () => {
  it("indexes columns by JS key AND by SQL column name", () => {
    expect(users.tableName).toBe("users");
    expect(users.columnList).toHaveLength(6);
    expect(users.byKey["passwordHash"]?.name).toBe("password_hash");
    expect(users.byColumn["password_hash"]).toBe("passwordHash");
  });

  it("exposes each column directly on the table (users.email)", () => {
    expect(users.email.spec.name).toBe("email");
    expect(users.email.spec.sqlType).toBe("TEXT");
    expect(users.email.spec.unique).toBe(true);
    expect(users.email.spec.nullable).toBe(false);
  });
});

describe("column builders", () => {
  it("text/integer/real seed the right SQL type", () => {
    expect(text("x").spec.sqlType).toBe("TEXT");
    expect(integer("x").spec.sqlType).toBe("INTEGER");
    expect(real("x").spec.sqlType).toBe("REAL");
  });

  it(".notNull / .unique / .default produce fresh specs (immutable chains)", () => {
    const base = text("e");

    const c = base.notNull().unique().default("hi");

    expect(base.spec.nullable).toBe(true);
    expect(c.spec.nullable).toBe(false);
    expect(c.spec.unique).toBe(true);
    expect(c.spec.hasDefault).toBe(true);
    expect(c.spec.defaultValue).toBe("hi");
  });

  it(".primaryKey marks NOT NULL; autoIncrement also marks it as having a default", () => {
    const without = integer("id").primaryKey();
    const auto = integer("id").primaryKey({ autoIncrement: true });

    expect(without.spec.primaryKey).toBe(true);
    expect(without.spec.nullable).toBe(false);
    expect(without.spec.autoIncrement).toBe(false);
    expect(without.spec.hasDefault).toBe(false);

    expect(auto.spec.primaryKey).toBe(true);
    expect(auto.spec.autoIncrement).toBe(true);
    expect(auto.spec.hasDefault).toBe(true);
  });
});

describe("inferred types (compile-time)", () => {
  it("InferRow folds nullability in; InferInsert makes optional columns optional", () => {
    // These are TYPE assertions — the test passes if it typechecks.
    type Row = InferRow<typeof users>;
    type Insert = InferInsert<typeof users>;
    type Update = InferUpdate<typeof users>;

    const row: Row = {
      id: 1,
      email: "a@b.com",
      passwordHash: "hash",
      emailVerifiedAt: null,
      score: 0,
      rating: null,
    };

    // Only required keys (notNull AND no default).
    const insert: Insert = {
      email: "a@b.com",
      passwordHash: "hash",
    };

    // Every field optional — for partial updates.
    const update: Update = { score: 42 };

    expect(row.email).toBe("a@b.com");
    expect(insert.email).toBe("a@b.com");
    expect(update.score).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

describe("DDL", () => {
  it("createTableSql renders columns with primary key, defaults, unique, NOT NULL", () => {
    const stmt = createTableSql(users);

    expect(stmt).toBe(
      'CREATE TABLE "users" ' +
        '("id" INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        '"email" TEXT NOT NULL UNIQUE, ' +
        '"password_hash" TEXT NOT NULL, ' +
        '"email_verified_at" TEXT, ' +
        '"score" INTEGER DEFAULT 0, ' +
        '"rating" REAL)',
    );
  });

  it("emits string defaults quoted and escaped; boolean defaults as 1/0; null as NULL", () => {
    const t = defineTable("samples", {
      label: text("label").default("o'connor"),
      flagOn: integer("flag_on").default(true as unknown as number),
      flagOff: integer("flag_off").default(false as unknown as number),
      empty: text("empty").default(null as unknown as string),
    });

    const stmt = createTableSql(t);

    expect(stmt).toContain("\"label\" TEXT DEFAULT 'o''connor'");
    expect(stmt).toContain('"flag_on" INTEGER DEFAULT 1');
    expect(stmt).toContain('"flag_off" INTEGER DEFAULT 0');
    expect(stmt).toContain('"empty" TEXT DEFAULT NULL');
  });

  it("primaryKey() without autoIncrement does NOT emit AUTOINCREMENT", () => {
    const t = defineTable("natural_key", {
      slug: text("slug").primaryKey(),
    });

    expect(createTableSql(t)).toBe('CREATE TABLE "natural_key" ("slug" TEXT PRIMARY KEY)');
  });

  it("dropTableSql is the matching DROP", () => {
    expect(dropTableSql(users)).toBe('DROP TABLE "users"');
  });

  it("refuses a NUL byte in an identifier", () => {
    expect(() => createTableSql(defineTable("bad\0name", { x: text("x") }))).toThrow(DbError);
  });
});

// ---------------------------------------------------------------------------
// SELECT
// ---------------------------------------------------------------------------

describe("select", () => {
  it("returns undefined for .get() when no row matches; hydrates camelCase keys", () => {
    expect(db.select().from(users).where(eq(users.email, "nobody@x")).get()).toBeUndefined();

    db.insert(users).values({ email: "ada@example.com", passwordHash: "h" }).run();

    const ada = db.select().from(users).where(eq(users.email, "ada@example.com")).get();

    expect(ada).toMatchObject({
      email: "ada@example.com",
      passwordHash: "h",
      emailVerifiedAt: null,
      score: 0,
    });
  });

  it(".all() returns every matching row in insert order", () => {
    db.insert(users).values({ email: "a@x", passwordHash: "h" }).run();
    db.insert(users).values({ email: "b@x", passwordHash: "h" }).run();
    db.insert(users).values({ email: "c@x", passwordHash: "h" }).run();

    expect(db.select().from(users).all()).toHaveLength(3);
    expect(db.select().from(users).where(ne(users.email, "b@x")).all()).toHaveLength(2);
  });

  it("hands back unknown columns unchanged (defensive — schema evolution friendly)", () => {
    db.exec('ALTER TABLE "users" ADD COLUMN extra TEXT DEFAULT NULL');
    db.exec(`INSERT INTO "users" (email, password_hash, extra) VALUES ('x@y', 'h', 'leaked')`);

    const row = db.select().from(users).where(eq(users.email, "x@y")).get() as Record<
      string,
      unknown
    >;

    expect(row["extra"]).toBe("leaked");
  });
});

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

describe("insert", () => {
  it(".returning().get() yields the hydrated inserted row", () => {
    const row = db
      .insert(users)
      .values({ email: "ada@example.com", passwordHash: "h" })
      .returning()
      .get();

    expect(row.id).toBeGreaterThan(0);
    expect(row.email).toBe("ada@example.com");
    expect(row.score).toBe(0); // the default kicked in
  });

  it(".run() returns { changes } and does NOT consume the inserted row", () => {
    const result = db.insert(users).values({ email: "ada@example.com", passwordHash: "h" }).run();

    expect(result.changes).toBe(1);
    expect(db.select().from(users).all()).toHaveLength(1);
  });

  it("only writes the columns the caller supplied (defaults stay defaults)", () => {
    const row = db
      .insert(users)
      .values({ email: "ada@example.com", passwordHash: "h", emailVerifiedAt: "2026-06-09" })
      .returning()
      .get();

    expect(row.emailVerifiedAt).toBe("2026-06-09");
  });

  it("coerces boolean payload values to 1/0 (driver-friendly)", () => {
    // `score` types `number`, but a runtime-typed boolean should still bind.
    db.insert(users)
      .values({ email: "true@y", passwordHash: "h", score: true as unknown as number })
      .run();
    db.insert(users)
      .values({ email: "false@y", passwordHash: "h", score: false as unknown as number })
      .run();

    expect(db.select().from(users).where(eq(users.email, "true@y")).get()?.score).toBe(1);
    expect(db.select().from(users).where(eq(users.email, "false@y")).get()?.score).toBe(0);
  });

  it("coerces undefined values to SQL NULL", () => {
    db.insert(users)
      .values({ email: "u@x", passwordHash: "h", emailVerifiedAt: undefined as unknown as null })
      .run();

    const row = db.select().from(users).where(eq(users.email, "u@x")).get();

    expect(row?.emailVerifiedAt).toBeNull();
  });

  it("refuses an empty input object (no columns to write)", () => {
    expect(() =>
      db
        .insert(users)
        .values({} as unknown as InferInsert<typeof users>)
        .run(),
    ).toThrow(DbError);
  });

  it("ignores keys not in the schema (no SQL injection via unknown columns)", () => {
    const row = db
      .insert(users)
      .values({
        email: "ada@example.com",
        passwordHash: "h",
        ["DROP TABLE users; --"]: 1,
      } as unknown as InferInsert<typeof users>)
      .returning()
      .get();

    expect(row.email).toBe("ada@example.com");
    // The table is intact — the attacker key was filtered, not interpolated.
    expect(db.select().from(users).all()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

describe("update", () => {
  beforeEach(() => {
    db.insert(users).values({ email: "ada@example.com", passwordHash: "old" }).run();
  });

  it("updates the matching row(s) and returns the changes count", () => {
    const result = db
      .update(users)
      .set({ passwordHash: "new" })
      .where(eq(users.email, "ada@example.com"))
      .run();

    expect(result.changes).toBe(1);
    expect(db.select().from(users).get()?.passwordHash).toBe("new");
  });

  it("refuses an empty patch", () => {
    expect(() =>
      db
        .update(users)
        .set({} as InferUpdate<typeof users>)
        .where(eq(users.email, "ada@example.com"))
        .run(),
    ).toThrow(DbError);
  });

  it("ignores keys not in the schema (defense-in-depth on the set clause)", () => {
    const result = db
      .update(users)
      .set({
        passwordHash: "new",
        ["DROP TABLE users; --"]: 1,
      } as unknown as InferUpdate<typeof users>)
      .where(eq(users.email, "ada@example.com"))
      .run();

    expect(result.changes).toBe(1);
    expect(db.select().from(users).all()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe("delete", () => {
  it("deletes the matching row(s) and returns the changes count", () => {
    db.insert(users).values({ email: "ada@example.com", passwordHash: "h" }).run();
    db.insert(users).values({ email: "bob@example.com", passwordHash: "h" }).run();

    const result = db.delete(users).where(eq(users.email, "ada@example.com")).run();

    expect(result.changes).toBe(1);
    expect(db.select().from(users).all()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// conditions
// ---------------------------------------------------------------------------

describe("conditions", () => {
  beforeEach(() => {
    db.insert(users).values({ email: "a@x", passwordHash: "h" }).run();
    db.insert(users)
      .values({ email: "b@x", passwordHash: "h", emailVerifiedAt: "2026-06-09" })
      .run();
    db.insert(users).values({ email: "c@x", passwordHash: "h" }).run();
  });

  it("ne — inequality", () => {
    const rows = db.select().from(users).where(ne(users.email, "b@x")).all();

    expect(rows.map((r) => r.email).toSorted()).toEqual(["a@x", "c@x"]);
  });

  it("isNull / isNotNull", () => {
    const unverified = db.select().from(users).where(isNull(users.emailVerifiedAt)).all();
    const verified = db.select().from(users).where(isNotNull(users.emailVerifiedAt)).all();

    expect(unverified).toHaveLength(2);
    expect(verified).toHaveLength(1);
    expect(verified[0]?.email).toBe("b@x");
  });

  it("and — every clause must match", () => {
    const rows = db
      .select()
      .from(users)
      .where(and(ne(users.email, "a@x"), isNotNull(users.emailVerifiedAt)))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe("b@x");
  });

  it("or — any clause matches", () => {
    const rows = db
      .select()
      .from(users)
      .where(or(eq(users.email, "a@x"), eq(users.email, "c@x")))
      .all();

    expect(rows.map((r) => r.email).toSorted()).toEqual(["a@x", "c@x"]);
  });

  it("and(single) / or(single) — the lone arg is returned unwrapped (no parentheses noise)", () => {
    const single = eq(users.email, "a@x");

    expect(and(single)).toBe(single);
    expect(or(single)).toBe(single);
  });

  it("boolean values bind as 1/0 in eq/ne (both arms)", () => {
    expect(eq(users.score, true as unknown as number).params).toEqual([1]);
    expect(eq(users.score, false as unknown as number).params).toEqual([0]);
  });
});
