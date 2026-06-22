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
 *     docs/
 *       [...slug]/
 *         page.tsx          → the route "/docs/*slug"  (catch-all, `slug: string[]`)
 *     (marketing)/          → a pathless GROUP — adds no URL segment
 *       layout.tsx          → wraps the group's pages without nesting a URL
 *       about/
 *         page.tsx          → the route "/about"  (NOT "/(marketing)/about")
 *
 * A segment is a directory name. A `[name]` directory is a dynamic segment that
 * compiles to `:name`; a `[...name]` is a CATCH-ALL that compiles to the greedy
 * `*name` (one or more trailing segments, a typed `string[]`), and `[[...name]]`
 * its OPTIONAL twin `*name?` (zero or more, so the parent path matches too). A
 * `(name)` directory is a route GROUP: pathless, so it organizes files (and can
 * hold a shared `layout`) without contributing a URL segment. So the typed-param
 * machinery (`ParamKeys`/`PathParams`) the code-first router already has flows
 * through unchanged: the URL the page registers at is an ordinary pattern string.
 * A `page` file at a directory makes that directory's URL a page; a `layout` file
 * makes one that wraps every page at or below it, outermost-first (the directory
 * depth order layouts must nest in — a group's layout nests by its directory like
 * any other). A `loading`, `error`, or `not-found` file is a directory-scoped
 * BOUNDARY: it supplies the nearest Suspense fallback, error boundary, or 404
 * boundary to the page at its directory and below, a deeper file of the same kind
 * overriding the shallower for that subtree.
 *
 * Co-existence is the whole point: these descriptors become ordinary `.page()` /
 * `.layout()` registrations on the SAME `Lesto` instance an app declares its
 * programmatic routes on, so a file-route and a hand-written route live side by
 * side with no second router.
 *
 * A CATCH-ALL is a greedy FALLBACK — mind its registration order. Among file
 * routes it is auto-sorted LAST ({@link compileFileRoutes} sinks it below every
 * non-catch-all), so a file-route tree resolves correctly on its own. But the app
 * matcher is first-match-by-insertion-order (see `RouteTable`), and that sort does
 * NOT reach across to hand-written routes, `.data()` sources, or the built-in
 * `/__lesto/*` endpoints. So a ROOT catch-all (`/*slug`, `app/[[...slug]]`)
 * registered BEFORE those — e.g. `applyFileRoutes(app, …)` then `app.get("/api/…")`
 * — will shadow them (the request hits the catch-all page, not the API/data route).
 * Register specific routes and data sources FIRST, the root catch-all LAST. A
 * SCOPED catch-all (`/blog/*slug`) only covers its own subtree, so it is unaffected.
 */

import { RouterError } from "./errors";

/**
 * The recognized file kinds at a directory. A `page` makes the directory's URL a
 * route; a `layout` wraps every route at or below it. A `loading`, `error`, or
 * `not-found` is a BOUNDARY: like a layout it is directory-scoped (it applies to
 * the page at its directory and every page below, unless a deeper directory
 * overrides it) and registers no route of its own — it only supplies the page's
 * nearest Suspense fallback (`loading`), error boundary (`error`), or 404 boundary
 * (`not-found`). Anything else under the convention dir is ignored, so a co-located
 * helper (`listing-card.tsx`, a test, a stylesheet) is not mistaken for a route.
 */
export type FileRouteKind = "page" | "layout" | "loading" | "error" | "not-found";

/**
 * The DIRECTORY-SCOPED boundary kinds — the ones that, like a `layout`, wrap (or
 * supply a fallback to) the page at their directory and every page below it, with
 * a deeper file of the same kind overriding the shallower for that subtree. A
 * `page` is the only NON-boundary kind. Listed once so the compiler resolves each
 * boundary the SAME way (`nearestBoundary`) rather than repeating the walk per kind.
 */
export const BOUNDARY_KINDS = ["layout", "loading", "error", "not-found"] as const;

/** One of the directory-scoped boundary kinds (everything but `page`). */
export type BoundaryKind = (typeof BOUNDARY_KINDS)[number];

