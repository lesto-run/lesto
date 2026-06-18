/**
 * Compiling a path pattern into a matcher.
 *
 * One `:param` segment names a capture and matches a single path segment
 * (anything but `/`). Static text is matched literally. The compiled form is a
 * RegExp anchored end-to-end plus the ordered list of param names, derived once
 * at declaration time so matching at request time is a single `exec`.
 *
 * Shared by the legacy `Router` (`controller#action` targets) and the new
 * generic {@link RouteTable} that the `lesto()` builder dispatches over, so both
 * inherit the same ReDoS-safe compilation and never drift.
 */

import { RouterError } from "./errors";

// A `:param` segment names a capture; it matches one path segment (anything but "/").
export const PARAM_SEGMENT = /:([A-Za-z_][A-Za-z0-9_]*)/g;

// Characters that are literal in a path but special in a RegExp — escaped so a
// static segment like "/posts.json" never acts as a wildcard.
const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

export const escapeRegExp = (literal: string): string => literal.replace(REGEXP_SPECIALS, "\\$&");

/** A compiled pattern: the matcher RegExp and the param names in pattern order. */
export interface CompiledPattern {
  regExp: RegExp;

  /** The `:param` names, in the order they appear in the pattern. */
  paramNames: ReadonlyArray<string>;
}

/**
 * Compile a path pattern into a RegExp plus the ordered list of its param names.
 *
 * Static parts are escaped so they match literally; each `:param` becomes a
 * `[^/]+` capture group. The pattern is anchored end-to-end.
 *
 * Refuses a pattern that puts two params in one segment (`/:a-:b`): that compiles
 * to adjacent `([^/]+)` groups separated by a literal, an ambiguous pattern whose
 * backtracking is catastrophic on a long non-matching segment — the same ReDoS
 * shape that bit `path-to-regexp` (CVE-2024-45296). And the request-handler
 * deadline is no defense: a synchronous regex blocks the event loop, so its timer
 * never fires. So we reject the shape at *declaration* time (fail fast, once)
 * rather than risk it at request time.
 */
export const compile = (pattern: string): CompiledPattern => {
  const paramNames: string[] = [];

  let source = "";
  let lastIndex = 0;
  let sawParam = false;

  for (const match of pattern.matchAll(PARAM_SEGMENT)) {
    // The static text between the previous param and this one is matched literally.
    const between = pattern.slice(lastIndex, match.index);

    // No `/` since the previous param means this one shares its segment — two
    // `[^/]+` captures in one segment, the ambiguous backtracking shape we refuse.
    if (sawParam && !between.includes("/")) {
      throw new RouterError(
        "ROUTER_AMBIGUOUS_SEGMENT",
        `Route "${pattern}" puts two params in one segment (":${match[1]}" shares a segment with the param before it). Give each param its own "/" segment, or capture one param and split the value in the handler.`,
        { pattern, param: match[1] },
      );
    }

    source += escapeRegExp(between);
    source += "([^/]+)";

    // `match[1]` is the captured name; the regex guarantees it is present.
    paramNames.push(match[1] as string);

    lastIndex = match.index + match[0].length;
    sawParam = true;
  }

  // Whatever trails the final param is also literal.
  source += escapeRegExp(pattern.slice(lastIndex));

  return { regExp: new RegExp(`^${source}$`), paramNames };
};
