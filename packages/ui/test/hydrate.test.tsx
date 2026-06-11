// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

import { ISLAND_ATTR, Registry, renderPage, renderPageMarkup, UiError } from "../src/index";
import type { ClientComponentDef, ComponentDef, IslandMount } from "../src/index";
import { hydrateIslands } from "../src/hydrate";
import type { MountErrorSink, MountFn, ObserveFn } from "../src/hydrate";

// ---------------------------------------------------------------------------
// Client components used as hydration targets. Each renders something the test
// can assert appeared in the live DOM (proving the REAL component mounted, not
// the server fallback).
// ---------------------------------------------------------------------------

const Account: ClientComponentDef = {
  name: "Account",
  props: { plan: { type: "string", required: true } },
  component: (props) => createElement("span", { className: "live" }, `Hi, ${props.plan as string}`),
  fallback: (props) =>
    createElement("span", { className: "fallback" }, `loading ${props.plan as string}`),
};

// An `ssr` island: the server renders the REAL component, the client hydrates
// it. Its server and client output are identical, so hydrateRoot finds a match.
const Stamp: ClientComponentDef = {
  name: "Stamp",
  ssr: true,
  props: { label: { type: "string", required: true } },
  component: (props) => createElement("span", { className: "stamp" }, props.label as string),
};

// An `ssr` island with the realistic, dangerous shape: TWO adjacent text segments
// under one parent (`'Hi, ', name`). React delimits adjacent text with `<!-- -->`
// markers that `hydrateRoot` walks to align server and client; only `renderToString`
// emits them (`renderToStaticMarkup` strips them). This component is the canary for
// the hydration-renderer contract — render it the wrong way and it mismatches.
const Greeting: ClientComponentDef = {
  name: "Greeting",
  ssr: true,
  props: { name: { type: "string", required: true } },
  component: (props) =>
    createElement("p", { className: "greet" }, "Hi, ", props.name as string, "! Welcome back."),
};

// A `hydrate: "visible"` island: the client must NOT mount it on load, only when
// its region first scrolls into view. Like `Account` it ships a fallback the
// deferred mount replaces (visible islands are typically also `ssr: false`,
// since the whole point is to defer per-visitor work).
const Lazy: ClientComponentDef = {
  name: "Lazy",
  hydrate: "visible",
  props: { tag: { type: "string", required: true } },
  component: (props) => createElement("span", { className: "lazy-live" }, props.tag as string),
  fallback: (props) =>
    createElement("span", { className: "lazy-fallback" }, `idle ${props.tag as string}`),
};

// A plain server container, so a test can place two islands side by side under
// one parent and assert their distinct wire entries.
const Box: ComponentDef = {
  name: "Box",
  props: {},
  children: true,
  render: (_props, kids) => createElement("div", null, kids),
};

function registry(): Registry {
  return new Registry()
    .define(Box)
    .defineClient(Account)
    .defineClient(Stamp)
    .defineClient(Greeting)
    .defineClient(Lazy);
}

/**
 * Paint a page's server HTML into the jsdom document, returning the manifest.
 *
 * Uses {@link renderPageMarkup}, the framework's own page serializer, NOT a raw
 * `renderToStaticMarkup` — so the markup carries the hydration markers any
 * `ssr: true` island needs, exactly as a real adopter's document shell would emit
 * it. Painting with the wrong renderer is the very bug these tests guard against.
 */