/**
 * The base names (without extension) that name each kind, in the order a reader
 * surfaces matter not at all — the kind is decided by the name, never position.
 * Exported so the impure scanner and its tests agree on exactly which files count.
 */
export const ROUTE_FILE_NAMES: Readonly<Record<string, FileRouteKind>> = Object.freeze({
  page: "page",
  layout: "layout",
  loading: "loading",
  error: "error",
  "not-found": "not-found",
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
   * layouts above it gets `[]`, and a non-`page` descriptor gets `[]` too (the
   * applier never wraps a boundary in layouts — only a `page` is registered).
   * Making it total rather than page-only keeps the consumer branch-free.
   */
  layoutDepth: ReadonlyArray<number>;

  /**
   * The NEAREST boundary of each kind above this route, as the depth of the
   * directory holding it — or absent when no such file sits at or above the page.
   *
   * Unlike `layoutDepth` (the WHOLE chain, because layouts nest), a `loading`,
   * `error`, or `not-found` resolves to a SINGLE boundary — the closest one, with a
   * deeper file overriding a shallower for that subtree — so each is one depth, not
   * a list. The applier reads the depth to look up the boundary's module and wrap
   * the page in it (a Suspense fallback for `loading`, an error boundary for
   * `error`). Present only on a `page` descriptor; a boundary/layout descriptor
   * carries an empty record (it is never the thing wrapped).
   */
  boundaries: BoundaryDepths;
}

/**
 * The nearest boundary depth of each non-layout boundary kind above a page, each
 * absent when no such file sits at or above it. Layouts are NOT here — they nest
 * as a whole chain ({@link FileRoute.layoutDepth}); these three resolve to one
 * nearest file each.
 */
export interface BoundaryDepths {
  loading?: number;
  error?: number;
  "not-found"?: number;
}

// A dynamic segment is a directory named `[name]`; it compiles to `:name`. The
// name must be a valid param identifier, the same `[A-Za-z_][A-Za-z0-9_]*` the
// runtime pattern compiler captures (see `compile.ts`'s `PARAM_SEGMENT`), so the
// derived pattern is one the router will actually accept.
const DYNAMIC_SEGMENT = /^\[([A-Za-z_][A-Za-z0-9_]*)\]$/;

// A catch-all segment `[...name]` compiles to the greedy `*name` (one or more
// trailing segments, captured as a typed `string[]`); its optional twin
// `[[...name]]` to `*name?` (zero or more, so the parent path matches too). The
// inner name is the same param identifier a `[name]` takes.
const CATCH_ALL_SEGMENT = /^\[\.\.\.([A-Za-z_][A-Za-z0-9_]*)\]$/;
const OPTIONAL_CATCH_ALL_SEGMENT = /^\[\[\.\.\.([A-Za-z_][A-Za-z0-9_]*)\]\]$/;

// A route group `(name)` is a PATHLESS directory: it organizes files (and can hold
// a shared `layout`) without contributing a URL segment — `(marketing)/about` is
// the route `/about`. The name only labels the group, so the grammar is lenient.
const GROUP_SEGMENT = /^\(([A-Za-z0-9_-]+)\)$/;

// A static segment is one or more path-safe characters with no bracket, paren,
// slash, or the param colon — a literal directory name. Refusing anything else here
// turns a stray `[`/`]` (a malformed dynamic segment like `[id` or `[1bad]`) into a
// coded error at compile time, not a silently-wrong route.
const STATIC_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** A `(group)` directory contributes no URL segment — it is stripped before compiling. */
const isGroupSegment = (segment: string): boolean => GROUP_SEGMENT.test(segment);

/** A `[...rest]` or `[[...rest]]` directory — a catch-all (the greedy, trailing kind). */
const isCatchAllSegment = (segment: string): boolean =>
  CATCH_ALL_SEGMENT.test(segment) || OPTIONAL_CATCH_ALL_SEGMENT.test(segment);

/**
 * The param NAME a raw directory segment binds, or `undefined` for a static or
 * group segment. A `[id]`, `[...id]`, and `[[...id]]` all bind `id` — so the
 * duplicate-name guard catches a name repeated across ANY of these forms, not just
 * across two `[id]`s.
 */
function paramNameOf(segment: string): string | undefined {
  const optional = OPTIONAL_CATCH_ALL_SEGMENT.exec(segment);

  if (optional !== null) return optional[1] as string;

  const catchAll = CATCH_ALL_SEGMENT.exec(segment);

  if (catchAll !== null) return catchAll[1] as string;

  const dynamic = DYNAMIC_SEGMENT.exec(segment);

  if (dynamic !== null) return dynamic[1] as string;

  return undefined;
}

/**
 * Compile one raw directory segment into its pattern piece: `[id]` → `:id`,
 * `[...rest]` → `*rest`, `[[...rest]]` → `*rest?`, a literal name → itself, anything
 * malformed → a coded refusal. (A `(group)` segment never reaches here — it is
 * stripped by {@link patternFor} before compilation.)
 *
 * The dynamic and catch-all cases reuse the router's own param grammar so the
 * derived pattern is exactly what a hand-written route would take, typed params and
 * all. A segment that is none of those well-formed forms (a bare `[`, an empty `[]`,
 * a `[1bad]` starting with a digit, an empty `()` group) is a convention mistake the
 * author must fix — surfaced by a stable `ROUTER_FILE_BAD_SEGMENT`, not compiled
 * into a route that can never match.
 */
function compileSegment(segment: string): string {
  // Optional catch-all is checked before the required form (its brackets are a
  // superset), and both before the single `[name]`, so each lands on its own arm.
  const optional = OPTIONAL_CATCH_ALL_SEGMENT.exec(segment);

  if (optional !== null) return `*${optional[1] as string}?`;

  const catchAll = CATCH_ALL_SEGMENT.exec(segment);

  if (catchAll !== null) return `*${catchAll[1] as string}`;

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
    `File-route segment "${segment}" is neither a literal name, a "[param]", a "[...catchAll]", nor a "(group)" — rename the directory to a valid segment.`,
    { segment },
  );
}

