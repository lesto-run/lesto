/**
 * `lesto g` (alias `lesto generate`) — per-resource code generators.
 *
 * The Rails `bin/rails generate` / Laravel `php artisan make:*` day-one move:
 * one command emits a convention-correct, typed, test-stubbed file wired the way
 * the rest of the codebase already does it, so a new resource is a single line
 * rather than a copy-paste-and-fix-the-imports chore (ADR 0019).
 *
 *   lesto g model Post title:string published:boolean
 *   lesto g migration add_views_to_posts
 *   lesto g island Counter
 *   lesto g page blog/[slug]
 *
 * Ships four generators — `model`, `migration`, `island`, `page` — each a pure
 * (name/route, field list) → file-set function. `page` takes a ROUTE PATH rather
 * than a resource name and emits a file-routed `page.tsx` whose props are inferred
 * via `PageProps<typeof load>` (the recommended no-restated-interface shape). The
 * remaining surface (`controller`, `mailer`, `job`) is designed in the ADR and deferred.
 *
 * Like `run`/`runOpenApi`, the core is pure and fully injected: a test hands it a
 * fake `exists`/`write` and a capturing `out` and asserts on the exact files that
 * would be written and the lines printed. The only real-world dependency — the
 * filesystem — lives behind the {@link GenerateIO} seam, so the decisions (field
 * parsing, naming, template rendering, idempotency, `--dry-run`) are tested with
 * no disk.
 *
 *   - `--dry-run` prints the plan (every path + a "would write" marker) and writes
 *     nothing — the safe preview before a real run.
 *   - Idempotency: a file that already exists is SKIPPED, never clobbered or
 *     duplicated. Re-running a generator after editing the emitted file is a
 *     no-op on that file, so a generator is safe to re-run.
 */

import { CliError } from "./errors";
import { hasFlag } from "./flags";

/** The filesystem seam `runGenerate` needs — injected so tests fake it. */
export interface GenerateIO {
  /** True iff a path already exists (so generation can skip rather than clobber). */
  exists: (path: string) => Promise<boolean>;

  /** Read an existing file's contents (used to tell "unchanged" from "differs"). */
  read: (path: string) => Promise<string>;

  /** Write a file's contents, creating parent directories as needed. */
  write: (path: string, contents: string) => Promise<void>;
}

/** The seams `lesto generate` depends on — all injected, never imported live. */
export interface GenerateDeps extends GenerateIO {
  /**
   * The clock a `migration` generator stamps its version from (the bin passes
   * `Date.now`; tests inject a fixed instant). A version is the UTC instant
   * rendered `YYYYMMDDHHMMSS`, so migrations sort in creation order — the scheme
   * Rails/Laravel and the Lesto migrator (lexicographic on the version string) use.
   */
  now: () => number;

  /** Where a line of output goes (the bin passes `console.log`). */
  out: (line: string) => void;
}

/**
 * The `field:type` mapping a `model`/`migration` field declaration accepts.
 *
 * Each alias resolves to a `@lesto/db` column builder name — the EXACT builders
 * `@lesto/db` exports (`text`/`integer`/`real`/`boolean`/`timestamp`), so the
 * emitted column compiles against the current API. The aliases (`string`→`text`,
 * `int`→`integer`, …) are the human-facing spelling Rails/Laravel use; the value
 * is what the template imports and calls.
 */
const FIELD_TYPES: Readonly<Record<string, "text" | "integer" | "real" | "boolean" | "timestamp">> =
  {
    string: "text",
    text: "text",
    integer: "integer",
    int: "integer",
    float: "real",
    real: "real",
    boolean: "boolean",
    bool: "boolean",
    timestamp: "timestamp",
    datetime: "timestamp",
  };

/** A parsed field: its JS key (camelCase), SQL column (snake_case), and builder. */
interface Field {
  /** The camelCase property key — what `InferRow` exposes and a query reads. */
  readonly key: string;

