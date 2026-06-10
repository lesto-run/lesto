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
// interface. The terminals are async (ADR 0006): the synchronous better-sqlite3
// engine is wrapped so each terminal resolves a Promise (zero latency); prepare()
// stays sync. `transaction()` brackets BEGIN/COMMIT (ROLLBACK on reject) over the
// single in-memory connection.
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
        run: async (params = []) => stmt.run(...(params as never[])),
        get: async (params = []) => stmt.get(...(params as never[])),
        all: async (params = []) => stmt.all(...(params as never[])),
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

beforeEach(async () => {
  raw = new Database(":memory:");
  sql = adapt(raw);
  db = createDb(sql);
  await db.exec(createTableSql(users));
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
  it("returns undefined for .get() when no row matches; hydrates camelCase keys", async () => {
    expect(await db.select().from(users).where(eq(users.email, "nobody@x")).get()).toBeUndefined();

    await db.insert(users).values({ email: "ada@example.com", passwordHash: "h" }).run();

    const ada = await db.select().from(users).where(eq(users.email, "ada@example.com")).get();

    expect(ada).toMatchObject({
      email: "ada@example.com",
      passwordHash: "h",
      emailVerifiedAt: null,
      score: 0,
    });
  });

  it(".all() returns every matching row in insert order", async () => {
    await db.insert(users).values({ email: "a@x", passwordHash: "h" }).run();
    await db.insert(users).values({ email: "b@x", passwordHash: "h" }).run();
    await db.insert(users).values({ email: "c@x", passwordHash: "h" }).run();

    expect(await db.select().from(users).all()).toHaveLength(3);
    expect(await db.select().from(users).where(ne(users.email, "b@x")).all()).toHaveLength(2);
  });

  it("hands back unknown columns unchanged (defensive — schema evolution friendly)", async () => {
    await db.exec('ALTER TABLE "users" ADD COLUMN extra TEXT DEFAULT NULL');
    await db.exec(
      `INSERT INTO "users" (email, password_hash, extra) VALUES ('x@y', 'h', 'leaked')`,
    );

    const row = (await db.select().from(users).where(eq(users.email, "x@y")).get()) as Record<
      string,
      unknown
    >;

    expect(row["extra"]).toBe("leaked");
  });
});

// ---------------------------------------------------------------------------
// select modifiers — orderBy / limit / offset / count
// ---------------------------------------------------------------------------

