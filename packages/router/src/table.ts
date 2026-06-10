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
 */

import { compile } from "./compile";

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
        params[paramName] = matched[index + 1] as string;
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
