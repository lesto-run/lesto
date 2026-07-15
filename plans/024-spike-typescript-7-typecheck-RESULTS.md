# Plan 024 — RESULTS: TypeScript 7 (native `tsgo`) for the workspace typecheck path

> **Spike, not adoption.** This is a measured report + go/no-go recommendation.
> Nothing was adopted. The repo's `typescript` version, `package.json`,
> `bun.lock`, and all `tsconfig*.json` are **unchanged** (verified — see
> Methodology). `tsgo` was run **ephemerally** from bun's global cache; no repo
> file was mutated.

- **Task**: Studio `L-a7b501c4`
- **Date**: 2026-07-11
- **Machine**: darwin arm64 (Darwin 24.1.0), 14 logical CPUs
- **Baseline compiler**: `typescript@5.9.3` (root pins `^5.7.0`), the repo's `tsc`
- **Candidate compiler**: `@typescript/native-preview@7.0.0-dev.20260707.2`
  (bin `tsgo`; darwin-arm64 native Mach-O binary)
- **Verdict**: **GO — staged / additive.** Parity is complete across every axis
  measured (resolution, type-identity, expected-error, strict flags), on both
  synthetic probes *and* a real in-the-wild error. tsgo is ~6.5× faster on a
  matched harness and ~7× less CPU. Keep `tsc` 5.x as the authoritative gate
  until tsgo reaches RC/GA; add tsgo now as a fast local/pre-push path.

---

## TL;DR numbers

| Measurement (warm) | tsc 5.9.3 | tsgo 7 (dev) | speedup |
|---|---|---|---|
| **Matched harness, full workspace** (xargs -P8, 91 workspaces, same driver for both) | ~21.8 s wall / ~226 s CPU-user | ~3.35 s wall / ~32 s CPU-user | **~6.5× wall, ~7× CPU** |
| Single pkg `web` (heavy: resolves 5 `@lesto` pkgs), 3-run warm | 1.03 s | 0.16 s | ~6.4× |
| Single pkg `queue` (reference), 3-run warm | 0.48 s | 0.04 s | ~12× |
| **Current real gate** `bun run ws:typecheck` (tsc, bun `--filter` fan-out) | 72–85 s wall | *(not directly runnable — see note)* | — |

**Parity (all identical):**

- **Resolution**: 91/91 workspaces produce the **identical pass/fail verdict**
  under both compilers. `--listFiles` confirms tsgo resolves cross-package
  `.ts` via `exports` (the `Bundler` + `.ts`-exports layout). ✅
- **Type-identity + expected-error** (`test:types`): green under both; the
  `Equal<>` identity trick and `@ts-expect-error`/TS2578 mechanisms proven to
  fire identically (non-vacuous — see §3). ✅
- **Strict flags**: `noUncheckedIndexedAccess` (TS2322),
  `exactOptionalPropertyTypes` (TS2375/TS2379), `noImplicitReturns` (TS2366),
  `Expect<false>` constraint (TS2344), unused directive (TS2578) — byte-identical
  diagnostics, same line/column/elaboration. ✅

**One behavioral difference:** on type errors tsgo exits **1**, tsc exits **2**.
Both are non-zero, so `bun run`'s failure detection and any `!= 0` check are
unaffected. No repo script keys on `== 2` (checked). Flag it only for tooling
that would branch on the specific code.

---

## Scope correction: it's **91** workspaces, not 69

The task/plan title says "69-package". The gate `ws:typecheck` is
`bun run --filter '@lesto/*' typecheck`, and **every** matched workspace's
`typecheck` script is exactly `tsc --noEmit` (uniform — no variants). The live
set is:

| area | count |
|---|---|
| `packages/*` (`@lesto/*`) | 66 |
| `examples/*` (`@lesto/example-*`) | 23 |
| `site` (`@lesto/site`) | 1 |
| `www` (`@lesto/www`) | 1 |
| **total** | **91** |

"69" ≈ the `packages/*` slice; the gate also fans out over examples + the two
sites. All 91 were measured.

---

## 1. Wall-clock delta