describe("select modifiers", () => {
  // Insert a small, deterministic set we can order + paginate over.
  beforeEach(async () => {
    await db.insert(users).values({ email: "c@x", passwordHash: "h", score: 30 }).run();
    await db.insert(users).values({ email: "a@x", passwordHash: "h", score: 10 }).run();
    await db.insert(users).values({ email: "b@x", passwordHash: "h", score: 20 }).run();
  });

  describe("orderBy", () => {
    it("defaults to ascending when no direction is supplied", async () => {
      const rows = await db.select().from(users).orderBy(users.email).all();

      expect(rows.map((r) => r.email)).toEqual(["a@x", "b@x", "c@x"]);
    });

    it("descending sorts the other way", async () => {
      const rows = await db.select().from(users).orderBy(users.score, "desc").all();

      expect(rows.map((r) => r.score)).toEqual([30, 20, 10]);
    });

    it("last orderBy wins (idiomatic chain replacement)", async () => {
      const rows = await db
        .select()
        .from(users)
        .orderBy(users.email)
        .orderBy(users.score, "desc")
        .all();

      expect(rows.map((r) => r.score)).toEqual([30, 20, 10]);
    });

    it("composes with where", async () => {
      const rows = await db
        .select()
        .from(users)
        .where(ne(users.email, "b@x"))
        .orderBy(users.score, "desc")
        .all();

      expect(rows.map((r) => r.email)).toEqual(["c@x", "a@x"]);
    });
  });

  describe("limit", () => {
    it("caps the row count", async () => {
      const rows = await db.select().from(users).orderBy(users.email).limit(2).all();

      expect(rows.map((r) => r.email)).toEqual(["a@x", "b@x"]);
    });

    it(".get() is implicitly LIMIT 1 and overrides a larger .limit()", async () => {
      const row = await db.select().from(users).orderBy(users.email).limit(5).get();

      expect(row?.email).toBe("a@x");
    });
  });

  describe("offset", () => {
    it("with limit, skips then yields", async () => {
      const rows = await db.select().from(users).orderBy(users.email).limit(2).offset(1).all();

      expect(rows.map((r) => r.email)).toEqual(["b@x", "c@x"]);
    });

    it("without limit, emits LIMIT -1 OFFSET n (SQLite-friendly)", async () => {
      const rows = await db.select().from(users).orderBy(users.email).offset(1).all();

      // Two rows after skipping the first.
      expect(rows.map((r) => r.email)).toEqual(["b@x", "c@x"]);
    });
  });

  describe("count", () => {
    it("counts every row when no where is set", async () => {
      expect(await db.select().from(users).count()).toBe(3);
    });

    it("honors the where clause", async () => {
      expect(await db.select().from(users).where(ne(users.email, "b@x")).count()).toBe(2);
    });

    it("ignores orderBy/limit/offset (a limited count is almost always a bug)", async () => {
      // The user asked for at most 1 row, but we count the full match set.
      expect(
        await db.select().from(users).orderBy(users.score, "desc").limit(1).offset(99).count(),
      ).toBe(3);
    });
  });
});

// ---------------------------------------------------------------------------
// INSERT
// ---------------------------------------------------------------------------

