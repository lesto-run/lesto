import { createElement } from "react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { DiscoveredFile } from "@lesto/router";

import {
  applyFileRoutes,
  generateRouteManifest,
  loadFileRoutes,
  routeKey,
} from "../src/file-routes";
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

describe("loadFileRoutes", () => {
  it("loads each discovered file through the injected loader, keyed for the applier", async () => {
    const home = page();
    const rootLayout = layout();

    const loaded = await loadFileRoutes([rootLayout, home], async (kind) =>
      kind === "page" ? { default: Home } : layoutModule("root"),
    );

    expect(loaded.get(routeKey("page", []))).toEqual({ default: Home });
    expect(loaded.get(routeKey("layout", []))?.default).toBeTypeOf("function");
  });

  it("composes scan → load → apply end to end (a named-export page, wrapped in its layout)", async () => {
    // `loadFileRoutes`'s loader stands in for the CLI's real `import()`. This is
    // the whole "drop a file → it routes" pipeline minus the filesystem walk
    // (`scanRoutes`, covered in @lesto/router): a discovered layout + page, loaded
    // and applied, render the named-export page wrapped in its layout, head and all.
    const rootLayout = layout();
    const posts = page("posts");
    const files = [rootLayout, posts];

    const modules = await loadFileRoutes(files, async (kind) =>
      kind === "layout"
        ? layoutModule("root")
        : { default: Home, metadata: () => ({ title: "Posts" }) },
    );

    const app = applyFileRoutes(lesto(), files, modules);
    const html = await drain(await app.handle("GET", "/posts"));

    expect(html).toContain('<div id="root">'); // the layout wrap
    expect(html).toContain("<h1>home</h1>"); // the page component (named-export default)
    expect(html).toContain("<title>Posts</title>"); // the named metadata export, applied
  });

  it("re-raises a coded error, naming the file, when a route module fails to load", async () => {
    // A throw / bad import inside a page file must surface as a coded error that
    // names the file — not abort the whole command with a raw stack.
    await expect(
      loadFileRoutes([page()], async () => {
        throw new Error("kaboom inside the route file");
      }),
    ).rejects.toMatchObject({ code: "WEB_FILE_ROUTE_LOAD_FAILED" });

    // A non-Error throw is stringified into the message, never crashes the loader.
    await expect(
      loadFileRoutes([page("blog")], async () => {
        throw { reason: "boom" };
      }),
    ).rejects.toBeInstanceOf(WebError);
  });
});

