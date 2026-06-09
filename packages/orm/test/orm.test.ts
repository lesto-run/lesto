import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  camelize,
  database,
  humanize,
  Model,
  OrmError,
  pluralize,
  resetConnection,
  singularize,
  tableize,
  underscore,
  useDatabase,
  validate,
} from "../src/index";

import type { SqlDatabase, SqlStatement } from "../src/index";

// The last SQL strings prepared, so tests can assert how identifiers were quoted.
let preparedSql: string[] = [];

// Run a block and return the SQL it prepared (used to assert injection neutralization).
function capturedSql(run: () => void): string {
  preparedSql = [];
  run();

  return preparedSql.join("\n");
}

// The DI boundary: the ORM speaks "array of positional params"; this adapter
// maps that onto better-sqlite3's variadic bind. A Postgres adapter looks the same.
function adapt(raw: Database.Database): SqlDatabase {
  return {
    prepare(sql: string): SqlStatement {
      preparedSql.push(sql);
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
  static override timestamps = true;

  static override validations = { title: { presence: true, length: { min: 3 } } };
}

class LegacyThing extends Model {
  static override tableName = "weird_table";
}

let raw: Database.Database;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.exec(`
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, body TEXT, published INTEGER, views INTEGER, meta TEXT, note TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE weird_table (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
  `);
  useDatabase(adapt(raw));
});

afterEach(() => {
  resetConnection();
  raw.close();
});

describe("inflector", () => {
  it("pluralizes", () => {
    expect(pluralize("post")).toBe("posts");
    expect(pluralize("box")).toBe("boxes");
    expect(pluralize("dish")).toBe("dishes");
    expect(pluralize("category")).toBe("categories");
    expect(pluralize("day")).toBe("days");
    expect(pluralize("person")).toBe("people");
    expect(pluralize("equipment")).toBe("equipment");
  });

  it("singularizes", () => {
    expect(singularize("posts")).toBe("post");
    expect(singularize("categories")).toBe("category");
    expect(singularize("boxes")).toBe("box");
    expect(singularize("people")).toBe("person");
    expect(singularize("equipment")).toBe("equipment");
    expect(singularize("sheep")).toBe("sheep");
  });

  it("underscores, camelizes, tableizes, humanizes", () => {
    expect(underscore("BlogPost")).toBe("blog_post");
    expect(underscore("blog-post")).toBe("blog_post");
    expect(camelize("blog_post")).toBe("BlogPost");
    expect(camelize("blog-post")).toBe("BlogPost");
    expect(camelize("blog_")).toBe("Blog");
    expect(tableize("BlogPost")).toBe("blog_posts");
    expect(humanize("created_at")).toBe("Created at");
    expect(humanize("author_id")).toBe("Author");
    expect(humanize("title")).toBe("Title");
  });
});

describe("validations", () => {
  it("validates presence, length, format, numericality, inclusion", () => {
    const rules = {
      title: { presence: true, length: { min: 2, max: 5, is: 4 } },
      email: { format: /@/ },
      age: { numericality: true },
      role: { inclusion: ["admin", "user"] },
    };

    const errors = validate(rules, { title: "x", email: "nope", age: "abc", role: "ghost" });

    expect(errors.isEmpty).toBe(false);
    expect(errors.on("title")).toEqual(
      expect.arrayContaining([
        "is too short (minimum is 2 characters)",
        "is the wrong length (should be 4 characters)",
      ]),
    );
    expect(errors.on("email")).toEqual(["is invalid"]);
    expect(errors.on("age")).toEqual(["is not a number"]);
    expect(errors.on("role")).toEqual(["is not included in the list"]);
    expect(errors.size).toBeGreaterThanOrEqual(5);
    expect(errors.full()).toContain("Title is too short (minimum is 2 characters)");
  });

  it("flags blank required and the too-long case", () => {
    const errors = validate(
      { title: { presence: true }, code: { length: { max: 2 } } },
      { code: "toolong" },
    );

    expect(errors.on("title")).toEqual(["can't be blank"]);
    expect(errors.on("code")).toEqual(["is too long (maximum is 2 characters)"]);
  });

  it("is empty when everything passes", () => {
    expect(
      validate({ title: { presence: true, length: { is: 2 } } }, { title: "ok" }).isEmpty,
    ).toBe(true);
  });

  it("skips other rules for a blank, non-required value", () => {
    const errors = validate({ bio: { length: { min: 1 } } }, {});

    expect(errors.isEmpty).toBe(true);
    expect(errors.on("anything")).toEqual([]); // unknown field → no messages
  });
});

