/**
 * examples/feeds — @lesto/feeds RSS 2.0 + Atom 1.0 generation behind real HTTP.
 *
 * A tiny blog whose posts live in a SQLite `posts` table, syndicated as two feeds
 * a reader (or an aggregator) can subscribe to:
 *
 *   GET /          a minimal HTML index that links to both feeds
 *   GET /feed.xml  the posts rendered as a spec-valid RSS 2.0 document
 *   GET /atom.xml  the SAME posts rendered as a spec-valid Atom 1.0 document
 *
 * The interesting behavior all lives at the XML boundary, and only shows up once
 * a feed is built from REAL data:
 *
 *   - one document, two dialects — the identical `{ FeedMeta, FeedItem[] }` feeds
 *     both `rss(...)` and `atom(...)`; the builders differ only in the XML they
 *     emit (RFC 822 `<pubDate>` vs RFC 3339 `<updated>`, `<item>` vs `<entry>`);
 *   - untrusted post text can never break the document — a post title carrying
 *     `&`, `<`, `>` (see {@link SPECIAL_POST}) is XML-escaped, so `Tips & Tricks`
 *     renders as `Tips &amp; Tricks` and never as a bare, malforming ampersand;
 *   - the feeds are built FROM DB ROWS — a `SELECT … ORDER BY published_at DESC`
 *     maps straight onto `FeedItem`s, which is what a real blog actually does.
 *
 * WHY A SQLITE TABLE (not an in-memory array): the feature on show is XML
 * generation, so the data source is deliberately small — but "a feed from your
 * posts table" is the honest, canonical use of `@lesto/feeds`, and mapping a
 * `SELECT … ORDER BY published_at DESC` row straight onto a `FeedItem` is the
 * genuinely useful thing to show a feeds-library user. The table is a single
 * `CREATE TABLE` seeded on boot; dates are stored as epoch-ms and handed to the
 * feed builders as `Date`s, which `@lesto/feeds` formats per dialect.
 *
 * Built as factories (the estate shape): the routes close over a `loadPosts`
 * reader rather than reaching for a module-scoped database.
 */

import { atom, escapeXml, rss } from "@lesto/feeds";
import type { FeedItem, FeedMeta } from "@lesto/feeds";
import type { KernelDatabase } from "@lesto/kernel";
import { lesto } from "@lesto/web";
import type { Lesto, LestoResponse } from "@lesto/web";

/** The public origin the feed and its posts are addressed under. */
const SITE_URL = "https://blog.lesto.dev";

/** Channel-level metadata every feed rendered here shares. */
const BLOG_TITLE = "The Lesto Blog";
const BLOG_DESCRIPTION = "Releases, deep dives & field notes from the Lesto team.";
const BLOG_AUTHOR = "team@lesto.dev";

/** The content types the two feed dialects are served under. */
const RSS_CONTENT_TYPE = "application/rss+xml; charset=utf-8";
const ATOM_CONTENT_TYPE = "application/atom+xml; charset=utf-8";

/** A single blog post — the row shape as the app code reads it. */
export interface Post {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly author: string;
  /** Epoch-ms publish instant; formatted per dialect by `@lesto/feeds`. */
  readonly publishedAt: number;
}

/**
 * The one post whose title and summary carry `&`, `<`, and `>` on purpose.
 *
 * It is the load-bearing fixture: the feed must render its special characters as
 * XML entities (`&amp;`, `&lt;`, `&gt;`) and never leak the raw text, or the
 * document is malformed. The test asserts exactly that against this post.
 */
export const SPECIAL_POST: Post = {
  slug: "ampersands-and-angle-brackets",
  title: "Tips & Tricks: <marquee> is not coming back",
  summary:
    "This post's title & body carry & < > on purpose, so you can watch @lesto/feeds escape them into a well-formed document.",
  author: "grace@lesto.dev",
  publishedAt: Date.UTC(2026, 5, 15, 12, 30, 0),
};

/** The posts the blog is seeded with. Order is irrelevant — the reader sorts. */
export const SEED_POSTS: readonly Post[] = [
  {
    slug: "shipping-feeds",
    title: "Shipping RSS and Atom with zero dependencies",
    summary:
      "How @lesto/feeds builds spec-valid XML from a posts table, with no parser to pull in.",
    author: "ada@lesto.dev",
    publishedAt: Date.UTC(2026, 5, 22, 8, 15, 0),
  },
  SPECIAL_POST,
  {
    slug: "hello-lesto",
    title: "Hello, Lesto",
    summary: "Why we built a batteries-included fullstack framework for the agent era.",
    author: "ada@lesto.dev",
    publishedAt: Date.UTC(2026, 5, 8, 9, 0, 0),
  },
];

/** The `posts` table: a slug-keyed row per post, with an epoch-ms publish stamp. */
const POSTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS posts (
    slug         TEXT    PRIMARY KEY,
    title        TEXT    NOT NULL,
    summary      TEXT    NOT NULL,
    author       TEXT    NOT NULL,
    published_at INTEGER NOT NULL
  )
