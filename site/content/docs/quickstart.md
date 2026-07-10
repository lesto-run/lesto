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
```

The scaffolder writes the project, installs its dependencies with `bun install`
(pass `--no-install` to run your own package manager instead), and makes an
initial git commit (`--no-git` to skip). What you get is a minimal but *real* app — it boots on `@lesto/kernel`, has a
typed `posts` table backed by a migration, a file-routed home page, a code-first
JSON API, one interactive island, and a wired Tailwind v4 + shadcn/ui setup:

```
my-app/
  lesto.app.ts          # tables, migrations, API routes, security, UI config
  lesto.sites.ts        # which zones render static vs. dynamic
  env.ts                # typed, validated environment (server half)
  env.client.ts         # the PUBLIC_* env schema the browser may read
  app/
    routes/
      page.tsx          # the home page — file-routed at /
      layout.tsx        # wraps every file-routed page
    islands/
      counter.tsx       # one interactive island
    styles/app.css      # the Tailwind v4 + shadcn theme
    lib/utils.ts        # cn() — the shadcn class-merge helper
  components.json       # shadcn manifest — npx shadcn add works on day one
  worker.ts             # the Cloudflare Worker entry (the edge twin)
  wrangler.jsonc        # the Cloudflare deploy config
  tsconfig.json         # strict, ESM, bundler resolution
  package.json          # @lesto/* deps + dev/build scripts
  AGENTS.md             # onboards any coding agent (CLAUDE.md defers to it)
  .claude/skills/lesto/ # a first-party Claude Code skill
  .gitignore
  README.md