describe("connection", () => {
  it("throws a coded error when no database is set", () => {
    resetConnection();

    try {
      database();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OrmError);
      expect((error as OrmError).code).toBe("ORM_NO_CONNECTION");
    }
  });
});

describe("Model — persistence", () => {
  it("creates, finds, and round-trips attributes", () => {
    const post = Post.create({ title: "Hello", body: "world", published: true });

    expect(post.isPersisted).toBe(true);
    expect(typeof post.id).toBe("number");

    const found = Post.find(post.id);
    expect(found.get("title")).toBe("Hello");
    expect(found.get("published")).toBe(1); // boolean normalized to 0/1
    expect(found.isNew).toBe(false);
  });

  it("infers the table and honors an explicit tableName", () => {
    expect(Post.table()).toBe("posts");
    expect(LegacyThing.table()).toBe("weird_table");
    LegacyThing.create({ name: "ok" });
    expect(LegacyThing.count()).toBe(1);
  });

  it("sets timestamps when enabled", () => {
    const post = Post.create({ title: "Timed" });

    expect(typeof post.get("created_at")).toBe("string");
    expect(typeof post.get("updated_at")).toBe("string");
  });

  it("throws ORM_RECORD_NOT_FOUND for a missing id", () => {
    try {
      Post.find(999);
      expect.unreachable();
    } catch (error) {
      expect((error as OrmError).code).toBe("ORM_RECORD_NOT_FOUND");
    }
  });

  it("findBy returns undefined when nothing matches", () => {
    expect(Post.findBy({ title: "ghost" })).toBeUndefined();
  });

  it("validates before saving", () => {
    const post = new Post({ title: "x" }); // too short
    expect(post.save()).toBe(false);
    expect(post.errors.on("title")).toContain("is too short (minimum is 3 characters)");
    expect(post.isNew).toBe(true);
  });

  it("updates, reloads, and destroys", () => {
    const post = Post.create({ title: "First" });

    expect(post.update({ title: "Second" })).toBe(true);
    expect(Post.find(post.id).get("title")).toBe("Second");

    post.set("title", "stale-in-memory");
    expect(post.reload().get("title")).toBe("Second");

    post.destroy();
    expect(post.isPersisted).toBe(false);
    expect(() => Post.find(post.id)).toThrow(OrmError);
  });

  it("normalizes booleans, objects, undefined, and null on write", () => {
    const post = Post.create({
      title: "Norm",
      published: true,
      meta: { a: 1 },
      body: undefined,
      note: null,
    });
    const row = Post.find(post.id);

    expect(row.get("published")).toBe(1);
    expect(row.get("meta")).toBe(JSON.stringify({ a: 1 }));
    expect(row.get("body")).toBeNull();
    expect(row.get("note")).toBeNull();
  });

  it("honors an explicitly-provided primary key on create", () => {
    const post = Post.create({ id: 4242, title: "Pinned" });

    expect(post.id).toBe(4242);
    expect(Post.find(4242).get("title")).toBe("Pinned"); // the row was written under the chosen id
  });

  it("still assigns a primary key when none is given", () => {
    const post = Post.create({ title: "Auto" });

    expect(typeof post.id).toBe("number");
    expect(Post.find(post.id).get("title")).toBe("Auto");
  });

  it("exposes get/set/assign/toJSON", () => {
    const post = new Post();
    post.set("title", "Set").assign({ body: "Assigned" });

    expect(post.get("title")).toBe("Set");
    expect(post.toJSON()).toMatchObject({ title: "Set", body: "Assigned" });
  });
});

