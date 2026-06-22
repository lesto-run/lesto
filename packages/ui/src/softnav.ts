/**
 * Client-side soft navigation — a `Link` is just an `<a>`, and this upgrades it.
 *
 * Lesto pages are real documents: a plain `<a href>` works with JS off, which is
 * the floor this never drops below. With JS on, {@link enableSoftNav} installs ONE
 * delegated click listener that, for an eligible same-origin link, fetches the
 * next page, swaps its body in place, re-hydrates the islands, and updates history
 * — no full document reload, no white flash, island state preserved where the swap
 * can keep it. Back/Forward replays the same swap from `popstate`, and scroll is
 * restored to where the user left each entry.
 *
 * This is the SPA-grade soft-nav primitive, distinct from the roadmap's Bet I
 * `@lesto/platform` view-transitions / speculation-rules item (which layers
 * browser-native niceties ON TOP of a navigation): this is the navigation itself,
 * the fetch-and-swap every peer framework's client router owns (Next's app-router
 * Link, RR7, SvelteKit, Nuxt, TanStack, Astro's `<ClientRouter>`). Bet I's
 * view-transition wrapper is a natural future caller of {@link SoftNavOptions.swap}.
 *
 * ## Progressive enhancement is the contract, not a mode
 *
 * The server still renders every page as a full document, and a `Link` is an
 * ordinary anchor — so with no JS (or before this module loads, or for any link
 * this declines to handle) the browser does a normal navigation. Soft nav is a
 * pure enhancement layered over working links; it never becomes load-bearing for
 * correctness, only for smoothness. A link opts OUT with `data-lesto-reload`
 * (force a full nav) and is declined automatically when it is cross-origin, a
 * download, targets another frame, or the click carries a modifier (the user asked
 * for a new tab) — every case where a soft swap would be wrong.
 *
 * ## bfcache stays intact
 *
 * Soft nav drives `history.pushState`, which does NOT enter the back/forward cache
 * (only real document navigations do), so this never fights {@link observePageLifecycle}
 * (`bfcache.ts`): that helper still owns the page lifecycle and still refuses
 * `unload`/`beforeunload`. A `popstate` to a soft-nav entry re-fetches and swaps;
 * a `popstate` that the browser served from bfcache (a real prior document) fires
 * `pageshow` with `persisted`, the lifecycle helper's job, untouched here.
 *
 * ## Everything that touches the platform is injected
 *
 * `fetch`, `history`, the document, the window's scroll, and the re-hydrate call
 * are all seams with real-browser defaults, so the whole state machine runs under
 * jsdom with no real navigation, no real network, and a fake history — the same
 * testability discipline as `hydrate.tsx` and `bfcache.ts`.
 */

import { UiError } from "./errors";
import { hydrateDocumentIslands } from "./hydrate";
import type { HydrateOptions, HydrationResult } from "./hydrate";
import type { Registry } from "./registry";
import { eligibleAnchor, LAYOUT_ATTR, PREFETCH_ATTR, RELOAD_ATTR } from "./softnav-contract";
import type { PrefetchStrategy, SoftNavAnchor, SoftNavClick } from "./softnav-contract";

// Re-export the DOM-free contract through the runtime barrel, so a caller that
// reaches for the soft-nav surface sees one module — the constants and the click /
// anchor shapes that `<Link>` (isomorphic) and this runtime (browser) both read.
export { eligibleAnchor, LAYOUT_ATTR, PREFETCH_ATTR, RELOAD_ATTR } from "./softnav-contract";
export type { PrefetchStrategy, SoftNavAnchor, SoftNavClick } from "./softnav-contract";

/**
 * One history entry's restorable scroll position. Saved into `history.state` on
 * navigate-away so Back/Forward returns the user to where they were, not the top.
 */
export interface ScrollPosition {
  x: number;
  y: number;
}

/** The history surface soft nav drives — `window.history` satisfies it. */
export interface SoftNavHistory {
  state: unknown;

  /**
   * The browser's scroll-restoration mode. Always present on a real `History`
   * (`"auto"` by default), so it is REQUIRED here too — soft nav flips it to
   * `"manual"` for the session and hands the prior value back on `disable()`,
   * with no "was it ever set" branch to reason about.
   */
  scrollRestoration: string;

  pushState(state: unknown, unused: string, url: string): void;
  replaceState(state: unknown, unused: string, url: string): void;
}

/** The window surface soft nav reads/writes for scroll — `window` satisfies it. */
export interface SoftNavWindow {
  scrollX: number;
  scrollY: number;
  scrollTo(x: number, y: number): void;
}

/**
 * Where the `popstate` (Back/Forward) listener attaches — `window` satisfies it.
 * Its own seam, separate from the scroll {@link SoftNavWindow}, so a test can fire
 * a synthetic `popstate` at a fake target with no real history navigation.
 */
