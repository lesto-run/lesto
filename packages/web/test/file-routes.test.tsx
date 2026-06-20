import { createElement } from "react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { DiscoveredFile } from "@lesto/router";

import { applyFileRoutes, routeKey } from "../src/file-routes";
import type { LoadedFileRoutes, LoadedRouteModule } from "../src/file-routes";
import { lesto } from "../src/lesto";
import type { PageDef } from "../src/render-page";
import { WebError } from "../src/errors";
import type { LestoResponse } from "../src/types";

/** Drain a streamed response body to a string for HTML assertions. */
async function drain(response: LestoResponse): Promise<string> {
  const stream = response.body as unknown as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let out = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    out += decoder.decode(value, { stream: true });
  }

  return out + decoder.decode();
}

const page = (...segments: string[]): DiscoveredFile => ({ kind: "page", segments });
const layout = (...segments: string[]): DiscoveredFile => ({ kind: "layout", segments });

// Module-scope marker components — hoisted out of the `it` bodies (they capture
// nothing) so each is defined once, not recreated per call.
const Home = (): ReactNode => createElement("h1", null, "home");
const About = (): ReactNode => createElement("h1", null, "about");
const Dash = (): ReactNode => createElement("span", null, "dash");
const Leaf = (): ReactNode => createElement("span", null, "leaf");
const Listings = (): ReactNode => createElement("span", null, "listings");
const Marker = (): ReactNode => createElement("span", null, "x");
const Listing = ({ id }: { id: string }): ReactNode => createElement("h1", null, `listing ${id}`);

/** A page module whose component renders a marker, plus any extra PageDef fields. */
function pageModule(
  component: PageDef["component"],
  extra: Partial<PageDef> = {},
): LoadedRouteModule {
  return { default: { component, ...extra } };
}

/** A layout module wrapping its children in a named div, so nesting is visible in the HTML. */
function layoutModule(id: string): LoadedRouteModule {
  const Wrap = ({ children }: { children: ReactNode }) => createElement("div", { id }, children);

  return { default: Wrap };
}

/** Build a modules map from (file, module) pairs, keyed the way the loader would. */
function moduleMap(
  ...entries: ReadonlyArray<[DiscoveredFile, LoadedRouteModule]>
): LoadedFileRoutes {
  return new Map(entries.map(([file, module]) => [routeKey(file.kind, file.segments), module]));
}

/** A user's GET routes, with the framework's built-in beacon endpoints filtered out. */
const userGetRoutes = (
  app: ReturnType<typeof lesto>,
): ReadonlyArray<{ method: string; pattern: string }> =>
  app.routes().filter((route) => route.method === "GET" && !route.pattern.startsWith("/__lesto"));

describe("routeKey", () => {
  it("keys a page and a layout in the same directory distinctly", () => {
    expect(routeKey("page", ["listings"])).toBe("page:listings");
    expect(routeKey("layout", ["listings"])).toBe("layout:listings");
  });

  it("keys the root with an empty directory", () => {
    expect(routeKey("page", [])).toBe("page:");
  });
});