function paint(tree: unknown): ReturnType<typeof renderPage>["islands"] {
  const page = renderPage(registry(), tree);

  document.body.innerHTML = renderPageMarkup(page);

  return page.islands;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("hydrateIslands — deferred islands (createRoot)", () => {
  it("mounts the real client component fresh over the fallback", () => {
    const manifest = paint({ type: "Account", props: { plan: "Ada" } });

    // Server painted the fallback first — that's the prerendered state.
    expect(document.body.querySelector(".fallback")?.textContent).toBe("loading Ada");

    let result!: ReturnType<typeof hydrateIslands>;

    // React commits the mount inside act() so the DOM is settled before we look.
    act(() => {
      result = hydrateIslands(registry(), manifest);
    });

    expect(result).toEqual({ mounted: ["$"], missing: [], failed: [], deferred: [] });
    expect(document.body.querySelector(".live")?.textContent).toBe("Hi, Ada");
  });

  it("pairs each manifest id to its own shell via the injected mount, ssr=false", () => {
    const manifest = paint({ type: "Account", props: { plan: "outer" } });

    const mounts: Array<{ id: string | null; plan: unknown; ssr: boolean }> = [];

    const mount: MountFn = (container, element, context) => {
      const props = (element as { props: Record<string, unknown> }).props;

      mounts.push({ id: container.getAttribute(ISLAND_ATTR), plan: props.plan, ssr: context.ssr });
    };

    const result = hydrateIslands(registry(), manifest, { mount });

    expect(result).toEqual({ mounted: ["$"], missing: [], failed: [], deferred: [] });
    expect(mounts).toEqual([{ id: "$", plan: "outer", ssr: false }]);
  });
});

describe("hydrateIslands — ssr islands (hydrateRoot)", () => {
  it("hydrates the server-rendered real component, reusing its DOM", () => {
    const manifest = paint({ type: "Stamp", props: { label: "READY" } });

    // The server rendered the REAL component (not a fallback) into the shell.
    expect(document.body.querySelector(".stamp")?.textContent).toBe("READY");
    expect(manifest).toEqual([
      { id: "$", component: "Stamp", props: { label: "READY" }, ssr: true },
    ]);

    let result!: ReturnType<typeof hydrateIslands>;

    act(() => {
      result = hydrateIslands(registry(), manifest);
    });

    expect(result).toEqual({ mounted: ["$"], missing: [], failed: [], deferred: [] });
    // After hydration the same node is live — still the real component's output.
    expect(document.body.querySelector(".stamp")?.textContent).toBe("READY");
  });

  it("hydrates an adjacent-text-segment component with ZERO recoverable errors", () => {
    // The headline-feature contract: an ssr island whose component interpolates
    // text (`'Hi, ', name` — two adjacent text segments under one <p>) must
    // hydrate cleanly. This is the common, realistic shape; a single-text-child
    // component happens to survive even a markerless render, masking the defect.
    // Painted via renderPageMarkup, the markup carries React's `<!-- -->` text
    // markers, so hydrateRoot aligns server and client and reuses the DOM with no
    // re-render and no console error.
    const manifest = paint({ type: "Greeting", props: { name: "Ada" } });

    expect(document.body.querySelector(".greet")?.textContent).toBe("Hi, Ada! Welcome back.");

    const errors: unknown[] = [];

    act(() => {
      hydrateIslands(registry(), manifest, {
        onRecoverableError: (error) => errors.push(error),
      });
    });

    // No mismatch: the markers let React reuse the server DOM verbatim.
    expect(errors).toEqual([]);
    expect(document.body.querySelector(".greet")?.textContent).toBe("Hi, Ada! Welcome back.");
  });

  it("routes a hydrate via the injected mount with ssr=true and a sink", () => {
    const manifest = paint({ type: "Stamp", props: { label: "x" } });

    let sawSsr: boolean | undefined;

    let sawSink = false;

    const mount: MountFn = (_container, _element, context) => {
      sawSsr = context.ssr;
      sawSink = typeof context.onRecoverableError === "function";
    };

    hydrateIslands(registry(), manifest, { mount });

    expect(sawSsr).toBe(true);
    expect(sawSink).toBe(true);
  });

  it("wires React's recoverable-error callback to the provided sink", () => {
    // Force a recoverable hydration mismatch: paint markup the client render does
    // NOT match (the shell says "SERVER", the component renders "CLIENT"). React
    // recovers by patching the DOM and reports it through onRecoverableError.
    document.body.innerHTML = `<div ${ISLAND_ATTR}="$"><span class="stamp">SERVER</span></div>`;

    const errors: unknown[] = [];

    act(() => {
      hydrateIslands(
        registry(),
        [{ id: "$", component: "Stamp", props: { label: "CLIENT" }, ssr: true }],
        { onRecoverableError: (error) => errors.push(error) },
      );
    });

    // React recovered to the client truth and surfaced the mismatch to our sink.
    expect(document.body.querySelector(".stamp")?.textContent).toBe("CLIENT");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("falls back to console.error as the default recoverable-error sink", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    document.body.innerHTML = `<div ${ISLAND_ATTR}="$"><span class="stamp">SERVER</span></div>`;

    act(() => {
      hydrateIslands(registry(), [
        { id: "$", component: "Stamp", props: { label: "CLIENT" }, ssr: true },
      ]);
    });

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]?.[0]).toContain("recoverable hydration error");
  });
});