export interface PopStateTarget {
  addEventListener(type: "popstate", listener: (event: Event) => void): void;
  removeEventListener(type: "popstate", listener: (event: Event) => void): void;
}

/**
 * What soft nav fetches: a page's HTML and the URL it actually resolved to (after
 * any redirect), so the history entry reflects where the user really landed.
 */
export interface FetchedPage {
  html: string;
  url: string;
}

/**
 * The page fetcher — defaults to a same-origin `fetch` of the destination's HTML.
 * Always receives the navigation's `AbortSignal` so a superseded in-flight fetch
 * can be cancelled (the default passes it straight to `fetch`); an override that
 * does not care about cancellation simply omits the parameter.
 */
export type PageFetcher = (url: string, signal: AbortSignal) => Promise<FetchedPage>;

/**
 * Swap the fetched document's body into the live one and return the new title.
 *
 * The default {@link defaultSwap} parses the HTML, swaps the body — LAYOUT-PRESERVING
 * when the document carries {@link LAYOUT_ATTR} markers, else replacing the whole
 * body's contents — and returns the fetched `<title>`. A caller can inject a finer
 * swap (a single content region, a view-transition wrapper for Bet I) without this
 * module knowing how the page is structured.
 */
export type PageSwapper = (html: string, doc: Document) => string | undefined;

/**
 * The re-hydrate call after a swap — defaults to {@link hydrateDocumentIslands}.
 *
 * Its shape is exactly `hydrateDocumentIslands`'s `(registry, options)`, so the
 * default IS that function with no adapter, and the applier passes the swap target
 * document as `options.root` (the seam hydration looks islands up under). An
 * override that ignores `options` still type-checks; one that honors `root`
 * re-hydrates against the just-swapped document, not the ambient global one.
 */
export type Rehydrate = (registry: Registry, options: HydrateOptions) => HydrationResult;

/** A soft navigation's kind — a forward push vs. a Back/Forward replay. */
export type SoftNavKind = "push" | "pop";

/** What a completed soft navigation reports to {@link SoftNavOptions.onNavigate}. */
export interface SoftNavEvent {
  kind: SoftNavKind;
  url: string;
  hydration: HydrationResult;
}

/** The injectable seams + hooks `enableSoftNav` runs on; all default to the real browser. */
export interface SoftNavOptions {
  /** Where the delegated click listener attaches and islands re-hydrate. Defaults to `document`. */
  document?: Document;

  /** The history to drive. Defaults to `window.history`. */
  history?: SoftNavHistory;

  /** The window to read/write scroll on. Defaults to `window`. */
  window?: SoftNavWindow;

  /** Where the `popstate` listener attaches. Defaults to the document's `defaultView` (the window). */
  popStateTarget?: PopStateTarget;

  /** How to fetch a page's HTML. Defaults to a same-origin `fetch`. */
  fetchPage?: PageFetcher;

  /** How to swap the fetched body in. Defaults to replacing `document.body`'s contents. */
  swap?: PageSwapper;

  /** How to re-hydrate after a swap. Defaults to {@link hydrateDocumentIslands}. */
  rehydrate?: Rehydrate;

  /** Called after each successful soft navigation — the Bet I view-transition hook, telemetry, etc. */
  onNavigate?: (event: SoftNavEvent) => void;

  /**
   * Called the moment a soft navigation STARTS — before its fetch, after the click
   * is taken over. The pair to {@link onNavigate} (which fires after success): this
   * is the cue to show pending UI (a top progress bar, a busy cursor). It carries
   * the destination and {@link SoftNavKind} so a caller can distinguish a forward
   * push from a Back/Forward replay. Fires once per navigation, including one a
   * newer click later supersedes (so a started-but-aborted nav is observable too).
   */
  onNavigateStart?: (event: SoftNavStart) => void;

  /**
   * Observe the {@link IsNavigatingSignal} pending flag — called once immediately
   * with the current value (false) and again on every change, so a caller can drive
   * pending UI declaratively without tracking start/end itself. The observable form
   * of {@link onNavigateStart} + {@link onNavigate}; both are wired off the same
   * in-flight count, so they never disagree. (The same signal is returned from
   * {@link enableSoftNav} for a caller that prefers to read it.)
   */
  onNavigatingChange?: (navigating: boolean) => void;

  /**
   * How to observe a prefetch link entering the viewport — defaults to the browser's
   * `IntersectionObserver`. Injected so the viewport-prefetch path is testable under
   * jsdom (which has no real `IntersectionObserver`) with a fake that fires entries
   * on demand. A `"viewport"` `<Link prefetch>` needs this; an environment that
   * lacks it (and supplies no override) refuses viewport prefetch with a coded
   * `UI_SOFTNAV_PREFETCH_UNSUPPORTED`, leaving the link's hover/click paths intact.
   */
  intersectionObserver?: IntersectionObserverFactory;

