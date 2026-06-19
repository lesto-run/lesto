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
 *
 * Exported so the two halves of the convention — the pure compiler here and the
 * impure applier in `@lesto/web` — key directories the SAME way; a drift between
 * them would mis-pair a page with its layout. Kept in ONE place, tested once.
 */
export const dirKey = (segments: ReadonlyArray<string>): string => segments.join("/");

/**
 * The MATCH-SHAPE key of a compiled pattern: every `:param` segment normalized to a
 * single `STAR` sentinel, static segments kept literal — `/:id` and `/:slug` both
 * become `/STAR`, while `/files/:id` becomes `/files/STAR` and `/:category/new`
 * becomes `/STAR/new` (the sentinel written here as `STAR` for the param wildcard).
 *
 * Two patterns share a shape iff they match exactly the same SET of URLs (same
 * arity, same static segments at the same positions, a dynamic slot wherever
 * either has one). Deduping on this — not the literal pattern string — is what
 * catches two dynamic siblings with DIFFERENT param names (`[id]` vs `[slug]`):
 * their patterns differ as strings but answer the same single-segment URL, so one
 * would permanently shadow the other. The sentinel is not a legal pattern
 * character (params are `:name`, statics are `STATIC_SEGMENT`), so it can never
 * collide with a literal segment an author wrote.
 */
function matchShape(pattern: string): string {
  return pattern.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "*");
}

/**
 * Refuse a page whose `[name]` directories repeat a param name across segments.
 *
 * `[id]/[id]/page.tsx` compiles to `/:id/:id`; at match time the deeper `:id`
 * overwrites the shallower one in the params record, a silent collision a typed
 * convention must not allow (it already rejects two params in one segment via
 * `ROUTER_AMBIGUOUS_SEGMENT`). We scan the page's own segments and throw a coded
 * `ROUTER_FILE_DUPLICATE_PARAM` on the first repeat, naming the offending param.
 */
function assertNoDuplicateParam(segments: ReadonlyArray<string>, pattern: string): void {
  const seen = new Set<string>();

  for (const segment of segments) {
    const dynamic = DYNAMIC_SEGMENT.exec(segment);

    if (dynamic === null) continue;

    const name = dynamic[1] as string;

    if (seen.has(name)) {
      throw new RouterError(
        "ROUTER_FILE_DUPLICATE_PARAM",
        `File-route "${pattern}" uses the param ":${name}" twice — the deeper segment would silently shadow the shallower; rename one directory.`,
        { pattern, param: name },
      );
    }

    seen.add(name);
  }
}

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
 *   - **Collision refusal.** Two `page` files sharing a MATCH SHAPE — the pattern
 *     with every `:param` normalized to `*`, so `/:id` and `/:slug` both reduce to
 *     `/*` — answer the same set of URLs and are a convention ambiguity the author
 *     must resolve; we refuse it with a coded `ROUTER_FILE_DUPLICATE_ROUTE` rather
 *     than let insertion order silently pick a winner (a string-equal check would
 *     miss two dynamic siblings with different param names). A literal `about/` and
 *     a `[slug]/` are NOT duplicates — `/about` and `/*` are distinct shapes
 *     resolved by precedence, not refused here. A page that repeats a param across
 *     segments (`[id]/[id]`) is refused too, by `ROUTER_FILE_DUPLICATE_PARAM`.
 *
 *   - **Resolution order.** Pages are returned MOST-SPECIFIC FIRST: a deeper /
 *     more-static path before a shallower / more-dynamic one, so a literal route
 *     shadows a dynamic sibling whose first differing segment sits at the same
 *     position (`/listings/new` before `/listings/:id`, `/files/new` before
 *     `/:category/new`) and the first-match-wins `RouteTable` resolves the way an
 *     author expects without hand-ordering files.
 */
