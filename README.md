# Lesto

> *One substrate. Every capability. Agent-native from day one.*

**Lesto is a batteries-included, AI-native, fullstack TypeScript framework** — the best of Rails (conventions, ActiveRecord ORM, migrations, RESTful routing), Laravel (in-house batteries: queues, mail, cache, events), WordPress (content, an admin surface, and an actions/filters extensibility model that lets anyone build onto the platform), and Next.js (React, server-side rendering, DX), with one twist the others predate: it is designed to be driven by an agent. Every capability is an in-house API on **one substrate — the SQL database** (SQLite for zero-config local, Postgres for scale), so there is no zoo of external services to glue together; thin drivers live only at the irreducible edges (mail transport, object storage, OAuth). The north star: change your site's content, UI, schema, and data — and ship it — from code, the CLI, or an MCP client inside Claude or ChatGPT.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the product vision and the build order, and [CONVENTIONS.md](./CONVENTIONS.md) for the engineering bar.

## Package catalog

Fifty `@lesto/*` packages and counting. The highlights below are grouped by domain; each is in-house, depends on interfaces rather than drivers, and is built to the same standard below.

### Data

| Package | What it does |
|---|---|
| [`@lesto/migrate`](./packages/migrate) | Tracks-style migrator — version-stamped, idempotent migrations over `@lesto/db` schema-as-value DDL on an injected SQL database. |
| [`@lesto/pg`](./packages/pg) | The Node Postgres driver — adapts a node-postgres `Pool` to the same async `SqlDatabase` seam SQLite satisfies (`openPostgres`), so an app moves from SQLite to Postgres with no change above the driver. |
| [`@lesto/cloudflare`](./packages/cloudflare) | Run a Lesto app on Cloudflare Workers — the `fetch`-handler + static-assets adapter, plus the edge's two SQL drivers for the same `SqlDatabase` surface: `d1ToSqlDatabase` (D1, the edge's SQLite) and `hyperdriveToSqlDatabase` (Cloudflare Hyperdrive fronting a real Postgres). Both bundle for Workers with no `node:*` builtins. |
| [`@lesto/storage`](./packages/storage) | Object storage behind one API — pluggable backends (in-memory, local filesystem; S3 to come). |

### Async

| Package | What it does |
|---|---|
| [`@lesto/queue`](./packages/queue) | Durable job queue — at-least-once delivery with visibility-timeout reclaim, on the SQL database, no Redis. |
| [`@lesto/workflows`](./packages/workflows) | Resumable step memoization on the SQL database — completed steps replay when `run()` is re-invoked with the same `runId` (caller-driven resume; not crash-safe durable execution — a run journal + resume driver is post-1.0). |
| [`@lesto/cache`](./packages/cache) | TTL cache — pluggable stores (in-memory or SQL-backed) over an injected clock. |
| [`@lesto/pubsub`](./packages/pubsub) | In-process publish/subscribe hub — synchronous registration, awaited delivery. |

### Comms

| Package | What it does |
|---|---|
| [`@lesto/mail`](./packages/mail) | Mailers — react-email templates with queued delivery on `@lesto/queue` and a pluggable transport. |
| [`@lesto/mailing-lists`](./packages/mailing-lists) | Ghost-style subscriber lists — double opt-in and broadcasts, composed on `@lesto/db`, `@lesto/mail`, and `@lesto/queue`. |
| [`@lesto/webhooks`](./packages/webhooks) | Webhooks — HMAC-signed outbound delivery (retried on `@lesto/queue`) and inbound signature verification. |

### Content

The WordPress-class content engine — folded in from Docks (`@usedocks/*`), rebuilt on the substrate. Fifteen `@lesto/content-*` packages; the load-bearing ones:

> **Supported in v1 vs. preview.** The **supported** content surface is the store/engine/CLI/MCP seam: `@lesto/content-store`, `@lesto/content-core`, the `lesto content:build` CLI, the `@lesto/mcp` content tools, and `HtmlContent` from `@lesto/content-components`. Everything else — search, embeddings, prose, lint, seo, query, vite, and content components beyond `HtmlContent` — ships **PREVIEW**: experimental, coverage-gate-exempt, and may change. Two preview limits worth knowing: `@lesto/content-search` is brute-force O(n) and practical only up to **~10k documents**; `@lesto/content-embeddings` downloads the `all-MiniLM-L6-v2` model (~25MB, via `@huggingface/transformers`) on a fresh build environment's first run (cache the model directory in CI).

| Package | What it does |
|---|---|
| [`@lesto/content-core`](./packages/content-core) | Schema-driven content engine — collections, validated frontmatter, computed fields, taxonomies, and the markdown/MDX pipeline. |
| [`@lesto/content-store`](./packages/content-store) | Content on the SQL substrate — persists pipeline entries to the database and hydrates the runtime from it. CRUD on `content_entries`. |
| [`@lesto/content-mdx`](./packages/content-mdx) · [`@lesto/content-markdown`](./packages/content-markdown) | MDX compilation and markdown rendering for content. |
| [`@lesto/content-search`](./packages/content-search) · [`@lesto/content-embeddings`](./packages/content-embeddings) | Client-safe vector search and build-time embedding generation. |
| [`@lesto/content-seo`](./packages/content-seo) | Content-aware SEO analysis and entry-aware JSON-LD (complements zero-dep `@lesto/seo`). |
| [`@lesto/content-prose`](./packages/content-prose) · [`@lesto/content-lint`](./packages/content-lint) | Prose-quality and writing linters. |
| [`@lesto/content-vite`](./packages/content-vite) | Vite plugin — generates content on build, serves raw markdown in dev, guards client bundle size. |
| [`@lesto/content-mcp`](./packages/content-mcp) | Standalone content MCP server — schema introspection, search, file/Studio-oriented CRUD (distinct from the DB-backed content tools `@lesto/mcp` exposes on the control plane). |

