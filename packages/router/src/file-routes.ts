/**
 * File-based routing — a convention that compiles a directory tree into the same
 * `:param` patterns the rest of `@lesto/router` already matches.
 *
 * Every peer meta-framework lets you drop a file at a path and get a route; this
 * is Lesto's version, and it is deliberately THIN. It owns one job: read the shape
 * of a conventional directory (`app/` by default) and turn it into an ordered list
 * of {@link FileRoute} descriptors — a URL pattern, the kind of file, and the
 * layout chain that wraps it. It does NOT load modules, touch a `Lesto` builder,
 * or render anything; the impure half (importing each module, calling `.page()` /
 * `.layout()`) lives in `@lesto/web`'s `applyFileRoutes`, over THESE descriptors.
 * Keeping the path math here, pure and over an injected reader, is what makes the
 * whole convention unit-testable with no filesystem.
 *
 * THE CONVENTION (a strict subset of the Next/Remix/SvelteKit family):
 *
 *   app/
 *     layout.tsx            → a layout wrapping every route under app/
 *     page.tsx              → the route "/"
 *     about/
 *       page.tsx            → the route "/about"
 *     listings/
 *       layout.tsx          → a layout wrapping every route under /listings
 *       page.tsx            → the route "/listings"
 *       [id]/
 *         page.tsx          → the route "/listings/:id"  (typed param `id`)
 *
 * A segment is a directory name. A `[name]` directory is a dynamic segment that
 * compiles to `:name` — so the typed-param machinery (`ParamKeys`/`PathParams`)
 * the code-first router already has flows through unchanged: the URL the page
 * registers at is an ordinary pattern string. A `page` file at a directory makes
 * that directory's URL a page; a `layout` file makes one that wraps every page at
 * or below it, outermost-first (the directory depth order layouts must nest in).
 *
 * Co-existence is the whole point: these descriptors become ordinary `.page()` /
 * `.layout()` registrations on the SAME `Lesto` instance an app declares its
 * programmatic routes on, so a file-route and a hand-written route live side by
 * side with no second router.
 */

import { RouterError } from "./errors";

/**
 * The recognized file kinds at a directory. A `page` makes the directory's URL a
 * route; a `layout` wraps every route at or below it. Anything else under the
 * convention dir is ignored, so a co-located helper (`listing-card.tsx`, a test,
 * a stylesheet) is not mistaken for a route.
 */
export type FileRouteKind = "page" | "layout";

/**
 * The base names (without extension) that name each kind, in the order a reader
 * surfaces matter not at all — the kind is decided by the name, never position.
 * Exported so the impure scanner and its tests agree on exactly which files count.
 */
export const ROUTE_FILE_NAMES: Readonly<Record<string, FileRouteKind>> = Object.freeze({
  page: "page",
  layout: "layout",
});

/**
 * One discovered module under the convention dir, as the injected reader yields
 * it: the kind (page/layout) and the chain of URL SEGMENTS from the convention
 * root to its directory.
 *
 * Segments are the raw directory names, NOT yet compiled to a pattern — `["app"]`
 * is omitted (the reader yields paths relative to the convention root), so
 * `app/listings/[id]/page.tsx` arrives as `{ kind: "page", segments: ["listings",
 * "[id]"] }`. The root `app/page.tsx` arrives as `{ kind: "page", segments: [] }`.
 * Keeping segments raw lets {@link compileFileRoutes} own the one place a `[id]`
 * becomes `:id`, so the rule is tested once.
 */
export interface DiscoveredFile {
  kind: FileRouteKind;

  /** The directory segments from the convention root to this file's directory. */
  segments: ReadonlyArray<string>;
}

/**
 * A compiled file route: the URL pattern it registers at, its kind, and — for a
 * page — the layout depths that wrap it (outermost first).
 *
 * `pattern` is an ordinary `@lesto/router` pattern (`/listings/:id`), so it feeds
 * `.page()` / `RouteTable.add` and inherits the same compilation, matching, and
 * typed-param inference as a hand-written route. `layoutDepth` is present only on a
 * `page` and lists the segment depths whose `layout` file wraps it, shallowest
 * first — the order layouts must nest in (a root layout outside a section layout
 * outside the page). The applier reads it to build each page's layout chain.
 */
export interface FileRoute {
  kind: FileRouteKind;

  pattern: string;

  /** The directory segments (raw, uncompiled) this file lives at — for the applier to key a module by. */
  segments: ReadonlyArray<string>;

