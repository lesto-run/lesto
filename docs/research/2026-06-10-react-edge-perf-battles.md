# React + Edge Performance Battles — Lessons for Keel

- **Date:** 2026-06-10
- **Audience:** Keel maintainers
- **Scope:** A deep-research pass into the hard-fought React performance battles
  other frameworks have already lost and won — hydration races, shrinking the
  React runtime, the Cloudflare Workers platform walls, and RSC double-render —
  read against Keel's *actual* model (the code, not the architecture doc) so the
  lessons are concrete rather than aspirational.

## TL;DR

The frameworks ahead of us (Astro and the Astro Cloudflare adapter most of all)
have paid for a catalogue of bugs we will inherit the moment we grow the same
features. The expensive ones cluster in four places: islands that hydrate at the
wrong time (nested-island races, hydrate-before-HTML-complete), the React
runtime being 100–150KB you ship to every visitor, the Cloudflare platform's
hard walls (no CommonJS `require`, a compressed bundle ceiling, a global-scope
startup-CPU budget, a streaming-API that once threw), and Server Components quietly
rendering a layout twice per request. The good news, confirmed by reading Keel's
code: most of the *hydration* battles are **latent, not live** for us today —
Keel ships a single, fully-buffered HTML string with a flat island manifest and
no nested islands, so the race conditions that motivate Astro's fixes have no
window to occur. What *is* live and was acted on in this change-set: a smaller
client runtime (an opt-in `react`→`preact/compat` alias, ~92% smaller raw, ~108KB
smaller gzip), keeping per-request work off the edge (the Worker now memoizes its
handler per isolate), and per-island mount resilience so one broken region cannot
dark out the rest of the page.

---

## Hydration races

These are timing bugs: the island's JavaScript runs against a DOM that is not in
the state the island assumed. Astro hit two distinct flavours.

### Nested-island hydration race — child hydrates after the parent re-created it