  /**
   * Called when a soft navigation's fetch or swap throws. The DEFAULT recovers by
   * doing a real navigation to the destination (`assign`), so a soft-nav failure
   * degrades to exactly the full reload the link would have done with no JS —
   * never a dead link. Override to surface the error differently.
   */
  onError?: (error: unknown, url: string) => void;
}

/** What a STARTING soft navigation reports to {@link SoftNavOptions.onNavigateStart}. */
export interface SoftNavStart {
  kind: SoftNavKind;
  url: string;
}

/**
 * The observable "a navigation is in flight" flag returned from {@link enableSoftNav}.
 *
 * `get()` reads the current value; `subscribe(listener)` registers a listener called
 * immediately with the current value and again on every change, returning an
 * unsubscribe. A thin hand-rolled signal (no dependency): an app wires it to whatever
 * pending UI it renders — a progress bar, a `aria-busy` flag, a disabled nav.
 */
export interface IsNavigatingSignal {
  get(): boolean;
  subscribe(listener: (navigating: boolean) => void): () => void;
}

/**
 * Construct an {@link IntersectionObserver}-shaped observer — the seam the viewport
 * prefetch path uses. The real `IntersectionObserver` constructor satisfies it; a
 * test injects a fake whose callback it can fire with synthetic entries.
 */
export type IntersectionObserverFactory = (
  callback: (entries: IntersectionObserverEntry[]) => void,
) => IntersectionObserverLike;

/** The slice of `IntersectionObserver` the prefetch wiring uses. */
export interface IntersectionObserverLike {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

/**
 * The control surface {@link enableSoftNav} returns: a callable that detaches every
 * listener (idempotent — a second call is a harmless no-op), plus the
 * {@link IsNavigatingSignal} pending flag a caller can read or subscribe to. It IS a
 * function (call it to disable), so the original `disable()` call site is unchanged.
 */
export interface DisableSoftNav {
  (): void;

  /** The observable "a navigation is in flight" flag — see {@link IsNavigatingSignal}. */
  isNavigating: IsNavigatingSignal;
}

/**
 * Resolve the {@link SoftNavAnchor} a click targets by walking from the clicked
 * node up to the nearest enclosing `<a href>`, or `undefined` if there is none.
 *
 * A click lands on whatever was under the cursor — a `<span>` inside a `<Link>`,
 * the `<a>` itself, or bare page chrome — so we ascend the ancestry via the
 * standard `closest("a[href]")` (which includes the element itself) and read the
 * eligibility surface off the found anchor: its RESOLVED `href` (the DOM
 * normalizes a relative one to absolute), its `target`, whether it carries a
 * `download`, and the {@link RELOAD_ATTR} opt-out. An anchor with no `href`, or a
 * click on non-anchor chrome, yields `undefined` and the click falls through to
 * the browser untouched.
 */
function resolveAnchor(target: EventTarget | null): SoftNavAnchor | undefined {
  // Only an `Element` can have an enclosing anchor; a click whose target is not
  // one (the document, a text node the platform never hands us) has no anchor.
  if (!(target instanceof Element)) return undefined;

  const anchor = target.closest("a[href]");

  if (!(anchor instanceof HTMLAnchorElement)) return undefined;

  return {
    href: anchor.href,
    target: anchor.target,
    hasDownload: anchor.hasAttribute("download"),
    reload: anchor.hasAttribute(RELOAD_ATTR),
  };
}

/**
 * The prefetch-eligible anchor a node sits under, with its opted-into strategy — or
 * `undefined` when there is no enclosing `<a>` carrying a valid {@link PREFETCH_ATTR}.
 *
 * Reads the nearest anchor (a hover may land on a child `<span>`) so the intent
 * listener and any strategy check share one resolution. Pure over the DOM, captures
 * nothing — a sibling of {@link resolveAnchor}.
 */
function prefetchTargetOf(
  target: EventTarget | null,
): { anchor: HTMLAnchorElement; strategy: PrefetchStrategy } | undefined {
  if (!(target instanceof Element)) return undefined;

  const anchor = target.closest("a[href]");

  if (!(anchor instanceof HTMLAnchorElement)) return undefined;

  const value = anchor.getAttribute(PREFETCH_ATTR);

  return value === "viewport" || value === "hover" ? { anchor, strategy: value } : undefined;
}

/**
 * The default page fetch: a same-origin GET whose body is the page's HTML. The
 * resolved `response.url` rides back so a redirect lands the history entry on the
 * real destination, not the link's pre-redirect href.
 */
const defaultFetchPage: PageFetcher = async (url, signal) => {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { accept: "text/html" },
    signal,
  });

  // A non-ok page is still a page (a 404 has a body to show); we swap it like any
  // other rather than throw, so the user sees the server's error page, not a dead
  // click. A true network failure rejects and routes to `onError` → full nav.
  const html = await response.text();

  return { html, url: response.url === "" ? url : response.url };
};

