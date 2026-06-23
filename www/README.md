# `@lesto/www` — the Lesto marketing site (lesto.run)

The public marketing site, built with Lesto. A hand-built landing page plus the
blog, the changelog, and a use-cases showcase — prerendered to static files by
the framework and served from Cloudflare's static-asset edge. There is no
database and no content engine on the edge — just files.

It is the sibling of [`site/`](../site) (the docs site on `docs.lesto.run`): the
same static-Lesto-app shape, a bolder look, and the editorial surfaces (blog,
changelog). Docs keeps the reference docs (Quickstart, Concepts, batteries).

All public copy is held to the binding claims guardrail in
[`docs/brand/messaging.md`](../docs/brand/messaging.md).

## Structure

- `src/ui/landing.tsx` — the hand-built landing page (`/`).
- `src/ui/use-cases.tsx` — the showcase (`/use-cases`), grounded in `examples/`.
- `src/ui/blog.tsx`, `src/ui/changelog.tsx` — the editorial UI over Markdown.
- `content/blog/`, `content/changelog/` — the Markdown (moved here from `site/`).
- `src/ui/styles.ts` — the one inline stylesheet (the bold, on-brand look).

## Develop

```bash
bun install
bun run --filter '@lesto/www' dev   # or, from www/:  lesto dev
```

Add a blog post by dropping a Markdown file under `content/blog/` with
frontmatter:

```md
---
title: My Post
description: One line for the list blurb and meta description.
date: "2026-06-22"
author: The Lesto team
---

# My Post
```

The route is derived from the file path (`my-post.md` → `/blog/my-post`); the
index sorts by `date`, newest first. No route list to maintain.

## Build

```bash
bun run build.ts          # prerender every page to out/www/
```

The build is all-or-nothing: if any page fails to render, nothing is written.

## Deploy to Cloudflare

```bash
bun run build.ts          # prerender to out/www/
npx wrangler deploy       # upload the Worker + static assets
```

`worker.ts` serves a prerendered file when one matches and renders a 404
otherwise; `wrangler.jsonc` binds `out/www/` as the static-asset directory and
the `lesto.run` apex (+ `www.lesto.run`) as the custom domain. No secret, no
database.

## Test

```bash
bun run --filter '@lesto/www' test
```

Covers the rendered routes (landing, use-cases, blog, changelog) and the
Worker's 404 behavior.
