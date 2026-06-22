// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Registry } from "../src/index";
import { enableSoftNav } from "../src/softnav";
import type {
  FetchedPage,
  PopStateTarget,
  SoftNavHistory,
  SoftNavOptions,
  SoftNavWindow,
} from "../src/softnav";
import type { HydrationResult } from "../src/hydrate";

/**
 * Soft nav is a browser state machine, but every platform seam it touches is
 * injectable — so the whole fetch → swap → re-hydrate → history → scroll dance is
 * driven here under fakes, with a few jsdom-backed cases proving the REAL defaults
 * (the `fetch`/`DOMParser`/`document`/`history` fallbacks) on top.
 */

// ---------------------------------------------------------------------------
// A fake harness: capture the click + popstate listeners `enableSoftNav` wires,
// so a test fires synthetic events at them with no real DOM dispatch, and record
// every history / scroll / hydrate call for assertions.
// ---------------------------------------------------------------------------

interface ClickOptions {
  href?: string;
  target?: string;
  download?: boolean;
  reload?: boolean;
  button?: number;
  metaKey?: boolean;
  preventDefault?: () => void;
}

interface Harness {
  options: SoftNavOptions;
  fireClick: (click?: ClickOptions) => void;
  fireRawClick: (event: {
    target: EventTarget | null;
    button?: number;
    preventDefault?: () => void;
  }) => void;
  firePopState: (state: unknown) => void;
  hist: SoftNavHistory & {
    pushed: Array<{ state: unknown; url: string }>;
    replaced: Array<{ state: unknown; url: string }>;
  };
  win: SoftNavWindow & { scrolledTo: Array<[number, number]> };
  rehydrateCalls: Array<{ root: unknown }>;
  navigated: string[];
  body: HTMLElement;
  disable: () => void;
}

const HYDRATION: HydrationResult = { mounted: [], missing: [], failed: [], deferred: [] };

/**
 * Build the `MouseEvent`-shaped object the real `onClick` reads — with a REAL
 * jsdom `<a>` as the target, so the runtime's own `resolveAnchor` (closest-anchor
 * walk) runs, not a stubbed `anchor()`. A `preventDefault` spy rides along.
 */
function clickEvent(over: ClickOptions = {}): Event & { preventDefault: ReturnType<typeof vi.fn> } {
  const anchor = document.createElement("a");
  anchor.href = over.href ?? "https://app.test/next";

  if (over.target !== undefined) anchor.target = over.target;
  if (over.download === true) anchor.setAttribute("download", "");
  if (over.reload === true) anchor.setAttribute("data-lesto-reload", "");

  const inner = document.createElement("span");
  anchor.append(inner);

  return {
    button: over.button ?? 0,
    metaKey: over.metaKey ?? false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    target: inner,
    preventDefault: over.preventDefault ?? vi.fn(),
  } as unknown as Event & { preventDefault: ReturnType<typeof vi.fn> };
}