describe("generateRouteManifest", () => {
  it("emits static imports + a files list + a keyed module map, sorted and deterministic", () => {
    const src = generateRouteManifest(
      [page("lab", "gallery", "[id]"), layout(), page("lab", "gallery")],
      {
        importBase: "../app/routes",
      },
    );

    // One static import per file (the edge bundler must see these), path = importBase/…segments/kind.
    expect(src).toContain('import * as m0 from "../app/routes/layout";');
    expect(src).toContain('import * as m1 from "../app/routes/lab/gallery/page";');
    expect(src).toContain('import * as m2 from "../app/routes/lab/gallery/[id]/page";');

    // The map, keyed exactly as the applier looks up (routeKey), in sorted order.
    expect(src).toContain('["layout:", m0 as LoadedRouteModule]');
    expect(src).toContain('["page:lab/gallery", m1 as LoadedRouteModule]');
    expect(src).toContain('["page:lab/gallery/[id]", m2 as LoadedRouteModule]');

    // The raw-segment files list the applier compiles.
    expect(src).toContain('{ kind: "page", segments: ["lab","gallery","[id]"] }');

    // Deterministic: a different input order yields byte-identical output.
    const reordered = generateRouteManifest(
      [layout(), page("lab", "gallery"), page("lab", "gallery", "[id]")],
      { importBase: "../app/routes" },
    );
    expect(reordered).toBe(src);
  });

  it("emits a RoutePath union + @lesto/ui augmentation from the page patterns", () => {
    const src = generateRouteManifest(
      [page("lab", "gallery", "[id]"), layout(), page("lab", "gallery")],
      { importBase: "../app/routes" },
    );

    // RoutePath (the <Link href> form): a static page → a string-literal member; a
    // `:param` page → a template-literal with each param a `${string}` slot (so an
    // interpolated href matches). A `layout` contributes no URL and so no member.
    expect(src).toContain("export type RoutePath =");
    expect(src).toContain('| "/lab/gallery"');
    expect(src).toContain("| `/lab/gallery/${string}`");

    // RoutePattern (the route(pattern, params) form): the SAME patterns with `:param`
    // KEPT, so `PathParams` can read the param names.
    expect(src).toContain("export type RoutePattern =");
    expect(src).toContain('| "/lab/gallery/:id"');

    // The seam @lesto/ui's `RegisteredRoutes` reads by declaration merging — `href`
    // for `<Link>` autocomplete, `pattern` for the typed `route()` builder.
    expect(src).toContain('declare module "@lesto/ui" {');
    expect(src).toContain("interface RegisteredRoutes {");
    expect(src).toContain("href: RoutePath;");
    expect(src).toContain("pattern: RoutePattern;");
  });

  it("emits a valid, import-free manifest for an empty tree", () => {
    const src = generateRouteManifest([], { importBase: "../app/routes" });

    expect(src).toContain("export const files: readonly DiscoveredFile[] = [");
    expect(src).toContain(
      "export const modules: LoadedFileRoutes = new Map<string, LoadedRouteModule>([",
    );
    expect(src).not.toContain("import * as m");

    // No pages → `RoutePath`/`RoutePattern` are `never`, so the @lesto/ui augmentation
    // leaves a codegen-less app's `href` and `route()` unconstrained (the default).
    expect(src).toContain("export type RoutePath = never;");
    expect(src).toContain("export type RoutePattern = never;");
  });

  it("refuses a tree the runtime applier would reject (no manifest that throws at apply)", () => {
    // A catch-all before the end is rejected by the compiler; codegen must fail
    // HERE, not emit a manifest that bundles cleanly then throws the moment it is
    // applied.
    expect(() =>
      generateRouteManifest([page("[...rest]", "more")], { importBase: "../app/routes" }),
    ).toThrow();
  });

  it("emits ${string} RoutePath + a `*catch-all` RoutePattern for a catch-all page", () => {
    const src = generateRouteManifest([page("docs", "[...slug]")], {
      importBase: "../app/routes",
    });

    // The href form collapses the greedy tail to a single `${string}` slot, so a
    // deep `/docs/a/b` link matches; the pattern form keeps `*slug`, so `PathParams`
    // can read the catch-all name (and type it `string[]`).
    expect(src).toContain("| `/docs/${string}`");
    expect(src).toContain('| "/docs/*slug"');
  });

  it("strips a (group) directory from the emitted URL but keeps its raw module key", () => {
    const src = generateRouteManifest([page("(marketing)", "about")], {
      importBase: "../app/routes",
    });

    // The URL drops the group; the module import + map key keep the raw segments.
    expect(src).toContain('| "/about"');
    expect(src).toContain('import * as m0 from "../app/routes/(marketing)/about/page";');
    expect(src).toContain('["page:(marketing)/about", m0 as LoadedRouteModule]');
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

  it("refuses a page that default-exports a non-component / non-PageDef, by code", () => {
    const home = page();

    // null (a forgotten component), a bare value, and an object with no component
    // — each a common authoring slip — must be refused at registration, not boot a
    // route that 500s (or renders nothing) per request.
    for (const bad of [null, 42, {}]) {
      try {
        applyFileRoutes(
          lesto(),
          [home],
          moduleMap([home, { default: bad } as unknown as LoadedRouteModule]),
        );
        expect.unreachable(`a ${String(bad)} default should be refused`);
      } catch (error) {
        expect(error).toBeInstanceOf(WebError);
        expect((error as WebError).code).toBe("WEB_FILE_ROUTE_INVALID_PAGE");
      }
    }
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