### Method
The production gate `bun run ws:typecheck` spends most of its wall-clock in
**bun's per-package `bun run` spawn overhead**, not in `tsc` compute
(baseline #1: `real 84.8s`, `user 378s`, **`sys 332s`** — the enormous `sys`
is process/IO churn, not checking). Comparing "tsc-via-bun" to "tsgo-via-a-
different-harness" would confound compiler speed with harness overhead, and
tsgo **cannot be run through the current `--filter` path without editing the
`typecheck` scripts** (out of scope for this spike). So the honest
apples-to-apples number is a **controlled driver** (`xargs -P8`) that runs the
*same* per-package `<compiler> --noEmit` over the *same* 91 workspaces for
*both* compilers. The bun number is reported separately as the real-world
baseline.

### Results (warm; all times seconds, `/usr/bin/time -p real`)

**Controlled driver, P=8, full 91 workspaces:**

| run | tsc 5.9.3 | tsgo 7 |
|---|---|---|
| a | 20.65 (user 221.6) | 3.17 (user 31.7) |
| b | 22.84 (user 235.6) | 3.50 (user 32.1) |
| c | 22.03 | 3.37 |
| **mean** | **~21.8 wall / ~226 user** | **~3.35 wall / ~32 user** |

→ **~6.5× wall-clock, ~7× CPU**, harness held constant.

**Real gate `bun run ws:typecheck` (tsc 5.9.3):** 84.8 s (warmup) / 72.2 s
(2nd run). High variance — the machine was under a concurrent agent fleet
(load average swung 4.8 → 78 during runs). The driver's compute-only number
(~21.8 s) shows how much of the 72–85 s is bun fan-out overhead rather than
`tsc`.

**Per-invocation (sequential, warm, 3 runs, ~0 variance):**
`web` 1.03→0.16 s (6.4×); `queue` 0.48→0.04 s (12×). tsgo's process startup is
tiny (queue checks in 40 ms), so a leaner harness would realize the full delta.

### Two levers, not one
1. **Compiler** (this spike): tsc→tsgo cuts CPU ~7× — materially reduces
   contention on a fleet-busy box, where every agent's typecheck currently burns
   ~226 CPU-s. This alone is a strong reason to adopt for local/dev loops.
2. **Harness** (orthogonal follow-up): the current gate's 72–85 s is dominated
   by `bun run --filter` spawn overhead (`sys` ~300 s). A leaner fan-out (an
   `xargs -P` driver like this spike's, or `tsgo -b` if a solution-style root
   tsconfig existed) would help regardless of compiler. Not this spike's call.

---

## 2. `Bundler` resolution + `.ts`-exports parity

**Identical.** Evidence:

- **91/91 verdict parity.** Running the driver for both compilers, the
  per-package pass/fail sets are identical (a `join` diff of the exit tables is
  empty). Under a clean tree both were 91/91 exit-0; all per-package logs were
  **empty** (zero diagnostics either way).
- **tsgo does real cross-package `.ts` resolution** (not a silent no-op).
  `tsgo --noEmit --listFiles` in `packages/web` pulls source from
  `packages/errors/src`, `packages/observability/src`, `packages/router/src`,
  `packages/ui/src` (+ `web/src`) — i.e. it follows each `@lesto/*` dep's
  `package.json` `exports` to `./src/*.ts`, exactly the `Bundler` +
  `.ts`-exports layout. (Note: `--listFiles` works but is **not** listed in
  `tsgo --help` — undocumented surface.)
- **Real-error parity (in the wild).** During the runs a *sibling agent*
  introduced a genuine type error in `packages/webhooks`
  (`src/pinning-fetch.ts:203` — an `exactOptionalPropertyTypes` violation on
  `signal`). Both compilers flagged the **same package, same file, same
  `(203,9)`, same TS2379, byte-identical message** (full 4-level elaboration).
  This is the strongest possible resolution+checking parity signal: not a
  synthetic fixture, an actual regression, caught identically.
  *(That error is transient sibling worktree state, not part of this spike and
  not touched.)*

---

## 3. Type-identity + expected-error parity (`test:types`) — the critical axis