export function compileFileRoutes(files: ReadonlyArray<DiscoveredFile>): ReadonlyArray<FileRoute> {
  // Guard against two pages at one URL: key each page by its MATCH SHAPE (every
  // `:param` normalized to `*`) and refuse a duplicate by code rather than let the
  // later one silently shadow the earlier. Deduping on the shape — not the literal
  // pattern — catches two dynamic siblings with different param names (`[id]` vs
  // `[slug]`), which match the same URLs yet differ as strings, while leaving
  // genuinely distinct routes (`files/[id]` vs `[category]/new`) untouched.
  const seenShape = new Set<string>();

  // The directory of every `layout` file, computed once: a page's layout chain is
  // the subset of these that prefix its path, so the lookup is built ahead of the
  // loop rather than rebuilt per page.
  const layoutKeys = new Set(
    files.filter((file) => file.kind === "layout").map((file) => dirKey(file.segments)),
  );

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

    const shape = matchShape(pattern);

    if (seenShape.has(shape)) {
      throw new RouterError(
        "ROUTER_FILE_DUPLICATE_ROUTE",
        `Two file-routes share the match-shape "${shape}" (this one is "${pattern}") — they answer the same URLs, so two pages cannot disambiguate; rename one directory.`,
        { pattern, shape },
      );
    }

    // A `[id]` in two different segments (`[id]/[id]/page.tsx`) compiles to
    // `/:id/:id`, where the deeper capture silently clobbers the shallower at match
    // time. A typed-param convention must not mint that collision — refuse by code,
    // mirroring the single-segment ambiguity `compile` already rejects.
    assertNoDuplicateParam(file.segments, pattern);

    seenShape.add(shape);

    pages.push({
      kind: "page",
      pattern,
      segments: file.segments,
      layoutDepth: layoutDepthsFor(file.segments, layoutKeys),
    });
  }

  // Most-specific first: a deeper path before a shallower one, and at equal depth
  // the path whose first differing segment is static (not `:param`) before the
  // dynamic one. The first-match-wins table then resolves a literal route ahead of
  // a dynamic sibling without the author hand-ordering anything.
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
  layoutKeys: ReadonlySet<string>,
): ReadonlyArray<number> {
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

/**
 * Order two pages most-specific first.
 *
 * Deeper paths win (more segments = more specific). At equal depth the comparison
 * is POSITION-AWARE: walk the two segment arrays slot-by-slot and, at the first
 * position where one segment is static and the other dynamic, the STATIC one wins
 * — so `/files/new` (static-then-static) sorts ahead of `/:category/new`, and
 * `/listings/new` ahead of `/listings/:id`, the literal route shadowing a dynamic
 * sibling AT THAT POSITION under first-match resolution. A whole-path
 * static-vs-static (or otherwise identical-shape) pair falls back to the pattern
 * string so the sort is stable and deterministic across reader orderings.
 *
 * The two pages compared here always have DISTINCT patterns — two pages that share
 * a match-shape (so necessarily an exact-pattern duplicate too) are refused upstream
 * with `ROUTER_FILE_DUPLICATE_ROUTE` before the sort runs — so the final string
 * comparison need only choose a side, never report "equal"; `< ? -1 : 1` is total
 * over the distinct-pattern inputs the sort sees.
 */
function comparePageSpecificity(a: FileRoute, b: FileRoute): number {
  if (a.segments.length !== b.segments.length) {
    return b.segments.length - a.segments.length;
  }

  // Equal depth: at the first slot where one side is static and the other dynamic,
  // the static segment is more specific and sorts earlier.
  for (let i = 0; i < a.segments.length; i += 1) {
    const aDynamic = DYNAMIC_SEGMENT.test(a.segments[i] as string);
    const bDynamic = DYNAMIC_SEGMENT.test(b.segments[i] as string);

    if (aDynamic !== bDynamic) return aDynamic ? 1 : -1;
  }

  return a.pattern < b.pattern ? -1 : 1;
}
