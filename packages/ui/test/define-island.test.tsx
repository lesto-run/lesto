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

import { act, Suspense } from "react";
import { createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  createSourceResolver,
  defineDataSource,
  defineIsland,
  IslandDataProvider,
  ISLAND_ATTR,
  ISLAND_MOUNT_ATTR,
  Registry,
  UiError,
} from "../src/index";
import { renderPageStreamToString } from "../src/server";
import type { SourceResolver } from "../src/index";
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
  delete window.__voloData;
  vi.restoreAllMocks();
});

describe("defineIsland — define-time union refusals", () => {
  it("throws UI_CLIENT_COMPONENT_MISSING for a def with neither component nor load", () => {
    // The un-typed caller: cast past the generic signature to the runtime gate.
    const empty = { name: "Ghost" } as unknown as Parameters<typeof defineIsland>[0];

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
    expect(html).toContain('"bind":{"session":{"source":"session","href":"/__volo/data/session"}}');

    // …and a primer kicks the bound source's fetch.
    expect(html).toContain("window.__voloData");
    expect(html).toContain('"/__volo/data/session"');

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

// ---------------------------------------------------------------------------
// ADR 0012: the render-time resolver. Under a provider, a bound island's data
// is resolved AT RENDER and inlined (no bind, no primer); an ssr:true island's
// shell holds the REAL component WITH the data.
// ---------------------------------------------------------------------------

const counts = defineDataSource<{ likes: number }>("counts");

/** A stub resolver that records which sources it loaded and returns canned values. */
function stubResolver(value: unknown): { resolver: SourceResolver; loaded: string[] } {
  const loaded: string[] = [];

  const resolver = createSourceResolver((source) => {
    loaded.push(source);

    return value;
  });

  return { resolver, loaded };
}

describe("defineIsland — render-time resolver (ADR 0012)", () => {
  it("an ssr:true + data island renders the real component WITH the data, no bind, no primer", () => {
    const Reactions = defineIsland({
      name: "Reactions",
      ssr: true,
      component: (props) =>
        createElement(
          "b",
          { className: "count" },
          String((props.counts as { likes: number }).likes),
        ),
      data: { counts },
    });

    const { resolver, loaded } = stubResolver({ likes: 42 });

    const html = renderToStaticMarkup(
      createElement(IslandDataProvider, { resolver }, createElement(Reactions, {})),
    );

    // The server markup holds the REAL component's output with the inlined data.
    expect(html).toContain('class="count"');
    expect(html).toContain("42");
    // The mount script inlines the value into props with NO bind…
    expect(html).toContain('"counts":{"likes":42}');
    expect(html).not.toContain('"bind"');
    expect(html).toContain('"ssr":true');
    // …and there is no primer (the data already crossed the wire inline).
    expect(html).not.toContain("__voloData");
    expect(loaded).toEqual(["counts"]);
  });

  it("a deferred (ssr falsy) + data island under a resolver inlines too — no bind, no primer", () => {
    const { resolver } = stubResolver({ name: "Ada" });

    const html = renderToStaticMarkup(
      createElement(IslandDataProvider, { resolver }, createElement(Account, {})),
    );

    // The shell is still the fallback (ssr is falsy), but the mount inlines data…
    expect(html).toContain("Sign in");
    expect(html).toContain('"session":{"name":"Ada"}');
    expect(html).not.toContain('"bind"');
    expect(html).not.toContain("__voloData");
  });

  it("a visible + data island under a resolver KEEPS its bind and never loads its source", () => {
    const VisibleAccount = defineIsland({
      name: "VisibleAccount",
      hydrate: "visible",
      component: (props) => createElement("span", null, String(props.session)),
      fallback: () => createElement("span", null, "idle"),
      data: { session: sessionSource },
    });

    const { resolver, loaded } = stubResolver({ name: "Never" });

    const html = renderToStaticMarkup(
      createElement(IslandDataProvider, { resolver }, createElement(VisibleAccount, {})),
    );

    // Deferred with the mount: bind kept, no inline value, loader never called.
    expect(html).toContain('"bind":{"session":{"source":"session","href":"/__volo/data/session"}}');
    expect(html).toContain('"strategy":"visible"');
    expect(loaded).toEqual([]);
  });

  it("two islands binding one source run the loader once (memoization)", () => {
    const A = defineIsland({
      name: "A",
      ssr: true,
      component: (props) =>
        createElement("i", null, String((props.counts as { likes: number }).likes)),
      data: { counts },
    });
    const B = defineIsland({
      name: "B",
      ssr: true,
      component: (props) =>
        createElement("u", null, String((props.counts as { likes: number }).likes)),
      data: { counts },
    });

    const { resolver, loaded } = stubResolver({ likes: 9 });

    renderToString(
      createElement(IslandDataProvider, { resolver }, createElement(A, {}), createElement(B, {})),
    );

    expect(loaded).toEqual(["counts"]);
  });

  it("renders a sync-loader island under renderToString", () => {
    const Reactions = defineIsland({
      name: "Reactions",
      ssr: true,
      component: (props) =>
        createElement("b", null, String((props.counts as { likes: number }).likes)),
      data: { counts },
    });

    const { resolver } = stubResolver({ likes: 3 });

    const html = renderToString(
      createElement(IslandDataProvider, { resolver }, createElement(Reactions, {})),
    );

    expect(html).toContain("3");
  });

  it("streams an async-loader island, flushing the resolved document", async () => {
    const Reactions = defineIsland({
      name: "Reactions",
      ssr: true,
      component: (props) =>
        createElement(
          "b",
          { className: "count" },
          String((props.counts as { likes: number }).likes),
        ),
      data: { counts },
    });

    // An async loader — resolved through React's `use()` + Suspense + the stream.
    const resolver = createSourceResolver(() => Promise.resolve({ likes: 77 }));

    const element = createElement(
      "div",
      null,
      createElement(
        IslandDataProvider,
        { resolver },
        createElement(
          Suspense,
          { fallback: createElement("span", null, "…") },
          createElement(Reactions, {}),
        ),
      ),
    );

    const html = await renderPageStreamToString({ element, errors: [], islands: [] });

    expect(html).toContain('class="count"');
    expect(html).toContain("77");
    expect(html).toContain('"counts":{"likes":77}');
  });
});

describe("defineIsland — no resolver in scope", () => {
  it("an ssr:true + data island throws UI_ISLAND_SSR_DATA_UNRESOLVED", () => {
    const Reactions = defineIsland({
      name: "Reactions",
      ssr: true,
      component: (props) =>
        createElement("b", null, String((props.counts as { likes: number }).likes)),
      data: { counts },
    });

    try {
      // No provider: a static/prerender emission of an ssr+data island is refused.
      renderToStaticMarkup(createElement(Reactions, {}));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UiError);
      expect((error as UiError).code).toBe("UI_ISLAND_SSR_DATA_UNRESOLVED");
      expect((error as UiError).details).toEqual({ name: "Reactions" });
    }
  });

  it("a deferred + data island emits bind + primer byte-identically to before item 7", () => {
    // No provider → the static tier: the same bind + primer the island always had.
    const html = renderToStaticMarkup(createElement(Account, {}));

    expect(html).toContain('"bind":{"session":{"source":"session","href":"/__volo/data/session"}}');
    expect(html).toContain("window.__voloData");
    expect(html).not.toContain('"session":{"name"');
  });
});

// ---------------------------------------------------------------------------
// Item 9 (review F8): the token's phantom type reaches the component's props.
// These are TYPE-LEVEL assertions — checked by the package's `tsc --noEmit`
// step (test is in the tsconfig include); the `@ts-expect-error` lines fail the
// build if the error they pin disappears. The runtime body is incidental.
// ---------------------------------------------------------------------------

describe("defineIsland — typed props (review F8)", () => {
  const numberSource = defineDataSource<number>("count");

  it("binds a DataSource to a same-typed prop; the island requires the unbound props", () => {
    const Card = defineIsland({
      name: "Card",
      component: (props: { count: number; title: string }) =>
        createElement("div", null, `${props.title}: ${props.count}`),
      data: { count: numberSource },
    });

    // The returned island accepts ONLY the unbound remainder (`title`), with the
    // bound `count` removed.
    expectTypeOf(Card).parameter(0).toEqualTypeOf<{ title: string }>();

    // Supplying `title` is valid…
    createElement(Card, { title: "Hello" });

    // …omitting it is a compile error (it is required)…
    // @ts-expect-error — `title` is required on the unbound remainder.
    createElement(Card, {});

    // …and passing the bound prop is rejected (data supplies it, not the caller).
    // @ts-expect-error — `count` is bound by data; the caller must not pass it.
    createElement(Card, { title: "Hello", count: 3 });
  });

  it("rejects binding a DataSource<number> to a string prop (mismatched phantom type)", () => {
    defineIsland({
      name: "Bad",
      component: (props: { count: string }) => createElement("span", null, props.count),
      // @ts-expect-error — DataSource<number> cannot feed a `string` prop.
      data: { count: numberSource },
    });
  });

  it("flows P straight through when there is no data (every prop required of the caller)", () => {
    const Plain = defineIsland({
      name: "Plain",
      component: (props: { a: number; b: string }) =>
        createElement("span", null, `${props.a}${props.b}`),
    });

    expectTypeOf(Plain).parameter(0).toEqualTypeOf<{ a: number; b: string }>();
  });
});

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
    expect(html).not.toContain("__voloData");
  });
});

