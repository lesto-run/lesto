import { describe, expect, it } from "vitest";

import {
  BOUNDARY_KINDS,
  compileFileRoutes,
  type DiscoveredFile,
  type FileRoute,
  ROUTE_FILE_NAMES,
  RouteTable,
  RouterError,
} from "../src/index";

/** A page file at the given raw segments — the scanner's output shape. */
const page = (...segments: string[]): DiscoveredFile => ({ kind: "page", segments });

/** A layout file at the given raw segments. */
const layout = (...segments: string[]): DiscoveredFile => ({ kind: "layout", segments });

/** A loading boundary file at the given raw segments. */
const loading = (...segments: string[]): DiscoveredFile => ({ kind: "loading", segments });

/** An error boundary file at the given raw segments. */
const errorFile = (...segments: string[]): DiscoveredFile => ({ kind: "error", segments });

/** A not-found boundary file at the given raw segments. */
const notFound = (...segments: string[]): DiscoveredFile => ({ kind: "not-found", segments });

/** The page descriptors compileFileRoutes returned, in its resolution order. */
const pagesOf = (files: readonly DiscoveredFile[]): readonly FileRoute[] =>
  compileFileRoutes(files).filter((route) => route.kind === "page");

/** The layout descriptors, in compile order. */
const layoutsOf = (files: readonly DiscoveredFile[]): readonly FileRoute[] =>
  compileFileRoutes(files).filter((route) => route.kind === "layout");

describe("ROUTE_FILE_NAMES", () => {
  it("maps every recognized base name to its kind", () => {
    expect(ROUTE_FILE_NAMES).toEqual({
      page: "page",
      layout: "layout",
      loading: "loading",
      error: "error",
      "not-found": "not-found",
    });
  });
});

describe("compileFileRoutes — pattern derivation", () => {
  it("compiles the root page to '/'", () => {
    expect(pagesOf([page()])[0]?.pattern).toBe("/");
  });

  it("compiles a static segment to a literal path", () => {
    expect(pagesOf([page("about")])[0]?.pattern).toBe("/about");
  });

  it("compiles nested static segments to a joined path", () => {
    expect(pagesOf([page("blog", "archive")])[0]?.pattern).toBe("/blog/archive");
  });

  it("compiles a [param] directory to a :param segment", () => {
    expect(pagesOf([page("listings", "[id]")])[0]?.pattern).toBe("/listings/:id");
  });

  it("compiles a deep mix of static and dynamic segments", () => {
    const route = pagesOf([page("posts", "[postId]", "comments", "[id]")])[0];

    expect(route?.pattern).toBe("/posts/:postId/comments/:id");
  });

  it("accepts an underscore-led param name", () => {
    expect(pagesOf([page("u", "[_id]")])[0]?.pattern).toBe("/u/:_id");
  });

  it("accepts a dot and dash in a static segment", () => {
    expect(pagesOf([page("files.v2-beta")])[0]?.pattern).toBe("/files.v2-beta");
  });
});

