# Island data hardening & the canonical island — implementation plan

**Execute top-to-bottom.** Each numbered item is one commit on `main` (never a side branch). This plan implements the bug list from the 2026-06-11 architecture review (items 1–6), then ADR 0012's canonical-island inversion plus the remainder of ADR 0011 Increment 1 (items 7–11). Read ADR 0010 (as corrected), ADR 0011, and ADR 0012 before starting.

## The bar (non-negotiable, every commit)

- TypeScript, ESM, Bun. `oxlint` and `oxfmt` clean.
- **100% vitest coverage per touched package** — statements, branches, functions, lines. No threshold carve-outs. New branches ship with the tests that exercise them.
- Every refusal is a **coded error** (`UiError` / `WebError` etc. with a stable code added to the package's error-code union); callers branch on codes, never message strings.
- Before each commit: run the **serial coverage gate** — `bun scripts/coverage-gate.ts` — and it must be green. Do not parallelize it (see the gate's header comment for why).
- Doc comments at the existing standard: every changed module's header comment must still tell the truth after your change. Several modules below have header prose that this plan makes *false* — updating that prose is part of the item, not optional polish.
- Commit messages: conventional (`fix(ui): …`, `feat(web): …`), ending with the repo's Claude co-author trailer.

---

## Item 1 — F1 interim guard: refuse `ssr: true` + `data` at define time

**Why:** `islandMount` (packages/ui/src/mount.ts) emits `ssr: true` alongside `bind`; both server paths (`buildIsland` in packages/ui/src/render.tsx, `defineIsland` in packages/ui/src/define-island.tsx) render the real component WITHOUT the bound props; the client hydrates with `{...props, ...data}` (hydrate.tsx `mountOne`/`finish`) — a guaranteed hydration mismatch with no guard. Until item 7 makes the combination work, declaring it must fail loudly at define time, mirroring `UI_CLIENT_SSR_NEEDS_COMPONENT`.

**Change:**
- `packages/ui/src/errors.ts`: add `"UI_CLIENT_SSR_DATA_UNSUPPORTED"` to `UiErrorCode` (keep the union alphabetized). *(This code is temporary — item 7 removes it and replaces the invariant with an emission-time check. Say so in a comment.)*
- `packages/ui/src/island.ts`: add and export `assertClientDef(def: ClientComponentDef): void` performing the three runtime union checks, with the two existing checks **moved** out of `Registry.defineClient` (packages/ui/src/registry.ts) so the rule lives once:
  1. neither `component` nor `load` → `UI_CLIENT_COMPONENT_MISSING` (existing message verbatim);
  2. `ssr: true` without `component` → `UI_CLIENT_SSR_NEEDS_COMPONENT` (existing message verbatim);
  3. **new:** `ssr === true && def.data !== undefined` → `UI_CLIENT_SSR_DATA_UNSUPPORTED`, message: `client component "<name>" is ssr: true with data bindings — the server cannot yet render an island WITH its bound data, so hydration would always mismatch (temporary; see ADR 0012)`.
- `packages/ui/src/registry.ts`: `defineClient` calls `assertClientDef(def)`.
- `packages/ui/src/define-island.tsx`: `defineIsland` calls `assertClientDef(def)` at wrap time (module init), so the `.page` path — which never passes through a registry — gets the same refusals. (Today it has none; an untyped caller can hand it a broken union too.)

**Tests:** `packages/ui/test/island.test.tsx` (or a new `packages/ui/test/client-def.test.ts`): all three codes thrown with correct `details`. `registry.test` expectations move/stay green. `define-island.test.tsx`: `defineIsland({ ssr: true, data: {…}, … })` throws `UI_CLIENT_SSR_DATA_UNSUPPORTED`; `defineIsland` with neither `component` nor `load` throws.

---

## Item 2 — F2 + F4 + F5: harden the primer and the client data fetch

**Why (verified):** `dataPrimerScript` (packages/ui/src/data.ts:121–128) emits `w[name]=fetch(...).then(r => r.json())` — (F4) unguarded, so two islands binding one source via separate `defineIsland` primers issue duplicate credentialed fetches and orphan a promise; (F2) no `response.ok` check, so a 401/429 JSON error body becomes the island's prop value; (F5) `distinctSources` (data.ts:90) has no strategy filter, so a `hydrate:"visible"` island's bind is primed at parse time — estate's `document.ts` primes every bind — defeating the entire point of `"visible"`. The client fallback fetch (`resolveBinds`, packages/ui/src/hydrate.tsx:100–104) also skips `ok`.

**Change:**
- `packages/ui/src/data.ts` — `dataPrimerScript` per-source emission becomes (names/hrefs still `JSON.stringify`-embedded; the charset validation in `defineDataSource` is what keeps this injection-safe — do not relax it):

  ```js
  w[<name>]=w[<name>]||fetch(<href>,{credentials:"same-origin"}).then(function(r){if(!r.ok)throw new Error("keel data "+r.status);return r.json()});w[<name>].catch(function(){})
  ```

  - The `||` guard makes the primer idempotent (ADR 0011 Seam 1 §3 specified this; the implementation violated its own spec).
  - The `ok` throw rejects the stored promise; `hydrateIslands` already routes a rejected bind to `onMountError`/`failed`, so the island keeps its fallback — correct behavior for a 401.
  - The trailing detached `.catch(function(){})` marks the rejection handled so a failure that occurs before hydration attaches its handler doesn't fire a spurious `unhandledrejection`. It does NOT swallow the error for `resolveBinds`, which awaits the original stored promise. Document this in the function's comment.
- `packages/ui/src/data.ts` — `distinctSources`: skip any mount whose `strategy === "visible"`. A source bound by both an eager island and a visible island still primes (the eager mount keeps it in the map). Update the function doc and the module-header delivery prose.
- `packages/ui/src/hydrate.tsx` — `resolveBinds` fallback fetch: check `response.ok`; on failure throw `new UiError("UI_ISLAND_DATA_FETCH_FAILED", \`data source "<source>" answered <status>\`, { source, status })`. Add the code to `packages/ui/src/errors.ts`.
- Behavior already correct and untouched: a `"visible"` island's bind resolves on first intersection via `resolveBinds`' fallback fetch — that path now simply isn't pre-empted by a parse-time prime.

**Tests:**
- `packages/ui/test/data.test.ts`: execute the primer body in jsdom against a stubbed `window.fetch` — (a) two sources → two fetches; running the script **twice** → still two fetches (guard); (b) a 401 response rejects the stored promise *without* the body being parsed into a value; (c) no `unhandledrejection` fires for an unconsumed rejected primer promise (use vitest's event hooks); (d) a manifest whose only bind is on a `strategy:"visible"` mount → empty primer string; (e) mixed eager+visible on one source → primed once.
- `packages/ui/test/hydrate.test.tsx`: fallback fetch answering 401 → island in `failed`, `onMountError` receives a `UiError` with code `UI_ISLAND_DATA_FETCH_FAILED`.
- Update any tests pinning the old primer bytes (`data.test.ts`, `define-island.test.tsx`, `examples/estate/test/document.test.tsx`).

---

## Item 3 — F3: cache headers on `/__keel/data/<name>` + `scope` on `defineDataSource`

**Why (verified):** `Keel.data()` (packages/web/src/keel.ts:216–218) returns `c.json(...)`, and `Context.json` (packages/web/src/handler-context.ts:108–114) sets only `content-type` — per-user JSON on a GET with no cache header is heuristically shared-cacheable. Rule now lives in ADR 0010 §3a.

**Change:**
- `packages/ui/src/data.ts`: `defineDataSource<T>(name: string, options?: { scope?: "private" | "shared" })`; `DataSource<T>` gains `readonly scope: "private" | "shared"`, defaulting to `"private"`. Update the module header (the token now carries name + scope + phantom type — still zero implementation).
- `packages/web/src/keel.ts` — `data()`:

  ```ts
  const cacheControl =
    source.scope === "shared" ? "public, max-age=0, must-revalidate" : "private, no-store";
  return this.get(dataSourceHref(source.name), async (c) => {
    const response = c.json(await loader(c));
    return { ...response, headers: { ...response.headers, "cache-control": cacheControl } };
  });
  ```

  Update `data()`'s doc comment to state the rule and why (`Vary: Cookie` is not honored by Cloudflare's cache — "do not store" is the only defense for per-user JSON).

**Tests:** `packages/web/test/keel.test.ts`: default source → `cache-control: private, no-store` on the response; `scope:"shared"` source → `public, max-age=0, must-revalidate`; body/content-type unchanged. `packages/ui/test/data.test.ts`: scope defaults private; explicit shared carried; name validation unaffected. estate is correct with no change (session stays private by default) — but eyeball `examples/estate/test/security.test.ts` for a place to add one assertion that `/__keel/data/session` is `no-store` (do add it; this is the live launch-hardening surface).

---

## Item 4 — F6: deploy-skew resilience — unknown components skip-and-report, never throw

**Why (verified):** `hydrateIslands` (packages/ui/src/hydrate.tsx:376–381) throws `UI_ISLAND_UNKNOWN_COMPONENT` uncaught mid-loop. Both manifest forms reach the client inside a **possibly CDN-cached document** (estate's `#keel-islands` script and the scanned `data-keel-island-mount` scripts alike), so the premise in the doc comment — "a manifest/registry mismatch is a build-time bug" — is wrong in production: rename an island, deploy, and every cached page darks **all** islands after the renamed one. The page-resilience contract ("one broken region cannot take the page down") must cover this.

**Change:** `packages/ui/src/hydrate.tsx` — in the manifest loop, replace the throw:

```ts
if (def === undefined) {
  onMountError(
    new UiError("UI_ISLAND_UNKNOWN_COMPONENT", `island manifest names an unregistered client component "${entry.component}"`, { id: entry.id, component: entry.component }),
    { id: entry.id, component: entry.component },
  );
  failed.push(entry.id);
  continue;
}
```

The error code stays (callers branch on it at the sink); only the delivery changes — routed, not thrown. This applies to both `hydrateIslands` and (via delegation) `hydrateDocumentIslands` — deliberately uniform, no divergent semantics between the two paths. **Rewrite the now-false doc prose**: the `hydrateIslands` doc block (the "deliberately NOT caught" paragraph) and the module header's mention, explaining the deploy-skew rationale.

**Tests:** `packages/ui/test/hydrate.test.tsx`: manifest of `[unknown, known]` → known still mounts, unknown lands in `failed`, sink receives the coded `UiError`; the existing test pinning the throw is updated to pin the new behavior; `hydrateDocumentIslands` with a stale mount script naming a renamed component → other islands hydrate.

---

## Item 5 — bind-resolution deadline

**Why:** a hung `/__keel/data/<name>` (or a primed promise that never settles) leaves its island in `deferred` forever — the client has no analogue of the server's 10s `RENDER_DEADLINE_MS` (packages/web/src/render-page.tsx:95).

**Change:** `packages/ui/src/hydrate.tsx`:
- `const BIND_DEADLINE_MS = 10_000;` (mirror the server constant's rationale in a comment).
- `HydrateOptions` gains `bindTimeoutMs?: number` (default `BIND_DEADLINE_MS`) — an injectable seam like `observe`/`mount`, primarily for tests.
- `resolveBinds(entry, timeoutMs)` races its `Promise.all` against a timer that rejects with `new UiError("UI_ISLAND_DATA_TIMEOUT", \`island data did not arrive within ${timeoutMs}ms\`, { id: entry.id })`. **Clear the timer when the data wins** (a dangling timer keeps test processes alive and is sloppy in the browser). Rejection flows through the existing `mountOne` catch → `onMountError` + `failed`.
- Add `"UI_ISLAND_DATA_TIMEOUT"` to `packages/ui/src/errors.ts`.

**Tests:** `packages/ui/test/hydrate.test.tsx` with fake timers: a never-settling primed promise → after advancing 10s the island is `failed` with the timeout code; a bind resolving at 9.9s mounts and no timer leaks (assert via `vi.getTimerCount()`); `bindTimeoutMs` override honored.

---

## Item 6 — F7: estate's primer and module script belong in `<head>`

**Why (verified):** `examples/estate/src/document.ts:98–106` emits the primer and the `client.js` module tag at end-of-body. The primer's entire purpose is to start the data fetch at parse time — at end-of-body it starts after the whole document has parsed. ADR 0011 Seam 1 already rules: head module tag, primer beside it.

**Change:** `examples/estate/src/document.ts` — move into `<head>`, in this order: the existing `<style>`, then `<script>${primer}</script>` (when non-empty), then `<script type="module" src="/client.js"></script>`. A `type="module"` script is deferred by spec — it downloads immediately, executes after the parse, so the `#keel-islands` manifest (which **stays at end-of-body**; it is inert payload the runtime reads post-parse, and keeping it after the content keeps first-paint bytes first) is always present when the runtime runs. Update the module header and inline comments to match.

**Tests:** `examples/estate/test/document.test.tsx`: primer appears in head and **before** the module tag; module tag in head; manifest still in body; a page with no bound islands emits no primer (existing assertion holds). Estate's Lighthouse posture is the regression canary — `production.integration.test.ts` must stay green.

---

## Item 7 — ADR 0012 core: the render-time source resolver in `@keel/ui`

**This is the inversion's machinery. Read ADR 0012 §Mechanism first.**

**Change:**
- **New** `packages/ui/src/data-resolve.tsx`:
  - `export interface SourceResolver { resolve(source: string): PromiseLike<unknown>; }`
  - `export function createSourceResolver(load: (source: string) => Promise<unknown> | unknown): SourceResolver` — memoizes per name (`Map<string, PromiseLike<unknown>>`): one loader run per source per request, shared by every island; chaining still has no API (the loader gets only what the caller closed over). **Implementation note:** when `load` returns a non-promise, store a pre-fulfilled *tracked thenable* (`{ status: "fulfilled", value, then(...) }`) so React's `use()` reads it synchronously — this keeps sync loaders (estate's pure-HMAC session) compatible with non-streaming renderers and keeps tests simple. A real promise is instrumented the way React expects (let `use()` do it; just memoize).
  - `export const IslandDataContext` (server-side React context, default `null`) + `export function IslandDataProvider({ resolver, children })`.
  - Export all of it from `packages/ui/src/index.ts` (server barrel — NOT the client barrel).
- `packages/ui/src/mount.ts` — `islandMount(def, rawProps, id, resolved?: Record<string, unknown>)`: when `resolved` is given, merge it into the props **after** schema validation (bound props were never schema-validated — they bypass `validateProps` on the client path today; keep that symmetric) and **before** `assertSerializable` (inlined data rides the wire, so it must pass the same JSON guard); emit `bind` only for `def.data` entries **not** present in `resolved`. The Registry path (`buildIsland`) passes nothing and is byte-for-byte unchanged.
- `packages/ui/src/define-island.tsx` — the `Island` component:
  - `const resolver = useContext(IslandDataContext);`
  - **Resolution rule** (document it as a table in the module header):
    - resolver present, island is `ssr: true` (any `hydrate`) → resolve **all** bound sources via `use(resolver.resolve(name))`, inline, no bind, no primer; the shell renders `def.component` **with** the resolved props — the canonical island.
    - resolver present, `ssr` falsy, `hydrate` ≠ `"visible"` → resolve and inline too (0 RTT; the client `createRoot`s with complete props).
    - resolver present, `ssr` falsy, `hydrate: "visible"` → do **not** resolve (the loader's work is deferred along with the mount, per the meaning of "visible"); emit `bind`, no primer for it (item 2's filter), fetch-on-intersection unchanged.
    - resolver **absent**, `ssr: true` + `data` → `throw new UiError("UI_ISLAND_SSR_DATA_UNRESOLVED", \`island "<name>" is ssr: true with data bindings but no data resolver is in scope — on a static/prerendered document this would inline per-user bytes or guarantee a hydration mismatch; render it on a dynamic page or drop ssr\`, { name })`. A static build containing this island **fails the build** — by design (ADR 0012).
    - resolver absent, `ssr` falsy → today's behavior exactly (bind + primer).
  - Add `"UI_ISLAND_SSR_DATA_UNRESOLVED"` to errors.ts; **remove** item 1's `UI_CLIENT_SSR_DATA_UNSUPPORTED` code and its check from `assertClientDef` (define-time `ssr`+`data` is now a legal, indeed canonical, declaration). Update item 1's tests accordingly.
- `packages/ui/src/data.ts` — **delete `resolveIslandData`** and its `index.ts` export; update the module header's delivery story (the dynamic tier is `data-resolve.tsx`/ADR 0012, the primer is the static tier). It has zero callers (verified) — nothing else changes.

**Tests:** `packages/ui/test/define-island.test.tsx` (+ a new `data-resolve.test.tsx`):
- under a provider with a stub resolver: ssr+data island's emitted HTML contains the component's real output **with** the data; mount script has inlined `props`, no `bind`, no primer script; deferred+data island likewise inlines; visible+data island keeps `bind` and the resolver's loader is **never called** for it; two islands binding one source → loader called once (memoization); a loader returning a sync value renders under `renderToString`; an async loader renders under `renderPageStream` (stream the result, assert the flushed document).
- without a provider: ssr+data throws the new code; deferred+data emits bind+primer byte-identically to before item 7.
- `createSourceResolver`: memoization, sync-value tracked thenable, async passthrough.
- `data.test.ts`: drop the `resolveIslandData` suite.

---

## Item 8 — wire `keel()` to the resolver + the head module tag (`@keel/web`)

**Change:** `packages/web/src/keel.ts` and `packages/web/src/render-page.tsx`:
- `Keel` gains `private readonly dataLoaders = new Map<string, (c: Context) => MaybePromise<unknown>>()`. `.data()` records the loader (last registration wins, mirroring `Registry`'s rule) in addition to registering the route. `.route()` merges `sub.dataLoaders` into the parent (parent's existing entry wins on collision? **No — last wins, i.e. the sub's, consistent with `.data()` itself; document it**). **Known limitation, document in `.route()`'s doc comment:** a prefixed mount prefixes the data *route* but `bind.href` still points at root — register sources on the root app (ADR 0010 corrections #8).
- `Keel` gains `.client(src: string): this` recording `clientModuleSrc` (e.g. `"/client.js"`). Doc comment: why config-driven rather than island-gated (streaming flushes the head first — see ADR 0011's 2026-06-11 amendment).
- `pageHandler` becomes a closure with access to the app: per request it builds `createSourceResolver((name) => { const loader = this.dataLoaders.get(name); if (loader === undefined) throw new WebError(<new code> "WEB_UNKNOWN_DATA_SOURCE", …); return loader(c); })` and calls `renderPageResponse(def, c, layouts, { clientModule, resolver })`. Add the code to `packages/web/src/errors.ts` (an island binding a never-registered source is a wiring bug — fail the island loudly through the render error path, not silently `undefined`).
- `renderPageResponse(def, c, layouts, options?: { clientModule?: string; resolver?: SourceResolver })`:
  - when `options.resolver` is set, wrap `content` in `IslandDataProvider`;
  - when `options.clientModule` is set, append `createElement("script", { type: "module", src: options.clientModule })` to the head children (after the metadata elements). This closes ADR 0011's "render-page head module tag" gap.
  - Fix the module-header lie: "The island manifest is empty here on purpose … islands slot into the same stream when that lands" → islands now ride `defineIsland`'s co-located emission and the data resolver; say so.

**Tests:** `packages/web/test/keel.test.ts` / `render-page.test.tsx`:
- `.client("/client.js")` → head contains the module tag on every page; absent without it.
- a `.page` whose tree contains an ssr+data `defineIsland` + `.data(source, loader)` → streamed HTML carries the real markup with data, an inlined mount script, no primer; loader observed **once** with the request's context across two islands binding the source.
- `.route()` merge: sub-app's loader resolves on a parent-mounted page.
- an island binding an unregistered source → the island fails (contained), the page still streams, the coded error is observable.

---

## Item 9 — F8: type the token through to the component's props (`defineIsland` generics)

**Why:** `data?: Record<string, DataSource>` (packages/ui/src/island.ts:115) is unlinked to the component's props — estate's `Account` takes `Record<string, unknown>` and casts (examples/estate/src/account.tsx:26–27). The phantom type on `DataSource<T>` exists precisely to close this loop.

**Decision:** type the **`defineIsland` path now** (the canonical path). `Registry.defineClient` typing is **deferred** to estate's `.page` convergence (ADR 0011 Increment 2) — its storage is erased `Map<string, ClientComponentDef>` and its consumers (the UiNode walk) are stringly by design, so generics there are cosmetic until that path migrates or retires; record this rationale in the `island.ts` doc.

**Change:** `packages/ui/src/define-island.tsx` gains a typed public signature over the same runtime (one erasure boundary, the `PageDef` precedent in keel.ts `page()`):

```ts
export function defineIsland<
  P extends Record<string, unknown>,
  const D extends { [K in keyof P]?: DataSource<P[K]> } = Record<never, never>,
>(def: {
  name: string;
  component: ComponentType<P>;
  ssr?: boolean;
  hydrate?: HydrationStrategy;
  fallback?: (props: Omit<P, keyof D>) => ReactNode;
  data?: D;
  props?: Record<string, PropSpec>;
}): IslandComponent<Omit<P, keyof D>>;
```

`IslandComponent<Rest>` accepts `Rest` as its JSX props. Internally cast once to the erased `ClientComponentDef` (comment the contravariance reason, as `page()` does). The acceptance bar:
- binding `DataSource<number>` to a `string` prop is a compile error;
- the returned island component **requires** the non-bound props and **rejects** the bound ones;
- an island with no `data` is unchanged (`P` flows through).

**Tests:** `define-island.test.tsx` using `expectTypeOf` + `// @ts-expect-error` cases for each bullet; runtime suite untouched (the erasure is type-level only — coverage cannot regress, but the ts-expect-error lines must be exercised by `vitest --typecheck` or the package's existing typecheck step; wire whichever the repo already runs in CI).

---

## Item 10 — CLI invokes `@keel/assets` (`keel dev` / `keel build`)

**Why:** ADR 0011 Seam 3 — `@keel/assets` (`buildClient`, `synthesizeEntry`, packages/assets/src) is shipped and unit-tested but nothing calls it; `packages/cli/src/run.ts` already has the `clientAsset` injection seam for serving `/client.js` in dev.

**Change** (follow the CLI's existing injected-deps pattern — real implementations bind in `bin.ts`, `run.ts` stays pure):
- Convention: a project with an **`app/islands/`** directory (one island module per file, default-exporting a `defineIsland` component — ADR 0011's convention, exactly) gets a client build. No directory → no build, zero change for island-less apps.
- `RunDeps` gains `buildClientAssets?: (options: { projectRoot: string; outDir: string; mode: "dev" | "production" }) => Promise<void>` — `bin.ts` wires it to `synthesizeEntry(join(projectRoot, "app/islands"))` + `buildClient(...)` with `bunBuildClientDeps`. Dialect: `"react"` for now; the `ui.dialect` config key is Increment 2/3 scope — leave a pointed TODO referencing ADR 0011 Seam 2.
- `keel build`: when `app/islands/` exists, run the prod client build into the static out dir before/alongside `buildStaticSites` so `/client.js` + chunks land in the artifact.
- `keel dev`: when `app/islands/` exists, run an unminified build on boot, then a debounced (`~100ms`) `fs.watch` on `app/islands/` rebuilding on change; serve the result through the existing `clientAsset` seam. Keep the watcher trivial — correctness over cleverness.

**Tests:** `packages/cli` test suite with injected fakes: `build` invokes `buildClientAssets` iff the islands dir exists (fake fs probe via deps — add an injectable `hasIslandsDir`/fs seam rather than touching the real filesystem); `dev` builds on boot; failure of the client build fails the command with a coded CLI error (add to packages/cli/src/errors.ts). 100% coverage including the watcher debounce (fake timers).

---

## Item 11 — the blog proof (ADR 0011 Increment 1 exit, demonstrating ADR 0012)

**Why:** `examples/blog` is the canonical `keel()+.page` app and has **no island** — the wire has never been proven end-to-end. Per ADR 0012 it must prove the **canonical** island: ssr + inline data on a dynamic page.

**Change** (`examples/blog`):
- `src/reactions-source.ts`: `export const reactionsSource = defineDataSource<Record<string, number>>("reactions", { scope: "shared" })` — post-slug → count; shared on purpose (same for every visitor) so the proof exercises the non-default scope and its cache header.
- `app/islands/reactions.tsx`: a pure `Reactions({ counts })` component (renders a count badge per post; an interactive bit — e.g. a local-state "👍" toggle — so hydration is observable), `export default defineIsland({ name: "Reactions", component: Reactions, ssr: true, data: { counts: reactionsSource } })`. Typed via item 9 — **no casts**.
- `src/page.tsx`: render `<ReactionsIsland />` in `BlogPage`.
- `src/app.ts`: `.data(reactionsSource, async () => countReactions(db))` (an in-memory or db-backed count — keep it honest but small) and `.client("/client.js")`.
- `examples/blog/test/` (new, mirroring estate's test layout): assert the streamed `/posts` document contains (a) the island's **real server markup including the counts** (not a fallback), (b) a co-located mount script with inlined props and **no `bind`**, (c) **no primer**, (d) the head module tag; assert `/__keel/data/reactions` answers with `cache-control: public, max-age=0, must-revalidate`; a jsdom `hydrateDocumentIslands` pass over the document mounts the island with zero `failed`.
- Run `keel dev` against blog manually once and record the result in the commit message (client builds, island hydrates, no console errors) — the automated assertions above are the gate, the manual run is the smoke.

**Exit criterion (ADR 0011 Increment 1, restated):** blog's `/posts` ships a live data-bound island with **inline** (0-RTT) data and a small client, written as `keel()+.page` + one island file — zero bespoke scripts.

---

## Explicitly out of scope (decided, with owners)

- **estate convergence** onto `.page`/`defineIsland` and the Registry-path resolver seam — ADR 0011 Increment 2.
- **`create-keel` scaffold flip** to the canonical island — ADR 0011 Increment 3.
- **Dev double-render mismatch diff**, then any reconsideration of defaulting `ssr` — ADR 0012 Phase C.
- **CSP nonce seam** for inline scripts (primer + mount scripts) — no served path enforces a CSP today; design when one does (ADR 0010 corrections #9).
- **`TriggerFn`** generalization of `ObserveFn` / richer hydrate vocabulary (`"idle"`, `"media"`) — future ADR.
- **Prefix-aware `bind.href`** for `.data()` under `.route(prefix, …)` — documented limitation (ADR 0010 corrections #8).
