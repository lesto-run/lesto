---
title: Quickstart
description: Scaffold a Lesto app, run it locally, and deploy it to Cloudflare.
section: Getting started
order: 2
---

# Quickstart

From an empty directory to a deployed app. You'll scaffold a real (small but
runnable) Lesto app, boot it locally, tour its files, add a page and a table,
then ship it to Cloudflare.

## Scaffold

```package-install
npm create lesto@latest my-app
cd my-app
npm install
```

This writes a minimal but *real* app — it boots on `@lesto/kernel`, has a typed
`posts` table backed by a migration, a code-first `lesto()` app with a page and
JSON routes, and one interactive island. The emitted tree is exactly:

```
my-app/
  lesto.app.ts        # the whole app: table, migration, routes, pages, config
  lesto.sites.ts      # which zones render static vs. dynamic
  app/islands/        # interactive components (one per file)
    counter.tsx
  worker.ts           # the Cloudflare Worker entry (the edge twin)
  wrangler.jsonc      # the Cloudflare deploy config
  tsconfig.json       # strict, ESM, bundler resolution
  package.json        # @lesto/* deps + dev/build scripts
  .gitignore
  README.md
```

There's no `src/` or `app/routes/` directory: the starter is *code-first*, so
the entire application lives in `lesto.app.ts`. (File-based routing under
`app/routes/` is available, but the scaffold doesn't use it.)

## Run it

```bash
npm run dev
```

`npm run dev` runs `lesto dev`, which loads `lesto.app.ts`, has the kernel apply
your migrations, builds the island client bundle (`/client.js`) from
`app/islands/`, and serves every zone live on one origin. It prints:

```
dev server on http://127.0.0.1:3000
```

Open it: you'll see "Welcome to Lesto" and a counter button. The button is inert
until the Preact client bundle hydrates the island — a working click is the
visible proof hydration is live. Editing an island re-bundles on save; pass
`--port` to change the port.

## A tour of the key files

**`lesto.app.ts`** is the heart. It defines the `posts` table as a value, a
migration that runs `createTableSql(posts)`, and a code-first `lesto()` app whose
handlers close over a typed `@lesto/db` handle:

```ts
function buildApp(db: Db) {
  return lesto()
    .client("/client.js")
    .page("/", { component: () => /* ... renders the Counter island */ })
    .get("/posts", async (c) => {
      const rows = await db.select().from(posts).orderBy(posts.id, "asc").all();
      return c.json({ posts: rows });
    })
    .post("/posts", async (c) => {
      const input = c.valid(NewPost); // Zod at the boundary — a bad body is a 422
      // ... insert and return 201
    });
}
```

The file default-exports a `LestoAppConfig` — `{ db, app, migrations, secure, ui }`
— that the CLI boots. Two conventions ship on by default: **validation at the
boundary** (the `POST` handler runs the untrusted body through a Zod schema via
`c.valid` before it touches the database), and **security declared in one place**
(`secure: { originCheck: {} }` adds zero-token, header-based CSRF on top of the
kernel's per-client rate limiting). `ui: { dialect: "preact" }` ships a ~10 KB
island client.

**`lesto.sites.ts`** declares your sites. The starter has one dynamic site at the
root, so every route runs live through the app's handler:

```ts
const sites: Site[] = [{ name: "app", render: "dynamic", basePath: "/" }];
export default sites;
```

**`app/islands/counter.tsx`** is the one island — a `defineIsland` default export.
`lesto dev`/`build` discover one island per file here and bundle them into
`/client.js`.

**`worker.ts`** is the Cloudflare Worker entry: a thin adapter that fronts the app
through `@lesto/cloudflare`'s `toFetchHandler` + `withAssets`. It builds a minimal
*edge twin* (the island home page) rather than importing `lesto.app.ts`, because a
Worker has no filesystem for the local SQLite handle that file opens at module
scope. **`wrangler.jsonc`** wires `nodejs_compat`, the `worker.ts` entry, and the
`ASSETS` binding rooted at `out/`.

For the deeper model behind all of this — apps, sites, islands, the kernel — see
**[Concepts](/concepts)**.

## Add a page

A page pairs a server `load` with a component that renders its result. Write the
component as an ordinary React component in a `.tsx` file:

```tsx
// src/posts-page.tsx
import type { Post } from "./posts";

export function PostsPage({ posts }: { posts: Post[] }) {
  return (
    <main>
      <h1>Posts</h1>
      {posts.map((post) => (
        <p key={post.id}>{post.title}</p>
      ))}
    </main>
  );
}
```

Then register it in `lesto.app.ts`:

```ts
import { PostsPage } from "./src/posts-page";

app.page("/posts", {
  load: async () => ({ posts: await db.select().from(posts).orderBy(posts.id, "asc").all() }),
  component: PostsPage,
  metadata: () => ({ title: "Posts" }),
});
```

`load` runs on the server before render; its return value is the component's
props. **Static vs. dynamic** is decided by `lesto.sites.ts`, not the page: a
`dynamic` zone renders every request live (what the starter does), while a
`static` zone is prerendered to disk at build time — declare one by adding a site
with `render: "static"` and a `pages` list. Routes read top-to-bottom like
Hono or Express; grow the app by chaining more `.get`/`.post`/`.page` calls.

## Add a bit of data

Tables are plain values — schema as a value backs both the migration's DDL and the
inferred row type every query returns. The starter already defines `posts`; add a
column the same way and query through the typed `Db`:

```ts
export const posts = defineTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// In a handler — fully typed, no globals:
const rows = await db.select().from(posts).orderBy(posts.id, "asc").all();
const post = await db.insert(posts).values({ /* ... */ }).returning().get();
```

Every schema change pairs with a migration entry (`up`/`down`) in the config's
`migrations` array; the kernel runs pending ones on boot. The full query builder,
column types, relations, and JOINs are covered in **[Data](/batteries/data)**.

## Build and deploy

```package-install
npm run build       # prerender static zones + bundle the island client into out/
npx wrangler deploy # ship the Worker and its assets to Cloudflare
```

`npm run build` runs `lesto build`, which prerenders any static sites and bundles
`/client.js` into `out/` — the directory `wrangler.jsonc` binds as `ASSETS`.
`wrangler deploy` then uploads `worker.ts` and that `out/` directory in one
atomic, Cloudflare-versioned step. (You can also run the one-command
`lesto deploy --cloudflare`, which builds `out/` and runs `wrangler deploy` for
you, with an optional post-deploy health gate.) First time, run `wrangler login`
once to authenticate against your account.

See **[Deploy to Cloudflare](/deploy/cloudflare)** for the full runbook —
secrets, the `name`/subdomain, and lighting the SQLite-backed routes on the edge
over a D1 binding. Every `lesto` command and flag is in the
**[CLI reference](/reference/cli)**.

## Worked examples

The repository ships runnable example apps:

- **[`examples/blog`](https://github.com/lesto-run/lesto/tree/main/examples/blog)** — a typed schema, a streamed SSR page, and a JSON API.
- **[`examples/queue-dashboard`](https://github.com/lesto-run/lesto/tree/main/examples/queue-dashboard)** — the background-job operator dashboard.
- **[`examples/estate`](https://github.com/lesto-run/lesto/tree/main/examples/estate)** — auth-aware static + dynamic zones on one origin, deployed to Cloudflare.
