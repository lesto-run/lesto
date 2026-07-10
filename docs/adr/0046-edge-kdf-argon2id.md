# ADR 0046 — Edge password KDF: adopt memory-hard **argon2id** as the edge-portable mint default, retiring the interim 100k PBKDF2 floor

- **Status:** **Proposed — pending owner ratification.** Decision document only; implementation is
  deliberately gated on this ADR (board task `L-cea1370e`, follow-up from the `b932aa1` security
  review). The 100k-PBKDF2 pin this ADR supersedes is **correct and stays** until the replacement
  lands — 100k that works beats 600k that throws on every deployed-Worker login.
- **Date:** 2026-07-10.
- **Deciders:** tech lead + owner (authored under board task `L-cea1370e`).
- **Builds on / touches:** ADR 0003 (auth strategy) and ADR 0020 (auth factors — recovery codes ride
  the same KDF); the `b932aa1` edge-iteration-cap fix (L-f0145c40/L-7a8faaf6) whose own code comment
  names this ADR as the tracked follow-up (`packages/auth/src/password-web.ts:70-78`); the migration
  runbook `docs/guide/edge-password-migration.md`; ADR 0029's **Phase-0 hard-gate spike** precedent
  (crypto-on-workerd claims are verified on a *deployed* Worker before any flow code — the exact
  lesson `b932aa1` re-taught).
- **Grounded in (seams audited 2026-07-10):** the runtime probe + mint selector
  `packages/auth/src/runtime.ts` (`isWorkerd()` :36, `selectPasswordAlgorithm()` :58); the adaptive
  facade `packages/auth/src/password.ts` (prefix dispatch `isPbkdf2` :44, the edge scrypt refusal
  `AUTH_KDF_UNAVAILABLE` :82-88, `needsRehash` :98); the edge backend
  `packages/auth/src/password-web.ts` (format :14, `EDGE_MAX_ITERATIONS` :80,
  `assertMintableIterations` :236, the workerd over-ceiling verify refusal :308, the walk-up-AND-down
  rehash oracle :333); the Node backend `packages/auth/src/password-scrypt.ts` (the
  reject-hostile-cost precedent `N > DEFAULT_N` :154, `MAXMEM` :90); the identity seam
  `packages/identity/src/identity.ts` (`PasswordHasher` :137, `productionHasher` :165,
  `pbkdf2MigrationHasher` :200, length-only password policy :101-105, `onUnverifiableHash` :437, the
  rehash-on-login seam :887-889, the timing-decoy epilogue :884-895); recovery codes riding the same
  facade `packages/auth/src/recovery-codes.ts`.

## Context

**Where the interim pin left us.** workerd's WebCrypto hard-rejects any PBKDF2 `deriveBits` above
100,000 iterations (`cloudflare/workerd#1346` — a fixed DoS guard, not raisable by any compat flag),
and the cap gates *verifying* as well as *minting*. `b932aa1` therefore pinned every minted
`pbkdf2$…` hash at exactly `EDGE_MAX_ITERATIONS = 100_000` on **every** runtime
(`password-web.ts:80-88`), because the format's whole reason to exist is to run on the edge: a hash
minted at 600k was CI-green and threw on every deployed-Worker login. The pin is the right call and
this ADR does not relitigate it.

**What the pin costs.** 100k PBKDF2-HMAC-SHA256 is ~6× below OWASP-2023's 600k recommendation. That
is a real regression against the **offline** crack of an exfiltrated hash DB — the threat class a
KDF cost exists to defend. The per-account `loginRateLimiter` bounds only *online* guessing; it does
nothing once the `password_hash` column has left the building. Magnitude, order-of-magnitude (rates
from the `b932aa1` review, not re-benchmarked here): one RTX 4090 at ~21.7 GH/s raw SHA-256 sustains
≈ 108k PBKDF2-100k guesses/s vs ≈ 18k/s at 600k; an 8-char alphanumeric password (~41 bits) falls in
≈ 30 GPU-days at 100k vs ≈ 180 at 600k. And the weakening lands hardest on exactly the users the
door admits weakest: identity's password policy is **length-only** (min 8, max 128, no complexity or
breach check — `identity.ts:101-105`), so the 8-char-dictionary tail is real, not hypothetical.

