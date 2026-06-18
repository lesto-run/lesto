import { beforeEach, describe, expect, it } from "vitest";

import { CliError } from "../src/errors";
import { parseField, resourceName, runGenerate } from "../src/generate";
import type { GenerateDeps } from "../src/generate";

// A fixed instant so a `migration` version stamp is deterministic in tests.
// 2026-06-18T12:34:56.000Z → YYYYMMDDHHMMSS = 20260618123456.
const FIXED_NOW = Date.parse("2026-06-18T12:34:56.000Z");
const FIXED_VERSION = "20260618123456";

// Capture writes, the existing files (path → contents), and printed lines.
let written: { path: string; contents: string }[];
let existing: Map<string, string>;
let lines: string[];

function depsWith(overrides: Partial<GenerateDeps> = {}): GenerateDeps {
  return {
    exists: (path) => Promise.resolve(existing.has(path)),
    read: (path) => Promise.resolve(existing.get(path) ?? ""),
    write: (path, contents) => {
      written.push({ path, contents });

      return Promise.resolve();
    },
    now: () => FIXED_NOW,
    out: (line) => lines.push(line),
    ...overrides,
  };
}

/** Run a generator and return the error it threw, or undefined on success. */
async function refusal(args: readonly string[]): Promise<CliError> {
  try {
    await runGenerate(args, depsWith());
  } catch (error) {
    return error as CliError;
  }

  throw new Error("expected a refusal but the generator succeeded");
}

/** The contents written to a given path, or undefined if it was not written. */
function contentsAt(path: string): string | undefined {
  return written.find((file) => file.path === path)?.contents;
}

beforeEach(() => {
  written = [];
  existing = new Map();
  lines = [];
});

describe("resourceName", () => {
  it("derives every cased form from a PascalCase name", () => {
    expect(resourceName("BlogPost")).toEqual({
      pascal: "BlogPost",
      camel: "blogPost",
      snake: "blog_post",
      table: "blog_posts",
      fileStem: "blog_post",
    });
  });

  it("accepts snake_case and kebab-case names, normalizing them", () => {
    expect(resourceName("blog_post").pascal).toBe("BlogPost");
    expect(resourceName("blog-post").pascal).toBe("BlogPost");
  });

  it("pluralizes a consonant-y stem to -ies", () => {
    expect(resourceName("Category").table).toBe("categories");
  });

  it("leaves a vowel-y stem to take a plain -s", () => {
    // "day" ends in a vowel+y, so it is NOT the consonant-y → -ies branch.
    expect(resourceName("Day").table).toBe("days");
  });

  it("pluralizes a sibilant stem with -es", () => {
    expect(resourceName("Box").table).toBe("boxes");
    expect(resourceName("Dish").table).toBe("dishes");
  });

  it("pluralizes only the last word of a compound name", () => {
    expect(resourceName("BlogCategory").table).toBe("blog_categories");
  });

  it("refuses a name with a leading digit", () => {
    expect(() => resourceName("1Post")).toThrow(CliError);
  });

  it("refuses an empty / punctuation-only name with a coded error", () => {
    const error = (() => {
      try {
        resourceName("__");

        return undefined;
      } catch (caught) {
        return caught as CliError;
      }
    })();

    expect(error?.code).toBe("CLI_GENERATE_BAD_NAME");
  });
});

describe("parseField", () => {
  it("maps every type alias to its @lesto/db builder", () => {
    expect(parseField("title:string").builder).toBe("text");
    expect(parseField("body:text").builder).toBe("text");
    expect(parseField("views:integer").builder).toBe("integer");
    expect(parseField("count:int").builder).toBe("integer");
    expect(parseField("ratio:float").builder).toBe("real");
    expect(parseField("ratio:real").builder).toBe("real");
    expect(parseField("published:boolean").builder).toBe("boolean");
    expect(parseField("active:bool").builder).toBe("boolean");
    expect(parseField("at:timestamp").builder).toBe("timestamp");
    expect(parseField("at:datetime").builder).toBe("timestamp");
  });

  it("derives a snake_case column from a camelCase field name", () => {
    expect(parseField("publishedAt:timestamp")).toEqual({
      key: "publishedAt",
      column: "published_at",
      builder: "timestamp",
    });
  });

  it("accepts a snake_case / kebab-case field name, normalizing it", () => {
    expect(parseField("published_at:boolean")).toEqual({
      key: "publishedAt",
      column: "published_at",
      builder: "boolean",
    });
    expect(parseField("blog-post:string")).toEqual({
      key: "blogPost",
      column: "blog_post",
      builder: "text",
    });
  });

  it("refuses a token with more than one colon, never swallowing the tail", () => {
    const error = (() => {
      try {
        parseField("title:string:garbage");

        return undefined;
      } catch (caught) {
        return caught as CliError;
      }
    })();

    expect(error?.code).toBe("CLI_GENERATE_BAD_FIELD");
  });

  it("refuses a token with no type", () => {
    expect(() => parseField("title")).toThrow(CliError);
  });

  it("refuses a token with an empty name or empty type", () => {
    expect(() => parseField(":string")).toThrow(CliError);
    expect(() => parseField("title:")).toThrow(CliError);
  });

  it("refuses a field name that is not an identifier", () => {
    const error = (() => {
      try {
        parseField("1bad:string");

        return undefined;
      } catch (caught) {
        return caught as CliError;
      }
    })();

    expect(error?.code).toBe("CLI_GENERATE_BAD_FIELD");
  });

  it("refuses an unknown field type, naming the known set", () => {
    const error = (() => {
      try {
        parseField("title:blob");

        return undefined;
      } catch (caught) {
        return caught as CliError;
      }
    })();

    expect(error?.code).toBe("CLI_GENERATE_BAD_FIELD");
    expect(error?.message).toContain("string");
  });
});

