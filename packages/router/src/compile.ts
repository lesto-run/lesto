/**
 * Compiling a path pattern into a matcher.
 *
 * One `:param` segment names a capture and matches a single path segment
 * (anything but `/`). A `*rest` catch-all names a capture too, but a GREEDY one:
 * it swallows the whole remaining tail (one or more `/`-joined segments), and its
 * optional twin `*rest?` swallows zero or more — so it must be the LAST token in
 * the pattern. Static text is matched literally. The compiled form is a RegExp
 * anchored end-to-end, the ordered list of param names, and the subset of those
 * names that are catch-alls (so the matcher knows to split their capture into a
 * `string[]`), all derived once at declaration time so matching at request time
 * is a single `exec`.
 *
 * Shared by the legacy `Router` (`controller#action` targets) and the new
 * generic {@link RouteTable} that the `lesto()` builder dispatches over, so both
 * inherit the same ReDoS-safe compilation and never drift.
 */

import { RouterError } from "./errors";

// A `:param` segment names a capture; it matches one path segment (anything but "/").
// Kept exported (and catch-all-free) so reverse-routing and inspection of the
// single-segment params stay a one-liner; catch-alls have their own token below.
export const PARAM_SEGMENT = /:([A-Za-z_][A-Za-z0-9_]*)/g;

// A param token: a single-segment `:name` OR a catch-all `*name` (with an optional
// trailing `?` marking the zero-or-more form). `match[1]` is a single name; `match[2]`
// is a catch-all name and `match[3]` is the `?` when it is optional. One regex so the
// compiler walks both kinds in pattern order with a single pass.
export const PARAM_TOKEN = /:([A-Za-z_][A-Za-z0-9_]*)|\*([A-Za-z_][A-Za-z0-9_]*)(\?)?/g;

// The greedy capture a catch-all compiles to: one or more non-empty `/`-joined
// segments. Anchoring each `[^/]+` to a following `/` or the end keeps the match
// linear (no nested-quantifier backtracking), so it is ReDoS-safe like `[^/]+`.
const CATCH_ALL_CAPTURE = "((?:[^/]+/)*[^/]+)";

// Characters that are literal in a path but special in a RegExp — escaped so a
// static segment like "/posts.json" never acts as a wildcard.
const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

export const escapeRegExp = (literal: string): string => literal.replace(REGEXP_SPECIALS, "\\$&");

/** A compiled pattern: the matcher RegExp, the param names, and which are catch-alls. */
export interface CompiledPattern {
  regExp: RegExp;

  /** The param names (`:name` and `*name` alike), in the order they appear. */
  paramNames: ReadonlyArray<string>;

  /**
   * The subset of {@link paramNames} that are catch-alls (`*name`/`*name?`). Their
   * capture is a `/`-joined run of segments the matcher splits into a `string[]`,
   * where a single-segment param's capture stays one `string`. An optional catch-all
   * that matched zero segments has no capture, which the matcher reads as `[]`.
   */
  catchAllParams: ReadonlySet<string>;
}

/**
 * Compile a path pattern into a RegExp, the ordered list of its param names, and
 * which of those names are catch-alls.
 *
 * Static parts are escaped so they match literally; each `:param` becomes a
 * `[^/]+` capture group, and a `*rest` catch-all a greedy {@link CATCH_ALL_CAPTURE}
 * that spans the tail (its `*rest?` twin makes the whole trailing segment, slash
 * and all, optional). The pattern is anchored end-to-end.
 *
 * Refuses a pattern that puts two params in one segment (`/:a-:b`): that compiles
 * to adjacent `([^/]+)` groups separated by a literal, an ambiguous pattern whose
 * backtracking is catastrophic on a long non-matching segment — the same ReDoS
 * shape that bit `path-to-regexp` (CVE-2024-45296). And the request-handler
 * deadline is no defense: a synchronous regex blocks the event loop, so its timer
 * never fires. So we reject the shape at *declaration* time (fail fast, once)
 * rather than risk it at request time.
 *
 * Refuses, too, a catch-all that is not the final segment (`/*rest/edit`,
 * `/*a/:b`): it greedily eats the tail, so anything after it could never match —
 * a coded `ROUTER_CATCHALL_NOT_LAST`. And a catch-all glued to a literal rather
 * than occupying its own segment (`/shop*rest`) is `ROUTER_CATCHALL_NOT_SEGMENT`,
 * since it would silently capture part of a path component.
 */
