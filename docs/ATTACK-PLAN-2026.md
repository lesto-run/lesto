# Volo — The 2026 Attack Plan

> Companion to `docs/REVIEW-2026-06-09.md`. Where the review said *what's broken*, this says
> *how we win*. Grounded in a verified mid-2026 read of the tooling, competitor, and
> browser-platform landscape (appendix §8). Tone: ruthless and excited, on purpose.

---

## 0. The one-sentence bet

**Volo is the framework that makes a server-rendered, database-backed site feel like a
hand-tuned SPA, ship its assets to a CDN with zero glue, and be operated by an agent — by
*riding the 2026 platform* instead of re-implementing it in JavaScript.**

We do not out-React the React frameworks. We make their entire client-side value proposition
look like wasted bundle size.

---

## 1. How to attack the industry in 2026

### The market truth (validated, not vibes)

Every incumbent has the **same soft underbelly the moment you leave their managed cloud**:

- **Next.js** — `assetPrefix` only rewrites `_next/static`; your `public/` (favicons, OG images,
  logos) is **un-fingerprinted and served `Cache-Control: max-age=0`**. `next/image` optimizes
  **at runtime, in the SSR/RSC process** — self-hosters report p95 spikes and OOMs as `sharp`
  fights the request path. To self-host you **upload `.next/static` to S3+CloudFront by hand**.
- **SvelteKit** — `paths.assets` is a CDN *URL knob with no uploader*; `enhanced-img` is
  build-time only and punts dynamic images to "a CDN you set up."
- **Astro** — hashes imports beautifully, but SSR images optimize **on-the-fly with sharp at
  request time**, some adapters can't even run it, and S3/CloudFront/R2 deploys are hand-assembled.
  Astro never uploads anything.
- **React Router 7** (merged Remix) — **lost Remix's automatic immutable `_headers`** and
  under-caches `public/`. No image component.
- **TanStack Start** — best-in-class type-safe routing, **no image story, no asset upload, no CDN
  pipeline.**

> The pattern: **every framework gives you a `public/` directory and then abandons it at the
> origin.** Fingerprinting, immutable headers, bucket upload, CDN invalidation, and keeping big
> bytes off the Node tier are all left to you — *unless* you pay Vercel/Netlify/Cloudflare to hide
> it. **That seam is our entry wound.**

### The Cloudflare earthquake (June 4, 2026)

Cloudflare **acquired VoidZero** — Vite, Vitest, Rolldown, OXC, and Vite+. Vite stays MIT and
vendor-neutral, but the company that owns the toolchain is now also selling **agents + edge +
D1/Durable Objects as a database-substrate**. That is *Volo's exact thesis*, funded and
distributed by a hyperscaler.

Two consequences, and we lean into both:

1. **Don't fight the toolchain — stand on it.** Vite 8 (Rolldown, Rust, 10–30× faster builds),
   OXC, oxlint, oxfmt, Vitest *are* the modern stack. We already use oxlint/oxfmt/vitest. We will
   consolidate the rest onto Vite/Rolldown and **sit *on top* of Vite+ (the `vp` CLI), never
   rebuild it.** The bundler/CLI tier is now a commodity Cloudflare maintains for us.
2. **Make Cloudflare our flagship deploy target, not just our rival.** R2 for assets, Workers for
   the edge tier, 103 Early Hints, Hyperdrive→Postgres. We ride the incumbent's rails and
   differentiate one layer up — **batteries + agent-native + one-DB coherence** — which Cloudflare
   sells as a bag of disconnected primitives, not a framework.

### Where we win, where we must not fight

