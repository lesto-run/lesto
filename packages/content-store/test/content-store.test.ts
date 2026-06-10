import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getCollection, getEntry, type RuntimeEntry } from "@keel/content-core";
import { Migrator, type SqlDatabase } from "@keel/migrate";

import {
  CONTENT_ENTRIES_TABLE,
  ContentStoreError,
  contentEntriesMigration,
  createEntry,
  deleteEntry,
  hydrateRuntime,
  loadEntries,
  loadEntry,
  persistEntries,
  pruneEntries,
  updateEntry,
} from "../src/index";

// A ~6-line adapter wrapping better-sqlite3 in the minimal SqlDatabase shape —
// the same seam every Keel data package is built on.
let raw: Database.Database;
let db: SqlDatabase;

function adapt(database: Database.Database): SqlDatabase {
  return {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => {
      const statement = database.prepare(sql);

      return {
        run: (params = []) => statement.run(...(params as never[])),
        all: (params = []) => statement.all(...(params as never[])),
      };
    },
  };
}

// A valid entry with the metadata content-core attaches to every document.
function makeEntry(collection: string, id: string, data: Record<string, unknown>): RuntimeEntry {
  return {
    id,
    collection,
    file: {
      path: `${collection}/${id}.md`,
      fileName: `${id}.md`,
      extension: ".md",
      directory: collection,
      pathSegments: [id],
      isIndex: false,
    },
    ...data,
  };
}

const HELLO = makeEntry("posts", "hello", {
  slug: "hello",
  status: "published",
  date: "2024-01-01",
  title: "Hello",
  content: "# Hello",
});

const DRAFT = makeEntry("posts", "draft", {
  slug: "draft-post",
  status: "draft",
  publishedAt: "2024-02-01",
  title: "Draft",
  content: "wip",
});

// No slug (falls back to id), no status, no date — exercises every null path.
const ABOUT = makeEntry("pages", "about", {
  title: "About",
  content: "about us",
});

beforeEach(async () => {
  raw = new Database(":memory:");
  db = adapt(raw);
  await new Migrator(db, [contentEntriesMigration]).migrate();
});

afterEach(() => {
  raw.close();
});

describe("the migration", () => {
  it("creates the content_entries table", () => {
    const row = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(CONTENT_ENTRIES_TABLE);

    expect(row).toEqual({ name: CONTENT_ENTRIES_TABLE });
  });

  it("rolls back, dropping the table", async () => {
    await new Migrator(db, [contentEntriesMigration]).rollback();

    const row = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(CONTENT_ENTRIES_TABLE);

    expect(row).toBeUndefined();
  });
});

describe("persistEntries", () => {
  it("writes every entry and reports the count", async () => {
    const result = await persistEntries(db, [HELLO, DRAFT, ABOUT], { now: () => 1000 });

    expect(result).toEqual({ persisted: 3 });
  });

  it("lifts slug, status and publish date into their own columns", async () => {
    await persistEntries(db, [HELLO, DRAFT, ABOUT], { now: () => 1000 });

    const rows = raw
      .prepare(
        `SELECT entry_id, slug, status, published_at FROM ${CONTENT_ENTRIES_TABLE} ORDER BY entry_id`,
      )
      .all();

    expect(rows).toEqual([
      { entry_id: "about", slug: "about", status: null, published_at: null },
      { entry_id: "draft", slug: "draft-post", status: "draft", published_at: "2024-02-01" },
      { entry_id: "hello", slug: "hello", status: "published", published_at: "2024-01-01" },
    ]);
  });

  it("upserts on identity, preserving created_at and advancing updated_at", async () => {
    await persistEntries(db, [HELLO], { now: () => 1000 });

    const updated = makeEntry("posts", "hello", {
      slug: "hello",
      title: "Hello, again",
      content: "# Hi",
    });
    await persistEntries(db, [updated], { now: () => 5000 });

    const rows = raw
      .prepare(`SELECT created_at, updated_at, document FROM ${CONTENT_ENTRIES_TABLE}`)
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      created_at: new Date(1000).toISOString(),
      updated_at: new Date(5000).toISOString(),
    });
    expect(JSON.parse((rows[0] as { document: string }).document)).toMatchObject({
      title: "Hello, again",
    });
  });

  it("defaults to the system clock when no clock is injected", async () => {
    const before = Date.now();
    await persistEntries(db, [HELLO]);
    const after = Date.now();

    const row = raw.prepare(`SELECT updated_at FROM ${CONTENT_ENTRIES_TABLE}`).get() as {
      updated_at: string;
    };
    const stamped = new Date(row.updated_at).getTime();

    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it("rejects an entry with an empty id", async () => {
    await expect(persistEntries(db, [{ ...HELLO, id: "" }])).rejects.toThrowError(
      ContentStoreError,
    );

    try {
      await persistEntries(db, [{ ...HELLO, id: "" }]);
      expect.unreachable();
    } catch (error) {
      expect((error as ContentStoreError).code).toBe("CONTENT_STORE_INVALID_ENTRY");
    }
  });

  it("rejects an entry with an empty collection", async () => {
    try {
      await persistEntries(db, [{ ...HELLO, collection: "" }]);
      expect.unreachable();
    } catch (error) {
      expect((error as ContentStoreError).code).toBe("CONTENT_STORE_INVALID_ENTRY");
    }
  });
});

