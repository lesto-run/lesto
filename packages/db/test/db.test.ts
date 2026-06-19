import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  alias,
  and,
  boolean,
  createDb,
  createTableSql,
  DbError,
  defineTable,
  dropTableSql,
  eq,
  gt,
  gte,
  inList,
  integer,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  or,
  real,
  text,
  timestamp,
} from "../src/index";

import type {
  Column,
  Db,
  InferInsert,
  InferRow,
  InferUpdate,
  QueryEvent,
  SqlDatabase,
} from "../src/index";

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

  it("stamps the owning table name onto each placed column (ADR 0018 §0)", () => {
    // A free-standing builder doesn't know its table yet...
    expect(text("x").spec.tableName).toBeUndefined();
    // ...but every column reference reachable through a defined table does, so a
    // foreign-key thunk or a join can read the owning table off the column alone.
    expect(users.email.spec.tableName).toBe("users");
    expect(users.byKey["passwordHash"]?.tableName).toBe("users");
    expect(users.columnList[0]?.spec.tableName).toBe("users");
  });
});

describe("column builders", () => {
  it("text/integer/real seed the right SQL type", () => {
    expect(text("x").spec.sqlType).toBe("TEXT");
    expect(integer("x").spec.sqlType).toBe("INTEGER");
    expect(real("x").spec.sqlType).toBe("REAL");
  });

  it("boolean/timestamp carry a logical kind but store as INTEGER", () => {
    expect(boolean("x").spec.kind).toBe("boolean");
    expect(boolean("x").spec.sqlType).toBe("INTEGER");
    expect(timestamp("x").spec.kind).toBe("timestamp");
    expect(timestamp("x").spec.sqlType).toBe("INTEGER");
    // the existing three keep kind === their storage, lower-cased.
    expect(text("x").spec.kind).toBe("text");
    expect(integer("x").spec.kind).toBe("integer");
    expect(real("x").spec.kind).toBe("real");
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

describe("rich column types (boolean, timestamp)", () => {
  // A second fixture so the shared `users` table's column count stays fixed.
  const events = defineTable("events", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    active: boolean("active").notNull(),
    archived: boolean("archived"), // nullable
    occurredAt: timestamp("occurred_at").notNull(),
    deletedAt: timestamp("deleted_at"), // nullable
  });

  let edb: Db;
  let eraw: Database.Database;

  beforeEach(async () => {
    eraw = new Database(":memory:");
    edb = createDb(adapt(eraw));
    await edb.exec(createTableSql(events));
  });

  afterEach(() => {
    eraw.close();
  });

  it("DDL stores both as INTEGER (sqlite) / BIGINT (postgres)", () => {
    const sqlite = createTableSql(events);
    expect(sqlite).toContain('"active" INTEGER');
    expect(sqlite).toContain('"occurred_at" INTEGER');

    const pg = createTableSql(events, "postgres");
    expect(pg).toContain('"active" BIGINT');
    expect(pg).toContain('"occurred_at" BIGINT');
  });

  it("boolean round-trips 0/1 ⇄ false/true; timestamp round-trips epoch-ms ⇄ Date", async () => {
    const when = new Date("2026-06-18T12:34:56.000Z");

    const created = await edb
      .insert(events)
      .values({ active: true, archived: false, occurredAt: when })
      .returning()
      .get();

    expect(created.active).toBe(true);
    expect(created.archived).toBe(false);
    expect(created.occurredAt).toBeInstanceOf(Date);
    expect(created.occurredAt.getTime()).toBe(when.getTime());
  });

  it("a nullable boolean / timestamp left unset stays null (never false / Invalid Date)", async () => {
    const created = await edb
      .insert(events)
      .values({ active: false, occurredAt: new Date(0) })
      .returning()
      .get();

    expect(created.active).toBe(false); // a real `false`, not a dropped null
    expect(created.archived).toBeNull();
    expect(created.deletedAt).toBeNull();
    expect(created.occurredAt.getTime()).toBe(0);
  });

  it("a Date / boolean binds the same inside a WHERE condition as on insert", async () => {
    const early = new Date("2026-01-01T00:00:00.000Z");
    const late = new Date("2026-12-31T00:00:00.000Z");
    await edb.insert(events).values({ active: true, occurredAt: early }).run();
    await edb.insert(events).values({ active: false, occurredAt: late }).run();

    // a Date operand must marshal to epoch-ms in WHERE, exactly as it does on insert
    // (a regression here threw "SQLite3 can only bind numbers, strings, …").
    const recent = await edb.select().from(events).where(gte(events.occurredAt, late)).all();
    expect(recent.map((r) => r.occurredAt.getTime())).toEqual([late.getTime()]);

    // a Date passed to eq is an object that is NOT a column, so it binds as a value
    const exact = await edb.select().from(events).where(eq(events.occurredAt, late)).all();
    expect(exact.map((r) => r.occurredAt.getTime())).toEqual([late.getTime()]);

    // a boolean operand marshals to 1/0
    const active = await edb.select().from(events).where(eq(events.active, true)).all();
    expect(active.map((r) => r.occurredAt.getTime())).toEqual([early.getTime()]);
  });

  it("hydrates string-valued cells the same as numbers (node-postgres BIGINT path)", async () => {
    // node-postgres hands INTEGER/BIGINT columns back as *strings*; a fake driver
    // pins that wire shape so the pg coercion is proven here, not only in CI.
    const wireRow = {
      id: "1",
      active: "1",
      archived: "0",
      occurred_at: "1750000000000",
      deleted_at: null,
    };
    const fake: SqlDatabase = {
      exec: async () => undefined,
      prepare: () => ({
        run: async () => ({ changes: 0 }),
        get: async () => wireRow,
        all: async () => [wireRow],
      }),
      transaction: async (fn) => fn(fake),
    };

    const row = await createDb(fake, { dialect: "postgres" }).select().from(events).get();
    if (!row) throw new Error("expected a row");

    expect(row.active).toBe(true);
    expect(row.archived).toBe(false);
    expect(row.occurredAt).toBeInstanceOf(Date);
    expect(row.occurredAt.getTime()).toBe(1_750_000_000_000);
    expect(row.deletedAt).toBeNull();
  });

  it("a timestamp default stores epoch-ms, so its DDL is a valid integer literal", () => {
    const stamped = timestamp("created_at").default(new Date(123_456));
    expect(stamped.spec.defaultValue).toBe(123_456);

    const withDefault = defineTable("with_default", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      createdAt: timestamp("created_at").notNull().default(new Date(123_456)),
    });
    expect(createTableSql(withDefault)).toContain("DEFAULT 123456");
  });
});

describe("foreign keys", () => {
  const authors = defineTable("authors", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
  });

  it(".references stores the (thunk) target and actions on the spec", () => {
    const col = integer("author_id").references(() => authors.id, { onDelete: "cascade" });
    expect(col.spec.references?.resolve().spec.name).toBe("id");
    expect(col.spec.references?.onDelete).toBe("cascade");
    expect(col.spec.references?.onUpdate).toBeUndefined();
  });

  it("renders an inline REFERENCES clause, identical on both dialects", () => {
    const posts = defineTable("posts", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      authorId: integer("author_id")
        .notNull()
        .references(() => authors.id),
    });

    expect(createTableSql(posts)).toContain(
      '"author_id" INTEGER NOT NULL REFERENCES "authors"("id")',
    );
    // The FK SQL is ANSI-standard, so only the integer width forks (BIGINT on pg).
    expect(createTableSql(posts, "postgres")).toContain(
      '"author_id" BIGINT NOT NULL REFERENCES "authors"("id")',
    );
  });

  it("appends ON DELETE / ON UPDATE actions only when given", () => {
    const withActions = defineTable("with_actions", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      authorId: integer("author_id").references(() => authors.id, {
        onDelete: "cascade",
        onUpdate: "restrict",
      }),
    });

    expect(createTableSql(withActions)).toContain(
      'REFERENCES "authors"("id") ON DELETE CASCADE ON UPDATE RESTRICT',
    );
  });

  it("resolves a self-reference at render time", () => {
    // A self-reference needs the thunk's return type annotated to break TS's
    // circular inference (the table is defined in terms of itself) — the same
    // small ceremony Drizzle requires; the runtime resolution is unaffected.
    const employees = defineTable("employees", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      managerId: integer("manager_id").references((): Column<number> => employees.id, {
        onDelete: "set null",
      }),
    });

    expect(createTableSql(employees)).toContain(
      '"manager_id" INTEGER REFERENCES "employees"("id") ON DELETE SET NULL',
    );
  });

  it("refuses (fail-loud) a reference to a column that is not part of a table", () => {
    const broken = defineTable("broken", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      ref: integer("ref").references(() => integer("orphan")),
    });

    let thrown: unknown;
    try {
      createTableSql(broken);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DbError);
    expect((thrown as DbError).code).toBe("DB_UNRESOLVED_REFERENCE");
  });
});