/**
 * Replace a live element's CONTENTS with a fetched element's children, importing
 * the fetched nodes into the live document. Shared by the full-body swap and the
 * partial layout swap so the import-and-replace rule lives in one place.
 */
function replaceContents(live: Element, fetched: Element, doc: Document): void {
  live.replaceChildren(...Array.from(fetched.childNodes).map((node) => doc.importNode(node, true)));
}

/**
 * The deepest layout-marker subtree the live + fetched documents SHARE, or
 * `undefined` when they share none (no markers, or the chains diverge at the root).
 *
 * Layout-preserving partial swap (driven by {@link LAYOUT_ATTR}): the server marks
 * each layout-boundary element with its `data-lesto-layout="<depth>"`. We walk the
 * live document's marker chain from the outermost depth inward, matching each
 * against the fetched document's marker at the same depth. As long as a depth marker
 * exists in BOTH (the two pages pass through the same layout there), the swap can
 * keep that layout's live DOM mounted and recurse inward. The first depth that is
 * missing on either side is where the pages diverge — everything from there down is
 * what must be swapped.
 *
 * Returns the matched `{ live, fetched }` element pair for the deepest shared
 * layout, so the caller swaps only THAT element's contents (the inner page +
 * deeper layouts), preserving every outer layout above it. `undefined` means
 * "no shared layout boundary" — the caller does the whole-body fallback swap.
 */
function deepestSharedLayout(
  liveBody: Element,
  fetchedBody: Element,
): { live: Element; fetched: Element } | undefined {
  let live = liveBody.querySelector(`[${LAYOUT_ATTR}="0"]`);
  let fetched = fetchedBody.querySelector(`[${LAYOUT_ATTR}="0"]`);

  // No depth-0 marker in both documents → no shared layout boundary at all; the
  // caller falls back to a full body swap (today's behavior, never a regression).
  if (live === null || fetched === null) return undefined;

  let match: { live: Element; fetched: Element } = { live, fetched };

  // Descend the marker chain depth by depth. The next-deeper layout, if both pages
  // have it, must be NESTED inside the current matched layout (a prefix tree), so we
  // look for it WITHIN the matched element — that keeps an unrelated sibling layout
  // at the same depth elsewhere in the tree from being mistaken for a match.
  for (let depth = 1; ; depth += 1) {
    const selector = `[${LAYOUT_ATTR}="${depth}"]`;

    live = match.live.querySelector(selector);
    fetched = match.fetched.querySelector(selector);

    // One side lacks this depth → the chains diverge here; the previous match is the
    // deepest layout both pages share.
    if (live === null || fetched === null) return match;

    match = { live, fetched };
  }
}

/**
 * The default swap: parse the fetched HTML and swap the live `<body>`.
 *
 * **Layout-preserving when it can be.** If both the live and fetched documents
 * carry {@link LAYOUT_ATTR} markers that share an outer prefix, only the DEEPEST
 * shared layout's contents are replaced (its inner page + any deeper layouts),
 * leaving every outer layout's DOM — and the island state mounted in it — intact
 * across the navigation. This is the "nested layouts keep their state" behavior.
 *
 * **Full-body fallback otherwise.** With no markers (today's server output) or a
 * chain that diverges at the root, it replaces the whole `<body>`'s children — the
 * original behavior, byte-for-byte, so the partial swap is a pure enhancement that
 * never regresses an unmarked page.
 *
 * Either way it replaces CONTENTS (not the `<body>`/layout element itself), keeping
 * the live nodes — and the click listener delegated to `<body>`'s document — attached
 * across the swap. The head is left alone (the client module + styles already ran);
 * only the per-page `<title>` is carried over.
 */
const defaultSwap: PageSwapper = (html, doc) => {
  const parsed = new DOMParser().parseFromString(html, "text/html");

  const shared = deepestSharedLayout(doc.body, parsed.body);

  if (shared === undefined) {
    // No shared layout boundary → swap the whole body (the original behavior).
    replaceContents(doc.body, parsed.body, doc);
  } else {
    // A shared outer layout → swap only its inner contents, preserving the outer
    // layout DOM (and any island state mounted in it) across the navigation.
    replaceContents(shared.live, shared.fetched, doc);
  }

  // `textContent` is "" when the fetched page has no <title>; treat that as "no
  // title to set" so we never blank the tab on a title-less page.
  const title = parsed.title;

  return title === "" ? undefined : title;
};

/** The id of the framework-owned `aria-live` region soft nav announces routes through. */
const LIVE_REGION_ID = "lesto-route-announcer";

/**
 * Announce the new route to assistive tech. A real navigation re-reads the page;
 * a body swap is silent, so we mirror that by writing the new title into a polite
 * `aria-live` region (lazily created, visually hidden) — the same technique every
 * peer client router uses to keep soft nav from regressing screen-reader UX.
 *
 * The region is appended to `<html>` (`documentElement`), a SIBLING of `<body>`, not
 * inside the body — because the default swap does `body.replaceChildren(...)`, which
 * would delete a body-resident region on the very next navigation. Screen readers
 * only announce a region whose text changes while it is ALREADY in the DOM, so it
 * must persist across swaps: by living on `<html>` it survives every body swap, is
 * found again on the next navigation, and only its `textContent` updates.
 */
