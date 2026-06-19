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
 * view-transition wrapper is a natural future caller of {@link SoftNavOptions.onSwap}.
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

import { hydrateDocumentIslands } from "./hydrate";
import type { HydrateOptions, HydrationResult } from "./hydrate";
import type { Registry } from "./registry";
import { eligibleAnchor, RELOAD_ATTR } from "./softnav-contract";
import type { SoftNavAnchor, SoftNavClick } from "./softnav-contract";

// Re-export the DOM-free contract through the runtime barrel, so a caller that
// reaches for the soft-nav surface sees one module — the constant and the click /
// anchor shapes that `<Link>` (isomorphic) and this runtime (browser) both read.
export { eligibleAnchor, RELOAD_ATTR } from "./softnav-contract";
export type { SoftNavAnchor, SoftNavClick } from "./softnav-contract";

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

/** The page fetcher — defaults to a same-origin `fetch` of the destination's HTML. */
export type PageFetcher = (url: string) => Promise<FetchedPage>;

/**
 * Swap the fetched document's body into the live one and return the new title.
 *
 * The default {@link domSwap} parses the HTML, replaces `document.body`'s contents
 * with the fetched body's, and returns the fetched `<title>`. A caller can inject
 * a finer swap (a single content region, a view-transition wrapper for Bet I)
 * without this module knowing how the page is structured.
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
   * Called when a soft navigation's fetch or swap throws. The DEFAULT recovers by
   * doing a real navigation to the destination (`assign`), so a soft-nav failure
   * degrades to exactly the full reload the link would have done with no JS —
   * never a dead link. Override to surface the error differently.
   */
  onError?: (error: unknown, url: string) => void;
}

/** Detach the soft-nav listeners. Idempotent — a second call is a harmless no-op. */
export type DisableSoftNav = () => void;

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
 * The default page fetch: a same-origin GET whose body is the page's HTML. The
 * resolved `response.url` rides back so a redirect lands the history entry on the
 * real destination, not the link's pre-redirect href.
 */
const defaultFetchPage: PageFetcher = async (url) => {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { accept: "text/html" },
  });

  // A non-ok page is still a page (a 404 has a body to show); we swap it like any
  // other rather than throw, so the user sees the server's error page, not a dead
  // click. A true network failure rejects and routes to `onError` → full nav.
  const html = await response.text();

  return { html, url: response.url === "" ? url : response.url };
};

/**
 * The default swap: parse the fetched HTML and replace the live `<body>`'s
 * children with the fetched body's, returning the fetched `<title>`.
 *
 * Replacing the body's CONTENTS (not the body element itself) keeps the live
 * `<body>` node — and any listeners delegated to it, this module's included —
 * attached across the swap. The head is intentionally left alone: the app's
 * client module and styles are already loaded, so re-running them would re-execute
 * the bundle; only the title (the one head element that is per-page and cheap) is
 * carried over.
 */
const defaultSwap: PageSwapper = (html, doc) => {
  const parsed = new DOMParser().parseFromString(html, "text/html");

  doc.body.replaceChildren(
    ...Array.from(parsed.body.childNodes).map((node) => doc.importNode(node, true)),
  );

  // `textContent` is "" when the fetched page has no <title>; treat that as "no
  // title to set" so we never blank the tab on a title-less page.
  const title = parsed.title;

  return title === "" ? undefined : title;
};

/**
 * Enable client-side soft navigation: upgrade eligible same-origin link clicks to
 * a fetch-and-swap, wire Back/Forward, and restore scroll — over the supplied
 * island `registry`, so a swapped-in page's islands hydrate with the same
 * components the initial load did.
 *
 * Returns a `disable()` that removes every listener and restores the browser's own
 * scroll restoration — so a test (or a hot reload) can tear the whole thing down
 * cleanly. Call it once, after the initial `hydrateDocumentIslands`:
 *
 *   hydrateDocumentIslands(registry);
 *   enableSoftNav(registry);
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

  // Perform the fetch → swap → re-hydrate → scroll for one navigation. `kind`
  // distinguishes a forward push (record where we came from, scroll to top) from a
  // Back/Forward pop (restore the saved scroll, do not push a new entry).
  const navigate = async (
    url: string,
    kind: SoftNavKind,
    restore?: ScrollPosition,
  ): Promise<void> => {
    try {
      const { html, url: landed } = await fetchPage(url);

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
      const hydration = rehydrate(registry, { root: doc });

      // Restore the saved scroll for a Back/Forward, else go to the top of the new
      // page — the browser's own behavior for a fresh navigation.
      if (restore !== undefined) {
        win.scrollTo(restore.x, restore.y);
      } else {
        win.scrollTo(0, 0);
      }

      options.onNavigate?.({ kind, url: landed, hydration });
    } catch (error) {
      onError(error, url);
    }
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

  // Back/Forward listens on the window (the document's `defaultView`); a test
  // injects a fake target so a synthetic `popstate` needs no real history move.
  const popTarget: PopStateTarget = options.popStateTarget ?? (doc.defaultView as PopStateTarget);

  doc.addEventListener("click", onClick);
  popTarget.addEventListener("popstate", onPopState);

  // Seed the initial entry as a soft-nav entry carrying its scroll, so the FIRST
  // Back to it restores correctly rather than falling through to the browser.
  hist.replaceState(
    { lestoSoftNav: true, scroll: { x: win.scrollX, y: win.scrollY } },
    "",
    doc.URL,
  );

  return () => {
    doc.removeEventListener("click", onClick);
    popTarget.removeEventListener("popstate", onPopState);

    // Hand scroll restoration back to whatever it was on entry, so we leave no
    // trace (the field is required, so this is a clean unconditional restore).
    hist.scrollRestoration = priorScrollRestoration;
  };
}
