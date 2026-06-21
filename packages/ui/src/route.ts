/**
 * `route(pattern, params)` — build a typed URL from a known route pattern.
 *
 * The compile-time-CHECKED companion to `<Link>`: where `href` only autocompletes
 * (a typo still compiles), `route` CONSTRAINS its pattern argument to the app's
 * registered route patterns — a typo'd or stale pattern is a `tsc` error — and types
 * `params` from the pattern's `:segments` via `@lesto/router`'s `PathParams`. It
 * returns a `string` assignable to a `<Link href>`, so the type-safe dynamic link is:
 *
 *   <Link href={route("/lab/gallery/:id", { id: listing.id })}>{listing.title}</Link>
 *   route("/lab/gallery")   // a param-less pattern takes no second argument
 *
 * This is the higher-value half of typed routing (ADR/`docs/plans/dx-parity.md`,
 * Workstream 1 Increment 2): `<Link href>` made navigation route-AWARE; `route` makes
 * a dynamic link route-SAFE. With no route codegen the pattern is any `string` and the
 * params are unconstrained — the unchanged escape hatch, nothing breaks.
 *
 * Authored as a plain pure function with native string ops, so it stays in
 * `@lesto/ui`'s isomorphic, react-free core alongside `<Link>` (its sibling on the
 * link-authoring surface).
 */

import { UiError } from "./errors";
import type { KnownPatterns, ParamArgs } from "./routes";

/**
 * The pattern argument: the app's known patterns when codegen has augmented
 * `RegisteredRoutes`, else any `string` (unchanged). The `[KnownPatterns] extends
 * [never]` tuple guards the empty case without distributing over the union.
 */
type PatternArg = [KnownPatterns] extends [never] ? string : KnownPatterns;

/**
 * Build a URL from a route pattern, substituting each `:name` segment from `params`
 * (URL-encoded). The pattern is constrained to the app's {@link KnownPatterns} and the
 * params are typed via {@link ParamArgs} from the pattern's `:segments` — so a typo or
 * a missing/mistyped param is a compile error.
 *
 * The runtime missing-param guard (a coded {@link UiError}) is unreachable through the
 * types, but an untyped JS caller could trip it — mirrors `@lesto/client`'s
 * `applyParams`, the same `:param`-substitution this is the navigation twin of.
 */
export function route<P extends PatternArg>(pattern: P, ...args: ParamArgs<P>): string {
  const params = args[0] as Record<string, string | number> | undefined;

  return pattern.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params?.[name];

    if (value === undefined) {
      throw new UiError(
        "UI_ROUTE_MISSING_PARAM",
        `route "${pattern}" needs a value for ":${name}"`,
        {
          pattern,
          param: name,
        },
      );
    }

    return encodeURIComponent(String(value));
  });
}