function announceRoute(message: string, doc: Document): void {
  let region = doc.getElementById(LIVE_REGION_ID);

  if (region === null) {
    region = doc.createElement("div");
    region.id = LIVE_REGION_ID;
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "true");
    region.setAttribute("role", "status");
    region.style.cssText =
      "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap";
    doc.documentElement.append(region);
  }

  region.textContent = message;
}

/**
 * Move focus to the new page's top, like a real navigation does. We target the
 * main landmark, else the first `<h1>`, else the body — giving a non-interactive
 * target a `tabindex="-1"` (harmless: `-1` takes focus programmatically without
 * entering the tab order) so the next Tab and the AT reading cursor start at the
 * new content, not a detached old node.
 */
function focusMain(doc: Document): void {
  const target =
    doc.querySelector<HTMLElement>("main") ?? doc.querySelector<HTMLElement>("h1") ?? doc.body;

  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");

  target.focus();
}

/**
 * A minimal observable boolean — the backing of {@link IsNavigatingSignal}.
 *
 * A hand-rolled signal (no framework dependency): `set` no-ops when the value is
 * unchanged so listeners only hear real transitions, and `subscribe` calls back
 * immediately with the current value (the "initial render" any pending-UI binding
 * needs) then on every change. Listeners live in a `Set` so an unsubscribe is exact.
 */
