// @vitest-environment jsdom

/**
 * The dispose contract across the swap boundary (ADR 0048 Phase 0.1) — the leak
 * this work exists to close, pinned end to end.
 *
 * A soft navigation replaces DOM with `replaceChildren`. Detaching a container
 * does NOT stop what is mounted in it: the React root survives, its effects
 * survive, and so does everything those effects registered — a `useQuery`
 * `refetchInterval` keeps polling, re-rendering into DOM no user can see, for the
 * life of the tab. One navigation per orphan, forever.
 *
 * So the headline test here is not "the handle was disposed" — it is "the POLL
 * STOPPED". It wires a real `useQuery` island through a fake
 * {@link RevalidationEnvironment} that records its cancel, mounts it through the
 * real hydration runtime, soft-navigates through the real swap, and asserts the
 * timer was cancelled. Remove the teardown and it goes red on the symptom, not on
 * a proxy for it.
 */

import { act, createElement } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ISLAND_ATTR, LAYOUT_ATTR, QueryClient, Registry, UiError, useQuery } from "../src/index";
import type { ClientComponentDef, RevalidationEnvironment } from "../src/index";
import { disposeDetachedIslands, hydrateIslands, islandDisposer } from "../src/hydrate";
import type { Disposer } from "../src/hydrate";
import { enableDevPageRefresh, enableSoftNav } from "../src/softnav";
import type { PageFetcher, PageSwapper } from "../src/softnav";

/** A window seam with no real scrolling; jsdom has no `scrollTo`. */
const stillWindow = { scrollX: 0, scrollY: 0, scrollTo: () => undefined };

/**
 * A {@link RevalidationEnvironment} that records what a mounted query registered
 * and, crucially, whether the registration was ever CANCELLED. `cancels` is the
 * assertion the leak is really about: the effect cleanup that clears the poll runs
 * only if something unmounts the island.
 */
function recordingEnvironment(): RevalidationEnvironment & {
  intervals: number;
  cancels: number;
} {
  const recorder = {
    intervals: 0,
    cancels: 0,

    onFocus: () => () => undefined,
    onReconnect: () => () => undefined,

    setInterval(): () => void {
      recorder.intervals += 1;

      return () => {
        recorder.cancels += 1;
      };
    },
  };

  return recorder;
}

/** Paint `html` into the live document — the server's output for the current page. */
function paint(html: string): void {
  document.body.innerHTML = html;
}

/** A page fetcher that always answers with `html`, landing on the requested url. */
function serving(html: string): PageFetcher {
  return (url) => Promise.resolve({ html, url });
}

/**
 * A two-level layout shell: a depth-0 layout holding a `chrome` island, and a
 * depth-1 layout holding whatever the page contributes. Two documents built this
 * way share both markers, so the default swap replaces only the depth-1 contents —
 * the layout-preserving partial swap.
 */
function layoutShell(inner: string): string {
  return (
    `<div ${LAYOUT_ATTR}="0">` +
    `<div ${ISLAND_ATTR}="chrome"></div>` +
    `<div ${LAYOUT_ATTR}="1">${inner}</div>` +
    `</div>`
  );
}

/**
 * An injected swapper that does its OWN `replaceChildren` on the body — the shape
 * the runtime cannot instrument, and therefore the one the post-swap sweep exists
 * to cover.
 */
const bespokeSwap: PageSwapper = (_html, doc) => {
  const replacement = doc.createElement("p");

  replacement.className = "next";
  replacement.textContent = "next page";

  doc.body.replaceChildren(replacement);

  return { title: undefined, root: doc.body };
};

