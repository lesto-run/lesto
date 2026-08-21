// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

import { ISLAND_ATTR, Registry, UiError } from "../src/index";
import { renderPage, renderPageMarkup } from "../src/server";
import type { ClientComponentDef, ComponentDef, IslandMount } from "../src/index";
import { disposeDetachedIslands, hydrateIslands, islandDisposer } from "../src/hydrate";
import type { Disposer, MountErrorSink, MountFn, ObserveFn } from "../src/hydrate";

/**
 * The teardown an injected test `mount` returns when the test does not care about
 * disposal — the seam's contract is "say how to take this down", and a fake that
 * mounts nothing has nothing to take down.
 */
const noopDispose: Disposer = () => undefined;

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

// A data-bound island (ADR 0010): it renders a prop the framework resolves from
// a source, never a client fetch the component wrote. Eager component; the bind
// rides the manifest entry, not the def.
const Profile: ClientComponentDef = {
  name: "Profile",
  component: (props) =>
    createElement("span", { className: "profile" }, `who: ${String(props.who)}`),
  fallback: () => createElement("span", { className: "profile-fallback" }, "…"),
};

function registry(): Registry {
  return new Registry()
    .define(Box)
    .defineClient(Account)
    .defineClient(Stamp)
    .defineClient(Greeting)
    .defineClient(Lazy)
    .defineClient(Profile);
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
  // Blanking the body only DETACHES the islands a test mounted; their React roots
  // are still live until something ends them. Drain the registry so no root — and
  // no retained handle — survives into the next test.
  disposeDetachedIslands();
  delete window.__lestoData;
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

      return noopDispose;
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

      return noopDispose;
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
      mount: (container) => {
        calls.push(container.tagName);

        return noopDispose;
      },
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
      { root, mount: () => noopDispose },
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
      {
        root,
        mount: (container) => {
          seen.push(container);

          return noopDispose;
        },
      },
    );

    expect(result).toEqual({ mounted: [id], missing: [], failed: [], deferred: [] });
    expect(seen[0]).toBe(shell);
  });

  it("routes UI_ISLAND_UNKNOWN_COMPONENT to the sink (deploy skew, not a thrown page)", () => {
    // A renamed-and-redeployed island in a CDN-cached document names a component
    // this bundle no longer registers. It must NOT throw — that would dark out the
    // rest of the page. The coded error is routed to onMountError and the id lands
    // in `failed`; the known island after it still mounts.
    document.body.innerHTML = `<div ${ISLAND_ATTR}="ghost"></div><div ${ISLAND_ATTR}="ok"></div>`;

    const mounted: string[] = [];

    const errors: Array<{ error: UiError; id: string; component: string }> = [];

    const result = hydrateIslands(
      registry(),
      [
        { id: "ghost", component: "Ghost", props: {}, ssr: false },
        { id: "ok", component: "Account", props: { plan: "live" }, ssr: false },
      ],
      {
        mount: (container) => {
          mounted.push(container.getAttribute(ISLAND_ATTR) as string);

          return noopDispose;
        },
        onMountError: (error, info) =>
          errors.push({ error: error as UiError, id: info.id, component: info.component }),
      },
    );

    // The unknown island failed (routed), the known one mounted — the loop survived.
    expect(result).toEqual({ mounted: ["ok"], missing: [], failed: ["ghost"], deferred: [] });
    expect(mounted).toEqual(["ok"]);
    expect(errors).toHaveLength(1);

    const first = errors[0] as { error: UiError; id: string; component: string };

    expect(first.error).toBeInstanceOf(UiError);
    expect(first.error.code).toBe("UI_ISLAND_UNKNOWN_COMPONENT");
    expect(first.error.details).toEqual({ id: "ghost", component: "Ghost" });
    expect(Object.isFrozen(first.error.details)).toBe(true);
    // The sink's `info` argument names the dead island too.
    expect({ id: first.id, component: first.component }).toEqual({
      id: "ghost",
      component: "Ghost",
    });
  });

  it("falls back to console.error for an unknown component with no injected sink", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

    const result = hydrateIslands(registry(), [
      { id: "$", component: "Ghost", props: {}, ssr: false },
    ]);

    expect(result.failed).toEqual(["$"]);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]?.[0]).toContain('island "$" (Ghost) failed to mount');
    expect(spy.mock.calls[0]?.[1]).toBeInstanceOf(UiError);
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

      return noopDispose;
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