| Fight | Verdict |
|---|---|
| Type-safe client routing / data loaders (TanStack's turf) | **Don't.** Bet the platform router instead (Bet I). |
| The bundler / unified CLI (Vite+ / Rolldown) | **Don't.** Stand on it. |
| Managed-cloud asset magic (Vercel) | **Win** by shipping it off-the-shelf for *any* bucket+CDN (Bet II). |
| Batteries on one DB substrate (ORM/queue/auth/email/CMS) | **Win.** Nobody else ships this coherent set. |
| Agent-operated site (MCP control plane) | **Win.** Genuinely novel; make it demoable (Bet IV). |

---

## 2. The four bets

### Bet I — The platform is the router (zero client JS, SPA feel)

The review's #1 competitive wound was *"no client-side navigation."* **We turn that into the
flex.** The 2026 platform hands MPAs SPA-class UX for free:

- **Cross-document View Transitions** (`@view-transition { navigation: auto }`) — animated
  page-to-page transitions, **no client router**. Chrome/Edge 126+, Safari 18.2+ (~82% and
  climbing; Firefox partial). Degrades to a normal nav everywhere else.
- **Speculation Rules** (`<script type="speculationrules">`, prerender-on-hover) — **instant**
  navigations on Chromium (~76% of traffic). Case studies: Ray-Ban **+101% mobile / +156% desktop
  PDP conversion** from prerender alone. Pure accelerator; costs nothing where unsupported.
- **bfcache + Early Hints (103)** — instant back/forward on *all* engines; turn server
  think-time (the DB query) into preloading on edges that support it.

**What we ship:** a `@volo/platform` layer that, by default, emits `@view-transition`, injects a
*safe* speculation-rules block (eagerness `moderate`, same-origin only, **auto-excludes
logout/mutation links, respects `Save-Data`**), auto-injects `<link rel="expect"
blocking="render">` on declared transition roots so we beat Chrome's ~4s transition timeout, keeps
pages bfcache-eligible, and gates analytics/side-effects behind `document.prerendering`.
`view-transition-name` becomes a **first-class authoring primitive** reused across both
same-document island swaps (cross-engine) and cross-document navigations.

> Result: a plain Volo page navigates **faster *and* smoother than most React SPAs**, with no
> router bundle, no hydration, no client data layer. This is the leapfrog — and the honest
> progressive-enhancement story (works with JS off) is itself a differentiator.

### Bet II — Assets are a substrate concern, not your problem

This is the direct answer to *"you literally can't serve an image"* and *"an off-the-shelf
S3-during-CD solution would be nice."* The deploy `uploader` seam and the async `Storage`
interface already exist — we fill them into a real pipeline. **New package: `@volo/assets`.**

**The DX (first-class, beats `public/`):**
- A `public/` (static, copied) **and** import-graph assets (`import hero from "./hero.jpg"`) via
  Rolldown — **both content-fingerprinted uniformly** (Next orphans `public/`; we don't).
- An `<Image>`/`<Asset>` component that defaults to the *entire safe perf stack*: `srcset`/`sizes`,
  intrinsic `width`/`height` (CLS), `loading=lazy` + `decoding=async`, with the **LCP image
  auto-opted-out of lazy and given `fetchpriority=high`**. All Baseline 2024 — zero config.

**The production model (app server never touches bytes):**
- **Build-time** AVIF/WebP/responsive variants for *known* assets — off the request path entirely
  (vs Next/Astro/Nuxt doing `sharp` *in the SSR process*).
- **Dynamic/user-uploaded** images → a **decoupled edge/worker optimizer**, never in-process.
- An **asset manifest** (logical path → fingerprinted URL) and a configurable **CDN origin**; the
  renderer rewrites every asset URL to the CDN at build/serve.
- `@volo/storage` gains an **S3/R2 backend** and a **`url()`** (public + presigned) method — the
  two gaps the review found.
- `volo deploy` **uploads automatically**: incremental, changed-files-only, to any S3-compatible
  target (S3 / R2 / Spaces / Backblaze / MinIO), sets `immutable, max-age=31536000` at upload, and
  invalidates the CDN for the mutable HTML. **You write zero upload scripts.**

> The pitch: **"Vercel's asset experience — fingerprinting, immutable headers, CDN, image
> optimization off the request path — on your own bucket and CDN, with no CD glue and no vendor
> lock-in."** No incumbent ships this self-hosted.

### Bet III — One Rust toolchain underneath

Today we **shell out to `bun build client.tsx`** for the app/island bundle and only use Vite for
content. That's two pipelines, no HMR, no dev/prod parity. We consolidate:

- **Replace `bun build` with Vite 8 / Rolldown** (Rust, Rollup-compatible — our `content-vite`
  plugin runs *unchanged*; HMR; one pipeline; 10–30× faster).
- **Model server / client / edge as Vite Environments + `ModuleRunner`** for true dev/prod parity,
  retiring the bespoke dev dispatcher. *(Environment API is RC at Vite 8.0.16 — budget for some
  churn; TanStack Start and Astro 6 already ship on it.)*
- Optionally adopt **`@vitejs/plugin-rsc`** for streaming server-component islands later.
- **Stand on Vite+ (`vp`)**, don't rebuild dev/build/test/lint — we're already on the VoidZero
  stack (oxlint/oxfmt/vitest).
- Embed **OXC's Rust parser/transformer** for *deterministic agent code-transforms* (Bet IV)
  instead of Bun's.

### Bet IV — The agent-native control plane (the moat)

The differentiator nobody else has — but today it's unwired (no `volo mcp` command, three
divergent MCP impls, `generate_ui` inert). We make it a five-minute demo:

- A real **`volo mcp`** binary/command; **collapse the three MCP implementations into one**
  (delete ~1,700 lines of fold-in debt).
- **Wire `generate_ui` end-to-end** in an example — the registry→JSON-Schema→forced-tool→
  `validateTree`→graceful-render loop is our best original idea; *exercise it*.
- Expand the operations surface to match principle #5: **migrations, jobs, schema, deploy,
  assets** as MCP operations, not just content + routes.

> Target demo: *from Claude Desktop, add a content type, generate a validated UI block for it,
> migrate the DB, and deploy assets to R2 — on a running site, live.* That's the 2026 mom test.

---

## 3. Architecture — new & changed surfaces

| Package | Change |
|---|---|
| **`@volo/assets`** (new) | `public/` + import-graph fingerprinting, manifest, `<Image>`/`<Asset>`, build-time variant generation, CDN-URL rewriting. |
| **`@volo/platform`** (new, or fold into runtime/loom) | `@view-transition` + speculation-rules emission, `view-transition-name` authoring, `rel=expect` injection, bfcache/prerender-safety helpers, default Service Worker recipe (precache assets + Navigation Preload for dynamic HTML + `Vary` correctness). |
| **`@volo/storage`** | Add **S3/R2 backend** + **`url()`** (public/presigned). |
| **`@volo/deploy`** | Fill the `uploader` seam: incremental S3-compatible uploader, immutable headers, CDN invalidation; a **first-class Cloudflare adapter** (R2 + Workers + 103 Early Hints) as flagship; align targets with Vite Environments. |
| **`@volo/web` / `@volo/runtime`** | **Binary/stream response bodies** (kill string-only `body`); full MIME table in `contentTypeOf`; emit `Cache-Control`/`immutable`; `fetchpriority`/`modulepreload` hints; Early Hints hook. |
| **build tier** | Vite 8/Rolldown replaces `bun build`; Environments + ModuleRunner; content plugin unchanged. |
| **`@volo/mcp` + content MCP** | One implementation; `volo mcp` bin; `generate_ui` wired; ops surface expanded. |
| **DB seam** (orm/queue) | **Make `SqlDatabase`/`SqlStatement` async** (the still-pending blocker — every edge/Cloudflare/Postgres path is async; do it while the surface is small). |

---

## 4. Build sequence (phased, with exit criteria)

Merges the review's 10/10 hardening roadmap with the four bets. Each phase ships something demoable.

**Phase 0 — Stop the bleeding (≈1 wk, non-negotiable).** Fix the confirmed Highs: request error
boundary + process-level rejection handler + body cap (the malformed-JSON crash); quote/whitelist
ORM identifiers (SQLi); `verifyPassword` full-length-hash; CORS `*`+credentials reject; workflow
void-step persistence. **Stand up CI** (typecheck + lint + test + `format:check`). *Exit: zero
confirmed High findings; CI green; no input crashes the process.*

**Phase 1 — Binary spine + async DB (≈3–4 wks).** Binary/stream response bodies, full MIME table,
`Cache-Control` emission. **Async DB seam** + a real Postgres adapter + transactional migrations.
*Exit: the framework serves an image with correct type + immutable header; the same app boots on
SQLite local and Postgres prod unchanged.*

**Phase 2 — The asset pipeline, Bet II (≈3–4 wks).** `@volo/assets`: `public/` + import
fingerprinting, manifest, `<Image>` with the full perf stack, build-time variants. `@volo/storage`
S3/R2 backend + `url()`. `@volo/deploy` auto-uploader + immutable headers + invalidation. *Exit:
`volo deploy` fingerprints every asset, uploads changed-only to R2/S3, serves via CDN, and the Node
tier never streams an asset byte — with zero user-written upload script.*

**Phase 3 — The platform router, Bet I (≈2–3 wks).** `@volo/platform`: view transitions +
speculation rules + `rel=expect` + bfcache/prerender-safety + default SW recipe + `view-transition-name`
authoring. *Exit: a stock Volo app gets animated transitions (Chromium+Safari) and prerendered
instant nav (Chromium), degrades cleanly on Firefox, ships **0 bytes** of router JS.*

**Phase 4 — Toolchain consolidation, Bet III (≈3–4 wks).** Vite 8/Rolldown replaces `bun build`;
Environments + ModuleRunner; flagship Cloudflare adapter. *Exit: one build pipeline with HMR;
`volo deploy --target cloudflare` puts assets on R2 + app on Workers + Early Hints.*

**Phase 5 — Agent control plane, Bet IV (≈2–3 wks).** `volo mcp`; one MCP impl; `generate_ui`
wired; ops surface expanded. *Exit: the five-minute Claude-Desktop demo runs end-to-end.*

**Phase 6 — Wire the batteries + trust (ongoing).** Middleware pipeline so csrf/cors/ratelimit/
rbac/auth/observability are *in the request path*; kernel fires hooks; DB-backed sessions +
OAuth; one trace UI→API→DB. Publish packages (fix the `workspace:*` scaffold), docs site, a
dogfooded flagship app in prod, external security audit. *Exit: a generated app has working auth +
a plugin firing a hook + one stitched trace, no hand-wiring; packages installable by strangers.*

---

## 5. What we delete (ruthless = subtraction)

The line count overstates what's built; cutting raises every score at once.

- **The legacy CommonJS root** (`lib/`, `bin/tracks.js`, `test/`, root pkg `"tracks"`) — duplicates
  ported packages; root `npm test` runs the legacy suite. Delete or quarantine.
- **MCP triplication** (~1,700 lines across `@volo/mcp`, `content-core/mcp*.ts`, `content-mcp`) —
  one impl.
- **`bun build` client pipeline** — replaced by Rolldown.
- **Dead code**: the 14-event build taxonomy (`events.ts`), the unreachable workflow auto-filter
  path, duplicated content-search/embeddings primitives (`@volo/content-shared` already exports
  them). Merge or cut the ~27 zero-consumer packages.
- **Any temptation to write a client-side router or a JS popover/tooltip/floating-ui layer** —
  the platform (Popover API + Anchor Positioning + container queries + `:has()`) does it for free.

---

## 6. The demo that wins (2026 mom test)

1. `bunx create-volo shop && cd shop && volo dev` — boots in <2s (Rolldown HMR).
2. Drop a 4MB photo in `public/`, reference `<Image src="/hero.jpg">`. Dev serves it; build emits
   AVIF/WebP/srcset, `fetchpriority=high` on the LCP image.
3. Click between pages — **instant, animated** (prerender + view transition), **DevTools Network
   shows zero router JS**.
4. From **Claude Desktop**: "add a `Product` type, generate a product-card UI, migrate, and deploy
   to R2." It happens on the running site.
5. `volo deploy --target cloudflare` — assets fingerprinted to R2 behind the CDN, app on Workers,
   **you never wrote an upload script.**

If steps 3 and 4 land, the eyes widen. That's the whole game.

---

## 7. Risks & honest open calls

- **Progressive enhancement is a promise, not a hope.** Speculation Rules is Chromium-only
  (~76%); cross-doc transitions miss Firefox. Everything must be *fully functional* as a plain
  MPA — the accelerators are pure upside. This is a design constraint, not a footnote.
- **Environment API is RC.** Real churn risk; pin versions, keep the bespoke path behind a flag
  until it's stable.
- **The async-DB rewrite is the pivotal, irreversible call.** It's an API break — cheapest now (1
  day old, 487 files). Deferring it keeps "Postgres scale" and every edge path fictional.
