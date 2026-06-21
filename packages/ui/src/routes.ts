/**
 * The typed-route seam — how an app's generated `routes.gen.ts` teaches `<Link>`
 * the app's real routes, with ZERO runtime and zero react dependency (this module
 * is pure type-level, so the `@lesto/ui` isomorphic core stays react-free here and
 * the type gate can pin it without pulling the component tree in).
 *
 * The mechanism is declaration merging — the same `Register` idiom TanStack Router
 * uses. `@lesto/web`'s `generateRouteManifest` emits, into each app's
 * `routes.gen.ts`, a `RoutePath` union of every route plus:
 *
 *   declare module "@lesto/ui" {
 *     interface RegisteredRoutes { href: RoutePath }
 *   }
 *
 * which merges a `href` member into {@link RegisteredRoutes} below. {@link RouteHref}
 * reads that member, so `<Link href>` (typed as `RouteHref`) gains autocomplete over
 * the app's routes — and, crucially, an app with NO route codegen leaves
 * `RegisteredRoutes` empty, so `RouteHref` stays exactly `string`: nothing breaks.
 */

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