describe("compileFileRoutes — malformed segments refuse by code", () => {
  it("refuses a bare unclosed bracket", () => {
    try {
      compileFileRoutes([page("[id")]);

      expect.unreachable("a malformed segment should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).code).toBe("ROUTER_FILE_BAD_SEGMENT");
      expect((error as RouterError).details).toEqual({ segment: "[id" });
    }
  });

  it("refuses an empty [] dynamic segment", () => {
    expect(() => compileFileRoutes([page("[]")])).toThrowError(/is neither a literal name/);
  });

  it("refuses a param name starting with a digit", () => {
    expect(() => compileFileRoutes([page("[1bad]")])).toThrowError(RouterError);
  });

  it("refuses a segment with a stray bracket among letters", () => {
    expect(() => compileFileRoutes([page("a[b")])).toThrowError(RouterError);
  });

  it("refuses a segment with a slash-smuggling character", () => {
    // A space is not in the static-segment set; it must be rejected, not routed.
    expect(() => compileFileRoutes([page("two words")])).toThrowError(RouterError);
  });
});

describe("compileFileRoutes — duplicate routes refuse by code", () => {
  it("refuses two pages that compile to the same pattern", () => {
    try {
      compileFileRoutes([page("about"), page("about")]);

      expect.unreachable("a duplicate route should throw");
    } catch (error) {
      expect((error as RouterError).code).toBe("ROUTER_FILE_DUPLICATE_ROUTE");
      expect((error as RouterError).details).toEqual({ pattern: "/about", shape: "/about" });
    }
  });

  it("refuses two dynamic siblings with DIFFERENT param names (same match-shape)", () => {
    // `[id]/page.tsx` (`/:id`) and `[slug]/page.tsx` (`/:slug`) are different
    // strings but answer the SAME single-segment URL — both reduce to the shape
    // `/*`. A string-equal dedup would let both register and one would permanently
    // shadow the other; the shape dedup refuses the ambiguity instead.
    try {
      compileFileRoutes([page("[id]"), page("[slug]")]);

      expect.unreachable("two siblings of the same match-shape should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).code).toBe("ROUTER_FILE_DUPLICATE_ROUTE");
      // The second page (the one that collides) names itself and the shared shape.
      expect((error as RouterError).details).toEqual({ pattern: "/:slug", shape: "/*" });
    }
  });

  it("allows distinct routes that share a dynamic count but differ in static positions", () => {
    // `files/[id]` (`/files/*`) and `[category]/new` (`/*/new`) both have one
    // dynamic slot at depth 2, yet match DISJOINT URL sets — their shapes differ,
    // so they must NOT be over-rejected as duplicates.
    const routes = pagesOf([page("files", "[id]"), page("[category]", "new")]);

    expect(routes.map((route) => route.pattern).toSorted()).toEqual([
      "/:category/new",
      "/files/:id",
    ]);
  });

  it("allows a page and a layout at the same directory", () => {
    const routes = compileFileRoutes([page("listings"), layout("listings")]);

    expect(routes).toHaveLength(2);
  });
});

describe("compileFileRoutes — duplicate param names refuse by code", () => {
  it("refuses a page that repeats a param across segments", () => {
    // `[id]/[id]/page.tsx` → `/:id/:id`: the deeper capture would silently clobber
    // the shallower, so it is refused at compile time, not minted as a collision.
    try {
      compileFileRoutes([page("[id]", "[id]")]);

      expect.unreachable("a duplicate param name should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).code).toBe("ROUTER_FILE_DUPLICATE_PARAM");
      expect((error as RouterError).details).toEqual({ pattern: "/:id/:id", param: "id" });
    }
  });

  it("allows two DIFFERENT param names across segments", () => {
    // `[postId]/[id]` is fine — distinct names, no collision.
    const route = pagesOf([page("[postId]", "[id]")])[0];

    expect(route?.pattern).toBe("/:postId/:id");
  });
});

describe("compileFileRoutes — layout nesting", () => {
  it("gives a page the depths of every layout above it, shallowest first", () => {
    const files = [layout(), layout("listings"), page("listings", "[id]")];

    const route = pagesOf(files)[0];

    // Root layout at depth 0, section layout at depth 1; the page itself is depth 2
    // and has no layout file, so only 0 and 1.
    expect(route?.layoutDepth).toEqual([0, 1]);
  });

  it("gives a page with no layouts above it an empty layoutDepth", () => {
    expect(pagesOf([page("about")])[0]?.layoutDepth).toEqual([]);
  });

  it("records a layout at the page's own directory", () => {
    // A layout co-located with the page wraps it too (depth === page depth).
    const route = pagesOf([layout("dash"), page("dash")])[0];

    expect(route?.layoutDepth).toEqual([1]);
  });

  it("does not wrap a page under a sibling branch's layout", () => {
    const files = [layout("admin"), page("admin", "users"), page("public")];

    const compiled = compileFileRoutes(files);

    const adminUsers = compiled.find((route) => route.pattern === "/admin/users");
    const publicPage = compiled.find((route) => route.pattern === "/public");

    expect(adminUsers?.layoutDepth).toEqual([1]);
    expect(publicPage?.layoutDepth).toEqual([]);
  });

  it("orders layouts shallowest-first in the returned list", () => {
    const result = layoutsOf([layout("a", "b"), layout(), layout("a")]);

    expect(result.map((route) => route.segments.length)).toEqual([0, 1, 2]);
  });
});

describe("BOUNDARY_KINDS", () => {
  it("lists the directory-scoped kinds (every kind but page)", () => {
    expect([...BOUNDARY_KINDS]).toEqual(["layout", "loading", "error", "not-found"]);
  });
});

describe("compileFileRoutes — boundary resolution (loading / error / not-found)", () => {
  it("gives a page the NEAREST boundary depth of each kind above it", () => {
    // Root loading + a deeper section loading; the page picks the deeper (nearest).
    // A root error and a section not-found each resolve to their one depth.
    const files = [
      loading(),
      loading("listings"),
      errorFile(),
      notFound("listings"),
      page("listings", "[id]"),
    ];

    const route = pagesOf(files)[0];

    // loading: nearest is depth 1 (the section), overriding the root's depth 0.
    // error: only the root's depth 0. not-found: only the section's depth 1.
    expect(route?.boundaries).toEqual({ loading: 1, error: 0, "not-found": 1 });
  });

  it("gives a page with no boundaries above it an empty boundaries record", () => {
    expect(pagesOf([page("about")])[0]?.boundaries).toEqual({});
  });

  it("records a boundary co-located in the page's own directory", () => {
    const route = pagesOf([loading("dash"), errorFile("dash"), page("dash")])[0];

    expect(route?.boundaries).toEqual({ loading: 1, error: 1 });
  });

  it("does not apply a sibling branch's boundary to a page outside it", () => {
    const files = [loading("admin"), page("admin", "users"), page("public")];

    const compiled = compileFileRoutes(files);
    const adminUsers = compiled.find((route) => route.pattern === "/admin/users");
    const publicPage = compiled.find((route) => route.pattern === "/public");

    expect(adminUsers?.boundaries).toEqual({ loading: 1 });
    expect(publicPage?.boundaries).toEqual({});
  });

  it("returns boundary descriptors (no route of their own) ahead of the pages", () => {
    const compiled = compileFileRoutes([page("x"), loading(), errorFile(), notFound()]);

    // Each boundary is a descriptor the applier keys by directory; none is a page.
    const boundaries = compiled.filter((route) => route.kind !== "page");

    expect(boundaries.map((route) => route.kind).toSorted()).toEqual([
      "error",
      "loading",
      "not-found",
    ]);
    // A boundary descriptor carries empty depths — it is never the thing wrapped.
    for (const boundary of boundaries) {
      expect(boundary.layoutDepth).toEqual([]);
      expect(boundary.boundaries).toEqual({});
    }
  });

  it("keeps a boundary out of the page set — it registers no URL", () => {
    const pages = pagesOf([page("docs"), loading("docs"), errorFile("docs"), notFound("docs")]);

    expect(pages.map((route) => route.pattern)).toEqual(["/docs"]);
  });
});

describe("compileFileRoutes — resolution order (most specific first)", () => {
  it("orders a deeper path before a shallower one", () => {
    const order = pagesOf([page("a"), page("a", "b")]).map((route) => route.pattern);

    expect(order).toEqual(["/a/b", "/a"]);
  });

  it("orders a literal sibling before a dynamic one at equal depth", () => {
    const order = pagesOf([page("listings", "[id]"), page("listings", "new")]).map(
      (route) => route.pattern,
    );

    expect(order).toEqual(["/listings/new", "/listings/:id"]);
  });

  it("prefers a literal first segment over a dynamic one when both have a dynamic slot too", () => {
    // `/files/:id` and `/:category/new` tie on depth (2) and dynamic-count (1); the
    // literal-prefix route must still win because its FIRST segment is static. A
    // count- or string-only comparator would mis-order these.
    const order = pagesOf([page("files", "[id]"), page("[category]", "new")]).map(
      (route) => route.pattern,
    );

    expect(order).toEqual(["/files/:id", "/:category/new"]);
  });

  it("routes /files/new to the literal-prefix route, not the dynamic one", () => {
    // The end-to-end consequence of the order above: registered into a first-match
    // table in resolution order, /files/new resolves to /files/:id (binding the
    // literal `files` segment), never to /:category/new.
    const table = new RouteTable<string>();

    for (const route of pagesOf([page("files", "[id]"), page("[category]", "new")])) {
      table.add("GET", route.pattern, route.pattern);
    }

    expect(table.match("GET", "/files/new")?.value).toBe("/files/:id");
  });

  it("breaks a full tie deterministically on the pattern string", () => {
    // Several equally-specific static siblings, fed out of order: the tie-break
    // sorts them alphabetically regardless of discovery order. More than two
    // elements forces the comparator down BOTH string branches (a<b and a>b), so
    // the ordering is total, not just stable for one pair.
    const order = pagesOf([page("c"), page("a"), page("b")]).map((route) => route.pattern);

    expect(order).toEqual(["/a", "/b", "/c"]);
  });

  it("puts layouts ahead of pages in the combined list", () => {
    const kinds = compileFileRoutes([page("x"), layout()]).map((route) => route.kind);

    expect(kinds).toEqual(["layout", "page"]);
  });
});

describe("compileFileRoutes — catch-all segments", () => {
  it("compiles [...slug] to a greedy *slug catch-all", () => {
    expect(pagesOf([page("docs", "[...slug]")])[0]?.pattern).toBe("/docs/*slug");
  });

  it("compiles [[...slug]] to an optional *slug? catch-all", () => {
    expect(pagesOf([page("docs", "[[...slug]]")])[0]?.pattern).toBe("/docs/*slug?");
  });

  it("accepts a root catch-all", () => {
    expect(pagesOf([page("[...rest]")])[0]?.pattern).toBe("/*rest");
  });

  it("refuses a catch-all that is not the final segment", () => {
    try {
      compileFileRoutes([page("[...slug]", "more")]);

      expect.unreachable("a non-terminal catch-all should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).code).toBe("ROUTER_FILE_CATCHALL_POSITION");
      expect((error as RouterError).details).toEqual({
        pattern: "/*slug/more",
        segment: "[...slug]",
      });
    }
  });

  it("refuses an optional catch-all that is not the final segment", () => {
    expect(() => compileFileRoutes([page("[[...slug]]", "more")])).toThrowError(
      expect.objectContaining({ code: "ROUTER_FILE_CATCHALL_POSITION" }),
    );
  });

  it("refuses a name shared between a [param] and a [...catchAll]", () => {
    try {
      compileFileRoutes([page("[id]", "[...id]")]);

      expect.unreachable("a duplicate param name should throw");
    } catch (error) {
      expect((error as RouterError).code).toBe("ROUTER_FILE_DUPLICATE_PARAM");
      expect((error as RouterError).details).toEqual({ pattern: "/:id/*id", param: "id" });
    }
  });

  it("refuses a required and an optional catch-all that answer the same URLs", () => {
    try {
      compileFileRoutes([page("[...a]"), page("[[...b]]")]);

      expect.unreachable("two catch-alls of one shape should throw");
    } catch (error) {
      expect((error as RouterError).code).toBe("ROUTER_FILE_DUPLICATE_ROUTE");
      expect((error as RouterError).details).toEqual({ pattern: "/*b?", shape: "/**" });
    }
  });

  it("keeps a catch-all and a single dynamic at one depth as distinct routes", () => {
    // `/docs/*rest` (shape `/docs/**`) and `/docs/:id` (shape `/docs/*`) differ, so
    // they are NOT over-rejected as duplicates — they resolve by specificity.
    const patterns = pagesOf([page("docs", "[...rest]"), page("docs", "[id]")])
      .map((route) => route.pattern)
      .toSorted();

    expect(patterns).toEqual(["/docs/*rest", "/docs/:id"]);
  });
});

describe("compileFileRoutes — route groups", () => {
  it("strips a (group) directory from the URL", () => {
    expect(pagesOf([page("(marketing)", "about")])[0]?.pattern).toBe("/about");
  });

  it("compiles a group that holds only the root page to '/'", () => {
    expect(pagesOf([page("(marketing)")])[0]?.pattern).toBe("/");
  });

  it("keeps the raw segments (group included) for the applier to key by", () => {
    expect(pagesOf([page("(marketing)", "about")])[0]?.segments).toEqual(["(marketing)", "about"]);
  });

  it("nests a group's layout by its directory like any other", () => {
    const route = pagesOf([layout("(marketing)"), page("(marketing)", "about")])[0];

    expect(route?.layoutDepth).toEqual([1]);
  });

  it("does not let a group change a param or its specificity", () => {
    expect(pagesOf([page("(g)", "p", "[id]")])[0]?.pattern).toBe("/p/:id");
  });

  it("refuses two groups that wrap the same URL (a real duplicate)", () => {
    try {
      compileFileRoutes([page("(a)", "about"), page("(b)", "about")]);

      expect.unreachable("a group-induced duplicate should throw");
    } catch (error) {
      expect((error as RouterError).code).toBe("ROUTER_FILE_DUPLICATE_ROUTE");
      expect((error as RouterError).details).toEqual({ pattern: "/about", shape: "/about" });
    }
  });

  it("refuses an empty () group as a bad segment", () => {
    expect(() => compileFileRoutes([page("()")])).toThrowError(
      expect.objectContaining({ code: "ROUTER_FILE_BAD_SEGMENT" }),
    );
  });
});

describe("compileFileRoutes — catch-all resolution order", () => {
  it("sinks a catch-all below its non-catch-all siblings, regardless of input order", () => {
    const forward = pagesOf([
      page("docs", "[...rest]"),
      page("docs", "intro"),
      page("docs", "[id]"),
    ]).map((route) => route.pattern);

    const reverse = pagesOf([
      page("docs", "intro"),
      page("docs", "[id]"),
      page("docs", "[...rest]"),
    ]).map((route) => route.pattern);

    expect(forward).toEqual(["/docs/intro", "/docs/:id", "/docs/*rest"]);
    expect(reverse).toEqual(["/docs/intro", "/docs/:id", "/docs/*rest"]);
  });

  it("orders a deeper catch-all before a shallower one", () => {
    const order = pagesOf([page("a", "[...x]"), page("a", "b", "[...y]")]).map(
      (route) => route.pattern,
    );

    expect(order).toEqual(["/a/b/*y", "/a/*x"]);
  });

  it("breaks a tie between two catch-alls on the pattern string", () => {
    const order = pagesOf([page("b", "[...y]"), page("a", "[...x]")]).map((route) => route.pattern);

    expect(order).toEqual(["/a/*x", "/b/*y"]);
  });

  it("orders the root page behind any deeper page", () => {
    expect(pagesOf([page(), page("about")]).map((route) => route.pattern)).toEqual(["/about", "/"]);
  });

  it("lets an optional catch-all and its parent page coexist, the parent winning its own URL", () => {
    const table = new RouteTable<string>();

    for (const route of pagesOf([page("shop"), page("shop", "[[...slug]]")])) {
      table.add("GET", route.pattern, route.pattern);
    }

    // The explicit page answers its own URL; the catch-all answers everything deeper.
    expect(table.match("GET", "/shop")?.value).toBe("/shop");
    expect(table.match("GET", "/shop/winter/boots")?.value).toBe("/shop/*slug?");
  });
});
