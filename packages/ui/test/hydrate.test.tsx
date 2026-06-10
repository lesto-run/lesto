// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

import { ISLAND_ATTR, Registry, renderPage, renderPageMarkup, UiError } from "../src/index";
import type { ClientComponentDef } from "../src/index";
import { hydrateIslands } from "../src/hydrate";
import type { MountFn } from "../src/hydrate";

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

function registry(): Registry {
  return new Registry().defineClient(Account).defineClient(Stamp).defineClient(Greeting);
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

    expect(result).toEqual({ mounted: ["$"], missing: [] });
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

    expect(result).toEqual({ mounted: ["$"], missing: [] });
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

    expect(result).toEqual({ mounted: ["$"], missing: [] });
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

    expect(result).toEqual({ mounted: [], missing: ["$"] });
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

    expect(result).toEqual({ mounted: ["$"], missing: [] });
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

    expect(result).toEqual({ mounted: [id], missing: [] });
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
});