function harness(extra: SoftNavOptions = {}): Harness {
  let clickListener: ((event: Event) => void) | undefined;
  let popListener: ((event: Event) => void) | undefined;

  // A real jsdom document backs the DOM-builder surface (body / createElement /
  // getElementById / querySelector / focus) the post-swap a11y step touches, while
  // the listener capture + history/location stay stubbed — so the focus + live
  // region work runs against real nodes with no real page navigation.
  const real = document.implementation.createHTMLDocument("");
  real.body.innerHTML = "<main><h1>Page</h1></main>";

  const doc = {
    URL: "https://app.test/",
    get body() {
      return real.body;
    },
    get documentElement() {
      return real.documentElement;
    },
    title: "",
    createElement: (tag: string) => real.createElement(tag),
    getElementById: (id: string) => real.getElementById(id),
    querySelector: (sel: string) => real.querySelector(sel),
    importNode: (node: Node, deep: boolean) => real.importNode(node, deep),
    addEventListener: (type: string, listener: (event: Event) => void) => {
      if (type === "click") clickListener = listener;
    },
    removeEventListener: vi.fn(),
    location: { assign: vi.fn() },
  } as unknown as Document;

  const hist = {
    state: null as unknown,
    scrollRestoration: "auto",
    pushed: [] as Array<{ state: unknown; url: string }>,
    replaced: [] as Array<{ state: unknown; url: string }>,
    pushState(state: unknown, _t: string, url: string) {
      this.pushed.push({ state, url });
    },
    replaceState(state: unknown, _t: string, url: string) {
      this.state = state;
      this.replaced.push({ state, url });
    },
  };

  const win = {
    scrollX: 11,
    scrollY: 22,
    scrolledTo: [] as Array<[number, number]>,
    scrollTo(x: number, y: number) {
      this.scrolledTo.push([x, y]);
    },
  };

  const popTarget: PopStateTarget = {
    addEventListener: (_type, listener) => {
      popListener = listener;
    },
    removeEventListener: vi.fn(),
  };

  const navigated: string[] = [];
  const rehydrateCalls: Array<{ root: unknown }> = [];

  const options: SoftNavOptions = {
    document: doc,
    history: hist,
    window: win,
    popStateTarget: popTarget,
    fetchPage: async (url): Promise<FetchedPage> => {
      navigated.push(url);
      return { html: "<title>Next</title><p>next</p>", url };
    },
    swap: (html) => (html.includes("<title>") ? "Next" : undefined),
    rehydrate: (_registry, opts) => {
      rehydrateCalls.push({ root: opts.root });
      return HYDRATION;
    },
    ...extra,
  };

  const disable = enableSoftNav(new Registry(), options);

  return {
    options,
    fireClick: (over = {}) => clickListener?.(clickEvent(over)),
    // A plain primary click (so eligibility proceeds to anchor resolution) whose
    // only variable is the raw `target` — to drive resolveAnchor's non-anchor and
    // non-element branches with no enclosing `<a href>`.
    fireRawClick: (event) =>
      clickListener?.({
        button: event.button ?? 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        defaultPrevented: false,
        target: event.target,
        preventDefault: event.preventDefault ?? vi.fn(),
      } as unknown as Event),
    firePopState: (state) => popListener?.({ state } as unknown as Event),
    hist,
    win,
    rehydrateCalls,
    navigated,
    body: real.body,
    disable,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("enableSoftNav — wiring", () => {
  it("sets manual scroll restoration and seeds the initial entry", () => {
    const h = harness();

    expect(h.hist.scrollRestoration).toBe("manual");
    // The initial entry is replaced with a soft-nav marker carrying the live scroll.
    expect(h.hist.replaced).toHaveLength(1);
    expect(h.hist.replaced[0]?.state).toMatchObject({
      lestoSoftNav: true,
      scroll: { x: 11, y: 22 },
    });
  });
});

describe("enableSoftNav — a click soft-navigates", () => {
  it("prevents the default, records scroll, fetches, swaps, pushes, re-hydrates, scrolls to top", async () => {
    const h = harness();
    const preventDefault = vi.fn();

    h.fireClick({ preventDefault });
    await vi.waitFor(() => expect(h.navigated).toContain("https://app.test/next"));

    expect(preventDefault).toHaveBeenCalled();
    // recordScroll stamped the current entry before leaving (the 2nd replaceState).
    expect(h.hist.replaced.length).toBeGreaterThanOrEqual(2);
    // A forward push records the new entry.
    expect(h.hist.pushed).toEqual([
      { state: { lestoSoftNav: true, scroll: { x: 0, y: 0 } }, url: "https://app.test/next" },
    ]);
    // Re-hydrated against the swapped document.
    expect(h.rehydrateCalls).toEqual([{ root: h.options.document }]);
    // A forward nav scrolls to the top of the new page.
    expect(h.win.scrolledTo).toContainEqual([0, 0]);
  });

  it("sets the document title from the swap's returned title", async () => {
    const h = harness();

    h.fireClick({});
    await vi.waitFor(() => expect(h.navigated.length).toBe(1));

    expect((h.options.document as Document).title).toBe("Next");
  });

  it("leaves the title untouched when the swap returns none", async () => {
    const h = harness({ swap: () => undefined });
    const before = (h.options.document as Document).title;

    h.fireClick({});
    await vi.waitFor(() => expect(h.navigated.length).toBe(1));

    expect((h.options.document as Document).title).toBe(before);
  });

  it("calls onNavigate with the push event after a successful swap", async () => {
    const onNavigate = vi.fn();
    const h = harness({ onNavigate });

    h.fireClick({});
    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalled());

    expect(onNavigate).toHaveBeenCalledWith({
      kind: "push",
      url: "https://app.test/next",
      hydration: HYDRATION,
    });
  });
});

describe("enableSoftNav — a click it must not steal", () => {
  it("ignores an ineligible click (a modified click)", () => {
    const h = harness();

    h.fireClick({ metaKey: true });

    expect(h.navigated).toEqual([]);
    expect(h.hist.pushed).toEqual([]);
  });

  it("ignores a cross-origin link — that is a real navigation", () => {
    const h = harness();
    const preventDefault = vi.fn();

    h.fireClick({ href: "https://other.test/x", preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(h.navigated).toEqual([]);
  });

  it("ignores a click on non-anchor chrome (no enclosing <a>)", () => {
    const h = harness();

    h.fireRawClick({ target: document.createElement("div") });

    expect(h.navigated).toEqual([]);
  });

  it("ignores a click whose target is not an element (e.g. the document)", () => {
    const h = harness();

    h.fireRawClick({ target: null });

    expect(h.navigated).toEqual([]);
  });

  it("declines an opted-out (reload) link", () => {
    const h = harness();
    const preventDefault = vi.fn();

    h.fireClick({ reload: true, preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(h.navigated).toEqual([]);
  });

  it("declines an anchor element with no href", () => {
    const h = harness();
    // A bare `<a>` with no href is not a navigation target — closest("a[href]") skips it.
    const bare = document.createElement("a");

    h.fireRawClick({ target: bare });

    expect(h.navigated).toEqual([]);
  });

  it("ignores a same-document hash link — the browser owns the in-page jump", () => {
    // The page is at `https://app.test/`; clicking `/#section` differs only by hash,
    // so soft nav must NOT take it over (no preventDefault, no fetch, no pushState) —
    // letting the browser do its native in-page scroll.
    const h = harness();
    const preventDefault = vi.fn();

    h.fireClick({ href: "https://app.test/#section", preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(h.navigated).toEqual([]);
    expect(h.hist.pushed).toEqual([]);
  });

  it("still soft-navigates a normal cross-path link (regression guard)", async () => {
    // A link to a DIFFERENT pathname is a genuine navigation soft nav owns — proving
    // the same-document gate above is scoped to pathname+search, not blanket.
    const h = harness();
    const preventDefault = vi.fn();

    h.fireClick({ href: "https://app.test/elsewhere", preventDefault });
    await vi.waitFor(() => expect(h.navigated).toContain("https://app.test/elsewhere"));

    expect(preventDefault).toHaveBeenCalled();
    expect(h.hist.pushed).toHaveLength(1);
  });
});

describe("enableSoftNav — recordScroll merges existing state", () => {
  it("preserves a prior history.state's keys when stamping scroll", async () => {
    const h = harness();
    // Pretend the entry already carried extra state the framework set.
    h.hist.state = { custom: "keep" };

    h.fireClick({});
    await vi.waitFor(() => expect(h.navigated.length).toBe(1));

    const stamped = h.hist.replaced.at(-1)?.state as Record<string, unknown>;
    expect(stamped["custom"]).toBe("keep");
    expect(stamped["lestoSoftNav"]).toBe(true);
  });

  it("starts from an empty object when history.state is null", async () => {
    // A history whose `replaceState` does NOT persist state — so `hist.state` stays
    // null at recordScroll time, exercising the `?? {}` default seed (the entry was
    // never a soft-nav entry before this navigation).
    const replaced: Array<Record<string, unknown>> = [];
    const hist: SoftNavHistory = {
      state: null,
      scrollRestoration: "auto",
      pushState: () => {},
      replaceState: (state) => {
        replaced.push(state as Record<string, unknown>);
      },
    };

    const real = document.implementation.createHTMLDocument("");

    let clickListener: ((event: Event) => void) | undefined;
    const doc = {
      URL: "https://app.test/",
      get body() {
        return real.body;
      },
      title: "",
      createElement: (tag: string) => real.createElement(tag),
      getElementById: (id: string) => real.getElementById(id),
      querySelector: (sel: string) => real.querySelector(sel),
      addEventListener: (type: string, l: (event: Event) => void) => {
        if (type === "click") clickListener = l;
      },
      removeEventListener: () => {},
      location: { assign: () => {} },
    } as unknown as Document;

    enableSoftNav(new Registry(), {
      document: doc,
      history: hist,
      window: { scrollX: 0, scrollY: 0, scrollTo: () => {} },
      popStateTarget: { addEventListener: () => {}, removeEventListener: () => {} },
      fetchPage: async (url) => ({ html: "<p>x</p>", url }),
      swap: () => undefined,
      rehydrate: () => HYDRATION,
    });

    clickListener?.(clickEvent());
    await vi.waitFor(() => expect(replaced.length).toBeGreaterThanOrEqual(2));

    // The recordScroll entry seeded `{}` then stamped the soft-nav marker onto it.
    expect(replaced.at(-1)).toMatchObject({ lestoSoftNav: true });
  });
});

describe("enableSoftNav — Back/Forward (popstate)", () => {
  it("replays a soft-nav entry, restoring its saved scroll without pushing", async () => {
    const h = harness();

    h.firePopState({ lestoSoftNav: true, scroll: { x: 5, y: 99 } });
    await vi.waitFor(() => expect(h.navigated).toContain("https://app.test/"));

    // A pop never pushes a new entry.
    expect(h.hist.pushed).toEqual([]);
    expect(h.win.scrolledTo).toContainEqual([5, 99]);
  });

  it("defaults a soft-nav entry with no saved scroll to the top", async () => {
    const h = harness();

    h.firePopState({ lestoSoftNav: true });
    await vi.waitFor(() => expect(h.navigated.length).toBe(1));

    expect(h.win.scrolledTo).toContainEqual([0, 0]);
  });

  it("ignores a pop to a null-state entry (a real prior document)", () => {
    const h = harness();

    h.firePopState(null);

    expect(h.navigated).toEqual([]);
  });

  it("ignores a pop to a non-soft-nav entry", () => {
    const h = harness();

    h.firePopState({ some: "other" });

    expect(h.navigated).toEqual([]);
  });
});

describe("enableSoftNav — last-click-wins (stale-response race)", () => {
  it("a slow first nav that resolves LAST does not clobber the faster newer one", async () => {
    // Two clicks overlap: A is slow, B is fast. We resolve B first (it swaps +
    // pushes), THEN resolve A. A captured an older generation token, so its late
    // resolution must bail — leaving the body/URL/history on B, with no spurious
    // intermediate "/a" entry. This is last-CLICK-wins, not last-fetch-wins.
    const deferreds = new Map<string, (page: FetchedPage) => void>();
    const aborted: string[] = [];

    const h = harness({
      fetchPage: (url, signal) =>
        new Promise<FetchedPage>((resolve) => {
          signal.addEventListener("abort", () => aborted.push(url));
          deferreds.set(url, resolve);
        }),
      swap: () => undefined,
    });

    h.fireClick({ href: "https://app.test/a" });
    h.fireClick({ href: "https://app.test/b" });

    // Starting B aborted A's in-flight fetch.
    expect(aborted).toEqual(["https://app.test/a"]);

    // B resolves first and lands.
    deferreds.get("https://app.test/b")?.({ html: "", url: "https://app.test/b" });
    await vi.waitFor(() => expect(h.hist.pushed.length).toBe(1));

    // Now the slow A resolves LAST — it must be dropped, not clobber B.
    deferreds.get("https://app.test/a")?.({ html: "", url: "https://app.test/a" });
    await Promise.resolve();
    await Promise.resolve();

    // Exactly one push, to B — A left no body swap, no history entry, no scroll.
    expect(h.hist.pushed).toEqual([
      { state: { lestoSoftNav: true, scroll: { x: 0, y: 0 } }, url: "https://app.test/b" },
    ]);
    expect(h.rehydrateCalls).toHaveLength(1);
  });

  it("swallows a superseded fetch's REJECTION instead of firing onError", async () => {
    // A is superseded by B, then A's fetch REJECTS (an aborted fetch rejects with
    // an AbortError). Because A is no longer the current generation, that rejection
    // must be swallowed — NOT routed to onError, which would do a spurious full
    // navigation that fights B's swap.
    const rejects = new Map<string, (error: unknown) => void>();
    const onError = vi.fn();

    const h = harness({
      fetchPage: (url) =>
        url === "https://app.test/b"
          ? Promise.resolve({ html: "", url })
          : new Promise<FetchedPage>((_resolve, reject) => rejects.set(url, reject)),
      onError,
      swap: () => undefined,
    });

    h.fireClick({ href: "https://app.test/a" });
    h.fireClick({ href: "https://app.test/b" });

    // B lands.
    await vi.waitFor(() => expect(h.hist.pushed.length).toBe(1));

    // The superseded A now rejects (as an aborted fetch would) — swallowed.
    rejects.get("https://app.test/a")?.(new Error("aborted"));
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
    expect((h.options.document as Document).location.assign).not.toHaveBeenCalled();
  });

  it("a Back/Forward pop supersedes an in-flight forward nav", async () => {
    const deferreds = new Map<string, (page: FetchedPage) => void>();
    const aborted: string[] = [];

    const h = harness({
      fetchPage: (url, signal) =>
        new Promise<FetchedPage>((resolve) => {
          signal.addEventListener("abort", () => aborted.push(url));
          deferreds.set(url, resolve);
        }),
      swap: () => undefined,
    });

    // A forward click starts, then a pop arrives before the fetch resolves.
    h.fireClick({ href: "https://app.test/forward" });
    h.firePopState({ lestoSoftNav: true, scroll: { x: 0, y: 7 } });

    // The pop aborted the in-flight forward fetch.
    expect(aborted).toEqual(["https://app.test/forward"]);

    // The pop resolves and replays (restoring its scroll, no push).
    deferreds.get("https://app.test/")?.({ html: "", url: "https://app.test/" });
    await vi.waitFor(() => expect(h.win.scrolledTo).toContainEqual([0, 7]));

    // The stale forward then resolves LAST — dropped, so no forward push survives.
    deferreds.get("https://app.test/forward")?.({ html: "", url: "https://app.test/forward" });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.hist.pushed).toEqual([]);
  });
});

describe("enableSoftNav — cross-origin redirect falls back to a full navigation", () => {
  it("does NOT swap a foreign body when a same-origin link redirects cross-origin", async () => {
    // The clicked link is same-origin (so the click is taken over), but the fetch
    // LANDS on another origin after a redirect. Swapping that foreign HTML into our
    // live DOM would be a same-origin-DOM injection — so we must fall back to a real
    // navigation instead, swapping nothing.
    const h = harness({
      fetchPage: async (): Promise<FetchedPage> => ({
        html: "<title>Evil</title><p>evil</p>",
        url: "https://evil.test/landed",
      }),
    });

    h.fireClick({ href: "https://app.test/redirector" });

    await vi.waitFor(() =>
      expect((h.options.document as Document).location.assign).toHaveBeenCalledWith(
        "https://evil.test/landed",
      ),
    );

    // No swap, no history push, no re-hydrate — the cross-origin body never touched
    // our DOM.
    expect(h.hist.pushed).toEqual([]);
    expect(h.rehydrateCalls).toEqual([]);
  });
});

describe("enableSoftNav — a11y: focus + route announcement on swap", () => {
  it("announces the new title in a live region and moves focus to the main landmark", async () => {
    const h = harness();

    h.fireClick({});
    await vi.waitFor(() => expect(h.navigated.length).toBe(1));

    // A polite live region carries the new title so screen readers announce it. It
    // lives on `<html>` (not in the body, which a real swap would wipe), so it is
    // found via the document, not a body query.
    const announcer = (h.options.document as Document).getElementById("lesto-route-announcer");
    expect(announcer?.getAttribute("aria-live")).toBe("polite");
    expect(announcer?.getAttribute("role")).toBe("status");
    expect(announcer?.textContent).toBe("Next");
    expect(h.body.contains(announcer)).toBe(false);

    // Focus moved off any detached node to the new page's main landmark, which got
    // a transient tabindex so a non-interactive element can hold focus.
    const main = h.body.querySelector("main");
    expect(main?.getAttribute("tabindex")).toBe("-1");
  });

  it("the announcer survives a REAL body swap and the same node is reused", async () => {
    // A swap that mirrors the real `defaultSwap`: it `replaceChildren`s the body, so
    // a body-resident announcer would be DELETED on the next nav. The announcer must
    // instead live on `<html>` (a sibling of `<body>`) — so it survives the swap, the
    // SAME node is reused across two navigations, its text updates, and it is never a
    // child of the (wiped) body.
    const onNavigate = vi.fn();
    const h = harness({
      onNavigate,
      swap: (html, swapDoc) => {
        swapDoc.body.replaceChildren(swapDoc.createElement("main"));
        return html.includes("Two") ? "Two" : "One";
      },
      fetchPage: async (url) => ({
        html: url.endsWith("/two") ? "<title>Two</title>" : "<title>One</title>",
        url,
      }),
    });

    h.fireClick({ href: "https://app.test/one" });
    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));

    const doc = h.options.document as Document;
    const firstNode = doc.getElementById("lesto-route-announcer");
    expect(firstNode).not.toBeNull();
    expect(firstNode?.textContent).toBe("One");
    // It lives on <html>, NOT in the body the swap wiped.
    expect(h.body.contains(firstNode)).toBe(false);

    h.fireClick({ href: "https://app.test/two" });
    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(2));

    const secondNode = doc.getElementById("lesto-route-announcer");
    // The body swap did not remove or recreate it: same node, updated text.
    expect(secondNode).toBe(firstNode);
    expect(secondNode?.textContent).toBe("Two");
    expect(h.body.contains(secondNode)).toBe(false);
  });
});

describe("enableSoftNav — failure degrades to a real navigation", () => {
  it("routes a fetch rejection to the injected onError", async () => {
    const onError = vi.fn();
    const boom = new Error("offline");
    const h = harness({
      fetchPage: () => Promise.reject(boom),
      onError,
    });

    h.fireClick({});
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());

    expect(onError).toHaveBeenCalledWith(boom, "https://app.test/next");
  });

  it("the DEFAULT onError does a full navigation to the destination", async () => {
    const h = harness({ fetchPage: () => Promise.reject(new Error("x")) });

    h.fireClick({});
    await vi.waitFor(() =>
      expect((h.options.document as Document).location.assign).toHaveBeenCalledWith(
        "https://app.test/next",
      ),
    );
  });
});

describe("enableSoftNav — disable", () => {
  it("removes both listeners and restores prior scroll restoration", () => {
    const h = harness();

    h.disable();

    expect((h.options.document as Document).removeEventListener).toHaveBeenCalled();
    expect((h.options.popStateTarget as PopStateTarget).removeEventListener).toHaveBeenCalled();
    expect(h.hist.scrollRestoration).toBe("auto");
  });

  it("hands the entry-time scroll restoration back on disable", () => {
    const hist: SoftNavHistory = {
      state: null,
      scrollRestoration: "auto",
      pushState: () => {},
      replaceState: () => {},
    };

    const disable = enableSoftNav(new Registry(), {
      document: {
        URL: "https://app.test/",
        addEventListener: () => {},
        removeEventListener: () => {},
      } as unknown as Document,
      history: hist,
      window: { scrollX: 0, scrollY: 0, scrollTo: () => {} },
      popStateTarget: { addEventListener: () => {}, removeEventListener: () => {} },
    });

    // Flipped to manual for the session...
    expect(hist.scrollRestoration).toBe("manual");

    disable();

    // ...and restored to the entry-time value on teardown.
    expect(hist.scrollRestoration).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// The real defaults, under jsdom — proving the `fetch`/`DOMParser` fallbacks and
// the ambient `document`/`history`/`window` seams actually work.
// ---------------------------------------------------------------------------

describe("enableSoftNav — default seams (jsdom)", () => {
  beforeEach(() => {
    // jsdom has no real `window.scrollTo`; the default scroll seam calls it after a
    // swap, so stub it (a no-op) to exercise the real defaults without the throw.
    vi.stubGlobal("scrollTo", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("defaults popTarget to the document's defaultView and swaps via the real DOMParser", async () => {
    const fetchMock = vi.fn(async () => ({
      text: async () => "<html><head><title>Loaded</title></head><body><p>loaded</p></body></html>",
      url: "http://localhost:3000/loaded",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const onNavigate = vi.fn();

    // Default document/history/window/popStateTarget/fetchPage/swap/rehydrate.
    const disable = enableSoftNav(new Registry(), { onNavigate });

    // A real anchor click: jsdom dispatches a genuine MouseEvent that bubbles to
    // the document listener, with the anchor as the event target — so the runtime's
    // own resolveAnchor walk and the default DOMParser swap both run for real. The
    // href is RELATIVE so the DOM resolves it against the page origin (same-origin),
    // the gate the runtime enforces before taking a click over.
    const anchor = document.createElement("a");
    anchor.href = "/loaded";
    anchor.textContent = "Go";
    document.body.append(anchor);

    anchor.click();

    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalled());

    // The real default swap replaced the body's contents and set the title.
    expect(document.body.textContent).toContain("loaded");
    expect(document.title).toBe("Loaded");
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:3000/loaded", {
      credentials: "same-origin",
      headers: { accept: "text/html" },
      signal: expect.any(AbortSignal),
    });
    // The real default a11y step announces the new title and focuses the page top
    // (no <main>/<h1> in the swapped-in markup → the body fallback, focused).
    expect(document.getElementById("lesto-route-announcer")?.textContent).toBe("Loaded");
    expect(document.activeElement).toBe(document.body);

    disable();
  });

  it("the default fetch keeps the requested url when the response reports none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ text: async () => "<body></body>", url: "" })),
    );

    const onNavigate = vi.fn();
    const disable = enableSoftNav(new Registry(), { onNavigate });

    const anchor = document.createElement("a");
    anchor.href = "/same";
    anchor.textContent = "Go";
    document.body.append(anchor);

    anchor.click();

    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalled());

    // A title-less page leaves the document title untouched and lands on the
    // requested url (response.url was "" → the DOM-resolved requested href).
    expect(onNavigate.mock.calls[0]?.[0]).toMatchObject({ url: "http://localhost:3000/same" });

    disable();
  });
});

// ---------------------------------------------------------------------------
// Prefetch, the pending-nav signal, and the layout-preserving partial swap —
// the Workstream-8 client-nav UX additions. These drive the AMBIENT jsdom
// document (real body / closest / querySelectorAll / event dispatch), with the
// platform-edge seams (fetch, IntersectionObserver, history, scroll) injected.
// ---------------------------------------------------------------------------

/** A fake IntersectionObserver whose callback a test fires with synthetic entries. */
class FakeIO {
  observed: Element[] = [];
  unobserved: Element[] = [];
  disconnected = false;
  constructor(public callback: (entries: IntersectionObserverEntry[]) => void) {}
  observe(target: Element): void {
    this.observed.push(target);
  }
  unobserve(target: Element): void {
    this.unobserved.push(target);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  /** Fire the observer's callback for a target, marking it intersecting (or not). */
  fire(target: Element, isIntersecting = true): void {
    this.callback([{ target, isIntersecting } as unknown as IntersectionObserverEntry]);
  }
}

/** A no-op history/window/popTarget bundle for the ambient-document prefetch tests. */
function inertSeams(): Pick<SoftNavOptions, "history" | "window" | "popStateTarget"> {
  return {
    history: {
      state: null,
      scrollRestoration: "auto",
      pushState: () => {},
      replaceState: () => {},
    },
    window: { scrollX: 0, scrollY: 0, scrollTo: () => {} },
    popStateTarget: { addEventListener: () => {}, removeEventListener: () => {} },
  };
}

/**
 * Enable soft nav on the ambient document but CAPTURE its click listener, so a test
 * can fire a synthetic click through it without a real anchor `.click()` (which jsdom
 * would try — and noisily fail — to natively navigate). Returns `disable` plus a
 * `click(anchor)` that drives the captured listener with the anchor as the target.
 */
function enableWithCapturedClick(options: SoftNavOptions): {
  disable: ReturnType<typeof enableSoftNav>;
  click: (anchor: Element) => void;
} {
  let clickListener: ((event: Event) => void) | undefined;
  const realAdd = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation(((type: string, l: EventListener) => {
    if (type === "click") clickListener = l as (event: Event) => void;
    else realAdd(type, l);
  }) as typeof document.addEventListener);

  const disable = enableSoftNav(new Registry(), options);

  // Hand the OTHER listeners (pointerover/focusin) back to the real document so
  // prefetch-intent dispatch still works; only the click was diverted to capture.
  vi.restoreAllMocks();

  return {
    disable,
    click: (anchor: Element) => {
      clickListener?.({
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        defaultPrevented: false,
        target: anchor,
        preventDefault: () => {},
      } as unknown as Event);
    },
  };
}

describe("enableSoftNav — prefetch (hover)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("warms the fetch on pointerover of a hover-prefetch link", async () => {
    const fetched: string[] = [];
    const anchor = document.createElement("a");
    anchor.href = "/dest";
    anchor.setAttribute("data-lesto-prefetch", "hover");
    anchor.append(document.createElement("span"));
    document.body.append(anchor);

    const disable = enableSoftNav(new Registry(), {
      ...inertSeams(),
      fetchPage: async (url) => {
        fetched.push(url);
        return { html: "", url };
      },
    });

    // Pointer enters a CHILD of the link — the closest-anchor walk still finds it.
    anchor.firstChild?.dispatchEvent(new Event("pointerover", { bubbles: true }));

    await vi.waitFor(() => expect(fetched).toEqual([`${location.origin}/dest`]));

    disable();
  });

  it("warms the fetch on focusin of a hover-prefetch link", async () => {
    const fetched: string[] = [];
    const anchor = document.createElement("a");
    anchor.href = "/focusdest";
    anchor.setAttribute("data-lesto-prefetch", "hover");
    document.body.append(anchor);

    const disable = enableSoftNav(new Registry(), {
      ...inertSeams(),
      fetchPage: async (url) => {
        fetched.push(url);
        return { html: "", url };
      },
    });

    anchor.dispatchEvent(new Event("focusin", { bubbles: true }));

    await vi.waitFor(() => expect(fetched).toEqual([`${location.origin}/focusdest`]));

    disable();
  });

  it("does NOT warm a link with no prefetch marker, or a viewport-strategy link, on hover", () => {
    const fetched: string[] = [];
    const plain = document.createElement("a");
    plain.href = "/plain";
    const viewport = document.createElement("a");
    viewport.href = "/vp";
    viewport.setAttribute("data-lesto-prefetch", "viewport");
    document.body.append(plain, viewport);

    const disable = enableSoftNav(new Registry(), {
      ...inertSeams(),
      intersectionObserver: (cb) => new FakeIO(cb),
      fetchPage: async (url) => {
        fetched.push(url);
        return { html: "", url };
      },
    });

    plain.dispatchEvent(new Event("pointerover", { bubbles: true }));
    // A viewport link's HOVER must not warm — it warms on intersection, not hover.
    viewport.dispatchEvent(new Event("pointerover", { bubbles: true }));

    expect(fetched).toEqual([]);

    disable();
  });

  it("ignores a pointerover on non-anchor chrome", () => {
    const fetched: string[] = [];
    const div = document.createElement("div");
    document.body.append(div);

    const disable = enableSoftNav(new Registry(), {
      ...inertSeams(),
      fetchPage: async (url) => {
        fetched.push(url);
        return { html: "", url };
      },
    });

    div.dispatchEvent(new Event("pointerover", { bubbles: true }));

    expect(fetched).toEqual([]);

    disable();
  });

  it("ignores a prefetch-intent event whose target is not an element", () => {
    const fetched: string[] = [];
    // Capture the delegated intent listener so we can fire it with a non-element
    // target (the document itself, which a real pointerover never carries as target
    // under a link, but the guard must still hold).
    let intentListener: ((event: Event) => void) | undefined;
    const realAdd = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation(((type: string, l: EventListener) => {
      if (type === "pointerover") intentListener = l as (event: Event) => void;
      else realAdd(type, l);
    }) as typeof document.addEventListener);

    const disable = enableSoftNav(new Registry(), {
      ...inertSeams(),
      fetchPage: async (url) => {
        fetched.push(url);
        return { html: "", url };
      },
    });

    vi.restoreAllMocks();

    intentListener?.({ target: null } as unknown as Event);

    expect(fetched).toEqual([]);

    disable();
  });

  it("dedupes — a second hover does not start a second fetch", async () => {
    const fetched: string[] = [];
    const anchor = document.createElement("a");
    anchor.href = "/once";
    anchor.setAttribute("data-lesto-prefetch", "hover");
    document.body.append(anchor);

    const disable = enableSoftNav(new Registry(), {
      ...inertSeams(),
      fetchPage: async (url) => {
        fetched.push(url);
        return { html: "", url };
      },
    });

    anchor.dispatchEvent(new Event("pointerover", { bubbles: true }));
    anchor.dispatchEvent(new Event("pointerover", { bubbles: true }));

    await vi.waitFor(() => expect(fetched.length).toBe(1));

    disable();
  });
});

describe("enableSoftNav — prefetch (skip rules)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const enableWith = (fetched: string[]) =>
    enableSoftNav(new Registry(), {
      ...inertSeams(),
      fetchPage: async (url) => {
        fetched.push(url);
        return { html: "", url };
      },
    });

  it("does not warm a cross-origin link", () => {
    const fetched: string[] = [];
    const anchor = document.createElement("a");
    anchor.href = "https://other.test/x";
    anchor.setAttribute("data-lesto-prefetch", "hover");
    document.body.append(anchor);

    const disable = enableWith(fetched);
    anchor.dispatchEvent(new Event("pointerover", { bubbles: true }));

    expect(fetched).toEqual([]);
    disable();
  });

  it("does not warm a link to the current page (same path+search)", () => {
    const fetched: string[] = [];
    const anchor = document.createElement("a");
    // The ambient page is the origin root; a link back to it is the current page.
    anchor.href = location.href;
    anchor.setAttribute("data-lesto-prefetch", "hover");
    document.body.append(anchor);

    const disable = enableWith(fetched);
    anchor.dispatchEvent(new Event("pointerover", { bubbles: true }));

    expect(fetched).toEqual([]);
    disable();
  });
});

describe("enableSoftNav — prefetch (viewport)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("warms a viewport-prefetch link when it scrolls into view, then unobserves it", async () => {
    const fetched: string[] = [];
    const anchor = document.createElement("a");
    anchor.href = "/vp";
    anchor.setAttribute("data-lesto-prefetch", "viewport");
    document.body.append(anchor);

    let io: FakeIO | undefined;
    const disable = enableSoftNav(new Registry(), {
      ...inertSeams(),
      intersectionObserver: (cb) => (io = new FakeIO(cb)),
      fetchPage: async (url) => {
        fetched.push(url);
        return { html: "", url };
      },
    });

    // Registered on enable, not yet warmed (nothing has scrolled into view).
    expect(io?.observed).toEqual([anchor]);
    expect(fetched).toEqual([]);

    io?.fire(anchor, true);

    await vi.waitFor(() => expect(fetched).toEqual([`${location.origin}/vp`]));
    // A single warm per link: it is unobserved once it has fired.
    expect(io?.unobserved).toEqual([anchor]);

    disable();
  });

  it("reuses one observer across multiple viewport links", () => {
    const a = document.createElement("a");
    a.href = "/v-a";
    a.setAttribute("data-lesto-prefetch", "viewport");
    const b = document.createElement("a");
    b.href = "/v-b";
    b.setAttribute("data-lesto-prefetch", "viewport");
    document.body.append(a, b);

    let made = 0;
    let io: FakeIO | undefined;
    const disable = enableSoftNav(new Registry(), {
      ...inertSeams(),
      intersectionObserver: (cb) => {
        made += 1;
        return (io = new FakeIO(cb));
      },
      fetchPage: async (url) => ({ html: "", url }),
    });

    // Exactly one observer is created, and BOTH links are observed by it.
    expect(made).toBe(1);
    expect(io?.observed).toEqual([a, b]);

    disable();
    document.body.innerHTML = "";
  });

  it("ignores a non-intersecting entry (a link scrolling OUT of view)", () => {
    const fetched: string[] = [];
    const anchor = document.createElement("a");
    anchor.href = "/vp2";
    anchor.setAttribute("data-lesto-prefetch", "viewport");
    document.body.append(anchor);

    let io: FakeIO | undefined;
    const disable = enableSoftNav(new Registry(), {
      ...inertSeams(),
      intersectionObserver: (cb) => (io = new FakeIO(cb)),
      fetchPage: async (url) => {
        fetched.push(url);
        return { html: "", url };
      },
    });

    io?.fire(anchor, false);

    expect(fetched).toEqual([]);
    expect(io?.unobserved).toEqual([]);

    disable();
  });

  it("ignores an intersecting entry whose target is not an anchor", () => {
    const fetched: string[] = [];
    const anchor = document.createElement("a");
    anchor.href = "/vp3";
    anchor.setAttribute("data-lesto-prefetch", "viewport");
    document.body.append(anchor);

    let io: FakeIO | undefined;
    const disable = enableSoftNav(new Registry(), {
      ...inertSeams(),
      intersectionObserver: (cb) => (io = new FakeIO(cb)),
      fetchPage: async (url) => {
        fetched.push(url);
        return { html: "", url };
      },
    });

    // A non-anchor element intersecting — unobserved (single-shot) but never warmed.
    const div = document.createElement("div");
    io?.fire(div, true);

    expect(fetched).toEqual([]);
    expect(io?.unobserved).toEqual([div]);

    disable();
  });

  it("refuses viewport prefetch with a coded error when no IntersectionObserver exists", () => {
    const anchor = document.createElement("a");
    anchor.href = "/vp4";
    anchor.setAttribute("data-lesto-prefetch", "viewport");
    document.body.append(anchor);

    const original = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    // jsdom may or may not define it; force the "unsupported" branch.
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

    try {
      expect(() => enableSoftNav(new Registry(), inertSeams())).toThrowError(
        expect.objectContaining({ code: "UI_SOFTNAV_PREFETCH_UNSUPPORTED" }),
      );
    } finally {
      if (original !== undefined) {
        (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = original;
      }
      document.body.innerHTML = "";
    }
  });

  it("uses the real global IntersectionObserver when none is injected", () => {
    const anchor = document.createElement("a");
    anchor.href = "/vp5";
    anchor.setAttribute("data-lesto-prefetch", "viewport");
    document.body.append(anchor);

    const observed: Element[] = [];
    class RealIsh {
      constructor(public cb: unknown) {}
      observe(t: Element): void {
        observed.push(t);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("IntersectionObserver", RealIsh);

    // No `intersectionObserver` option → the real global constructor path runs.
    const disable = enableSoftNav(new Registry(), inertSeams());

    expect(observed).toEqual([anchor]);

    disable();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });
});

describe("enableSoftNav — prefetch consumed by the navigation", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("a navigation to a warmed url reuses the prefetch instead of re-fetching", async () => {
    const fetched: string[] = [];
    const anchor = document.createElement("a");
    anchor.href = "/warm";
    anchor.setAttribute("data-lesto-prefetch", "hover");
    document.body.append(anchor);

    const onNavigate = vi.fn();
    const { disable, click } = enableWithCapturedClick({
      ...inertSeams(),
      fetchPage: async (url) => {
        fetched.push(url);
        return { html: "<title>Warm</title>", url };
      },
      swap: () => "Warm",
      rehydrate: () => HYDRATION,
      onNavigate,
    });

    // Hover warms the fetch.
    anchor.dispatchEvent(new Event("pointerover", { bubbles: true }));
    await vi.waitFor(() => expect(fetched.length).toBe(1));

    // Now click it — the navigation consumes the warmed fetch (no second request).
    click(anchor);
    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalled());

    expect(fetched).toEqual([`${location.origin}/warm`]);

    disable();
  });

  it("a prefetch is single-use — a later nav to the same url re-fetches", async () => {
    const fetched: string[] = [];
    const anchor = document.createElement("a");
    anchor.href = "/reuse";
    anchor.setAttribute("data-lesto-prefetch", "hover");
    document.body.append(anchor);

    const onNavigate = vi.fn();
    const { disable, click } = enableWithCapturedClick({
      ...inertSeams(),
      fetchPage: async (url) => {
        fetched.push(url);
        return { html: "", url };
      },
      swap: () => undefined,
      rehydrate: () => HYDRATION,
      onNavigate,
    });

    anchor.dispatchEvent(new Event("pointerover", { bubbles: true }));
    await vi.waitFor(() => expect(fetched.length).toBe(1));

    click(anchor);
    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
    // The warmed fetch was consumed (still 1).
    expect(fetched.length).toBe(1);

    // A second click re-fetches — the prefetch was single-use.
    click(anchor);
    await vi.waitFor(() => expect(fetched.length).toBe(2));

    disable();
  });

  it("swallows a prefetch rejection (no unhandled rejection); the click consumes it via onError", async () => {
    const anchor = document.createElement("a");
    anchor.href = "/flaky";
    anchor.setAttribute("data-lesto-prefetch", "hover");
    document.body.append(anchor);

    const boom = new Error("prefetch offline");
    const onError = vi.fn();

    // The prefetch fetch rejects; we assert that rejection is swallowed (no
    // unhandled-rejection crash) and the click — consuming the same warmed promise —
    // routes it to onError. The captured-click helper avoids a real anchor nav.
    const { disable, click } = enableWithCapturedClick({
      ...inertSeams(),
      fetchPage: () => Promise.reject(boom),
      swap: () => undefined,
      rehydrate: () => HYDRATION,
      onError,
    });

    anchor.dispatchEvent(new Event("pointerover", { bubbles: true }));
    // Let the swallowed prefetch rejection settle without surfacing.
    await Promise.resolve();
    await Promise.resolve();

    click(anchor);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(boom, `${location.origin}/flaky`));

    disable();
  });

  it("teardown aborts a still-warming prefetch and disconnects the viewport observer", async () => {
    const aborted: string[] = [];
    const anchor = document.createElement("a");
    anchor.href = "/pending";
    anchor.setAttribute("data-lesto-prefetch", "viewport");
    document.body.append(anchor);

    let io: FakeIO | undefined;
    const disable = enableSoftNav(new Registry(), {
      ...inertSeams(),
      intersectionObserver: (cb) => (io = new FakeIO(cb)),
      fetchPage: (url, signal) =>
        new Promise<FetchedPage>(() => {
          signal.addEventListener("abort", () => aborted.push(url));
        }),
    });

    io?.fire(anchor, true);
    await Promise.resolve();

    disable();

    expect(aborted).toEqual([`${location.origin}/pending`]);
    expect(io?.disconnected).toBe(true);
  });

  it("re-registers viewport prefetch links brought in by a swap", async () => {
    const fetched: string[] = [];
    const link = document.createElement("a");
    link.href = "/first";
    link.setAttribute("data-lesto-prefetch", "hover");
    document.body.append(link);

    let io: FakeIO | undefined;
    const onNavigate = vi.fn();
    const { disable, click } = enableWithCapturedClick({
      ...inertSeams(),
      intersectionObserver: (cb) => (io = new FakeIO(cb)),
      // The swapped-in page carries a NEW viewport-prefetch link.
      swap: (_html, doc) => {
        const next = doc.createElement("a");
        next.href = "/second";
        next.setAttribute("data-lesto-prefetch", "viewport");
        doc.body.replaceChildren(next);
        return undefined;
      },
      fetchPage: async (url) => {
        fetched.push(url);
        return { html: "", url };
      },
      rehydrate: () => HYDRATION,
      onNavigate,
    });

    // No viewport links at enable → no observer created yet.
    expect(io).toBeUndefined();

    click(link);
    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalled());

    // After the swap, the new viewport link is registered with the observer.
    expect(io?.observed.some((el) => (el as HTMLAnchorElement).href.endsWith("/second"))).toBe(
      true,
    );

    disable();
  });
});