Content is reachable from every surface: author with `lesto content:new`, compile to the database with `lesto content:build` (`--prune` to mirror the source exactly), delete with `lesto content:delete`, and read or write it from agents through the MCP content tools (`list_content_collections`, `get_content_entry`, `query_content`, `create_content_entry`, `update_content_entry`, `delete_content_entry`).

### Identity

| Package | What it does |
|---|---|
| [`@lesto/auth`](./packages/auth) | Authentication primitives on `node:crypto` — password hashing, tokens, and sessions. |
| [`@lesto/authz`](./packages/authz) | First-class authorization — a declarative role/permission policy (wildcard grants, cycle-safe role inheritance) and the guard middleware that enforces it. |

### Platform

| Package | What it does |
|---|---|
| [`@lesto/observability`](./packages/observability) | In-house distributed-tracing core — OpenTelemetry-shaped, with no OpenTelemetry dependency. |

### UI / Web

| Package | What it does |
|---|---|
| [`@lesto/ui`](./packages/ui) | AI-native UI rendering engine — validate a JSON UI tree and render it to React against a vetted component registry. |
| [`@lesto/web`](./packages/web) | MVC request-handling core — a Rails-style controller layer that weds `@lesto/router` and `@lesto/ui`. |
| [`@lesto/router`](./packages/router) | RESTful router — declare routes and named paths, resolve method + path to a `controller#action`. |

### Runtime

| Package | What it does |
|---|---|
| [`@lesto/kernel`](./packages/kernel) | Application kernel — assembles the database, migrations, router, and controllers into one bootable app. |

## Engineering standard

The bar, enforced per package (`packages/queue` is the reference implementation):

- **Strict TypeScript** — `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and more. No `any`, no type-dodging casts.
- **ESM only** — `import` / `export`, never `require`; `Bundler` module resolution, so imports are extensionless.
- **Bun** — the runtime; packages run their TypeScript directly (`exports` point at `./src/index.ts`). Targets Node ≥ 22 for compatibility.
- **oxlint + oxfmt** — the linter and the formatter; the formatter owns whitespace.
- **vitest with enforced 100% coverage** — lines, functions, branches, and statements, thresholds set in each package's `vitest.config.ts`. A line we cannot cover is a line we should not have written.
- **Errors carry codes** — every failure is a `LestoError` subclass with a stable, machine-readable `code`; callers branch on `code`, never on a message.

## Quickstart

### Try it in your browser — no install

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/lesto-run/lesto)

Click the badge to open a ready-to-go Codespace — Bun installed, the workspace
already built. Then run a real app: `bun run examples/blog/serve.ts` (it serves on
port 3000, auto-forwarded). The Codespace opens a [short guide](./docs/devrel/try-in-codespaces.md)
with the rest. This is the zero-install on-ramp until `npm create lesto` publishes;
a Codespace (a real Linux container) runs Bun and native SQLite, which browser
playgrounds cannot.

### Locally

The runnable end-to-end example lives in [`examples/blog`](./examples/blog) — a small blog that wires the whole stack together: a `Post` ORM model, a migration that creates the `posts` table, an app-defined `@lesto/ui` registry (`Page` + `PostCard`), a `PostsController` that renders an HTML page via `renderTree` and serves a JSON API, RESTful routes via `resources("posts")`, all booted by `@lesto/kernel` over a SQLite database.

```sh
bun install
bun run examples/blog/run.ts
```

It boots the app, runs migrations, seeds a few posts, and dispatches `GET /posts` (server-rendered HTML) and `GET /api/posts` (JSON), printing the real responses:

```
migrations applied: [ "001_create_posts" ]
posts seeded: 3

GET /posts -> 200 text/html
<main><h1>The Lesto Blog</h1><section><article><h2>Hello, Lesto</h2>...</section></main>

GET /api/posts -> 200 application/json
{"posts":[{"id":1,"title":"Hello, Lesto",...}]}
```

The canonical Lesto driver is **better-sqlite3** (what the kernel's own end-to-end test boots). Because Bun cannot yet load better-sqlite3's native addon, the example's adapter transparently falls back to Bun's built-in `bun:sqlite` when run with `bun run` — both satisfy the same `KernelDatabase` interface, so the app code is identical either way.

### Run the server

The same app can be served over live HTTP via [`@lesto/runtime`](./packages/runtime)'s `serve()`, which stands a real `node:http` server in front of the kernel. [`examples/blog/serve.ts`](./examples/blog/serve.ts) boots the app, seeds it, and listens on port `3000` (override with `PORT`):

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
{"posts":[{"id":1,"title":"Hello, Lesto","body":"A batteries-included, AI-native TypeScript framework.",...}]}
```

## Further reading

- [ARCHITECTURE.md](./ARCHITECTURE.md) — the product vision, the three pillars (Tracks, Loom, Docks), and the dependency-aware build order.
- [CONVENTIONS.md](./CONVENTIONS.md) — the engineering conventions, in full.
- [docs/guide/quickstart.md](./docs/guide/quickstart.md) — scaffold, run, and deploy your first app.

## Contributing & security

- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to set up, run the gate, and open a change that meets the bar.
- [SECURITY.md](./SECURITY.md) — how to report a vulnerability privately (please don't open a public issue).

## License

Lesto is open source under the [MIT License](./LICENSE). Every published `@lesto/*`
package carries the same `"license": "MIT"`; an app you scaffold with
`create-lesto` ships as `UNLICENSED` so you choose its license.
