# Plan 019: Share the one genuine query-parsing twin; conformance-test the rest

> **Executor instructions**: Follow step by step; run every verification command.
> STOP on any "STOP conditions" item. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/runtime/ packages/cloudflare/ packages/web/`

## Status

- **Priority**: P2
- **Effort**: S (re-scoped — was M; only `parseQuery` is extracted, the rest
  become a conformance test)
- **Risk**: LOW
- **Depends on**: land plan 010 first (it touches the same fetch-handler/server
  regions)
- **Category**: tech-debt / architecture
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters — and the re-scope

The node and edge transports have request-normalization that *looks* like
byte-aligned twins, and the original plan proposed extracting four primitives
into one module. **Review found that only ONE of the four is a genuine verbatim
twin**; the other three are *deliberate transport-specific divergences*, and
forcing them into a shared impl would change one tier's contract on a security
boundary. So this plan is re-scoped:

- **Extract (verbatim twin):** `parseQuery` (`runtime/src/request.ts:79`) ↔
  `queryFrom` (`cloudflare/src/fetch-handler.ts:306`) — identical dual projection
  (last-value record + multimap) and identical `Object.create(null)` pollution
  guard; the only difference is the input (`string` vs a passed `URLSearchParams`).
  This is the recent `queries()`-across-both-transports work (`e48b73c`) — one
  behavior kept in two bodies by hand.
- **Do NOT merge (deliberate divergences — leave as-is):**
  - **Headers**: node `parseHeaders` lowercases keys, picks `value[0]` of an
    array, skips `undefined` (`request.ts:53`); edge `headersFrom` relies on Web
    `Headers.forEach` (keys already lowercased, duplicates comma-joined by the
    platform) (`fetch-handler.ts:322`). Different input model; a forced merge
    risks changing edge multi-header behavior.
  - **Body**: node `readBody` **throws** `RUNTIME_BODY_TOO_LARGE` and returns a
    `Buffer` (`server.ts:589/612`); edge `readBounded` **returns `undefined`**
    (caller maps → 413), no coded error, and returns `Uint8Array | undefined`,
    and cancels the stream on over-cap (`fetch-handler.ts:353`). Different error
    contract, return type, and post-cap stream behavior — NOT a byte-for-byte
    twin. (The original plan's claim that they share `RUNTIME_BODY_TOO_LARGE` was
    wrong.)
  - **Request-target guard**: this IS a real cross-tier drift worth fixing, but
    not by code-merge — see Step 2.

## Current state

- `parseQuery` (`runtime/src/request.ts:79`) / `queryFrom`
  (`fetch-handler.ts:306`) — the verbatim twin; edge docstring says "the edge
  twin of `@lesto/runtime`'s `parseQuery`."
- **Request-target string drift (the real finding):** node `parseRequestTarget`
  (`request.ts:150`+) throws a `@lesto/runtime` **`RuntimeError`** with code
  `RUNTIME_INVALID_REQUEST_TARGET`; the edge inline check
  (`fetch-handler.ts:718`+) throws a **bare `@lesto/errors` `LestoError`** with
  the same code **string**, deliberately "so the edge takes no dependency on the
  node transport." Same code, two classes, hand-kept in sync — the exact
  string-drift class that already bit (`L-44f2e967`).
- Home for the extraction: **`@lesto/web`** — cycle-free (it depends on
  errors/observability/router/ui/react, NOT on runtime/cloudflare, while BOTH
  runtime and cloudflare already depend on `@lesto/web`). Confirmed: zero new
  edges, no cycle.

### Conventions to follow

- The extracted primitive must be transport-neutral (take a `URLSearchParams`,
  not a node `IncomingMessage` or a Workers `Request`).
- Both `runtime` and `cloudflare` are 100%-coverage-gated.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime gate | `cd packages/runtime && bun run typecheck && bun run test:cov` | exit 0, 100% |
| Cloudflare gate | `cd packages/cloudflare && bun run typecheck && bun run test:cov` | exit 0, 100% |
| Web gate | `cd packages/web && bun run typecheck && bun run test:cov` | exit 0, 100% |
| Workspace | `bun run ws:typecheck` | exit 0 |

## Scope

**In scope**:
- A shared `parseQuery`-equivalent in `@lesto/web` (transport-neutral over
  `URLSearchParams`), imported by both transports.
- A shared **conformance test** asserting both tiers agree on the security-
  critical request-target refusals (see Step 2).
- Tests for the shared query primitive; keep both transports' tests green.

**Out of scope**:
- Merging the header, body, or request-target *implementations* — they diverge
  by design. Do NOT touch their behavior.
- Any parsing behavior change (this is a de-dup of the ONE verbatim twin).

## Steps

### Step 1: Extract `parseQuery` into `@lesto/web`

Move the pure `URLSearchParams` → `{record, multimap}` transform (with its
`Object.create(null)` pollution guard) into `@lesto/web`; have `runtime`'s
`parseQuery` and `cloudflare`'s `queryFrom` call it (each adapts its own input to
`URLSearchParams` first).

**Verify**: both transports import it; `bun run ws:typecheck` exit 0; `runtime`,
`cloudflare`, and `web` all `test:cov` at 100%.

### Step 2: Conformance-test the request-target guard (don't merge it)

Rather than merge the two divergent target-guard implementations (which would
change node's error *class*), add a **shared conformance test** (in `@lesto/web`
or a shared test util) that runs the SAME authority-confusion inputs
(`//evil/admin`, `/\evil`, etc.) through both tiers' guards and asserts both
refuse with the same `code` string `RUNTIME_INVALID_REQUEST_TARGET`. This pins
the string-drift (`L-44f2e967` class) without a risky code-merge. If a single
shared test can't reach both tiers' guards without importing both transports,
put a small assertion in each transport's suite referencing one shared constant
for the code string.

**Verify**: the conformance test refuses the shared input set on both tiers;
`bun run ws:typecheck` exit 0.

## Test plan

- Query primitive: pollution guard (`?__proto__=x` dropped), last-value record +
  multimap, moved onto the shared impl and exercised through both transports.
- Request-target conformance: the shared authority-confusion input set refused
  with the same code string on both tiers (Step 2).
- No coverage lost on either transport.

## Done criteria

- [ ] `parseQuery`/`queryFrom` share one `@lesto/web` implementation (no cycle)
- [ ] A conformance test pins the request-target refusal + code string across
      both tiers
- [ ] `runtime`, `cloudflare`, `web` all `test:cov` at 100%; `bun run ws:typecheck` exit 0
- [ ] Headers/body/target *implementations* unchanged (`git diff` shows no
      behavior edit to `parseHeaders`/`readBody`/`readBounded`)
- [ ] `plans/README.md` status row for 019 updated

## STOP conditions

Stop and report if:
- Extracting `parseQuery` would create a dependency cycle (it won't — `@lesto/web`
  is confirmed cycle-free).
- You find the header or body readers are *actually* identical after all (then
  they'd be extractable too — report, don't assume).
- The conformance test can't reach both guards without importing both transports
  into one module — use the per-suite-shared-constant fallback and note it.

## Maintenance notes

- The bounded-body unification (share the cap loop while keeping per-transport
  error surfacing) is a deliberately deferred follow-up — it is NOT a verbatim
  twin, so it needs its own careful plan, post-launch.
- Reviewer must confirm zero behavior change to headers/body/target and no new
  dependency edge.
