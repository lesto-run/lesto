# The documentation site (`site/`)

The public docs site, built **with Lesto, on Lesto** — every page is a Markdown
file rendered by `@lesto/content-*` at build time, prerendered to static HTML by
the framework, and served from Cloudflare's static-asset edge. It is both the
deliverable (`L-5d64ad98`, the "public docs site" Adoption-Unblock task) and a
real-world QA gate for the content packages and the static-build path.

Last updated: **2026-06-19**.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Content model | **Static prerender** (build-time) | Docs are read-heavy and change only on deploy. `content-core` + `content-markdown` render Markdown to HTML at build time; pages are `static: true` and prerendered. No content engine, DB, or filesystem on the edge. The D1/content-store runtime path is already dogfooded by `examples/estate`. |
| Location | **Top-level `site/`** | The canonical product docs site, distinct from the toy/demo apps under `examples/`. Added to the root `workspaces` glob. |
| First-pass scope | **Skeleton + runbook** | Intro, quickstart, three battery pages (data/queue/auth), and the Cloudflare deploy runbook. The pipeline + deploy are proven; pages fill in iteratively. |
| Dialect | **React** (default) | Matches `examples/blog`; avoids the Preact alias/shim maintenance. There are zero islands, so there is no client bundle and the dialect only drives the build-time SSR. |

## Architecture

```
BUILD (Node)   content/docs/**/*.md
                 └─ content-core pipeline (frontmatter validate)
                     └─ content-markdown render (HTML + Shiki + heading outline)
                         └─ src/content.ts → DocEntry[] (route, html, headings, nav)
                             └─ src/app.ts registers one static .page() per doc
                                 └─ build.ts → buildStaticSites → out/docs/*.html
DEPLOY (edge)  wrangler deploy → Cloudflare Static Assets
                 └─ worker.ts: withAssets serves a file, a miss → hardened 404
```

- **`lesto.content.ts`** — the `docs` collection: frontmatter schema (title,
  description, section, order) and `render: { syntaxHighlighting: true }`.
- **`src/content.ts`** — runs the pipeline once and reshapes entries into the
  flat `DocEntry` the routes and UI consume; derives the route from each file's
  path segments (`index.md` → `/`, `batteries/data.md` → `/batteries/data`) and
  groups docs into ordered nav sections.
- **`src/app.ts`** — `buildAppConfig()`: registers one `static: true` page per
  doc, each bound to its rendered HTML. An in-memory SQLite handle satisfies the
  kernel's required `db`; no route touches it, and it never reaches the edge.
- **`lesto.sites.ts`** — one static zone at `/` whose `pages` is a *function*
  derived from the collection, so the prerender list needs no hand-maintenance.
- **`worker.ts`** — `withAssets(env.ASSETS, …)` serves prerendered files first;
  a miss falls through to a `toFetchHandler`-wrapped static 404 (no React, no DB).

## Why `wrangler.jsonc` is hand-authored

`@lesto/cloudflare`'s `wranglerConfig` models an app whose dynamic zone fronts
its assets, and refuses a plan with **no** dynamic zone
(`CLOUDFLARE_NO_DYNAMIC_ZONE`). A fully-prerendered docs site has none, so its
`wrangler.jsonc` is written by hand: an `assets` binding over `out/docs`, plus a
thin Worker for the 404. This is the one Cloudflare seam the generator does not
cover; it is documented inline in the file.

## What this dogfoods

`content-core` (collections, frontmatter, pipeline) · `content-markdown`
(Markdown→HTML, Shiki highlighting, heading extraction) · the framework (static
`.page()` routing, layout, metadata, `buildStaticSites`) · `@lesto/cloudflare`
(`withAssets`, `toFetchHandler`).

A dual-React-instance bug surfaced and was avoided: `@lesto/content-components`
carries its own React 18 (a devDependency), which collides with the framework's
React 19 SSR. The site injects the already-sanitized pipeline HTML directly under
the root React instead of through that wrapper.

## Verification

- `bun run --filter '@lesto/site' typecheck` — clean (and the full `ws:typecheck`, 64 pkgs, stays green).
- `bun run --filter '@lesto/site' test` — 15 tests (content, routes, prerender, worker).
- `bun run build.ts` — prerenders 6 pages to `out/docs/`.
- `wrangler deploy --dry-run` — bundles the Worker and validates the `ASSETS` binding.
- CI runs the test + build steps (`.github/workflows/ci.yml`).

## Open / follow-ups

- **Live deploy** — not yet pushed to Cloudflare (an outward-facing, account-touching step); the build + dry-run are proven locally.
- **More content** — the skeleton covers intro/quickstart/three batteries/deploy; remaining batteries, CLI reference, and guides are iterative.
- **Search** — deferred (would be a client island over a `content-search` index; `content-search` is PREVIEW).
- **Copy-button styles** — `content-markdown`'s Shiki pass inlines a `<style>` block per code block (redundant but harmless); upstream cleanup, not a site concern.