describe("enableSoftNav — pending-nav signal", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("fires onNavigateStart before the fetch and onNavigate after, and flips isNavigating", async () => {
    const events: string[] = [];
    const anchor = document.createElement("a");
    anchor.href = "/pend";
    document.body.append(anchor);

    let resolveFetch: ((page: FetchedPage) => void) | undefined;
    const onNavigate = vi.fn(() => events.push("navigate"));
    const { disable, click } = enableWithCapturedClick({
      ...inertSeams(),
      fetchPage: () =>
        new Promise<FetchedPage>((resolve) => {
          events.push("fetch");
          resolveFetch = resolve;
        }),
      swap: () => undefined,
      rehydrate: () => HYDRATION,
      onNavigateStart: (e) => events.push(`start:${e.kind}`),
      onNavigatingChange: (busy) => events.push(`busy:${busy}`),
      onNavigate,
    });

    // Subscribe immediately → the initial false value.
    const seen: boolean[] = [];
    disable.isNavigating.subscribe((b) => seen.push(b));
    expect(disable.isNavigating.get()).toBe(false);
    expect(seen).toEqual([false]);

    click(anchor);

    // Start fired before the fetch; the signal flipped true.
    await vi.waitFor(() => expect(events).toContain("fetch"));
    expect(events.indexOf("start:push")).toBeLessThan(events.indexOf("fetch"));
    expect(disable.isNavigating.get()).toBe(true);
    expect(seen).toEqual([false, true]);

    resolveFetch?.({ html: "", url: `${location.origin}/pend` });
    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalled());

    // Settled: the flag is back to false and onNavigate ran after start.
    expect(disable.isNavigating.get()).toBe(false);
    expect(seen).toEqual([false, true, false]);
    expect(events).toContain("busy:true");
    expect(events).toContain("busy:false");

    disable();
  });

  it("stays navigating until the LAST overlapping nav settles (count-based, not a bare flag)", async () => {
    const a = document.createElement("a");
    a.href = "/a";
    const b = document.createElement("a");
    b.href = "/b";
    document.body.append(a, b);

    const resolvers = new Map<string, () => void>();
    const { disable, click } = enableWithCapturedClick({
      ...inertSeams(),
      fetchPage: (url) =>
        new Promise<FetchedPage>((resolve) => {
          resolvers.set(url, () => resolve({ html: "", url }));
        }),
      swap: () => undefined,
      rehydrate: () => HYDRATION,
    });

    click(a);
    click(b);

    // Two navigations started; the signal is busy.
    expect(disable.isNavigating.get()).toBe(true);

    // The superseded A settles first (its token is stale → it returns, but still
    // runs its `finally`, decrementing the count to 1) — still busy.
    resolvers.get(`${location.origin}/a`)?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(disable.isNavigating.get()).toBe(true);

    // B (the current nav) settles → count hits 0 → no longer busy.
    resolvers.get(`${location.origin}/b`)?.();
    await vi.waitFor(() => expect(disable.isNavigating.get()).toBe(false));

    disable();
  });

  it("subscribe returns an unsubscribe that stops further notifications", async () => {
    const anchor = document.createElement("a");
    anchor.href = "/unsub";
    document.body.append(anchor);

    const { disable, click } = enableWithCapturedClick({
      ...inertSeams(),
      fetchPage: async (url) => ({ html: "", url }),
      swap: () => undefined,
      rehydrate: () => HYDRATION,
    });

    const seen: boolean[] = [];
    const unsubscribe = disable.isNavigating.subscribe((b) => seen.push(b));
    expect(seen).toEqual([false]);

    unsubscribe();

    click(anchor);
    await vi.waitFor(() => expect(disable.isNavigating.get()).toBe(false));

    // After unsubscribe the listener heard nothing more than its initial value.
    expect(seen).toEqual([false]);

    disable();
  });
});

