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
    title: "",
    createElement: (tag: string) => real.createElement(tag),
    getElementById: (id: string) => real.getElementById(id),
    querySelector: (sel: string) => real.querySelector(sel),
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

    // A polite live region carries the new title so screen readers announce it.
    const announcer = h.body.querySelector("#lesto-route-announcer");
    expect(announcer?.getAttribute("aria-live")).toBe("polite");
    expect(announcer?.textContent).toBe("Next");

    // Focus moved off any detached node to the new page's main landmark, which got
    // a transient tabindex so a non-interactive element can hold focus.
    const main = h.body.querySelector("main");
    expect(main?.getAttribute("tabindex")).toBe("-1");
  });

  it("reuses the single live region across successive navigations", async () => {
    const h = harness();

    h.fireClick({});
    await vi.waitFor(() => expect(h.navigated.length).toBe(1));
    h.fireClick({});
    await vi.waitFor(() => expect(h.navigated.length).toBe(2));

    // Only one announcer node is ever created.
    expect(h.body.querySelectorAll("#lesto-route-announcer")).toHaveLength(1);
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
