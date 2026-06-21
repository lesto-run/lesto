# Frontend DX parity — closing the gap to Next.js / Astro / TanStack

**Origin:** the 2026-06-20 adversarial DX review (32 findings, 25 confirmed / 6 partially / 1 refuted), which compared Lesto's React page/component authoring, data fetching, type safety, routing, and onboarding against current Next.js, Astro, and TanStack (Router/Start/Query). Every claim below is grounded in real `file:line` and verified against current competitor docs.

The headline: Lesto's **server** authoring (file routes, typed params, typed mutations, render-time data resolution, batteries) is competitive — in places ahead. The gap is the thin **client / navigation / dev-loop** layer, and it clusters into a handful of root causes. None are architecturally hard; most are "the seam already exists, it just isn't wired to the type system or the dev server."

## The bar (non-negotiable, every commit)

- TypeScript, ESM, Bun. `oxlint` and `oxfmt` clean.
- **100% vitest coverage per touched package** — statements, branches, functions, lines. New branches ship with the tests that exercise them.
- Every refusal is a **coded error** (stable code in the package's error-code union); callers branch on codes, never message strings.
- Before each commit: `bun run ws:typecheck` AND the **serial coverage gate** — `bun scripts/coverage-gate.ts` — both green. Do not parallelize the gate.
- Doc comments must still tell the truth after the change.
- Commit on `main`, conventional messages, with the repo's Claude co-author trailer.
- **No over-promising.** A type that claims to catch dead links must actually catch them, or the doc must say exactly what it does and does not catch. Generated types must keep `routes.gen.ts` byte-stable (the freshness guard re-scans and diffs).

---

## Workstream 1 — Typed `<Link href>` (typed routes) · **highest ROI, in progress**

**Why (verified):** `LinkProps.href` is `string` (`packages/ui/src/link.tsx:29`), so a typo'd or renamed destination is a runtime 404, never a `tsc` error. This was independently flagged by **4 of 5** reviewers — the single loudest signal. The data already exists: `generateRouteManifest` (`packages/web/src/file-routes.ts:202`) knows every route pattern at codegen time but emits only runtime values (`files[]` + `modules` Map), no type. Next's `typedRoutes` (stable) and TanStack Router both type this. A reviewer confirmed: no `RoutePath`/route-union anywhere in `packages/`.

### Increment 1 — generated `RoutePath` union + autocomplete `href` (this session)

The foundation + autocomplete, **fully back-compatible** (the estate app mixes file-routes and code-first `.page()` routes, so a *strict* `href` would false-positive on legitimate code-first links — see Increment 2).

- **`packages/web/src/file-routes.ts`** — `generateRouteManifest` also emits, from the compiled page patterns:
  - `export type RoutePath = "/" | "/lab/gallery" | ` + "`/lab/gallery/${string}`" + `;` — each `:param` segment compiled to a `${string}` template-literal slot, static routes as string literals. Zero pages → `never`.
  - a `declare module "@lesto/ui" { interface RegisteredRoutes { href: RoutePath } }` augmentation, so the app's generated module wires its routes into the shared `<Link>` type by declaration merging (the TanStack `Register` idiom). Deterministic, code-point-sorted, byte-stable.
- **`packages/ui/src/link.tsx`** (+ `index.ts` re-exports) — add the augmentable seam:
  - `export interface RegisteredRoutes {}` (empty; apps augment it).
  - `export type RouteHref` = `string` when `RegisteredRoutes` carries no `href` (no codegen → unchanged), else `KnownRoutes | (string & {})` — autocomplete of every real route **plus** a non-breaking escape for external URLs, query/hash, and code-first routes.
  - `LinkProps.href: RouteHref`. `Link` runtime is byte-for-byte unchanged.
- **`examples/estate/src/routes.gen.ts`** — regenerate via `bun examples/estate/src/regenerate-routes.ts` so the committed manifest carries the new type + augmentation (the freshness test asserts byte-identity).
- **Tests:** `packages/web/test/file-routes.test.tsx` — `generateRouteManifest` emits the `RoutePath` union + augmentation for static, dynamic, and empty route sets (covers the new branch). A `type-tests/routes.types.ts` asserting: unaugmented `RouteHref` is `string`; an augmented `RegisteredRoutes` makes known routes assignable and surfaces them, while an arbitrary string still assigns (escape preserved).

**Increment 1 explicitly delivers** editor autocomplete of every real route + a single generated source of truth for route paths. It does **not yet** error on an unknown literal — that's Increment 2.

### Increment 2 — actual compile-time checking (follow-up)

Increment 1 deliberately delivers only autocomplete (a typo still compiles, and the dynamic member `` `/…/${string}` `` is looser than the router's single-segment `[^/]+`). The *value* — catching a typo'd/mis-parametered link at `tsc` time — is here.

- **Registry-placement decision — DECIDED (2026-06-20): keep the registry in `@lesto/ui`, build `route()` there using `@lesto/router`'s `PathParams`.** The fork was: keep `RegisteredRoutes` in `@lesto/ui` (where `<Link>` already reads it) vs. lower it into `@lesto/router` so `<Link>` and `route()` share one source of truth. Chosen the former because it's the **low-regret, no-refactor** option: Increment 1's `RegisteredRoutes`/`RouteHref` stay put; we only *extend* the codegen augmentation with a `pattern` member. `route()` lives next to `<Link>` (both are the link-authoring surface), imports the **tested** `PathParams` from `@lesto/router` (a clean type-only downward dep — router is pure, browser-safe, deps only `@lesto/errors`; `@lesto/client` already deps it), and adds only a ~5-line `:param` substitution mirroring `@lesto/client`'s `applyParams`. Lowering into `@lesto/router` is the "conceptually purer" option but is a cross-package move of unreleased code for marginal gain — deferred until a concrete need (e.g. a server-side route consumer that can't dep `@lesto/ui`) justifies it. Because Plan A is purely additive to `ui`, that relocation stays a cheap, demand-driven refactor rather than a speculative one now.
- Ship a typed dynamic-link builder `route("/lab/gallery/:id", { id })` (param-checked, TanStack `Link to`/`params` ergonomics; returns a `string` assignable to `href`; `route("/lab/gallery")` for static), and type the soft-nav `navigate()` against the same registry — the part that actually makes a typo/`:param` mistake a compile error, opt-in so it never false-positives on external/code-first links. This is the higher-value half of typed routing; Increment 1 is its foundation.
- Drop the `(string & {})` escape behind an opt-in so an unknown literal is a `tsc` error, with an external/query/hash allowlist (`` `${string}://${string}` ``, `` `${Base}?${string}` ``, `` `${Base}#${string}` ``) generated per route to avoid false positives.
- Capture **code-first `.page(path)` routes** into the same registry (a typed accumulator on the `Lesto` builder), so a mixed app doesn't false-positive on code-first links — the reason strict can't be the Increment-1 default.
- **Known constraint to resolve here:** `RoutePath` is emitted from the *prefix-less* compiled file-route patterns. No app mounts file routes under a prefix today (estate bakes `lab` into the segments and mounts with no prefix), but `app.route("/admin", applyFileRoutes(...))` would rewrite the real URLs to `/admin/…` while `RoutePath` stays prefix-less — a silent desync codegen can't currently see. Thread the mount prefix into the manifest (or refuse a prefixed file-route mount) when strict erroring lands.

---

## Workstream 2 — Publish + a real `create-lesto` · **blocker for adoption**

**Why (verified):** the scaffold writes 9 files and exits with "now run bun install" — no install, no `git init`, no prompts, no Tailwind/lint/test wiring, no `AGENTS.md`/`CLAUDE.md`, a home page in raw `createElement` (not JSX), and **no `app/routes/` example** so the headline file-routing is invisible on day 1 (`packages/create-lesto/src/scaffold.ts:104-114`, `templates.ts:192-200`). Worse, deps pin `^0.1.0` against an **unpublished** registry (`index.ts:42-45`) — `npm create lesto-app` fails to install without the internal `--local` flag (verifier confirmed npm 404). `create-next-app` runs a wizard, installs, inits git, scaffolds App Router + an `AGENTS.md`.

- Make the scaffold run install + `git init`, add interactive prompts + `--yes`, ship an `app/routes/page.tsx` JSX home page, author it in JSX, generate `AGENTS.md`/`CLAUDE.md`.
- Publish `0.x` to npm so the default pin resolves (RELEASING.md already designs the `0.x` publish — treat it as launch-blocking, not "last").

---

## Workstream 3 — Dev HMR / Fast Refresh + watch `app/routes/` · **blocker for first impression**

**Why (verified):** `lesto dev` watches only `app/islands/` (a debounced bundle rebuild — `bin.ts:280-293`); page/layout/loader edits need a **manual browser refresh**, and route adds need a **full dev-server restart** because `applyDiscoveredRoutes` runs once in `loadApp` (`bin.ts:202`). No live-reload/Fast-Refresh anywhere. Astro/TanStack/Next(Turbopack) all give sub-second, state-preserving updates.

- Build dev on Vite/Rolldown (already the 2026 attack-plan direction) for HMR + Fast Refresh, OR a websocket live-reload that re-scans `app/routes/` and reloads on any page/layout/app change.
- Ship `lesto routes:gen` (today the regen is a per-app npm script, `examples/estate/src/regenerate-routes.ts`) and have `lesto dev` watch `app/routes/`. (Note: the Node auto-scan path only needs a *restart*, not a regen; `routes.gen.ts` is the **edge** Worker's static-import map — keep that distinction in the watcher design.)

---

## Workstream 4 — Drift-proof the read client · **major**

**Why (verified, with proof):** the GET client's `ApiContract` is a hand-declared `interface` not derived from the server routes (`packages/client/src/client.ts`). A verifier edited a handler to return `{ totallyWrong: 123 }` and `tsc` **stayed green** — empirical drift. The *mutation* path already solves this (`MutationContractOf<typeof defs>`, `packages/runtime/src/mutations.ts:109`). Astro Actions / TanStack `createServerFn` make drift structurally impossible.

- Apply the same `typeof`-projection to reads: derive `ApiContract` from the typed route registry (you already codegen `routes.gen.ts`), OR a typed `app.get(path, handler)` that captures the handler's response type into a contract the client imports. Close the read path's drift the way `defineMutation` closed the write path's.

---

## Workstream 5 — Route boundary conventions · **major**

**Why (verified):** the file convention recognizes only `page` + `layout` (`FileRouteKind = "page" | "layout"`, `packages/router/src/file-routes.ts:49`); `loading.tsx` is *explicitly tested to be ignored*. No `error.tsx`/`not-found.tsx`. ADR 0023 lists these as out-of-scope-for-now. Next ships all three as zero-config conventions; TanStack has per-route `pendingComponent`/`errorComponent`/`notFoundComponent`.

- Add `loading`, `error`, `not-found` to `ROUTE_FILE_NAMES` and have `applyFileRoutes` wrap each page in the nearest Suspense/error boundary the same way it composes the layout chain (`layoutDepth` is the natural insertion point).

---

## Workstream 6 — Richer route segments · **major**

**Why (verified):** only single-segment `[param]`. `[...slug]` **throws**, and `(group)` folders are *actively rejected* with `ROUTER_FILE_BAD_SEGMENT`. All three competitors treat catch-all + grouping as table-stakes.

- Add catch-all `[...rest]` (compile to a trailing greedy capture, surfaced as a typed `string[]` param) — the single most common missing case. Then optional catch-all `[[...rest]]` and `(group)` pathless folders. The compiler is pure and 100%-tested; extend `DYNAMIC_SEGMENT`/`STATIC_SEGMENT` + the pattern compiler's `[^/]+` to an alternation.

---

## Workstream 7 — Client data ergonomics (the minimal Weft step) · **major**

**Why (verified):** no client cache/dedupe/revalidate/invalidate. Islands hand-roll `useState`+`useEffect` (`examples/estate/app/islands/live-listing.tsx:40-65`); mutations expose no pending/optimistic/invalidate (`save-note.tsx` even re-fetches CSRF + rebuilds the client per submit). Weft (ADR 0027) is design-accepted but unbuilt. *(Lesto does dedupe within a single page load via the data primer, and `defineDataSource`/`IslandDataProvider` removes the SSR fetch waterfall — credit where due.)*

- Ship a thin `useQuery`/`useResource` over `createApi` keys (in-flight dedupe + explicit-invalidation cache) and a `useMutation` over `createMutationClient` exposing `{ mutate, isPending, error, data }` with optimistic/`onSuccess(invalidate)`. Let the mutation client fetch/cache CSRF internally so forms stop re-implementing the round-trip. This is the smallest credible step toward Weft.

---

## Workstream 8 — Authoring DX polish · **minor, high-visibility**

**Why (verified):** `PageProps<typeof load>` exists (`render-page.tsx:140`) but **zero** pages use it — every example restates the props interface (and the helper is even structurally unusable inside the object-literal `PageDef` form). Soft-nav has no prefetch and only an *after-success* `onNavigate` (no `isNavigating`/start signal), and replaces the whole `<body>` every nav (nested layouts lose state). Query/search params are validated at the boundary but land in an untyped bag — never typed back to `load`/component.

- Adopt `PageProps<typeof load>` (or invert to `definePage({ load, component })` that infers the param) in every example + ship `lesto g page`.
- Add typed validated search params: a `search` generic on `PageDef` so `params?: ZodType<Search>` flows the validated value typed into the loader context (mirror TanStack `validateSearch`).
- Add `<Link prefetch>` (viewport/hover) + an `onNavigateStart`/`isNavigating` signal for pending UI; drive a layout-preserving partial swap from the existing `layoutDepth` shared-prefix.

---

## Sequencing

1 (in progress) → 2, 3 (the two adoption blockers, parallelizable) → 4, 5, 6 (typed-surface + routing completeness) → 7 (data ergonomics) → 8 (polish). Workstreams are file-disjoint enough to fan out via `/studio-orchestrator` once 1 lands.