describe("Model — querying (Relation)", () => {
  beforeEach(() => {
    Post.create({ title: "Alpha", published: true, views: 10 });
    Post.create({ title: "Bravo", published: false, views: 30 });
    Post.create({ title: "Charlie", published: true, views: 20 });
  });

  it("filters with equality, IN, and IS NULL", () => {
    expect(Post.where({ published: true }).count()).toBe(2);
    expect(Post.where({ published: false }).count()).toBe(1); // bindable(false) → 0
    expect(Post.where({ title: ["Alpha", "Bravo"] }).count()).toBe(2);
    expect(Post.where({ note: null }).count()).toBe(3);
    expect(Post.where({ note: undefined }).all()).toEqual([]); // bindable(undefined) → null param
  });

  it("orders, limits, offsets, plucks, and iterates", () => {
    const desc = Post.order("views", "desc").all();
    expect(desc[0]?.get("title")).toBe("Bravo");

    expect(Post.order("views", "asc").limit(1).offset(1).all()[0]?.get("title")).toBe("Charlie");
    expect(Post.limit(2).all()).toHaveLength(2); // static Model.limit
    expect(Post.all().pluck("title")).toEqual(
      expect.arrayContaining(["Alpha", "Bravo", "Charlie"]),
    );

    const titles = [...Post.all()].map((post) => post.get("title"));
    expect(titles).toHaveLength(3);
  });

  it("first respects an explicit order and defaults to the primary key", () => {
    expect(Post.order("views", "desc").all()).toHaveLength(3);
    expect(Post.where({ published: true }).order("views", "desc").first()?.get("title")).toBe(
      "Charlie",
    );
    expect(Post.all().first()?.get("title")).toBe("Alpha"); // default order by id
  });

  it("counts and checks existence", () => {
    expect(Post.count()).toBe(3);
    expect(Post.where({ published: true }).exists()).toBe(true);
    expect(Post.where({ title: "nope" }).exists()).toBe(false);
  });

  it("compiles an empty IN to a constant-false predicate (no syntax error)", () => {
    // `IN ()` is invalid SQL on Postgres; an empty set should simply match nothing.
    expect(Post.where({ title: [] }).all()).toEqual([]);
    expect(Post.where({ title: [] }).count()).toBe(0);
  });

  it("offset without limit returns the tail (emits LIMIT -1 OFFSET n)", () => {
    // A bare `OFFSET` with no `LIMIT` is a syntax error in SQLite — this must not throw.
    const tail = Post.order("views", "asc").offset(1).all();

    expect(tail.map((post) => post.get("title"))).toEqual(["Charlie", "Bravo"]);
  });
});

describe("Relation — SQL identifier safety", () => {
  beforeEach(() => {
    Post.create({ title: "Alpha", views: 10 });
  });

  it("quotes column identifiers so a where key cannot inject SQL", () => {
    // Without quoting, the malicious key would terminate the statement and run a second one.
    // Quoted, it is treated as a (non-existent) column name and the query simply runs.
    const sql = capturedSql(() => {
      try {
        Post.where({ 'title"; DROP TABLE posts; --': "x" }).all();
      } catch {
        // SQLite raises "no such column" — the point is the table still exists.
      }
    });

    expect(sql).toContain('"title""; DROP TABLE posts; --"');
    expect(Post.count()).toBe(1); // table survived
  });

  it("quotes order keys", () => {
    const sql = capturedSql(() => {
      try {
        Post.order("views; DROP TABLE posts").all();
      } catch {
        // ignored — order key is quoted as a single identifier
      }
    });

    expect(sql).toContain('ORDER BY "views; DROP TABLE posts"');
    expect(Post.count()).toBe(1);
  });

  it("quotes the pluck column", () => {
    expect(Post.all().pluck("title")).toEqual(["Alpha"]);
  });

  it("rejects an identifier containing a NUL byte", () => {
    try {
      Post.where({ "ti\0tle": "x" }).all();
      expect.unreachable();
    } catch (error) {
      expect((error as OrmError).code).toBe("ORM_UNKNOWN_COLUMN");
    }
  });

  it("enforces a declared column allowlist, rejecting unknown columns", () => {
    class Guarded extends Model {
      static override tableName = "posts";

      static override columns = ["id", "title", "views"];
    }

    expect(Guarded.where({ title: "Alpha" }).count()).toBe(1);
    expect(Guarded.order("views").all()).toHaveLength(1);

    try {
      Guarded.where({ secret: "x" }).all();
      expect.unreachable();
    } catch (error) {
      expect((error as OrmError).code).toBe("ORM_UNKNOWN_COLUMN");
    }

    try {
      Guarded.order("secret").all();
      expect.unreachable();
    } catch (error) {
      expect((error as OrmError).code).toBe("ORM_UNKNOWN_COLUMN");
    }

    try {
      Guarded.all().pluck("secret");
      expect.unreachable();
    } catch (error) {
      expect((error as OrmError).code).toBe("ORM_UNKNOWN_COLUMN");
    }
  });

  it("includes the primary key and timestamps implicitly in the allowlist", () => {
    class Timed extends Model {
      static override tableName = "posts";

      static override timestamps = true;

      static override columns = ["title"];
    }

    // first() orders by the primary key, and create() writes created_at/updated_at —
    // all must pass the allowlist even though only "title" was declared.
    const row = Timed.create({ title: "Implicit" });
    expect(row.isPersisted).toBe(true);
    expect(Timed.all().first()?.get("title")).toBe("Alpha");

    class Untimed extends Model {
      static override tableName = "weird_table";

      static override columns = ["name"];
    }

    expect(Untimed.create({ name: "ok" }).isPersisted).toBe(true);
  });
});