describe("joins", () => {
  const authors = defineTable("authors", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
  });
  const posts = defineTable("posts", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    authorId: integer("author_id").references(() => authors.id), // nullable
    title: text("title").notNull(),
  });
  const comments = defineTable("comments", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id),
    body: text("body").notNull(),
  });

  let jdb: Db;
  let jraw: Database.Database;
  let adaId: number;
  let enginesPost: number;

  beforeEach(async () => {
    jraw = new Database(":memory:");
    jdb = createDb(adapt(jraw));
    for (const table of [authors, posts, comments]) await jdb.exec(createTableSql(table));

    const ada = await jdb.insert(authors).values({ name: "Ada" }).returning().get();
    await jdb.insert(authors).values({ name: "Grace" }).returning().get(); // no posts
    adaId = ada.id;

    const p1 = await jdb
      .insert(posts)
      .values({ authorId: ada.id, title: "On Engines" })
      .returning()
      .get();
    await jdb.insert(posts).values({ authorId: ada.id, title: "On Looms" }).run();
    await jdb.insert(posts).values({ title: "Orphan" }).run(); // authorId null → no match
    enginesPost = p1.id;
    await jdb.insert(comments).values({ postId: p1.id, body: "yes" }).run();
  });

  afterEach(() => {
    jraw.close();
  });

  it("innerJoin namespaces rows by table; same-named `id` columns never collide", async () => {
    const rows = await jdb
      .select()
      .from(posts)
      .innerJoin(authors, eq(posts.authorId, authors.id))
      .orderBy(posts.title)
      .all();

    // only Ada's two posts match (the orphan's null authorId matches no author)
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.posts.title)).toEqual(["On Engines", "On Looms"]);
    expect(rows.every((r) => r.authors.name === "Ada")).toBe(true);
    // distinct namespaces: the post's id and its author's id are both present and
    // each correct, even when the auto-increment sequences happen to coincide (the
    // first post and the first author both get id 1 — a flat row would clobber one).
    expect(rows[0]?.authors.id).toBe(adaId);
    expect(rows[0]?.posts.id).toBe(enginesPost);
  });

  it("leftJoin yields null for the unmatched side", async () => {
    const rows = await jdb
      .select()
      .from(authors)
      .leftJoin(posts, eq(posts.authorId, authors.id))
      .all();

    const grace = rows.filter((r) => r.authors.name === "Grace");
    expect(grace).toHaveLength(1);
    expect(grace[0]?.posts).toBeNull(); // no post → the whole namespace is null, not {id:null,…}

    const ada = rows.filter((r) => r.authors.name === "Ada");
    expect(ada).toHaveLength(2);
    expect(ada.every((r) => r.posts !== null)).toBe(true);
  });

  it("projects qualified-aliased columns and a qualified ON", async () => {
    let captured = "";
    const spy = createDb(adapt(jraw), {
      onQuery: (event) => {
        captured = event.sql;
      },
    });
    await spy.select().from(posts).innerJoin(authors, eq(posts.authorId, authors.id)).all();

    expect(captured).toContain('"posts"."id" AS "posts.id"');
    expect(captured).toContain('"authors"."name" AS "authors.name"');
    expect(captured).toContain(
      'FROM "posts" INNER JOIN "authors" ON "posts"."author_id" = "authors"."id"',
    );
  });

  it("filters a join with a where across both tables", async () => {
    const rows = await jdb
      .select()
      .from(posts)
      .innerJoin(authors, eq(posts.authorId, authors.id))
      .where(eq(authors.name, "Ada"))
      .all();
    expect(rows).toHaveLength(2);
  });

  it("orders, limits, and offsets a join", async () => {
    const page = await jdb
      .select()
      .from(posts)
      .innerJoin(authors, eq(posts.authorId, authors.id))
      .orderBy(posts.title, "desc")
      .limit(1)
      .all();
    expect(page.map((r) => r.posts.title)).toEqual(["On Looms"]);

    const tail = await jdb
      .select()
      .from(posts)
      .innerJoin(authors, eq(posts.authorId, authors.id))
      .orderBy(posts.title)
      .offset(1)
      .all();
    expect(tail.map((r) => r.posts.title)).toEqual(["On Looms"]);
  });

  it("get returns one namespaced row, or undefined for no match", async () => {
    const hit = await jdb
      .select()
      .from(posts)
      .innerJoin(authors, eq(posts.authorId, authors.id))
      .where(eq(posts.title, "On Engines"))
      .get();
    expect(hit?.authors.name).toBe("Ada");

    const miss = await jdb
      .select()
      .from(posts)
      .innerJoin(authors, eq(posts.authorId, authors.id))
      .where(eq(posts.title, "nope"))
      .get();
    expect(miss).toBeUndefined();
  });

  it("chains a third table — innerJoin then leftJoin off the join", async () => {
    const rows = await jdb
      .select()
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id)) // SelectQuery.innerJoin
      .leftJoin(authors, eq(posts.authorId, authors.id)) // JoinQuery.leftJoin
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.comments.body).toBe("yes");
    expect(rows[0]?.posts.id).toBe(enginesPost);
    expect(rows[0]?.authors?.name).toBe("Ada");
  });

  it("chains via leftJoin then innerJoin off the join", async () => {
    const rows = await jdb
      .select()
      .from(authors)
      .leftJoin(posts, eq(posts.authorId, authors.id)) // SelectQuery.leftJoin
      .innerJoin(comments, eq(comments.postId, posts.id)) // JoinQuery.innerJoin — drops null-post rows
      .all();
    // only the (Ada → On Engines → "yes") chain survives the inner comments join
    expect(rows).toHaveLength(1);
    expect(rows[0]?.comments.body).toBe("yes");
  });

  it("joins a table to itself through alias()", async () => {
    const employees = defineTable("employees", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      name: text("name").notNull(),
      managerId: integer("manager_id"),
    });
    await jdb.exec(createTableSql(employees));
    const ceo = await jdb.insert(employees).values({ name: "CEO" }).returning().get();
    await jdb.insert(employees).values({ name: "Alice", managerId: ceo.id }).run();

    const manager = alias(employees, "manager");
    const rows = await jdb
      .select()
      .from(employees)
      .innerJoin(manager, eq(employees.managerId, manager.id))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.employees.name).toBe("Alice");
    expect(rows[0]?.manager.name).toBe("CEO");
  });

  it("a double alias still resolves to the real table", () => {
    const m1 = alias(authors, "m1");
    const m2 = alias(m1, "m2");
    expect(m1.sourceTableName).toBe("authors");
    expect(m2.sourceTableName).toBe("authors"); // not "m1" — FROM "authors" AS "m2"
  });

  it("a column whose SQL name contains a dot round-trips intact (no key mis-split)", async () => {
    // The hardest hydration case: a column whose SQL name itself contains a dot.
    // The projection aliases it `"weird"."a.b" AS "weird.a.b"` — so a hydrator that
    // split a result key on the LAST dot (or naively on every dot) would read the
    // namespace as `weird.a` and lose the column. hydrateJoin reconstructs the EXACT
    // alias (`namespace + "." + name`) and reads by it, so a dotted name can never be
    // mis-parsed. Pin the wire row to prove it without a driver-quoting detour.
    const weird = defineTable("weird", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      dotted: text("a.b").notNull(),
    });
    const sidecar = defineTable("sidecar", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      weirdId: integer("weird_id").notNull(),
    });

    // Keys are exactly the aliases the projection writes.
    const wireRow = {
      "weird.id": 1,
      "weird.a.b": "kept",
      "sidecar.id": 5,
      "sidecar.weird_id": 1,
    };
    const fake: SqlDatabase = {
      exec: async () => undefined,
      prepare: () => ({
        run: async () => ({ changes: 0 }),
        get: async () => wireRow,
        all: async () => [wireRow],
      }),
      transaction: async (fn) => fn(fake),
    };

    const [row] = await createDb(fake)
      .select()
      .from(weird)
      .innerJoin(sidecar, eq(sidecar.weirdId, weird.id))
      .all();

    // The dotted-name column kept its value under the right namespace; the sidecar
    // namespace is distinct and intact.
    expect(row?.weird.dotted).toBe("kept");
    expect(row?.weird.id).toBe(1);
    expect(row?.sidecar.id).toBe(5);
    expect(row?.sidecar.weirdId).toBe(1);
  });

  it("aliasing onto a name another table already uses fails loud and coded", () => {
    // alias(posts, "authors") collides with the base `authors` namespace: both would
    // project `"authors".* AS "authors.*"` and overwrite each other. Refuse it.
    expect(() =>
      jdb.select().from(authors).innerJoin(alias(posts, "authors"), eq(posts.authorId, authors.id)),
    ).toThrow(DbError);
  });

  it("a left-joined row of all-NULL columns collapses to null (documented limit)", async () => {
    // Pin the known limitation: a matched left-joined row whose every projected cell
    // is null is indistinguishable from no-match. `nullable_only` has no NOT NULL
    // column, so a real match of (null, null) collapses to `null`.
    const anchor = defineTable("anchor", {
      id: integer("id").primaryKey({ autoIncrement: true }),
    });
    const nullableOnly = defineTable("nullable_only", {
      a: integer("a"),
      b: text("b"),
    });

    const wireRow = { "anchor.id": 1, "nullable_only.a": null, "nullable_only.b": null };
    const fake: SqlDatabase = {
      exec: async () => undefined,
      prepare: () => ({
        run: async () => ({ changes: 0 }),
        get: async () => wireRow,
        all: async () => [wireRow],
      }),
      transaction: async (fn) => fn(fake),
    };

    const [row] = await createDb(fake)
      .select()
      .from(anchor)
      .leftJoin(nullableOnly, eq(anchor.id, anchor.id))
      .all();

    expect(row?.anchor.id).toBe(1);
    expect(row?.nullable_only).toBeNull(); // the documented lossy edge
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

  it("postgres: AUTOINCREMENT becomes an identity column and INTEGER widens to BIGINT", () => {
    const stmt = createTableSql(users, "postgres");

    expect(stmt).toBe(
      'CREATE TABLE "users" ' +
        '("id" BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY, ' +
        '"email" TEXT NOT NULL UNIQUE, ' +
        '"password_hash" TEXT NOT NULL, ' +
        '"email_verified_at" TEXT, ' +
        '"score" BIGINT DEFAULT 0, ' +
        '"rating" REAL)',
    );
  });

  it("postgres: a non-auto-increment INTEGER primary key still widens to BIGINT", () => {
    const t = defineTable("counters", {
      id: integer("id").primaryKey(),
    });

    expect(createTableSql(t, "postgres")).toBe('CREATE TABLE "counters" ("id" BIGINT PRIMARY KEY)');
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

    it("coerces a numeric column returned as a string (node-postgres BIGINT) to a number", async () => {
      // node-postgres hands BIGINT/numeric back as a string; the hydrator must
      // coerce numeric columns so `InferRow` (which types `id`/`score` as number)
      // is honest. A TEXT column that happens to look numeric stays a string.
      const row = { id: "42", email: "ada@x", score: "7", rating: "1.5" };
      const capture: SqlDatabase = {
        prepare: () => ({
          run: async () => ({ changes: 0 }),
          get: async () => row,
          all: async () => [row],
        }),
        exec: async () => {},
        transaction: async (fn) => fn(capture),
      };

      const got = await createDb(capture).select().from(users).get();

      expect(got).toEqual({ id: 42, email: "ada@x", score: 7, rating: 1.5 });
      expect(typeof got?.id).toBe("number");
      expect(typeof got?.email).toBe("string");
    });

    it("postgres dialect: offset-without-limit renders a bare OFFSET (no LIMIT -1)", async () => {
      // Capture the SQL the dialect renders without needing a real Postgres: the
      // `LIMIT -1` idiom is a SQLite-ism Postgres rejects, so the PG path must emit
      // a bare `OFFSET`. We assert the rendered statement, not a row set.
      let captured = "";
      const capture: SqlDatabase = {
        prepare: (stmt) => {
          captured = stmt;

          return {
            run: async () => ({ changes: 0 }),
            get: async () => undefined,
            all: async () => [],
          };
        },
        exec: async () => {},
        transaction: async (fn) => fn(capture),
      };

      const pg = createDb(capture, { dialect: "postgres" });
      await pg.select().from(users).orderBy(users.email).offset(1).all();

      expect(captured).toContain("OFFSET 1");
      expect(captured).not.toContain("LIMIT -1");
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
  it("qualifies a placed column by its table; a free-standing column renders bare", () => {
    // A column reachable through a table qualifies — unambiguous the moment a query
    // joins (ADR 0018 §3); a builder never placed in a table has no table to name.
    expect(eq(users.email, "a@x").sql).toBe('"users"."email" = ?');
    expect(eq(text("loose"), "x").sql).toBe('"loose" = ?');
  });

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

  it("gt / gte / lt / lte — numeric comparisons", async () => {
    // Seed distinct scores: a@x=10, b@x=20, c@x=30.
    await db.update(users).set({ score: 10 }).where(eq(users.email, "a@x")).run();
    await db.update(users).set({ score: 20 }).where(eq(users.email, "b@x")).run();
    await db.update(users).set({ score: 30 }).where(eq(users.email, "c@x")).run();

    const gtRows = await db.select().from(users).where(gt(users.score, 20)).all();
    expect(gtRows.map((r) => r.email)).toEqual(["c@x"]);

    const gteRows = await db.select().from(users).where(gte(users.score, 20)).all();
    expect(gteRows.map((r) => r.email).toSorted()).toEqual(["b@x", "c@x"]);

    const ltRows = await db.select().from(users).where(lt(users.score, 20)).all();
    expect(ltRows.map((r) => r.email)).toEqual(["a@x"]);

    const lteRows = await db.select().from(users).where(lte(users.score, 20)).all();
    expect(lteRows.map((r) => r.email).toSorted()).toEqual(["a@x", "b@x"]);
  });

  it("inList — membership, single, and the empty-set short-circuit", async () => {
    const some = await db
      .select()
      .from(users)
      .where(inList(users.email, ["a@x", "c@x"]))
      .all();
    expect(some.map((r) => r.email).toSorted()).toEqual(["a@x", "c@x"]);

    const one = await db
      .select()
      .from(users)
      .where(inList(users.email, ["b@x"]))
      .all();
    expect(one.map((r) => r.email)).toEqual(["b@x"]);

    // An empty list matches nothing (renders `1 = 0`), never throws on `IN ()`.
    const empty = inList(users.email, []);
    expect(empty).toEqual({ sql: "1 = 0", params: [] });
    expect(await db.select().from(users).where(empty).all()).toEqual([]);
  });

  it("like — pattern match with bound wildcards", async () => {
    const rows = await db.select().from(users).where(like(users.email, "a%")).all();
    expect(rows.map((r) => r.email)).toEqual(["a@x"]);

    // The pattern is a bound parameter — the value is never interpolated.
    expect(like(users.email, "a%").params).toEqual(["a%"]);
  });
});

describe("raw", () => {
  beforeEach(async () => {
    await db.insert(users).values({ email: "a@x", passwordHash: "h", score: 1 }).run();
    await db.insert(users).values({ email: "b@x", passwordHash: "h", score: 2 }).run();
  });

  it("runs a parameterized query and returns the raw rows", async () => {
    const rows = await db.raw<{ email: string }>(
      "SELECT email FROM users WHERE score >= ? ORDER BY email",
      [2],
    );

    expect(rows).toEqual([{ email: "b@x" }]);
  });

  it("defaults params to empty and returns [] for a parameterless read with no match", async () => {
    const rows = await db.raw("SELECT email FROM users WHERE score > 99");

    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// onQuery — the observability seam
// ---------------------------------------------------------------------------

describe("onQuery observability seam", () => {
  it("fires once per executed query (select/insert/update/delete/raw), with a measured duration", async () => {
    const events: QueryEvent[] = [];
    const observed = createDb(sql, { onQuery: (event) => events.push(event) });

    await observed.insert(users).values({ email: "ada@x", passwordHash: "h" }).run();
    await observed.insert(users).values({ email: "bob@x", passwordHash: "h" }).returning().get();
    await observed.select().from(users).all();
    await observed.select().from(users).where(eq(users.email, "ada@x")).get();
    await observed.select().from(users).count();
    await observed.update(users).set({ passwordHash: "n" }).where(eq(users.email, "ada@x")).run();
    await observed.delete(users).where(eq(users.email, "bob@x")).run();
    await observed.raw("SELECT email FROM users");

    // One event per executed statement — eight in all.
    expect(events).toHaveLength(8);

    // Every event names the SQL it timed and carries a finite, non-negative
    // duration in milliseconds.
    for (const event of events) {
      expect(typeof event.sql).toBe("string");
      expect(event.sql.length).toBeGreaterThan(0);
      expect(typeof event.durationMs).toBe("number");
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(event.durationMs)).toBe(true);
    }

    // A spot-check that the reported SQL is the real statement, not a placeholder.
    expect(events.some((event) => event.sql.includes("INSERT INTO"))).toBe(true);
    expect(events.some((event) => event.sql.includes("COUNT(*)"))).toBe(true);
  });

  it("does NOT fire for exec (no statement is run)", async () => {
    const events: QueryEvent[] = [];
    const observed = createDb(sql, { onQuery: (event) => events.push(event) });

    await observed.exec('CREATE TABLE IF NOT EXISTS "noop" ("x" TEXT)');

    expect(events).toEqual([]);
  });

  it("a throwing sink is contained — it never breaks the query or its result", async () => {
    const observed = createDb(sql, {
      onQuery: () => {
        throw new Error("sink exploded");
      },
    });

    // The insert and the read both succeed despite the reporter throwing.
    await expect(
      observed.insert(users).values({ email: "ok@x", passwordHash: "h" }).run(),
    ).resolves.toMatchObject({ changes: 1 });

    const row = await observed.select().from(users).where(eq(users.email, "ok@x")).get();
    expect(row?.email).toBe("ok@x");
  });

  it("a transaction inherits the sink — spans inside it report too", async () => {
    const events: QueryEvent[] = [];
    const observed = createDb(sql, { onQuery: (event) => events.push(event) });

    await observed.transaction(async (tx) => {
      await tx.insert(users).values({ email: "tx@x", passwordHash: "h" }).run();
    });

    // The insert inside the transaction reported through the inherited sink.
    expect(events.some((event) => event.sql.includes("INSERT INTO"))).toBe(true);
  });
});