describe("hydrateIslands — pairing and drift", () => {
  it("reports a manifest entry whose shell is absent as missing, not an error", () => {
    // No painting: the document has no shells at all.
    const manifest = [{ id: "$", component: "Account", props: { plan: "x" }, ssr: false }];

    const calls: string[] = [];

    const result = hydrateIslands(registry(), manifest, {
      mount: (container) => calls.push(container.tagName),
    });

    expect(result).toEqual({ mounted: [], missing: ["$"], failed: [], deferred: [] });
    expect(calls).toEqual([]);
  });

  it("looks up shells in an injected root rather than document", () => {
    const root = document.createElement("section");

    root.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

    const result = hydrateIslands(
      registry(),
      [{ id: "$", component: "Account", props: { plan: "y" }, ssr: false }],
      { root, mount: () => undefined },
    );

    expect(result).toEqual({ mounted: ["$"], missing: [], failed: [], deferred: [] });
  });

  it("escapes special characters in an id so the selector stays literal", () => {
    // A contrived id carrying a quote and backslash must still match exactly.
    const id = 'weird"\\id';

    const root = document.createElement("div");

    const shell = document.createElement("div");

    shell.setAttribute(ISLAND_ATTR, id);
    root.append(shell);

    const seen: Element[] = [];

    const result = hydrateIslands(
      registry(),
      [{ id, component: "Account", props: { plan: "z" }, ssr: false }],
      { root, mount: (container) => void seen.push(container) },
    );

    expect(result).toEqual({ mounted: [id], missing: [], failed: [], deferred: [] });
    expect(seen[0]).toBe(shell);
  });

  it("throws UI_ISLAND_UNKNOWN_COMPONENT when the manifest and registry drift", () => {
    const manifest = [{ id: "$", component: "Ghost", props: {}, ssr: false }];

    try {
      hydrateIslands(registry(), manifest, { root: document, mount: () => undefined });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UiError);
      expect((error as UiError).code).toBe("UI_ISLAND_UNKNOWN_COMPONENT");
      expect((error as UiError).details).toEqual({ id: "$", component: "Ghost" });
      expect(Object.isFrozen((error as UiError).details)).toBe(true);
    }
  });

  it("does NOT catch the drift throw — a wrong component aborts before any mount runs", () => {
    // The drift throw is a build-time bug for the whole page, not a per-island
    // runtime fault: it must stay fatal and pre-empt the mount, never be routed to
    // onMountError or recorded in `failed`.
    let mountErrors = 0;

    expect(() =>
      hydrateIslands(registry(), [{ id: "$", component: "Ghost", props: {}, ssr: false }], {
        root: document,
        mount: () => undefined,
        onMountError: () => (mountErrors += 1),
      }),
    ).toThrow(UiError);

    expect(mountErrors).toBe(0);
  });
});

describe("hydrateIslands — per-island mount resilience", () => {
  it("routes a failing island's throw to onMountError and keeps hydrating the rest", () => {
    // Two shells, two manifest entries. The FIRST island's mount throws; without
    // resilience the loop would abort and the second would never hydrate. With it,
    // the first is recorded in `failed`, its error reaches the sink, and the
    // second still mounts.
    document.body.innerHTML = `<div ${ISLAND_ATTR}="first"></div><div ${ISLAND_ATTR}="second"></div>`;

    const boom = new Error("component blew up during render");

    const mounted: string[] = [];

    const errors: Array<{ error: unknown; id: string; component: string }> = [];

    const mount: MountFn = (container) => {
      const id = container.getAttribute(ISLAND_ATTR);

      if (id === "first") {
        throw boom;
      }

      mounted.push(id as string);
    };

    const onMountError: MountErrorSink = (error, info) => {
      errors.push({ error, id: info.id, component: info.component });
    };

    const result = hydrateIslands(
      registry(),
      [
        { id: "first", component: "Account", props: { plan: "a" }, ssr: false },
        { id: "second", component: "Stamp", props: { label: "b" }, ssr: true },
      ],
      { mount, onMountError },
    );

    expect(result).toEqual({ mounted: ["second"], missing: [], failed: ["first"], deferred: [] });
    expect(mounted).toEqual(["second"]);
    expect(errors).toEqual([{ error: boom, id: "first", component: "Account" }]);
  });

  it("falls back to console.error as the default mount-error sink", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

    const boom = new Error("nope");

    const mount: MountFn = () => {
      throw boom;
    };

    const result = hydrateIslands(
      registry(),
      [{ id: "$", component: "Account", props: { plan: "x" }, ssr: false }],
      { mount },
    );

    expect(result).toEqual({ mounted: [], missing: [], failed: ["$"], deferred: [] });
    expect(spy).toHaveBeenCalled();
    // The default sink names the dead island and forwards the original error.
    expect(spy.mock.calls[0]?.[0]).toContain('island "$" (Account) failed to mount');
    expect(spy.mock.calls[0]?.[1]).toBe(boom);
  });
});

