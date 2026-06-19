/**
 * A tiny, zero-dependency type-assertion kit.
 *
 * The end-to-end type flow IS the differentiator — schema-as-value `InferRow`,
 * the contract-typed `@lesto/client`. The 100% runtime-coverage gate says nothing
 * about whether those INFERRED types still hold: a refactor can quietly widen a
 * row field to `unknown`, make a required insert key optional, or drop a typed
 * error path, and every runtime test stays green. This kit pins the types so such
 * a drift fails `tsc` instead of shipping.
 *
 * No `tsd` / `expect-type` dependency on purpose — pulling one in would mutate the
 * shared bun lockfile (a race against the other agents on this tree) for a pair of
 * one-line type helpers. The whole suite is checked by `tsc --noEmit` over
 * `type-tests/tsconfig.json`; a failed assertion is a compile error.
 *
 * Usage:
 *
 *   type _row = Expect<Equal<InferRow<typeof users>, { id: number; email: string }>>;
 *
 * `Equal<A, B>` is the standard invariant-position trick: two conditional types
 * are mutually assignable ONLY when `A` and `B` are identical — not merely
 * bidirectionally assignable. That distinction matters: a plain
 * `A extends B ? B extends A ? true : false : false` treats `any` as equal to
 * everything and collapses `{ a: string } | { a: string }`-style unions, so it
 * would wave through exactly the regressions we want to catch. `Equal` does not.
 */

/**
 * `true` iff `A` and `B` are the *same* type (identity, not mutual
 * assignability). Resolves to `false` for any drift — including `any` creeping
 * into either side, which `A extends B`-style checks silently accept.
 */
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Compiles only when handed `true`. Pair with {@link Equal} so a regression makes
 * the `Expect<...>` reference itself a type error:
 *
 *   type _ = Expect<Equal<Actual, Expected>>;   // red the moment they diverge
 */
export type Expect<T extends true> = T;

/**
 * Flatten an object type into a single mapped form — collapsing an INTERSECTION
 * (`{ a: 1 } & { b?: 2 }`) into the equivalent flat literal (`{ a: 1; b?: 2 }`).
 *
 * Why this matters for {@link Equal}: `Equal` tests *identity*, and an
 * intersection is not identical to its flattened literal even though the two are
 * mutually assignable. `@lesto/db`'s `InferInsert` is built as
 * `{ requiredKeys } & { optionalKeys? }`, so a fixture must `Resolve` it before
 * comparing — otherwise `Equal` reports `false` on a perfectly-correct type. The
 * flatten is structure-preserving (it only re-homes keys; it widens nothing), so
 * the assertion stays exact.
 */
export type Resolve<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;
