/**
 * Path params, inferred from the pattern at the type level.
 *
 * A route's `:param` segments are not just runtime captures — the compiler can
 * read them straight off the pattern string. `ParamKeys<"/listings/:id">` is the
 * literal union `"id"`; `PathParams<…>` lifts that union into the record a
 * handler receives. This is the spine of Lesto's end-to-end typing: a handler for
 * `"/posts/:postId/comments/:id"` knows, with no annotation and no codegen, that
 * `c.param("postId")` and `c.param("id")` are the only valid keys.
 *
 * Purely type-level — these emit no JavaScript. The runtime captures still flow
 * through {@link RouteTable}; these types only describe their shape.
 */

/**
 * The name a `:param` captures, stopping at a literal that follows it in the same
 * segment.
 *
 * The runtime compiler captures a name as `[A-Za-z_][A-Za-z0-9_]*` (see
 * `PARAM_SEGMENT`), so a pattern like `/files/:name.json` binds the param `name`
 * and matches `.json` literally. A naive split-on-`/` would infer `name.json` and
 * steer `c.param(...)` to a key that does not exist at runtime. This peels the
 * trailing literal at the `.`/`-` separators a path segment uses, so the type
 * agrees with the captured key.
 */
type ParamName<Raw extends string> = Raw extends `${infer Name}.${string}`
  ? ParamName<Name>
  : Raw extends `${infer Name}-${string}`
    ? ParamName<Name>
    : Raw;

/**
 * The union of `:param` names in a path pattern.
 *
 * Walks the literal: a `:name/` prefix yields `name` and recurses on the rest; a
 * trailing `:name` yields the final name; anything without a `:` yields `never`
 * (a static path has no params). A name stops at the next `/` — or at a `.`/`-`
 * literal within the segment — mirroring the identifier the runtime captures.
 *
 * @example
 * type A = ParamKeys<"/listings/:id">;             // "id"
 * type B = ParamKeys<"/posts/:postId/c/:id">;      // "postId" | "id"
 * type C = ParamKeys<"/files/:name.json">;         // "name"
 * type D = ParamKeys<"/about">;                     // never
 */
export type ParamKeys<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}`
  ? ParamName<Param> | ParamKeys<`/${Rest}`>
  : Path extends `${string}:${infer Param}`
    ? ParamName<Param>
    : never;

/**
 * The record of path params for a pattern: each `:param` name mapped to `string`.
 *
 * Every captured segment is a `string` at runtime (the router never coerces), so
 * the value type is uniformly `string`. A static path produces `{}` — no keys,
 * nothing to read.
 *
 * @example
 * type P = PathParams<"/listings/:id">;            // { id: string }
 */
export type PathParams<Path extends string> = { [Key in ParamKeys<Path>]: string };
