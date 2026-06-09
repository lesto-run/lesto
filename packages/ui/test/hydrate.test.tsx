// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { ISLAND_ATTR, Registry, renderPage, UiError } from "../src/index";
import type { ClientComponentDef } from "../src/index";
import { hydrateIslands } from "../src/hydrate";
import type { HydrateFn } from "../src/hydrate";

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

function registry(): Registry {
  return new Registry().defineClient(Account);
}

/** Paint a page's server HTML into the jsdom document, returning the manifest. */
function paint(tree: unknown): ReturnType<typeof renderPage>["islands"] {
  const page = renderPage(registry(), tree);

  document.body.innerHTML = renderToStaticMarkup(page.element);

  return page.islands;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("hydrateIslands", () => {
  it("hydrates a shell with the real client component using the default React mount", () => {
    const manifest = paint({ type: "Account", props: { plan: "Ada" } });

    // Server painted the fallback first — that's the prerendered state.
    expect(document.body.querySelector(".fallback")?.textContent).toBe("loading Ada");

    let result!: ReturnType<typeof hydrateIslands>;

    // React commits hydration inside act() so the DOM is settled before we look.
    act(() => {
      result = hydrateIslands(registry(), manifest);
    });

    expect(result).toEqual({ mounted: ["$"], missing: [] });
    expect(document.body.querySelector(".live")?.textContent).toBe("Hi, Ada");
  });

  it("pairs each manifest id to its own shell via the injected mount", () => {
    const manifest = paint({
      type: "Account",
      props: { plan: "outer" },
    });

    const mounts: Array<{ id: string | null; plan: unknown }> = [];

    const hydrate: HydrateFn = (container, element) => {
      const props = (element as { props: Record<string, unknown> }).props;

      mounts.push({ id: container.getAttribute(ISLAND_ATTR), plan: props.plan });
    };

    const result = hydrateIslands(registry(), manifest, { hydrate });

    expect(result).toEqual({ mounted: ["$"], missing: [] });
    expect(mounts).toEqual([{ id: "$", plan: "outer" }]);
  });

  it("reports a manifest entry whose shell is absent as missing, not an error", () => {
    // No painting: the document has no shells at all.
    const manifest = [{ id: "$", component: "Account", props: { plan: "x" } }];

    const calls: string[] = [];

    const result = hydrateIslands(registry(), manifest, {
      hydrate: (container) => calls.push(container.tagName),
    });

    expect(result).toEqual({ mounted: [], missing: ["$"] });
    expect(calls).toEqual([]);
  });

  it("looks up shells in an injected root rather than document", () => {
    const root = document.createElement("section");

    root.innerHTML = `<div ${ISLAND_ATTR}="$"></div>`;

    const result = hydrateIslands(
      registry(),
      [{ id: "$", component: "Account", props: { plan: "y" } }],
      {
        root,
        hydrate: () => undefined,
      },
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
      [{ id, component: "Account", props: { plan: "z" } }],
      {
        root,
        hydrate: (container) => void seen.push(container),
      },
    );

    expect(result).toEqual({ mounted: [id], missing: [] });
    expect(seen[0]).toBe(shell);
  });

  it("throws UI_ISLAND_UNKNOWN_COMPONENT when the manifest and registry drift", () => {
    const manifest = [{ id: "$", component: "Ghost", props: {} }];

    try {
      hydrateIslands(registry(), manifest, { root: document, hydrate: () => undefined });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UiError);
      expect((error as UiError).code).toBe("UI_ISLAND_UNKNOWN_COMPONENT");
      expect((error as UiError).details).toEqual({ id: "$", component: "Ghost" });
      expect(Object.isFrozen((error as UiError).details)).toBe(true);
    }
  });
});