describe("runGenerate — model", () => {
  it("writes a typed model + test under app/models, reporting each", async () => {
    const code = await runGenerate(
      ["model", "Post", "title:string", "published:boolean"],
      depsWith(),
    );

    expect(code).toBe(0);
    expect(written.map((file) => file.path)).toEqual([
      "app/models/post.ts",
      "app/models/post.test.ts",
    ]);
    expect(lines).toEqual(["wrote app/models/post.ts", "wrote app/models/post.test.ts"]);
  });

  it("emits a compilable model: schema value, row type, and migration", async () => {
    await runGenerate(["model", "Post", "title:string", "published:boolean"], depsWith());

    const model = contentsAt("app/models/post.ts") ?? "";

    // The @lesto/db import carries exactly the builders the fields use, sorted.
    expect(model).toContain(
      'import { boolean, createTableSql, defineTable, dropTableSql, integer, text, type InferRow } from "@lesto/db";',
    );
    expect(model).toContain('export const posts = defineTable("posts", {');
    expect(model).toContain('id: integer("id").primaryKey({ autoIncrement: true }),');
    expect(model).toContain('title: text("title").notNull(),');
    expect(model).toContain('published: boolean("published").notNull(),');
    expect(model).toContain("export type Post = InferRow<typeof posts>;");
    expect(model).toContain("export const postMigration: MigrationEntry = {");
    expect(model).toContain('version: "001_create_posts",');
    expect(model).toContain("createTableSql(posts, schema.dialect)");
  });

  it("emits a test that inserts one literal per column type", async () => {
    await runGenerate(
      ["model", "Event", "name:string", "count:int", "ratio:float", "live:bool", "at:timestamp"],
      depsWith(),
    );

    const test = contentsAt("app/models/event.test.ts") ?? "";

    expect(test).toContain('name: "x",');
    expect(test).toContain("count: 1,");
    expect(test).toContain("ratio: 1,");
    expect(test).toContain("live: true,");
    expect(test).toContain("at: new Date(0),");
    expect(test).toContain('import { events, eventMigration } from "./event";');
  });

  it("handles a model with no fields (just the id column)", async () => {
    await runGenerate(["model", "Flag"], depsWith());

    const model = contentsAt("app/models/flag.ts") ?? "";

    // No declared columns: only the id line, no trailing column block, and the
    // import omits any field builder (just the always-present ones, sorted).
    expect(model).toContain(
      'import { createTableSql, defineTable, dropTableSql, integer, type InferRow } from "@lesto/db";',
    );
    expect(model).toContain("autoIncrement: true }),\n});");

    // The empty-fields test inserts an empty values object.
    const test = contentsAt("app/models/flag.test.ts") ?? "";

    expect(test).toContain(".values({\n      })");
  });
});

describe("runGenerate — migration", () => {
  it("writes a timestamped standalone migration + test", async () => {
    const code = await runGenerate(["migration", "add_views_to_posts"], depsWith());

    expect(code).toBe(0);
    expect(written.map((file) => file.path)).toEqual([
      `app/migrations/${FIXED_VERSION}_add_views_to_posts.ts`,
      `app/migrations/${FIXED_VERSION}_add_views_to_posts.test.ts`,
    ]);

    const migration = contentsAt(`app/migrations/${FIXED_VERSION}_add_views_to_posts.ts`) ?? "";

    expect(migration).toContain(`version: "${FIXED_VERSION}_add_views_to_posts",`);
    expect(migration).toContain("export const addViewsToPostsMigration: MigrationEntry = {");
  });

  it("ignores trailing field tokens for a migration (it has no fields)", async () => {
    await runGenerate(["migration", "tweak", "title:string"], depsWith());

    const migration = contentsAt(`app/migrations/${FIXED_VERSION}_tweak.ts`) ?? "";

    expect(migration).not.toContain("title");
  });
});

