// @vitest-environment jsdom

/**
 * `defineIsland` + `hydrateDocumentIslands` — the `.page` island wire end to end
 * (ADR 0011), in a browser-like environment.
 *
 * The server path: a `defineIsland` component renders its shell + a co-located
 * mount script + (for bound data) a primer — siblings, so the hydration
 * container is exactly the shell. The client path: `hydrateDocumentIslands`
 * scans the mount scripts and mounts each island through the same machinery as
 * the manifest path. The two are proven to meet in the middle.
 */

import { act } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defineDataSource,
  defineIsland,
  ISLAND_ATTR,
  ISLAND_MOUNT_ATTR,
  Registry,
  UiError,
} from "../src/index";
import type { ClientComponentDef } from "../src/index";
import { hydrateDocumentIslands } from "../src/hydrate";

// A deferred island that renders a prop the framework resolves from a source.
const sessionSource = defineDataSource<{ name: string } | null>("session");

const Account = defineIsland({
  name: "Account",
  component: (props) =>
    createElement(
      "span",
      { className: "live" },
      `Hi, ${String((props.session as { name: string }).name)}`,
    ),
  fallback: () => createElement("a", { className: "fallback", href: "/in" }, "Sign in"),
  data: { session: sessionSource },
});

/** A registry the client uses to look up an island by the name in its mount script. */
function registry(): Registry {
  return new Registry().defineClient(Account.island);
}

afterEach(() => {
  document.body.innerHTML = "";
  delete window.__keelData;
  vi.restoreAllMocks();
});

describe("defineIsland — define-time union refusals", () => {
  it("throws UI_CLIENT_SSR_DATA_UNSUPPORTED for ssr: true + data (interim, ADR 0012)", () => {
    const ssrData = {
      name: "Live",
      ssr: true,
      component: () => createElement("span", null, "x"),
      data: { session: defineDataSource("session") },
    } as unknown as ClientComponentDef;

    try {
      defineIsland(ssrData);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UiError);
      expect((error as UiError).code).toBe("UI_CLIENT_SSR_DATA_UNSUPPORTED");
      expect((error as UiError).details).toEqual({ name: "Live" });
    }
  });

  it("throws UI_CLIENT_COMPONENT_MISSING for a def with neither component nor load", () => {
    const empty = { name: "Ghost" } as unknown as ClientComponentDef;

    try {
      defineIsland(empty);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UiError);
      expect((error as UiError).code).toBe("UI_CLIENT_COMPONENT_MISSING");
      expect((error as UiError).details).toEqual({ name: "Ghost" });
    }
  });
});

describe("defineIsland — server emission", () => {
  it("emits the shell, a co-located mount script, and a data primer as siblings", () => {
    const html = renderToStaticMarkup(createElement(Account, {}));

    // The shell wraps the fallback (deferred island) under the island attr…
    expect(html).toContain(`${ISLAND_ATTR}=`);
    expect(html).toContain("Sign in");

    // …a co-located application/json mount script carries this island's own mount…
    expect(html).toContain(`${ISLAND_MOUNT_ATTR}=""`);
    expect(html).toContain('"component":"Account"');
    expect(html).toContain('"bind":{"session":{"source":"session","href":"/__keel/data/session"}}');

    // …and a primer kicks the bound source's fetch.
    expect(html).toContain("window.__keelData");
    expect(html).toContain('"/__keel/data/session"');

    // The mount script is a SIBLING of the shell, not a child (else hydration
    // would adopt the script and mismatch): the script tag comes after the
    // closing of the island div.
    const islandClose = html.indexOf("</div>");
    const mountScript = html.indexOf(ISLAND_MOUNT_ATTR);
    expect(mountScript).toBeGreaterThan(islandClose);
  });

  it("carries the island's declaration on the component for the build + client registry", () => {
    expect(Account.island.name).toBe("Account");
    expect(Account.island.data).toEqual({ session: sessionSource });
  });
});

/** Paint a page of `defineIsland` components into the document, like the server would. */
function paint(...islands: ReturnType<typeof defineIsland>[]): void {
  document.body.innerHTML = islands
    .map((Island) => renderToStaticMarkup(createElement(Island, {})))
    .join("");
}

describe("defineIsland — shell variants", () => {
  it("renders the REAL component into the shell for an ssr:true island", () => {
    const Stamp = defineIsland({
      name: "Stamp",
      ssr: true,
      component: () => createElement("span", { className: "stamp" }, "READY"),
    });

    const html = renderToStaticMarkup(createElement(Stamp, {}));

    // ssr:true → the shell holds the component's real output, not a fallback.
    expect(html).toContain('class="stamp"');
    expect(html).toContain("READY");
    expect(html).toContain('"ssr":true');
  });

  it("renders an empty shell for a deferred island that declares no fallback", () => {
    const Bare = defineIsland({
      name: "Bare",
      component: () => createElement("span", null, "live"),
    });

    const html = renderToStaticMarkup(createElement(Bare, {}));

    // No fallback → the island div is present but empty until hydration.
    expect(html).toContain(`<div ${ISLAND_ATTR}="`);
    expect(html).toContain(`${ISLAND_MOUNT_ATTR}=""`);
    // No primer (no data binding).
    expect(html).not.toContain("__keelData");
  });
});

describe("hydrateDocumentIslands — client scan + mount", () => {
  it("scans the mount scripts and hydrates each island with its primed data", async () => {
    paint(Account);

    // Server painted the fallback; the primer kicked the fetch (here pre-primed).
    expect(document.body.querySelector(".fallback")).not.toBeNull();
    window.__keelData = { session: Promise.resolve({ name: "Ada" }) };

    let result!: ReturnType<typeof hydrateDocumentIslands>;
    act(() => {
      result = hydrateDocumentIslands(registry());
    });

    // Bound island → deferred until its data lands, then mounted with it.
    expect(result.deferred).toHaveLength(1);

    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.querySelector(".live")?.textContent).toBe("Hi, Ada");
    expect(result.mounted).toHaveLength(1);
  });

  it("skips a corrupt mount script — its island keeps its fallback, the rest hydrate", async () => {
    const Plain = defineIsland({
      name: "Plain",
      component: () => createElement("span", { className: "plain-live" }, "live"),
      fallback: () => createElement("span", { className: "plain-fallback" }, "…"),
    });

    paint(Plain);
    // Corrupt the (only) mount script's JSON so it cannot parse.
    const script = document.querySelector(`script[${ISLAND_MOUNT_ATTR}]`)!;
    script.textContent = "{ not json";

    let result!: ReturnType<typeof hydrateDocumentIslands>;
    act(() => {
      result = hydrateDocumentIslands(new Registry().defineClient(Plain.island));
    });

    // Nothing mounted, nothing threw; the island keeps its server fallback.
    expect(result).toEqual({ mounted: [], missing: [], failed: [], deferred: [] });
    expect(document.body.querySelector(".plain-fallback")).not.toBeNull();
    expect(document.body.querySelector(".plain-live")).toBeNull();
  });

  it("skips an empty mount script (nothing to parse)", () => {
    document.body.innerHTML = `<div ${ISLAND_ATTR}="x"></div><script ${ISLAND_MOUNT_ATTR}=""></script>`;

    expect(hydrateDocumentIslands(registry())).toEqual({
      mounted: [],
      missing: [],
      failed: [],
      deferred: [],
    });
  });

  it("returns an empty result for a document with no islands", () => {
    document.body.innerHTML = "<p>just content</p>";

    expect(hydrateDocumentIslands(registry())).toEqual({
      mounted: [],
      missing: [],
      failed: [],
      deferred: [],
    });
  });
});
