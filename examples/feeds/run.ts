/**
 * The whole feed-generation journey, in-process, in one run.
 *
 *   bun run examples/feeds/run.ts
 *
 * It boots the blog on an in-memory SQLite database, seeds the posts, then drives
 * the actual HTTP routes with `app.handle` so you can read the two feeds the same
 * posts produce: a spec-valid RSS 2.0 `/feed.xml` and Atom 1.0 `/atom.xml`. It
 * prints each feed's status, content type, and a leading snippet, and finally
 * points at the one line where a post's `&`/`<`/`>` was escaped into entities —
 * the correctness the test locks down.
 */

import { openSqlite } from "@lesto/runtime";

import { buildApp } from "./src/app";

/** The first `lines` lines of an XML document — enough to see its shape. */
function snippet(xml: string, lines = 18): string {
  return xml.split("\n").slice(0, lines).join("\n");
}

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const { app, loadPosts } = await buildApp({ handle });

  const posts = await loadPosts();
  console.log(
    `seeded ${posts.length} posts (newest first): ${posts.map((p) => p.slug).join(", ")}\n`,
  );

  // 1. RSS 2.0 — the posts as an <rss><channel> of <item>s (RFC 822 <pubDate>).
  const feed = await app.handle("GET", "/feed.xml");
  console.log(`GET /feed.xml -> ${feed.status}  ${String(feed.headers["content-type"])}`);
  console.log(snippet(feed.body));
  console.log("  …\n");

  // 2. Atom 1.0 — the SAME posts as a <feed> of <entry>s (RFC 3339 <updated>).
  const atomFeed = await app.handle("GET", "/atom.xml");
  console.log(`GET /atom.xml -> ${atomFeed.status}  ${String(atomFeed.headers["content-type"])}`);
  console.log(snippet(atomFeed.body));
  console.log("  …\n");

  // 3. Escaping in action — the special-char post's `&`/`<`/`>` rendered as
  //    entities, so untrusted post text can never break the document.
  const escaped = feed.body
    .split("\n")
    .find((line) => line.includes("&amp;") && line.includes("&lt;"));
  console.log(`escaping in action:  ${escaped?.trim() ?? "(none found)"}`);

  close();
}

await main();
