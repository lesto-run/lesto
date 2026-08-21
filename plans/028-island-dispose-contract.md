# Plan 028: The island dispose contract — stop soft nav orphaning React roots

> **Executor instructions**: This is ADR 0048 **Phase 0.1** and it fixes a
> **live shipped leak**, not a new feature. Land it increment by increment, gate
> green after each. Do NOT start Phase 0.2 (the trace ring) or 0.3 (honest
> vitals) from this plan. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git log --oneline -5 -- packages/ui/src/hydrate.tsx packages/ui/src/softnav.ts`

## Status

- **Priority**: P1 (a live leak in shipped code)
- **Effort**: coarse M
- **Risk**: LOW–MEDIUM (a type change on one injected seam; the default React
  path's behavior is unchanged apart from the teardown that was missing)
- **Depends on**: none
- **Category**: correctness / memory safety
- **Source**: ADR 0048 Phase 0.1 (Proposed, 2026-08-17), whose adversarial pass
  validated the defect
- **Planned at**: commit `7b11787`, 2026-08-18

## Why this matters

The three facts, each verified against live code:

1. `MountFn` is `(container, element, context) => void`
   (`packages/ui/src/hydrate.tsx:193`). The default `reactMount`
   (`hydrate.tsx:266`) calls `hydrateRoot(...)` and `createRoot(...).render(...)`
   and **discards both root handles**. Nothing in the package can ever unmount an
   island.
2. Soft navigation's swap is `live.replaceChildren(...)`
   (`softnav.ts:373`, `replaceContents`). It replaces the DOM and **tears down
   nothing** — every navigation detaches the old island containers while their
   React roots stay mounted, effects and all.
3. A mounted island may hold live registrations: `useQuery`'s
   `refetchInterval` / `refetchOnWindowFocus` / `refetchOnReconnect` are wired in
   an effect (`data-client.ts:536-572`) whose cleanup only runs on unmount. With
   no unmount, a poll timer keeps firing — refetching, publishing snapshots, and
   re-rendering **into detached DOM** — for the life of the tab.

So: N soft navigations leave N orphaned React roots and N live poll timers. The
teardown is not "missing polish", it is the absent half of a mount contract.

`hydrateIslands` is also the substrate ADR 0048's `lesto verify` stands on — a
battery that drives an app through many navigations is precisely the consumer
that turns this from a slow leak into a visible one.

## Current state (verified)

- `packages/ui/src/hydrate.tsx`
  - `MountFn` returns `void` (`:193`); `reactMount` discards its roots (`:266`).
  - `finish()` (`:382`) is the ONE place every path (eager, lazy, bound,
    on-intersection) calls `mount(...)` — so it is the one place a disposer can
    be retained.
  - A `"visible"` island's `observe(...)` handle is `disconnect`ed only **after**
    it mounts (`:486-494`). A page that navigates away before the region is seen
    leaves the observer watching a detached element.
- `packages/ui/src/softnav.ts`
  - `navigate()` calls `swap(html, doc)` then `rehydrate(registry, { root })`
    (`:682-700`). No teardown between them.
  - `enableDevPageRefresh`'s `refresh()` has the identical shape (`:1033-1048`)
    and the identical leak (dev-only, same class).
  - `replaceContents(live, fetched, doc)` (`:373`) is the single site where the
    DEFAULT swap actually replaces DOM — full-body and layout-preserving partial
    swap both funnel through it.
- `packages/ui/src/errors.ts` — `UiErrorCode` union; a new code lands here.
- Injected `mount` seams exist only in `packages/ui/test/hydrate.test.tsx`
  (8 call sites). No example, app, or published caller passes `options.mount`
  (`grep -rn "mount:" examples site www packages --include='*.ts*'` outside
  `packages/ui/test`), so the seam's signature change touches no adopter code.
- `examples/estate/client.tsx` calls `hydrateDocumentIslands(registry)` then
  `enableSoftNav(registry)` — it gets the fix with **no source change**, which is
  exactly why estate needs a *test* that proves it, not a rewrite.

### Conventions to follow

- CONVENTIONS.md: strict TS (no `any`, no dodging casts), ESM, oxfmt owns
  whitespace, **100% coverage on `@lesto/ui`**, errors carry codes, inject what
  varies, comments name the invariant.
- AGENTS.md trap — **vacuous tests**: an assertion that can never fire is
  decorative. Every test below must be watched RED before it is trusted. The
  disposal assertions are written as *positive* ones (a disposer that was already
  called throws a coded error; a fake revalidation environment records its
  cancel) rather than "the leak is absent".
- Estate is the living dogfood and must be updated in the SAME change.

## The design

**One registry, two ways to drain it, one caller-held handle.**

1. `Disposer = () => void` and `MountFn` returns one. A mount that brings an
   island to life must say how to take it back down.
2. `hydrateIslands` retains each successful mount's disposer in a module-level
   `Map<Element, { id, dispose }>` keyed by the island's container — the same
   place the browser already keys a React root.
3. `disposeDetachedIslands()` — dispose every retained island whose container is
   no longer `isConnected`. Called by `navigate()` and by the dev `refresh()`
   immediately after `swap(...)` returns and before `rehydrate(...)`. **This is
   the only teardown endpoint**, and it is the one that covers an injected
   `PageSwapper` — which owns its own DOM replacement and which the runtime cannot
   instrument.

   *Superseded design, recorded (2026-08-18 review):* a second mechanism disposed
   the swap's own subtree from inside `replaceContents`, **before**
   `replaceChildren` — the literal ADR 0048 wording. Two independent reviewers
   showed it was dead weight: `replaceContents` is reachable only from
   `defaultSwap`, which is reachable only from the `swap(...)` call both sweep
   sites follow in the same synchronous job, so everything it disposed was
   disposed one statement later anyway — while an injected swapper still needed
   the sweep. It was removed, along with its export and its tests.

   *Why after, not before, for the backstop:* the swap seam is a single call that
   both chooses the subtree and replaces it, so the replaced subtree is not
   knowable until it returns. The sweep runs synchronously in the same job as the
   swap — no timer, effect, or microtask can run in between — so "after the swap"
   and "before the swap" are behaviorally indistinguishable here, and only the
   former can cover a swap the runtime did not write.
4. `islandDisposer(container)` — the caller-held teardown handle for one island
   (an app that removes a region itself must be able to tear it down). Calling it
   twice throws the coded `UI_ISLAND_ALREADY_DISPOSED`; that guard is what stops
   a double `root.unmount()`, and a caller-held handle is what makes the coded
   error the ADR requires reachable at all.

   ⚠️ *Reviewed and retained (2026-08-18):* both reviewers argued this export has
   no consumer today and that dropping it would let the error code go too. It is
   kept because ADR 0048 Phase 0.1 states "Coded error on double-dispose" as a
   requirement, and no internal path can double-call — deleting the handle would
   delete the requirement. The review DID find a real defect behind it (below).

**A `"visible"` island holds TWO successive teardowns** — the pending observation,
then the mount — and the transition between them must run the first handle rather
than drop its entry, or a caller holding it can later fire it, evict the MOUNT's
teardown from the registry, and orphan the very root this contract exists to end.
(Found in review; the first implementation dropped the entry raw.)

**A lazy or bound island in flight is retained too.** Between `hydrateIslands` and
its chunk (or its bind) resolving, nothing was retained, so a navigation swept
nothing and the mount then landed in a container the document had already let go —
a live root nothing could reach, and on the last navigation of a session one that
runs forever. It retains a CANCEL before returning `"later"`; disposing the pending
island trips it and the mount is abandoned. (Deferred in the first draft as
"reclaimed by the next sweep", which is only true if the user navigates again; the
review was right that it is the same defect class.)

## Increments

### Increment 1 — the contract and the registry (`@lesto/ui`)

`packages/ui/src/errors.ts`: add `"UI_ISLAND_ALREADY_DISPOSED"` to `UiErrorCode`
(alphabetical).

`packages/ui/src/hydrate.tsx`:

- `export type Disposer = () => void;` with a doc block stating the contract:
  called at most once; a second call is a coded error.
- `MountFn` returns `Disposer`.
- `reactMount` keeps its root and returns `() => root.unmount()` on both
  branches. **The default path's mount behavior is otherwise byte-identical** —
  `hydrateRoot` still gets the same options, `createRoot(...).render(...)` still
  runs in the same order.
- A module-level `liveIslands: Map<Element, { id: string; dispose: Disposer }>`.
- `disposeOnce(id, dispose)` wraps a raw disposer so the second call throws
  `UiError("UI_ISLAND_ALREADY_DISPOSED", …, { id })`.
- `finish()` registers the wrapped disposer after a successful `mount(...)`,
  **disposing any prior entry for the same container first** (a re-mount over a
  live root would otherwise orphan it — the collision is the only way the
  registry can lie).
- `disposeDetachedIslands(): string[]` and
  `islandDisposer(container: Element): Disposer | undefined` — each deletes its
  entry before/at disposal so the registry never holds a spent handle.
- Export the new symbols from `packages/ui/src/client.ts` (the browser barrel;
  they touch the DOM, so they do **not** go on the isomorphic barrel).

Update the 8 injected `mount` seams in `packages/ui/test/hydrate.test.tsx` to
return a disposer.

**Acceptance tests** (`packages/ui/test/hydrate.test.tsx`, new describe block):

- `reactMount` on the `ssr: false` (createRoot) path: after
  `islandDisposer(container)!()`, the live component's DOM is gone from the
  container. *(RED before: nothing to call.)*
- `reactMount` on the `ssr: true` (hydrateRoot) path: same, proving BOTH branches
  return a real unmount.
- Calling a disposer twice throws a `UiError` whose `code` is
  `UI_ISLAND_ALREADY_DISPOSED`, with a frozen `details.id`.
- `islandDisposer` returns `undefined` for a container that never mounted, and
  `undefined` again after the island was disposed.
- Re-hydrating the SAME container disposes the first mount before the second
  mounts (assert via the first handle now throwing).
- `disposeDetachedIslands()` disposes exactly the islands whose container left
  the document and returns their ids; a still-connected island is untouched.
- A failed mount (the `finish` catch path) registers nothing.

**Verify**: `cd packages/ui && bun run typecheck && bun run lint && bun run format:check && bun run test:cov` → exit 0, 100%.

### Increment 2 — soft nav and the dev page refresh drain it

`packages/ui/src/softnav.ts`:

- `navigate()` calls `disposeDetachedIslands()` after `swap(...)` and before
  `rehydrate(...)`; `refresh()` (`enableDevPageRefresh`) does the same. That is the
  ONLY teardown site — `replaceContents` just replaces.
- The `PageSwapper` doc block states the teardown contract: the runtime disposes
  what the swap detaches, so an injected swapper never has to know about island
  lifetimes.

**Acceptance tests**:

- New `packages/ui/test/island-dispose.test.tsx` (the softnav-facing cases live
  here, not in `softnav.test.ts`, because they need React) — **the defect, pinned
  end to end**: an island component that calls `useQuery(key, fetcher, { refetchInterval,
  environment })` against a FAKE `RevalidationEnvironment` recording
  `setInterval`/cancel; hydrate it, soft-navigate with an injected `fetchPage`,
  and assert the fake's cancel ran and no further poll fires after the
  navigation. Run the same scenario with the disposal wiring removed once, by
  hand, to confirm it goes RED (it must: the interval keeps firing).
- `packages/ui/test/softnav.test.ts`: a soft nav disposes the swapped-out
  island's retained handle (the handle now throws `UI_ISLAND_ALREADY_DISPOSED`),
  and a **layout-preserving partial swap** leaves the preserved outer layout's
  island mounted (its handle still works) — the regression that would otherwise
  destroy the very state the partial swap exists to keep.
- An **injected** `swap` that does its own `replaceChildren` still gets its
  detached islands disposed (the backstop branch).
- `enableDevPageRefresh` disposes the islands its swap replaced.

**Verify**: `cd packages/ui && bun run typecheck && bun run lint && bun run format:check && bun run test:cov` → exit 0, 100%.

### Increment 3 — a never-mounted `"visible"` island stops observing

A `"visible"` island that is swapped away before its region is seen leaves an
`IntersectionObserver` watching a detached element (a real observer holds a
strong reference to its target). Register the observer's `disconnect` as the
container's retained disposer at observe time.

The transition to the mount is where this gets sharp, and the review found three
ways to get it wrong:

- The intersection must END the observation THROUGH its retained handle, not drop
  the entry raw — otherwise a caller holding that handle can fire it later and
  evict the MOUNT's teardown.
- An `ObserveFn` that reports visibility SYNCHRONOUSLY has already mounted by the
  time the runtime would retain the observation, so retaining unconditionally
  overwrites the mount's teardown. Retain only when it has not mounted, and
  disconnect the observer that will not be retained — nothing else holds it.
- A re-hydrate over a still-watching container must end the first observation,
  symmetric with what the mount path does.

**Acceptance tests**:

- A deferred `"visible"` island whose container is detached and swept has its
  observer disconnected (assert the injected `ObserveFn`'s disconnect ran).
- The one-shot mount path still disconnects exactly once and mounts exactly once.
- After the intersection, the retained handle is the MOUNT's and the observation
  handle is spent.
- A synchronous `ObserveFn` keeps the mount's teardown AND disconnects.
- A second `hydrateIslands` over a watching container disconnects the first.

**Verify**: `cd packages/ui && bun run typecheck && bun run lint && bun run format:check && bun run test:cov` → exit 0, 100%.

### Increment 4 — estate, the living dogfood

Estate needs **no source change** — it already calls `hydrateDocumentIslands` +
`enableSoftNav`, so it inherits the teardown. What it needs is the proof, in
`examples/estate/test/soft-nav.test.tsx`:

- Paint the real `/lab` page (it carries the `LiveListing` and `DeferredPanel`
  islands), hydrate it with the estate island registry, capture the
  `LiveListing` container's `islandDisposer` handle, soft-navigate to
  `/lab/gallery` through the real `app.handle`, and assert the captured handle
  now throws `UI_ISLAND_ALREADY_DISPOSED` — i.e. estate's own islands are torn
  down by estate's own navigation.

**Verify**: `cd examples/estate && bun run typecheck && bun run lint && bun run format:check && bun run test` → exit 0; `LESTO_DEMO=1 bun run build` → exit 0.

### Increment 5 — docs

- `docs/adr/0024-client-soft-navigation.md`: record the teardown contract in the
  Consequences/companion section (soft nav now disposes what it swaps out).
- `site/content/docs/guides/routing.md`: one sentence where `enableSoftNav` is
  introduced — swapped-out islands are unmounted, so a polling `useQuery` in a
  swapped-out island stops.
- `plans/README.md`: add the 028 row.

**Verify**: `cd site && bun run test` → exit 0.

## Done criteria

- [ ] `MountFn` returns `Disposer`; both `reactMount` branches return a real unmount
- [ ] `hydrateIslands` retains a disposer per container; a re-mount disposes the prior one
- [ ] Soft nav + dev page refresh dispose the islands their swap detaches; a
      layout-preserving partial swap does NOT dispose the preserved layout's islands
- [ ] Double-dispose throws `UI_ISLAND_ALREADY_DISPOSED` with frozen details
- [ ] A `refetchInterval` in a swapped-out island demonstrably stops (RED without the fix)
- [ ] `cd packages/ui && bun run test:cov` → 100%, exit 0
- [ ] Estate proves the teardown on its own page + navigation; estate builds
- [ ] `plans/README.md` row for 028 updated

## STOP conditions

- Making `MountFn` return `Disposer` turns out to break a real adopter call site
  outside `packages/ui/test` — report it and widen the union to `Disposer | void`
  rather than silently forcing the break.
- Disposing on the partial-swap path unmounts a PRESERVED layout's island — that
  is a behavior regression worse than the leak; stop and re-scope the sweep.

## Maintenance notes

- The registry is module-level browser state, like a React root registry. It is
  drained by disposal and by the detached sweep; the only growth path is an app
  that detaches island shells outside a swap and never navigates again — bounded
  by the page's island count, and noted in the doc block.
- `lesto verify` (ADR 0048 Phase 1) is the first consumer that will drive many
  navigations in one page lifetime; it should assert the registry drains.