describe("runGenerate — island", () => {
  it("writes a defineIsland file + test under app/islands", async () => {
    const code = await runGenerate(["island", "Counter"], depsWith());

    expect(code).toBe(0);
    expect(written.map((file) => file.path)).toEqual([
      "app/islands/counter.tsx",
      "app/islands/counter.test.tsx",
    ]);

    const island = contentsAt("app/islands/counter.tsx") ?? "";

    expect(island).toContain('import { defineIsland } from "@lesto/ui";');
    expect(island).toContain('name: "Counter",');
    expect(island).toContain("function Counter({ start }: { start: number })");

    const test = contentsAt("app/islands/counter.test.tsx") ?? "";

    expect(test).toContain('expect(Counter.island.name).toBe("Counter");');
  });
});

describe("runGenerate — dry-run", () => {
  it("prints the plan and writes nothing", async () => {
    const code = await runGenerate(["model", "Post", "title:string", "--dry-run"], depsWith());

    expect(code).toBe(0);
    expect(written).toHaveLength(0);
    expect(lines).toEqual([
      "would write app/models/post.ts",
      "would write app/models/post.test.ts",
    ]);
  });

  it("labels an existing file 'would skip', not 'would write'", async () => {
    existing.set("app/models/post.ts", "anything");

    await runGenerate(["model", "Post", "title:string", "--dry-run"], depsWith());

    expect(written).toHaveLength(0);
    expect(lines).toEqual(["would skip app/models/post.ts", "would write app/models/post.test.ts"]);
  });
});

describe("runGenerate — idempotency", () => {
  it("skips a file that already exists rather than clobbering it", async () => {
    // Capture the model the generator emits, then pre-seed it byte-identical so a
    // re-run reports a true no-op on it.
    await runGenerate(["model", "Post", "title:string"], depsWith());
    existing.set("app/models/post.ts", contentsAt("app/models/post.ts") ?? "");
    written = [];
    lines = [];

    await runGenerate(["model", "Post", "title:string"], depsWith());

    // The existing model is left alone; only the missing test is written.
    expect(written.map((file) => file.path)).toEqual(["app/models/post.test.ts"]);
    expect(lines).toEqual([
      "exists app/models/post.ts (unchanged)",
      "wrote app/models/post.test.ts",
    ]);
  });

  it("is a full no-op when both files already exist unchanged", async () => {
    await runGenerate(["model", "Post"], depsWith());
    existing.set("app/models/post.ts", contentsAt("app/models/post.ts") ?? "");
    existing.set("app/models/post.test.ts", contentsAt("app/models/post.test.ts") ?? "");
    written = [];
    lines = [];

    await runGenerate(["model", "Post"], depsWith());

    expect(written).toHaveLength(0);
    expect(lines).toEqual([
      "exists app/models/post.ts (unchanged)",
      "exists app/models/post.test.ts (unchanged)",
    ]);
  });

  it("reports 'differs' when an existing file's contents have drifted", async () => {
    // A re-run with NEW fields would emit different contents — the existing file
    // is left unchanged but the author is told so, never a silent skip.
    existing.set("app/models/post.ts", "// hand-edited, no longer what the generator emits\n");

    await runGenerate(["model", "Post", "title:string", "body:text"], depsWith());

    expect(written.map((file) => file.path)).toEqual(["app/models/post.test.ts"]);
    expect(lines[0]).toBe(
      "exists app/models/post.ts (differs — left unchanged; edit or delete to regenerate)",
    );
  });
});

describe("runGenerate — refusals", () => {
  it("refuses with no arguments", async () => {
    const error = await refusal([]);

    expect(error.code).toBe("CLI_GENERATE_MISSING_ARGS");
  });

  it("refuses a generator with no name", async () => {
    const error = await refusal(["model"]);

    expect(error.code).toBe("CLI_GENERATE_MISSING_ARGS");
  });

  it("refuses an unknown generator, naming the available set", async () => {
    const error = await refusal(["controller", "Posts"]);

    expect(error.code).toBe("CLI_GENERATE_UNKNOWN_GENERATOR");
    expect(error.message).toContain("model, migration, island");
  });

  it("refuses a bad resource name before touching the filesystem", async () => {
    const error = await refusal(["model", "1Post"]);

    expect(error.code).toBe("CLI_GENERATE_BAD_NAME");
    expect(written).toHaveLength(0);
  });

  it("refuses a bad field, propagating parseField's code", async () => {
    const error = await refusal(["model", "Post", "title:blob"]);

    expect(error.code).toBe("CLI_GENERATE_BAD_FIELD");
    expect(written).toHaveLength(0);
  });

  it("refuses a model with a duplicate field key before touching the filesystem", async () => {
    const error = await refusal(["model", "Post", "title:string", "title:integer"]);

    expect(error.code).toBe("CLI_GENERATE_BAD_FIELD");
    expect(error.message).toContain('field "title" is declared twice');
    expect(written).toHaveLength(0);
  });
});