export const compile = (pattern: string): CompiledPattern => {
  const paramNames: string[] = [];
  const catchAllParams = new Set<string>();

  let source = "";
  let lastIndex = 0;
  let sawParam = false;
  let sawCatchAll = false;

  for (const match of pattern.matchAll(PARAM_TOKEN)) {
    // The static text between the previous token and this one is matched literally.
    const between = pattern.slice(lastIndex, match.index);

    // A catch-all swallows the rest of the path, so no token may follow it.
    if (sawCatchAll) {
      throw new RouterError(
        "ROUTER_CATCHALL_NOT_LAST",
        `Route "${pattern}" has a catch-all that is not the final segment — a "*rest" greedily matches the tail, so nothing can follow it. Move it to the end.`,
        { pattern },
      );
    }

    const singleName = match[1];

    if (singleName !== undefined) {
      // No `/` since the previous param means this one shares its segment — two
      // `[^/]+` captures in one segment, the ambiguous backtracking shape we refuse.
      if (sawParam && !between.includes("/")) {
        throw new RouterError(
          "ROUTER_AMBIGUOUS_SEGMENT",
          `Route "${pattern}" puts two params in one segment (":${singleName}" shares a segment with the param before it). Give each param its own "/" segment, or capture one param and split the value in the handler.`,
          { pattern, param: singleName },
        );
      }

      source += escapeRegExp(between);
      source += "([^/]+)";
      paramNames.push(singleName);
    } else {
      // A catch-all (`match[2]` the name, `match[3]` the `?` when optional). It must
      // occupy a whole segment: the literal before it ends at a `/` boundary (or is
      // the root `/`), else it would glue onto a literal and capture part of a path
      // component rather than a clean run of segments.
      const name = match[2] as string;
      const optional = match[3] === "?";

      if (!between.endsWith("/")) {
        throw new RouterError(
          "ROUTER_CATCHALL_NOT_SEGMENT",
          `Route "${pattern}" has a catch-all "*${name}" glued to a literal — a catch-all must be its own "/"-delimited segment.`,
          { pattern, param: name },
        );
      }

      if (optional) {
        // The whole trailing segment is optional — including the slash that precedes
        // it. At the root the leading `/` is structural (every path has it) and IS the
        // zero-segment path, so keep it and make only the segments optional; elsewhere
        // peel the segment's own slash so the bare prefix (`/shop`) matches too.
        source +=
          between === "/"
            ? `/${CATCH_ALL_CAPTURE}?`
            : `${escapeRegExp(between.slice(0, -1))}(?:/${CATCH_ALL_CAPTURE})?`;
      } else {
        source += escapeRegExp(between) + CATCH_ALL_CAPTURE;
      }

      paramNames.push(name);
      catchAllParams.add(name);
      sawCatchAll = true;
    }

    lastIndex = match.index + match[0].length;
    sawParam = true;
  }

  // Whatever trails the final token is literal — but a catch-all leaves nothing to
  // trail, so a non-empty tail here is a literal after a catch-all (`/*rest/edit`).
  const trailing = pattern.slice(lastIndex);

  if (sawCatchAll && trailing !== "") {
    throw new RouterError(
      "ROUTER_CATCHALL_NOT_LAST",
      `Route "${pattern}" has text after its catch-all — a "*rest" greedily matches the tail, so nothing can follow it. Move it to the end.`,
      { pattern },
    );
  }

  source += escapeRegExp(trailing);

  return { regExp: new RegExp(`^${source}$`), paramNames, catchAllParams };
};
