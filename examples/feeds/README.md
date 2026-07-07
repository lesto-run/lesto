# examples/feeds — RSS 2.0 & Atom 1.0 over HTTP

Wires **`@lesto/feeds`** behind real HTTP routes: a small blog whose posts live in
a SQLite table, syndicated as a spec-valid RSS 2.0 `/feed.xml` and Atom 1.0
`/atom.xml`. The same posts feed both dialects, all post text is XML-escaped, and
the documents are asserted well-formed — with **no XML dependency** (the whole
point of `@lesto/feeds` is that it needs none).

## What it shows

| Route          | Behavior                                                                              |
| -------------- | ------------------------------------------------------------------------------------- |
| `GET /`        | A minimal HTML index linking to both feeds — the browsable landing page.              |
| `GET /feed.xml`  | The posts rendered as RSS 2.0 (`rss(meta, items)`) — `<channel>`, `<item>`s, RFC 822 `<pubDate>`. |
| `GET /atom.xml`  | The **same** posts rendered as Atom 1.0 (`atom(meta, items)`) — `<feed>`, `<entry>`s, RFC 3339 `<updated>`. |

- **One document, two dialects.** The identical `{ FeedMeta, FeedItem[] }` feeds
  both `rss(...)` and `atom(...)`; the builders differ only in the XML they emit.
- **Untrusted text can't break the feed.** One seeded post's title & summary carry
  `&`, `<`, `>` on purpose (`SPECIAL_POST`) — the feed escapes them into entities
  (`Tips &amp; Tricks: &lt;marquee&gt;…`) and never leaks the raw characters.
- **Feeds from DB rows.** A `SELECT … ORDER BY published_at DESC` maps straight
  onto `FeedItem`s — what a real blog actually does.

Only `@lesto/feeds`' public API builds the feeds: `rss`, `atom`, `escapeXml`, and
the `FeedMeta` / `FeedItem` types. The routes are plain `@lesto/web`; the database
is `@lesto/runtime`'s `openSqlite`. `FeedMeta`/`FeedItem` require only `title` and
`link` each — everything else (channel `<description>`, Atom `<id>`/`<updated>`,
entry `<id>`/`<updated>`) is either supplied here or synthesized by the battery,
so every emitted document is spec-valid.

### Why a SQLite table (data-source choice)

The feature on show is XML generation, so the data source is kept deliberately
small — but **"a feed from your posts table"** is the honest, canonical use of
`@lesto/feeds`, so this backs the routes with a real `posts` table rather than an
in-memory array. The payoff: `serve.ts` uses **one** database for both the posts
query and `@lesto/kernel`'s durable schema — no throwaway handle. The table is a
single `CREATE TABLE` seeded on boot; publish dates are stored as epoch-ms and
handed to the builders as `Date`s, which `@lesto/feeds` formats per dialect.

## How to run

```bash
bun run examples/feeds/run.ts
```

Boots the blog on an in-memory SQLite database, seeds the posts, then drives the
HTTP routes — printing each feed's status, content type, a leading snippet, and
the one line where a post's `&`/`<`/`>` was escaped into entities.

## How it's tested (the QA gate)

```bash
bun run --filter '@lesto/example-feeds' test
```

`test/feeds.test.ts` drives the routes with `app.handle` and asserts what only an
end-to-end wiring can prove:

- `GET /feed.xml` and `/atom.xml` each answer `200` with the correct feed content
  type (`application/rss+xml` / `application/atom+xml`);
- each body is a **well-formed** XML document — it opens with the XML declaration
  and contains **no bare ampersand** (every `&` opens a valid entity; a single
  unescaped `&` fails any real parser, so this regex is a strict well-formedness
  proxy, taken because neither Node nor Bun ships a `DOMParser` and this example
  adds no XML-parser dependency);
- every required RSS channel / Atom feed element is present;
- the feed carries exactly one `<item>` / `<entry>` per seeded post;
- the special-char post is escaped — the escaped forms are present **and** its raw
  title/summary never appear (the load-bearing correctness check).

`test/serve.smoke.test.ts` adds the hosted leg — it boots `serve.ts` over a real
socket and asserts `GET /feed.xml` returns a well-formed RSS document (see below).

## How to deploy / run the hosted leg

```bash
bun run examples/feeds/serve.ts
```

`buildApp` returns a bare `@lesto/web` app, not a bootable one — `serve.ts` wraps
it with `@lesto/kernel`'s `createApp` (installing the durable-store schema on the
**same** handle the posts live on) and serves THAT behind a real `node:http`
server (`@lesto/runtime`'s `serveWithGracefulShutdown`), so a real feed reader —
or `curl` — can fetch the feeds over a socket:

```bash
open http://localhost:3000/        # the index, in a browser
curl localhost:3000/feed.xml       # RSS 2.0
curl localhost:3000/atom.xml       # Atom 1.0
```

**The boot is proven automatically.** `test/serve.smoke.test.ts` spawns `bun run
serve.ts` on an ephemeral port, `fetch()`es `GET /feed.xml` over a real socket,
asserts a `200` with `application/rss+xml` and a well-formed `<?xml … <rss …>`
body, then SIGTERMs and asserts a clean `exit(0)` — so the hosted boot (`buildApp`
→ `createApp` → `serveWithGracefulShutdown`) is exercised end-to-end, not merely
typechecked. Starting a long-lived server by hand is blocked in this sandbox, so
that smoke test IS the proof the hosted leg boots; its wiring mirrors the pattern
every hosted `serve.ts` in the gallery uses (see `examples/cache/serve.ts`).

## DX findings

1. **No `c.xml` content-type helper.** `@lesto/web`'s `Context` ships
   `json`/`html`/`text`/`bytes`/`stream`, but a feed is neither `text/plain` nor
   `text/html` — so a feed route returns the `LestoResponse` shape directly
   (`{ status, headers: { "content-type": "application/rss+xml…" }, body }`) to
   set the right type. It's a one-liner (see `feedResponse` in `src/app.ts`), but
   a `c.xml(body, contentType?)` — or letting `c.text` take a content type — would
   make feeds/sitemaps/OPML routes read as cleanly as `c.json`. → `@lesto/web`
   (minor).
2. **`@lesto/feeds` is a joy to wire.** The `{ FeedMeta, FeedItem[] }` → string
   surface is exactly right: no builder objects, no I/O, no parser, and `escapeXml`
   is exported so the same escaping can be reused (this example uses it for the
   HTML index too). Required fields are just `title` + `link`; everything a valid
   feed can't omit is synthesized, so a minimal call still emits a spec-valid
   document. Nothing missing for this use.