/**
 * Turn a chain of raw directory segments into a URL pattern, dropping `(group)`
 * directories (which contribute no URL).
 *
 * The empty chain — or a chain of only groups (`(marketing)/page.tsx`) — is the
 * site root `"/"`. Otherwise each surviving segment is compiled (`[id]` → `:id`,
 * `[...rest]` → `*rest`) and joined under a leading slash, so `["listings", "[id]"]`
 * becomes `/listings/:id` — the exact pattern string the code-first `.page()`
 * would have taken.
 */
function patternFor(segments: ReadonlyArray<string>): string {
  const urlSegments = segments.filter((segment) => !isGroupSegment(segment));

  if (urlSegments.length === 0) return "/";

  return `/${urlSegments.map(compileSegment).join("/")}`;
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
 *
 * A catch-all segment (`*rest` / `*rest?`) normalizes to a SECOND sentinel `**`, so
 * a required and an optional catch-all at the same path (`[...a]` vs `[[...b]]`, both
 * answering `/x/…`) reduce to the same shape and are refused as duplicates — while a
 * catch-all and a single dynamic (`/x/*rest` vs `/x/:id`) keep distinct shapes
 * (`/x/**` vs `/x/*`), so they coexist and resolve by specificity.
 */
function matchShape(pattern: string): string {
  return pattern
    .replace(/\*[A-Za-z_][A-Za-z0-9_]*\??/g, "**")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "*");
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
    const name = paramNameOf(segment);

    if (name === undefined) continue;

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
 * Refuse a page whose catch-all segment is not the LAST URL segment.
 *
 * A catch-all (`[...rest]` / `[[...rest]]`) compiles to a greedy capture that
 * swallows the whole tail, so a segment after it (`[...rest]/edit`) could never
 * match — the pattern compiler refuses the resulting `/*rest/edit` too, but we
 * catch it HERE, at convention time, so `generateRouteManifest` fails on the
 * directory shape rather than emitting a manifest that throws when applied. The
 * caller passes the GROUP-STRIPPED segments, since a `(group)` adds no URL segment.
 */
function assertCatchAllTerminal(urlSegments: ReadonlyArray<string>, pattern: string): void {
  for (let i = 0; i < urlSegments.length - 1; i += 1) {
    const segment = urlSegments[i] as string;

    if (isCatchAllSegment(segment)) {
      throw new RouterError(
        "ROUTER_FILE_CATCHALL_POSITION",
        `File-route "${pattern}" puts a catch-all "${segment}" before the end — a catch-all matches the whole remaining path, so it must be the last segment.`,
        { pattern, segment },
      );
    }
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
 *   - **Boundary resolution.** A page's `boundaries` names the NEAREST `loading`,
 *     `error`, and `not-found` at or above it (the deepest matching directory, so
 *     a deeper file overrides a shallower for that subtree — Next's per-segment
 *     override). Unlike layouts these resolve to a single nearest file each, not a
 *     nesting chain; the applier wraps the page in that one Suspense/error/404
 *     boundary.
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

  // The directories of every boundary file, grouped by kind and computed once: a
  // page's layout chain (and each nearest boundary) is the subset that prefixes its
  // path, so the lookups are built ahead of the loop rather than rebuilt per page.
  // `layout` is here too, so the one walk feeds the layout chain and the boundaries.
  const boundaryKeys = boundaryKeysByKind(files);
  const layoutKeys = boundaryKeys.layout;

  const pages: FileRoute[] = [];

  // Every non-page descriptor (layout + the three boundaries), in one bucket: each
  // registers no route, so the applier keys it by directory and looks it up from a
  // page's `layoutDepth`/`boundaries`. Kept ahead of the pages in the returned list.
  const boundaries: FileRoute[] = [];

  for (const file of files) {
    const pattern = patternFor(file.segments);

    if (file.kind !== "page") {
      // A boundary/layout descriptor carries an empty `layoutDepth`/`boundaries`: it
      // is never the thing wrapped (only a page is registered), so it has none of its
      // own — but the fields are total, so the applier reads every descriptor
      // branch-free.
      boundaries.push({
        kind: file.kind,
        pattern,
        segments: file.segments,
        layoutDepth: [],
        boundaries: {},
      });

      continue;
    }

    // The URL-bearing segments (a `(group)` adds none) — what the catch-all-position
    // and duplicate-param guards reason over, since neither concerns a pathless group.
    const urlSegments = file.segments.filter((segment) => !isGroupSegment(segment));

    // A catch-all greedily matches the tail, so it must be the final URL segment.
    assertCatchAllTerminal(urlSegments, pattern);

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
    // time — and likewise a `[id]` and a `[...id]` sharing a name. A typed-param
    // convention must not mint that collision — refuse by code, mirroring the
    // single-segment ambiguity `compile` already rejects.
    assertNoDuplicateParam(urlSegments, pattern);

    seenShape.add(shape);

    pages.push({
      kind: "page",
      pattern,
      segments: file.segments,
      layoutDepth: layoutDepthsFor(file.segments, layoutKeys),
      boundaries: boundariesFor(file.segments, boundaryKeys),
    });
  }

  // Most-specific first: a deeper path before a shallower one, and at equal depth
  // the path whose first differing segment is static (not `:param`) before the
  // dynamic one. The first-match-wins table then resolves a literal route ahead of
  // a dynamic sibling without the author hand-ordering anything.
  pages.sort(comparePageSpecificity);

  // Boundaries (layout + loading/error/not-found) trail the pages; the applier
  // registers nothing for them directly — it keys them by directory and looks each
  // up from a page's depths — but we keep them grouped and depth-ordered so a
  // shallowest-first scan is available to any consumer.
  boundaries.sort((a, b) => a.segments.length - b.segments.length);

  return [...boundaries, ...pages];
}

/**
 * The directories of every boundary file, grouped by kind — a set per kind of the
 * `dirKey` of each `layout`/`loading`/`error`/`not-found` file. Built once so the
 * per-page nearest-boundary walk is a set lookup, not a re-filter of the file list.
 */
function boundaryKeysByKind(
  files: ReadonlyArray<DiscoveredFile>,
): Record<BoundaryKind, Set<string>> {
  const byKind = {
    layout: new Set<string>(),
    loading: new Set<string>(),
    error: new Set<string>(),
    "not-found": new Set<string>(),
  } satisfies Record<BoundaryKind, Set<string>>;

  for (const file of files) {
    if (file.kind !== "page") byKind[file.kind].add(dirKey(file.segments));
  }

  return byKind;
}

/**
 * The nearest boundary of each non-layout kind above a page — its directory depth,
 * or absent when no such file sits at or above the page.
 *
 * "Nearest" is the DEEPEST directory on the path from the root to the page that
 * holds the kind, so a deeper `loading`/`error`/`not-found` overrides a shallower
 * for that subtree (Next's per-segment override). We reuse {@link layoutDepthsFor}
 * (which records every matching depth shallowest-first) and take its last entry —
 * the deepest — per kind. Layouts are excluded: they nest as the whole chain, not
 * a single nearest file.
 */
function boundariesFor(
  pageSegments: ReadonlyArray<string>,
  keysByKind: Record<BoundaryKind, Set<string>>,
): BoundaryDepths {
  const result: BoundaryDepths = {};

  for (const kind of ["loading", "error", "not-found"] as const) {
    const depths = layoutDepthsFor(pageSegments, keysByKind[kind]);

    // The nearest is the deepest matching directory — the last entry, since
    // `layoutDepthsFor` records them shallowest-first. Absent when none matched.
    const nearest = depths.at(-1);

    if (nearest !== undefined) result[kind] = nearest;
  }

  return result;
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

/** The URL segments of a compiled pattern — `[]` for the root, else the `/`-split. */
const urlPatternSegments = (pattern: string): ReadonlyArray<string> =>
  pattern === "/" ? [] : pattern.slice(1).split("/");

/** A pattern is a catch-all iff it carries a `*rest` token (single `:` params have none). */
const isCatchAllPattern = (pattern: string): boolean => pattern.includes("*");

/**
 * A pattern segment's specificity rank, LOWER = more specific: a literal (`0`)
 * before a single dynamic `:param` (`1`) before a catch-all `*rest` (`2`).
 */
function segmentRank(segment: string): number {
  if (segment.startsWith("*")) return 2;
  if (segment.startsWith(":")) return 1;

  return 0;
}

/**
 * Order two pages most-specific first — over the compiled URL pattern, so a
 * `(group)` (which adds no URL segment) never skews depth.
 *
 * A catch-all route is the BROADEST kind, so it sinks below every non-catch-all
 * route regardless of depth: an explicit page — even the catch-all's own parent
 * (`/shop` under a `/shop/[[...slug]]`) — always wins, and the catch-all answers
 * only what nothing else claimed. Among same-kind routes, deeper paths win (more
 * segments = more specific); at equal depth the comparison is POSITION-AWARE: at
 * the first slot where the rank differs, the more specific (literal before `:param`
 * before `*rest`) sorts earlier — so `/files/new` precedes `/:category/new`, and
 * `/listings/new` precedes `/listings/:id`, the literal route shadowing its dynamic
 * sibling AT THAT POSITION under first-match resolution. An otherwise-identical pair
 * falls back to the pattern string so the sort is stable across reader orderings.
 *
 * The two pages compared here always have DISTINCT patterns — two pages that share
 * a match-shape are refused upstream with `ROUTER_FILE_DUPLICATE_ROUTE` before the
 * sort runs — so the final string comparison need only choose a side, never report
 * "equal"; `< ? -1 : 1` is total over the distinct-pattern inputs the sort sees.
 */
function comparePageSpecificity(a: FileRoute, b: FileRoute): number {
  const aCatchAll = isCatchAllPattern(a.pattern);
  const bCatchAll = isCatchAllPattern(b.pattern);

  if (aCatchAll !== bCatchAll) return aCatchAll ? 1 : -1;

  const aSegments = urlPatternSegments(a.pattern);
  const bSegments = urlPatternSegments(b.pattern);

  if (aSegments.length !== bSegments.length) {
    return bSegments.length - aSegments.length;
  }

  // Equal depth and kind: at the first slot where specificity differs, the more
  // specific (lower-rank) segment sorts earlier.
  for (let i = 0; i < aSegments.length; i += 1) {
    const rank = segmentRank(aSegments[i] as string) - segmentRank(bSegments[i] as string);

    if (rank !== 0) return rank;
  }

  return a.pattern < b.pattern ? -1 : 1;
}
