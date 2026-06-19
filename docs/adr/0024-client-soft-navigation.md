# ADR 0024 — Client-side router & soft navigation

- **Status:** Accepted (implemented)
- **Date:** 2026-06-19
- **Deciders:** tech lead + owner
- **Supersedes nothing; builds on the islands hydration runtime (`hydrateDocumentIslands`, ADR 0011) and the bfcache-safe page lifecycle (`observePageLifecycle`, ADR 0009). Pairs with ADR 0023 (file-based routing) and is the SPA-grade primitive the roadmap's Bet I (`@lesto/platform` view-transitions / speculation-rules) would later layer on top of.**

## Context

A Lesto page is a real, server-rendered document: a plain `<a href>` works, the
page is crawlable, and the back/forward cache holds. That floor is non-negotiable.
But every peer client router — Next's app-router `<Link>`, React-Router 7,
SvelteKit, Nuxt, TanStack Router, Astro's `<ClientRouter>` — gives the same
upgrade ON TOP of that floor: an in-app link, when JS is on, **fetches the next
page and swaps it in without a full document reload** — no white flash, island
state preserved where the swap can keep it, scroll restored on Back/Forward. Lesto
had islands (interactive regions) but no navigation primitive between pages, so an
in-app link was always a full reload that re-downloaded and re-ran everything.

The roadmap's **Bet I** (`@lesto/platform`) is about the browser-native niceties
that ride *on top of* a navigation — `startViewTransition`, speculation-rules
prefetch. Those are wrappers; they presuppose a navigation to wrap. This ADR is the
navigation itself — the fetch-and-swap SPA primitive — distinct from, and a
prerequisite for, Bet I. (Bet I's view-transition wrapper is a natural future
caller of this module's `onNavigate` / `swap` seams.)

The constraints:

- **Progressive enhancement is the contract, not a mode.** The server renders every
  page as a full document; a `<Link>` is an ordinary `<a>`. With no JS — or before
  the runtime loads, or for any link it declines — the browser does a normal
  navigation. Soft nav is a pure enhancement; it is never load-bearing for
  correctness, only for smoothness.
- **It must not fight the bfcache lifecycle (ADR 0009).** Soft nav drives
  `history.pushState`, which does NOT enter the back/forward cache; a real document
  navigation (and its `pageshow`/`persisted` restore) stays `observePageLifecycle`'s
  job, untouched.
- **It must re-hydrate islands on swap, over the same registry the initial load
  used** — so a swapped-in page's islands come alive with the same components.
- **Everything that touches the platform is injected** (the same discipline as
  `hydrate.tsx` / `bfcache.ts`), so the whole state machine runs under jsdom with no
  real navigation, no real network, and a fake history.

## Decision

Ship soft navigation in two halves, split by what each touches:

### `<Link>` + the contract — isomorphic (`@lesto/ui` core)

`<Link>` renders a real `<a href>`, nothing more: it works with JS off, it is an
anchor in every devtool, and it is the authoring sugar that pairs with the runtime.
`reload` lifts off the DOM props into a `data-lesto-reload` attribute the runtime
declines on (for a link that must re-run the document — a logout, a cross-app
boundary). The DOM-FREE contract — the opt-out attribute name and the eligibility
predicate `eligibleAnchor(click)` (a pure function over a click's modifier/button
flags + the resolved anchor) — lives in `softnav-contract.ts`, which imports
NOTHING from the DOM or `react-dom`. So `<Link>` stays in the isomorphic barrel and
a server build that imports `@lesto/ui` for it drags in no `fetch`/`DOMParser`.

### `enableSoftNav` — browser-only (`@lesto/ui/client`)

`enableSoftNav(registry, options?)` installs ONE delegated click listener. For an
eligible same-origin link click it: `preventDefault`s the full navigation, stamps
the current entry's scroll into `history.state`, **fetches** the destination's HTML
(default: a same-origin `fetch` with `accept: text/html`, following redirects to
the landed URL), **swaps** the fetched `<body>`'s children into the live one
(default: parse + `replaceChildren`, keeping the live `<body>` node and its
delegated listeners; carry over only the `<title>`), **pushes** the history entry,
**re-hydrates** islands against the just-swapped document, and **restores scroll**
(top for a forward nav, the saved position for a Back/Forward). A `popstate` to one
of our own soft-nav entries replays the swap; a pop to an entry we didn't create
(or a bfcache restore) is left to the browser. A fetch/swap failure routes to
`onError`, whose default does a real navigation to the destination — so a soft-nav
failure degrades to exactly the full reload the link would have done with no JS,
never a dead link.

Every seam — `document`, `history`, `window` (scroll), the `popstate` target, the
page fetcher, the swapper, the re-hydrate call, `onNavigate`/`onError` — defaults
to the real browser and is overridable. `disable()` removes the listeners and
hands `history.scrollRestoration` back (soft nav owns it as `"manual"` for the
session, because the browser's automatic restore races the swap).

### Eligibility — decline so the browser navigates normally

`eligibleAnchor` declines (and the click falls through to a real navigation) when:
the event was already defaulted by another handler; it is not a plain primary-button
click (any modifier or non-left button means the user asked for a new tab / window /
save); there is no enclosing `<a href>`; or the anchor is a named-`target`, a
`download`, or carries the `data-lesto-reload` opt-out. The cross-origin check lives
in the runtime (it needs the page origin) — a link to another origin is always a
real navigation. Resolving the clicked node up to its nearest `<a href>`
(`closest("a[href]")`) is the runtime's job; the eligibility *rules* stay pure over
a plain object, so every decline branch is unit-tested with no DOM.

## Consequences

- **A click soft-navigates; the floor still holds.** Clicking a `<Link>` swaps the
  next page in with no full reload and re-hydrates its islands; with JS off (or any
  declined link) the same anchor does an ordinary navigation. Back/Forward replays
  the swap and restores scroll.
- **bfcache stays intact.** `pushState` never enters the back/forward cache, so
  this never fights `observePageLifecycle` (ADR 0009); that helper still owns the
  real-document lifecycle.
- **No `react-dom` in the isomorphic build.** The DOM-free contract keeps `<Link>`
  and the eligibility logic out of the browser-only subpath, so a server importer
  of `@lesto/ui` pulls no client navigation code.
- **A clean seam for Bet I.** `onNavigate` / the injectable `swap` are exactly where
  a future `startViewTransition` wrapper or speculation-rules prefetch hooks in,
  without this module knowing about either.
- **Demonstrated in estate.** `client.tsx` calls `enableSoftNav(registry)` after the
  initial hydrate; the file-routed gallery (ADR 0023) is the visible proof — clicking
  a listing `<Link>` swaps in its `/lab/gallery/:id` detail page without a reload.
  `test/soft-nav.test.tsx` drives the whole loop (forward swap, history URL update,
  Back replay) through the real app under jsdom, with `fetchPage` wired to
  `app.handle`.

### Security — what the swap does and does not add

The swap inserts **same-origin, server-rendered (trusted) HTML** into the live DOM.
Two properties bound the surface precisely — no more, no less than a full navigation
would:

- **Parsed `<script>` tags do NOT re-execute.** The default swap parses the fetched
  HTML with `DOMParser` and moves the resulting nodes in; per the HTML spec, a
  `<script>` inserted by the parser of a `DOMParser`-created document is already
  "already started" and never runs. So soft nav does not turn a stored `<script>`
  into a fresh execution it would not have had.
- **Inline event-handler attributes behave exactly as a full navigation.** An
  `onerror`/`onload`/`onclick` attribute on swapped-in markup executes when the
  element loads or fires — identical to what the same server-rendered page would do
  on a real navigation. Soft nav therefore adds **no script-execution surface beyond
  the full-navigation baseline for same-origin targets**: anything that would run on
  the swapped page already runs when the browser loads that page directly.

The one path that *would* have widened the surface — a same-origin link that
302-redirects **cross-origin** — is closed by the runtime: after the fetch resolves,
the runtime re-checks the **landed** URL's origin (not just the clicked link's) and,
if it differs from the page origin, swaps nothing and falls back to a real
navigation (`location.assign`). Foreign HTML never enters our origin's live DOM. (The
fetch is `credentials: "same-origin"`, so a cross-origin hop also carries no
ambient-authority cookies.)

