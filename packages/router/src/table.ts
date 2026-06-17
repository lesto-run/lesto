/**
 * A generic route table: method + path pattern → a value of the caller's choice.
 *
 * Where the legacy {@link Router} hard-codes its value to a `"controller#action"`
 * string, `RouteTable<T>` is agnostic — the `keel()` builder stores whatever it
 * needs to run a route (a handler chain, a page definition) as the value, and the
 * table only owns matching: compile each pattern once, then resolve a request to
 * the first route whose verb and path both match, handing back the value and the
 * captured params.
 *
 * Insertion order is resolution order: the first matching route wins, so a more
 * specific pattern declared earlier shadows a broader one declared later. Pure
 * over plain strings — no socket, no handler invocation — so every matching edge
 * is unit-testable in isolation.
 *
 * ## Captured params are URL-decoded at match time (BREAKING, Wave 5)
 *
 * Matching runs against the *encoded* path, then each capture is
 * `decodeURIComponent`-d before it reaches the caller. Two consequences a handler
 * can now rely on:
 *
 *   - A percent-encoded separator never smuggles a segment. The pattern's `[^/]+`
 *     capture matches `%2F` as ONE segment, so `/files/a%2Fb` binds the single
 *     param `"a/b"` — it does NOT split into two segments or match a two-segment
 *     pattern. Decoding happens *after* the segment boundary is fixed, so the
 *     route shape is decided on the wire form and the slash can never be forged
 *     into the path structure. (`%2e%2e` likewise decodes to the literal `".."`
 *     value — a string the handler sees, not a path operator the router honors.)
 *   - Unicode is real text. `/u/%E2%9C%93` binds `"✓"`, not its bytes.
 *
 * A param that is not a well-formed percent-encoding (a stray `%`, `%zz`, a
 * truncated `%E2`) is a client-malformed request, not a server fault: the decode
 * refuses with a coded {@link RouterError} (`ROUTER_MALFORMED_PARAM`) so the web
 * tier maps it to a 400 instead of letting `decodeURIComponent`'s bare `URIError`
 * escape as a 500. The reverse of this — building an encoded path from decoded
 * params — is {@link pathFor}, which round-trips: `match(pathFor(p, v)).params`
 * recovers `v`.
 */

import { compile, PARAM_SEGMENT } from "./compile";
import { RouterError } from "./errors";

/**
 * Decode one captured segment, turning a malformed percent-sequence into a coded
 * refusal instead of a bare `URIError`.
 *
 * `decodeURIComponent` throws a plain `URIError` on a stray or truncated `%`; left
 * unhandled that surfaces as an opaque 500 for what is really a bad request. We
 * catch exactly that case and re-raise a {@link RouterError} the web tier can map
 * to a 400 by code (`ROUTER_MALFORMED_PARAM`).
 */
const decodeParam = (paramName: string, raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new RouterError(
      "ROUTER_MALFORMED_PARAM",
      `Route param "${paramName}" is not a valid percent-encoding: "${raw}".`,
      { param: paramName, raw },
    );
  }
};

/** A compiled entry: its verb, the source pattern (for inspection), and the matcher. */
interface Entry<T> {
  method: string;

  pattern: string;

  regExp: RegExp;

  paramNames: ReadonlyArray<string>;

  value: T;
}

/** A successful match: the stored value and the params captured from the path. */
export interface Match<T> {
  value: T;

  params: Record<string, string>;
}

export class RouteTable<T> {
  // Insertion order is resolution order: the first matching route wins.
  private readonly entries: Entry<T>[] = [];

  /**
   * Register a route. The pattern is compiled once, here, so a malformed or
   * ambiguous pattern (see {@link compile}) fails at declaration, not at request.
   */
  add(method: string, pattern: string, value: T): this {
    const { regExp, paramNames } = compile(pattern);

    this.entries.push({ method, pattern, regExp, paramNames, value });

    return this;
  }

  /**
   * Find the route that answers this method + path.
   *
   * Returns the stored value and the extracted params, or `undefined` when
   * nothing matches — either no pattern fits the path, or the matching pattern
   * wants a different verb. The verb check is first and cheapest; the RegExp runs
   * only for a method that could answer.
   */
  match(method: string, path: string): Match<T> | undefined {
    for (const entry of this.entries) {
      if (entry.method !== method) continue;

      const matched = entry.regExp.exec(path);

      if (matched === null) continue;

      const params: Record<string, string> = {};

      entry.paramNames.forEach((paramName, index) => {
        // Group 0 is the whole match; captures start at 1, aligned with paramNames.
        // The capture is the on-the-wire (encoded) segment — decode it here, after
        // the segment boundary is already fixed, so `%2F` can never smuggle a `/`
        // into the route shape. A malformed `%` becomes a coded 400, not a 500.
        params[paramName] = decodeParam(paramName, matched[index + 1] as string);
      });

      return { value: entry.value, params };
    }

    return undefined;
  }

  /** Every registered route's verb + pattern, in resolution order, for inspection. */
  list(): ReadonlyArray<{ method: string; pattern: string }> {
    return this.entries.map((entry) => ({ method: entry.method, pattern: entry.pattern }));
  }
}

/**
 * Build a concrete path from a pattern by substituting and URL-encoding its params
 * — the reverse of {@link RouteTable.match}, so a link never hardcodes a URL.
 *
 * Each `:param` is replaced by `encodeURIComponent` of its value. That encoding is
 * the exact inverse of the `decodeURIComponent` `match` applies, so the two
 * round-trip: a value containing a `/` (or any unicode) survives the trip out and
 * back unchanged — `pathFor("/files/:p", { p: "a/b" })` yields `/files/a%2Fb`,
 * which `match` decodes back to `{ p: "a/b" }` as one segment, never two.
 *
 * Throws a coded {@link RouterError} (`ROUTER_MISSING_PARAM`) if the pattern needs
 * a param the caller did not supply, or supplied empty: a `[^/]+` capture matches
 * one-or-more chars, so an empty value would yield a path that can never route
 * back (`/files/` misses `/files/:p`). Both are wiring bugs caught here, not
 * broken links shipped to a user.
 */
export const pathFor = (pattern: string, params: Record<string, string> = {}): string =>
  pattern.replace(PARAM_SEGMENT, (_segment, paramName: string) => {
    const value = params[paramName];

    if (value === undefined || value === "") {
      throw new RouterError(
        "ROUTER_MISSING_PARAM",
        `Pattern "${pattern}" needs a non-empty "${paramName}" param.`,
        { pattern, param: paramName },
      );
    }

    return encodeURIComponent(value);
  });
