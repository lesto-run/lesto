# Plan 011: Stop an app `Vary` from clobbering `Vary: Origin` in CORS

> **Executor instructions**: Follow step by step; run every verification command.
> STOP on any "STOP conditions" item. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/cors/`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED (touches the response merge on every CORS-wrapped route)
- **Depends on**: none
- **Category**: correctness / security
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

The CORS middleware merges its policy headers **under** the handler's response so
the handler wins by key: `{ ...headers, ...response.headers }`. Under a
non-wildcard origin policy the middleware sets `Vary: Origin` (its own comment at
`cors.ts:191-206` says it MUST ride on both allow and deny paths, precisely to
stop a shared cache from cross-serving one origin's
`Access-Control-Allow-Origin` to another). But any handler that sets its own
`Vary` (e.g. `Vary: Cookie`) with the same casing **replaces** `Vary: Origin`
entirely — reopening exactly the shared-cache cross-origin hazard the comment
warns about. Because different-casing keys survive as duplicates, the failure is
casing-dependent and intermittent. The fix: merge `Vary` by (case-insensitive)
union instead of letting one side win.

## Current state

- The clobbering merge:
  ```ts
  // packages/cors/src/middleware.ts:79
  const response = await next();
  // Merge the CORS headers *under* the response so a controller that set its
  // own header for the same name still wins; the browser sees the policy.
  return { ...response, headers: { ...headers, ...response.headers } };
  ```
- The policy that emits `Vary: Origin` (both outcomes):
  ```ts
  // packages/cors/src/cors.ts:198  const variesByOrigin = policy !== "*";
  // :205  if (allowOrigin === undefined) { return { Vary: "Origin" }; }   // deny path
  // (allow path also attaches Vary: Origin when non-wildcard)
  ```

### Conventions to follow

- The comment's intent ("controller wins for its own headers") must be
  preserved for **non-`Vary`** headers — the union is a `Vary`-specific rule, not
  a general merge change (keep the blast radius small).
- HTTP header names are case-insensitive; `Vary` values are a comma list and
  legally may repeat, but a clean union is correct and cache-friendly.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Gate | `cd packages/cors && bun run typecheck && bun run lint && bun run format:check && bun run test:cov` | exit 0, 100% |

## Scope

**In scope**:
- `packages/cors/src/middleware.ts` (the merge)
- `packages/cors/test/*` (add cases)
- Optionally a tiny private helper in `packages/cors/src` for the `Vary` union.

**Out of scope**:
- `packages/cors/src/cors.ts`'s policy resolution — it correctly emits
  `Vary: Origin`; only the merge changes.
- The general "controller wins" behavior for non-`Vary` headers.
- `web/lesto.ts:445`'s analogous `cache-control` spread — a related but separate
  finding; do not touch it here (note it in maintenance).

## Steps

### Step 1: Union the `Vary` header on merge

Replace the merge at `middleware.ts:79-83` so that:
- all non-`Vary` headers keep "controller wins" (unchanged),
- `Vary` becomes the case-insensitive union of the policy's `Vary` and the
  handler's `Vary` (dedupe tokens case-insensitively; join with `, `).

**Type correctness — the values are NOT plain strings.** The response header map
is `HeaderMap = Record<string, string | string[]>` (`packages/web/src/types.ts:167`;
response `headers: HeaderMap` at `:194`). Under strict TS, reading
`headers[varyKey]` yields `string | string[] | undefined`, so a naive
`.split(",")` **will not typecheck** — normalize the **value** (handle the
`string[]` arm, e.g. `Array.isArray(v) ? v : [v]`) as well as the key
(any casing of `vary`). **Tokenize BOTH sides**: the policy `Vary` is itself
multi-token when request-headers are reflected (`cors.ts:246-258` can emit
`Vary: Origin, Access-Control-Request-Headers`), so split the policy side on
comma too, not just the handler side. Write the union back under a single
canonical `Vary` key.

**Verify**: `cd packages/cors && bun run typecheck` → exit 0.

### Step 2: Tests + gate

**Verify**:
```
cd packages/cors && bun run typecheck && bun run lint && bun run format:check && bun run test:cov
```
→ exit 0, 100%.

## Test plan

Add to `packages/cors/test`, modeled on the existing middleware tests:
1. **Handler sets `Vary: Cookie` under a non-wildcard policy** → response
   `Vary` contains BOTH `Origin` and `Cookie` (order not asserted). Make this
   red if the union is removed.
2. **Handler sets no `Vary`** → `Vary: Origin` still present.
3. **Different-casing `vary`** from the handler → still unioned (no duplicate
   `Origin`).
4. **Non-`Vary` header collision** (handler sets its own `Content-Type`) → the
   handler still wins (controller-wins preserved).
5. **Multi-token policy `Vary`** (a preflight/reflected-headers response where
   the policy emits `Vary: Origin, Access-Control-Request-Headers`) unioned with
   a handler `Vary: Cookie` → all three tokens present, none duplicated.
6. **Wildcard policy (no policy `Vary`) + handler sets `Vary`** → the handler's
   `Vary` survives (the policy-side-absent branch).
7. **Neither side sets `Vary`** → no `Vary` header (the no-op branch).
   (Cases 5–7 are needed for the 100% branch gate — the `string[]`-value arm and
   both empty-side branches.)

## Done criteria

- [ ] `cd packages/cors && bun run test:cov` exit 0, 100%, union tests present
- [ ] `cd packages/cors && bun run lint && bun run format:check` exit 0
- [ ] A handler `Vary: Cookie` no longer drops `Vary: Origin` (test 1)
- [ ] Non-`Vary` "controller wins" behavior unchanged (test 4)
- [ ] `plans/README.md` status row for 011 updated

## STOP conditions

Stop and report if:
- An existing test asserts the old clobber behavior (handler `Vary` fully
  replacing `Origin`) — it encodes the bug; report before changing it.
- The header map turns out to be a case-normalizing structure such that the
  clobber can't actually happen — then the finding is moot; report that instead
  of adding dead code. (It is not: `HeaderMap` is a plain object indexed by
  literal key, so a same-casing `Vary` clobbers.)

## Maintenance notes

- The same clobber idiom exists at `web/lesto.ts:445` for `cache-control`; if a
  shared `mergeHeaders(under, over)` helper is introduced later, route both
  through it (a `Vary`/`Cache-Control`-aware union).
- Reviewer should confirm the union is `Vary`-specific and did not turn the whole
  merge into "policy wins" (which would break legitimate handler overrides).