A child island could begin hydrating *after* its parent island had unmounted and
re-created it, leaving the runtime operating on a stale, detached element. Astro's
fix had three moving parts: a `!this.isConnected` guard so an island that is no
longer in the document skips hydration; a `setTimeout(…, 0)` macrotask deferral so
the parent settles before the child runs; and **top-down** enforcement, where a
child walks `parentElement.closest('astro-island[ssr]')` and lets the ancestor
hydrate first. See the fix in
[Astro commit `d72cfa7`](https://github.com/withastro/astro/commit/d72cfa7cad758192163712ceb269405659fd14bc)
and the report in [issue #7197](https://github.com/withastro/astro/issues/7197).

- **Root cause:** parent/child hydration ordering was not enforced, so a parent
  re-render could destroy a child mid-hydration.
- **Fix:** connectivity guard + macrotask deferral + top-down ordering.
- **Impact:** correctness — eliminates operating on detached/recreated nodes.

### Hydrate-before-HTML-complete on slow connections

On slow connections an island's script ran before the island's own HTML had
finished arriving, so a sibling lookup walked off the end of a half-built DOM and
threw `Cannot read properties of null (reading nextSibling)`. The fix was to make
the island emit an explicit `<!--astro:end-->` marker as its last child — so the
runtime can tell its own DOM is complete — with a `DOMContentLoaded` fallback. See
[issue #8178](https://github.com/withastro/astro/issues/8178) and
[PR #8680](https://github.com/withastro/astro/pull/8680).

- **Root cause:** the island ran before the browser had parsed all of its markup.
- **Fix:** an end-of-island sentinel comment + a `DOMContentLoaded` fallback.
- **Impact:** correctness on slow/throttled connections; no measured byte change.

### Per-island mount resilience (the analogue we *do* have)

React already gives each root its own hydration-error resilience. The
orchestration layer *above* the roots — the loop that mounts every island — did
not: in Keel, if one island's `mount()` threw, the `for` loop aborted and every
island after it in the manifest never hydrated. That is the same class of problem
(one region's failure cascading into others) the Astro fixes guard against, at the
layer where Keel actually has it.

---

## Shrinking the React runtime (preact/compat)

React + ReactDOM is roughly 100–150KB shipped to every visitor. The canonical
escape hatch is the `preact/compat` alias: Preact core is ~3KB and
`preact/compat` ~9KB, and real-world measurements land around **33–48% savings**
(one documented case went 91.8 → 58.2KB gzip). Astro exposes it via
`@astrojs/preact` with `compat: true`. See the
[Astro Preact integration guide](https://docs.astro.build/en/guides/integrations-guide/preact/)
and the [Vite alias issue #15503](https://github.com/vitejs/vite/issues/15503).

It is not free. The correctness traps are real:

- **Library SSR/hydration breakage.** `react-aria`'s ComboBox failed to SSR and
  hydrate under `preact/compat` while working under real React. See
  [Astro issue #4107](https://github.com/withastro/astro/issues/4107) and
  [PR #4267](https://github.com/withastro/astro/pull/4267).
- **Dev/prod alias skew.** Vite's `ssrLoadModule` historically did *not* apply
  the alias in dev — so you ran React in dev and Preact in prod, masking compat
  bugs until production. Fixed in Vite 5.2; see
  [Vite PR #15602](https://github.com/vitejs/vite/pull/15602).
- **CJS-only React libraries** resist aliasing entirely.

There is also a tooling reality specific to how Keel builds: `bun build` (the CLI)
has **no `--alias` or `--tsconfig-override` flag** (only `--external`/
`--conditions`), so aliasing `react`→`preact/compat` for the client bundle
requires the `Bun.build()` JS API with an `onResolve` resolver plugin — exactly
what `examples/estate/build-client.ts` now does.

---

## Cloudflare Workers platform walls

These are not bugs in framework code — they are the runtime's hard edges, and
every framework that targets workerd hits the same ones.

### No CommonJS `require()` in workerd

`workerd` has no CommonJS `require()`. A transitive CJS dependency (`picomatch`)
broke Astro 6 + Cloudflare + React + SSR with `require is not defined`. The fix
was to prebundle the offending dependency to ESM via `optimizeDeps.include`. See
[issue #15796](https://github.com/withastro/astro/issues/15796) and
[PR #15798](https://github.com/withastro/astro/pull/15798).

### SSR streaming once threw on workerd

Astro **disabled** SSR streaming on Cloudflare in
[PR #3777](https://github.com/withastro/astro/pull/3777) because workerd's
`ReadableStream` constructor threw. It was reverted once Cloudflare shipped a
compliant `ReadableStream` in late 2022 — see
[issue #5900](https://github.com/withastro/astro/issues/5900) and
[PR #5914](https://github.com/withastro/astro/pull/5914). The lesson is that the
edge runtime's stream primitives are a moving target; a streaming SSR path must be
proven against the *current* runtime, not assumed.

### The compressed bundle ceiling

Cloudflare caps the worker bundle at **3 MiB Free / 10 MiB Paid**, measured as
**compressed** size only. An adapter dead-code bug left prerender-only code in the
worker, ballooning it to ~7.8MB and tripping `script_too_large`; fixed in adapter
v10.2.0. See [adapters issue #218](https://github.com/withastro/adapters/issues/218)
and [PR #222](https://github.com/withastro/adapters/pull/222). The takeaway: keep
build-time / prerender-only code out of the deployed worker graph.

### The global-scope startup-CPU budget

A Worker must parse and execute its top-level (global-scope) code within a hard
**startup-time budget**; overrun raises a startup-limit validation failure
(reported as error 10021 in some paths). Cloudflare's current
[limits docs](https://developers.cloudflare.com/workers/platform/limits/) put that
budget at **1 second**, but the figure is version-dependent — a 400ms limit still
surfaces in deploy validation; see
[workers-sdk issue #10723](https://github.com/cloudflare/workers-sdk/issues/10723),
where a rejected deploy reports a 400ms startup-time limit (and the "Refuted /
corrected" section below). The remedy either way is to move initialization out of
the module top level into the request handler or to build time. This is the
finding that motivated keeping per-request construction off the Worker's hot
path — though note the documented budget is on *startup* CPU, and the win in
Keel's worker is about not redoing that work on *every* request either.

### The `_routes.json` 100-rule cap (Pages-specific)

Cloudflare **Pages** caps `_routes.json` at 100 include/exclude rules; the Astro
adapter had to collapse its rules to fit. See
[adapters PR #394](https://github.com/withastro/adapters/pull/394). This cap is a
*Pages* mechanism; a pure-Worker router (which is what Keel ships) routes in code
and may never hit this identical cap.

---

## RSC double-render

Next.js's root `layout.js` (a Server Component) rendered **twice per request**
under `dynamic = 'force-dynamic'`. The two renders run in parallel, so they add no
latency — but any *side effect* in that component (incrementing a counter, writing
a row, hitting an external API) fires twice. See
[Next.js issue #49115](https://github.com/vercel/next.js/issues/49115) and
[PR #52589](https://github.com/vercel/next.js/pull/52589). The lesson is
architectural, not a bug to port a fix for: a server-render function must be a
pure function of its inputs, because the framework reserves the right to call it
more than once.

---

## What applies to Keel (and what doesn't)

The honest mapping, grounded in the code (`packages/ui/src/hydrate.tsx`,
`examples/estate/worker.ts`, `examples/estate/build-client.ts`):

| Finding | Status for Keel | Why |
| --- | --- | --- |
| Nested-island race (#7197) | **Latent** | The manifest is a flat `readonly IslandMount[]`; no island is ever an ancestor of another, so there is no parent-before-child ordering to enforce. Ids are tree paths (`$`, `$.children[0]`) but nesting is not yet representable. |
| `isConnected` guard (#7197) | **Not applicable as written** | Keel's `root` seam legitimately mounts into *detached* trees — an existing test mounts into a `document.createElement('section')` that is never appended, so `container.isConnected === false` by design. A naive Astro-style connectivity guard would skip that mount and break the contract for zero benefit, because Keel has no late-arriving-DOM scenario. |
| Hydrate-before-HTML-complete (#8178) | **Latent** | `renderPageMarkup` buffers the *complete* HTML string before any client code runs (`KeelResponse.body` is a finished string, not a stream), so `hydrateIslands` only ever runs against a fully-settled document. There is no partial-DOM window to gate on. Revisit only if `stream.tsx` (`renderPageStream`) is ever wired to drive client hydration of a progressively-streamed document. |
| Per-island mount resilience | **Live — done this change-set** | The mount loop is exactly the orchestration layer where one failure could cascade; it now catches per island. |
| `preact/compat` size win (#15503) | **Live — done this change-set** | estate ships a React island runtime; the alias is wired as opt-in. |
| `preact/compat` correctness traps (#4107/#4267, Vite #15602) | **Live constraint** | The alias is sound *only* for deferred (`ssr: false`) islands; estate's lone `Account` island qualifies. There is no Vite dev/prod skew because Keel does not use Vite — the same `build-client.ts` produces dev and prod bundles. |
| Vite `optimizeDeps` dev-mode alias skew | **Not applicable** | Dev-mode-only, and Vite-specific (the `ssrLoadModule` alias-skew class — see Vite #15602 above); Keel's client build is `Bun.build`, not Vite. |
| No `require()` in workerd (#15796) | **Live constraint** | The estate worker runs on workerd. Keel's packages are ESM, but any future transitive CJS dependency in the worker graph is a latent `require is not defined`. |
| SSR streaming threw on workerd (#3777) | **Latent** | Keel does not stream SSR on the edge today (buffered string). The lesson applies the day `renderPageStream` reaches the worker. |
| Compressed bundle ceiling (#218) | **Live constraint** | The estate worker is well under the cap, but the same dead-code-in-worker failure mode exists; keep prerender-only code out of the worker graph. |
| Global-scope startup-CPU budget (#10723) | **Live — motivated this change-set** | The worker built its Router/controllers/`SignedSessions` on every request; that is per-request CPU on the edge for an identical result. |
| `_routes.json` 100-rule cap (#394) | **Not applicable (likely)** | That is a Cloudflare *Pages* cap; Keel routes in code inside a pure Worker. |
| RSC double-render (#49115) | **Latent (design rule)** | Keel has no RSC today, but the rule stands: `react-dom/server`'s `renderToStaticMarkup` in `render.tsx` must stay a pure function of its inputs. |

---

## Ranked actionable backlog

Highest-leverage first. `[DONE]` items were implemented in this change-set;
`[PROPOSED]` items are not yet built.

1. **`[DONE]` Keep per-request construction off the edge.** `worker.ts` now
   memoizes the `toFetchHandler` closure at module scope via `cachedSecret` /
   `cachedHandler` and a `handlerFor(secret)` helper, keyed by the resolved
   secret (`edgeSecret(env)`). An isolate builds the Router/controllers/
   `SignedSessions` once and reuses it; a different resolved secret is a cache
   miss and rebuilds, so there is no cross-secret leakage. `env.ASSETS` is
   deliberately *outside* the cache — it is a per-request binding, so
   `withAssets(env.ASSETS, handler)` is re-wrapped every `fetch` around the cached
   handler. `buildEdgeApp`'s signature is untouched, so the e2e test
   (`edge-auth.e2e.test.ts`, which calls `buildEdgeApp` directly) is unaffected.
   (Finding 11.)

2. **`[DONE]` Per-island mount resilience.** `hydrateIslands` now wraps each
   `mount()` in `try/catch`: a throwing island is routed to a new injectable
   `MountErrorSink` (`onMountError`, defaulting to `consoleMountError`), its id is
   recorded in a new `HydrationResult.failed: string[]`, and the loop continues so
   later islands still hydrate. The crucial error-class line is preserved:
   `UI_ISLAND_UNKNOWN_COMPONENT` (registry/manifest drift) is raised *before* the
   `try` and stays a fatal page-wide throw — that is a build-time programming
   error, not a per-visitor runtime fault. `failed` is empty on every success
   path, so the common case reads exactly as before plus one always-empty array.
   `MountErrorSink` is exported from the `@keel/ui/client` barrel.

3. **`[DONE]` Opt-in `preact/compat` client bundle.** `build-client.ts` uses
   `Bun.build()` with a single `onResolve` plugin (`bun build` CLI has no
   `--alias`) to map, per-specifier with anchored `^…$` filters:
   `react`→`preact/compat`, `react-dom/client`→`preact/compat/client`,
   `react/jsx-runtime` + `react/jsx-dev-runtime`→`preact/jsx-runtime`,
   `react-dom`→a local shim, and `react-dom/server`→a local shim. The alias is
   gated on `KEEL_PREACT=1` (read in `src/production.ts` and `dev.ts`), **default
   OFF** — so the default bundle is the same real React. Two shims are mandatory
   because `@keel/ui`'s barrel (reached via `src/registry.tsx`) drags server-only
   modules into the client graph: `preact-react-dom-shim.ts` re-exports
   `preact/compat` plus inert React-19 resource hints (`preload`, `preinit`,
   `preinitModule`, `preconnect`, `prefetchDNS`) that `preact/compat` lacks, and
   `preact-react-dom-server-shim.ts` provides inert `renderToStaticMarkup` /
   `renderToString` / `renderToReadableStream` because `react-dom/server`'s
   top-level bootstrap throws once `react` is aliased away. Both shims are sound
   because the client only ever hydrates — it never invokes server-render or the
   resource hints. **Measured:** default React `client.js` = 383575 bytes raw /
   ~118549 gzip; `--preact` = 30369 bytes raw / ~10241 gzip — ~92% smaller raw,
   ~108KB smaller gzip (gzip figures vary by a few bytes across zlib versions). The large delta is partly because the alias path drops
   `react-dom/server` (otherwise pulled into the React client bundle by the
   `@keel/ui` barrel) via the inert server shim. **Constraint:** safe ONLY for
   `ssr: false` (deferred, `createRoot`) islands. (Findings 5, 6.)

4. **`[DONE]` Make `preact/compat` safe for `ssr: true` islands.** `@keel/ui`'s
   server renderer is now pluggable: `renderPageMarkup` takes an injectable
   `ServerRenderer` (default `reactServerRenderer` = real `react-dom/server`, so
   the default path is byte-for-byte unchanged), and a `preactServerRenderer`
   adapter ships from the new `@keel/ui/server-preact` subpath (backed by
   `preact-render-to-string`, an optional peer dep). A Preact-client app passes
   that adapter so server- and client-emitted markup match, closing the
   `ssr: true` mismatch. Capability + end-to-end proof only — no app rewired
   (estate has no `ssr: true` island). See ADR 0008. (Finding 6, finding 4.)

5. **`[DONE]` Lazy island hydration (`client:visible` analogue).** `@keel/ui` added
   opt-in `hydrate: "visible"` per client component: `buildIsland` threads a
   `strategy: "visible"` flag onto the wire (omitted for the default `"load"`, so
   existing manifests are unchanged), and `hydrateIslands` gained an injectable
   `observe?: ObserveFn` seam (default `IntersectionObserver`) that defers a
   visible island's *mount work* — render, effects, and on-mount fetches — until
   its region first intersects the viewport, recording it under a new
   `HydrationResult.deferred`. It defers mount WORK, not bundle BYTES (Keel still
   ships one `client.js`); true byte deferral needs per-island code-splitting, a
   separate follow-up. See ADR 0008's companion note. (Finding 3.)

6. **`[PROPOSED]` Worker bundle-size guard.** Add a build-time check that the
   deployed worker's *compressed* size stays under the Cloudflare ceiling and that
   prerender-only code does not leak into the worker graph — the exact failure
   mode that ballooned the Astro adapter to ~7.8MB. (Finding 10.)

7. **`[PROPOSED]` ESM-only guard for the worker graph.** A build-time assertion
   (or `optimizeDeps`-equivalent prebundle step) that catches a transitive CJS
   dependency before it reaches workerd and throws `require is not defined` at
   runtime. (Finding 8.)

8. **`[PROPOSED]` Pure-render invariant for SSR.** Document and (where feasible)
   test that `renderToStaticMarkup` in `render.tsx` is a pure function of its
   inputs, so the framework is free to render more than once without firing side
   effects — the lesson from Next's double-render, ahead of any RSC work. (Finding
   13.)

9. **`[PROPOSED]` Streaming-complete marker, *if* `renderPageStream` ever drives
   client hydration.** Keel buffers today, so there is no partial-DOM window. The
   day the stream path feeds the client, adopt Astro's end-of-island sentinel +
   `DOMContentLoaded` fallback. (Finding 2.)

---

## Refuted / corrected

Two figures circulating about these bugs are worth pinning down precisely
(neither original draft framing survived a source check):

- **The slow-connection hydration bug (#8178): differential caching was a
  *contributing* factor, not a refuted theory.** Astro's own
  [issue #8178](https://github.com/withastro/astro/issues/8178) lists two
  contributing factors named by the reporter: (1) differential caching — JS
  fully cached while HTML carried `cache-control: no-cache`, creating the timing
  mismatch — and (2) the hydration script running before its own HTML had
  finished arriving. They are complementary, not mutually exclusive: the cache
  skew widened the window in which the parse-order race could fire. The fix
  (an end-of-island sentinel + a `DOMContentLoaded` fallback) targets the race;
  it does not "refute" the caching factor, it makes the race robust regardless of
  cache headers. (Earlier drafts that called the differential-caching cause
  "refuted" overstated the source.)

- **The Cloudflare global-scope startup-CPU budget: the *currently documented*
  figure is ~1s, but 400ms is not simply "wrong."** Cloudflare's current
  [limits docs](https://developers.cloudflare.com/workers/platform/limits/) state
  a Worker must parse and execute its global scope within **1 second**. However,
  a 400ms figure still surfaces in Cloudflare's own validation tooling — see
  [workers-sdk issue #10723](https://github.com/cloudflare/workers-sdk/issues/10723),
  where a rejected deploy reports a **400ms** startup-time limit. Treat the budget
  as version-dependent (roughly 400ms–1s across runtime versions and validation
  paths), not a single fixed number; the engineering rule — keep heavy work out of
  the module top level — holds regardless of which figure your runtime enforces.

---

## Open questions

- **Will Keel ever stream SSR on the edge?** If `renderPageStream` reaches the
  worker, three latent findings go live at once: workerd's `ReadableStream`
  history (#3777), the streaming-complete hydration marker (#8178), and any
  partial-DOM hydration ordering. Worth a deliberate decision before that path is
  wired.

- **Should `preact` be an explicit estate dependency?** It currently resolves from
  the repo-root `node_modules` (`preact@10.29.2`, added as a root devDependency
  this change-set) and `examples/estate/package.json` lists no `preact` in its
  `dependencies`. estate is not a workspace, so it hoists — the build works, but
  the dependency is implicit at the estate level. The integrator may want it
  explicit.

- **What is the right per-island hydration-strategy surface?** Lazy/visible
  hydration (finding 3) and a future `ssr: true`-under-Preact path both want
  per-island knobs. Is that a manifest field, a `HydrateOptions` strategy map, or
  a registry-level capability? Worth designing once rather than bolting on twice.

- **Where does the per-island mount-resilience contract get documented?** The new
  catch-and-continue behaviour, the `failed` field, and the `onMountError` seam
  extend the `hydrateIslands` contract and touch `@keel/ui` (another agent's
  package); an ADR or the `@keel/ui` changelog should record the dividing line
  (manifest/registry drift = fatal throw; per-island render failure = catch, sink,
  continue).