Net: for same-origin targets the swap is no more dangerous than the full navigation
it replaces, and the cross-origin-redirect guard removes the only case where it
could have been worse. This is **not** a sanitizer — it relies on the server
rendering trusted markup, exactly as the full-navigation path already does.

### Deliberately out of scope (for now)

- **View transitions / speculation-rules prefetch** — Bet I (`@lesto/platform`),
  layered on this module's `onNavigate`/`swap` seams, not built here.
- **Partial / nested-region swaps** — the default swap replaces the whole `<body>`;
  a finer region swap is an injectable `swap` an app can supply, not a built-in.
- **Head/body metadata reconciliation** — the body-only swap carries over the
  `<title>` (and announces it for a11y) but does NOT reconcile `<html lang>`, body
  attributes, or other non-title head metadata (`<meta>`, `<link rel>`,
  `lang`/`class` on `<html>`/`<body>`) across navigations. A page whose `lang` or
  body class must change per route should declare such a link `reload` (full nav) or
  inject a `swap` that handles it; widening the default swap to reconcile head/body
  is intentionally left out here.
- **Pending/optimistic UI** — richer in-flight transition state (a loading bar,
  optimistic content) is a future addition. In-flight *cancellation* IS handled: a
  newer click or Back/Forward pop captures a fresh generation token and aborts the
  prior fetch, so overlapping navigations resolve **last-click-wins**, never
  last-fetch-wins (no stale swap, no spurious intermediate history entry).
