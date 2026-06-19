# ADR 0026 — End-to-end type-regression suite

- Status: Accepted
- Date: 2026-06-19
- Board: 206e92c6

## Context

Lesto's headline differentiator is a **one-language, end-to-end type flow**: a
schema declared as a *value* (`@lesto/db`'s `defineTable`) drives the row, insert,
and update types with no codegen (`InferRow` / `InferInsert` / `InferUpdate`), and
`@lesto/client` carries types across the network by inference over a contract you
declare once (`createApi` / `createMutationClient`).

That flow is entirely *type-level*. The CI bar enforces **100% runtime coverage**,
but runtime tests exercise *values* — they say nothing about whether the inferred
types still hold. A refactor can silently:

- widen a row field to `unknown`,
- make a required insert key optional (or vice-versa),
- stop the `timestamp` column hydrating to `Date`,
- drop the `:param` requirement on a contract-typed request,
- collapse the mutation result's discriminated union,

…and every runtime test stays green. The differentiator can regress without a
single failing test. There were **zero type-level tests** guarding it.

## Decision

Add a **zero-dependency, in-repo type-regression suite** under a new top-level
`type-tests/` directory, run in CI alongside the coverage gate.

### Zero-dependency assertion kit

No `tsd` / `expect-type` dependency — pulling one in would mutate the shared bun
lockfile (a race against parallel work) for what is a pair of one-line type
helpers. The kit (`type-tests/assert.ts`) is:

```ts
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export type Expect<T extends true> = T;
export type Resolve<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;
```

`Equal` is the standard invariant-position identity check — two types are equal
only when *identical*, not merely bidirectionally assignable (so `any` creeping in,
or a field widening, is caught). `Resolve` flattens an intersection (`@lesto/db`
builds `InferInsert` as `{required} & {optional?}`) into a single literal so
`Equal`'s identity check holds; it is structure-preserving and widens nothing.

A drift makes the `Expect<Equal<…>>` reference itself a `tsc` error (`TS2344`). The
whole suite is checked by `tsc --noEmit` over `type-tests/tsconfig.json`.

### Resolution without an install

`type-tests/tsconfig.json` extends `tsconfig.base.json` (so the pinned types are
checked under the SAME strict bar a consumer sees) and uses `paths` to resolve the
differentiator packages straight from source — no `bun install`, no lockfile touch:

```
@lesto/db            → packages/db/src/index.ts
@lesto/client        → packages/client/src/index.ts
@lesto/router        → packages/router/src/params.ts   (see note)
@lesto/observability → packages/observability/src/index.ts
@lesto/errors        → packages/errors/src/index.ts
```

`type-tests/` stays OUT of the workspaces glob, so nothing triggers an install. The
only relaxations from the base are `noUnusedLocals` / `noUnusedParameters` (the
assertions ARE unused `type _x = …` aliases — declaring one is how the check fires)
— every strictness flag that makes the assertions *mean* something is inherited.

### What is pinned (this wave)

- **`@lesto/db`** (`type-tests/db.types.ts`):
  - `InferRow` — every column present, nullability folded in (`nickname:
    string | null`); the kind dispatch that hydrates `boolean`→`boolean` and
    `timestamp`→`Date` from their `INTEGER` storage.
  - **A subtle invariant**: a `.default(0)` WITHOUT `.notNull()` stays nullable, so
    its type is `number | null` — pinned so a "default ⇒ non-null" mis-refactor reds.
  - `InferInsert` — required keys required, nullable / defaulted / auto-increment
    keys optional; proven both at the type level and through value-level
    `@ts-expect-error` fixtures (a missing required key won't compile).
  - `InferUpdate` — every column optional, none dropped.
  - The anti-ORM win: `eq(column, wrongType)` is a compile error.
- **`@lesto/client`** (`type-tests/client.types.ts`):
  - `createApi<Contract>()` — response inferred from the contract (not `unknown`);
    a path is constrained to its verb's routes; `:param` paths require typed
    `params`; a typed request `body`.
  - `createMutationClient<Contract>()` — each stub takes its `input` and resolves
    to the discriminated `MutationResult<output>` union (`if (result.ok)` narrows
    `data` vs the coded `error` — a value, never a throw); a no-arg mutation's input
    is optional, a required one is not.

### Acceptance proof (drift detection)

`type-tests/drift.fixture.ts` carries a deliberately-wrong assertion
(`InferRow.id` claimed `string`, actually `number`), kept block-commented on
`main`. Uncommenting it makes `tsc -p type-tests/tsconfig.json` exit `2` with
`TS2344` on the `Expect<...>`; re-commenting returns exit `0`. Verified locally:

```
bun run test:types          # exit 0 (green)
# …uncomment the drift block…
bun run test:types          # exit 2 (RED — TS2344)
# …re-comment…
bun run test:types          # exit 0 (green again)
```

### CI wiring

- Root `package.json`: `"test:types": "tsc -p type-tests/tsconfig.json"`.
- `.github/workflows/ci.yml`, `check` job: a **Type-regression suite** step running
  `bun run test:types`, immediately after `Typecheck` and before the coverage gate
  — same job, same Bun setup, blocking.

## Consequences

- A type-level regression in the differentiator now fails CI, closing the gap the
  coverage gate left open.
- The suite consumes package *source* via `paths`. This is robust as long as the
  consumed entry points compile; the `@lesto/router` mapping points at the stable
  `params.ts` (not the package `index.ts`) precisely to avoid coupling the gate to
  unrelated in-flight package work.

## FOLLOW-UP (explicitly deferred)

- **Router param-type fixtures.** `@lesto/router` is being rewritten THIS wave
  (file-based routing + soft-nav), so its public types are in flux. Pinning
  `PathParams` / `ParamKeys` / the route-table types directly is deferred until that
  rewrite lands. (Their behavior is still indirectly exercised here via
  `@lesto/client`'s `:param` requirement, but a dedicated router fixture set should
  be added.)
- Extend pinning to `@lesto/db`'s JOIN / alias result-row types and
  `@lesto/runtime`'s `MutationContractOf` projection once they stabilize.
- Consider pinning against built `.d.ts` (not source) once packages publish, so the
  gate matches exactly what a consumer installs.
