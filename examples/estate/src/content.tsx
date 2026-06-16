/**
 * DB-driven (WordPress-style) pages — the other half of ADR 0004's duality.
 *
 * Where `pages.tsx` is hand-written React, these pages are DATA: a serialized
 * UiNode block tree stored in a `pages` table, loaded by slug at request time and
 * rendered through a `Registry` of block components (`@keel/ui`'s `renderTree`).
 * The same `keel()` router serves both — a hand-authored `/lab/streaming` beside a
 * DB-driven `/lab/content/:slug` — which is the whole point: one app, two content
 * models.
 *
 * The store here is a self-contained in-memory SQLite seeded at module load, so
 * the demo owns its data without threading estate's identity DB through every
 * layer. A real deploy points `createDb` at its primary database instead; the
 * query + render path is identical.
 */

import { createDb, createTableSql, defineTable, eq, integer, text } from "@keel/db";
import type { Db } from "@keel/db";
import { openSqlite } from "@keel/runtime";
import { keel, type Keel } from "@keel/web";
import { Registry } from "@keel/ui";
import { renderTree } from "@keel/ui/server";
import type { UiNode } from "@keel/ui";
import type { ReactNode } from "react";

import { Hero, Main, SiteHeader } from "./ui/components";

/** The block-page table: a slug, a title, and the serialized UiNode tree. */
const pages = defineTable("pages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  tree: text("tree").notNull(),
});

/**
 * The block vocabulary a stored tree may use — server components only (no islands
 * in DB content for now). `renderTree` validates a loaded tree against this, so an
 * unknown block degrades safely rather than throwing.
 */
const blocks = new Registry()
  .define({
    name: "Doc",
    description: "The root of a DB-driven page.",
    props: {},
    children: ["Heading", "Prose", "Callout"],
    render: (_props, children) => <article className="content">{children}</article>,
  })
  .define({
    name: "Heading",
    props: { text: { type: "string", required: true } },
    children: false,
    render: (props) => <h2>{String(props["text"])}</h2>,
  })
  .define({
    name: "Prose",
    props: { text: { type: "string", required: true } },
    children: false,
    render: (props) => <p className="copy">{String(props["text"])}</p>,
  })
  .define({
    name: "Callout",
    props: { text: { type: "string", required: true } },
    children: false,
    render: (props) => (
      <aside className="section">
        <strong>{String(props["text"])}</strong>
      </aside>
    ),
  });

/** A seeded page: its slug, title, and block tree. */
interface SeedPage {
  slug: string;
  title: string;
  tree: UiNode;
}

const SEED: readonly SeedPage[] = [
  {
    slug: "welcome",
    title: "A page stored in the database",
    tree: {
      type: "Doc",
      children: [
        { type: "Heading", props: { text: "This page is data, not code." } },
        {
          type: "Prose",
          props: {
            text: "Its block tree lives in a `pages` row as JSON; the router loaded it by slug and rendered it through a component Registry — the WordPress-style half of the framework.",
          },
        },
        {
          type: "Callout",
          props: {
            text: "Edit the row, change the page — no deploy. (ADR 0004's content duality.)",
          },
        },
      ],
    },
  },
];

// Open + seed the store once, lazily. `openSqlite` is the framework's PORTABLE
// sqlite seam (better-sqlite3 under Node/vitest, bun:sqlite under `bun run`), so
// this works in the test runner AND in the real `bun run build`/`serve` — a
// direct `better-sqlite3` import crashes the latter because Bun cannot dlopen the
// native addon. The open is async, so it is memoized behind a promise the
// request path awaits (estate's identity layer opens its DB the same way).
let storePromise: Promise<Db> | undefined;

function store(): Promise<Db> {
  storePromise ??= (async () => {
    const { db: handle } = await openSqlite(":memory:");
    const db = createDb(handle);

    await handle.exec(createTableSql(pages));

    for (const page of SEED) {
      await db
        .insert(pages)
        .values({ slug: page.slug, title: page.title, tree: JSON.stringify(page.tree) })
        .run();
    }

    return db;
  })();

  return storePromise;
}

/** Load a stored page's title + block tree by slug, or `undefined` if none. */
async function loadPage(slug: string): Promise<{ title: string; tree: UiNode } | undefined> {
  const db = await store();
  const row = await db.select().from(pages).where(eq(pages.slug, slug)).get();

  if (row === undefined) return undefined;

  return { title: row.title, tree: JSON.parse(row.tree) as UiNode };
}

/** Render a loaded block tree through the Registry, or a not-found view. */
function ContentPage({
  slug,
  title,
  tree,
}: {
  slug: string;
  title?: string;
  tree?: UiNode;
}): ReactNode {
  if (tree === undefined || title === undefined) {
    return (
      <>
        <SiteHeader />

        <Main>
          <Hero heading="Not found" sub={`No stored page "${slug}".`} />
        </Main>
      </>
    );
  }

  // The block tree, validated + rendered to React by the Registry.
  const { element } = renderTree(blocks, tree);

  return (
    <>
      <SiteHeader />

      <Main>
        <Hero heading={title} sub="Rendered from a serialized block tree in the database." />

        {element}
      </Main>
    </>
  );
}

/** The DB-driven content routes — mounted into the `/lab` zone. */
export function buildContentRoutes(): Keel {
  return keel().page("/lab/content/:slug", {
    load: async (c): Promise<{ slug: string; title?: string; tree?: UiNode }> => {
      const slug = c.param("slug");
      const page = await loadPage(slug);

      return page === undefined ? { slug } : { slug, title: page.title, tree: page.tree };
    },
    component: ContentPage,
  });
}