describe("insert", () => {
  it(".returning().get() yields the hydrated inserted row", async () => {
    const row = await db
      .insert(users)
      .values({ email: "ada@example.com", passwordHash: "h" })
      .returning()
      .get();

    expect(row.id).toBeGreaterThan(0);
    expect(row.email).toBe("ada@example.com");
    expect(row.score).toBe(0); // the default kicked in
  });

  it(".run() returns { changes } and does NOT consume the inserted row", async () => {
    const result = await db
      .insert(users)
      .values({ email: "ada@example.com", passwordHash: "h" })
      .run();

    expect(result.changes).toBe(1);
    expect(await db.select().from(users).all()).toHaveLength(1);
  });

  it("only writes the columns the caller supplied (defaults stay defaults)", async () => {
    const row = await db
      .insert(users)
      .values({ email: "ada@example.com", passwordHash: "h", emailVerifiedAt: "2026-06-09" })
      .returning()
      .get();

    expect(row.emailVerifiedAt).toBe("2026-06-09");
  });

  it("coerces boolean payload values to 1/0 (driver-friendly)", async () => {
    // `score` types `number`, but a runtime-typed boolean should still bind.
    await db
      .insert(users)
      .values({ email: "true@y", passwordHash: "h", score: true as unknown as number })
      .run();
    await db
      .insert(users)
      .values({ email: "false@y", passwordHash: "h", score: false as unknown as number })
      .run();

    expect((await db.select().from(users).where(eq(users.email, "true@y")).get())?.score).toBe(1);
    expect((await db.select().from(users).where(eq(users.email, "false@y")).get())?.score).toBe(0);
  });

  it("coerces undefined values to SQL NULL", async () => {
    await db
      .insert(users)
      .values({ email: "u@x", passwordHash: "h", emailVerifiedAt: undefined as unknown as null })
      .run();

    const row = await db.select().from(users).where(eq(users.email, "u@x")).get();

    expect(row?.emailVerifiedAt).toBeNull();
  });

  it("refuses an empty input object (no columns to write)", async () => {
    await expect(
      db
        .insert(users)
        .values({} as unknown as InferInsert<typeof users>)
        .run(),
    ).rejects.toThrow(DbError);
  });

  it("ignores keys not in the schema (no SQL injection via unknown columns)", async () => {
    const row = await db
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
    expect(await db.select().from(users).all()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

describe("update", () => {
  beforeEach(async () => {
    await db.insert(users).values({ email: "ada@example.com", passwordHash: "old" }).run();
  });

  it("updates the matching row(s) and returns the changes count", async () => {
    const result = await db
      .update(users)
      .set({ passwordHash: "new" })
      .where(eq(users.email, "ada@example.com"))
      .run();

    expect(result.changes).toBe(1);
    expect((await db.select().from(users).get())?.passwordHash).toBe("new");
  });

  it("refuses an empty patch", () => {
    // The empty-patch guard throws synchronously inside `.set()` — before any
    // async terminal — so this is a plain synchronous throw.
    expect(() =>
      db
        .update(users)
        .set({} as InferUpdate<typeof users>)
        .where(eq(users.email, "ada@example.com"))
        .run(),
    ).toThrow(DbError);
  });

  it("ignores keys not in the schema (defense-in-depth on the set clause)", async () => {
    const result = await db
      .update(users)
      .set({
        passwordHash: "new",
        ["DROP TABLE users; --"]: 1,
      } as unknown as InferUpdate<typeof users>)
      .where(eq(users.email, "ada@example.com"))
      .run();

    expect(result.changes).toBe(1);
    expect(await db.select().from(users).all()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe("delete", () => {
  it("deletes the matching row(s) and returns the changes count", async () => {
    await db.insert(users).values({ email: "ada@example.com", passwordHash: "h" }).run();
    await db.insert(users).values({ email: "bob@example.com", passwordHash: "h" }).run();

    const result = await db.delete(users).where(eq(users.email, "ada@example.com")).run();

    expect(result.changes).toBe(1);
    expect(await db.select().from(users).all()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// transaction
// ---------------------------------------------------------------------------

describe("transaction", () => {
  it("commits the whole span when the callback resolves", async () => {
    await db.transaction(async (tx) => {
      await tx.insert(users).values({ email: "tx@x", passwordHash: "h" }).run();
      await tx.insert(users).values({ email: "tx2@x", passwordHash: "h" }).run();
    });

    expect(await db.select().from(users).all()).toHaveLength(2);
  });

  it("rolls back the whole span when the callback rejects, re-raising the error", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(users).values({ email: "rb@x", passwordHash: "h" }).run();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The insert inside the rolled-back span left no row.
    expect(await db.select().from(users).where(eq(users.email, "rb@x")).get()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// conditions
// ---------------------------------------------------------------------------

describe("conditions", () => {
  beforeEach(async () => {
    await db.insert(users).values({ email: "a@x", passwordHash: "h" }).run();
    await db
      .insert(users)
      .values({ email: "b@x", passwordHash: "h", emailVerifiedAt: "2026-06-09" })
      .run();
    await db.insert(users).values({ email: "c@x", passwordHash: "h" }).run();
  });

  it("ne — inequality", async () => {
    const rows = await db.select().from(users).where(ne(users.email, "b@x")).all();

    expect(rows.map((r) => r.email).toSorted()).toEqual(["a@x", "c@x"]);
  });

  it("isNull / isNotNull", async () => {
    const unverified = await db.select().from(users).where(isNull(users.emailVerifiedAt)).all();
    const verified = await db.select().from(users).where(isNotNull(users.emailVerifiedAt)).all();

    expect(unverified).toHaveLength(2);
    expect(verified).toHaveLength(1);
    expect(verified[0]?.email).toBe("b@x");
  });

  it("and — every clause must match", async () => {
    const rows = await db
      .select()
      .from(users)
      .where(and(ne(users.email, "a@x"), isNotNull(users.emailVerifiedAt)))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe("b@x");
  });

  it("or — any clause matches", async () => {
    const rows = await db
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