- **Cloudflare owns the toolchain *and* competes with the thesis.** Mitigation: stay portable
  (Vite is MIT/neutral; design adapters for any Environment-API runtime), differentiate on
  batteries + agent + one-DB coherence, treat CF as the best *first* target, not the only one.
- **Open call:** build-vs-adopt on RSC (`@vitejs/plugin-rsc`) and on the edge image optimizer
  (own it vs proxy to an image CDN). Decide at the slice; both stay on the substrate.

---

## 8. Verified facts appendix (mid-2026, corrections applied)

**Tooling.** VoidZero → **Cloudflare, June 4 2026** (Vite/Vitest/Rolldown/OXC/Vite+; Vite stays
MIT). **Vite 8, Mar 12 2026** — Rolldown is the single default bundler (Rust, 10–30× faster;
Linear 46s→6s); **Rolldown 1.0 stable May 2026**, Rollup-plugin-compatible. **Environment API =
RC** at Vite 8.0.16 (custom client/ssr/edge/RSC envs + `ModuleRunner` dev/prod parity; adopted by
TanStack Start, Astro 6; RR7/Nuxt opt-in). **`@vitejs/plugin-rsc`** = official RSC primitive.
**Vite+** open-sourced **MIT alpha, Mar 13 2026** (`vp` binary; dev/build/test/lint + task runner;
bundles Vite 8 / Vitest 4.1 / Oxlint 1.52 / Oxfmt beta). *Correction: it was **oxlint** that hit
1.0 (Jun 2025), not "OXC 1.0"; oxfmt is beta (v0.54, Feb 2026).*

