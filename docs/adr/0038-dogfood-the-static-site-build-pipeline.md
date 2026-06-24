# ADR 0038 — Dogfood the static-site build pipeline (`lesto build` + a post-build hook, so `www/` and `site/` stop forking the build command)

- **Status:** Accepted (2026-06-23) — implemented and committed. The two Lesto static
  apps (`www/`, the marketing site; `site/`, the docs) no longer run a hand-rolled
  `build.ts`; their `build`/`deploy` scripts run plain `lesto build`, and the
  discoverability files the command itself doesn't emit are produced by a `lesto.build.ts`
  post-build hook over first-class `@lesto/*` packages. Deploys are byte-equivalent to the
  forked scripts (verified file-by-file).
- **Date:** 2026-06-23
- **Deciders:** tech lead + owner
- **Builds on / touches:** ADR 0007 (preact-on-edge — the apps move to a single `preact`
  dialect for BOTH server SSR and the island client; see *The dialect knot*), ADR 0008
  (matched-pair dialect — `lesto build` reads one `ui.dialect`; this ADR keeps that
  invariant rather than re-opening it), ADR 0011 (optimized-by-default pipeline — the
  client build the hook fires after), ADR 0035 (agent legibility — `site/`'s `generate
  agents --check` drift gate stays, now in the `build` script chain), ADR 0037 (the
  Tailwind CSS build — generalized here with a `ui.cssScanRoot` key).

## Context

Both static apps copied a ~100-line `build.ts` that re-called the very primitives
`lesto build` already wires — `buildStaticSites` + `buildClient` + `buildStyles` — then
appended the artifacts the command can't emit. The fork was already drifting: `www/build.ts`
hand-rolled the same `buildStyles` step the CLI had just grown (TW7), both hardcoded
`dialect: "preact"` and the out dir, and the two scripts were a standing dogfood liability
(see the `dogfood-first-docs` steer). The goal: collapse them back onto `lesto build` so a
static marketing/docs app is *thin config*, and every capability it needs is a real Lesto
package a user gets too.

## Decision

**1. Land the emitters as first-class packages (the hook calls them; nothing is bespoke).**

- `@lesto/content-core/build` — the **docs AI surface** (`renderLlmsIndex` / `renderLlmsFull`
  / `renderMarkdownTwin` / `markdownTwinPath`), promoted from an unexported preview module to
  the supported `/build` barrel. Deletes `site/src/ai-docs.ts`.
- `@lesto/sites` `defineStaticSite({ siteUrl, routes, og?, favicon? }).emit(sink)` — the SEO
  emit (sitemap / robots / og / favicon) through the `OutputSink` seam. Kept substrate-light
  (adds only `@lesto/seo`, **never** `@lesto/cloudflare`, whose `@lesto/db`/`@lesto/pg` deps
  would bloat a prerender package).
- `@lesto/cloudflare` `staticAssetsWorker({ notFound })` — the edge front door (serve assets,
  hardened 404). Both `worker.ts` files collapse to one line.

**2. Give `lesto build` a post-build extension seam.** A project's `lesto.build.ts`
default-exports an `onBuilt(context)` hook (discovered + loaded by the bin exactly like
`lesto.sites.ts`; absence tolerated). `runBuild` fires it AFTER prerender + client + styles,
handing each built static site `{ name, routes, sink }` — a sink rooted at that site's
`out/<name>/` output dir. The hook emits SEO, an AI-docs surface, a search index — whatever
the command itself doesn't. The `out/` **clean** is also folded into `runBuild` (the sink
only writes, so a removed route would otherwise orphan a stale file the deploy still ships).

**3. Generalize three `lesto build` behaviours that the fork existed to work around:**

- **Asset placement.** A single static site is served from `out/<name>/` (its wrangler
  `assets.directory`), so its `client.js`/`styles.css` build there — beside the pages — not
  loose in `out/`. Previously `lesto build` wrote them to `outDir`, leaving them orphaned
  from the pages (even `examples/tailwind` was incoherent).
- **CSS scan root.** A new `ui.cssScanRoot` key (default `app/`) points Tailwind at an app
  whose markup lives elsewhere; the two sites set `"src"` (their components live under
  `src/`, not `app/`), so their utility classes are compiled in.
- **The dialect knot.** The apps ran React SSR + a *preact* island client (ADR 0007's
  ~118 KB→~10 KB trick), which `lesto build`'s single `dialectOf(config)` (ADR 0008) cannot
  express without re-opening the hydration-divergence footgun ADR 0008 closed. Rather than
  fork the config, the apps **move to `preact` for both** — verified to render byte-identical
  HTML to React across all 48 pages, so the unification is free.

## Consequences

- `www/`/`site/` are thin config: `lesto.app.ts` + `lesto.sites.ts` + a small `lesto.build.ts`
  hook. The forked `build.ts`, the duplicated worker, and the bespoke `ai-docs.ts` are gone.
- **Deploys are byte-equivalent** to the forked scripts (`diff -rq` clean across the whole
  output tree; the docs `search-index.json` differs only in its always-nondeterministic
  `builtAt`). The CLI's new `runBuild` branches are covered to 100%.
- **Islands builds require Bun.** `lesto build`'s client bundler is `Bun.build`, but the
  `lesto` bin's shebang is `node`, so the natural `bun run build` spawns node and fails on an
  islands app. The two sites' scripts run `bun --bun lesto build` (faithful to their prior
  `bun run build.ts`, which was always Bun). The `create-lesto` scaffold's plain `lesto build`
  has the same latent gap for islands apps — tracked as follow-up, not fixed here.
- Multi-static-site asset placement is left at `outDir` (no single served root); the real
  consumers are single-site, so it's deferred, not designed.
