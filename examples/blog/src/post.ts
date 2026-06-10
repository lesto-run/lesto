/**
 * The `posts` table as a `@keel/db` schema value, plus the helper functions
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
} from "@keel/db";
import type { Migration, MigrationEntry } from "@keel/migrate";

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
export function insertPost(db: Db, input: { title: string; body: string }): Post {
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
export function listPosts(db: Db): Post[] {
  return db.select().from(posts).orderBy(posts.id, "asc").all();
}

/** Row count — the seed script logs it. */
export function countPosts(db: Db): number {
  return db.select().from(posts).count();
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
