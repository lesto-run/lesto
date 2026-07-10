---
title: CLI
description: The lesto command-line interface — scaffold, develop, build, deploy, migrate, and inspect your app.
section: Reference
order: 0
---

# CLI

The `lesto` command drives an app through its whole lifecycle — develop, build, deploy, migrate, scaffold, and inspect. The published binary is a thin shim that registers a TypeScript loader (jiti) and runs under plain `node`, so your project's TypeScript — `lesto.app.ts`, `env.ts`, routes — runs with no separate build step. Every command resolves the project from the current directory: commands that need the app import your `lesto.app.ts` (the app config) and, where relevant, your `lesto.sites.ts` (the declared sites); the scaffolders write into the project without booting it. Invocation is `lesto <command> [options]`, with order-independent flags; run `lesto help` (or `lesto` with no command) for the current usage.

## Develop

| Command | What it does |
|---|---|
| `lesto dev` | Run every site live on one origin, dispatching each path through the app. Accepts `--port <n>`. |
| `lesto serve` | Boot the app over HTTP as a single production server. Accepts `--port <n>` (default `3000`). |
| `lesto routes` | List every route the app declares, one per line as `method` tab `pattern`. |
| `lesto routes:gen` | Regenerate the edge route manifest (`routes.gen.ts`) from `app/routes/` — the static-import map a Worker bundles. A project with no `app/routes/` is a no-op, said out loud. |

`dev` is the local loop: it renders *every* zone live through the app's own handle, so a static zone needs no prebuild and an edit shows on the next refresh. With `@lesto/island-dev` installed (the scaffold default), a Vite dev server owns the islands — a saved island Fast-Refreshes in place, keeping its state. Without it, `dev` falls back to a bundle-and-reload watch over `app/islands/`. A freshly scaffolded app with no `lesto.sites.ts` still boots.

```bash
lesto dev --port 4000
# dev server on http://127.0.0.1:4000
```

`serve` is the production single-process server, with `/readyz` wired to a real database ping so an orchestrator only routes traffic to a node whose database answers. See [Deploy to Node](/deploy/node).

## Build & deploy

| Command | Flags | What it does |
|---|---|---|
| `lesto build` | `--target <name>`, `--out <dir>` | Prerender static sites to disk (default `out`). `--target` builds one declared site; omitted builds all. |
| `lesto deploy --cloudflare` | `--health-url <url>` | Push the Worker + its bound Static Assets via `wrangler`, then health-gate the result. |
| `lesto deploy --release` | `--version <v>`, `--dist <dir>`, `--target`, `--out` | Ship a versioned, atomically-flipped release to local disk. `--version` names it; absent, a timestamp is used. |
| `lesto deploy` (remote) | `--bucket <name>`, `--endpoint <url>`, `--region <r>`, `--pointer <key>` | Publish a versioned release to an S3/R2 store. Naming `--bucket`/`--endpoint` implies `--release`; both are required together. |
| `lesto rollback --to <version>` | `--dist <dir>` or `--bucket`/`--endpoint` | Flip the live pointer back to a published release. |

`build` prerenders with a build that fails on any page that does not render before a file is written. When `app/islands/` is present it bundles the client first (Vite/Rolldown, under plain node), so `/client.js` lands beside the HTML; the static deploy paths do the same.

```bash
lesto deploy --cloudflare --health-url https://example.com/readyz
```

The Cloudflare path is the one-command edge deploy: `wrangler deploy` ships the Worker and its assets in one atomic, Cloudflare-versioned step, so there is no Lesto-owned pointer to flip. What Lesto adds is the gate — after the push it probes the health URL (`--health-url` if given, else the deploy URL with `/readyz` appended) and, if the probe fails, it automatically rolls the Worker back to its previous deployment rather than leave a broken release live. If no URL is available, the deploy still lands but the gate is skipped, and the CLI says so out loud. See [Deploy to Cloudflare](/deploy/cloudflare).

For self-hosting, the versioned `--release` path writes each release into an immutable `releases/<version>/` tree and flips the `current` pointer atomically, so traffic never sees a partial deploy and `lesto rollback --to <version>` can flip back in one step. A remote release publishes the same machinery into an S3-compatible bucket (R2, S3, MinIO); `--region` defaults to `auto` and `--pointer` lets one bucket host several sites. Object-store credentials come from the environment, never flags. See [Deploy to Node](/deploy/node).

