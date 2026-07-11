# ADR 0046 Phase-0 spike — chief-architect verdict (fable, delegated review)

> **Superseded figures note:** this review was written on the PRE-correction draft.
> Its `1.2–1.8 s` / `25×` / `~12 s enrollment` numbers are superseded by
> `FINDINGS.md` §Measurement rounds and `REVIEW-red-team.md` P1 (corrected to
> **~0.5–0.8 s / ~10–16× / ~5–8 s**). The **rulings are unaffected** — the decision
> holds on every corrected number.

Delegated per the owner's instruction ("consult with a fable chief architect when
needed") and the repo's decision-gated-delegate rule. Read `FINDINGS.md` first.
Advisory input to the human owner; the owner ratifies.

## Rulings (verbatim summary)

1. **Backend = A-wasm. A-js REJECTED on the gate. Option C not triggered.** (high
   confidence). Three independent kills, each sufficient: (a) A-js busts the ADR's
   *own* ratified R4 budget — measured ~12 s enrollment vs the written 2–5 s; (b)
   the per-derive 1.2–1.8 s CPU is plan-independent and cannot improve under load
   or on paid (the Free throttle affects admission, not per-request speed) — so
   failing at zero load ⇒ fails the harder gate; (c) sync noble blocks the isolate
   event loop per derive (disqualifying for co-located requests), async noble
   realizes the B1 buffer-stack for the same total CPU. The 25× gap is externally
   credible; the 200–500 ms estimate was the outlier — exactly the estimate-vs-
   deployed error class the Phase-0 gate exists to catch.

2. **Gate status: selection half PASSED on Free data; operational-envelope half
   NOT.** The Workers-Paid re-run is a **blocker for Stage 2 (mint-default flip)
   only**, NOT for the epic. Facade work + the Stage-1 verify-support release
   proceed now (format, params, cross-runtime byte-identity are confirmed, so no
   later finding can strand a minted row). The paid re-run must confirm: a *stated
   numeric* budget + A-wasm p95 (end-to-end and cpuTime) under sustained combined
   load with a **shared per-isolate** semaphore and ZERO throttle 503s; the
   production memory ceiling (128 vs ~256 MiB); no `exceededMemory` under soak
   (GC of dropped 19 MiB wasm Memories); cold start with the wasm module; the
   `/pbkdf2`-100k baseline on the same deploy; that the burst-503s were Free-only.

3. **IT3 supply chain: vendor a first-party wasm build from the reference C**
   (phc-winner-argon2, pinned commit, reproducible/containerized recipe, checked-in
   `.wasm` + recorded SHA-256, CI rebuild/verify, CC0/Apache-2.0 provenance).
   `@phi-ag/argon2@0.5.24` (the spike's measurement proxy) is the **sanctioned
   fallback only if the toolchain proves impractical within the epic — recorded as
   a deviation with a follow-up task, never silently**. Mandatory bar before it
   lands in `@lesto/auth`: a **differential CI gate** (wasm output byte-identical
   to `@noble/hashes` argon2id across RFC 9106 vectors + a property corpus; keep
   noble as the test oracle), minimal first-party glue that zeroes the password in
   linear memory before dropping the Instance, dual load paths (module-import on
   workerd / bytes-compile on Node+tests) both surfacing `AUTH_KDF_UNAVAILABLE` on
   failure, and a **pack-boot gate OUTSIDE the repo** (install the tarball in a
   clean dir; boot a wrangler build AND a Node consumer that resolve+instantiate
   the `.wasm` subpath) — the specific test that catches the 0.1.6-class breakage.

4. **Option C does NOT reopen.** noble-scrypt at N=2^15/r=8/p=3 is the same pure-JS
   memory-hard class the spike just clocked ~25× slower than wasm → it lands in the
   same second-plus, event-loop-blocking band that killed A-js; making it fast means
   scrypt-wasm = same pipeline cost for a strictly weaker OWASP choice. Trading a
   weaker KDF forever to dodge a one-time build task is the wrong trade. Params also
   stand (raise **t** not **m** later, only if paid shows CPU headroom).

## Required ADR amendments (continue the trail): A11–A17

- **A11** record the gate outcome: backend = A-wasm, inverting the Q1 default;
  move perf figures from "Claims not verified" to measured-with-caveat.
- **A12** memory ceiling: annotate every "128 MB isolate" — measured ~250–260 MiB
  on Free/workers.dev, documented 128 MB; **keep designing to 128** until the paid
  re-run; semaphore 2–3 (38–57 MiB) safe under either. Do not bank 256.
- **A13** restate B1/IT1: the 190 MiB simultaneous-alloc claim holds only for an
  async/buffer-across-yield derive, NOT the chosen sync backend (peak 1×19 MiB).
  **IT1 stays mandatory** — justification becomes CPU-fairness/bounded-queue +
  future-proofing a swap to an async derive that would re-arm the OOM.
- **A14** restate B2/A2: with a sync ~50 ms derive the decoy vector is event-loop
  blocking + CPU/billing EDoS, not memory exhaustion; controls unchanged; the
  shared semaphore's real job is bounded-queue load-shedding (backpressure).
- **A15** shrink R2/M6: the "~10×" mixed-corpus timing delta was on A-js estimates;
  at wasm ~50 ms vs PBKDF2-100k native ~30–60 ms the decoy is near-parity —
  materially narrower enumeration residual (confirm with the paid `/pbkdf2` number).
- **A16 (NEW, important):** A-wasm LOSES A-js's "identical bytes, runs everywhere
  for free" property. Node/Bun tiers verifying `argon2id$…` must load the wasm
  backend too (bytes-compile, legal off-workerd) — noble-JS at ~1 s/verify is not
  an acceptable Node verify path; noble is the last-resort degrade-to-secure-and-
  alive fallback preserving "never strands a user". State in Integration design.
- **A17** close R4 with the measured ~0.5 s wasm enrollment; mark IT4 confirmed
  (measured `CompileError` behavior); record the IT3 ruling.

## What the spike did NOT measure (owner needs before Stage 2)
Stated numeric login budget; cold start with the wasm module; the `/pbkdf2`-100k
baseline number (endpoint exists, number absent from FINDINGS); a **shared
per-isolate** semaphore under cross-request load (the harness one is per-request);
Node-side verify cost for `argon2id$…`; sustained-duration GC soak; decoy-under-
flood as wired; a docs/ops floor for `limits.cpu_ms`.

## Harness notes the architect flagged
- The spike's `Semaphore` is constructed **per request** inside `runDerives`, so
  IT2's *shared per-isolate* shape was never literally exercised (mostly moot for a
  sync backend, since the event loop serializes derives within a request — but the
  paid re-run must wire the ship-shaped shared semaphore).
- `/pbkdf2` baseline endpoint exists but its number never reached FINDINGS.
