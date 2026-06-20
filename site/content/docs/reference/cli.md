---
title: CLI
description: The lesto command-line interface — scaffold, develop, build, deploy, migrate, and inspect your app.
section: Reference
order: 0
---

# CLI

The `lesto` command drives an app through its whole lifecycle — develop, build, deploy, migrate, scaffold, and inspect. The published binary is a thin shim that registers a TypeScript loader (jiti) and runs Lesto's real `.ts` entry under plain `node`, so the framework ships TypeScript and `lesto` runs without a separate build step. Every command resolves the project from the current directory: it imports your `lesto.app.ts` (the app config) and, where relevant, your `lesto.sites.ts` (the declared sites). Invocation is `lesto <command> [options]`, with order-independent flags; run `lesto help` (or `lesto` with no command) for the current usage.

## Develop

| Command | What it does |
|---|---|
| `lesto dev` | Run every site live on one origin, dispatching each path through the app and rebuilding islands on change. Accepts `--port <n>`. |
| `lesto serve` | Boot the app over HTTP as a single production server. Accepts `--port <n>` (default `3000`). |
| `lesto routes` | List every route the app declares, one per line as `method` tab `pattern`. |

`dev` is the local loop: it renders *every* zone live through the app's own handle, so a static zone needs no prebuild and an edit shows on the next refresh. If the project has an `app/islands/` directory it builds the client bundle on boot and watches it for changes, and a freshly scaffolded app with no `lesto.sites.ts` still boots.

```bash
lesto dev --port 4000
# dev server on http://127.0.0.1:4000
```

`serve` is the production single-process server, with `/readyz` wired to a real database ping so an orchestrator only routes traffic to a node whose database answers.

## Build & deploy

| Command | Flags | What it does |
|---|---|---|
| `lesto build` | `--target <name>`, `--out <dir>` | Prerender static sites to disk (default `out`). `--target` builds one declared site; omitted builds all. |
| `lesto deploy --cloudflare` | `--health-url <url>` | Push the Worker + its bound Static Assets via `wrangler`, then health-gate the result. |
| `lesto deploy --release` | `--version <v>`, `--dist <dir>`, `--target`, `--out` | Ship a versioned, atomically-flipped release to local disk. `--version` names it; absent, a timestamp is used. |
| `lesto deploy` (remote) | `--bucket <name>`, `--endpoint <url>`, `--region <r>`, `--pointer <key>` | Publish a versioned release to an S3/R2 store. Naming `--bucket`/`--endpoint` implies `--release`; both are required together. |
| `lesto rollback --to <version>` | `--dist <dir>` or `--bucket`/`--endpoint` | Flip the live pointer back to a published release. |

`build` and the static deploy paths both prerender with a build that fails on any page that does not render before a file is written, and both run the island client build first when `app/islands/` is present, so `/client.js` lands beside the HTML.

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

`g` is the alias for `generate`. A model's trailing `field:type` tokens accept the aliases `string`/`text`, `int`/`integer`, `float`/`real`, `bool`/`boolean`, and `datetime`/`timestamp`; field names may be camelCase, snake_case, or kebab-case. Pass `--dry-run` on any generator to print the plan and write nothing. Generators are idempotent — an existing file is left untouched, never clobbered, so a generator is safe to re-run.

```bash
lesto g model Post title:string published:boolean publishedAt:timestamp
# wrote app/models/post.ts
# wrote app/models/post.test.ts
```

## Content

| Command | What it does |
|---|---|
| `lesto content:build [--prune]` | Boot the app (applying its migrations) and compile Markdown content into the content store. `--prune` drops store rows for source that no longer exists. |
| `lesto content:new <collection> <title>` | Scaffold a new content entry into a collection. |
| `lesto content:delete <collection> <slug>` | Delete a content entry from the store. |

The `content:*` commands depend on the optional `@lesto/content-core` and `@lesto/content-store` packages, which a default scaffold does not install. They are imported on call, so a missing peer surfaces as a friendly hint to install them rather than a raw module error.

## Notes

The published `lesto` shim runs Lesto's TypeScript entry through jiti under plain `node`, so every command runs under node with no separate build step. The one exception is island bundling: when a command with islands (`dev`, `build`, and the static `deploy` paths) builds the client bundle, it calls Bun's bundler — so a project that uses `app/islands/` needs Bun available for those commands. An island-less app is unaffected. The long-running `serve` and `dev` commands stay alive on their own socket and drain in-flight requests on `SIGTERM`/`SIGINT`; every other command exits when done.
