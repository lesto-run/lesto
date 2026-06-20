---
title: CLI
description: The lesto command-line interface — scaffold, develop, build, deploy, migrate, and inspect your app.
section: Reference
order: 0
---

# CLI

The `lesto` command drives an app through its whole lifecycle.

## Develop

| Command | What it does |
|---|---|
| `lesto dev` | Run every site live on one origin, rebuilding islands on change. |
| `lesto serve --port <n>` | Boot the app over HTTP (default port 3000). |
| `lesto routes` | List every route the app declares (method + pattern). |

## Build & deploy

| Command | What it does |
|---|---|
| `lesto build --out <dir>` | Prerender static sites to disk (default `out`). |
| `lesto deploy --cloudflare` | Build and ship to Cloudflare (Worker + static assets), health-gated. |
| `lesto deploy --release` | Ship a versioned, atomically-flipped release (optionally to S3/R2). |
| `lesto rollback --to <version>` | Flip the live pointer back to a published release. |

## Data & scaffolding

| Command | What it does |
|---|---|
| `lesto migrate` | Run pending migrations and print the applied versions. |
| `lesto g model <Name> [field:type …]` | Scaffold a model (use `--dry-run` to preview). |
| `lesto g migration <Name>` · `lesto g island <Name>` | Scaffold a migration or island. |

## Content

| Command | What it does |
|---|---|
| `lesto content:build [--prune]` | Compile Markdown content into the content store. |
| `lesto content:new <collection> <title>` | Scaffold a new content entry. |
| `lesto content:delete <collection> <slug>` | Delete a content entry. |

Run `lesto help` for the full, current usage.