describe("loadEntries", () => {
  beforeEach(async () => {
    await persistEntries(db, [HELLO, DRAFT, ABOUT], { now: () => 1000 });
  });

  it("reads every collection back, grouped and round-tripped", async () => {
    const loaded = await loadEntries(db);

    expect(Object.keys(loaded).toSorted()).toEqual(["pages", "posts"]);
    expect(loaded["posts"]).toHaveLength(2);
    expect(loaded["pages"]).toEqual([ABOUT]);
    // Ordered by slug: "draft-post" precedes "hello".
    expect(loaded["posts"]?.map((e) => e.id)).toEqual(["draft", "hello"]);
  });

  it("reads a single collection when one is named", async () => {
    const loaded = await loadEntries(db, "posts");

    expect(Object.keys(loaded)).toEqual(["posts"]);
    expect(loaded["posts"]).toHaveLength(2);
  });

  it("throws on a corrupt stored document", async () => {
    raw
      .prepare(
        `INSERT INTO ${CONTENT_ENTRIES_TABLE}
           (collection, entry_id, slug, document, created_at, updated_at)
         VALUES ('posts', 'broken', 'broken', '{not json', '', '')`,
      )
      .run();

    try {
      await loadEntries(db, "posts");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ContentStoreError);
      expect((error as ContentStoreError).code).toBe("CONTENT_STORE_CORRUPT_DOCUMENT");
      expect((error as ContentStoreError).details["collection"]).toBe("posts");
    }
  });
});

describe("loadEntry", () => {
  it("reads one entry by identity", async () => {
    await persistEntries(db, [HELLO], { now: () => 1000 });

    expect(await loadEntry(db, "posts", "hello")).toEqual(HELLO);
  });

  it("returns undefined when the entry is absent", async () => {
    expect(await loadEntry(db, "posts", "ghost")).toBeUndefined();
  });
});

