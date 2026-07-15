/**
 * Type-inference audit fixture: exercises join / nullable-FK / partial-select inference for
 * `@lesto/db` as an adversarial check, pinned by the type-tests gate (tsconfig `include: *.ts`).
 * Originated as a scratch probe during an audit; kept as a permanent regression fixture.
 */

import { boolean, defineTable, eq, integer, text } from "@lesto/db";
import type { InferRow } from "@lesto/db";

import type { Equal, Expect, Resolve } from "./assert";

const authors = defineTable("authors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});

const posts = defineTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  // Nullable FK — a post may have no author.
  authorId: integer("author_id").references(() => authors.id),
  published: boolean("published").notNull(),
});

declare const db: import("@lesto/db").Db;

// ---------------------------------------------------------------------------
// 1. INNER JOIN row shape — both namespaces present, non-null.
// ---------------------------------------------------------------------------

async function innerJoinProbe() {
  const row = await db
    .select()
    .from(posts)
    .innerJoin(authors, eq(posts.authorId, authors.id))
    .get();

  // row: { posts: PostRow; authors: AuthorRow } | undefined
  type Row = NonNullable<typeof row>;

  type _innerShape = Expect<
    Equal<
      Resolve<Row>,
      {
        posts: {
          id: number;
          title: string;
          authorId: number | null;
          published: boolean;
        };
        authors: { id: number; name: string };
      }
    >
  >;
}
void innerJoinProbe;

// ---------------------------------------------------------------------------
// 2. LEFT JOIN row shape — the joined namespace should widen to `| null`.
// ---------------------------------------------------------------------------

async function leftJoinProbe() {
  const row = await db
    .select()
    .from(posts)
    .leftJoin(authors, eq(posts.authorId, authors.id))
    .get();

  type Row = NonNullable<typeof row>;

  // Does the LEFT-joined `authors` namespace actually become `AuthorRow | null`?
  type _leftShape = Expect<
    Equal<
      Resolve<Row>,
      {
        posts: {
          id: number;
          title: string;
          authorId: number | null;
          published: boolean;
        };
        authors: { id: number; name: string } | null;
      }
    >
  >;
}
void leftJoinProbe;

// ---------------------------------------------------------------------------
// 3. Partial select — does the DSL support selecting a subset of columns?
//    (No `.select(posts.title)` / column-picking overload exists in the
//    SelectBuilder at all — `select()` takes no arguments. This probe
//    documents that gap rather than asserting a positive.)
// ---------------------------------------------------------------------------

async function partialSelectProbe() {
  // If a projection API existed it would look something like:
  //   db.select({ title: posts.title }).from(posts)...
  // `select()` is 0-arity in the actual SelectBuilder type, so there is no
  // way to type this without editing queries.ts. Left commented as evidence.
  //
  // const row = await db.select({ title: posts.title }).from(posts).get();
  void 0;
}
void partialSelectProbe;

// ---------------------------------------------------------------------------
// 4. RETURNING clause — always the full row; no column-subset RETURNING.
// ---------------------------------------------------------------------------

async function returningProbe() {
  const created = await db
    .insert(posts)
    .values({ title: "hello", published: false })
    .returning()
    .get();

  type _returningShape = Expect<Equal<Resolve<typeof created>, InferRow<typeof posts>>>;
}
void returningProbe;

// ---------------------------------------------------------------------------
// 5. Cross-table `eq()` type safety in a JOIN's ON clause.
// ---------------------------------------------------------------------------

eq(posts.authorId, authors.id); // ok — both `number`-typed columns

// @ts-expect-error — `posts.title` (string) vs `authors.id` (number) must not type-check.
eq(posts.title, authors.id);