describe("enableSoftNav — layout-preserving partial swap (default swap)", () => {
  beforeEach(() => {
    vi.stubGlobal("scrollTo", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  /**
   * Run the REAL `defaultSwap` against the ambient document for a fetched HTML, by
   * firing the runtime's captured click listener with a synthetic event whose target
   * is a real `<a href="/dest">` (so its own `resolveAnchor` walk runs). The fetch is
   * injected (no global `fetch`/`location.assign`), and the swap is the default.
   */
  async function navigateWithDefaultSwap(destHtml: string): Promise<void> {
    const onNavigate = vi.fn();
    const onError = vi.fn();

    let clickListener: ((event: Event) => void) | undefined;
    const realAdd = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation(((type: string, l: EventListener) => {
      if (type === "click") clickListener = l as (event: Event) => void;
      else realAdd(type, l);
    }) as typeof document.addEventListener);

    const disable = enableSoftNav(new Registry(), {
      ...inertSeams(),
      fetchPage: async () => ({ html: destHtml, url: `${location.origin}/dest` }),
      onNavigate,
      onError,
    });

    vi.restoreAllMocks();

    // A real anchor in the live DOM the runtime's resolveAnchor walks to.
    const anchor = document.createElement("a");
    anchor.href = "/dest";
    const span = document.createElement("span");
    anchor.append(span);
    document.body.append(anchor);

    clickListener?.({
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      target: span,
      preventDefault: () => {},
    } as unknown as Event);

    await vi.waitFor(() => expect(onNavigate).toHaveBeenCalled());
    expect(onError).not.toHaveBeenCalled();

    disable();
  }

  it("swaps only the deepest shared layout's contents, preserving the outer layout DOM", async () => {
    // Live document: a depth-0 shell wrapping a depth-1 section wrapping the page.
    document.body.innerHTML = `
      <div data-lesto-layout="0" id="shell">
        <header id="keepme">SHELL</header>
        <div data-lesto-layout="1" id="section">
          <main id="page">OLD PAGE</main>
        </div>
      </div>`;

    const shell = document.getElementById("shell");
    const keepme = document.getElementById("keepme");
    // Tag the preserved nodes so we can prove they are the SAME node after the swap.
    (shell as HTMLElement).dataset["marker"] = "original-shell";
    (keepme as HTMLElement).dataset["marker"] = "original-header";

    // Fetched document: same layout chain, a DIFFERENT page inside the depth-1 section.
    await navigateWithDefaultSwap(`<!doctype html><html><head><title>New</title></head><body>
      <div data-lesto-layout="0">
        <header>NEW SHELL (should NOT replace the live one)</header>
        <div data-lesto-layout="1">
          <main id="page">NEW PAGE</main>
        </div>
      </div></body></html>`);

    // The outer shell + header are the SAME live nodes (state/DOM preserved)...
    expect(document.getElementById("shell")?.dataset["marker"]).toBe("original-shell");
    expect(document.getElementById("keepme")?.dataset["marker"]).toBe("original-header");
    // ...the outer header text was NOT replaced by the fetched one...
    expect(document.getElementById("keepme")?.textContent).toBe("SHELL");
    // ...but the inner page content WAS swapped.
    expect(document.getElementById("page")?.textContent).toBe("NEW PAGE");
  });

  it("falls back to a full body swap when the documents share no layout markers", async () => {
    document.body.innerHTML = `<main id="page">OLD</main>`;

    await navigateWithDefaultSwap(
      `<!doctype html><html><head><title>X</title></head><body><main id="page">NEW</main></body></html>`,
    );

    expect(document.getElementById("page")?.textContent).toBe("NEW");
    expect(document.title).toBe("X");
  });

  it("falls back to a full body swap when the chains diverge at the root (no depth-0 in fetched)", async () => {
    document.body.innerHTML = `<div data-lesto-layout="0"><main id="page">OLD</main></div>`;

    // Fetched page has NO depth-0 marker → no shared boundary → full swap.
    await navigateWithDefaultSwap(
      `<!doctype html><html><head><title>Y</title></head><body><main id="page">NEW</main></body></html>`,
    );

    expect(document.getElementById("page")?.textContent).toBe("NEW");
    // The whole body was replaced (the old depth-0 wrapper is gone).
    expect(document.querySelector("[data-lesto-layout='0']")).toBeNull();
  });

  it("swaps the depth-0 layout's contents when that is the deepest shared (no depth-1)", async () => {
    document.body.innerHTML = `<div data-lesto-layout="0" id="shell"><main id="page">OLD</main></div>`;
    (document.getElementById("shell") as HTMLElement).dataset["marker"] = "kept";

    await navigateWithDefaultSwap(`<!doctype html><html><head><title>Z</title></head><body>
      <div data-lesto-layout="0"><main id="page">NEW</main></div></body></html>`);

    // The depth-0 shell node is preserved; only its inner contents changed.
    expect(document.getElementById("shell")?.dataset["marker"]).toBe("kept");
    expect(document.getElementById("page")?.textContent).toBe("NEW");
  });
});
