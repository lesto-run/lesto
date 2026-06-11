import { describe, expect, it } from "vitest";

import {
  DATA_ROUTE_PREFIX,
  dataPrimerScript,
  dataSourceHref,
  defineDataSource,
  resolveIslandData,
  UiError,
} from "../src/index";
import type { IslandMount } from "../src/index";

describe("defineDataSource", () => {
  it("returns a token carrying just the name", () => {
    const source = defineDataSource<{ id: string }>("session");

    expect(source).toEqual({ name: "session" });
  });

  it.each(["a/b", "a b", "", "a.b", "sess!on", "../escape"])(
    "rejects the unsafe name %j (it is a URL segment and a script literal)",
    (name) => {
      try {
        defineDataSource(name);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(UiError);
        expect((error as UiError).code).toBe("UI_INVALID_DATA_SOURCE_NAME");
        expect((error as UiError).details).toEqual({ name });
      }
    },
  );

  it.each(["session", "cart_count", "user-id", "ABC123"])("accepts the safe name %j", (name) => {
    expect(defineDataSource(name).name).toBe(name);
  });
});

describe("dataSourceHref", () => {
  it("is the auto-exposed route for the source", () => {
    expect(dataSourceHref("session")).toBe("/__keel/data/session");
    expect(DATA_ROUTE_PREFIX).toBe("/__keel/data/");
  });
});

// A manifest entry with a bind, as buildIsland would emit for a `data` island.
function bound(id: string, bind: NonNullable<IslandMount["bind"]>): IslandMount {
  return { id, component: "Account", props: { static: 1 }, ssr: false, bind };
}

describe("dataPrimerScript", () => {
  it("is empty for a manifest with no binds (a data-free page emits no primer)", () => {
    expect(dataPrimerScript([{ id: "$", component: "X", props: {}, ssr: false }])).toBe("");
    expect(dataPrimerScript([])).toBe("");
  });

  it("kicks one credentialed fetch per distinct source onto window.__keelData", () => {
    const script = dataPrimerScript([
      bound("$.a", { session: { source: "session", href: "/__keel/data/session" } }),
    ]);

    expect(script).toBe(
      "(function(){var w=window.__keelData=window.__keelData||{};" +
        'w["session"]=fetch("/__keel/data/session",{credentials:"same-origin"})' +
        ".then(function(r){return r.json()});})()",
    );
  });

  it("deduplicates a source bound by several islands to a single fetch", () => {
    const script = dataPrimerScript([
      bound("$.a", { session: { source: "session", href: "/__keel/data/session" } }),
      bound("$.b", { session: { source: "session", href: "/__keel/data/session" } }),
      bound("$.c", { cart: { source: "cart", href: "/__keel/data/cart" } }),
    ]);

    expect(script.match(/fetch\(/g)).toHaveLength(2);
    expect(script).toContain('w["session"]=');
    expect(script).toContain('w["cart"]=');
  });
});

describe("resolveIslandData", () => {
  it("is a no-op for a manifest with no binds", async () => {
    const manifest: IslandMount[] = [{ id: "$", component: "X", props: { a: 1 }, ssr: false }];

    await resolveIslandData(manifest, () => "unused");

    expect(manifest).toEqual([{ id: "$", component: "X", props: { a: 1 }, ssr: false }]);
  });

  it("inlines resolved values into props and strips the bind (the dynamic tier)", async () => {
    const manifest = [
      bound("$.a", { session: { source: "session", href: "/__keel/data/session" } }),
    ];

    await resolveIslandData(manifest, (source) =>
      source === "session" ? { id: "jade", name: "Jade" } : undefined,
    );

    expect(manifest[0]).toEqual({
      id: "$.a",
      component: "Account",
      props: { static: 1, session: { id: "jade", name: "Jade" } },
      ssr: false,
    });
    expect(manifest[0]?.bind).toBeUndefined();
  });

  it("leaves an unbound island on the page untouched (mixed manifest)", async () => {
    const manifest: IslandMount[] = [
      { id: "$.static", component: "Hero", props: { title: "Homes" }, ssr: false },
      bound("$.account", { session: { source: "session", href: "/__keel/data/session" } }),
    ];

    await resolveIslandData(manifest, () => ({ id: "x", name: "X" }));

    // The data-free island is byte-identical; only the bound one gained its value.
    expect(manifest[0]).toEqual({
      id: "$.static",
      component: "Hero",
      props: { title: "Homes" },
      ssr: false,
    });
    expect(manifest[1]?.props["session"]).toEqual({ id: "x", name: "X" });
  });

  it("runs each distinct source's loader exactly once, even when bound twice", async () => {
    const calls: string[] = [];

    const manifest = [
      bound("$.a", { session: { source: "session", href: "/__keel/data/session" } }),
      bound("$.b", { session: { source: "session", href: "/__keel/data/session" } }),
    ];

    await resolveIslandData(manifest, (source) => {
      calls.push(source);

      return Promise.resolve(`v:${source}`);
    });

    expect(calls).toEqual(["session"]); // one loader run, fanned out to both islands
    expect(manifest[0]?.props["session"]).toBe("v:session");
    expect(manifest[1]?.props["session"]).toBe("v:session");
  });
});