describe("applyFileRoutes", () => {
  it("registers a page at its compiled pattern and renders it", async () => {
    const home = page();
    const app = applyFileRoutes(lesto(), [home], moduleMap([home, pageModule(Home)]));

    expect(app.routes()).toContainEqual({ method: "GET", pattern: "/" });

    const html = await drain(await app.handle("GET", "/"));

    expect(html).toContain("<h1>home</h1>");
  });

  it("accepts the named-export form: a default-export component with no named exports", async () => {
    // The Next/Remix idiom — `export default` the component, nothing else. The
    // module's `default` is the function itself, not a PageDef object.
    const home = page();
    const app = applyFileRoutes(lesto(), [home], moduleMap([home, { default: Home }]));

    const html = await drain(await app.handle("GET", "/"));

    expect(html).toContain("<h1>home</h1>");
  });

  it("folds named load / params / metadata / static / cache into the PageDef", async () => {
    // The full named-export form: default component + every cross-cutting concern
    // as a named export. `load` feeds the component, `metadata` derives the head.
    const listing = page("listings", "[id]");
    const mod: LoadedRouteModule = {
      default: Listing,
      load: (c) => ({ id: c.param("id") }),
      params: z.object({}),
      metadata: () => ({ title: "Listing page" }),
      static: false,
      cache: "public",
    };
    const app = applyFileRoutes(lesto(), [listing], moduleMap([listing, mod]));

    const html = await drain(await app.handle("GET", "/listings/42"));

    expect(html).toContain("<h1>listing 42</h1>"); // load → component props
    expect(html).toContain("<title>Listing page</title>"); // named metadata applied
  });

  it("returns the same app so file-routes chain with programmatic ones", () => {
    const base = lesto().get("/api/health", (c) => c.json({ ok: true }));

    const home = page();
    const app = applyFileRoutes(base, [home], moduleMap([home, pageModule(Home)]));

    expect(app).toBe(base);
    expect(app.routes()).toContainEqual({ method: "GET", pattern: "/api/health" });
    expect(app.routes()).toContainEqual({ method: "GET", pattern: "/" });
  });

  it("flows a typed [param] through to the page's c.param", async () => {
    const listing = page("listings", "[id]");
    const app = applyFileRoutes(
      lesto(),
      [listing],
      moduleMap([
        listing,
        pageModule(Listing as PageDef["component"], { load: (c) => ({ id: c.param("id") }) }),
      ]),
    );

    expect(app.routes()).toContainEqual({ method: "GET", pattern: "/listings/:id" });

    const html = await drain(await app.handle("GET", "/listings/42"));

    expect(html).toContain("<h1>listing 42</h1>");
  });

  it("wraps a page in the root layout above it", async () => {
    const rootLayout = layout();
    const dash = page("dash");

    const app = applyFileRoutes(
      lesto(),
      [rootLayout, dash],
      moduleMap([rootLayout, layoutModule("root")], [dash, pageModule(Dash)]),
    );

    const html = await drain(await app.handle("GET", "/dash"));

    expect(html).toContain('<div id="root">');
    expect(html).toContain("<span>dash</span>");
  });

  it("nests multiple layouts outermost-first around the page", async () => {
    const rootLayout = layout();
    const adminLayout = layout("admin");
    const adminUsers = page("admin", "users");

    const app = applyFileRoutes(
      lesto(),
      [rootLayout, adminLayout, adminUsers],
      moduleMap(
        [rootLayout, layoutModule("root")],
        [adminLayout, layoutModule("admin")],
        [adminUsers, pageModule(Leaf)],
      ),
    );

    const html = await drain(await app.handle("GET", "/admin/users"));

    // Assert the nesting order by substring position: root outside admin outside leaf.
    const rootAt = html.indexOf('<div id="root">');
    const adminAt = html.indexOf('<div id="admin">');
    const leafAt = html.indexOf("<span>leaf</span>");

    expect(rootAt).toBeGreaterThanOrEqual(0);
    expect(rootAt).toBeLessThan(adminAt);
    expect(adminAt).toBeLessThan(leafAt);
  });

  it("wraps a page in a layout co-located in its own directory", async () => {
    // A page and a layout share the `listings/` directory — keyed distinctly, both load.
    const listingsLayout = layout("listings");
    const listings = page("listings");

    const app = applyFileRoutes(
      lesto(),
      [listingsLayout, listings],
      moduleMap([listingsLayout, layoutModule("section")], [listings, pageModule(Listings)]),
    );

    const html = await drain(await app.handle("GET", "/listings"));

    expect(html).toContain('<div id="section">');
    expect(html).toContain("<span>listings</span>");
  });

  it("registers a page with no layouts without wrapping", async () => {
    const about = page("about");
    const app = applyFileRoutes(lesto(), [about], moduleMap([about, pageModule(About)]));

    const html = await drain(await app.handle("GET", "/about"));

    expect(html).toContain("<h1>about</h1>");
    expect(html).not.toContain('<div id="root">');
  });

  it("registers only pages — a layout descriptor adds no route of its own", () => {
    const listingsLayout = layout("listings");
    const listings = page("listings");

    const app = applyFileRoutes(
      lesto(),
      [listingsLayout, listings],
      moduleMap([listingsLayout, layoutModule("section")], [listings, pageModule(Listings)]),
    );

    expect(userGetRoutes(app)).toEqual([{ method: "GET", pattern: "/listings" }]);
  });

  it("refuses a page whose module was not loaded, by code", () => {
    try {
      applyFileRoutes(lesto(), [page("orphan")], new Map());

      expect.unreachable("a missing module should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WebError);
      expect((error as WebError).code).toBe("WEB_FILE_ROUTE_MODULE_MISSING");
      expect((error as WebError).details).toEqual({
        key: "page:orphan",
        kind: "page",
        pattern: "/orphan",
      });
    }
  });

  it("names the root in the missing-module message when the directory is empty", () => {
    try {
      applyFileRoutes(lesto(), [page()], new Map());

      expect.unreachable("a missing root module should throw");
    } catch (error) {
      expect((error as WebError).message).toContain("<root>");
    }
  });

  it("refuses a page whose layout module was not loaded, by code", () => {
    // The page module is present, but the root layout the descriptor references is not.
    const rootLayout = layout();
    const x = page("x");

    try {
      applyFileRoutes(lesto(), [rootLayout, x], moduleMap([x, pageModule(Marker)]));

      expect.unreachable("a missing layout module should throw");
    } catch (error) {
      expect((error as WebError).code).toBe("WEB_FILE_ROUTE_MODULE_MISSING");
      expect((error as WebError).details).toEqual({
        key: "layout:",
        kind: "layout",
        pattern: "/x",
      });
    }
  });
});