describe("createEntry", () => {
  it("creates an entry from loose input, synthesizing its file metadata", async () => {
    const { entry } = await createEntry(db, {
      collection: "posts",
      slug: "guides/intro",
      data: { title: "Intro" },
      content: "# Intro",
    });

    expect(entry).toMatchObject({
      id: "guides/intro",
      collection: "posts",
      slug: "guides/intro",
      title: "Intro",
      content: "# Intro",
      file: {
        path: "posts/guides/intro.md",
        fileName: "intro.md",
        pathSegments: ["guides", "intro"],
      },
    });

    expect(await loadEntry(db, "posts", "guides/intro")).toEqual(entry);
  });

  it("creates a bare entry with neither data nor body", async () => {
    const { entry } = await createEntry(db, { collection: "pages", slug: "blank" });

    expect(entry).toMatchObject({ id: "blank", collection: "pages", slug: "blank" });
    expect(entry["content"]).toBeUndefined();
  });

  it("does not let frontmatter override the entry's identity", async () => {
    const { entry } = await createEntry(db, {
      collection: "posts",
      slug: "safe",
      data: { id: "evil", collection: "admin", slug: "spoof", title: "T" },
    });

    expect(entry).toMatchObject({ id: "safe", collection: "posts", slug: "safe", title: "T" });
    // The row is keyed by the real identity, never the frontmatter's.
    expect(await loadEntry(db, "posts", "safe")).toBeDefined();
    expect(await loadEntry(db, "admin", "evil")).toBeUndefined();
  });

  it("refuses to overwrite an existing entry", async () => {
    await createEntry(db, { collection: "posts", slug: "dup", data: { title: "One" } });

    try {
      await createEntry(db, { collection: "posts", slug: "dup", data: { title: "Two" } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ContentStoreError);
      expect((error as ContentStoreError).code).toBe("CONTENT_STORE_ENTRY_EXISTS");
    }
  });
});

describe("updateEntry", () => {
  it("merges data and replaces the body, holding identity fixed", async () => {
    await createEntry(db, {
      collection: "posts",
      slug: "edit",
      data: { title: "Old", keep: true },
      content: "old",
    });

    const { entry } = await updateEntry(db, {
      collection: "posts",
      slug: "edit",
      data: { title: "New" },
      content: "new",
    });

    // title overwritten, keep preserved, body replaced, identity intact.
    expect(entry).toMatchObject({
      title: "New",
      keep: true,
      content: "new",
      id: "edit",
      collection: "posts",
    });

    const reloaded = await loadEntry(db, "posts", "edit");
    expect(reloaded).toMatchObject({ title: "New", keep: true });
  });

  it("leaves data and body untouched when neither is given", async () => {
    await createEntry(db, {
      collection: "posts",
      slug: "keep",
      data: { title: "Same" },
      content: "body",
    });

    const { entry } = await updateEntry(db, { collection: "posts", slug: "keep" });

    expect(entry).toMatchObject({ title: "Same", content: "body" });
  });

  it("refuses to update an entry that is not there", async () => {
    try {
      await updateEntry(db, { collection: "posts", slug: "missing", data: { title: "x" } });
      expect.unreachable();
    } catch (error) {
      expect((error as ContentStoreError).code).toBe("CONTENT_STORE_ENTRY_NOT_FOUND");
    }
  });
});

describe("deleteEntry", () => {
  it("removes a matching entry and reports one deleted", async () => {
    await persistEntries(db, [HELLO], { now: () => 1000 });

    expect(await deleteEntry(db, "posts", "hello")).toEqual({ deleted: 1 });
    expect(await loadEntry(db, "posts", "hello")).toBeUndefined();
  });

  it("reports zero deleted when nothing matches", async () => {
    expect(await deleteEntry(db, "posts", "ghost")).toEqual({ deleted: 0 });
  });
});

describe("pruneEntries", () => {
  it("drops entries not in the kept set, leaving the rest", async () => {
    await persistEntries(db, [HELLO, DRAFT, ABOUT], { now: () => 1000 });

    // Keep everything except DRAFT.
    const result = await pruneEntries(db, [HELLO, ABOUT]);

    expect(result).toEqual({ deleted: 1 });
    expect(await loadEntry(db, "posts", "draft")).toBeUndefined();
    expect(await loadEntry(db, "posts", "hello")).toBeDefined();
    expect(await loadEntry(db, "pages", "about")).toBeDefined();
  });

  it("an empty kept set prunes everything", async () => {
    await persistEntries(db, [HELLO, DRAFT], { now: () => 1000 });

    expect(await pruneEntries(db, [])).toEqual({ deleted: 2 });
    expect(await loadEntries(db)).toEqual({});
  });
});

describe("hydrateRuntime", () => {
  it("loads the database into content-core's runtime queries", async () => {
    await persistEntries(db, [HELLO, DRAFT, ABOUT], { now: () => 1000 });

    await hydrateRuntime(db);

    expect(getCollection("posts")).toHaveLength(2);
    expect(getCollection("pages")).toHaveLength(1);
    expect(getEntry("posts", "hello")).toMatchObject({ title: "Hello" });
    expect(getEntry("posts", "draft-post")).toMatchObject({ title: "Draft" });
    expect(getEntry("posts", "nonexistent")).toBeUndefined();
  });
});
