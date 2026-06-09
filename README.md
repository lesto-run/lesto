# Keel

**Keel is a batteries-included, AI-native, fullstack TypeScript framework** — the best of Rails (conventions, ActiveRecord ORM, migrations, RESTful routing), Laravel (in-house batteries: queues, mail, cache, events), WordPress (content, an admin surface, and an actions/filters extensibility model that lets anyone build onto the platform), and Next.js (React, server-side rendering, DX), with one twist the others predate: it is designed to be driven by an agent. Every capability is an in-house API on **one substrate — the SQL database** (SQLite for zero-config local, Postgres for scale), so there is no zoo of external services to glue together; thin drivers live only at the irreducible edges (mail transport, object storage, OAuth). The north star: change your site's content, UI, schema, and data — and ship it — from code, the CLI, or an MCP client inside Claude or ChatGPT.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the product vision and the build order, and [CONVENTIONS.md](./CONVENTIONS.md) for the engineering bar.

## Package catalog

Fifty `@keel/*` packages and counting. The highlights below are grouped by domain; each is in-house, depends on interfaces rather than drivers, and is built to the same standard below.

### Data

| Package | What it does |
|---|---|
| [`@keel/orm`](./packages/orm) | ActiveRecord-style ORM — typed models, a fluent query builder, and validations over any SQL database. |
| [`@keel/migrate`](./packages/migrate) | Schema-builder DSL and migrator — version-stamped, idempotent migrations on an injected SQL database. |
| [`@keel/storage`](./packages/storage) | Object storage behind one API — pluggable backends (in-memory, local filesystem; S3 to come). |

### Async

| Package | What it does |
|---|---|
| [`@keel/queue`](./packages/queue) | Durable job queue — at-least-once delivery with visibility-timeout reclaim, on the SQL database, no Redis. |
| [`@keel/workflows`](./packages/workflows) | Durable workflows — DBOS-style step memoization on the SQL database, with crash-safe resume. |
| [`@keel/cache`](./packages/cache) | TTL cache — pluggable stores (in-memory or SQL-backed) over an injected clock. |
| [`@keel/pubsub`](./packages/pubsub) | In-process publish/subscribe hub — synchronous registration, awaited delivery. |

### Comms

| Package | What it does |
|---|---|
| [`@keel/mail`](./packages/mail) | Mailers — react-email templates with queued delivery on `@keel/queue` and a pluggable transport. |
| [`@keel/mailing-lists`](./packages/mailing-lists) | Ghost-style subscriber lists — double opt-in and broadcasts, composed on `@keel/orm`, `@keel/mail`, and `@keel/queue`. |
| [`@keel/webhooks`](./packages/webhooks) | Webhooks — HMAC-signed outbound delivery (retried on `@keel/queue`) and inbound signature verification. |

### Content

The WordPress-class content engine — folded in from Docks (`@usedocks/*`), rebuilt on the substrate. Fifteen `@keel/content-*` packages; the load-bearing ones:

| Package | What it does |
|---|---|
| [`@keel/content-core`](./packages/content-core) | Schema-driven content engine — collections, validated frontmatter, computed fields, taxonomies, and the markdown/MDX pipeline. |
| [`@keel/content-store`](./packages/content-store) | Content on the SQL substrate — persists pipeline entries to the database and hydrates the runtime from it. CRUD on `content_entries`. |
| [`@keel/content-mdx`](./packages/content-mdx) · [`@keel/content-markdown`](./packages/content-markdown) | MDX compilation and markdown rendering for content. |
| [`@keel/content-search`](./packages/content-search) · [`@keel/content-embeddings`](./packages/content-embeddings) | Client-safe vector search and build-time embedding generation. |
| [`@keel/content-seo`](./packages/content-seo) | Content-aware SEO analysis and entry-aware JSON-LD (complements zero-dep `@keel/seo`). |
| [`@keel/content-prose`](./packages/content-prose) · [`@keel/content-lint`](./packages/content-lint) | Prose-quality and writing linters. |
| [`@keel/content-vite`](./packages/content-vite) | Vite plugin — generates content on build, serves raw markdown in dev, guards client bundle size. |
| [`@keel/content-mcp`](./packages/content-mcp) | Standalone content MCP server — schema introspection, search, file/Studio-oriented CRUD (distinct from the DB-backed content tools `@keel/mcp` exposes on the control plane). |

Content is reachable from every surface: author with `keel content:new`, compile to the database with `keel content:build` (`--prune` to mirror the source exactly), delete with `keel content:delete`, and read or write it from agents through the MCP content tools (`list_content_collections`, `get_content_entry`, `query_content`, `create_content_entry`, `update_content_entry`, `delete_content_entry`).

