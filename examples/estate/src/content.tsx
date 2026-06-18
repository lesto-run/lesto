/**
 * DB-driven (WordPress-style) pages — the other half of ADR 0004's duality.
 *
 * Where `pages.tsx` is hand-written React, these pages are DATA: a serialized
 * UiNode block tree stored in a `pages` table, loaded by slug at request time and
 * rendered through a `Registry` of block components (`@volo/ui`'s `renderTree`).
 * The same `volo()` router serves both — a hand-authored `/lab/streaming` beside a
 * DB-driven `/lab/content/:slug` — one app, two content models.
 *
 * The STORE is injected, so the page runs on either runtime with the identical
 * query + render path: Node/Bun use portable SQLite (`openSqlite`), the Cloudflare
 * Worker uses D1 (`d1ContentStore`), since a Worker has no filesystem SQLite. Both
 * create the table idempotently and seed once, so a persistent D1 isn't reseeded
 * on every cold start.
 */

import { createDb, createTableSql, defineTable, eq, integer, text } from "@volo/db";
import type { Db, Dialect, SqlDatabase } from "@volo/db";
import { volo, type Volo } from "@volo/web";
import { Registry } from "@volo/ui";
import { renderTree } from "@volo/ui/server";
import type { UiNode } from "@volo/ui";
import type { ReactNode } from "react";

import { Hero, Main, SiteHeader } from "./ui/components";
import { d1ToSqlDatabase, hyperdriveToSqlDatabase } from "@volo/cloudflare";
import type { D1Database, HyperdriveConnection } from "@volo/cloudflare";

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

/**
 * Create the table if absent and seed it once (idempotent — safe on a persistent
 * D1 or Hyperdrive-fronted Postgres). The DDL is rendered for `dialect` so the
 * `pages` table installs on either edge substrate: SQLite-shaped on D1, Postgres-
 * shaped (BIGINT id, GENERATED ALWAYS AS IDENTITY) over Hyperdrive.
 */
async function ensureSeeded(handle: SqlDatabase, db: Db, dialect: Dialect): Promise<void> {
  await handle.exec(
    createTableSql(pages, dialect).replace(/^CREATE TABLE/, "CREATE TABLE IF NOT EXISTS"),
  );

  const first = SEED[0];
  if (first === undefined) return;

  // Already seeded? (A persistent D1 keeps its rows across cold starts.)
  const existing = await db.select().from(pages).where(eq(pages.slug, first.slug)).get();
  if (existing !== undefined) return;

  for (const page of SEED) {
    await db
      .insert(pages)
      .values({ slug: page.slug, title: page.title, tree: JSON.stringify(page.tree) })
      .run();
  }
}

/** A lazily-opened, seeded content store: a getter that resolves a ready `Db` once. */
export type ContentStore = () => Promise<Db>;

/**
 * Build a content store from an opener: memoizes it so the DB opens + seeds
 * exactly once, then is reused. Exported so the Node-only store
 * (`content-node.ts`, which pulls in `openSqlite`/better-sqlite3) can live in its
 * own module — keeping THIS module, and so the Worker bundle that imports it,
 * free of any filesystem-SQLite dependency the edge can't load.
 */
export function makeContentStore(
  open: () => Promise<{ handle: SqlDatabase; db: Db; dialect?: Dialect }>,
): ContentStore {
  let ready: Promise<Db> | undefined;

  return () =>
    (ready ??= (async () => {
      const { handle, db, dialect } = await open();
      await ensureSeeded(handle, db, dialect ?? "sqlite");

      return db;
    })());
}

/** The Cloudflare edge content store — a D1 binding adapted to `@volo/db`. */
export function d1ContentStore(d1: D1Database): ContentStore {
  return makeContentStore(async () => {
    const handle = d1ToSqlDatabase(d1);

    return { handle, db: createDb(handle) };
  });
}

/**
 * The Cloudflare edge content store over Hyperdrive-fronted Postgres — the
 * flagship-tier twin of {@link d1ContentStore}. `connection` is a postgres client
 * the Worker has connected to `env.HYPERDRIVE.connectionString`; it is adapted to
 * `@volo/db` by `hyperdriveToSqlDatabase`, so the IDENTICAL query + render path
 * runs over Postgres at scale instead of D1's edge SQLite. The dialect is
 * `"postgres"` so the table installs and binds (`?`→`$n`) the Postgres way.
 */
export function hyperdriveContentStore(connection: HyperdriveConnection): ContentStore {
  return makeContentStore(async () => {
    const handle = hyperdriveToSqlDatabase(connection);

    return { handle, db: createDb(handle, { dialect: "postgres" }), dialect: "postgres" };
  });
}

/** Load a stored page's title + block tree by slug, or `undefined` if none. */
async function loadPage(
  store: ContentStore,
  slug: string,
): Promise<{ title: string; tree: UiNode } | undefined> {
  const db = await store();
  const row = await db.select().from(pages).where(eq(pages.slug, slug)).get();

  if (row === undefined) return undefined;

  return { title: row.title, tree: JSON.parse(row.tree) as UiNode };
}

/** Render a loaded block tree through the Registry, or a not-found / unconfigured view. */
function ContentPage({
  slug,
  title,
  tree,
  configured,
}: {
  slug: string;
  title?: string;
  tree?: UiNode;
  configured: boolean;
}): ReactNode {
  if (!configured) {
    return (
      <>
        <SiteHeader />

        <Main>
          <Hero
            heading="DB-driven page"
            sub="No content store is configured — set a Cloudflare D1 binding (see wrangler.jsonc)."
          />
        </Main>
      </>
    );
  }

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

/**
 * The DB-driven content routes, over an injected store — mounted into `/lab`.
 *
 * `store` is the Node SQLite store on the server and the D1 store on the edge.
 * `undefined` means no store is configured (e.g. a Worker deployed without a D1
 * binding): the page renders a clear "configure D1" view instead of crashing.
 */
export function buildContentRoutes(store?: ContentStore): Volo {
  return volo().page("/lab/content/:slug", {
    load: async (
      c,
    ): Promise<{ slug: string; title?: string; tree?: UiNode; configured: boolean }> => {
      const slug = c.param("slug");

      if (store === undefined) return { slug, configured: false };

      const page = await loadPage(store, slug);

      return page === undefined
        ? { slug, configured: true }
        : { slug, title: page.title, tree: page.tree, configured: true };
    },
    component: ContentPage,
  });
}