`test:types` = `tsc -p type-tests/tsconfig.json --noEmit`. It does **not** assert
diagnostic text; it gates on two mechanisms (per ADR 0026):
(a) `type _ = Expect<Equal<A, B>>` — drift makes the alias itself a **TS2344**;
(b) `@ts-expect-error` — a checking-strictness gap turns a suppressed error into
an **unused-directive TS2578** false-RED.

**Suite inventory** (tracked): 19 `Expect<Equal<…>>` + 15 `@ts-expect-error`
across `assert/client/db/routes/drift`; the **untracked** `probe-audit.ts` adds
1 + 1 (accounted for below).

**Aggregate result:** `test:types` is **green (exit 0) under BOTH** tsc and tsgo,
with `probe-audit.ts` present.

**Non-vacuous proof (the important part).** A green suite is only meaningful if
tsgo *actually enforces* both mechanisms. I built a scratch project
(`var/tsgo-spike/probe/`, using the repo's *own* `Equal`/`Expect` and
`@lesto/db` `InferRow`, mirroring `type-tests/drift.fixture.ts`) with cases whose
diagnostics are known, and ran both compilers:

| case | expectation | tsc 5.9.3 | tsgo 7 |
|---|---|---|---|
| (A) `Equal<InferRow, {id:number;…}>` correct | no error | ✅ none | ✅ none |
| (B) `Equal<…, {id:string;…}>` drift | **TS2344** | `(17,22) TS2344` | `(17,22) TS2344` |
| (C) `Equal<…, any>` (any-creep) | **TS2344** (identity trick rejects `any`) | `(20,25) TS2344` | `(20,25) TS2344` |
| (D) `@ts-expect-error` over a real error | suppressed | ✅ none | ✅ none |
| (E) `@ts-expect-error` over a non-error | **TS2578** unused | `(27,1) TS2578` | `(27,1) TS2578` |

Identical codes, lines, **and columns**. Case (C) is decisive: tsgo implements
the `(<T>() => T extends A ? 1 : 2)` invariant-position identity trick the same
way tsc does — it does **not** treat `any` as equal-to-everything. Case (E)
confirms tsgo implements the unused-`@ts-expect-error` (TS2578) check. Therefore
the green suite genuinely means **all 19 `Equal<>` + 15 `@ts-expect-error`
resolve identically** under tsgo. ✅

### `probe-audit.ts` accounting (reproducibility caveat)
`type-tests/probe-audit.ts` is **untracked** in git (`?? type-tests/probe-audit.ts`)
yet is compiled by `test:types` because `type-tests/tsconfig.json` has
`include: ["*.ts"]`. It was **present** during all `test:types` runs above
(1 `Expect<Equal>` + 1 `@ts-expect-error`), and both compilers processed the
suite green with it in place. It was **not** modified or touched. Anyone
re-running the spike on a clean checkout **without** this file will get a
slightly smaller suite (18+14) — note its presence when comparing.

---

## 4. Strict-flag support

No strict flag in `tsconfig.base.json` caused any divergence. The full set is
exercised by the 91-workspace green parity + `test:types` + a targeted probe:

| flag | probe result |
|---|---|
| `strict` (all sub-flags) | ✅ workspace-wide parity |
| `noUncheckedIndexedAccess` | ✅ `arr[0]→number` = **TS2322**, identical |
| `exactOptionalPropertyTypes` | ✅ `{x:undefined}` = **TS2375**, identical; real `TS2379` in webhooks identical |
| `noImplicitReturns` | ✅ = **TS2366**, identical |
| `verbatimModuleSyntax`, `isolatedModules` | ✅ no divergence across 91 pkgs |
| `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals/Parameters`, `forceConsistentCasingInFileNames` | ✅ no divergence |
| `skipLibCheck: true` | on for both — see caveat |

**Caveat:** `skipLibCheck: true` means neither compiler checks `.d.ts` internals,
so a `.d.ts`-only divergence would be masked. Low risk here: source runs from
`.ts` with **no build step**, so there are ~no first-party `.d.ts`; only
`node_modules` declarations are skipped, equally for both. If tsgo is ever used
to *emit* `.d.ts` (not in scope — the gate is `--noEmit`), re-verify.

---

## Caveats / risks

