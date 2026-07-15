# Plan 010: Gate the ETag/304 conditional path to GET/HEAD on both tiers

> **Executor instructions**: Follow step by step; run every verification command.
> STOP on any "STOP conditions" item. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/runtime/src/server.ts packages/runtime/src/http-cache.ts packages/cloudflare/src/fetch-handler.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (strictly narrows when 304 can fire)
- **Depends on**: none
- **Category**: correctness
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

The conditional-request path runs on **every** admitted request with no method
gate. A client sending `If-None-Match: *` (or a coincidentally-matching tag) on a
POST/PUT/PATCH that returns a 200 HTML body gets a bodiless **304** — *after* the
handler's side effects already ran, and the client can't read the response body.
RFC 9110 §13.1.2 restricts 304 to GET/HEAD (other methods on a matching
`If-None-Match` should be 412, and since the handler has already run, the only
safe behavior is to skip conditional handling for non-GET/HEAD entirely). Both
the node tier and the edge twin have the gap. The fix is a one-line method gate
on each tier.

## Current state

- **Node tier** — `withEtag` + `etagMatches` run unconditionally:
  ```ts
  // packages/runtime/src/server.ts:1815
  const tagged = withEtag(response, deps.etag, coding);
  const hardened = hardenResponse(tagged.response, deps.securityHeaders, requestId);
  // :1822
  if (tagged.etag !== undefined && etagMatches(ifNoneMatch(req.headers), tagged.etag)) {
    status = 304;
    respondNotModified(res as NotModifiedResponse, hardened.headers);
  } else { /* write body */ }
  ```
  The `method` is available on `req` in this handler (used elsewhere in the file).
- `etagMatches` honors `*`:
  ```ts
  // packages/runtime/src/http-cache.ts:225
  export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean { ... "*" ... }
  ```
- **Edge twin** — same gap:
  ```ts
  // packages/cloudflare/src/fetch-handler.ts:872
  const tagged = etagEnabled ? await withEdgeEtag(response) : { response, etag: undefined };
  const hardened = withSecurityHeaders(tagged.response, securityHeaders);
  const notModified =
    tagged.etag !== undefined &&
    ifNoneMatchMatches(request.headers.get("if-none-match"), tagged.etag);
  const status = notModified ? 304 : hardened.status;
  ```
  `request.method` is available here.

### Conventions to follow

- The node and edge tiers are deliberately kept behavior-aligned ("the edge twin
  of …" comments) — make the SAME change on both, or they diverge.
- Both packages are 100%-coverage-gated.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime gate | `cd packages/runtime && bun run typecheck && bun run test:cov` | exit 0, 100% |
| Cloudflare gate | `cd packages/cloudflare && bun run typecheck && bun run test:cov` | exit 0, 100% |

## Scope

**In scope**:
- `packages/runtime/src/server.ts` (add the method gate around the 304 branch)
- `packages/cloudflare/src/fetch-handler.ts` (same)
- `packages/runtime/test/*`, `packages/cloudflare/test/*` (add cases)

**Out of scope**:
- `etagMatches` / `ifNoneMatchMatches` / `withEtag` / `withEdgeEtag` internals —
  the fix is at the call site (the method gate), not the matcher.
- Tagging behavior for GET/HEAD (unchanged). Weak-validator semantics (unchanged).

## Steps

### Step 1: Node tier

Gate the **whole tag+304 block** on GET/HEAD:
`const conditional = req.method === "GET" || req.method === "HEAD";` — only
`withEtag` + the 304 decision run when `conditional` is true; a non-GET/HEAD
request skips both and writes its body normally. Gating the whole block (not
just the 304 branch) is simpler and strictly more correct: a POST response
never needs an ETag, and on the edge tier it also skips an async SHA-256 over
every POST body (`withEdgeEtag` hashes the body). `req.method` is in scope at
this point (used nearby at server.ts:1809/1822); methods are uppercase, so the
`=== "GET" || === "HEAD"` compare is safe.

**Verify**: `cd packages/runtime && bun run typecheck` → exit 0.

### Step 2: Edge tier

Apply the identical whole-block gate on the edge: skip `withEdgeEtag` (the async
SHA-256) and the `notModified` decision unless
`request.method === "GET" || request.method === "HEAD"`. `request.method` is in
scope (used at fetch-handler.ts:885/893).

**Sequencing**: land 010 **before** plan 019 (which extracts node/edge
request-parsing twins and touches these same regions), or 019's drift check
fires against this change.

**Verify**: `cd packages/cloudflare && bun run typecheck` → exit 0.

### Step 3: Tests + gates

**Verify**:
```
cd packages/runtime && bun run typecheck && bun run test:cov
cd ../cloudflare && bun run typecheck && bun run test:cov
```
→ exit 0, 100% on both.

## Test plan

For each tier, add cases modeled on the existing 304/ETag tests:
1. **GET with matching `If-None-Match` → 304** (unchanged behavior — keep a
   positive test so the gate can't vacuously pass).
2. **POST with `If-None-Match: *` → 200 with body** (the bug fix): assert the
   response is NOT 304 and the body is delivered.
3. **HEAD with matching tag → 304** stays 304.
Make case 2 non-vacuous: confirm it goes red if the method gate is removed.

## Done criteria

- [ ] `cd packages/runtime && bun run test:cov` exit 0, 100%, new POST-not-304 test present
- [ ] `cd packages/cloudflare && bun run test:cov` exit 0, 100%, new POST-not-304 test present
- [ ] `grep -n "GET\" || .*HEAD\|method === \"GET\"" packages/runtime/src/server.ts packages/cloudflare/src/fetch-handler.ts` shows the gate on both tiers
- [ ] No files outside scope modified
- [ ] `plans/README.md` status row for 010 updated

## STOP conditions

Stop and report if:
- The excerpts don't match (drift), or `req.method` / `request.method` isn't
  reachable at the 304 decision (it is in the current code).
- Skipping the 304 for non-GET/HEAD breaks an existing test that (incorrectly)
  asserts a 304 on a non-GET — report it; that test encodes the bug.

## Maintenance notes

- The HEAD path in `web/lesto.ts:187-193` returns `body: ""`, so HEAD's ETag is
  hashed over the empty string — a separate wart (a different validator than the
  GET it mirrors, and it drops the GET's stream un-cancelled). Out of scope here;
  noted for a follow-up if HEAD handling is revisited.
- Reviewer should confirm both tiers changed identically.