  /**
   * The depths (0 = root) of the `layout` files that wrap this route, shallowest
   * first — the order they must nest in (root outside section outside page).
   *
   * Always present, so the applier reads it with no fallback: a page with no
   * layouts above it gets `[]`, and a `layout` descriptor gets `[]` too (the
   * applier never wraps a layout in layouts — only a `page` is registered). Making
   * it total rather than page-only keeps the consumer branch-free.
   */
  layoutDepth: ReadonlyArray<number>;
}

// A dynamic segment is a directory named `[name]`; it compiles to `:name`. The
// name must be a valid param identifier, the same `[A-Za-z_][A-Za-z0-9_]*` the
// runtime pattern compiler captures (see `compile.ts`'s `PARAM_SEGMENT`), so the
// derived pattern is one the router will actually accept.
const DYNAMIC_SEGMENT = /^\[([A-Za-z_][A-Za-z0-9_]*)\]$/;

// A static segment is one or more path-safe characters with no bracket, slash, or
// the param colon — a literal directory name. Refusing anything else here turns a
// stray `[`/`]` (a malformed dynamic segment like `[id` or `[1bad]`) into a coded
// error at compile time, not a silently-wrong route.
const STATIC_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Compile one raw directory segment into its pattern piece: `[id]` → `:id`, a
 * literal name → itself, anything malformed → a coded refusal.
 *
 * The dynamic case reuses the router's own param grammar so a `[id]` directory
 * yields exactly the `:id` a hand-written route would, typed params and all. A
 * segment that is neither a clean literal nor a well-formed `[param]` (a bare `[`,
 * an empty `[]`, a `[1bad]` starting with a digit) is a convention mistake the
 * author must fix — surfaced by a stable `ROUTER_FILE_BAD_SEGMENT`, not compiled
 * into a route that can never match.
 */
function compileSegment(segment: string): string {
  const dynamic = DYNAMIC_SEGMENT.exec(segment);

  if (dynamic !== null) {
    // `dynamic[1]` is the bracketed name; the regex guarantees it is present and
    // a valid identifier, so it becomes the `:param` verbatim.
    return `:${dynamic[1] as string}`;
  }

  if (STATIC_SEGMENT.test(segment)) {
    return segment;
  }

  throw new RouterError(
    "ROUTER_FILE_BAD_SEGMENT",
    `File-route segment "${segment}" is neither a literal name nor a "[param]" — rename the directory to a valid segment.`,
    { segment },
  );
}

/**
 * Turn a chain of raw directory segments into a URL pattern.
 *
 * The empty chain (the convention root's own `page`/`layout`) is the site root
 * `"/"`. Otherwise each segment is compiled (`[id]` → `:id`) and joined under a
 * leading slash, so `["listings", "[id]"]` becomes `/listings/:id` — the exact
 * pattern string the code-first `.page()` would have taken.
 */
function patternFor(segments: ReadonlyArray<string>): string {
  if (segments.length === 0) return "/";

  return `/${segments.map(compileSegment).join("/")}`;
}

/**
 * The key a route is grouped by, so two files at the SAME directory (a `page` and
 * its sibling `layout`) and two files at DIFFERENT directories never collide. The
 * raw segments joined by `/` — `["listings", "[id]"]` → `"listings/[id]"`, the
 * empty root → `""` — uniquely names a directory.
 */
const dirKey = (segments: ReadonlyArray<string>): string => segments.join("/");

/**
 * Compile a flat list of {@link DiscoveredFile}s into ordered {@link FileRoute}s
 * ready for the applier to register, oldest-convention rules enforced here once.
 *
 * What this owns, so the impure scanner does not:
 *
 *   - **Pattern derivation.** Each file's segments become a URL pattern, with the
 *     one `[id]` → `:id` rule (and the malformed-segment refusal) living here.
 *
 *   - **Layout nesting.** A page's `layoutDepth` lists the depths of every
 *     `layout` at or above its directory, shallowest first — the order layouts
 *     must wrap in. A `layout` at depth N wraps a page at depth ≥ N whose path
 *     passes through that directory; because the directory tree is a prefix tree,
 *     "wraps" is exactly "the page's segments start with the layout's segments."
 *
 *   - **Collision refusal.** Two `page` files compiling to the SAME pattern (e.g.
 *     a literal `about/` directory and a `[slug]/` that both yield `/about` for
 *     some value — or, more simply, a duplicated discovery) is a convention
 *     ambiguity the author must resolve; we refuse it with a coded
 *     `ROUTER_FILE_DUPLICATE_ROUTE` rather than let insertion order silently pick
 *     a winner.
 *
 *   - **Resolution order.** Pages are returned MOST-SPECIFIC FIRST: a deeper /
 *     more-static path before a shallower / more-dynamic one, so a literal route
 *     shadows a dynamic sibling at the same depth (`/listings/new` before
 *     `/listings/:id`) and the first-match-wins `RouteTable` resolves the way an
 *     author expects without hand-ordering files.
 */