## Data & scaffolding

| Command | What it does |
|---|---|
| `lesto migrate` | Boot the app (which runs pending migrations) and print each applied version. |
| `lesto g model <Name> [field:type …]` | Scaffold a model: a `@lesto/db` table, its row type, a create-migration, and a passing test under `app/models/`. |
| `lesto g migration <Name>` | Scaffold a timestamped standalone migration (plus test) under `app/migrations/`. |
| `lesto g island <Name>` | Scaffold a `defineIsland` component (plus test) under `app/islands/`. |
| `lesto g page <route>` | Scaffold a file-routed `page.tsx` (plus test) under `app/routes/<route>/` — e.g. `lesto g page blog/[slug]`. |
| `lesto g agents` | Scan the app's conventions into `AGENTS.md` (a managed region — your prose outside it survives) and `llms.txt`. `--check` writes nothing and exits non-zero on drift, for CI. |
| `lesto add mcp-auth` | Wire an authenticated MCP Resource Server into the app: `app/mcp/config.ts` (the holes you fill), `verify.ts` (the issuer adapter), and `governance.ts` (the battery wiring). See [Build an authenticated MCP server](/guides/authenticated-mcp). |

`g` is the alias for `generate`. A model's trailing `field:type` tokens accept the aliases `string`/`text`, `int`/`integer`, `float`/`real`, `bool`/`boolean`, and `datetime`/`timestamp`; field names may be camelCase, snake_case, or kebab-case. Pass `--dry-run` on any generator (and on `add`) to print the plan and write nothing. Generators are idempotent — an existing file is left untouched, never clobbered, so a generator is safe to re-run.

```bash
lesto g model Post title:string published:boolean publishedAt:timestamp
# wrote app/models/post.ts
# wrote app/models/post.test.ts
```

## Agents & the API surface

| Command | What it does |
|---|---|
| `lesto mcp` | Serve the MCP control plane over stdio, for a local agent. Read-only by default; `--operator` unlocks the destructive tools (content writes, `handle_request`). Every dispatch — success or refusal — lands one audit line on stderr (stdout belongs to the protocol). |
| `lesto openapi` | Export the app's routes as an OpenAPI 3.1 document — `--out <path>` (default `openapi.json`), with `--exclude <prefix>` (repeatable) to drop internal routes such as health probes. Request/response schemas are not yet emitted (Zod extraction is post-1.0); the command says so on the way out. |
| `lesto eval` | **Preview.** Run the app's declared evals (`lesto.evals.ts`) as a gate: a pass/fail line per eval, non-zero exit on any failure. An app with no evals file exits `0` silently, so adding it to CI can never break an eval-less build. LLM-judged evals use `ANTHROPIC_API_KEY`. |

Point a desktop MCP client at the stdio server with an `mcpServers` entry:

```json
{ "mcpServers": { "lesto": { "command": "lesto", "args": ["mcp"] } } }
```

For agents on the other side of the internet, serve MCP over HTTP behind OAuth instead — see [Build an authenticated MCP server](/guides/authenticated-mcp).

## Content

| Command | What it does |
|---|---|
| `lesto content:build [--prune]` | Boot the app (applying its migrations) and compile Markdown content into the content store. `--prune` drops store rows for source that no longer exists. |
| `lesto content:new <collection> <title>` | Scaffold a new content entry into a collection. |
| `lesto content:delete <collection> <slug>` | Delete a content entry from the store. |

The `content:*` commands depend on the optional `@lesto/content-core` and `@lesto/content-store` packages, which a default scaffold does not install. They are imported on call, so a missing peer surfaces as a friendly hint to install them rather than a raw module error.

## Notes

Every command runs under plain `node` — the shim's jiti loader handles your project's TypeScript, and island bundling for `build` and the static `deploy` paths runs Vite/Rolldown, which needs no Bun. The one place Bun is required: `lesto dev`'s fallback island build, used only when the optional `@lesto/island-dev` package is not installed or cannot start (the scaffold installs it by default). The long-running `serve` and `dev` commands stay alive on their own socket and drain in-flight requests on `SIGTERM`/`SIGINT`; every other command exits when done.
