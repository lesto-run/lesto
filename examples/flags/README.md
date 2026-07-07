# examples/flags — feature-flag gating over HTTP

Wires **`@lesto/flags`** behind real HTTP routes to show the one thing a flag is
for: an OFF feature does not exist to a client. `flags.gate(name)` is middleware
that answers a plain **404** when its flag is off — a route in progress neither
`403`-advertises itself nor leaks its shape. Flip the flag and the route appears.

## What it shows

`defineFlags({ defaults, resolve })` declares the flags; `resolve(flag, c)` runs
per request and wins over `defaults` when it returns a boolean, or returns
`undefined` to defer. An undeclared flag is off.

| Route             | Flag (default)                | Behavior                                                                                   |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /dashboard`  | `new-dashboard` (**off**)     | 404 by default; `?preview=1` **or** `x-user-tier: beta` flips it → 200.                    |
| `GET /changelog`  | `public-changelog` (**on**)   | 200 for everyone; a request-time kill switch (`x-kill-changelog: 1`) → 404.               |
| `GET /experiment` | `unlaunched-experiment` (—)   | Always 404 — an **undeclared** flag is off (and `?preview=1` does not leak to it).        |
| `GET /beta/*`     | `beta` (**off**)              | A whole **subtree** hidden by one `.use(flags.gate("beta"))`; `?preview=1` opens it all.   |
| `GET /flags`      | —                             | A diagnostic: `flags.enabled(name, c)` per flag, so the resolution outcome is legible.     |

The `resolve` here shows dynamic beating static in **both** directions — turning
an off flag on (`new-dashboard`, via a preview query or a per-request `x-user-tier`
targeting header) and a shipped flag off (`public-changelog`, via a kill-switch
header) — which is the one thing a static-only config cannot express:

```ts
const flags = defineFlags({
  defaults: { "new-dashboard": false, "public-changelog": true, beta: false },
  resolve: (flag, c) => {
    if ((flag === "new-dashboard" || flag === "beta") && c.query("preview") === "1") return true;
    if (flag === "new-dashboard" && c.header("x-user-tier") === "beta") return true; // targeting
    if (flag === "public-changelog" && c.header("x-kill-changelog") === "1") return false; // kill
    return undefined; // defer to the static default (and an undeclared flag is off)
  },
});

app
  .get("/dashboard", flags.gate("new-dashboard"), handler) // off ⇒ 404
  .route("/beta", lesto().use(flags.gate("beta")).get("/labs", handler)); // subtree gate
```

Only `@lesto/flags`' public API is used for gating (`defineFlags`, the `Flags`
type, `flags.gate`, `flags.enabled`); the routes are plain `@lesto/web`. **No
database** — a flag decision is pure computation over the request.

## How to run

```bash
bun run examples/flags/run.ts
```

Drives every route through `app.handle` in-process and prints the status of each:
`new-dashboard` off → 404, then flipped on by `?preview=1` and by an `x-user-tier:
beta` targeting header; `public-changelog` on → 200, then killed to 404; the
undeclared flag always 404; the `/beta` subtree 404 → 200 as a whole; and finally
the `/flags` resolution table for four different requests, so dynamic-then-static
reads side by side.

## How it's tested (the QA gate)

```bash
bun run --filter '@lesto/example-flags' test
```

`test/flags.test.ts` asserts, over `app.handle`, what only an end-to-end wiring can
prove — and every flip asserts **both** arms (404 off, 200 on) so it is
non-vacuous: were the gate bypassed the off-arm's `toBe(404)` fails; were it
always-closed the on-arm's `toBe(200)` fails.

- `GET /dashboard` is 404 with the flag off, 200 with `?preview=1`, 200 for an
  `x-user-tier: beta` principal but 404 for `x-user-tier: free` (targeting);
- `GET /changelog` is 200 by default and 404 under the kill switch (dynamic
  `false` overriding a static `true`);
- `GET /experiment` (an undeclared flag) is 404 even with `?preview=1`;
- the `/beta` subtree 404s **both** of its routes when off and 200s **both** when
  flipped — one `.use` gate covering the whole area;
- `GET /flags` returns the exact `enabled` map for each request (defaults, preview,
  targeting, kill switch), pinning the dynamic-then-static rule directly.

`test/serve.smoke.test.ts` adds the hosted leg — it boots `serve.ts` over a real
socket and proves the flip over HTTP: `GET /dashboard` is 404, `GET
/dashboard?preview=1` is 200 (see the deploy section below).

## How to deploy / run the hosted leg

```bash
bun run examples/flags/serve.ts
```

Flags has **no database** — `buildApp()` is synchronous and returns a bare
`@lesto/web` app — but `@lesto/kernel`'s `createApp` still requires a `db` handle
to wrap it into a bootable kernel `App`. `serve.ts` opens a THROWAWAY in-memory
SQLite handle purely to satisfy that contract, and passes `durable: false` (no
session/rate-limit tables to install on a handle nothing else touches) and
`secure: false` (no state-changing concern here — every route is a GET). It then
serves the wrapped app behind a real `node:http` server (`@lesto/runtime`'s
`serveWithGracefulShutdown`), so an ACTUAL browser or curl can watch a gated route
wink in and out of existence as a lever flips it:

```bash
open http://localhost:3000/                              # a browsable index

curl -i localhost:3000/dashboard                         # 404 — flag off
curl -i 'localhost:3000/dashboard?preview=1'             # 200 — preview lever
curl -i localhost:3000/dashboard -H 'x-user-tier: beta'  # 200 — per-request targeting
curl -i localhost:3000/changelog -H 'x-kill-changelog: 1'# 404 — kill switch
curl 'localhost:3000/flags?preview=1'                    # the resolution table
```

**The boot is proven automatically.** `test/serve.smoke.test.ts` spawns `bun run
serve.ts` on an ephemeral port, `fetch()`es `GET /dashboard` (404) then
`/dashboard?preview=1` (200) over a real socket, then SIGTERMs and asserts a clean
`exit(0)` — so the hosted boot (`buildApp` → `createApp` →
`serveWithGracefulShutdown`) and the gate itself are exercised end-to-end, not
merely typechecked. Its wiring mirrors the pattern every hosted `serve.ts` in the
gallery uses (see `examples/forms/serve.ts`). **Starting a long-lived server is
blocked in this sandbox**, so running it by hand in a browser is a manual
follow-up; the smoke test is the automated proof it boots and gates.

## DX findings

1. **The gate is exactly one line, and off-by-default is genuinely safe.**
   `.get(path, flags.gate(name), handler)` inline, or `.use(flags.gate(name))` for
   a subtree, composes with `@lesto/web` with no ceremony — the same shape as the
   `@lesto/authz` guard. A 404 (not a 403) for an off flag is the right default:
   the feature simply doesn't exist. The `Object.hasOwn` own-property lookup means
   a flag named `toString`/`__proto__` still reads as off, which is a real
   correctness edge most home-grown flag maps get wrong.

2. **Per-principal targeting is host-wired, not first-class — the friction.**
   `resolve(flag, c)` hands you the raw `Context`, so per-user/per-tenant targeting
   means reading a signal off the request yourself (this example uses an
   `x-user-tier` header as a stand-in for the authenticated principal's tier). That
   is flexible, but there is no built-in bridge to `@lesto/authz`'s resolved
   principal or to a percentage-rollout / bucketing helper — a real app must hash
   its own user id and reach into the session inside `resolve`. A small
   `resolve: (flag, { principal }) => …` convenience, or a `percentageRollout(flag,
   key, pct)` helper, would remove the most common boilerplate. → `@lesto/flags`
   (enhancement).

3. **`resolve` is a single function over all flags, so per-flag rules pile into one
   `if` ladder.** Fine at this scale; a larger app would want a per-flag resolver
   map (`resolve: { "new-dashboard": (c) => …, … }`) to avoid a growing branch that
   must string-match the flag name. → `@lesto/flags` (minor, ergonomic).