  /** The snake_case SQL column name — what the builder is given and DDL renders. */
  readonly column: string;

  /** The `@lesto/db` builder this field maps to (`text`/`integer`/…). */
  readonly builder: "text" | "integer" | "real" | "boolean" | "timestamp";
}

/** A valid identifier head: a resource name component. */
const NAME_PART = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * A valid field name: an identifier head that may also carry `_`/`-` word
 * separators (`published_at`, `blog-post`), so a `snake_case`/`kebab-case` field
 * is accepted just like a resource name and normalized through {@link words}.
 */
const FIELD_NAME_PART = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Split a `CamelCase` / `snake_case` / `kebab-case` name into its lowercase
 * words. The single tokenizer every other naming helper reads from, so
 * `BlogPost`, `blog_post`, and `blog-post` all yield `["blog", "post"]`.
 */
function words(name: string): string[] {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/** `["blog","post"]` → `BlogPost` — the type/component name. */
function pascalCase(parts: readonly string[]): string {
  return parts.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
}

/** `["blog","post"]` → `blogPost` — a property key / variable name. */
function camelCase(parts: readonly string[]): string {
  const pascal = pascalCase(parts);

  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** `["blog","post"]` → `blog_post` — a SQL column or table-name stem. */
function snakeCase(parts: readonly string[]): string {
  return parts.join("_");
}

/**
 * Naive English pluralization for the table name, matching the repo convention
 * (`Post` → `posts`). A trailing `y` after a consonant becomes `ies`
 * (`category` → `categories`); a trailing sibilant takes `es` (`box` → `boxes`);
 * everything else takes `s`. This is the table-name default only — never a
 * runtime inflector on a reference (ADR 0018 killed the pluralizing FK footgun);
 * a generator output is read once and committed, so a wrong plural is fixed by
 * editing the emitted file, not re-derived on every query.
 */
function pluralize(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;

  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;

  return `${word}s`;
}

/** Every naming a generator template needs, derived once from the raw name. */
export interface ResourceName {
  /** PascalCase type / component name — `BlogPost`, `Counter`. */
  readonly pascal: string;

  /** camelCase variable / value name — `blogPost`. */
  readonly camel: string;

  /** snake_case file stem — `blog_post`. */
  readonly snake: string;

  /** Pluralized snake_case table name — `blog_posts`. */
  readonly table: string;

  /** kebab-or-snake file basename used on disk for islands — `counter`. */
  readonly fileStem: string;
}

/**
 * Derive every cased form of a resource name from its raw argument, refusing a
 * name that is not a clean identifier.
 *
 * A name must be one or more identifier words (`Post`, `BlogPost`, `blog_post`,
 * `blog-post`); a name with a leading digit, punctuation, or that tokenizes to
 * nothing is refused by a stable code rather than emitting a file that will not
 * compile. The plural table name is derived from the LAST word only
 * (`BlogPost` → `blog_posts`), the convention the repo's `posts`/`products`
 * tables follow.
 */
export function resourceName(raw: string): ResourceName {
  const parts = words(raw);

  if (parts.length === 0 || !NAME_PART.test(pascalCase(parts))) {
    throw new CliError(
      "CLI_GENERATE_BAD_NAME",
      `"${raw}" is not a valid resource name — use letters and digits, e.g. Post or BlogPost.`,
      { name: raw },
    );
  }

  const lastWord = parts.at(-1)!;
  const tableParts = [...parts.slice(0, -1), pluralize(lastWord)];

  return {
    pascal: pascalCase(parts),
    camel: camelCase(parts),
    snake: snakeCase(parts),
    table: snakeCase(tableParts),
    fileStem: snakeCase(parts),
  };
}

/** A literal route segment — the SAME grammar `@lesto/router`'s `STATIC_SEGMENT` accepts. */
const ROUTE_STATIC = /^[A-Za-z0-9_.-]+$/;

/** A `[name]` dynamic route segment — mirrors `@lesto/router`'s `DYNAMIC_SEGMENT`. */
const ROUTE_DYNAMIC = /^\[([A-Za-z_][A-Za-z0-9_]*)\]$/;

/** Everything the `page` template needs, derived from a route path. */
export interface RouteName {
  /** The URL pattern the page registers at — `/blog/:slug`. */
  readonly pattern: string;

  /** The directory under `app/routes/` the file lives in — `blog/[slug]`. */
  readonly dir: string;

  /** The `:param` names in order — empty for a static page. */
  readonly params: readonly string[];

  /** The PascalCase component name — `BlogSlugPage`. */
  readonly component: string;
}

/**
 * Derive a route's pattern, directory, params, and component name from a path arg,
 * refusing anything the file-route convention would.
 *
 * `lesto g page blog/[slug]` → pattern `/blog/:slug`, dir `blog/[slug]`, params
 * `["slug"]`. Each segment is a literal name or a `[param]` (the SAME grammar the
 * router compiles), so the generator never emits a page the router will reject:
 * a catch-all/group segment, an empty path, or a param repeated across segments
 * (which would silently shadow) is refused up front by a stable code. The component
 * name is the path's words PascalCased + `Page`, falling back to `Page` for a path
 * with no identifier characters, so the emitted function name always compiles.
 */
export function routeName(rawPath: string): RouteName {
  const segments = rawPath.split("/").filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    throw new CliError(
      "CLI_GENERATE_BAD_ROUTE",
      `"${rawPath}" is not a route path — use a path like about or blog/[slug].`,
      { path: rawPath },
    );
  }

  const params: string[] = [];

  const patternSegments = segments.map((segment) => {
    const dynamic = ROUTE_DYNAMIC.exec(segment);

    if (dynamic !== null) {
      const param = dynamic[1]!;

      // A param repeated across segments (`[id]/[id]`) compiles to `/:id/:id`, where
      // the deeper capture silently clobbers the shallower — the router refuses it,
      // so the generator must not mint it.
      if (params.includes(param)) {
        throw new CliError(
          "CLI_GENERATE_BAD_ROUTE",
          `route path "${rawPath}" uses the param ":${param}" twice — the deeper would shadow the shallower; rename one.`,
          { path: rawPath, param },
        );
      }

      params.push(param);

      return `:${param}`;
    }

    if (ROUTE_STATIC.test(segment)) return segment;

    throw new CliError(
      "CLI_GENERATE_BAD_ROUTE",
      `route segment "${segment}" is neither a literal name nor a "[param]" — use a path like about or blog/[slug].`,
      { path: rawPath, segment },
    );
  });

  // The component name is every segment's words (a `[param]` contributes its param
  // name), with `.` treated as a separator so `sitemap.xml` → `SitemapXmlPage`.
  const nameWords = segments.flatMap((segment) => {
    const dynamic = ROUTE_DYNAMIC.exec(segment);

    return words((dynamic !== null ? dynamic[1]! : segment).replaceAll(".", "-"));
  });

  return {
    pattern: `/${patternSegments.join("/")}`,
    dir: segments.join("/"),
    params,
    component: nameWords.length > 0 ? `${pascalCase(nameWords)}Page` : "Page",
  };
}

/**
 * Parse one `field:type` token into a {@link Field}, refusing an unknown type or
 * a malformed name.
 *
 * The name is taken as written and re-cased: `publishedAt:timestamp` keeps the
 * camelCase key `publishedAt` and derives the snake_case column `published_at`.
 * An unknown type (`title:blob`) or a name that is not an identifier
 * (`1bad:string`) is refused by a stable code — the generator never emits a
 * column that will not compile.
 */
export function parseField(token: string): Field {
  const segments = token.split(":");

  // Exactly one `:` — a third segment (`title:string:garbage`) is a typo, never
  // silently dropped, so the author sees the mistake instead of a swallowed tail.
  if (segments.length > 2) {
    throw new CliError(
      "CLI_GENERATE_BAD_FIELD",
      `"${token}" is not a field — write it as name:type, e.g. title:string.`,
      { token },
    );
  }

  const [name, type] = segments;

  if (name === undefined || name === "" || type === undefined || type === "") {
    throw new CliError(
      "CLI_GENERATE_BAD_FIELD",
      `"${token}" is not a field — write it as name:type, e.g. title:string.`,
      { token },
    );
  }

  if (!FIELD_NAME_PART.test(name)) {
    throw new CliError(
      "CLI_GENERATE_BAD_FIELD",
      `"${name}" is not a valid field name — use letters and digits, e.g. title or publishedAt.`,
      { token, name },
    );
  }

  const builder = FIELD_TYPES[type];

  if (builder === undefined) {
    throw new CliError(
      "CLI_GENERATE_BAD_FIELD",
      `"${type}" is not a known field type. Use one of: ${Object.keys(FIELD_TYPES).join(", ")}.`,
      { token, type, known: Object.keys(FIELD_TYPES) },
    );
  }

  const parts = words(name);

  return { key: camelCase(parts), column: snakeCase(parts), builder };
}

/**
 * Parse every `field:type` token, refusing a duplicate key. Two tokens that
 * normalize to the same JS key (`title:string title:integer`, or
 * `published_at:… publishedAt:…`) would emit a `defineTable` object with a
 * repeated property — non-compiling TS (TS1117) — so the clash is refused by a
 * stable code up front rather than written to disk.
 */
function parseFields(tokens: readonly string[]): Field[] {
  const fields = tokens.map(parseField);
  const seen = new Set<string>();

  for (const field of fields) {
    if (seen.has(field.key)) {
      throw new CliError(
        "CLI_GENERATE_BAD_FIELD",
        `field "${field.key}" is declared twice — each field must be unique.`,
        { key: field.key },
      );
    }

    seen.add(field.key);
  }

  return fields;
}

/** A file a generator would write: its path and rendered contents. */
export interface GeneratedFile {
  readonly path: string;
  readonly contents: string;
}

/** The distinct builder names a field set uses, in `@lesto/db` export order. */
function importedBuilders(fields: readonly Field[]): string[] {
  const order: Field["builder"][] = ["text", "integer", "real", "boolean", "timestamp"];
  const used = new Set(fields.map((field) => field.builder));

  return order.filter((builder) => used.has(builder));
}

/** Render one `key: builder("column").notNull(),` column line for a table value. */
function columnLine(field: Field): string {
  return `  ${field.key}: ${field.builder}("${field.column}").notNull(),`;
}

/**
 * Render the model file — a `@lesto/db` schema value, its `InferRow` type, and a
 * `MigrationEntry` that creates/drops the table, in the exact shape `examples/blog`'s
 * `post.ts` uses.
 *
 * The table carries an auto-increment `id` plus every declared field as a
 * `notNull()` column. The migration is co-located (model = table + its create
 * migration), the convention the repo's example apps follow — there is no
 * separate per-model migration file to keep in sync.
 */
function modelFile(name: ResourceName, fields: readonly Field[]): string {
  // `integer` is ALWAYS imported — the auto-increment `id` column uses it even
  // when no declared field does; a `Set` dedupes it against an `integer` field.
  const used = new Set(["defineTable", "dropTableSql", "createTableSql", "integer"]);

  for (const builder of importedBuilders(fields)) used.add(builder);

  const builders = [...used].toSorted().join(", ");

  const columns = fields.map(columnLine).join("\n");
  const columnBlock = columns === "" ? "" : `\n${columns}`;

  return `/**
 * The \`${name.table}\` table as a \`@lesto/db\` schema value, its row type, and the
 * migration that creates it — one source of truth for the on-disk shape and the
 * inferred TS type every query returns.
 *
 * Generated by \`lesto g model ${name.pascal}\`. Grow it by adding columns to the
 * table value and helper functions below; wire \`${name.camel}Migration\` into your
 * \`LestoAppConfig\`'s \`migrations\` array so the kernel runs it on boot.
 */

import { ${builders}, type InferRow } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";

export const ${name.table} = defineTable("${name.table}", {
  id: integer("id").primaryKey({ autoIncrement: true }),${columnBlock}
});

/** A ${name.snake} row, as SELECT yields it. */
export type ${name.pascal} = InferRow<typeof ${name.table}>;

/** The migration that creates the \`${name.table}\` table; run on boot by the kernel. */
export const ${name.camel}Migration: MigrationEntry = {
  version: "001_create_${name.table}",
  migration: {
    up: (schema) => schema.execute(createTableSql(${name.table}, schema.dialect)),
    down: (schema) => schema.execute(dropTableSql(${name.table})),
  },
};
`;
}

/**
 * A representative TS literal for a column type, so the generated test's inserted
 * row type-checks against the table's `InferInsert` (a `Date` for `timestamp`, a
 * number for the numeric kinds, `true` for `boolean`, a string otherwise).
 */
function sampleLiteral(builder: Field["builder"]): string {
  if (builder === "integer" || builder === "real") return "1";

  if (builder === "boolean") return "true";

  if (builder === "timestamp") return "new Date(0)";

  return '"x"';
}

/**
 * Render the model's test stub — a real, passing test that proves the generated
 * schema value renders DDL and round-trips a row through an in-memory SQLite, so
 * the file the generator emitted is gate-green from the first run.
 */
function modelTestFile(name: ResourceName, fields: readonly Field[]): string {
  const values = fields
    .map((field) => `      ${field.key}: ${sampleLiteral(field.builder)},`)
    .join("\n");
  const valueBlock = values === "" ? "" : `\n${values}`;

  return `import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createDb, createTableSql } from "@lesto/db";

import { ${name.table}, ${name.camel}Migration } from "./${name.fileStem}";

/** Adapt better-sqlite3 to the async \`@lesto/db\` driver surface for the test. */
function memoryDb() {
  const raw = new Database(":memory:");

  raw.exec(createTableSql(${name.table}));

  return createDb({
    exec: async (sql: string) => {
      raw.exec(sql);
    },
    prepare: (sql: string) => {
      const statement = raw.prepare(sql);

      return {
        run: async (params: unknown[] = []) => statement.run(...params),
        get: async (params: unknown[] = []) => statement.get(...params),
        all: async (params: unknown[] = []) => statement.all(...params),
      };
    },
    transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn(raw),
  } as never);
}

describe("${name.table}", () => {
  it("renders a CREATE TABLE for the schema value", () => {
    expect(createTableSql(${name.table})).toContain("${name.table}");
  });

  it("has a create migration the kernel can run", () => {
    expect(${name.camel}Migration.version).toBe("001_create_${name.table}");
  });

  it("round-trips a row through @lesto/db", async () => {
    const db = memoryDb();

    const row = await db
      .insert(${name.table})
      .values({${valueBlock}
      })
      .returning()
      .get();

    expect(row.id).toBeGreaterThan(0);
  });
});
`;
}

/** Render a standalone migration file — a bare `MigrationEntry` for a schema edit. */
function migrationFile(name: ResourceName, version: string): string {
  return `/**
 * Migration \`${version}_${name.snake}\` — a schema edit not tied to a new model.
 *
 * Generated by \`lesto g migration ${name.snake}\`. Fill in \`up\` with the change
 * (\`schema.addColumn\`, \`schema.addIndex\`, \`createTableSql(table, schema.dialect)\`,
 * or the raw \`schema.execute\` escape hatch) and \`down\` with its reverse, then
 * wire \`${name.camel}Migration\` into your \`LestoAppConfig\`'s \`migrations\` array.
 */

import type { MigrationEntry } from "@lesto/migrate";

export const ${name.camel}Migration: MigrationEntry = {
  version: "${version}_${name.snake}",
  migration: {
    up: async (schema) => {
      // TODO: describe the schema change, e.g.
      // await schema.addColumn("posts", "views", "INTEGER", { default: 0 });
      await schema.execute("SELECT 1");
    },
    down: async (schema) => {
      // TODO: reverse the change above.
      await schema.execute("SELECT 1");
    },
  },
};
`;
}

/** Render the standalone migration's test stub — asserts its version string. */
function migrationTestFile(name: ResourceName, version: string): string {
  return `import { describe, expect, it } from "vitest";

import { ${name.camel}Migration } from "./${version}_${name.snake}";

describe("${version}_${name.snake}", () => {
  it("is a migration entry with a sortable version", () => {
    expect(${name.camel}Migration.version).toBe("${version}_${name.snake}");
  });
});
`;
}

/** Render the island file — one `defineIsland` default export, the ADR-0011 shape. */
function islandFile(name: ResourceName): string {
  return `import { useState } from "react";
import type { ReactElement } from "react";

import { defineIsland } from "@lesto/ui";

/**
 * The \`${name.pascal}\` island — generated by \`lesto g island ${name.pascal}\`.
 *
 * One \`defineIsland\` default export per file is the convention \`lesto build\`/\`dev\`
 * discover and bundle into \`/client.js\`. Replace the body with your component;
 * the local \`count\` here is a placeholder that proves hydration is live.
 */
function ${name.pascal}({ start }: { start: number }): ReactElement {
  const [n, setN] = useState(start);

  return (
    <button type="button" onClick={() => setN((value) => value + 1)}>
      count: {n}
    </button>
  );
}

export default defineIsland({
  name: "${name.pascal}",
  component: ${name.pascal},
  fallback: ({ start }) => <button type="button">count: {start}</button>,
});
`;
}

/** Render the island's test stub — asserts the island's declared name. */
function islandTestFile(name: ResourceName): string {
  return `import { describe, expect, it } from "vitest";

import ${name.pascal} from "./${name.fileStem}";

describe("${name.pascal} island", () => {
  it("declares its name", () => {
    expect(${name.pascal}.island.name).toBe("${name.pascal}");
  });
});
`;
}

/**
 * Render the file-routed `page.tsx` — a `PageDef` whose props are INFERRED from a
 * standalone `load` via `PageProps<typeof load>`, the shape the examples should have
 * shown but don't (the review's "PageProps ships but is never used" finding).
 *
 * A static route (no `[param]`) gets a no-arg `load`; a dynamic route gets a `load`
 * typed `(c: Context<pattern>)` that reads each `:param` with `c.param(...)`, so the
 * typed param flows into the component's props with no restated interface. Pulling
 * `load` out as a top-level `const` is what makes `typeof load` usable — inside the
 * object literal it would be a circular self-reference.
 */
function pageFile(route: RouteName): string {
  if (route.params.length === 0) {
    return `import type { ReactNode } from "react";

import type { PageDef, PageProps } from "@lesto/web";

/**
 * The \`${route.pattern}\` page — generated by \`lesto g page ${route.dir}\`.
 *
 * A \`page.tsx\` registers its directory's URL as a route (ADR 0023). \`load\` runs on
 * the server to produce props; the component's props are INFERRED from it via
 * \`PageProps<typeof load>\`, so the shape is declared once — no restated interface.
 * \`app/routes/\` is discovered by \`applyFileRoutes\` / the generated \`routes.gen.ts\`.
 */
const load = () => ({ heading: "${route.pattern}" });

function ${route.component}({ heading }: PageProps<typeof load>): ReactNode {
  return (
    <main>
      <h1>{heading}</h1>

      <p>Edit <code>app/routes/${route.dir}/page.tsx</code> to build this page.</p>
    </main>
  );
}

const page: PageDef<"${route.pattern}", PageProps<typeof load>> = {
  load,
  component: ${route.component},
};

export default page;
`;
  }

  const loadLines = route.params.map((param) => `  ${param}: c.param("${param}"),`).join("\n");
  const destructure = route.params.join(", ");
  const paramRows = route.params
    .map((param) => `      <p><code>${param}</code>: {${param}}</p>`)
    .join("\n");

  return `import type { ReactNode } from "react";

import type { Context, PageDef, PageProps } from "@lesto/web";

/**
 * The \`${route.pattern}\` page — generated by \`lesto g page ${route.dir}\`.
 *
 * Each \`[param]\` directory compiles to a typed \`:param\` the server \`load\` reads
 * with \`c.param(...)\`; the component's props are INFERRED from \`load\` via
 * \`PageProps<typeof load>\`, declared once — no restated interface (ADR 0023).
 */
const load = (c: Context<"${route.pattern}">) => ({
${loadLines}
});

function ${route.component}({ ${destructure} }: PageProps<typeof load>): ReactNode {
  return (
    <main>
      <h1>${route.dir}</h1>

${paramRows}
    </main>
  );
}

const page: PageDef<"${route.pattern}", PageProps<typeof load>> = {
  load,
  component: ${route.component},
};

export default page;
`;
}

/** Render the page's test stub — a real, passing smoke test of the emitted `PageDef`. */
function pageTestFile(route: RouteName): string {
  return `import { describe, expect, it } from "vitest";

import page from "./page";

describe("${route.pattern} page", () => {
  it("default-exports a page with a server load", () => {
    expect(typeof page.component).toBe("function");
    expect(typeof page.load).toBe("function");
  });
});
`;
}

/**
 * Plan the `model` generator's files: the model (table + row type + migration)
 * and its test, under `app/models/`.
 */
function planModel(name: ResourceName, fields: readonly Field[]): GeneratedFile[] {
  return [
    { path: `app/models/${name.fileStem}.ts`, contents: modelFile(name, fields) },
    { path: `app/models/${name.fileStem}.test.ts`, contents: modelTestFile(name, fields) },
  ];
}

/**
 * Plan the `migration` generator's files: a timestamped standalone migration and
 * its test, under `app/migrations/`. The version is `YYYYMMDDHHMMSS` from the
 * injected clock, so migrations sort in creation order.
 */
function planMigration(name: ResourceName, version: string): GeneratedFile[] {
  return [
    { path: `app/migrations/${version}_${name.snake}.ts`, contents: migrationFile(name, version) },
    {
      path: `app/migrations/${version}_${name.snake}.test.ts`,
      contents: migrationTestFile(name, version),
    },
  ];
}

/** Plan the `island` generator's files: the island and its test, under `app/islands/`. */
function planIsland(name: ResourceName): GeneratedFile[] {
  return [
    { path: `app/islands/${name.fileStem}.tsx`, contents: islandFile(name) },
    { path: `app/islands/${name.fileStem}.test.tsx`, contents: islandTestFile(name) },
  ];
}

/**
 * Plan the `page` generator's files: the file-routed page and its (scanner-ignored)
 * co-located test, under `app/routes/<dir>/`. The dir is the raw route path, so a
 * `[param]` directory lands on disk exactly as the convention reads it.
 */
function planPage(route: RouteName): GeneratedFile[] {
  return [
    { path: `app/routes/${route.dir}/page.tsx`, contents: pageFile(route) },
    { path: `app/routes/${route.dir}/page.test.tsx`, contents: pageTestFile(route) },
  ];
}

/** Format the injected instant as a `YYYYMMDDHHMMSS` UTC migration version stamp. */
function versionStamp(now: () => number): string {
  return new Date(now()).toISOString().replaceAll(/[-:T]/g, "").slice(0, 14);
}

/** The generators this CLI implements — `controller`/`mailer`/`job` are deferred (ADR 0019). */
const GENERATORS = ["model", "migration", "island", "page"] as const;

type Generator = (typeof GENERATORS)[number];

/** The resource-named generators (everything but `page`, which takes a route path). */
type ResourceGenerator = Exclude<Generator, "page">;

/** True iff `value` names a generator this CLI implements today. */
function isGenerator(value: string | undefined): value is Generator {
  return value !== undefined && (GENERATORS as readonly string[]).includes(value);
}

/**
 * Build the file plan for a generator invocation.
 *
 * `model` consumes the trailing `field:type` tokens; `migration` and `island`
 * take only a name (extra tokens are ignored — an `island` has no fields). The
 * version stamp for a `migration` is derived here from the injected clock, so a
 * test pins it.
 */
function planFiles(
  generator: ResourceGenerator,
  name: ResourceName,
  fieldTokens: readonly string[],
  now: () => number,
): GeneratedFile[] {
  if (generator === "model") return planModel(name, parseFields(fieldTokens));

  if (generator === "migration") return planMigration(name, versionStamp(now));

  return planIsland(name);
}

/**
 * Run a `lesto g <generator> <Name> [field:type …]` invocation.
 *
 * Parses and validates the generator, the name, and (for `model`) the fields up
 * front — a bad input is refused by a stable code before a single file is
 * touched. Then for each planned file:
 *
 *   - `--dry-run`: print `would write <path>` (or `would skip <path>` for a path
 *     that already exists) and write nothing.
 *   - an existing file: read it and print `exists <path> (unchanged)` if it is
 *     byte-identical, or `exists <path> (differs — left unchanged; edit or delete
 *     to regenerate)` if it is not — then SKIP it either way (idempotent — never
 *     clobbered, never duplicated).
 *   - otherwise: write it and print `wrote <path>`.
 *
 * Returns the process exit code (always 0 on a successful plan; a refusal throws
 * a coded {@link CliError} the caller turns into a non-zero exit).
 */
export async function runGenerate(args: readonly string[], deps: GenerateDeps): Promise<number> {
  const [generator, rawName, ...rest] = args;

  if (generator === undefined || rawName === undefined) {
    throw new CliError(
      "CLI_GENERATE_MISSING_ARGS",
      "generate needs a generator and a name: lesto g <model|migration|island|page> <Name|path> [field:type …]",
      { generator, name: rawName },
    );
  }

  if (!isGenerator(generator)) {
    throw new CliError(
      "CLI_GENERATE_UNKNOWN_GENERATOR",
      `"${generator}" is not a known generator. Available: ${GENERATORS.join(", ")}.`,
      { generator, known: [...GENERATORS] },
    );
  }

  const dryRun = hasFlag(args, "dry-run");

  // `page` takes a ROUTE PATH (`blog/[slug]`), not a resource name, and ignores any
  // trailing tokens; the resource generators take a name plus (for `model`) the
  // `field:type` tokens, with a flag like `--dry-run` never parsed as a field.
  const files =
    generator === "page"
      ? planPage(routeName(rawName))
      : planFiles(
          generator,
          resourceName(rawName),
          rest.filter((token) => !token.startsWith("--")),
          deps.now,
        );

  for (const file of files) {
    if (dryRun) {
      // A dry run reports the REAL plan: a path that already exists would be
      // skipped on a real run, so say so rather than mislabeling it "would write".
      deps.out(`would ${(await deps.exists(file.path)) ? "skip" : "write"} ${file.path}`);

      continue;
    }

    // Idempotency: an existing file is left exactly as it is — the generator is
    // safe to re-run after the author has edited what it first emitted. The
    // message distinguishes a byte-identical file (a true no-op) from one whose
    // contents differ, so a re-run with new fields is not a silent data-loss
    // surprise — the author is told to edit or delete the file to regenerate.
    if (await deps.exists(file.path)) {
      const current = await deps.read(file.path);

      deps.out(
        current === file.contents
          ? `exists ${file.path} (unchanged)`
          : `exists ${file.path} (differs — left unchanged; edit or delete to regenerate)`,
      );

      continue;
    }

    await deps.write(file.path, file.contents);

    deps.out(`wrote ${file.path}`);
  }

  return 0;
}
