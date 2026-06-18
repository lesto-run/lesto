/**
 * The `posts` table as a `@volo/db` schema value, plus the helper functions
 * the controller + seed scripts call.
 *
 * `Post` is `InferRow<typeof posts>` — a plain row, no `extends Model`. The
 * `insertPost` helper takes a camelCase input, stamps `createdAt` and
 * `updatedAt`, and runs a tiny title-presence check inline — full
 * validation is the subject of a future ADR. For a demo, the inline check
 * is enough.
 */

import {
  createTableSql,
  defineTable,
  dropTableSql,
  integer,
  text,
  type Db,
  type InferRow,
} from "@volo/db";
import type { Migration, MigrationEntry } from "@volo/migrate";

export const posts = defineTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** A post row, as SELECT yields it. */
export type Post = InferRow<typeof posts>;

/**
 * Insert a post. Demands a non-blank title — the one validation rule the
 * old `Post` model carried. A full validation story (ADR 0005 candidate)
 * will land before any consumer that needs more.
 */
export async function insertPost(db: Db, input: { title: string; body: string }): Promise<Post> {
  if (input.title.trim() === "") {
    throw new Error("Post title is required.");
  }

  const now = new Date().toISOString();

  return db
    .insert(posts)
    .values({
      title: input.title,
      body: input.body,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/** Every post, ordered by id ascending — what both index and api render. */
export function listPosts(db: Db): Promise<Post[]> {
  return db.select().from(posts).orderBy(posts.id, "asc").all();
}

/** Row count — the seed script logs it. */
export function countPosts(db: Db): Promise<number> {
  return db.select().from(posts).count();
}

/**
 * The reaction count per post, keyed by a stable slug (`post-<id>`), as the
 * Reactions island's `reactionsSource` loader returns it (ADR 0012's blog proof).
 *
 * There is no reactions table in this small demo, so the count is derived
 * deterministically from the post's body length — honest (it reads real rows
 * through the typed `Db`) and small. A real app would `SELECT count(*)` from a
 * reactions table; the shape the island consumes is identical.
 */
export async function countReactions(db: Db): Promise<Record<string, number>> {
  const rows = await listPosts(db);

  const counts: Record<string, number> = {};

  for (const post of rows) {
    counts[`post-${post.id}`] = post.body.length;
  }

  return counts;
}

const migration: { version: string; migration: Migration } = {
  version: "001_create_posts",
  migration: {
    up(schema) {
      schema.execute(createTableSql(posts));
    },
    down(schema) {
      schema.execute(dropTableSql(posts));
    },
  },
};

/** The migration entry the kernel runs on boot. */
export const postsMigration: MigrationEntry = migration;
