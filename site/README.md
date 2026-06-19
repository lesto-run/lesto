# `@lesto/site` — the Lesto documentation site

The public docs, built with Lesto. Every page under `content/docs/` is a Markdown
file rendered to HTML at build time by `@lesto/content-*`, prerendered to static
files by the framework, and served from Cloudflare's static-asset edge. There is
no database and no content engine on the edge — just files.

See [`docs/plans/docs-site.md`](../docs/plans/docs-site.md) for the design and
rationale.

## Develop

```bash
bun install
bun run --filter '@lesto/site' dev   # or, from site/:  lesto dev
```

Add a page by dropping a Markdown file under `content/docs/` with frontmatter:

```md
---
title: My Page
description: One line for the meta description.
section: Getting started
order: 2
---

# My Page
```

The route is derived from the file path (`batteries/data.md` → `/batteries/data`,
`index.md` → `/`); the sidebar groups pages by `section` and orders them by
`order`. No route list to maintain.

## Build

```bash
bun run build.ts          # prerender every page to out/docs/
```

The build is all-or-nothing: if any page fails to render, nothing is written.

## Deploy to Cloudflare

```bash
bun run build.ts          # prerender to out/docs/
npx wrangler deploy       # upload the Worker + static assets
```

`worker.ts` serves a prerendered file when one matches and renders a 404
otherwise; `wrangler.jsonc` binds `out/docs/` as the static-asset directory. No
secret, no database.

## Test

```bash
bun run --filter '@lesto/site' test
```

Covers the content pipeline, the rendered routes, the static prerender, and the
Worker's assets-first / 404 behavior.
