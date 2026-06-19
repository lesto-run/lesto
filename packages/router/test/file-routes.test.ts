import { describe, expect, it } from "vitest";

import {
  compileFileRoutes,
  type DiscoveredFile,
  type FileRoute,
  ROUTE_FILE_NAMES,
  RouterError,
} from "../src/index";

/** A page file at the given raw segments — the scanner's output shape. */
const page = (...segments: string[]): DiscoveredFile => ({ kind: "page", segments });

/** A layout file at the given raw segments. */
const layout = (...segments: string[]): DiscoveredFile => ({ kind: "layout", segments });

/** The page descriptors compileFileRoutes returned, in its resolution order. */
const pagesOf = (files: readonly DiscoveredFile[]): readonly FileRoute[] =>
  compileFileRoutes(files).filter((route) => route.kind === "page");

/** The layout descriptors, in compile order. */
const layoutsOf = (files: readonly DiscoveredFile[]): readonly FileRoute[] =>
  compileFileRoutes(files).filter((route) => route.kind === "layout");

describe("ROUTE_FILE_NAMES", () => {
  it("maps the two recognized base names to their kinds", () => {
    expect(ROUTE_FILE_NAMES).toEqual({ page: "page", layout: "layout" });
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
    expect(() => compileFileRoutes([page("[]")])).toThrowError(
      /neither a literal name nor a "\[param\]"/,
    );
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
      expect((error as RouterError).details).toEqual({ pattern: "/about" });
    }
  });

  it("allows a page and a layout at the same directory", () => {
    const routes = compileFileRoutes([page("listings"), layout("listings")]);

    expect(routes).toHaveLength(2);
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
