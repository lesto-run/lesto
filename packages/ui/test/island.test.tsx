import { describe, expect, it } from "vitest";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { createElement } from "react";

import {
  island,
  ISLAND_ATTR,
  Registry,
  renderPage,
  renderPageMarkup,
  renderTree,
  UiError,
  validateTree,
} from "../src/index";
import type { ClientComponentDef, ComponentDef } from "../src/index";

// ---------------------------------------------------------------------------
// Fixtures: a server container plus a couple of client components (islands).
// ---------------------------------------------------------------------------

const Box: ComponentDef = {
  name: "Box",
  props: {},
  children: true,
  render: (_props, children) => createElement("div", { className: "box" }, children),
};

const Account: ClientComponentDef = {
  name: "Account",
  description: "Resolves the signed-in user on the client.",
  props: { plan: { type: "string", required: true } },
  component: (props) => createElement("span", null, `signed in: ${props.plan as string}`),
  fallback: (props) => createElement("span", null, `loading ${props.plan as string}`),
};

// An island with no declared props and no fallback — the minimal case.
const Ping: ClientComponentDef = {
  name: "Ping",
  component: () => createElement("span", null, "pong"),
};

function registry(): Registry {
  return new Registry().define(Box).defineClient(Account).defineClient(Ping);
}

/** Pull the `data-keel-island` ids out of rendered HTML, in order. */
function islandIdsIn(html: string): string[] {
  return [...html.matchAll(/data-keel-island="([^"]*)"/g)].map((m) => m[1] as string);
}

// ---------------------------------------------------------------------------
// island() authoring helper
// ---------------------------------------------------------------------------

describe("island()", () => {
  it("is sugar for a plain node with type and props", () => {
    expect(island("Account", { plan: "pro" })).toEqual({
      type: "Account",
      props: { plan: "pro" },
    });
  });

  it("defaults props to an empty bag", () => {
    expect(island("Ping")).toEqual({ type: "Ping", props: {} });
  });
});

// ---------------------------------------------------------------------------
// Registry: client components share the namespace, last write wins.
// ---------------------------------------------------------------------------

