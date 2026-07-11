# ADR 0046 — Edge password KDF: adopt memory-hard **argon2id** as the edge-portable mint default, retiring the interim 100k PBKDF2 floor

- **Status:** **Accepted — ratified 2026-07-10** via the delegated adversarial-review +
  chief-architect process the owner directed (fable red-team + opus chief-architect, board
  task `L-cea1370e`). The **strategic decision** — retire the interim 100k-PBKDF2 edge floor
  for a **memory-hard** edge KDF — is ratified **unconditionally**. The **backend** (pure-JS
  vs wasm argon2id) and the concrete parameters remain **gated on the Phase-0 deployed-Worker
  spike** below (ADR 0029 precedent); a workerd-falsifies-both-argon2-routes outcome falls
  back to Option C (noble-scrypt). Ratification folded in ten required amendments from that
  review — see the **Amendment trail** at the end. The 100k-PBKDF2 pin this supersedes is
  **correct and stays** until the replacement lands **and its mandatory two-stage rollout
  completes** — 100k that works beats 600k that throws on every deployed-Worker login.
  - **Phase-0 spike DONE (2026-07-10, board `L-557c95dd`) — backend resolved: A-wasm; OWNER-RATIFIED
    2026-07-10.** (see the **Phase-0 spike outcome** section below and
    `spikes/adr-0046-edge-kdf/FINDINGS.md`). A-js measured **~10–16× slower per derive on a
    deployed Worker** (≈0.5–0.8 s vs A-wasm's ≈40–50 ms) and busts the R4 enrollment budget → the
    ratified decision procedure falls to **A-wasm**; Option C is not triggered. IT4 (wasm code-gen
    restriction) is **confirmed** on current workerd. The Q1 *default* flip to **A-wasm** and its
    wasm-pipeline cost are **ratified** (owner, 2026-07-10, via the delegated fable-chief-architect
    ruling) under the chief-architect's three conditions: **C1** — Stage 2 (the mint-default flip)
    stays gated on the Workers-Paid envelope re-run (`L-3bb43929`) against a **numeric login-timeout
    budget the OWNER writes before that re-run** (deliberately not fixed here, so the gate is not
    post-hoc fitted — suggested starting point p95 cpuTime+overhead ≤ 250 ms, p95 e2e ≤ 750 ms);
    **C2** — no release containing the facade ships until the IT3 vendored-first-party-wasm bar is
    met (`L-cd31248e`); **C3** — the design keeps assuming 128 MB (A12; the ~256 MiB Free-plan
    measurement is not banked) and the A16 Node/Bun verify path (`L-3ab85cc4`) is specified before
    the facade lands. Stage-1 facade/verify-support (`L-93f03791`) proceeds now. The
    fable-chief-architect + opus red-team amendments **A11–A17** are folded into the text.
- **Date:** 2026-07-10.
- **Deciders:** tech lead + owner (authored under board task `L-cea1370e`); **ratified
  2026-07-10** by the delegated red-team + chief-architect review the owner directed.
- **Builds on / touches:** ADR 0003 (auth strategy) and ADR 0020 (auth factors — recovery codes ride
  the same KDF); the `b932aa1` edge-iteration-cap fix (L-f0145c40/L-7a8faaf6) whose own code comment
  names this ADR as the tracked follow-up (`packages/auth/src/password-web.ts:70-78`); the migration
  runbook `docs/guide/edge-password-migration.md`; ADR 0029's **Phase-0 hard-gate spike** precedent
  (crypto-on-workerd claims are verified on a *deployed* Worker before any flow code — the exact
  lesson `b932aa1` re-taught).
- **Grounded in (seams audited 2026-07-10, re-verified at ratification; line numbers as of this
  commit — symbol names are the durable anchor):** the runtime probe + mint selector
  `packages/auth/src/runtime.ts` (`isWorkerd()` :60, `selectPasswordAlgorithm()` :98); the adaptive
  facade `packages/auth/src/password.ts` (prefix dispatch `isPbkdf2` :44, the edge scrypt refusal
  `AUTH_KDF_UNAVAILABLE` :77-90, `needsRehash` :98); the edge backend
  `packages/auth/src/password-web.ts` (format :14, `EDGE_MAX_ITERATIONS` :80, the workerd
  over-ceiling verify refusal ~:277-283, the walk-up-AND-down rehash oracle `needsRehashWeb`
  doc :294-300 / fn :302); the Node backend `packages/auth/src/password-scrypt.ts` (the
  reject-hostile-cost precedent `N > DEFAULT_N` :154, the prefix-reject-to-`false` at :123, `MAXMEM`
  :90); the identity seams `packages/identity/src/identity.ts` (`PasswordHasher` :137,
  `productionHasher` :165, `pbkdf2MigrationHasher` :200, length-only password policy :101-105,
  `onUnverifiableHash` :511, the rehash-on-login seam **:964-997** — `needsRehash` check :969, re-mint
  via `hashPassword` :974, persist :975 — the timing-decoy epilogue `failLogin` :914-923, and
  `describeHashCost` :296, the `password_rehashed` audit event's cost parser, which needs an
  `argon2id$…` arm, see Integration design); recovery codes riding the same facade
  `packages/auth/src/recovery-codes.ts` (`hashRecoveryCodes` :90-92 — currently a concurrent
  `Promise.all` fan-out, the load-bearing OOM hazard on the argon2id path; `DEFAULT_COUNT = 10` :26).

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
KDF changes the economics: argon2id at the OWASP-listed 19 MiB / t=2 / p=1 fits inside the 128 MB
isolate *for a single derive*, runs on the paid plan the 100k-PBKDF2 path already requires (any real
KDF blows the free plan's 10 ms CPU cap — `password-web.ts:22-25`), and caps a 24 GB GPU at roughly a
thousand concurrent instances instead of millions of hash lanes. The stored format is already
self-describing and prefix-dispatched (`scrypt$…` / `pbkdf2$…`), so `argon2id$…` is a third backend
behind the same facade, not a redesign. (The one genuinely new class this introduces — per-derive
memory that is *not* negligible — is the subject of the concurrency amendments below; it is why the
derive semaphore is mandatory, not a nicety.)

**Why now-ish, and why an ADR first.** Every `pbkdf2$100k` row minted today is a row that later
needs a rehash-on-login walk-up; the corpus only grows. But the last edge-KDF change shipped a
CI-green/Worker-broken bug, and concurrent work owns `packages/auth`/`packages/identity` right now —
so this is a decision document with a hard verification gate, not an implementation.

## Decision drivers

- **The 128 MB isolate ceiling** — the constraint that created this problem. Any candidate's
  *worst-case* memory (parameters × **concurrent** derives in one isolate, plus the module's resident
  footprint and app heap) must sit far from it; an OOM is not a catchable error. Single-derive
  headroom (~6.7×) is not the operative figure — concurrent headroom is (see Risks).
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
  pipeline untouched. **This is the driver that decides Q1 in favour of pure-JS** (see Ratified
  answers).
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
  alive*, never to *crashed* — **"when in doubt, pick the one that cannot crash."** This drives the
  mint routing (Integration design): argon2id mints **only on positively-identified workerd**; every
  ambiguous/unknown runtime keeps minting PBKDF2, because PBKDF2's memory is negligible and cannot
  OOM, whereas argon2id-under-concurrency can. A mis-identified host minting the ~6×-weak PBKDF2 is
  *recoverable* (rehash-on-login once it is positively identified as workerd); an OOM is not. Routing
  the unknown fallthrough to argon2id would *invert* this doctrine, so we do not.
- **The `b932aa1` doctrine:** the edge-portable format must be mintable-everywhere and
  edge-runnable-by-construction, with the ceiling enforced loudly on every runtime — the
  parse/verify-side over-ceiling refusal (`AUTH_KDF_UNAVAILABLE`) fires on Node too, so Node tests
  exercise the edge's refusal. (The mint-side `assertMintableIterations` guard was removed in this
  same session — task `L-ecdeeeab` — as never-shipped surface, once the mint cost became a
  non-configurable constant with no untrusted input to assert.)

## Options considered

### Option A — adopt **argon2id** as the edge-portable mint default *(recommended, ratified)*

Memory-hard, side-channel-balanced (the `id` variant), the OWASP first choice and RFC 9106's
recommendation. At the OWASP-listed **m=19456 KiB (19 MiB), t=2, p=1** a *single* derive fits the
isolate with ~6.7× headroom; **concurrent** headroom is far smaller (~1.2–1.5× at a few concurrent
derives — see Risks) and is the spike's key unknown, which is exactly why the per-isolate derive
semaphore is **mandatory, not optional**. `p=1` matches the no-threads reality of wasm on workerd.

- **Pros:** kills the GPU-lane advantage that makes any PBKDF2 count weak (the attacker must spend
  19 MiB *per guess in flight*); restores ≥ OWASP posture on the edge; runs on every runtime (JS/wasm),
  so `argon2id$…` rows — unlike `scrypt$…` — can never strand a user behind `AUTH_KDF_UNAVAILABLE`;
  slots behind the existing prefix-dispatch facade with zero change to `@lesto/identity`'s
  `PasswordHasher` seam.
- **Cons:** a new dependency (or vendored wasm) in the most security-sensitive package; **per-derive
  memory is no longer negligible** — this is the new risk class, forcing a derive semaphore, a
  bounded (non-fan-out) recovery-code mint, and a DoS-resistant decoy path (see Integration design +
  Risks); the wasm route must clear the workerd code-gen restriction and the publish pipeline;
  defender-side CPU on workerd is estimated, not measured (spike-gated below).

Two implementation routes, **in the ratified order of preference** (Q1): **A-js first**, A-wasm as
fallback — chosen by the spike on the acceptance gate below:

- **A-js *(ratified default)*** — `@noble/hashes`' pure-JS `argon2id`. Zero assets, zero code-gen
  concerns, one audited-family zero-dep package, identical bytes on every runtime, rides the existing
  publish pipeline untouched. This maximally preserves `@lesto/auth`'s "pure-TS, one-workspace-dep"
  property and sidesteps the entire binary-asset-through-the-pipeline risk class the 0.1.6→0.1.7 saga
  just re-taught. Cost: JS speed, estimated ~200–500 ms per derive at 19 MiB/t=2 (estimate — note
  this plausibly fails a naïve ≤250 ms p50 gate, which is why the gate is rewritten below to a p95
  budget). Note: noble's *argon2* module's third-party-audit coverage is **unverified** (the family
  is audited; whether the argon2 addition was in scope must be checked at implementation).
- **A-wasm *(fallback, only if A-js busts the budget)*** — an argon2 wasm build consumed as a
  deploy-time module import. **Prefer a vendored first-party build from the reference C
  (CC0/Apache-2.0)** over a third-party npm wasm package (auditable + version-pinned by construction,
  adds no supply-chain actor to the most security-sensitive package). Other candidates only if that
  is impractical: `@phi-ag/argon2` (Workers-targeted), `hash-wasm` *iff* it accepts an injected
  precompiled module (its default base64+runtime-compile path is expected blocked on workerd).
  Expected ~1.5–2× of native speed → roughly 50–150 ms per derive at 19 MiB/t=2 (estimate).

**Hard gate (ADR 0029 Phase-0 precedent; rewritten per the ratification review — see A6):** before any
facade code, benchmark BOTH routes on a **deployed Worker** (not miniflare, not Node — the `b932aa1`
lesson) at m=19456/t=2/p=1, under **sustained combined load** (concurrent logins AND a `confirmTotp`
recovery-code enrollment, with the derive semaphore engaged), measuring:

- **p95 derive time** (not merely p50) plus fixed request overhead, against a **stated
  login-timeout budget** — pass/fail is "p95 + overhead < the login-timeout budget," so a route is
  not silently rejected by an arbitrary p50 number the pure-JS route was pre-destined to miss;
- **isolate peak resident memory** under that combined load (not a single empty-isolate derive), with
  concurrency expressed as a **derive-COUNT** (e.g. "4 concurrent derives"), so B1/B2 behaviour is
  actually exercised;
- bundle delta and cold start.

**Acceptance:** prefer **A-js** if it clears the p95 budget under combined load with memory headroom;
fall to **A-wasm** only if A-js busts the budget; fall to **Option C (noble-scrypt)** only if BOTH
argon2 routes fail on workerd.

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
  32 MiB × concurrency is ~1.7× Option A's isolate pressure. **This is the ratified fallback** if the
  spike falsifies both argon2id routes on workerd.

### Option D — bcrypt *(rejected without a spike)*

Not meaningfully memory-hard (~4 KiB working set — GPU-crackable at scale), truncates input at 72
bytes (silently, against a 128-max policy), and its cost knob buys strictly less than argon2id's at
the same defender budget. No advantage over A or C on any driver.

*(Out of scope, noted for completeness: OPAQUE/PAKE and client-side pre-hashing change the protocol,
not the at-rest KDF, and are not 0.x-horizon work.)*

## Proposed decision

**Adopt Option A.** argon2id becomes the KDF `@lesto/auth` mints on **positively-identified workerd**,
once the hard-gate spike passes on a deployed Worker. **Every ambiguous/unknown runtime keeps minting
PBKDF2** — the fail-safe "cannot crash" choice (an unknown host is not proven able to bear 19 MiB ×
concurrency, and a weak-PBKDF2 mint is recoverable where an OOM is not; see Mint selection). Node
keeps native scrypt as its mint default (no regression, no new dep on the Node hot path; scrypt
N=2^17's 128 MiB working set concedes nothing to 19 MiB argon2id). PBKDF2 is demoted from *the
workerd mint default* to **verify-forever legacy** (on workerd it is never minted again and is walked
up to argon2id by the rehash-on-login seam on argon2id-minting tiers) **while remaining the
fail-safe mint for ambiguous/unknown runtimes**.

The rollout is **mandatory two-stage** (verify-support release, then mint-default flip — see
Migration), and the load-bearing memory-safety mechanisms (derive semaphore, bounded recovery-code
mint, DoS-resistant decoy) are **part of the decision, not the spike** — the spike measures their
cost, it does not decide whether they exist.

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
- **Fail-closed parameter ceiling, on every runtime — parse-side.** The load-bearing *single-row*
  OOM defense is a parse-side reject of any stored `m` above the ceiling (the scrypt `N > DEFAULT_N`
  :154 pattern — a hostile or corrupt row must not command a 2 GiB derive and OOM the isolate).
  Ceiling starts equal to the mint default (`EDGE_MAX_MEMORY_KIB = 19456`); raising it is a
  deliberate, reviewed act. A *mint*-side parameter guard is deliberately NOT added: exactly as the
  `iterations` override was trimmed in `L-ecdeeeab`, mint params are non-configurable constants with
  no untrusted input to assert. **Note the ceiling defends a *single* hostile row only — it does
  nothing about aggregate concurrency, which is the realistic OOM path; that is the semaphore's job
  (below), not the ceiling's.**
- **Bounded, non-fan-out concurrency — the memory-safety core of this design (A1/A2 + IT1/IT2).**
  Because a derive now costs ~19 MiB, three call sites must be made memory-bounded, or the isolate
  OOMs on *ordinary* paths (not just under attack):
  - **A single per-isolate derive semaphore** (concurrency 2–3, bounded queue) gates **every**
    argon2id derive — password, recovery-code, and decoy alike — so total concurrent argon2id
    memory is bounded **once**, not per call-site. Each derive uses a fresh wasm `Instance`/`Memory`
    dropped afterward (the compiled module stays cached; wasm memory cannot shrink, so a resident
    instance would pin 19 MiB forever).
  - **Recovery-code minting must NOT fan out.** `hashRecoveryCodes` (`recovery-codes.ts:90-92`) is
    today `Promise.all(codes.map(hashPassword))` and `generateRecoveryCodes` defaults to **10**
    codes — on the argon2id edge path that is 10 × 19 MiB ≈ 190 MiB allocated **simultaneously** in a
    128 MB isolate: an uncatchable OOM on the *ordinary `confirmTotp` enrollment happy path*, not an
    attack. It must run its per-code derives **serialized through the shared semaphore**. Budget the
    consequence explicitly: 10 codes × a serialized A-js derive ≈ **2–5 s** for `confirmTotp`
    (`identity.ts:1198-1203`). We **accept** that enrollment-latency budget as a knob (reduce the code
    count, or give recovery codes a distinct lighter cost, if the spike shows it is too slow) — it is
    not a blocker, but it must be a conscious number, not a surprise.
  - **The failure decoy must be DoS-resistant.** `login`'s `failLogin` epilogue
    (`identity.ts:914-923`) awaits a real KDF derive (the decoy verify) on the unknown-email and
    unverifiable-hash paths, and `loginRateLimiter` is **optional / unwired by default**
    (`identity.ts:857`). On the argon2id path each junk unknown-email attempt therefore consumes a
    ~19 MiB / ~200–500 ms memory-hard slot — memory-hardness turned into an unauthenticated
    latency-DoS / CPU-billing-EDoS amplifier that saturates the small semaphore. **Required:** the
    derive semaphore is a global admission-control cap engaged **before** the decoy runs, **and**
    `loginRateLimiter` (or an equivalent global cap) is promoted from "optional" to a **documented
    precondition for a production argon2id edge deployment**. (Alternative, if the spike prefers it:
    change the decoy strategy on the memory-hard path to a fixed-latency budget so an unknown-email
    failure does not consume a full derive — accepting the stated timing-enumeration model. Either
    way the amplifier is closed at ship, not deferred.)
- **Mint selection** (`runtime.ts`): `PasswordAlgorithm` gains `"argon2id"`.
  `selectPasswordAlgorithm()` returns `"argon2id"` **only for positively-identified workerd**;
  `"scrypt"` for positively-identified Node (unchanged); and **`"pbkdf2"` for the
  ambiguous/unknown-runtime fallthrough** (unchanged from today — the fail-safe "cannot crash"
  choice, since an unknown host is not proven able to bear 19 MiB × concurrency). This preserves
  `runtime.ts:11-15`'s doctrine; routing the fallthrough to argon2id would invert it.
- **Verify dispatch** (`password.ts`): prefix check `isArgon2id` alongside `isPbkdf2`; `argon2id$…`
  routes to the new backend on **every** runtime (argon2id verifies everywhere — it can never strand
  a user behind `AUTH_KDF_UNAVAILABLE` the way `scrypt$…` does). If the backend itself cannot
  initialize (an A-wasm asset failed to load on an exotic runtime), refuse with the existing coded
  `AUTH_KDF_UNAVAILABLE` so it flows through the one established migration/`onUnverifiableHash` path —
  never an uncoded throw.
- **`needsRehash` — promotion is monotone-in-strength, and the "no thrash" invariant is stated
  precisely (A3).** The prior draft asserted an unqualified "no cross-promotion between scrypt and
  argon2id, can never thrash." That is **false against code this ADR leaves in place**:
  `pbkdf2MigrationHasher.needsRehash` (`identity.ts:206`) is
  `stored.startsWith("pbkdf2$") ? needsRehashWeb(stored) : true` — so once argon2id ships, an
  `argon2id$…` row hits the `: true` arm, is reported stale, and is **re-minted down to PBKDF2-100k**
  by that preset's `hashPasswordWeb`. In a mixed fleet where a Node tier still runs
  `pbkdf2MigrationHasher` (which operators leave wired — see the runbook's own "remove after cutover"
  warning) a row thrashes argon2id↔pbkdf2 on alternating edge/Node logins. The ratified design:
  - **Fix `pbkdf2MigrationHasher.needsRehash`'s `: true` arm** so an at-strength `argon2id$…` row is
    NOT reported stale (return `false` for the `argon2id$` prefix; scope "stale" to `scrypt$`/legacy
    only). This closes the downgrade.
  - **The facade `needsRehash` (`password.ts:98`) argon2id arm** does argon2id→argon2id *param
    convergence only* (stale iff params ≠ current defaults, walking **up and down** to the pinned
    params — the `needsRehashWeb` doc :294-300 convergence discipline), and never reports an
    `argon2id$…` row stale toward a weaker algorithm. **Invariant, stated precisely: promotion is
    monotone in strength — `pbkdf2-100k → argon2id` yes; `argon2id → argon2id` convergence; `argon2id
    → pbkdf2` and `argon2id → scrypt` NEVER** (productionHasher never cross-promotes scrypt↔argon2id
    in either direction). The pbkdf2 arm remains mint-target-aware (it reads `selectPasswordAlgorithm()`):
    a `pbkdf2$…` row is stale only when this runtime's mint target is argon2id (i.e. workerd); on a
    positively-identified Node tier (mint target scrypt) it defers to `needsRehashWeb` and is **not**
    promoted to argon2id — so "the corpus walks up to argon2id" is scoped to **argon2id-minting tiers
    (workerd)**, not universal (M4).
  - **The hasher × prefix matrix** (the "can never thrash" claim, now *demonstrated* rather than
    asserted):

    | needsRehash verdict → | `scrypt$…` | `pbkdf2$100k` | `argon2id$…` |
    |---|---|---|---|
    | **productionHasher** (mint = `selectPasswordAlgorithm`) | scrypt-cost check (Node); *refused* on edge → reset, not rehashed | stale→argon2id **iff mint target = workerd**; else stays (Node/unknown) | param-convergence only; never downgraded |
    | **pbkdf2MigrationHasher** (mint = pbkdf2) | stale → pbkdf2 (migration goal) | pbkdf2-cost check | **`false` (FIXED — no downgrade)** |
    | **argon2idMigrationHasher** (mint = argon2id) | stale → argon2id *(deliberate scrypt→argon2id DOWN in memory-hardness — see below)* | stale → argon2id | param-convergence only |

    No cell produces a two-hasher cycle that flips a row's algorithm back and forth: the only
    scrypt↔argon2id crossing is the *deliberate, one-way, opt-in* `argon2idMigrationHasher` promotion,
    and `argon2id$…` is never reported stale toward a weaker KDF by any preset.
- **`@lesto/identity`'s hasher seam needs no structural change — but its audit parser and two presets
  do.** `productionHasher` (:165) wraps the facade functions and picks the KDF up for free — passwords,
  the timing decoy (`failLogin` :914-923; the decoy is minted via `hashPassword`, so it automatically
  costs argon2id on the edge — hence the DoS-resistance requirement above), and recovery codes
  (`recovery-codes.ts` hashes with the same primitive by design — hence the non-fan-out requirement
  above). Three additions:
  1. **A fourth `argon2id` arm in `describeHashCost` (:296)** — the `password_rehashed` audit event's
     cost parser. Extend `PasswordHashCost` (`identity.ts:275-278`) with
     `{ readonly algorithm: "argon2id"; readonly m: number; readonly t: number; readonly p: number }`
     and add the parse arm matching the 7-segment wire format. Without it, every `pbkdf2$100k →
     argon2id$…` promotion emits `to: { algorithm: "unknown" }`, silently gutting the up-vs-down audit
     legibility the event exists to provide (and hiding the `argon2idMigrationHasher` scrypt→argon2id
     *down*grade entirely). This re-duplicates the wire format a third time; track the drift class with
     board `L-632f1191` (a shared exported parser is the real fix) rather than silently forking a
     third copy.
  2. **An `argon2idMigrationHasher` preset** succeeding `pbkdf2MigrationHasher` (:200) — mints
     argon2id even on Node, reports every non-argon2id row stale — for hybrid/migrating Node tiers,
     inheriting the same documented timing-enumeration caveat while the corpus is mixed. **It MUST
     carry the same "migration tool — remove after cutover" warning its `pbkdf2MigrationHasher`
     sibling has** (`docs/guide/edge-password-migration.md:111-118`), naming the specific footgun: on
     Node it silently downgrades a scrypt-**128 MiB** row to argon2id-**19 MiB** (~7× less
     memory-hardness) on a tier that runs full scrypt fine. It is **only** for a Node tier
     deliberately migrating a shared corpus toward the edge — never a default, never for a Node-only
     deployment (scrypt is strictly stronger there; see Q2).
  3. The `pbkdf2MigrationHasher.needsRehash` fix (above).

### Migration / rollout

- **This migration is strictly gentler than scrypt→PBKDF2 was.** A `pbkdf2$100k` row still
  *verifies* on the edge — nobody is locked out, there is no `AUTH_KDF_UNAVAILABLE` wave, no reset
  emails, no drain-query urgency. The rehash-on-login seam (`identity.ts:964-997` — `needsRehash`
  check :969, re-mint via `hashPassword` :974, persist :975) re-mints each user's proven plaintext as
  `argon2id$…` on their next successful login **on argon2id-minting tiers** (workerd); a `pbkdf2$100k`
  row served only by a Node tier stays 100k (M4 — Node mints scrypt, and `needsRehashWeb` reports a
  100k row at-cost), no worse than today. The dormant tail simply stays at 100k PBKDF2 until it logs
  in on the edge or resets. PBKDF2 verify support is kept indefinitely (it is ~40 lines of WebCrypto
  with no dependency; deleting it buys nothing and strands the tail).
- **Two-stage rollout is MANDATORY (Q3 / A5), not "optional belt-and-suspenders."** An **older**,
  argon2id-blind `@lesto/auth` reading an `argon2id$…` row mis-routes it: on old-edge it throws the
  coded `AUTH_KDF_UNAVAILABLE` (safe, enumeration-clean); on old-Node it reaches `verifyPasswordScrypt`,
  whose `parseStored` rejects the prefix (`prefix !== PREFIX → undefined`, `password-scrypt.ts:123`)
  and resolves **`false`** — a *silent* invalid-credentials for a correct password, indistinguishable
  from a typo. This is **not only a hybrid-fleet hazard** — it hits the "common single-artifact app"
  two ways the prior draft dismissed:
  - **Rollback.** Deploy argon2id-capable → users mint `argon2id$…` rows → roll the Worker back to
    the prior (argon2id-blind) artifact (a routine incident action) → **every user active during the
    window is locked out**. You cannot "verify-before-mint" your way out of a rollback, because the
    rollback target is argon2id-blind by construction.
  - **Gradual / non-atomic deploy.** Cloudflare rolls a new version across isolates non-atomically;
    during the window new isolates mint argon2id that not-yet-updated isolates refuse → intermittent
    `invalid_credentials` for freshly-active users.

  Therefore the rollout is two mandatory stages with a **rollback-safety invariant**: **Stage 1** —
  ship a release where every tier can VERIFY `argon2id$…` but still MINTS the prior KDF; bake it until
  the verify-capable release is the **oldest artifact any tier could roll back to**. **Stage 2** —
  only then flip `selectPasswordAlgorithm`'s workerd arm to mint argon2id. The runbook
  (`docs/guide/edge-password-migration.md`) documents the ordering; for hybrid deployments (Node admin
  CLI + edge front end on separately-pinned versions) the same rule applies per tier.
- **Corpus inventory** for operators mirrors the existing drain query: count rows by prefix +
  parameters (`split_part(password_hash, '$', 1)`), watch `argon2id$…` share rise; no action is
  *required* on the tail.

## Phase-0 spike outcome (2026-07-10 — board `L-557c95dd`; awaiting owner ratification of the flip)

Ran the hard gate: a real deployed Cloudflare Worker (`*.workers.dev`, compat 2026-06-01, colo
EWR), both routes at m=19456/t=2/p=1, timed by `wrangler tail` `cpuTime` (authoritative — workerd
freezes `Date.now()` during sync compute) plus client end-to-end. Harness + full data +
caveats: `spikes/adr-0046-edge-kdf/` (`FINDINGS.md`, `REVIEW-chief-architect.md`). Reviewed by a
fable chief-architect + an opus red-team (which corrected an over-stated first-draft A-js number).

- **CPU / derive:** A-wasm **~40–50 ms** (tight, 37–76 ms) vs A-js **~0.5–0.8 s** (uncontended
  floor ~0.5 s; typical ~0.78 s; ≤1.8 s under Free-plan CPU contention) — a **~10–16× gap**. The
  ADR's A-js estimate (200–500 ms) was 1.5–4× optimistic vs the floor; A-wasm (50–150 ms est.)
  confirmed. PBKDF2-100k incumbent baseline **~25 ms** → argon2id-wasm is only ~1.6–2× the
  incumbent (near-parity; narrows R2/M6).
- **Recovery enrollment (10 serialized):** A-wasm ~0.47 s CPU / ~0.75 s e2e; A-js **~5–8 s** —
  at/over the R4 "2–5 s" budget even at the floor.
- **DECISION (per the ratified procedure): A-js busts the budget → fall to A-wasm.** The
  rejection rests on plan-independent facts (the ~10–16× CPU gap, the ~5–8 s enrollment vs R4,
  and A-js's single-threaded event-loop blocking), NOT the Free-plan 503s (a burst-throttle
  artifact). **Option C is NOT triggered** — an argon2 route passes on workerd; and it stays
  closed (noble-scrypt is the same pure-JS memory-hard class the spike clocked ~10–16× slower).
- **IT4 CONFIRMED** on current workerd: deploy-time module-import instantiate works; runtime
  `new WebAssembly.Module(bytes)` and `WebAssembly.compile(bytes)` are **blocked**
  (`CompileError: Wasm code generation disallowed by embedder`, catchable). A-wasm must consume
  wasm as a module import — no `nodejs_compat` needed; wrangler's `CompiledWasm` rule bundles it.
- **Memory ceiling measured ~250 MiB, NOT 128 MB** (authoritative `exceededMemory` at 14×19 MiB =
  266 MiB; 12×19 = 228 MiB ok), on Free/workers.dev. The **design keeps assuming 128 MB** until a
  paid re-run confirms (A12); the semaphore at 2–3 (38–57 MiB) is safe under either figure.
- **Gate status:** the **backend-selection** half is **passed** (the eliminating measurement is
  plan-independent). The **operational-envelope** half (a clean sustained-combined-load p95 under
  the *shared per-isolate* semaphore; the production memory ceiling; cold start) is **confounded by
  the Free-plan burst throttle** and must be **re-run on Workers Paid before Stage 2 (the mint-
  default flip)** — it does **not** block Stage-1 facade/verify-support work (format, params, and
  cross-runtime byte-identity are confirmed, so no later finding can strand a minted row).
- **Supply chain (IT3):** ship a **vendored first-party wasm build** from the reference C (pinned
  commit, reproducible/containerized recipe, checked-in `.wasm` + recorded SHA-256, CI rebuild/
  verify, a **differential CI gate** byte-comparing wasm output to `@noble/hashes` over RFC 9106
  vectors + a property corpus, and a **pack-boot gate OUTSIDE the repo**). `@phi-ag/argon2@0.5.24`
  (MIT — the spike's measurement proxy) is the **sanctioned fallback only** if the toolchain proves
  impractical, recorded as a deviation with a follow-up task, never silently.

## Consequences & risks

- **Security:** edge posture returns to at-or-above OWASP; the offline-crack economics move from
  "commodity-GPU-friendly" to memory-bound. The length-only password policy (min 8) remains the
  weakest link and is untouched by any KDF — the Option-B compensations (min-length 12,
  breach-password check) are recommended as an independent follow-up battery regardless.
- **Per-derive memory is the new risk class this ADR introduces — and the "~6× headroom" framing is
  corrected.** 128/19 ≈ 6.7 is the **single-derive, empty-isolate** figure. At a few concurrent
  derives (working set + the module's resident footprint + app heap + wasm `Memory`s that are dropped
  but not yet GC'd — GC timing on workerd is not deterministic) real headroom is ~1.2–1.5×.
  **Concurrent headroom is the spike's key unknown and the reason the derive semaphore is mandatory,
  not optional.** The mitigations are the semaphore + non-fan-out recovery-code mint + DoS-resistant
  decoy specified in Integration design; the spike measures their peak resident under sustained
  combined load.
- **Unauthenticated login-endpoint DoS/EDoS (closed at ship, not deferred).** Without the admission
  cap + required `loginRateLimiter`, the memory-hard decoy is a weapon against the defender (see
  Integration design). The decision requires those controls as a precondition for the argon2id edge
  path; the residual (a rate-limited attacker still spends *some* bounded derive budget) is accepted.
- **CPU/latency:** logins on the edge get slower (est. 50–150 ms wasm / 200–500 ms JS vs ~30–60 ms
  PBKDF2-100k native) and CPU-billing heavier; recovery-code enrollment is multi-second on A-js (see
  A1's budget). This is the *point* of a KDF; it stays comfortably inside the paid plan's default CPU
  limit, and the free plan was already excluded by any real KDF.
- **Surface:** a third permanent backend (format, parser, guards, tests, docs) and either a `.wasm`
  asset threaded through the publish pipeline (A-wasm) or one pinned pure-JS dependency in
  `@lesto/auth` (A-js, the ratified default) — each a standing maintenance and supply-chain commitment
  in the most security-sensitive package.
- **Timing enumeration during the mixed-corpus window — larger and longer-lived than the prior draft
  admitted (M6).** An argon2id decoy (~200–500 ms JS) does not cost the same as an unconverted
  `pbkdf2$100k` verify (~50 ms) — a ~10× wall-time delta, larger than the scrypt→PBKDF2 delta the
  existing caveat documents. And because a Node-served pbkdf2 row never converts (M4), the window is
  not "short" — it persists for the dormant + Node-served tail. Same mitigations (rate limiter wired,
  latency-by-outcome monitored), applied with eyes open to the magnitude.
- **If the spike fails** (workerd wasm blocked in a way module-imports don't solve AND pure-JS blows
  the CPU budget): fall back to Option C's noble-scrypt route at N=2^15/r=8/p=3, and only if *that*
  fails, Option B's compensations. The facade design is identical for either memory-hard backend.

## Non-goals

- Changing the Node mint default (scrypt N=2^17 stays; converging Node on argon2id was ruled **no** —
  see Q2).
- Password-policy hardening (breach checks, min-length) — recommended follow-up, separate track.
- Peppers, OPAQUE/PAKE, client-side pre-hashing — orthogonal protocol/at-rest changes, out of scope.
- Any change to session, token, or TOTP crypto — this ADR touches only the password/recovery-code
  KDF.

## Ratified answers to the open questions

1. **Backend route + supply chain → A-js (`@noble/hashes` pure-JS argon2id) is the ratified default
   preference, spike-gated on the rewritten gate above; A-wasm (a vendored first-party build
   preferred over any third-party npm wasm) is the fallback if A-js busts the login-timeout budget;
   Option C noble-scrypt only if both argon2 routes fail on workerd.** Rationale: A-js rides the
   existing publish pipeline untouched and adds no binary-asset class (the 0.1.6→0.1.7 saga's exact
   cost), keeping `@lesto/auth` a pure-TS package with one auditable dep and identical bytes on every
   runtime. License/audit verification (incl. noble-argon2's audit scope) is an implementation-time
   gate: no dep lands without a pinned version, a verified permissive license, and a recorded
   audit-coverage note.
2. **Should Node converge on argon2id? → NO. Keep scrypt N=2^17 on Node.** Node's ~128 MiB scrypt is
   *stronger* memory-hardness than 19 MiB argon2id; converging would trade it down for zero
   defender-relevant gain, put a wasm/JS dep on the dependency-free native hot path, and drag Node
   into the per-derive-memory concurrency class this ADR fights to contain on the edge. The
   "one-algorithm-everywhere collapses the migration class" argument does not bite: verify-support for
   all three prefixes ships on every runtime regardless, so a future hybrid app already reads one
   corpus — only the *mint* target stays split, a one-line `selectPasswordAlgorithm` Node-arm flip if
   a future ADR ever wants it. (The `argon2idMigrationHasher` M7 guardrail exists precisely so this
   ruling cannot be silently undone by a downgrade-on-Node preset.)
3. **Rollout staging → TWO-STAGE IS MANDATORY** (verify-support release fully deployed, *then* the
   mint-default flip), with the rollback-safety invariant in Migration. Rationale: an argon2id-blind
   old artifact locks out any user who minted an argon2id row (old-edge `AUTH_KDF_UNAVAILABLE`;
   old-Node silent `false`), and this hits **single-artifact apps** via rollback and gradual deploy,
   not just hybrids — and verify-before-mint cannot rescue a rollback. One extra release is cheap
   against a lockout wave.

## Implementation-time requirements (the ADR instructs; these do not block the paper decision)

- **IT1** — Replace `recovery-codes.ts:90-92`'s `Promise.all(...map(hashPassword))` with a
  bounded/serialized map through the shared derive semaphore.
- **IT2** — Build one per-isolate derive semaphore (concurrency 2–3, bounded queue) shared across
  password + recovery-code + decoy argon2id derives; a fresh wasm `Instance`/`Memory` per derive,
  dropped after (module stays cached).
- **IT3** — Before any dep lands in `@lesto/auth`: pinned version + verified permissive license +
  recorded audit-coverage note (noble-argon2 module scope, or vendored-build provenance).
- **IT4** — Re-verify the workerd runtime-wasm-codegen restriction against current workerd at the
  spike (the ADR's own first checkpoint).
- **IT5** — Extend `docs/guide/edge-password-migration.md` with the mandatory two-stage ordering and
  the `argon2idMigrationHasher` remove-after-cutover / scrypt→argon2id-downgrade warning.
- **IT6** — Keep the parse-side `EDGE_MAX_MEMORY_KIB = 19456` ceiling (the single-row OOM guard,
  mirroring scrypt's `N > DEFAULT_N`) and the deliberate omission of a mint-side param guard (per
  `L-ecdeeeab`).

## Residual risks knowingly accepted at ratification

- **R1 — Spike-gated backend.** All deployed-Worker perf/memory numbers are estimates until the
  spike; ratification of the *backend* is conditional on the rewritten spike passing, with the
  noble-scrypt fallback if workerd falsifies both argon2 routes. The decision to *move off 100k
  PBKDF2 to a memory-hard edge KDF* is unconditional.
- **R2 — Mixed-corpus timing residual.** The argon2id decoy cost ≠ an unconverted-pbkdf2 verify cost;
  same enumeration-timing class as the scrypt→pbkdf2 window, larger in magnitude (~10×) and
  longer-lived (M4/M6), bounded by rate limiter + monitoring, accepted as documented.
- **R3 — Length-only password policy (min 8).** Untouched by any KDF; the weakest link remains. The
  Option-B compensations are a separate follow-up track, not gated on this ADR.
- **R4 — Recovery-code enrollment latency.** Serialized 10-derive `confirmTotp` on A-js may be
  multiple seconds; accepted provided A1 budgets it. A knob (code count / cost), not a blocker.
- **R5 — Non-PHC house wire format.** `argon2id$<v>$<m>$<t>$<p>$salt$key` needs an external converter
  for PHC-tool interop; accepted (parity with the existing two backends' `split("$")` discipline).

## Amendment trail (ratification, 2026-07-10)

Ratified **RATIFY WITH REQUIRED AMENDMENTS** by the delegated review the owner directed: a fable
red-team (verdict BLOCK-as-written, three code-confirmed blockers + majors) and an opus
chief-architect (verdict RATIFY-WITH-AMENDMENTS, resolving the three open questions). All three
blockers and the drifted citations were re-verified against the tree before folding in. Amendments
absorbed into the text above: **A1** bounded/serialized recovery-code mint + enrollment-latency budget
(B1 — the `Promise.all` fan-out OOM); **A2** DoS-resistant decoy + required `loginRateLimiter` (B2);
**A3** `pbkdf2MigrationHasher.needsRehash` `: true`→`false`-for-argon2id fix + the hasher×prefix matrix
+ the monotone-in-strength invariant (B3 — the falsified "no thrash" claim); **A4** argon2id mints on
positively-identified workerd only, unknown-runtime stays PBKDF2, removed "19 MiB cannot OOM anything"
(M1 fail-safe inversion + internal contradiction); **A5** mandatory two-stage rollout + rollback-safety
invariant (M2, folds Q3); **A6** rewritten spike gate — p95/login-timeout budget, derive-count
concurrency, sustained combined load (M5, folds Q1); **A7** `argon2idMigrationHasher` remove-after-
cutover + downgrade warning (M7, guards Q2); **A8** concrete `describeHashCost` argon2id arm;
**A9** three drifted anchors re-anchored (`identity.ts:887-889`→`:964-997`; `password-web.ts:333`→
`:294-300`/`:302`; grounding `~:961`→`:969`); **A10** corrected the "~6× headroom under concurrency"
over-claim.

## Amendment trail (Phase-0 spike + delegated review, 2026-07-10 — board `L-557c95dd`)

Folded in from the deployed-Worker spike and its fable-chief-architect + opus-red-team review
(the review corrected an over-stated first-draft A-js figure; see `spikes/adr-0046-edge-kdf/`).
These invert the Q1 *default* and touch load-bearing claims — **awaiting owner ratification**.

- **A11 — gate outcome recorded:** backend = **A-wasm**, inverting the Q1 A-js default; perf
  figures move from "Claims not verified" to measured-with-caveat (Free plan; envelope re-run
  pending). See **Phase-0 spike outcome**.
- **A12 — memory ceiling:** measured ~250–260 MiB on Free/workers.dev (documented limit 128 MB);
  **keep designing to 128 MB** until a paid re-run; the semaphore at 2–3 (38–57 MiB) is safe under
  either figure. Do **not** bank 256.
- **A13 — B1/IT1 rationale restated:** the "190 MiB simultaneous" fan-out holds only for an
  async/buffer-across-yield derive (noble `argon2idAsync`), **not** the chosen sync backend (peak
  1×19 MiB, code-grounded + measured). **IT1 stays mandatory** — justification becomes CPU-fairness
  / bounded-queue backpressure + future-proofing any swap to an async derive that would re-arm the OOM.
- **A14 — B2/A2 mechanism restated:** with a sync ~45 ms derive the decoy vector is event-loop
  blocking + CPU/billing EDoS, not memory exhaustion; the controls (admission cap before the decoy;
  `loginRateLimiter` as a documented production precondition) are unchanged; the shared semaphore's
  real job is **bounded-queue load-shedding**.
- **A15 — R2/M6 shrinks (good direction):** the "~10×" mixed-corpus timing delta was on A-js
  estimates; measured argon2id-wasm ~45 ms vs PBKDF2-100k ~25 ms is near-parity → materially smaller
  enumeration residual.
- **A16 — NEW cross-runtime consequence of A-wasm:** A-js's "identical bytes, runs everywhere for
  free" property is **lost**. Node/Bun tiers verifying `argon2id$…` must load the wasm backend too
  (bytes-compile, legal off-workerd). The disqualifier is **enrollment fan-out + one-implementation
  consistency**, not single-verify latency: noble on **Node** measured ~0.27–0.43 s/verify (not the
  ~0.5–0.8 s *edge* figure), so a single verify is tolerable but a 10-code enrollment ≈ 3–4 s and a
  second JS implementation to maintain is not. noble stays the **degrade-to-secure-and-alive**
  fallback preserving "never strands a user." State this in Integration design when the facade lands.
- **A17 — housekeeping:** R4 closed with the measured ~0.47 s wasm enrollment (the code-count/cost
  knob is moot); **IT4 marked confirmed** (measured `CompileError` behavior); IT3 ruling recorded
  (vendored first-party wasm; `@phi-ag/argon2` sanctioned fallback only).
- **Gate-scope ruling:** the paid re-run is a blocker for **Stage 2 (mint flip) only**; Stage-1
  facade/verify-support work proceeds now (`L-93f03791`).

## Claims not verified against the codebase or a live system (do not ratify these as facts)

> **Phase-0 spike update (2026-07-10):** the first two bullets below are now **MEASURED** on a
> deployed Worker — the wasm code-gen restriction is **confirmed** (blocked, catchable
> `CompileError`), and the perf/bundle figures are **replaced** by measurements (A-wasm ~40–50 ms,
> A-js ~0.5–0.8 s, PBKDF2-100k ~25 ms; wasm asset 28 KiB raw / 11 KiB gzip). Caveat: all on the
> Free plan — the operational envelope (clean sustained p95, production memory ceiling, cold start)
> awaits a Workers-Paid re-run. The remaining bullets stay unverified.

- The workerd **wasm code-generation restriction** (module imports required; runtime
  `WebAssembly.compile` from bytes blocked) — ~~high confidence from platform knowledge, unverified
  here~~ **CONFIRMED at the spike** (`spikes/adr-0046-edge-kdf/FINDINGS.md` §IT4).
- All **performance estimates** (wasm ≈ 50–150 ms, pure-JS ≈ 200–500 ms per 19 MiB/t=2 derive on
  workerd; PBKDF2-100k ≈ 30–60 ms) and **bundle-size** figures (wasm "tens of KiB") — ~~estimates,
  to be replaced by deployed-Worker measurements~~ **MEASURED (Free plan): wasm ~40–50 ms, pure-JS
  ~0.5–0.8 s, PBKDF2-100k ~25 ms; wasm asset 28 KiB raw / 11 KiB gzip. Paid re-run pending for the
  sustained-load envelope.**
- **Licenses and audit status** of `@noble/hashes`' argon2 module specifically, `@phi-ag/argon2`,
  `hash-wasm`, `argon2-browser`.
- workerd `nodejs_compat` **`node:crypto` scrypt availability and memory limits** (Option C's native
  route).
- The **GPU crack-rate arithmetic** (4090 ≈ 21.7 GH/s SHA-256; ≈ 108k vs 18k guesses/s; 30 vs 180
  GPU-days for ~41 bits) is carried over from the `b932aa1` review as order-of-magnitude framing,
  not re-benchmarked.
- The **argon2 memory-hardness framing** — "≈ a thousand concurrent instances on a 24 GB GPU"
  (§Context) and "`p=1` because wasm on workerd has no threads" (§Parameters) — is order-of-magnitude
  platform reasoning, to be confirmed at the spike, not measured here.
- Workers **paid-plan default CPU limit (~30 s, configurable)** and **bundle-size caps** — believed
  current, verify against Cloudflare limits docs at implementation.