/** Assert `handle` has already run — a spent handle is the proof a teardown happened. */
function expectSpent(handle: Disposer): void {
  let caught: unknown;

  try {
    handle();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(UiError);
  expect((caught as UiError).code).toBe("UI_ISLAND_ALREADY_DISPOSED");
}

afterEach(() => {
  document.body.innerHTML = "";
  disposeDetachedIslands();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("soft navigation ends the islands it swaps out", () => {
  it("stops a swapped-out island's refetchInterval — the leak, pinned", async () => {
    const environment = recordingEnvironment();
    const client = new QueryClient();

    let fetches = 0;

    // A realistic polling island: the hook owns the loading machine and the timer,
    // and its cleanup runs ONLY on unmount.
    function PollerView(): ReactNode {
      const { data } = useQuery(
        ["poll"],
        () => {
          fetches += 1;

          return Promise.resolve("tick");
        },
        { client, environment, refetchInterval: 1_000 },
      );

      return createElement("span", { className: "poll" }, String(data));
    }

    const Poller: ClientComponentDef = { name: "Poller", component: PollerView };

    paint(`<div ${ISLAND_ATTR}="poll"></div><a href="/next">next</a>`);

    await act(async () => {
      hydrateIslands(new Registry().defineClient(Poller), [
        { id: "poll", component: "Poller", props: {}, ssr: false },
      ]);
    });

    // The island is live and it registered its poll.
    expect(document.body.querySelector(".poll")?.textContent).toBe("tick");
    expect(fetches).toBe(1);
    expect(environment.intervals).toBe(1);
    expect(environment.cancels).toBe(0);

    const disable = enableSoftNav(new Registry(), {
      fetchPage: serving("<html><body><p class='next'>next page</p></body></html>"),
      window: stillWindow,
    });

    document.body.querySelector<HTMLAnchorElement>("a[href='/next']")?.click();

    await vi.waitFor(() => expect(document.body.querySelector(".next")).not.toBeNull());

    // The navigation ENDED the island: the hook's cleanup ran and cleared the poll.
    // Without the teardown this stays 0 and the timer outlives the page forever.
    expect(environment.cancels).toBe(1);

    disable();
  });

  it("disposes the swapped-out island's retained handle", async () => {
    paint(`<div ${ISLAND_ATTR}="card"></div><a href="/next">next</a>`);

    hydrateIslands(cardRegistry(), [{ id: "card", component: "Card", props: {}, ssr: false }]);

    const container = document.body.querySelector(`[${ISLAND_ATTR}="card"]`) as Element;
    const handle = islandDisposer(container) as Disposer;

    const disable = enableSoftNav(new Registry(), {
      fetchPage: serving("<html><body><p class='next'>next page</p></body></html>"),
      window: stillWindow,
    });

    document.body.querySelector<HTMLAnchorElement>("a[href='/next']")?.click();

    await vi.waitFor(() => expect(document.body.querySelector(".next")).not.toBeNull());

    expectSpent(handle);
    expect(islandDisposer(container)).toBeUndefined();

    disable();
  });

  it("keeps a PRESERVED layout's island mounted across a partial swap", async () => {
    // The regression the scoped teardown must not cause: a layout-preserving swap
    // exists to keep the outer layout's island state, so disposing it would destroy
    // the very thing the partial swap buys.
    paint(layoutShell(`<div ${ISLAND_ATTR}="page"></div><a href="/next">next</a>`));

    hydrateIslands(cardRegistry(), [
      { id: "chrome", component: "Card", props: {}, ssr: false },
      { id: "page", component: "Card", props: {}, ssr: false },
    ]);

    const chrome = document.body.querySelector(`[${ISLAND_ATTR}="chrome"]`) as Element;
    const page = document.body.querySelector(`[${ISLAND_ATTR}="page"]`) as Element;

    const chromeHandle = islandDisposer(chrome) as Disposer;
    const pageHandle = islandDisposer(page) as Disposer;

    const disable = enableSoftNav(new Registry(), {
      fetchPage: serving(
        `<html><body>${layoutShell("<p class='next'>next page</p>")}</body></html>`,
      ),
      window: stillWindow,
    });

    document.body.querySelector<HTMLAnchorElement>("a[href='/next']")?.click();

    await vi.waitFor(() => expect(document.body.querySelector(".next")).not.toBeNull());

    // The inner page's island is gone; the preserved chrome island is still live —
    // same element, same root, same handle.
    expectSpent(pageHandle);
    expect(islandDisposer(chrome)).toBe(chromeHandle);
    expect(chrome.isConnected).toBe(true);
    expect(chrome.querySelector(".card")).not.toBeNull();

    disable();
  });

  it("disposes what an INJECTED swap detached — the backstop", async () => {
    // An injected swapper owns its own DOM replacement, so `replaceContents` never
    // runs and this module cannot instrument it. The post-swap sweep is what keeps
    // the contract true anyway.
    paint(`<div ${ISLAND_ATTR}="card"></div><a href="/next">next</a>`);

    hydrateIslands(cardRegistry(), [{ id: "card", component: "Card", props: {}, ssr: false }]);

    const container = document.body.querySelector(`[${ISLAND_ATTR}="card"]`) as Element;
    const handle = islandDisposer(container) as Disposer;

    const disable = enableSoftNav(new Registry(), {
      fetchPage: serving("<html><body></body></html>"),
      swap: bespokeSwap,
      window: stillWindow,
    });

    document.body.querySelector<HTMLAnchorElement>("a[href='/next']")?.click();

    await vi.waitFor(() => expect(document.body.querySelector(".next")).not.toBeNull());

    expectSpent(handle);

    disable();
  });
});

describe("the dev page refresh ends the islands it swaps out", () => {
  it("disposes the replaced islands on every refresh", async () => {
    paint(`<div ${ISLAND_ATTR}="card"></div>`);

    hydrateIslands(cardRegistry(), [{ id: "card", component: "Card", props: {}, ssr: false }]);

    const container = document.body.querySelector(`[${ISLAND_ATTR}="card"]`) as Element;
    const handle = islandDisposer(container) as Disposer;

    const refresh = enableDevPageRefresh(new Registry(), {
      fetchPage: serving("<html><body><p class='next'>re-rendered</p></body></html>"),
    });

    await act(async () => {
      await refresh();
    });

    expect(document.body.querySelector(".next")).not.toBeNull();
    expectSpent(handle);
  });
});

/** A registry holding one plain client component, enough to own a React root. */
function cardRegistry(): Registry {
  return new Registry().defineClient({
    name: "Card",
    component: () => createElement("span", { className: "card" }, "live"),
  });
}