```

Routes live in two places, on purpose. Pages are **file-routed**: a `page.tsx`
under `app/routes/` registers its directory's URL — the home page is
`app/routes/page.tsx`, and no `.page()` call exists anywhere. API routes are
**code-first**: chained `.get`/`.post` calls in `lesto.app.ts`. Both land on the
same router.

## Run it

```bash
npm run dev
```

`npm run dev` runs `lesto dev`, which loads `lesto.app.ts`, has the kernel apply
your migrations, and serves every zone live on one origin. It prints two lines
you care about:

```
dev server on http://127.0.0.1:3000
lesto dev: MCP control plane on http://127.0.0.1:<port>/ (x-lesto-dev-token: <token>)
```

Open the first: you'll see "Welcome to Lesto" and a counter button. The button
is inert until the Preact client bundle hydrates the island — a working click is
the visible proof hydration is live. Edit the island and Vite Fast Refresh swaps
it in place, preserving its state. Pass `--port` to change the port.

The second line is the dev-only, loopback-only **MCP control plane**: point an
MCP client (Claude Code, for example) at it and the agent can call
`describe_app`, list routes, query content, and tail logs — read-only by
default. The scaffold's `AGENTS.md` and its bundled Claude Code skill teach an
agent the whole loop; see [Agent control plane](/batteries/mcp).

## A tour of the key files

**`lesto.app.ts`** is the heart. It defines the `posts` table as a value, two
migrations (create + seed), and a code-first `lesto()` app whose handlers close
over a typed `@lesto/db` handle:

```ts
function buildApp(db: Db) {
  return lesto()
    .client("/client.js")   // the island bundle every page boots
    .styles("/styles.css")  // the compiled Tailwind stylesheet
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
kernel's per-client rate limiting). `ui: { dialect: "preact", css: "app/styles/app.css" }`
ships a ~10 KB island client and names the CSS entry the build compiles.

**`app/routes/page.tsx`** is the home page — the "drop a file, get a route"
convention. It default-exports a `PageDef` with a server `load` and a component
whose props are inferred via `PageProps<typeof load>`. `app/routes/layout.tsx`
wraps every file-routed page.

**`env.ts`** and **`env.client.ts`** are the typed environment (`@lesto/env`).
`defineEnv` validates it once at boot — a missing var fails fast, not mid-request
— and enforces the leak boundary: server vars never reach the browser (reading
one in an island throws `ENV_SERVER_LEAK`), while `PUBLIC_*` client vars are
inlined into the island bundle. The starter wires one knob, `env.LESTO_DB`.

**`app/islands/counter.tsx`** is the one island — a `defineIsland` default
export. `lesto dev`/`build` discover one island per file here and bundle them
into `/client.js`; everything else stays server-only.

**`app/styles/app.css`** is the Tailwind v4 entry, carrying the full shadcn/ui
OKLCH theme. The build compiles it to `/styles.css` and links it on every page.
With `components.json` and `app/lib/utils.ts` (`cn()`) already wired, the app is
a generic shadcn project: `npx shadcn add button` drops a component into
`app/components/ui`.

**`lesto.sites.ts`** declares your sites. The starter has one dynamic site at the
root, so every route runs live through the app's handler:

```ts
const sites: Site[] = [{ name: "app", render: "dynamic", basePath: "/" }];
export default sites;
```

**`worker.ts`** is the Cloudflare Worker entry: a thin adapter that fronts the
app through `@lesto/cloudflare`'s `toFetchHandler` + `withAssets`. It mounts the
*same* file-routed home page and layout the dev server serves — but registers
them explicitly, because a Worker has no filesystem to scan routes from, and it
leaves the SQLite-backed `/posts` routes off the edge until you wire a D1
binding. **`wrangler.jsonc`** wires `nodejs_compat`, the `worker.ts` entry, and
the `ASSETS` binding rooted at `out/`.

For the deeper model behind all of this — apps, sites, islands, the kernel — see
**[Concepts](/concepts)**.

## Call the API

The seed migration gives `GET /posts` content on first boot:

```bash
curl http://localhost:3000/posts
```

State-changing requests are CSRF-guarded by default. The origin check reads the
browser's `Sec-Fetch-Site` header — a non-browser client like `curl` sends none,
so set it explicitly or the request is refused with a 403:

```bash
curl -X POST http://localhost:3000/posts \
  -H 'Content-Type: application/json' \
  -H 'Sec-Fetch-Site: same-origin' \
  -d '{"title":"My first post","body":"Hello from curl."}'
```

A blank `title` or `body` comes back as a 422 — that's the `c.valid` boundary
check, not a crash.

## Add a page

Drop a file. A `page.tsx` under `app/routes/` registers its directory's URL —
no manual wiring:

```tsx
// app/routes/about/page.tsx
import type { PageDef, PageProps } from "@lesto/web";

const load = () => ({ tagline: "Batteries included." });

const page: PageDef<"/about", PageProps<typeof load>> = {
  load,
  component: ({ tagline }) => (
    <main>
      <h1>About</h1>
      <p>{tagline}</p>
    </main>
  ),
  metadata: () => ({ title: "About" }),
};

export default page;
```

`load` runs on the server before render; its return value is the component's
props, inferred once via `PageProps<typeof load>`. A `[param]` directory is a
dynamic segment, `[...rest]` a catch-all, and a `layout.tsx` wraps everything at
or below it.

A page that needs the database can instead be chained code-first in `buildApp`,
where the typed `db` is in scope — `.page()` takes the same `PageDef` shape:

```ts
.page("/posts-page", {
  load: async () => ({ posts: await db.select().from(posts).orderBy(posts.id, "asc").all() }),
  component: PostsPage,
  metadata: () => ({ title: "Posts" }),
})
```

**Static vs. dynamic** is decided by `lesto.sites.ts`, not the page: a `dynamic`
zone renders every request live (what the starter does), while a `static` zone
is prerendered to disk at build time — declare one by adding a site with
`render: "static"` and a `pages` list.

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
npm run build       # prerender static zones, bundle the islands, compile the CSS into out/
npx wrangler deploy # ship the Worker and its assets to Cloudflare
```

`npm run build` runs `lesto build`, which prerenders any static sites, bundles
the islands into `out/client.js`, and compiles the stylesheet to
`out/styles.css` — the directory `wrangler.jsonc` binds as `ASSETS`.
`wrangler deploy` then uploads `worker.ts` and that `out/` directory in one
atomic, Cloudflare-versioned step. You can also run the one-command
`npx lesto deploy --cloudflare`, which builds `out/` and runs `wrangler deploy`
for you; add `--health-url <url>` and a failing post-deploy probe rolls the
Worker back automatically. First time, run `wrangler login` once to
authenticate against your account.

See **[Deploy to Cloudflare](/deploy/cloudflare)** for the full runbook —
secrets, the `name`/subdomain, and lighting the SQLite-backed routes on the edge
over a D1 binding. Every `lesto` command and flag is in the
**[CLI reference](/reference/cli)**.

## Where to go next

The repository ships runnable example apps:

- **[`examples/blog`](https://github.com/lesto-run/lesto/tree/main/examples/blog)** — a typed schema, a streamed SSR page, and a JSON API.
- **[`examples/queue-dashboard`](https://github.com/lesto-run/lesto/tree/main/examples/queue-dashboard)** — the background-job operator dashboard.
- **[`examples/estate`](https://github.com/lesto-run/lesto/tree/main/examples/estate)** — auth-aware static + dynamic zones on one origin, deployed to Cloudflare.

Then read **[Concepts](/concepts)** for the model behind the pieces, or wire up
the **[Data](/batteries/data)** layer.