describe("hydrateDocumentIslands — client scan + mount", () => {
  it("scans the mount scripts and hydrates each island with its primed data", async () => {
    paint(Account);

    // Server painted the fallback; the primer kicked the fetch (here pre-primed).
    expect(document.body.querySelector(".fallback")).not.toBeNull();
    window.__voloData = { session: Promise.resolve({ name: "Ada" }) };

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

  it("survives a stale mount script naming a renamed component — others hydrate (deploy skew)", () => {
    const Plain = defineIsland({
      name: "Plain",
      component: () => createElement("span", { className: "plain-live" }, "live"),
    });

    // Two islands: a known one and a stale mount script the bundle no longer
    // registers (a renamed-then-redeployed island in a CDN-cached document).
    document.body.innerHTML =
      `<div ${ISLAND_ATTR}="known"></div>` +
      `<script type="application/json" ${ISLAND_MOUNT_ATTR}="">` +
      `{"id":"known","component":"Plain","props":{},"ssr":false}</script>` +
      `<div ${ISLAND_ATTR}="stale"></div>` +
      `<script type="application/json" ${ISLAND_MOUNT_ATTR}="">` +
      `{"id":"stale","component":"Renamed","props":{},"ssr":false}</script>`;

    const errors: unknown[] = [];

    let result!: ReturnType<typeof hydrateDocumentIslands>;
    act(() => {
      result = hydrateDocumentIslands(new Registry().defineClient(Plain.island), {
        onMountError: (error) => errors.push(error),
      });
    });

    // The renamed island failed (routed), the known one still mounted.
    expect(result.mounted).toEqual(["known"]);
    expect(result.failed).toEqual(["stale"]);
    expect((errors[0] as UiError).code).toBe("UI_ISLAND_UNKNOWN_COMPONENT");
    expect(document.body.querySelector(".plain-live")).not.toBeNull();
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
