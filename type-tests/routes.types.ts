/**
 * Type pins for `@lesto/ui`'s typed-route seam (Workstream 1, docs/plans/dx-parity.md).
 *
 * The whole value of typed `<Link href>` is type-level — a regression that widened
 * `RouteHref` back to plain `string` (losing autocomplete) or that broke the empty
 * registry's `string` default would pass every runtime test. These assertions make
 * either drift a `tsc` error.
 *
 * `HrefFor<Reg>` is tested as a GENERIC over a registry shape so both the empty and
 * populated cases are pinned in ONE file without a global `declare module` (which is
 * an all-or-nothing augmentation of the whole type-test program, so it could only
 * pin one of the two states). `RouteHref` is just `HrefFor<RegisteredRoutes>`.
 */

import type { HrefFor, ParamArgs, PatternsOf, StrictHrefFor } from "@lesto/ui";

import type { Equal, Expect } from "./assert";

/** `true` iff `A` is assignable to `B` (a one-directional check, unlike {@link Equal}). */
type Extends<A, B> = A extends B ? true : false;

/** A registry that declares no routes (an app with no route codegen) — and one that does. */
interface EmptyRegistry {}
interface PopulatedRegistry {
  href: "/lab/gallery" | `/lab/gallery/${string}`;
  pattern: "/lab/gallery" | "/lab/gallery/:id";
}

// ── HrefFor over an EMPTY registry: exactly `string` (the unchanged default) ──
type _EmptyIsString = Expect<Equal<HrefFor<EmptyRegistry>, string>>;

// ── HrefFor over a POPULATED registry ──
// Not widened back to plain `string` — the literal members survive, so autocomplete
// works (this is the assertion a "href: string" regression trips).
type _NotWidened = Expect<Equal<Equal<HrefFor<PopulatedRegistry>, string>, false>>;

// Each known route is assignable (the autocomplete surface is present)…
type _StaticMember = Expect<Extends<"/lab/gallery", HrefFor<PopulatedRegistry>>>;
type _DynamicMember = Expect<Extends<`/lab/gallery/${string}`, HrefFor<PopulatedRegistry>>>;
type _InterpolatedMember = Expect<Extends<"/lab/gallery/42", HrefFor<PopulatedRegistry>>>;

// …and any string still assigns (the `(string & {})` escape — an external URL, a
// query/hash, or a code-first route never fails to type-check).
type _EscapeKeepsAnyString = Expect<Extends<string, HrefFor<PopulatedRegistry>>>;
type _ExternalUrl = Expect<Extends<"https://example.com", HrefFor<PopulatedRegistry>>>;

// ── PatternsOf (the `route()` registry side): extracts the pattern union, or never ──
// Unlike the href form, patterns keep `:param` so `PathParams` can read the names.
type _PatternsNone = Expect<Equal<PatternsOf<EmptyRegistry>, never>>;
type _PatternsSome = Expect<Equal<PatternsOf<PopulatedRegistry>, "/lab/gallery" | "/lab/gallery/:id">>;

// ── ParamArgs (the `route()` argument list): typed params REQUIRED iff the pattern
// has `:segments`; a param-less pattern takes NO second argument (an empty tuple) ──
type _ArgsStatic = Expect<Equal<ParamArgs<"/lab/gallery">, []>>;
type _ArgsDynamic = Expect<Equal<ParamArgs<"/lab/gallery/:id">, [params: { id: string }]>>;
type _ArgsMulti = Expect<
  Equal<ParamArgs<"/shop/:category/:id">, [params: { category: string; id: string }]>
>;

// ── StrictHrefFor (the <StrictLink> href, for fully-file-routed apps): like HrefFor
// but WITHOUT the `(string & {})` escape — an unknown literal is NOT assignable ──
type _StrictEmptyIsString = Expect<Equal<StrictHrefFor<EmptyRegistry>, string>>;
type _StrictSome = Expect<
  Equal<StrictHrefFor<PopulatedRegistry>, "/lab/gallery" | `/lab/gallery/${string}`>
>;
// The escape is GONE: an arbitrary string does NOT assign, so a typo'd `<StrictLink href>`
// is a tsc error (a regression that re-added the escape would flip this to `true` and fail).
type _StrictRejectsArbitrary = Expect<
  Equal<Extends<string, StrictHrefFor<PopulatedRegistry>>, false>
>;