function createBooleanSignal(): IsNavigatingSignal & { set(next: boolean): void } {
  let value = false;
  const listeners = new Set<(navigating: boolean) => void>();

  return {
    get: () => value,
    set(next: boolean): void {
      if (next === value) return;

      value = next;

      for (const listener of listeners) listener(value);
    },
    subscribe(listener: (navigating: boolean) => void): () => void {
      listeners.add(listener);

      listener(value);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** One warmed prefetch: its in-flight fetch + the controller that can cancel it. */
interface PrefetchEntry {
  promise: Promise<FetchedPage>;
  controller: AbortController;
}

/**
 * Enable client-side soft navigation: upgrade eligible same-origin link clicks to
 * a fetch-and-swap, wire Back/Forward, restore scroll, and (opt-in per link) PREFETCH
 * a destination before the click — over the supplied island `registry`, so a
 * swapped-in page's islands hydrate with the same components the initial load did.
 *
 * Returns a `disable()` that removes every listener and restores the browser's own
 * scroll restoration — so a test (or a hot reload) can tear the whole thing down
 * cleanly. The returned function also carries an `isNavigating` {@link IsNavigatingSignal}
 * for pending UI. Call it once, after the initial `hydrateDocumentIslands`:
 *
 *   hydrateDocumentIslands(registry);
 *   const softNav = enableSoftNav(registry);
 *   softNav.isNavigating.subscribe((busy) => …);   // drive a progress bar
 *   // softNav();                                   // later, to tear down
 */
export function enableSoftNav(registry: Registry, options: SoftNavOptions = {}): DisableSoftNav {
  const doc: Document = options.document ?? document;
  const hist: SoftNavHistory = options.history ?? window.history;
  const win: SoftNavWindow = options.window ?? window;

  const fetchPage: PageFetcher = options.fetchPage ?? defaultFetchPage;
  const swap: PageSwapper = options.swap ?? defaultSwap;
  const rehydrate: Rehydrate = options.rehydrate ?? hydrateDocumentIslands;

  // We own scroll restoration: the browser's automatic restore races our swap (it
  // restores against the OLD document height before the new body is in), so we set
  // it manual and restore explicitly after each swap. Remembered so `disable()`
  // hands it back.
  const priorScrollRestoration = hist.scrollRestoration;
  hist.scrollRestoration = "manual";

  // The same-origin gate the eligibility check defers to us: a link to another
  // origin is a real navigation, never a same-document swap. Read from the current
  // document's URL so it is correct under jsdom's configured location too.
  const origin = new URL(doc.URL).origin;

  // Recover from a failed soft nav by doing the real navigation — the link's own
  // floor. Pulled out so the default is testable and an override is a clean swap.
  const onError =
    options.onError ??
    ((_error: unknown, url: string): void => {
      doc.location.assign(url);
    });

  // Last-CLICK-wins, not last-fetch-wins: every navigation grabs a monotonic token
  // and aborts the prior in-flight fetch, and each `await` resume bails if a newer
  // navigation (a forward click OR a Back/Forward pop) has since started — so two
  // overlapping navigations can never resolve out of click order and corrupt the
  // live body, the URL, or history.
  let currentToken = 0;
  let inFlight: AbortController | undefined;

  // The pending-nav signal: a navigation flips it true on start and false on
  // settle (success, supersession, or failure). Counted, not a bare boolean, so a
  // nav that starts while another is still settling never clears the flag early —
  // it reads false only when NO navigation is in flight. Wired to the optional
  // change callback so the imperative and observable forms share one source.
  const isNavigating = createBooleanSignal();
  let pendingCount = 0;

  if (options.onNavigatingChange !== undefined) {
    isNavigating.subscribe(options.onNavigatingChange);
  }

  const navStarted = (): void => {
    pendingCount += 1;

    isNavigating.set(true);
  };

  const navSettled = (): void => {
    pendingCount -= 1;

    if (pendingCount === 0) isNavigating.set(false);
  };

  // Warmed prefetches, keyed by the destination URL: a `<Link prefetch>` fires its
  // fetch ahead of the click and parks the in-flight promise here, so the eventual
  // navigation consumes it instead of starting a second round-trip.
  const prefetches = new Map<string, PrefetchEntry>();

  // Perform the fetch → swap → re-hydrate → scroll for one navigation. `kind`
  // distinguishes a forward push (record where we came from, scroll to top) from a
  // Back/Forward pop (restore the saved scroll, do not push a new entry).
  const navigate = async (
    url: string,
    kind: SoftNavKind,
    restore?: ScrollPosition,
  ): Promise<void> => {
    const mine = ++currentToken;
    inFlight?.abort();

    // Announce the start (pending UI cue) and flip the in-flight flag — both fire
    // once per navigation, even one a newer click later supersedes, so a started-
    // but-aborted nav is observable too. `navSettled()` in `finally` always pairs.
    options.onNavigateStart?.({ kind, url });
    navStarted();

    // Consume a warmed prefetch for this exact URL if one is in flight — its fetch
    // already started (or finished) ahead of the click, so the navigation is
    // instant. A prefetch is single-use: take it out of the cache so a later nav to
    // the same URL re-fetches fresh rather than replaying a stale warmed body.
    const warmed = prefetches.get(url);
    prefetches.delete(url);

    const controller = warmed?.controller ?? new AbortController();
    inFlight = controller;

    try {
      const { html, url: landed } = await (warmed?.promise ?? fetchPage(url, controller.signal));

      // A newer click/pop superseded us while the fetch was in flight — drop this
      // stale result so it cannot clobber the newer navigation's swap or history.
      if (mine !== currentToken) return;

      // The same-origin gate again, now on the LANDED url: a same-origin link that
      // 302-redirected cross-origin must NOT have its foreign body swapped into our
      // live DOM — fall back to a real navigation, the link's own floor.
      if (new URL(landed).origin !== origin) {
        doc.location.assign(landed);
        return;
      }

      const title = swap(html, doc);

      if (title !== undefined) doc.title = title;

      // A forward nav records the new entry (carrying its eventual scroll, seeded
      // at top); a pop is replaying an existing entry, so history is left alone.
      if (kind === "push") {
        hist.pushState({ lestoSoftNav: true, scroll: { x: 0, y: 0 } }, "", landed);
      }

      // Re-hydrate against the JUST-SWAPPED document — `root` is the seam islands
      // are looked up under, so the new body's mount scripts are the ones found,
      // not the ambient global `document`'s.
      //
      // ACTIVATION CAVEAT for the layout-preserving partial swap: this re-hydrates
      // the WHOLE document, which is correct ONLY for the full-body swap (today's
      // path — no server emits `data-lesto-layout`, so `deepestSharedLayout` always
      // returns undefined). The moment a server DOES emit those markers and a partial
      // swap keeps an outer layout's DOM, re-scanning the whole doc here would re-mount
      // that preserved layout's islands (no idempotency guard in `hydrateDocumentIslands`)
      // and DESTROY the very state the partial swap preserves. So before wiring the
      // marker, this must scope to the swapped subtree (the `defaultSwap` would have to
      // surface which element it replaced) OR `hydrateDocumentIslands` must skip an
      // already-mounted shell. Until then the partial-swap branch stays a dormant, pure
      // fallback (see docs/plans/dx-parity.md W8) — never activate one without the other.
      const hydration = rehydrate(registry, { root: doc });

      // The swapped-in page brings its own `viewport`-prefetch links; register them
      // so they warm as the user scrolls the new page. (Hover links are caught by
      // the persistent delegated listeners, so they need no re-registration.)
      registerViewportLinks();

      // Restore the saved scroll for a Back/Forward, else go to the top of the new
      // page — the browser's own behavior for a fresh navigation.
      if (restore !== undefined) {
        win.scrollTo(restore.x, restore.y);
      } else {
        win.scrollTo(0, 0);
      }

      // Match a real navigation's a11y: announce the new title through a polite
      // live region so screen readers hear the change, and move focus to the new
      // page's top landmark so the next Tab / AT cursor starts there, not on a now
      // detached node left over from the old body.
      announceRoute(doc.title, doc);
      focusMain(doc);

      options.onNavigate?.({ kind, url: landed, hydration });
    } catch (error) {
      // A fetch aborted by a newer navigation is expected, not a failure — that
      // newer navigation owns the page now, so swallow it rather than fall back to
      // a real reload that would fight it.
      if (mine !== currentToken) return;

      onError(error, url);
    } finally {
      // Always pair the `navStarted()` above — the flag clears on success, on
      // supersession (the early `return`s run `finally`), and on failure alike, so
      // pending UI never sticks on after a navigation settles.
      navSettled();
    }
  };

  // Is this RESOLVED href (an anchor's `.href`, always absolute) one soft nav could
  // navigate to — same-origin, not the current page? The prefetch gate: warming a
  // cross-origin URL (or the page we're already on) is wasted work, and a
  // cross-origin warm would be a needless request to a foreign server. Mirrors the
  // click-time eligibility, minus the event flags (a prefetch is not a click). No
  // try/catch: the caller only ever passes `anchor.href`, which the DOM has already
  // normalized to a parseable absolute URL — so `new URL` here cannot throw.
  const isPrefetchable = (href: string): boolean => {
    const there = new URL(href);

    if (there.origin !== origin) return false;

    const here = new URL(doc.URL);

    return there.pathname !== here.pathname || there.search !== here.search;
  };

  // Warm the fetch for a destination: start it (if not already warmed) and park the
  // in-flight promise so the eventual `navigate(url)` consumes it. The promise's
  // rejection is swallowed here — a prefetch that fails (offline, aborted on
  // teardown) must never surface as an unhandled rejection; the click path re-tries
  // and routes a real failure to `onError`. `url` is the RESOLVED absolute href,
  // the same key `navigate` looks up.
  const warmPrefetch = (url: string): void => {
    if (prefetches.has(url) || !isPrefetchable(url)) return;

    const controller = new AbortController();
    const promise = fetchPage(url, controller.signal);

    // Detach a no-op catch so a prefetch rejection is never unhandled; the entry's
    // own `promise` (the un-caught one) is what `navigate` awaits, so the real
    // error still reaches the click path.
    promise.catch(() => {});

    prefetches.set(url, { promise, controller });
  };

  // Before leaving the current entry, stamp its live scroll position into its
  // history state, so a later Back/Forward to it restores where the user was.
  const recordScroll = (): void => {
    const state = (hist.state ?? {}) as { lestoSoftNav?: boolean };

    hist.replaceState(
      { ...state, lestoSoftNav: true, scroll: { x: win.scrollX, y: win.scrollY } },
      "",
      doc.URL,
    );
  };

  const onClick = (event: Event): void => {
    // Adapt the real DOM event into the DOM-free {@link SoftNavClick} the pure
    // `eligibleAnchor` reads: the modifier/button flags ride straight off the
    // `MouseEvent`, and `anchor()` walks from the clicked element up to the
    // nearest `<a>`, reading the eligibility surface (href/target/download/opt-out)
    // off it. A real browser event has no `anchor()` of its own — resolving it
    // here is exactly the seam that keeps the eligibility rules testable with a
    // plain object.
    const mouse = event as MouseEvent;

    const click: SoftNavClick = {
      button: mouse.button,
      metaKey: mouse.metaKey,
      ctrlKey: mouse.ctrlKey,
      shiftKey: mouse.shiftKey,
      altKey: mouse.altKey,
      defaultPrevented: mouse.defaultPrevented,
      anchor: () => resolveAnchor(mouse.target),
      preventDefault: () => mouse.preventDefault(),
    };

    const anchor = eligibleAnchor(click);

    if (anchor === undefined) return;

    // Cross-origin links are real navigations — the one eligibility rule that
    // needs the page origin, so it lives here, not in the pure `eligibleAnchor`.
    if (new URL(anchor.href).origin !== origin) return;

    // A same-document link (one that differs only by `#hash`, or is identical to
    // the current URL) is the browser's to handle: hijacking it would refetch the
    // page, swap the body, scroll to top, and churn history — destroying the native
    // in-page anchor jump. So if the destination's pathname + search match the live
    // URL, let it fall through untouched (no preventDefault, no navigate).
    const here = new URL(doc.URL);
    const there = new URL(anchor.href);
    if (there.pathname === here.pathname && there.search === here.search) return;

    // We are taking over: stop the browser's full navigation, remember this
    // entry's scroll, and swap to the destination.
    click.preventDefault();

    recordScroll();

    void navigate(anchor.href, "push");
  };

  const onPopState = (event: Event): void => {
    const state = (event as unknown as { state: unknown }).state as {
      lestoSoftNav?: boolean;
      scroll?: ScrollPosition;
    } | null;

    // A pop to an entry we did NOT create (a real prior document, or the initial
    // load's entry) is the browser's to handle — left alone, it does its native
    // thing (including a bfcache restore that fires `pageshow`). We only replay our
    // own soft-nav entries.
    if (state === null || state.lestoSoftNav !== true) return;

    void navigate(doc.URL, "pop", state.scroll ?? { x: 0, y: 0 });
  };

  // --- Prefetch wiring (opt-in per link via `data-lesto-prefetch`) ----------

  // A pointer-enter / focus on (or within) a `hover`-strategy link warms its fetch.
  // Delegated on the document (one listener, survives swaps) — `pointerover` and
  // `focusin` both bubble, so a single pair covers mouse and keyboard intent.
  const onPrefetchIntent = (event: Event): void => {
    const found = prefetchTargetOf(event.target);

    if (found?.strategy === "hover") warmPrefetch(found.anchor.href);
  };

  // The viewport-prefetch observer: an `IntersectionObserver` that warms a
  // `viewport`-strategy link the moment it scrolls into view, then stops watching it
  // (a single warm per link). Created lazily on the first viewport link so an app
  // that uses only hover/no prefetch pays for no observer.
  let viewportObserver: IntersectionObserverLike | undefined;

  const observeViewportLink = (anchor: HTMLAnchorElement): void => {
    if (viewportObserver === undefined) {
      const factory = options.intersectionObserver;

      // No factory and no real `IntersectionObserver` (jsdom, an old engine) → a
      // coded refusal: viewport prefetch cannot run here. Hover + click still work;
      // the caller branches on the code to (e.g.) downgrade to hover.
      if (factory === undefined && typeof IntersectionObserver === "undefined") {
        throw new UiError(
          "UI_SOFTNAV_PREFETCH_UNSUPPORTED",
          'Viewport prefetch needs an IntersectionObserver; this environment has none and none was injected. Use prefetch="hover" or pass options.intersectionObserver.',
        );
      }

      const make: IntersectionObserverFactory =
        factory ?? ((cb) => new IntersectionObserver(cb) as IntersectionObserverLike);

      viewportObserver = make((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;

          const link = entry.target;

          viewportObserver?.unobserve(link);

          if (link instanceof HTMLAnchorElement) warmPrefetch(link.href);
        }
      });
    }

    viewportObserver.observe(anchor);
  };

  // Register every current `viewport`-strategy link with the observer. Run on enable
  // and after each swap (a swapped-in page brings its own prefetch links), so the
  // set stays current without a per-link mutation observer. Hover links need no
  // registration — they are caught by the delegated intent listeners.
  const registerViewportLinks = (): void => {
    // A `<body>`-less seam (a bare fake document used only to test history/scroll
    // teardown, never a real page) has no links to scan — skip rather than throw,
    // so the prefetch scan never makes the body a hard requirement of enabling.
    const body = doc.body as Element | null | undefined;

    if (body === null || body === undefined) return;

    const links = body.querySelectorAll<HTMLAnchorElement>(`a[href][${PREFETCH_ATTR}="viewport"]`);

    for (const anchor of Array.from(links)) observeViewportLink(anchor);
  };

  // Back/Forward listens on the window (the document's `defaultView`); a test
  // injects a fake target so a synthetic `popstate` needs no real history move.
  const popTarget: PopStateTarget = options.popStateTarget ?? (doc.defaultView as PopStateTarget);

  // Register the initial viewport-prefetch links FIRST: the only throwing path on
  // enable is the "viewport prefetch unsupported" refusal, and doing it before the
  // listeners are attached means that refusal leaves NOTHING wired up — no leaked
  // click/prefetch/popstate listener to undo without a `disable` handle.
  registerViewportLinks();

  doc.addEventListener("click", onClick);
  doc.addEventListener("pointerover", onPrefetchIntent);
  doc.addEventListener("focusin", onPrefetchIntent);
  popTarget.addEventListener("popstate", onPopState);

  // Seed the initial entry as a soft-nav entry carrying its scroll, so the FIRST
  // Back to it restores correctly rather than falling through to the browser.
  hist.replaceState(
    { lestoSoftNav: true, scroll: { x: win.scrollX, y: win.scrollY } },
    "",
    doc.URL,
  );

  const disable: DisableSoftNav = Object.assign(
    (): void => {
      doc.removeEventListener("click", onClick);
      doc.removeEventListener("pointerover", onPrefetchIntent);
      doc.removeEventListener("focusin", onPrefetchIntent);
      popTarget.removeEventListener("popstate", onPopState);

      // Stop watching for viewport prefetches and cancel every still-warming fetch,
      // so a teardown (a hot reload, a test) leaves no observer or in-flight request
      // dangling.
      viewportObserver?.disconnect();

      for (const { controller } of prefetches.values()) controller.abort();

      prefetches.clear();

      // Hand scroll restoration back to whatever it was on entry, so we leave no
      // trace (the field is required, so this is a clean unconditional restore).
      hist.scrollRestoration = priorScrollRestoration;
    },
    { isNavigating },
  );

  return disable;
}