`;

/** The stored row, as SQLite hands it back — snake_case, `published_at` an integer. */
interface PostRow {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly author: string;
  readonly published_at: number;
}

/** Seed the table. `INSERT OR IGNORE` keeps a re-boot on the same handle idempotent. */
async function seedPosts(db: KernelDatabase, posts: readonly Post[]): Promise<void> {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO posts (slug, title, summary, author, published_at) VALUES (?, ?, ?, ?, ?)",
  );

  for (const post of posts) {
    await insert.run([post.slug, post.title, post.summary, post.author, post.publishedAt]);
  }
}

/**
 * A reader that returns the posts newest-first — the order a feed lists entries,
 * and the order Atom's `<updated>` derivation ("the first dated entry") expects.
 */
function createLoadPosts(db: KernelDatabase): () => Promise<Post[]> {
  const select = db.prepare(
    "SELECT slug, title, summary, author, published_at FROM posts ORDER BY published_at DESC",
  );

  return async () => {
    const rows = (await select.all()) as PostRow[];

    return rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      author: row.author,
      publishedAt: row.published_at,
    }));
  };
}

/**
 * The feed's channel metadata, resolved from the current posts.
 *
 * `updated` is taken from the newest post (posts arrive newest-first) so the feed
 * advertises its true last-changed time; on an empty blog it is omitted and
 * `@lesto/feeds` synthesizes a valid `<updated>` of "now". `description` carries an
 * `&`, so channel-level escaping is exercised too, not just item text.
 */
function feedMeta(posts: readonly Post[]): FeedMeta {
  const newest = posts[0];

  return {
    title: BLOG_TITLE,
    link: `${SITE_URL}/blog`,
    description: BLOG_DESCRIPTION,
    id: `${SITE_URL}/blog`,
    author: BLOG_AUTHOR,
    // exactOptionalPropertyTypes: only attach `updated` when we actually have one.
    ...(newest === undefined ? {} : { updated: new Date(newest.publishedAt) }),
  };
}

/** Map a post row onto a `FeedItem`. The link doubles as the entry's stable id. */
function toFeedItem(post: Post): FeedItem {
  const link = `${SITE_URL}/blog/${post.slug}`;

  return {
    title: post.title,
    link,
    id: link,
    description: post.summary,
    published: new Date(post.publishedAt),
    author: post.author,
  };
}

/**
 * Wrap a feed's XML string in a response tagged with its content type.
 *
 * `@lesto/web`'s `Context` has `json`/`html`/`text`/`bytes`/`stream`, but no XML
 * helper — so a feed route returns the `LestoResponse` shape directly to set
 * `application/rss+xml` / `application/atom+xml` (the one small wiring note this
 * example surfaces; see the README's DX findings).
 */
function feedResponse(xml: string, contentType: string): LestoResponse {
  return { status: 200, headers: { "content-type": contentType }, body: xml };
}

/** A minimal HTML index that links to both feeds — the browsable landing page. */
function indexPage(posts: readonly Post[]): string {
  // `escapeXml` (a `@lesto/feeds` export) escapes the five predefined entities, so
  // it is equally correct for the HTML text and attributes reflected here.
  const items = posts
    .map((post) => {
      const href = escapeXml(`${SITE_URL}/blog/${post.slug}`);

      return `<li><a href="${href}">${escapeXml(post.title)}</a></li>`;
    })
    .join("");

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>${escapeXml(BLOG_TITLE)}</title></head><body>` +
    `<h1>${escapeXml(BLOG_TITLE)}</h1>` +
    `<p>Subscribe: <a href="/feed.xml">RSS 2.0</a> · <a href="/atom.xml">Atom 1.0</a></p>` +
    `<ul>${items}</ul></body></html>`
  );
}

/**
 * The routes, closing over the posts reader they render.
 *
 *   GET /          the HTML index
 *   GET /feed.xml  the posts as RSS 2.0
 *   GET /atom.xml  the posts as Atom 1.0
 */
export function buildFeedsApp(deps: { readonly loadPosts: () => Promise<Post[]> }): Lesto {
  const { loadPosts } = deps;

  return lesto()
    .get("/", async (c) => c.html(indexPage(await loadPosts())))
    .get("/feed.xml", async () => {
      const posts = await loadPosts();

      return feedResponse(rss(feedMeta(posts), posts.map(toFeedItem)), RSS_CONTENT_TYPE);
    })
    .get("/atom.xml", async () => {
      const posts = await loadPosts();

      return feedResponse(atom(feedMeta(posts), posts.map(toFeedItem)), ATOM_CONTENT_TYPE);
    });
}

/** What `buildApp` returns: the app plus the reader run.ts / the test drive. */
export interface Booted {
  readonly app: Lesto;
  readonly loadPosts: () => Promise<Post[]>;
}

export interface BuildOptions {
  /** A SQL database handle (from `@lesto/runtime`'s `openSqlite`). */
  readonly handle: KernelDatabase;

  /** The posts to seed; defaults to {@link SEED_POSTS}. */
  readonly posts?: readonly Post[];
}

/**
 * Boot the feeds app: install the `posts` schema on the handle, seed it, build a
 * newest-first reader over it, and wire the routes.
 *
 * The `@lesto/runtime` SQLite handle is exactly the SQL surface used here — one
 * `handle` flows into `exec`/`prepare` with no adapter and no cast.
 */
export async function buildApp(options: BuildOptions): Promise<Booted> {
  const { handle, posts = SEED_POSTS } = options;

  await handle.exec(POSTS_SCHEMA);
  await seedPosts(handle, posts);

  const loadPosts = createLoadPosts(handle);
  const app = buildFeedsApp({ loadPosts });

  return { app, loadPosts };
}