describe("Registry client components", () => {
  it("registers, looks up, and lists client components", () => {
    const r = registry();

    expect(r.hasClient("Account")).toBe(true);
    expect(r.getClient("Account")).toBe(Account);
    expect(r.getClient("Missing")).toBeUndefined();
    expect(r.clients()).toEqual([Account, Ping]);
  });

  it("lets a client component shadow a server component of the same name", () => {
    const r = new Registry().define(Box).defineClient({ ...Ping, name: "Box" });

    expect(r.has("Box")).toBe(false);
    expect(r.hasClient("Box")).toBe(true);
  });

  it("lets a server component shadow a client component of the same name", () => {
    const r = new Registry().defineClient(Ping).define({ ...Box, name: "Ping" });

    expect(r.hasClient("Ping")).toBe(false);
    expect(r.has("Ping")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderPage: HTML + manifest.
// ---------------------------------------------------------------------------

describe("renderPage", () => {
  it("renders an island wrapper with its fallback and records the manifest", () => {
    const tree = { type: "Box", children: ["hi ", island("Account", { plan: "pro" })] };

    const page = renderPage(registry(), tree);

    expect(page.errors).toEqual([]);

    const html = renderToStaticMarkup(page.element);

    expect(html).toBe(
      '<div class="box">hi <div data-keel-island="$.children[1]">' +
        "<span>loading pro</span></div></div>",
    );

    expect(page.islands).toEqual([
      { id: "$.children[1]", component: "Account", props: { plan: "pro" }, ssr: false },
    ]);
  });

  it("renders an island with no props and no fallback as an empty shell", () => {
    const page = renderPage(registry(), island("Ping"));

    expect(renderToStaticMarkup(page.element)).toBe('<div data-keel-island="$"></div>');
    expect(page.islands).toEqual([{ id: "$", component: "Ping", props: {}, ssr: false }]);
  });

  it("renders an island node written without a props key", () => {
    // A hand-written island node — no `props` key at all — exercises the
    // empty-props fallback the `island()` helper would otherwise fill in.
    const page = renderPage(registry(), { type: "Ping" });

    expect(page.islands).toEqual([{ id: "$", component: "Ping", props: {}, ssr: false }]);
  });

  it("degrades a genuinely unknown component (neither server nor client)", () => {
    const page = renderPage(registry(), { type: "Nope" });

    expect(page.element).toBeNull();
    expect(page.errors).toEqual([{ path: "$", type: "unknown_component" }]);
    expect(page.islands).toEqual([]);
  });

  it("supports nested islands, each with its own stable id", () => {
    const tree = {
      type: "Box",
      children: [island("Account", { plan: "a" }), island("Account", { plan: "b" })],
    };

    const page = renderPage(registry(), tree);

    const html = renderToStaticMarkup(page.element);

    expect(islandIdsIn(html)).toEqual(["$.children[0]", "$.children[1]"]);
    expect(page.islands.map((m) => m.props.plan)).toEqual(["a", "b"]);

    // Every manifest id is present as a wrapper in the HTML — the pairing the
    // client relies on holds.
    expect(page.islands.map((m) => m.id)).toEqual(islandIdsIn(html));
  });

  it("validates island props against the client schema (default applied)", () => {
    const r = new Registry().defineClient({
      ...Account,
      props: { plan: { type: "string", default: "free", required: true } },
    });

    const page = renderPage(r, island("Account"));

    expect(page.islands).toEqual([
      { id: "$", component: "Account", props: { plan: "free" }, ssr: false },
    ]);
  });

  it("contains a non-serializable prop as a render error, rendering nothing", () => {
    // `Ping` declares no prop schema, so props pass straight through to the wire
    // — the serialize guard is the only gate, and a function trips it.
    const page = renderPage(registry(), island("Ping", { onClick: () => undefined }));

    expect(page.islands).toEqual([]);
    expect(page.errors).toEqual([{ path: "$", type: "render_threw" }]);
    expect(renderToStaticMarkup(page.element)).toBe("");
  });

  it("passes island props through verbatim when there is no schema", () => {
    const page = renderPage(registry(), island("Ping", { anything: { nested: [1, 2] } }));

    expect(page.islands).toEqual([
      { id: "$", component: "Ping", props: { anything: { nested: [1, 2] } }, ssr: false },
    ]);
  });

  it("renders an ssr island's REAL component server-side and flags ssr in the manifest", () => {
    // An `ssr` island ships its real output (the markup the client will hydrate),
    // NOT a fallback — so hydrateRoot finds a match. The manifest says ssr: true.
    const Stamp: ClientComponentDef = {
      name: "Stamp",
      ssr: true,
      props: { label: { type: "string", required: true } },
      component: (props) => createElement("strong", null, props.label as string),
      // A fallback is declared but MUST be ignored when ssr is true.
      fallback: () => createElement("em", null, "FALLBACK"),
    };

    const r = new Registry().define(Box).defineClient(Stamp);

    const page = renderPage(r, { type: "Box", children: [island("Stamp", { label: "live" })] });

    const html = renderToStaticMarkup(page.element);

    expect(html).toBe(
      '<div class="box"><div data-keel-island="$.children[0]"><strong>live</strong></div></div>',
    );
    expect(html).not.toContain("FALLBACK");

    expect(page.islands).toEqual([
      { id: "$.children[0]", component: "Stamp", props: { label: "live" }, ssr: true },
    ]);
  });

  it("builds an ssr island's element lazily so React runs the real component", () => {
    // An ssr island's `component` is a full React component (it may use hooks), so
    // it is placed LAZILY: building the page never throws — the component runs
    // only when React renders the element, exactly like a server component. A
    // throwing island therefore surfaces at `renderToStaticMarkup`, not at build.
    const Boom: ClientComponentDef = {
      name: "Boom",
      ssr: true,
      component: () => {
        throw new Error("kaboom");
      },
    };

    const page = renderPage(new Registry().defineClient(Boom), island("Boom"));

    // Building the tree did not throw, and the island is in the manifest.
    expect(page.errors).toEqual([]);
    expect(page.islands).toEqual([{ id: "$", component: "Boom", props: {}, ssr: true }]);

    // The throw lives in React's render of the lazily-placed component.
    expect(() => renderToStaticMarkup(page.element)).toThrow("kaboom");
  });
});

// ---------------------------------------------------------------------------
// renderPageMarkup: pick the renderer the page's hydration contract requires.
// An ssr island needs renderToString (it emits the `<!-- -->` text markers
// hydrateRoot walks); a markerless renderToStaticMarkup would mismatch on the
// common interpolated-text shape. No ssr island → static markup is fine.
// ---------------------------------------------------------------------------

describe("renderPageMarkup", () => {
  // An ssr component whose render interpolates text: TWO adjacent text segments
  // under one parent — the shape that needs (and exposes) the text markers.
  const Greet: ClientComponentDef = {
    name: "Greet",
    ssr: true,
    props: { name: { type: "string", required: true } },
    component: (props) => createElement("p", null, "Hi, ", props.name as string, "!"),
  };

  it("renders an ssr-island page with renderToString so hydration markers survive", () => {
    const r = new Registry().define(Box).defineClient(Greet);
    const page = renderPage(r, { type: "Box", children: [island("Greet", { name: "Ada" })] });

    const html = renderPageMarkup(page);

    // The `<!-- -->` markers between adjacent text segments are present — exactly
    // what hydrateRoot needs and what renderToStaticMarkup would have stripped.
    expect(html).toContain("Hi, <!-- -->Ada<!-- -->!");
    // Equals the renderToString output, NOT the markerless static one.
    expect(html).toBe(renderToString(page.element));
    expect(html).not.toBe(renderToStaticMarkup(page.element));
  });

  it("renders a page with no ssr islands with renderToStaticMarkup", () => {
    // A deferred (ssr:false) island ships only a fallback the client replaces
    // wholesale, so its markers are irrelevant; the page stays static markup.
    const page = renderPage(registry(), {
      type: "Box",
      children: [island("Account", { plan: "pro" })],
    });

    const html = renderPageMarkup(page);

    expect(html).toBe(renderToStaticMarkup(page.element));
    expect(page.islands.every((m) => !m.ssr)).toBe(true);
  });

  it("renders a pure-static page (no islands) with renderToStaticMarkup", () => {
    const page = renderPage(registry(), { type: "Box", children: ["hello"] });

    expect(renderPageMarkup(page)).toBe(renderToStaticMarkup(page.element));
  });

  it("returns an empty string when the page element degraded to null", () => {
    // An unknown root component degrades to a null element — there is no body.
    const page = renderPage(registry(), { type: "DoesNotExist" });

    expect(page.element).toBeNull();
    expect(renderPageMarkup(page)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// renderTree: islands render their fallback, but no manifest is collected.
// ---------------------------------------------------------------------------

describe("renderTree with islands", () => {
  it("renders the island shell identically but exposes no manifest", () => {
    const tree = { type: "Box", children: [island("Account", { plan: "pro" })] };

    const viaTree = renderTree(registry(), tree);
    const viaPage = renderPage(registry(), tree);

    expect(viaTree.errors).toEqual([]);

    // The HTML is byte-for-byte the page's HTML — `renderTree` is unchanged for
    // every existing caller; islands simply degrade to their static fallback.
    expect(renderToStaticMarkup(viaTree.element)).toBe(renderToStaticMarkup(viaPage.element));
  });
});

// ---------------------------------------------------------------------------
// validateTree: islands validate against the client schema, and are leaves.
// ---------------------------------------------------------------------------

describe("validateTree with islands", () => {
  it("accepts a well-formed island", () => {
    const tree = { type: "Box", children: [island("Account", { plan: "pro" })] };

    expect(validateTree(registry(), tree)).toEqual({ valid: true, errors: [] });
  });

  it("flags a missing required island prop", () => {
    const { valid, errors } = validateTree(registry(), { type: "Account" });

    expect(valid).toBe(false);
    expect(errors).toEqual([
      { path: "$", type: "invalid_props", detail: 'missing required prop "plan"' },
    ]);
  });

  it("accepts a schema-less island with no props or children", () => {
    // `Ping` declares no prop schema; a bare `{ type: "Ping" }` validates with
    // nothing to check — the empty-schema and absent-children fallbacks.
    expect(validateTree(registry(), { type: "Ping" })).toEqual({ valid: true, errors: [] });
  });

  it("forbids children on an island (the client owns its insides)", () => {
    const tree = {
      type: "Account",
      props: { plan: "pro" },
      children: [{ type: "Box" }, "text"],
    };

    const { errors } = validateTree(registry(), tree);

    expect(errors).toEqual([
      { path: "$.children[0]", type: "disallowed_child", detail: "Box" },
      { path: "$.children[1]", type: "disallowed_child", detail: "string" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Serialization guard: the wire contract, reported by path.
// ---------------------------------------------------------------------------

// Drive the guard end-to-end through renderPage on a schema-less island (props
// pass straight to the wire), reporting whether it stayed clean or was contained
// as a render error. "render_threw" is renderPage's containment of the thrown
// UI_ISLAND_PROPS_NOT_SERIALIZABLE; the error itself is asserted separately below.
function serializeOutcome(props: Record<string, unknown>): "ok" | "render_threw" {
  const r = new Registry().defineClient({
    name: "Probe",
    component: () => createElement("span"),
  });

  const page = renderPage(r, { type: "Probe", props });

  return page.errors.length === 0 ? "ok" : "render_threw";
}

describe("island prop serialization guard", () => {
  it("accepts pure-JSON props: primitives, arrays, nested plain objects", () => {
    expect(
      serializeOutcome({
        s: "x",
        n: 1,
        b: true,
        nil: null,
        list: [1, "two", { three: 3 }],
        nested: { a: { b: [true, null] } },
      }),
    ).toBe("ok");
  });

  it.each([
    ["a function", { f: () => undefined }],
    ["a symbol", { sym: Symbol("nope") }],
    ["a bigint", { big: 10n }],
    ["undefined", { u: undefined }],
    ["a non-finite number", { bad: Number.NaN }],
    ["a Date (non-plain object)", { when: new Date() }],
    ["a function nested in an array", { list: [1, () => undefined] }],
    ["a function nested in an object", { obj: { ok: 1, bad: () => undefined } }],
  ])("rejects %s", (_label, props) => {
    expect(serializeOutcome(props)).toBe("render_threw");
  });
});

// ---------------------------------------------------------------------------
// The serialization UiError itself — code, path, frozen details.
// ---------------------------------------------------------------------------

describe("UI_ISLAND_PROPS_NOT_SERIALIZABLE", () => {
  it("carries a stable code and the offending path in frozen details", async () => {
    const { assertSerializable } = await import("../src/serialize");

    try {
      assertSerializable("Account", { user: { profile: { render: () => undefined } } });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UiError);
      expect((error as UiError).code).toBe("UI_ISLAND_PROPS_NOT_SERIALIZABLE");
      expect((error as UiError).details).toEqual({
        component: "Account",
        path: "props.user.profile.render",
      });
      expect(Object.isFrozen((error as UiError).details)).toBe(true);
    }
  });

  it("returns the props unchanged when everything is serializable", async () => {
    const { assertSerializable } = await import("../src/serialize");

    const props = { plan: "pro", seats: [1, 2] };

    expect(assertSerializable("Account", props)).toBe(props);
  });
});

// Keep the ISLAND_ATTR export honest — it is the one string both sides agree on.
describe("ISLAND_ATTR", () => {
  it("is the marker attribute used on every island wrapper", () => {
    const html = renderToStaticMarkup(renderPage(registry(), island("Ping")).element);

    expect(html).toContain(`${ISLAND_ATTR}="$"`);
  });
});
