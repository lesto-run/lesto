---
title: Quickstart
description: Scaffold a Lesto app, run it locally, and deploy it to Cloudflare.
section: Getting started
order: 1
---

# Quickstart

From an empty directory to a deployed app.

## Scaffold

```bash
npm create lesto-app@latest my-app
cd my-app
npm install
```

This emits a minimal, runnable app: a typed schema and migration, a code-first
`lesto()` app with one page and one JSON route, and an interactive island —
along with a `worker.ts` and `wrangler.jsonc` for the edge.

## Run it

```bash
npm run dev
```

`lesto dev` boots the kernel, applies migrations, builds the island client, and
serves on `http://localhost:3000`. Edits reload.

## The project

```
my-app/
  lesto.app.ts        # the entrypoint — default-exports your app config
  lesto.sites.ts      # which zones are static vs. dynamic
  src/app.ts          # assemble the lesto() app
  app/routes/         # file-based pages (optional)
  app/islands/        # interactive components (optional)
  worker.ts           # the Cloudflare Worker entry
  wrangler.jsonc      # the Cloudflare config
```

A page is a plain component with an optional server loader:

```ts
app.page("/posts", {
  load: async () => ({ posts: await listPosts(db) }),
  component: PostsPage,
  metadata: () => ({ title: "Posts" }),
});
```

## Build and deploy

```bash
npm run build              # prerender static zones + bundle the island client
npx wrangler deploy        # ship to Cloudflare
```

See **[Deploy to Cloudflare](/deploy/cloudflare)** for the full runbook,
including secrets and the edge database.

## Worked examples

The repository ships runnable example apps:

- **[`examples/blog`](https://github.com/lesto-run/lesto/tree/main/examples/blog)** — a typed schema, a streamed SSR page, and a JSON API.
- **[`examples/queue-dashboard`](https://github.com/lesto-run/lesto/tree/main/examples/queue-dashboard)** — the background-job operator dashboard.
- **[`examples/estate`](https://github.com/lesto-run/lesto/tree/main/examples/estate)** — auth-aware static + dynamic zones on one origin, deployed to Cloudflare.
