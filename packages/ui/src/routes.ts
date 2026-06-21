/**
 * The typed-route seam — how an app's generated `routes.gen.ts` teaches `<Link>` and
 * {@link route} the app's real routes, with ZERO runtime and no react dependency
 * (pure type-level — only a TYPE-only import of `PathParams` from `@lesto/router` —
 * so the `@lesto/ui` isomorphic core stays react-free here and the type gate can pin
 * it without pulling the component tree in).
 *
 * The mechanism is declaration merging — the same `Register` idiom TanStack Router
 * uses. `@lesto/web`'s `generateRouteManifest` emits, into each app's
 * `routes.gen.ts`, a `RoutePath` + `RoutePattern` union of every route plus:
 *
 *   declare module "@lesto/ui" {
 *     interface RegisteredRoutes { href: RoutePath; pattern: RoutePattern }
 *   }
 *
 * which merges `href`/`pattern` members into {@link RegisteredRoutes} below.
 * {@link RouteHref} reads `href` (so `<Link href>` autocompletes the app's routes);
 * {@link KnownPatterns} reads `pattern` (so {@link route} constrains its pattern arg
 * and types its params). An app with NO route codegen leaves `RegisteredRoutes`
 * empty, so both stay unconstrained (`string`): nothing breaks.
 */

import type { PathParams } from "@lesto/router";

/**
 * The route registry an app augments by declaration merging. Empty by design — it
 * IS the extension point a generated `routes.gen.ts` merges a `href` member into
 * (the same pattern as `@lesto/content-core`'s `CollectionRegistry`). Augmenting
 * `@lesto/ui` reaches this interface because the package re-exports it.
 */
export interface RegisteredRoutes {}

/**
 * The known route hrefs a registry shape `Reg` declares, or `never` when it declares
 * none. Internal helper for {@link HrefFor} — kept as a generic over the registry
 * (not reading the global {@link RegisteredRoutes}) so {@link HrefFor}'s behavior is
 * pinnable in the type gate without a program-global `declare module` augmentation.
 */
type KnownRoutesOf<Reg> = Reg extends { href: infer H extends string } ? H : never;

/**
 * The `<Link href>` type derived from a registry shape `Reg`:
 *
 *   - `Reg` declares no routes → exactly `string` (the unchanged default for an app
 *     with no route codegen).
 *   - `Reg` declares routes → the known routes (autocompleted) PLUS a `(string & {})`
 *     escape that still accepts any other string — an external URL, a `?query`/`#hash`,
 *     or a code-first route — so typed routes only SURFACE the known ones, never
 *     BLOCK a valid link. Strict dead-link erroring is a follow-up (docs/plans/
 *     dx-parity.md, Workstream 1 Increment 2).
 *
 * `[KnownRoutesOf<Reg>] extends [never]` guards the empty case without distributing
 * over the union, and `string & {}` is the standard trick that keeps the literal
 * members visible to autocomplete while staying assignable from any string.
 */
export type HrefFor<Reg> = [KnownRoutesOf<Reg>] extends [never]
  ? string
  : KnownRoutesOf<Reg> | (string & {});

/** A `<Link>` href — see {@link HrefFor}, resolved against the app's {@link RegisteredRoutes}. */
export type RouteHref = HrefFor<RegisteredRoutes>;

/**
 * Like {@link HrefFor} but WITHOUT the `(string & {})` escape — only the registry's
 * known routes, so an unknown literal is NOT assignable (a typo'd link is a `tsc`
 * error). A generic over `Reg` so it's pinnable in the type gate. An empty registry
 * still yields `string` (no codegen → unchanged).
 */
export type StrictHrefFor<Reg> = [KnownRoutesOf<Reg>] extends [never] ? string : KnownRoutesOf<Reg>;

/**
 * A STRICT `<Link href>` type for {@link StrictLink}: the app's known routes with no
 * escape, so a typo'd link does not compile. Sound only for a FULLY-file-routed app —
 * every route is in the registry. A MIXED app (with code-first `.page()` routes the
 * codegen can't see) must keep the lenient {@link RouteHref}, or strict mode would
 * false-positive on those routes (making it strict BY DEFAULT for mixed apps needs
 * code-first route capture, a deferred large refactor — docs/plans/dx-parity.md).
 */
export type StrictRouteHref = StrictHrefFor<RegisteredRoutes>;

/**
 * The known route PATTERNS a registry shape `Reg` declares (`"/blog/:id"`, with
 * `:param` segments KEPT), or `never` when it declares none. {@link route} reads this
 * to constrain its pattern argument to the app's real routes; a generic over `Reg`
 * (like {@link HrefFor}) so it's pinnable in the type gate without a global augmentation.
 */
export type PatternsOf<Reg> = Reg extends { pattern: infer P extends string } ? P : never;

/** The app's known route patterns once codegen augments {@link RegisteredRoutes}, else `never`. */
export type KnownPatterns = PatternsOf<RegisteredRoutes>;

/**
 * The argument list a {@link route} call takes for a pattern `P`: the typed params
 * object is REQUIRED when `P` has `:segments`, ABSENT otherwise — a tuple, so a
 * param-less `route("/about")` needs no second argument (the `@lesto/client`
 * `createApi` `GetArgs` precedent). Param names + value types come from
 * `@lesto/router`'s `PathParams<P>`.
 */
export type ParamArgs<P extends string> = keyof PathParams<P> extends never
  ? []
  : [params: PathParams<P>];