**The lever.** The platform forces "**not scrypt**" — scrypt's ~128 MiB working set at N=2^17
OOM-kills the 128 MB isolate, uncatchably. It does **not** force "PBKDF2". PBKDF2's weakness is
architectural: it is CPU-hard only, built from a primitive (SHA-256) that GPUs execute in millions of
parallel lanes, so *any* affordable iteration count loses to commodity hardware. A **memory-hard**
KDF changes the economics: argon2id at the OWASP-listed 19 MiB / t=2 / p=1 fits comfortably inside
the 128 MB isolate, runs on the paid plan the 100k-PBKDF2 path already requires (any real KDF blows
the free plan's 10 ms CPU cap — `password-web.ts:22-25`), and caps a 24 GB GPU at roughly a thousand
concurrent instances instead of millions of hash lanes. The stored format is already self-describing
and prefix-dispatched (`scrypt$…` / `pbkdf2$…`), so `argon2id$…` is a third backend behind the same
facade, not a redesign.

**Why now-ish, and why an ADR first.** Every `pbkdf2$100k` row minted today is a row that later
needs a rehash-on-login walk-up; the corpus only grows. But the last edge-KDF change shipped a
CI-green/Worker-broken bug, and concurrent work owns `packages/auth`/`packages/identity` right now —
so this is a decision document with a hard verification gate, not an implementation.

## Decision drivers

- **The 128 MB isolate ceiling** — the constraint that created this problem. Any candidate's
  *worst-case* memory (parameters × concurrent derives in one isolate) must sit far from it; an OOM
  is not a catchable error.
- **workerd WASM availability and its code-generation restriction.** Workers support WebAssembly,
  but (high confidence, verify at spike) **runtime compilation from bytes is disallowed** —
  `WebAssembly.compile` / `new WebAssembly.Module(buffer)` on arbitrary buffers is blocked by the
  embedder; a `.wasm` must arrive as a deploy-time **module import** (wrangler's `CompiledWasm` rule)
  and be instantiated from the precompiled module. This disqualifies libraries that only ship
  base64-inlined wasm compiled at runtime, unless they accept an injected `WebAssembly.Module`.
- **Bundle size / cold start.** An argon2 wasm build is on the order of tens of KiB; a pure-JS
  implementation a few KiB. Both are noise against Workers bundle limits, and module-imported wasm
  is compiled at deploy, not per-isolate — cold-start cost is expected negligible (verify at spike).
- **Publish-pipeline cost of a binary asset.** The 0.1.6→0.1.7 src→dist saga (tsup `node:` stripping,
  subpath/peer breakage) proved that anything unusual in the build pipeline bites. `@lesto/auth` is
  currently pure TS with one workspace dep; shipping a `.wasm` file through tsup +
  `rewriteManifestForPublish` + every consumer bundler (wrangler, Vite, the `packages/cloudflare`
  wrangler emitter) is a **new asset class** for the pipeline. A pure-JS backend rides the existing
  pipeline untouched.
- **Licensing & supply chain.** The argon2 reference implementation is CC0/Apache-2.0 dual-licensed,
  so permissively-licensed wasm builds exist; candidate packages (`@noble/hashes`, `hash-wasm`,
  `@phi-ag/argon2`, `argon2-browser`) are believed MIT — **to be audited at implementation, not
  assumed here**. `@lesto/auth` is a security package; one small, pinned, auditable dep (or a
  vendored first-party build) is the bar, not a dep tree.
- **Maintenance burden.** A third backend is permanent surface: format parsing, fail-closed
  invariants, rehash oracle, cross-runtime tests, docs. The facade discipline
  (`parseStored`-rejects-everything-not-ours, constant-time compare, coded refusals) is already
  established twice; the marginal cost is real but bounded.
- **Fail-safe symmetry** (`runtime.ts:11-15`): a mis-detected runtime must degrade to *secure and
  alive*, never to *crashed*. argon2id at 19 MiB is safe to run anywhere — it actually *improves*
  the ambiguous-runtime fallback, which today gets weak PBKDF2.
- **The `b932aa1` doctrine:** the edge-portable format must be mintable-everywhere and
  edge-runnable-by-construction, with the ceiling enforced loudly on every runtime
  (`assertMintableIterations` precedent) so Node tests exercise the edge's refusal.

## Options considered

### Option A — adopt **argon2id** as the edge-portable mint default *(recommended)*

Memory-hard, side-channel-balanced (the `id` variant), the OWASP first choice and RFC 9106's
recommendation. At the OWASP-listed **m=19456 KiB (19 MiB), t=2, p=1** it fits the isolate with ~6×
headroom even under a few concurrent derives, and `p=1` matches the no-threads reality of wasm on
workerd.

- **Pros:** kills the GPU-lane advantage that makes any PBKDF2 count weak (the attacker must spend
  19 MiB *per guess in flight*); restores ≥ OWASP posture on the edge; runs on every runtime (JS/wasm),
  so `argon2id$…` rows — unlike `scrypt$…` — can never strand a user behind `AUTH_KDF_UNAVAILABLE`;
  improves the ambiguous-runtime fallback from weak-PBKDF2 to memory-hard; slots behind the existing
  prefix-dispatch facade with zero change to `@lesto/identity`'s `PasswordHasher` seam.
- **Cons:** a new dependency (or vendored wasm) in the most security-sensitive package; the wasm
  route must clear the workerd code-gen restriction and the publish pipeline; per-derive memory is
  no longer negligible (19 MiB × concurrent derives — see Risks); defender-side CPU on workerd is
  estimated, not measured (spike-gated below).

Two implementation routes, chosen by the spike, in this order of preference **only if the numbers
support it**:

- **A-wasm** — an argon2 wasm build consumed as a deploy-time module import. Candidates: a vendored
  first-party build from the reference C (CC0/Apache-2.0), `@phi-ag/argon2` (Workers-targeted),
  `hash-wasm` *iff* it accepts an injected precompiled module (its default base64+runtime-compile
  path is expected blocked on workerd). Expected ~1.5–2× of native speed → roughly 50–150 ms per
  derive at 19 MiB/t=2 (estimate).
- **A-js** — `@noble/hashes`' pure-JS `argon2id`. Zero assets, zero code-gen concerns, one
  audited-family zero-dep package, identical bytes on every runtime, rides the existing publish
  pipeline untouched. Cost: JS speed, estimated ~200–500 ms per derive at 19 MiB/t=2 (estimate;
  fine against the paid plan's default 30 s CPU limit, but real latency and CPU-billing weight).
  Note: noble's *argon2* module's third-party-audit coverage is **unverified** (the family is
  audited; whether the argon2 addition was in scope must be checked).

**Hard gate (ADR 0029 Phase-0 precedent):** before any facade code, benchmark BOTH routes on a
**deployed Worker** (not miniflare, not Node — the `b932aa1` lesson) at m=19456/t=2/p=1: p50/p95
derive time, isolate memory under 4 concurrent derives, bundle delta, cold start. Acceptance:
derive ≤ ~250 ms p50 and headroom at 4× concurrency; prefer A-js if it passes (fewest moving
parts), else A-wasm.

### Option B — stay on 100k PBKDF2 and compensate

Accept the ~6× offline regression as the permanent edge posture; spend the effort on compensating
controls: raise the minimum password length (8 → 12), add a breach-password check at registration/
reset (HIBP k-anonymity range API — an outbound `fetch` with an availability/fail-open story), and
optionally a **pepper** (an HMAC pre-hash under a Worker-secret key, held outside the DB).

- **Pros:** zero new dependency in the KDF path; no binary asset; the compensations are genuinely
  valuable — a breached or 8-char-dictionary password falls to *any* KDF cost, and a pepper defeats
  the DB-only exfiltration threat outright at every iteration count.
- **Cons:** the headline number stays below OWASP for every password the policy admits, forever —
  a hard sell for a batteries-included framework whose pitch is safe-by-default; the pepper is not
  free (secret rotation needs a key-id in the hash format; a full-server compromise takes the pepper
  *with* the DB, so it hardens only the partial-breach case); the compensations are **orthogonal**
  — they strengthen Option A identically, so they are arguments for doing them *anyway*, not for
  standing still. Recommended as follow-ups regardless of this ADR's outcome; not as the decision.

### Option C — scrypt at reduced parameters on the edge

OWASP's scrypt guidance admits lower-memory/higher-parallelism equivalents; N=2^15, r=8, p=3 is a
listed configuration at ~32 MiB — inside the isolate. Two sub-routes: workerd's `nodejs_compat`
`node:crypto` scrypt (native, **availability/limits unverified**), or scrypt-wasm / `@noble/hashes`
scrypt (pure JS, audited).

- **Pros:** algorithm-family parity with the Node tier (one KDF story, simpler docs); noble's scrypt
  is within its audited core; memory-hard, so it clears the same GPU bar.
- **Cons:** the `nodejs_compat` route would make `@lesto/auth`'s edge path depend on a compat flag
  it deliberately avoids today (pure WebCrypto), on an unverified implementation with unknown
  internal memory caps — the exact class of platform surprise that produced this ADR; the wasm/JS
  route pays all of Option A's shipping costs for a *less* preferred algorithm (argon2id is the
  current OWASP/RFC first choice; scrypt at low N concedes more to time-memory trade-off attacks);
  32 MiB × concurrency is ~1.7× Option A's isolate pressure. Choose C only if the spike falsifies
  argon2id on workerd entirely.

### Option D — bcrypt *(rejected without a spike)*

Not meaningfully memory-hard (~4 KiB working set — GPU-crackable at scale), truncates input at 72
bytes (silently, against a 128-max policy), and its cost knob buys strictly less than argon2id's at
the same defender budget. No advantage over A or C on any driver.

*(Out of scope, noted for completeness: OPAQUE/PAKE and client-side pre-hashing change the protocol,
not the at-rest KDF, and are not 0.x-horizon work.)*

## Proposed decision

**Adopt Option A.** argon2id becomes the KDF `@lesto/auth` mints on workerd — and on every
ambiguous/unknown runtime — once the hard-gate spike passes on a deployed Worker. Node keeps native
scrypt as its mint default (no regression, no new dep on the Node hot path; scrypt N=2^17's 128 MiB
working set concedes nothing to 19 MiB argon2id). PBKDF2 is demoted to **verify-only legacy**: never
minted again, verified forever, promoted to argon2id by the existing rehash-on-login seam.

### Parameters (starting recommendation)

- **m=19456 KiB (19 MiB), t=2, p=1** — the OWASP-2023-listed configuration; `p=1` because wasm on
  workerd has no threads and cross-runtime hashes must verify identically everywhere.
- **Salt 16 bytes** (parity with both existing backends' `SALT_BYTES`), **tag/key 32 bytes**,
  argon2 **version 0x13 (19)**.
- If the spike shows generous CPU headroom, prefer raising **t** (pure CPU) over **m** (isolate
  pressure). The alternative OWASP point m=47104 (46 MiB)/t=1 is *not* recommended: 46 MiB ×
  concurrent derives crowds the isolate for no defender-relevant gain.

### Integration design — the third backend behind the existing facade

- **Format (house discipline, not PHC):** `argon2id$<v>$<m>$<t>$<p>$<saltHex>$<keyHex>` — seven
  `$`-separated segments, parameters travel with the hash, exactly like
  `scrypt$N$r$p$salt$hash` and `pbkdf2$digest$iterations$salt$key`. A leading-`$` PHC string would
  break the facade's `split("$")`/prefix discipline; interop with PHC tooling is a trivial external
  converter if ever needed. A new `password-argon2.ts` mirrors `password-web.ts`'s shape:
  `parseStored` returns `undefined` for anything not ours (wrong arity, unknown version, non-integer
  params, mis-sized salt/key), verify is a constant-time compare, malformed input resolves `false`.
- **Fail-closed parameter ceilings, on every runtime.** Mirror both precedents: an
  `assertMintableArgon2Params` guard (the `assertMintableIterations` :236 pattern — throw a coded
  `AuthError`, never clamp silently, so Node tests exercise the edge refusal), and a parse-side
  reject of any stored `m` above the ceiling (the scrypt `N > DEFAULT_N` :154 pattern — a hostile or
  corrupt row must not be able to command a 2 GiB derive and OOM the isolate). Ceiling starts equal
  to the mint default (`EDGE_MAX_MEMORY_KIB = 19456`); raising it is a deliberate, reviewed act.
- **Mint selection** (`runtime.ts`): `PasswordAlgorithm` gains `"argon2id"`.
  `selectPasswordAlgorithm()` returns `"argon2id"` for workerd **and** for the
  ambiguous/unknown-runtime fallthrough (strictly better than today's weak-PBKDF2 fallback, and
  still fail-safe — 19 MiB cannot OOM anything); `"scrypt"` for positively-identified Node,
  unchanged.
- **Verify dispatch** (`password.ts`): prefix check `isArgon2id` alongside `isPbkdf2`; `argon2id$…`
  routes to the new backend on every runtime. If the backend itself cannot initialize (wasm asset
  failed to load on an exotic runtime), refuse with the existing coded `AUTH_KDF_UNAVAILABLE` so it
  flows through the one established migration/`onUnverifiableHash` path — never an uncoded throw.
- **`needsRehash` — promotion without ping-pong.** The facade's oracle becomes mint-target-aware for
  the pbkdf2 prefix only: a `pbkdf2$…` row reports stale when this runtime's mint target is
  argon2id (edge + unknown), else defers to `needsRehashWeb` as today; an `argon2id$…` row compares
  its own params against the current defaults (walking **up and down** to the pinned params, the
  `needsRehashWeb` :333 convergence discipline); `scrypt$…` behavior is untouched. Explicit
  invariant: **no cross-promotion between scrypt and argon2id in either direction** — both are
  at-strength — so a hybrid deployment (Node mints scrypt, edge mints argon2id) can never thrash a
  row between algorithms on alternating logins.
- **`@lesto/identity` needs no seam change.** `productionHasher` (:165) wraps the facade functions
  and picks all of this up for free — passwords, the timing decoy (:884-895; minted via
  `hashPassword`, so it automatically costs argon2id on the edge), and recovery codes
  (`recovery-codes.ts` hashes with the same primitive by design). One addition, not a change: an
  `argon2idMigrationHasher` preset succeeding `pbkdf2MigrationHasher` (:200) — mints argon2id even
  on Node, reports every non-argon2id row stale — for hybrid/migrating Node tiers, inheriting the
  same documented timing-enumeration caveat while the corpus is mixed.

### Migration / rollout

- **This migration is strictly gentler than scrypt→PBKDF2 was.** A `pbkdf2$100k` row still
  *verifies* on the edge — nobody is locked out, there is no `AUTH_KDF_UNAVAILABLE` wave, no reset
  emails, no drain-query urgency. The rehash-on-login seam (`identity.ts:887-889`) re-mints each
  user's proven plaintext as `argon2id$…` on their next successful login; the dormant tail simply
  stays at 100k PBKDF2 — no worse than today — until it logs in or resets. PBKDF2 verify support is
  kept indefinitely (it is ~40 lines of WebCrypto with no dependency; deleting it buys nothing and
  strands the tail).
- **Version-skew ordering (the one real hazard).** An **older** `@lesto/auth` reading an
  `argon2id$…` row mis-routes it down the not-pbkdf2 arm of `verifyPassword` (:77-90): on old-edge
  it throws the coded `AUTH_KDF_UNAVAILABLE` (safe, enumeration-clean); on old-Node it reaches
  `verifyPasswordScrypt`, whose `parseStored` rejects the prefix and resolves **`false`** — a
  *silent* invalid-credentials for a correct password, indistinguishable from a typo. Therefore:
  **every tier that verifies a shared corpus upgrades to an argon2id-capable `@lesto/auth` before
  any tier mints argon2id.** For the common single-artifact Lesto app this is automatic; for hybrid
  deployments (Node admin CLI + edge front end on separately-pinned versions) the runbook
  (`docs/guide/edge-password-migration.md`, to be extended alongside implementation) documents the
  order. If desired, stage it across two releases — verify-support first, mint-default flip second —
  as a belt-and-suspenders for hybrid users; single-release is acceptable at 0.x.
- **Corpus inventory** for operators mirrors the existing drain query: count rows by prefix +
  parameters (`split_part(password_hash, '$', 1)`), watch `argon2id$…` share rise; no action is
  *required* on the tail.

## Consequences & risks

- **Security:** edge posture returns to at-or-above OWASP; the offline-crack economics move from
  "commodity-GPU-friendly" to memory-bound. The length-only password policy (min 8) remains the
  weakest link and is untouched by any KDF — the Option-B compensations (min-length 12,
  breach-password check) are recommended as an independent follow-up battery regardless.
- **Per-derive memory is no longer negligible — the new class of risk this ADR introduces.** N
  concurrent derives in one isolate cost ~N × 19 MiB; at ~5–6 concurrent logins plus app heap the
  128 MB cap comes into view. Mitigation, in the backend, v1: a small per-isolate derive semaphore
  (concurrency 2–3; excess derives queue — bounded added latency, zero OOM exposure), plus a fresh
  wasm `Instance`/`Memory` per derive dropped afterward (module stays cached; wasm memory cannot
  shrink, so a resident instance would pin 19 MiB forever). The spike measures this.
- **CPU/latency:** logins on the edge get slower (est. 50–150 ms wasm / 200–500 ms JS vs ~30–60 ms
  PBKDF2-100k native) and CPU-billing heavier. This is the *point* of a KDF; it stays comfortably
  inside the paid plan's default CPU limit, and the free plan was already excluded by any real KDF.
- **Surface:** a third permanent backend (format, parser, guards, tests, docs) and either a `.wasm`
  asset threaded through the publish pipeline or one pinned pure-JS dependency in `@lesto/auth` —
  each a standing maintenance and supply-chain commitment in the most security-sensitive package.
- **Timing enumeration during the mixed-corpus window:** same caveat as the scrypt→PBKDF2 migration
  (an argon2id decoy does not cost the same as a PBKDF2-row verify); same mitigations — rate
  limiter wired, window short, latency-by-outcome monitored. Drains as logins convert.
- **If the spike fails** (workerd wasm blocked in a way module-imports don't solve AND pure-JS blows
  the CPU budget): fall back to Option C's noble-scrypt route at N=2^15/r=8/p=3, and only if *that*
  fails, Option B's compensations. The facade design is identical for either memory-hard backend.

## Non-goals

- Changing the Node mint default (scrypt N=2^17 stays; revisiting single-algorithm convergence is
  Open question 2, not this decision).
- Password-policy hardening (breach checks, min-length) — recommended follow-up, separate track.
- Peppers, OPAQUE/PAKE, client-side pre-hashing — orthogonal protocol/at-rest changes, out of scope.
- Any change to session, token, or TOTP crypto — this ADR touches only the password/recovery-code
  KDF.

## Open questions for the ratifier

1. **Backend route + supply chain (spike-gated):** vendored first-party wasm vs `@phi-ag/argon2` vs
   `hash-wasm`-with-injected-module vs pure-JS `@noble/hashes` — decided by the deployed-Worker
   benchmark plus a license/size/audit check none of which could be verified from this sandbox (no
   network). The workerd runtime-wasm-compilation restriction itself is high-confidence but must be
   re-verified against current workerd at the spike.
2. **Should Node converge on argon2id too?** One algorithm everywhere would collapse the entire
   `scrypt$…`-on-edge migration class for future hybrid apps (one corpus, one format) at the cost of
   trading Node's 128 MiB scrypt for 19 MiB argon2id and putting a wasm/JS dep on the Node hot path.
   This ADR proposes **no** (keep scrypt) as the conservative default; reversible later by flipping
   `selectPasswordAlgorithm`'s Node arm, since verify support ships everywhere anyway.
3. **Rollout staging:** single release vs two-stage (verify-support release, then mint-default flip)
   for hybrid multi-tier deployments — see the version-skew hazard above. Two-stage is safer;
   single-release is simpler and defensible at 0.x.

## Claims not verified against the codebase or a live system (do not ratify these as facts)

- The workerd **wasm code-generation restriction** (module imports required; runtime
  `WebAssembly.compile` from bytes blocked) — high confidence from platform knowledge, unverified
  here; it is the spike's first checkpoint.
- All **performance estimates** (wasm ≈ 50–150 ms, pure-JS ≈ 200–500 ms per 19 MiB/t=2 derive on
  workerd; PBKDF2-100k ≈ 30–60 ms) and **bundle-size** figures (wasm "tens of KiB") — estimates,
  to be replaced by deployed-Worker measurements.
- **Licenses and audit status** of `@phi-ag/argon2`, `hash-wasm`, `argon2-browser`, and the audit
  coverage of `@noble/hashes`' argon2 module specifically.
- workerd `nodejs_compat` **`node:crypto` scrypt availability and memory limits** (Option C's native
  route).
- The **GPU crack-rate arithmetic** (4090 ≈ 21.7 GH/s SHA-256; ≈ 108k vs 18k guesses/s; 30 vs 180
  GPU-days for ~41 bits) is carried over from the `b932aa1` review as order-of-magnitude framing,
  not re-benchmarked.
- Workers **paid-plan default CPU limit (~30 s, configurable)** and **bundle-size caps** — believed
  current, verify against Cloudflare limits docs at implementation.