describe("hydrateIslands — data binds (ADR 0010)", () => {
  // A manifest entry as buildIsland emits for a `data`-declared island: static
  // props plus an unresolved bind the client must resolve before mounting.
  const profileBind = {
    id: "$",
    component: "Profile",
    props: {},
    ssr: false,
    bind: { who: { source: "who", href: "/__lesto/data/who" } },
  };

  it("resolves a bind from the parse-time primer promise, then mounts with it", async () => {
    document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

    // The primer (dataPrimerScript) already kicked the fetch before any JS ran;
    // the runtime must AWAIT that promise, not start its own request.
    window.__lestoData = { who: Promise.resolve("Ada") };

    let result!: ReturnType<typeof hydrateIslands>;

    await act(async () => {
      result = hydrateIslands(registry(), [profileBind]);
    });

    // Synchronously deferred — the data is in flight — then mounted on resolve.
    expect(result.deferred).toEqual(["$"]);

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.querySelector(".profile")?.textContent).toBe("who: Ada");
    expect(result.mounted).toEqual(["$"]);
    expect(result.failed).toEqual([]);
  });

  it("falls back to fetching the href when no primer primed the source", async () => {
    document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve("Bob") } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);

    let result!: ReturnType<typeof hydrateIslands>;

    await act(async () => {
      result = hydrateIslands(registry(), [profileBind]);
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Credentialed same-origin fetch of the source's href, exactly once.
    expect(fetchMock).toHaveBeenCalledWith("/__lesto/data/who", { credentials: "same-origin" });
    expect(document.body.querySelector(".profile")?.textContent).toBe("who: Bob");
    expect(result.mounted).toEqual(["$"]);
  });

  it("fails the island when the fallback fetch answers non-ok (UI_ISLAND_DATA_FETCH_FAILED)", async () => {
    document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

    // No primer primed `who`, so the runtime fetches the href — and gets a 401.
    const json = vi.fn(() => Promise.resolve({ error: "unauthorized" }));
    vi.stubGlobal("fetch", () =>
      Promise.resolve({ ok: false, status: 401, json } as unknown as Response),
    );

    const errors: unknown[] = [];

    let result!: ReturnType<typeof hydrateIslands>;

    await act(async () => {
      result = hydrateIslands(registry(), [profileBind], {
        onMountError: (error) => errors.push(error),
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.failed).toEqual(["$"]);
    expect(errors[0]).toBeInstanceOf(UiError);
    expect((errors[0] as UiError).code).toBe("UI_ISLAND_DATA_FETCH_FAILED");
    expect((errors[0] as UiError).details).toEqual({ source: "who", status: 401 });
    // The error body was never read into a prop value.
    expect(json).not.toHaveBeenCalled();
    expect(document.body.querySelector(".profile")).toBeNull();
  });

  it("merges resolved data over the island's static props (data wins)", async () => {
    document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

    window.__lestoData = { who: Promise.resolve("FromData") };

    await act(async () => {
      hydrateIslands(registry(), [{ ...profileBind, props: { who: "FromStaticProp" } }]);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.querySelector(".profile")?.textContent).toBe("who: FromData");
  });

  it("routes a failed data resolution to onMountError and failed — the page survives", async () => {
    document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div><div ${ISLAND_ATTR}="ok"></div>`;

    const sunk = new Error("data endpoint 500");
    window.__lestoData = { who: Promise.reject(sunk) };

    const errors: Array<{ id: string; component: string }> = [];

    let result!: ReturnType<typeof hydrateIslands>;

    await act(async () => {
      result = hydrateIslands(
        registry(),
        [
          profileBind,
          // An eager, unbound island after the broken one still mounts.
          { id: "ok", component: "Stamp", props: { label: "live" }, ssr: true },
        ],
        { onMountError: (_error, info) => errors.push({ id: info.id, component: info.component }) },
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.failed).toEqual(["$"]);
    expect(errors).toEqual([{ id: "$", component: "Profile" }]);
    // The unbound island mounted synchronously and is unaffected.
    expect(result.mounted).toContain("ok");
    expect(document.body.querySelector(".profile")).toBeNull();
  });

  it("fails a bound island whose data never arrives after the deadline (UI_ISLAND_DATA_TIMEOUT)", async () => {
    vi.useFakeTimers();

    try {
      document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

      // A primed promise that never settles — the hung-source case.
      window.__lestoData = { who: new Promise<unknown>(() => undefined) };

      const errors: UiError[] = [];

      let result!: ReturnType<typeof hydrateIslands>;

      await act(async () => {
        result = hydrateIslands(registry(), [profileBind], {
          onMountError: (error) => errors.push(error as UiError),
        });
      });

      // In flight: deferred, nothing failed yet.
      expect(result.deferred).toEqual(["$"]);
      expect(result.failed).toEqual([]);

      // Advance past the 10s deadline; the timeout rejects and routes to the sink.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(result.failed).toEqual(["$"]);
      expect(errors[0]).toBeInstanceOf(UiError);
      expect(errors[0]?.code).toBe("UI_ISLAND_DATA_TIMEOUT");
      expect(errors[0]?.details).toEqual({ id: "$" });
      expect(document.body.querySelector(".profile")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("mounts when data wins just before the deadline and leaks no timer", async () => {
    vi.useFakeTimers();

    try {
      document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

      // Resolve at 9.9s — inside the 10s deadline.
      window.__lestoData = {
        who: new Promise<unknown>((resolve) => setTimeout(() => resolve("Ada"), 9_900)),
      };

      let result!: ReturnType<typeof hydrateIslands>;

      await act(async () => {
        result = hydrateIslands(registry(), [profileBind]);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_900);
      });

      expect(result.mounted).toEqual(["$"]);
      expect(result.failed).toEqual([]);
      expect(document.body.querySelector(".profile")?.textContent).toBe("who: Ada");
      // The deadline timer was cleared when the data won — nothing dangling.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors an injected bindTimeoutMs override", async () => {
    vi.useFakeTimers();

    try {
      document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

      window.__lestoData = { who: new Promise<unknown>(() => undefined) };

      const errors: UiError[] = [];

      let result!: ReturnType<typeof hydrateIslands>;

      await act(async () => {
        result = hydrateIslands(registry(), [profileBind], {
          bindTimeoutMs: 50,
          onMountError: (error) => errors.push(error as UiError),
        });
      });

      // The default 10s would not have fired yet; the 50ms override does.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });

      expect(result.failed).toEqual(["$"]);
      expect(errors[0]?.code).toBe("UI_ISLAND_DATA_TIMEOUT");
      expect(errors[0]?.message).toContain("50ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fetches a lazy island's chunk AND its data in parallel, then mounts", async () => {
    // A bound + lazy island: ADR 0009's chunk and ADR 0010's data must race, not
    // chain. Both resolve; the island mounts with the loaded component + data.
    const LazyProfile: ClientComponentDef = {
      name: "LazyProfile",
      load: () =>
        Promise.resolve((props: Record<string, unknown>) =>
          createElement("span", { className: "lazy-profile" }, `hi ${String(props.who)}`),
        ),
      fallback: () => createElement("span", null, "…"),
    };

    document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;
    window.__lestoData = { who: Promise.resolve("Cleo") };

    let result!: ReturnType<typeof hydrateIslands>;

    await act(async () => {
      result = hydrateIslands(new Registry().defineClient(LazyProfile), [
        {
          id: "$",
          component: "LazyProfile",
          props: {},
          ssr: false,
          bind: { who: { source: "who", href: "/__lesto/data/who" } },
        },
      ]);
    });
    expect(result.deferred).toEqual(["$"]);

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.querySelector(".lazy-profile")?.textContent).toBe("hi Cleo");
    expect(result.mounted).toEqual(["$"]);
  });
});

// ---------------------------------------------------------------------------
// The dispose contract (ADR 0048 Phase 0.1). A mount that cannot be taken down
// leaks a React root — with its effects, poll timers, and focus listeners still
// live — every time the DOM under it is swapped. These tests pin the other half:
// `MountFn` returns a teardown, the runtime retains it per container, and there
// are exactly three ways to drain it.
// ---------------------------------------------------------------------------

/** An observer that reports its region visible before it even returns. */
const seeImmediately: ObserveFn = (_container, onVisible) => {
  onVisible();

  return () => undefined;
};

/** The island shell for `id` in the live document, which the tests tear down by hand. */
function islandShell(id: string): Element {
  const container = document.body.querySelector(`[${ISLAND_ATTR}="${id}"]`);

  if (container === null) throw new Error(`no island shell for "${id}"`);

  return container;
}

/** Hydrate `manifest` inside `act`, so React has committed before the test looks. */
function hydrate(manifest: readonly IslandMount[]): ReturnType<typeof hydrateIslands> {
  let result!: ReturnType<typeof hydrateIslands>;

  act(() => {
    result = hydrateIslands(registry(), manifest);
  });

  return result;
}

describe("hydrateIslands — the dispose contract", () => {
  it("returns a real teardown from the createRoot (ssr: false) mount", () => {
    hydrate(paint({ type: "Account", props: { plan: "Ada" } }));

    const container = islandShell("$");

    expect(container.querySelector(".live")?.textContent).toBe("Hi, Ada");

    const dispose = islandDisposer(container);

    expect(dispose).toBeTypeOf("function");

    act(() => dispose?.());

    // React cleared the container it owned — the root is genuinely unmounted, not
    // merely forgotten.
    expect(container.querySelector(".live")).toBeNull();
    expect(islandDisposer(container)).toBeUndefined();
  });

  it("returns a real teardown from the hydrateRoot (ssr: true) mount", () => {
    // The OTHER default branch: `hydrateRoot` must hand back its root too, or an
    // ssr island is the one flavour that can never be ended.
    hydrate(paint({ type: "Stamp", props: { label: "READY" } }));

    const container = islandShell("$");

    expect(container.querySelector(".stamp")?.textContent).toBe("READY");

    act(() => islandDisposer(container)?.());

    expect(container.querySelector(".stamp")).toBeNull();
    expect(islandDisposer(container)).toBeUndefined();
  });

  it("throws UI_ISLAND_ALREADY_DISPOSED when a retained handle is called twice", () => {
    hydrate(paint({ type: "Account", props: { plan: "Ada" } }));

    const dispose = islandDisposer(islandShell("$")) as Disposer;

    act(() => dispose());

    let caught: unknown;

    try {
      dispose();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UiError);
    expect((caught as UiError).code).toBe("UI_ISLAND_ALREADY_DISPOSED");
    expect((caught as UiError).details).toEqual({ id: "$" });
    expect(Object.isFrozen((caught as UiError).details)).toBe(true);
  });

  it("has no teardown for a shell nothing mounted into", () => {
    paint({ type: "Account", props: { plan: "Ada" } });

    expect(islandDisposer(islandShell("$"))).toBeUndefined();
  });

  it("ends the previous mount when the same shell is hydrated again", () => {
    const manifest = paint({ type: "Account", props: { plan: "Ada" } });

    hydrate(manifest);

    const container = islandShell("$");
    const first = islandDisposer(container) as Disposer;

    act(() => void hydrateIslands(registry(), manifest));

    const second = islandDisposer(container) as Disposer;

    expect(second).not.toBe(first);

    // The first root was ENDED by the re-hydrate, not left running under the
    // second one: its handle is spent, which only a real teardown makes true.
    expect(() => first()).toThrow(UiError);
    expect(container.querySelector(".live")?.textContent).toBe("Hi, Ada");
  });

  it("disposeDetachedIslands takes exactly what the document let go", () => {
    document.body.innerHTML =
      `<div id="host"><div ${ISLAND_ATTR}="gone"></div></div>` +
      `<div ${ISLAND_ATTR}="stays"></div>`;

    hydrate([
      { id: "gone", component: "Account", props: { plan: "gone" }, ssr: false },
      { id: "stays", component: "Account", props: { plan: "stays" }, ssr: false },
    ]);

    const gone = islandShell("gone");
    const stays = islandShell("stays");

    // A swap detaches the shell without ending the island — the leak, reproduced.
    (document.body.querySelector("#host") as Element).replaceChildren();

    expect(gone.isConnected).toBe(false);

    let disposed!: string[];

    act(() => {
      disposed = disposeDetachedIslands();
    });

    expect(disposed).toEqual(["gone"]);
    expect(islandDisposer(gone)).toBeUndefined();
    expect(islandDisposer(stays)).toBeTypeOf("function");
  });

  it("stops a never-seen visible island from watching a detached shell", () => {
    // A `"visible"` island that is swapped away before its region is ever seen has
    // no root to unmount — but a real `IntersectionObserver` holds a strong
    // reference to every target it watches, so the observation is the leak.
    const manifest = paint({ type: "Lazy", props: { tag: "X" } });

    let disconnects = 0;

    const observe: ObserveFn = () => () => {
      disconnects += 1;
    };

    const result = hydrateIslands(registry(), manifest, { observe });

    expect(result.deferred).toEqual(["$"]);

    const container = islandShell("$");

    // Nothing mounted, yet the container has a teardown: the pending observation.
    expect(islandDisposer(container)).toBeTypeOf("function");
    expect(container.querySelector(".lazy-live")).toBeNull();

    document.body.replaceChildren();

    expect(disposeDetachedIslands()).toEqual(["$"]);
    expect(disconnects).toBe(1);
    expect(islandDisposer(container)).toBeUndefined();
  });

  it("hands the mount's teardown to the container when a visible island goes live", () => {
    // The regression this pins: the pending OBSERVATION and the eventual MOUNT are
    // two successive teardowns for one container. If the transition drops the first
    // entry raw instead of running it, a caller still holding that handle can later
    // fire it, evict the MOUNT's teardown from the registry, and orphan the very
    // React root this whole contract exists to end.
    const manifest = paint({ type: "Lazy", props: { tag: "Y" } });

    let fire: (() => void) | undefined;

    const observe: ObserveFn = (_container, onVisible) => {
      fire = onVisible;

      return () => undefined;
    };

    hydrateIslands(registry(), manifest, { observe });

    const container = islandShell("$");
    const pending = islandDisposer(container) as Disposer;

    act(() => fire?.());

    expect(container.querySelector(".lazy-live")?.textContent).toBe("Y");

    // The observation handle is SPENT, so a caller holding it is told so…
    expect(() => pending()).toThrow(UiError);

    // …and the mount's own teardown is still the retained one, and still works.
    const mounted = islandDisposer(container);

    expect(mounted).toBeTypeOf("function");
    expect(mounted).not.toBe(pending);

    act(() => mounted?.());

    expect(container.querySelector(".lazy-live")).toBeNull();
  });

  it("abandons a lazy island whose chunk lands AFTER its shell was swapped away", async () => {
    // The window this closes: between `hydrateIslands` and the chunk resolving,
    // nothing was retained, so a navigation swept nothing and the mount then
    // landed in a container the document had already let go — a live root nothing
    // could reach. On the last navigation of a session it would run forever.
    let resolveChunk!: (component: NonNullable<ClientComponentDef["component"]>) => void;

    const Slow: ClientComponentDef = {
      name: "Slow",
      load: () =>
        new Promise<NonNullable<ClientComponentDef["component"]>>((resolve) => {
          resolveChunk = resolve;
        }),
    };

    document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

    const container = islandShell("$");

    const result = hydrateIslands(new Registry().defineClient(Slow), [
      { id: "$", component: "Slow", props: {}, ssr: false },
    ]);

    expect(result.deferred).toEqual(["$"]);
    // The in-flight mount is retained, so a sweep can reach it.
    expect(islandDisposer(container)).toBeTypeOf("function");

    // Navigate: the shell is detached and swept while the chunk is still in flight.
    document.body.replaceChildren();

    expect(disposeDetachedIslands()).toEqual(["$"]);

    await act(async () => {
      resolveChunk(() => createElement("span", { className: "slow-live" }, "late"));
    });

    // The chunk arrived to a container nobody holds: no mount, nothing retained.
    expect(container.querySelector(".slow-live")).toBeNull();
    expect(result.mounted).toEqual([]);
    expect(islandDisposer(container)).toBeUndefined();
  });

  it("drops the pending entry when a lazy island's chunk FAILS", async () => {
    document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

    const sunk = new Error("chunk fetch failed");

    const Broken: ClientComponentDef = { name: "Broken", load: () => Promise.reject(sunk) };

    const errors: unknown[] = [];

    let result!: ReturnType<typeof hydrateIslands>;

    act(() => {
      result = hydrateIslands(
        new Registry().defineClient(Broken),
        [{ id: "$", component: "Broken", props: {}, ssr: false }],
        { onMountError: (error) => errors.push(error) },
      );
    });

    await act(async () => {});

    expect(result.failed).toEqual(["$"]);
    expect(errors).toEqual([sunk]);
    // No cancel left behind for a mount that will never come.
    expect(islandDisposer(islandShell("$"))).toBeUndefined();
  });

  it("reports a chunk that fails AFTER its island was swept, retaining nothing", async () => {
    let rejectChunk!: (error: unknown) => void;

    const Slow: ClientComponentDef = {
      name: "Slow",
      load: () =>
        new Promise<NonNullable<ClientComponentDef["component"]>>((_resolve, reject) => {
          rejectChunk = reject;
        }),
    };

    document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

    const container = islandShell("$");
    const errors: unknown[] = [];

    hydrateIslands(
      new Registry().defineClient(Slow),
      [{ id: "$", component: "Slow", props: {}, ssr: false }],
      { onMountError: (error) => errors.push(error) },
    );

    document.body.replaceChildren();
    disposeDetachedIslands();

    const sunk = new Error("chunk 404");

    await act(async () => {
      rejectChunk(sunk);
    });

    // The failure is still reported; the already-swept entry is not resurrected.
    expect(errors).toEqual([sunk]);
    expect(islandDisposer(container)).toBeUndefined();
  });

  it("keeps the mount's teardown when an observer reports visibility SYNCHRONOUSLY", () => {
    // `observe` is an injected seam. One that calls back before it returns has
    // already mounted by the time the runtime retains the pending observation —
    // retaining unconditionally would overwrite the mount's teardown with a spent
    // disconnect and orphan the root.
    const manifest = paint({ type: "Lazy", props: { tag: "S" } });

    act(() => void hydrateIslands(registry(), manifest, { observe: seeImmediately }));

    const container = islandShell("$");

    expect(container.querySelector(".lazy-live")?.textContent).toBe("S");

    act(() => islandDisposer(container)?.());

    // The retained handle was the MOUNT's, so running it unmounts the root.
    expect(container.querySelector(".lazy-live")).toBeNull();
  });

  it("stops an observer it will not retain after a SYNCHRONOUS mount", () => {
    // Nothing else holds that observer: not retaining it AND not disconnecting it
    // would leave a real `IntersectionObserver` holding the element forever.
    const manifest = paint({ type: "Lazy", props: { tag: "D" } });

    let disconnects = 0;

    const observe: ObserveFn = (_container, onVisible) => {
      onVisible();

      return () => {
        disconnects += 1;
      };
    };

    act(() => void hydrateIslands(registry(), manifest, { observe }));

    expect(disconnects).toBe(1);
  });

  it("ends a still-watching observation when the same shell is hydrated again", () => {
    const manifest = paint({ type: "Lazy", props: { tag: "R" } });

    let disconnects = 0;

    const observe: ObserveFn = () => () => {
      disconnects += 1;
    };

    hydrateIslands(registry(), manifest, { observe });
    hydrateIslands(registry(), manifest, { observe });

    // Without this the first observer is unreachable from the registry and keeps a
    // strong reference to the element for the life of the page.
    expect(disconnects).toBe(1);
  });

  it("does not fail a re-mount when the PREVIOUS island's teardown throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

    const manifest = [{ id: "$", component: "Account", props: { plan: "x" }, ssr: false }];

    let mounts = 0;

    const mount: MountFn = () => {
      mounts += 1;

      return () => {
        throw new Error("unmount blew up");
      };
    };

    hydrateIslands(registry(), manifest, { mount });

    const second = hydrateIslands(registry(), manifest, { mount });

    // The old island's broken teardown is its own failure, not the new mount's.
    expect(second).toEqual({ mounted: ["$"], missing: [], failed: [], deferred: [] });
    expect(mounts).toBe(2);
    expect(spy.mock.calls[0]?.[0]).toContain('island "$" failed to dispose');
  });

  it("contains a throwing teardown so one bad island cannot abort a navigation", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    document.body.innerHTML = `<div ${ISLAND_ATTR}="bad"></div><div ${ISLAND_ATTR}="good"></div>`;

    const boom = new Error("unmount blew up");

    const mount: MountFn = (container) =>
      container.getAttribute(ISLAND_ATTR) === "bad"
        ? () => {
            throw boom;
          }
        : noopDispose;

    hydrateIslands(
      registry(),
      [
        { id: "bad", component: "Account", props: { plan: "a" }, ssr: false },
        { id: "good", component: "Account", props: { plan: "b" }, ssr: false },
      ],
      { mount },
    );

    const good = islandShell("good");

    document.body.replaceChildren();

    // The sweep runs mid-navigation: it must not rethrow, and it must still reach
    // the island AFTER the broken one.
    expect(() => disposeDetachedIslands()).not.toThrow();
    expect(islandDisposer(good)).toBeUndefined();
    expect(spy.mock.calls[0]?.[0]).toContain('island "bad" failed to dispose');
    expect(spy.mock.calls[0]?.[1]).toBe(boom);
  });

  it("retains nothing for an island whose mount threw", () => {
    document.body.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

    const boom = new Error("component blew up during render");

    const mount: MountFn = () => {
      throw boom;
    };

    const result = hydrateIslands(
      registry(),
      [{ id: "$", component: "Account", props: { plan: "x" }, ssr: false }],
      { mount, onMountError: () => undefined },
    );

    expect(result.failed).toEqual(["$"]);
    expect(islandDisposer(islandShell("$"))).toBeUndefined();
  });
});