export function compileFileRoutes(files: ReadonlyArray<DiscoveredFile>): ReadonlyArray<FileRoute> {
  // Guard against two pages at one URL: compile each page's pattern and refuse a
  // duplicate by code rather than let the later one silently shadow the earlier.
  const seenPattern = new Set<string>();

  const pages: FileRoute[] = [];
  const layouts: FileRoute[] = [];

  for (const file of files) {
    const pattern = patternFor(file.segments);

    if (file.kind === "layout") {
      // A layout descriptor carries an empty `layoutDepth`: it is never the thing
      // wrapped (only a page is registered), so it has no layouts of its own — but
      // the field is total, so the applier reads every descriptor branch-free.
      layouts.push({ kind: "layout", pattern, segments: file.segments, layoutDepth: [] });

      continue;
    }

    if (seenPattern.has(pattern)) {
      throw new RouterError(
        "ROUTER_FILE_DUPLICATE_ROUTE",
        `Two file-routes compile to the same pattern "${pattern}" — two pages cannot answer one URL.`,
        { pattern },
      );
    }

    seenPattern.add(pattern);

    pages.push({
      kind: "page",
      pattern,
      segments: file.segments,
      layoutDepth: layoutDepthsFor(file.segments, files),
    });
  }

  // Most-specific first: a deeper path before a shallower one, and at equal depth
  // a more-static path (fewer dynamic segments) before a more-dynamic one. The
  // first-match-wins table then resolves a literal route ahead of a dynamic
  // sibling without the author hand-ordering anything.
  pages.sort(comparePageSpecificity);

  // Layouts trail the pages; the applier registers each layout (in shallowest-
  // first order) before the pages it wraps, but the descriptor order between the
  // two groups is the applier's to interleave — here we just keep layouts grouped
  // and depth-ordered so the applier can lean on it.
  layouts.sort((a, b) => a.segments.length - b.segments.length);

  return [...layouts, ...pages];
}

/**
 * The depths of every `layout` at or above a page's directory, shallowest first.
 *
 * A layout wraps a page when the page's directory is the layout's directory or a
 * descendant of it — which, on a prefix tree of segments, is exactly "the page's
 * segments start with the layout's segments." We walk the page's own segment
 * prefixes (root, then one segment, then two, …) and record the depth of any that
 * has a `layout` file, so the result is naturally shallowest-first — the order the
 * layouts must nest in (root outside section outside page).
 */
function layoutDepthsFor(
  pageSegments: ReadonlyArray<string>,
  files: ReadonlyArray<DiscoveredFile>,
): ReadonlyArray<number> {
  const layoutKeys = new Set(
    files.filter((file) => file.kind === "layout").map((file) => dirKey(file.segments)),
  );

  const depths: number[] = [];

  // Each prefix length 0..pageSegments.length names a directory on the path from
  // the root to the page; a layout there wraps the page.
  for (let depth = 0; depth <= pageSegments.length; depth += 1) {
    const key = dirKey(pageSegments.slice(0, depth));

    if (layoutKeys.has(key)) {
      depths.push(depth);
    }
  }

  return depths;
}

/** How many segments of a pattern are dynamic (`:param`) — the specificity penalty. */
function dynamicCount(segments: ReadonlyArray<string>): number {
  return segments.filter((segment) => DYNAMIC_SEGMENT.test(segment)).length;
}

/**
 * Order two pages most-specific first.
 *
 * Deeper paths win (more segments = more specific), then — at equal depth — the
 * one with FEWER dynamic segments wins, so `/listings/new` (zero dynamic) sorts
 * ahead of `/listings/:id` (one dynamic) and the literal route shadows the param
 * route under first-match resolution. A final tie breaks on the pattern string so
 * the sort is stable and deterministic across reader orderings.
 *
 * The two pages compared here always have DISTINCT patterns — an exact-pattern
 * duplicate is refused upstream with `ROUTER_FILE_DUPLICATE_ROUTE` before the sort
 * runs — so the final string comparison need only choose a side, never report
 * "equal"; `< ? -1 : 1` is total over the distinct-pattern inputs the sort sees.
 */
function comparePageSpecificity(a: FileRoute, b: FileRoute): number {
  if (a.segments.length !== b.segments.length) {
    return b.segments.length - a.segments.length;
  }

  const dynamicDelta = dynamicCount(a.segments) - dynamicCount(b.segments);

  if (dynamicDelta !== 0) return dynamicDelta;

  return a.pattern < b.pattern ? -1 : 1;
}