**Asset/CDN DX.** Next `assetPrefix` rewrites only `_next/static`; `public/` un-fingerprinted,
`max-age=0`; `next/image` optimizes at **runtime in the SSR process** (p95 spikes/OOM
self-hosted); manual `.next/static`→S3+CloudFront. SvelteKit `paths.assets` = URL knob, **no
uploader**; `enhanced-img` build-time only. Astro hashes imports but **SSR images optimize
on-the-fly (sharp at request)**; never uploads. RR7 **lost Remix's immutable `_headers`**,
under-caches `public/`, no image component. TanStack Start: no image component, no CDN upload.
Nuxt `@nuxt/image` defaults to a **runtime IPX optimizer** (20+ CDN providers). Vercel/Netlify/CF
hide the whole pipeline; self-hosting drops upload + headers + invalidation + bytes-through-Node.

**Web platform.** Cross-doc View Transitions: Chrome/Edge 126+, Safari 18.2+ (~82%; Firefox
partial). Same-doc VT: cross-engine (Chrome 111+/Safari 18+/Firefox 144+, ~88%). Speculation
Rules: **Chromium-only ~76%** (Safari flag, Firefox none); Chrome 144 pauses JS at first blocking
script until activation. Container size queries: **Baseline Widely available ~92%**. `:has()`:
Baseline 2023 ~92%. CSS Nesting: Baseline (widely available by mid-2026; full support Chrome
120/Firefox 117/Safari 17.2). Style queries (custom props only): now Chrome/Edge 111+/Safari
18+/**Firefox 151+**. Popover API: Baseline 2024. CSS Anchor Positioning: cross-engine early 2026
(~81%, fallbacks advised). Scroll-driven animations: **not Baseline** (Firefox flag). fetchpriority:
Baseline 2024. SW Navigation Preload: all three engines (consume `preloadResponse`, send `Vary:
Service-Worker-Navigation-Preload`). 103 Early Hints: Chrome/Edge/Firefox (Safari preconnect-only),
needs h2/h3. srcset/sizes, `loading=lazy`, `decoding=async`, preload/modulepreload, bfcache:
universal.