1. **Dev preview, not GA.** `7.0.0-dev.20260707.2` is a nightly-style preview.
   Behavior can change build-to-build. Any adoption must re-run this spike at
   each tsgo bump (cheap — the driver + probes are saved).
2. **Exit code 1 vs 2** on type errors (see TL;DR). Non-issue for `bun run` /
   `!= 0`; a landmine only for tooling that branches on `== 2` (none found).
3. **Undocumented flags.** `--listFiles` works but isn't in `--help`; don't
   assume full CLI parity with `tsc` — audit any flag before relying on it.
4. **No build/emit or `-b` project-references path tested.** The gate is
   `--noEmit` only; that's all this spike validates.
5. **Timing noise.** Runs happened under a live agent fleet (load 4.8→78). The
   *ratios* (driver + per-invocation) are stable and trustworthy; absolute
   `bun run ws:typecheck` wall-clock (72–85 s) is contention-dependent.

---

## Recommendation — **GO (staged / additive)**

Parity is complete and proven non-vacuously across resolution, type-identity,
expected-error, and every strict flag the repo uses — confirmed on synthetic
probes *and* a real regression. The speedup is real (~6.5× wall / ~7× CPU on a
matched harness; 6–12× per invocation).

**Do now (low risk, high value):**
- Adopt tsgo as an **additive fast path** for the local/dev loop and an optional
  pre-push check — e.g. a `typecheck:fast` that fans `tsgo --noEmit` over the
  workspace. The ~7× CPU cut is especially valuable on this fleet-heavy repo
  (each agent's typecheck stops burning ~226 CPU-s).

**Keep as the authoritative gate (until tsgo RC/GA):**
- `tsc` 5.x remains the CI source of truth. Flip CI to tsgo-only **only** after
  (a) tsgo ships a stable/RC line and (b) this spike re-runs green on that build.

**Not this spike (separate tickets):**
- The current gate's 72–85 s is dominated by bun `--filter` spawn overhead, not
  compiler compute. A leaner typecheck harness is a worthwhile, compiler-agnostic
  follow-up.
- Fix the plan/board "69-package" figure → **91** workspace invocations.

**Do not** change `typescript`, `package.json`, `bun.lock`, or any `tsconfig`
as part of this spike. Adoption is a follow-up decision for the owner.

---

## Methodology (reproducible)

```sh
# 0. tsgo, ephemerally — DOES NOT touch repo package.json / bun.lock (verified
#    afterwards with `git status --short bun.lock package.json`: clean).
bunx @typescript/native-preview@7.0.0-dev.20260707.2 --version   # caches native bin
TSGO=$(find ~/.bun/install/cache -maxdepth 4 \
  -path '*native-preview-darwin-arm64@*/lib/tsgo' -type f | head -1)   # standalone Mach-O
TSC=./node_modules/.bin/tsc   # 5.9.3

# 1. Enumerate the gate's set: every @lesto/* workspace with a typecheck script
#    (packages/* + examples/* + site + www = 91; all `tsc --noEmit`).

# 2. Matched-harness delta: same xargs -P8 driver, run per-package
#    `<compiler> --noEmit` in each workspace cwd; time the batch; collect exit
#    codes + logs. (Driver: var/tsgo-spike/run.sh.)
#    tsc: ~21.8s / tsgo: ~3.35s.

# 3. Real gate baseline:  /usr/bin/time -p bun run ws:typecheck   # 72–85s (tsc)

# 4. Per-invocation:  (cd packages/web && $TSC/$TSGO --noEmit) warm x3.

# 5. test:types:  $TSC/$TSGO -p type-tests/tsconfig.json  (both green;
#    probe-audit.ts present).

# 6. Non-vacuous parity probes (scratch, in var/, never in the suite):
#    - var/tsgo-spike/probe/  -> forces TS2344 (Equal drift + any-creep) & TS2578
#    - var/tsgo-spike/flags/  -> forces TS2322 / TS2375 / TS2366
#    Both compilers emit identical codes/lines/columns.
```

Scratch harness + logs live under `var/tsgo-spike/` (git-ignored working
detritus; delete freely). Repo tracked files were not modified by this spike.