### Identity

| Package | What it does |
|---|---|
| [`@keel/auth`](./packages/auth) | Authentication primitives on `node:crypto` — password hashing, tokens, and sessions. |
| [`@keel/rbac`](./packages/rbac) | Role-based authorization — roles, wildcard permissions, and inheritance, as pure logic. |

### Platform

| Package | What it does |
|---|---|
| [`@keel/hooks`](./packages/hooks) | WordPress-style extensibility core — actions (side effects) and filters (value transforms), instance-based and pure. |
| [`@keel/config`](./packages/config) | Typed configuration loader — read, validate, and coerce config from a string source. |
| [`@keel/observability`](./packages/observability) | In-house distributed-tracing core — OpenTelemetry-shaped, with no OpenTelemetry dependency. |

### UI / Web

| Package | What it does |
|---|---|
| [`@keel/ui`](./packages/ui) | AI-native UI rendering engine — validate a JSON UI tree and render it to React against a vetted component registry. |
| [`@keel/web`](./packages/web) | MVC request-handling core — a Rails-style controller layer that weds `@keel/router` and `@keel/ui`. |
| [`@keel/router`](./packages/router) | RESTful router — declare routes and named paths, resolve method + path to a `controller#action`. |

### Runtime

| Package | What it does |
|---|---|
| [`@keel/kernel`](./packages/kernel) | Application kernel — assembles the database, migrations, router, and controllers into one bootable app. |

## Engineering standard

The bar, enforced per package (`packages/queue` is the reference implementation):

- **Strict TypeScript** — `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and more. No `any`, no type-dodging casts.
- **ESM only** — `import` / `export`, never `require`; `Bundler` module resolution, so imports are extensionless.
- **Bun** — the runtime; packages run their TypeScript directly (`exports` point at `./src/index.ts`). Targets Node ≥ 22 for compatibility.
- **oxlint + oxfmt** — the linter and the formatter; the formatter owns whitespace.
- **vitest with enforced 100% coverage** — lines, functions, branches, and statements, thresholds set in each package's `vitest.config.ts`. A line we cannot cover is a line we should not have written.
- **Errors carry codes** — every failure is a `KeelError` subclass with a stable, machine-readable `code`; callers branch on `code`, never on a message.

## Quickstart

The runnable end-to-end example lives in [`examples/blog`](./examples/blog) — a small blog that wires the whole stack together: a `Post` ORM model, a migration that creates the `posts` table, an app-defined `@keel/ui` registry (`Page` + `PostCard`), a `PostsController` that renders an HTML page via `renderTree` and serves a JSON API, RESTful routes via `resources("posts")`, all booted by `@keel/kernel` over a SQLite database.

```sh
bun install
bun run examples/blog/run.ts
```

It boots the app, runs migrations, seeds a few posts, and dispatches `GET /posts` (server-rendered HTML) and `GET /api/posts` (JSON), printing the real responses:

```
migrations applied: [ "001_create_posts" ]
posts seeded: 3

GET /posts -> 200 text/html
<main><h1>The Keel Blog</h1><section><article><h2>Hello, Keel</h2>...</section></main>

GET /api/posts -> 200 application/json
{"posts":[{"id":1,"title":"Hello, Keel",...}]}
```

The canonical Keel driver is **better-sqlite3** (what the kernel's own end-to-end test boots). Because Bun cannot yet load better-sqlite3's native addon, the example's adapter transparently falls back to Bun's built-in `bun:sqlite` when run with `bun run` — both satisfy the same `KernelDatabase` interface, so the app code is identical either way.

### Run the server

The same app can be served over live HTTP via [`@keel/runtime`](./packages/runtime)'s `serve()`, which stands a real `node:http` server in front of the kernel. [`examples/blog/serve.ts`](./examples/blog/serve.ts) boots the app, seeds it, and listens on port `3000` (override with `PORT`):

```sh
bun run examples/blog/serve.ts
```

```
migrations applied: [ "001_create_posts" ]
posts seeded: 3

listening on http://127.0.0.1:3000
```

Then hit it with `curl` (or a browser):

```sh
curl http://127.0.0.1:3000/posts      # server-rendered HTML
curl http://127.0.0.1:3000/api/posts  # JSON API
```

```
$ curl http://127.0.0.1:3000/api/posts
{"posts":[{"id":1,"title":"Hello, Keel","body":"A batteries-included, AI-native TypeScript framework.",...}]}
```

## Further reading

- [ARCHITECTURE.md](./ARCHITECTURE.md) — the product vision, the three pillars (Tracks, Loom, Docks), and the dependency-aware build order.
- [CONVENTIONS.md](./CONVENTIONS.md) — the engineering conventions, in full.