describe("hydrateIslands — visible (lazy) islands", () => {
  it("emits strategy: visible on the wire only for a visible island", () => {
    // The eager island's manifest entry stays byte-for-byte what it always was
    // (no `strategy` key), so existing manifests/scripts/tests read unchanged;
    // only the `visible` opt-in carries the field. This pins both halves.
    const page = renderPage(registry(), {
      type: "Box",
      children: [
        { type: "Account", props: { plan: "eager" } },
        { type: "Lazy", props: { tag: "deferred" } },
      ],
    });

    expect(page.islands).toEqual([
      { id: "$.children[0]", component: "Account", props: { plan: "eager" }, ssr: false },
      {
        id: "$.children[1]",
        component: "Lazy",
        props: { tag: "deferred" },
        ssr: false,
        strategy: "visible",
      },
    ]);
  });

  it("does NOT mount on load — it observes and records the id in deferred", () => {
    const manifest = paint({ type: "Lazy", props: { tag: "X" } });

    // Server painted the fallback; nothing should go live until intersection.
    expect(document.body.querySelector(".lazy-fallback")?.textContent).toBe("idle X");

    const observed: Element[] = [];

    // A fake observer that records WHAT it watched but never fires `onVisible`,
    // standing in for a viewport the region has not yet scrolled into.
    const observe: ObserveFn = (container) => {
      observed.push(container);

      return () => undefined;
    };

    let result!: ReturnType<typeof hydrateIslands>;

    act(() => {
      result = hydrateIslands(registry(), manifest, { observe });
    });

    expect(result).toEqual({ mounted: [], missing: [], failed: [], deferred: ["$"] });
    // The live component did NOT mount; the fallback is still the only thing there.
    expect(document.body.querySelector(".lazy-live")).toBeNull();
    expect(document.body.querySelector(".lazy-fallback")?.textContent).toBe("idle X");
    // It DID hand the island's container to the observer.
    expect(observed[0]?.getAttribute(ISLAND_ATTR)).toBe("$");
  });

  it("mounts once on first intersection, ignores repeats, then disconnects", () => {
    const manifest = paint({ type: "Lazy", props: { tag: "Y" } });

    // Capture the observer's callback + disconnect so the test can drive the
    // intersection by hand, the way a real IntersectionObserver would later. Our
    // fake fires `onVisible` on EVERY call — the runtime, not the observer, must
    // guard the one-shot.
    let fire: (() => void) | undefined;

    let disconnects = 0;

    const observe: ObserveFn = (_container, onVisible) => {
      fire = onVisible;

      return () => (disconnects += 1);
    };

    let result!: ReturnType<typeof hydrateIslands>;

    act(() => {
      result = hydrateIslands(registry(), manifest, { observe });
    });

    // Still deferred, still only the fallback, before the region is seen.
    expect(result.deferred).toEqual(["$"]);
    expect(document.body.querySelector(".lazy-live")).toBeNull();
    expect(disconnects).toBe(0);

    // Region scrolls into view: the runtime mounts the real component now and
    // tears the observer down.
    act(() => fire?.());

    expect(document.body.querySelector(".lazy-live")?.textContent).toBe("Y");
    // The post-intersection mount mutates the (caller-held) mounted array.
    expect(result.mounted).toEqual(["$"]);
    expect(disconnects).toBe(1);

    // A repeat intersection (a real observer fires on every entry) is ignored:
    // no second mount, no second disconnect.
    act(() => fire?.());

    expect(result.mounted).toEqual(["$"]);
    expect(disconnects).toBe(1);
  });

  it("routes a deferred island whose mount throws to onMountError when it fires", () => {
    // Resilience must survive the deferral: a visible island that blows up on
    // mount is contained exactly like an eager one — just later, on intersection.
    document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

    const boom = new Error("lazy blew up");

    let fire: (() => void) | undefined;

    const observe: ObserveFn = (_container, onVisible) => {
      fire = onVisible;

      return () => undefined;
    };

    const mount: MountFn = () => {
      throw boom;
    };

    const errors: Array<{ error: unknown; id: string; component: string }> = [];

    const onMountError: MountErrorSink = (error, info) => {
      errors.push({ error, id: info.id, component: info.component });
    };

    const result = hydrateIslands(
      registry(),
      [{ id: "$", component: "Lazy", props: { tag: "z" }, ssr: false, strategy: "visible" }],
      { observe, mount, onMountError },
    );

    // Nothing failed synchronously — it's purely deferred.
    expect(result).toEqual({ mounted: [], missing: [], failed: [], deferred: ["$"] });
    expect(errors).toEqual([]);

    // On intersection the throw is caught and routed, and the id lands in failed.
    fire?.();

    expect(errors).toEqual([{ error: boom, id: "$", component: "Lazy" }]);
    expect(result.failed).toEqual(["$"]);
  });

  it("a missing visible shell is reported missing, never observed", () => {
    // No painting: the visible island has no shell. It must take the missing
    // branch (like any island), never reach the observer.
    let observeCalls = 0;

    const observe: ObserveFn = () => {
      observeCalls += 1;

      return () => undefined;
    };

    const result = hydrateIslands(
      registry(),
      [{ id: "$", component: "Lazy", props: { tag: "q" }, ssr: false, strategy: "visible" }],
      { observe },
    );

    expect(result).toEqual({ mounted: [], missing: ["$"], failed: [], deferred: [] });
    expect(observeCalls).toBe(0);
  });

  it("the default observer wraps IntersectionObserver: observes, fires once, disconnects", () => {
    // Exercise the real `intersectionObserve` default (no injected `observe`) by
    // substituting a fake `IntersectionObserver` on the global — jsdom has none.
    // This covers the default branch, its `isIntersecting` predicate, the one-shot
    // disconnect, and the returned disconnect wrapper.
    const manifest = paint({ type: "Lazy", props: { tag: "W" } });

    const instances: Array<{ observed: Element[]; disconnected: number }> = [];

    let trigger: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;

    class FakeIntersectionObserver {
      observed: Element[] = [];

      disconnected = 0;

      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        trigger = cb;
        instances.push(this);
      }

      observe(el: Element): void {
        this.observed.push(el);
      }

      disconnect(): void {
        this.disconnected += 1;
      }
    }

    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

    try {
      let result!: ReturnType<typeof hydrateIslands>;

      act(() => {
        result = hydrateIslands(registry(), manifest);
      });

      expect(result.deferred).toEqual(["$"]);
      expect(instances[0]?.observed[0]?.getAttribute(ISLAND_ATTR)).toBe("$");
      expect(document.body.querySelector(".lazy-live")).toBeNull();

      // A non-intersecting entry is ignored — no mount, no disconnect.
      act(() => trigger?.([{ isIntersecting: false }]));

      expect(document.body.querySelector(".lazy-live")).toBeNull();
      expect(instances[0]?.disconnected).toBe(0);

      // An intersecting entry fires the one-shot: mount the real component and
      // disconnect the observer.
      act(() => trigger?.([{ isIntersecting: true }]));

      expect(document.body.querySelector(".lazy-live")?.textContent).toBe("W");
      expect(instances[0]?.disconnected).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// A lazy (load) island: its component arrives as its own chunk at mount time —
// per-island code-splitting's runtime half. The loader here stands in for the
// `() => import("./x").then(m => m.X)` a bundler would split.
const Chunky: ClientComponentDef = {
  name: "Chunky",
  props: { tag: { type: "string", required: true } },
  load: () =>
    Promise.resolve((props: Record<string, unknown>) =>
      createElement("span", { className: "chunk-live" }, props.tag as string),
    ),
  fallback: (props) =>
    createElement("span", { className: "chunk-fallback" }, `fetching ${props.tag as string}`),
};

describe("hydrateIslands — lazy (load) islands", () => {
  /** The shared registry plus the lazy island under test. */
  function lazyRegistry(def: ClientComponentDef = Chunky): Registry {
    return registry().defineClient(def);
  }

  /** Paint a tree against the lazy registry, returning its manifest. */
  function paintLazy(def: ClientComponentDef, tree: unknown): IslandMount[] {
    const page = renderPage(lazyRegistry(def), tree);

    document.body.innerHTML = renderPageMarkup(page);

    return [...page.islands];
  }

  it("reports the island deferred, then mounts it when its chunk lands", async () => {
    const manifest = paintLazy(Chunky, { type: "Chunky", props: { tag: "Z" } });

    // The server painted only the fallback — a lazy island is always deferred.
    expect(document.body.querySelector(".chunk-fallback")?.textContent).toBe("fetching Z");

    let result!: ReturnType<typeof hydrateIslands>;

    act(() => {
      result = hydrateIslands(lazyRegistry(), manifest);
    });

    // Synchronously: found, pending, not yet live — the chunk is in flight.
    expect(result).toEqual({ mounted: [], missing: [], failed: [], deferred: ["$"] });
    expect(document.body.querySelector(".chunk-live")).toBeNull();

    // The chunk arrives (the loader's promise resolves): the island goes live
    // and the post-arrival mount mutates the caller-held result arrays.
    await act(async () => {});

    expect(document.body.querySelector(".chunk-live")?.textContent).toBe("Z");
    expect(result.mounted).toEqual(["$"]);
    expect(result.failed).toEqual([]);
  });

  it("routes a failed chunk load to onMountError and failed — the page survives", async () => {
    const sunk = new Error("chunk fetch failed");

    const Broken: ClientComponentDef = {
      name: "Chunky",
      props: { tag: { type: "string", required: true } },
      load: () => Promise.reject(sunk),
      fallback: (props) =>
        createElement("span", { className: "chunk-fallback" }, `fetching ${props.tag as string}`),
    };

    const manifest = paintLazy(Broken, { type: "Chunky", props: { tag: "Q" } });

    const errors: Array<{ error: unknown; id: string; component: string }> = [];

    const onMountError: MountErrorSink = (error, info) => {
      errors.push({ error, id: info.id, component: info.component });
    };

    let result!: ReturnType<typeof hydrateIslands>;

    act(() => {
      result = hydrateIslands(lazyRegistry(Broken), manifest, { onMountError });
    });

    expect(result.deferred).toEqual(["$"]);

    await act(async () => {});

    // The island is dead, named, and contained; the fallback still stands.
    expect(result.failed).toEqual(["$"]);
    expect(result.mounted).toEqual([]);
    expect(errors).toEqual([{ error: sunk, id: "$", component: "Chunky" }]);
    expect(document.body.querySelector(".chunk-fallback")?.textContent).toBe("fetching Q");
  });

  it("combines with visible: no fetch until intersection, then load + mount", async () => {
    // The full byte-deferral story: a below-the-fold lazy island costs nothing —
    // not even its chunk fetch — until the region first scrolls into view.
    let loads = 0;

    const Visible: ClientComponentDef = {
      name: "Chunky",
      hydrate: "visible",
      props: { tag: { type: "string", required: true } },
      load: () => {
        loads += 1;

        return Promise.resolve((props: Record<string, unknown>) =>
          createElement("span", { className: "chunk-live" }, props.tag as string),
        );
      },
      fallback: (props) =>
        createElement("span", { className: "chunk-fallback" }, `fetching ${props.tag as string}`),
    };

    const manifest = paintLazy(Visible, { type: "Chunky", props: { tag: "V" } });

    let fire: (() => void) | undefined;

    const observe: ObserveFn = (_container, onVisible) => {
      fire = onVisible;

      return () => undefined;
    };

    let result!: ReturnType<typeof hydrateIslands>;

    act(() => {
      result = hydrateIslands(lazyRegistry(Visible), manifest, { observe });
    });

    // Before intersection: deferred, and the chunk was never even requested.
    expect(result.deferred).toEqual(["$"]);
    expect(loads).toBe(0);

    // The region is seen: fetch the chunk, then mount on arrival.
    await act(async () => fire?.());

    expect(loads).toBe(1);
    expect(document.body.querySelector(".chunk-live")?.textContent).toBe("V");
    expect(result.mounted).toEqual(["$"]);
  });
});
