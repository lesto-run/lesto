# Hoisted-Linux `lesto dev` first-request hang — root-cause investigation (L-513dd8a6)

Follow-up to the L-27285131 triage. This note is the evidence-based investigation that pairs with
the new **mutable-tree hoisted dev-boot preflight** (`packages/e2e/scaffold-hoisted-preflight.spec.ts`
+ `.github/workflows/scaffold-hoisted-preflight.yml`). The preflight is what will red/green a fix on
Linux CI; this note is the hypothesis it is meant to confirm/refute.

## The confirmed symptom (not in dispute)

On GitHub `ubuntu-latest`, a scaffolded Lesto app installed under bun's **HOISTED** linker (the
standalone-scaffold default) boots `lesto dev`, **binds and announces `127.0.0.1:<port>` (the Vite
listen callback fires; the child stays ALIVE — the `exit`/`error` listeners never trip), but never
answers the first `GET /`.** A 300s-budget dispatch (run 28714591201) confirmed it is a **true hang**,
not a slow cold start.

It is **narrow**, which rules out several tempting explanations:

- **Not a bind bug / not node:http-on-Linux / not a 127.0.0.1-vs-::1 poll mismatch.** The SAME dev
  code under the **ISOLATED** linker on the SAME Linux runner (scaffold-real-install leg b) answers
  fine. (This also retires the 0.1.1 skip's "127.0.0.1 bind/poll" wording — reconcile L-2d87f1b5.)
- **Not a universal dev bug.** Hoisted boots instantly on macOS (~24ms first GET).

So the failure is specific to **CURRENT-tree-equivalent code × HOISTED (flat) node_modules × Linux**.

## Where the first `GET /` actually blocks (traced in-repo)

The first `GET /` is **not** a passive static-file serve. The dev dispatch runs the app's HTML
response through Vite:

- `packages/cli/src/run.ts` → `withIslandDevHtml` (~L1821): every HTML dev response is
  `await islandDev.transformHtml(path, html)` **in the critical path of `GET /`**.
- `packages/island-dev/src/vite.ts` → `transformHtml` = `server.transformIndexHtml`. This is the
  **first** time Vite processes anything after `listen()`, and for the preact scaffold it triggers the
  `@prefresh/vite` Fast-Refresh preamble injection and Vite's first-request dep machinery.

The scaffold's dialect is **preact** (`packages/create-lesto/src/templates.ts`: `ui.dialect:
"preact"`), so `loadFastRefreshPlugin` (`vite.ts`) loads **`@prefresh/vite`**, which — per the
load-bearing comment already in `vite.ts` — **"drags in a `rolldown` NATIVE binding whose
initialization DEADLOCKS the Bun dev process if it is loaded."** That comment is the single strongest
in-repo prior: the repo already knows rolldown-native + Bun is a deadlock hazard, which is why the
plugin import is kept lazy/opt-in.

Note the plugin is imported at **boot** (inside `createViteBackend`, before `listen()`), and the
server DOES bind — so merely importing `@prefresh/vite` is not the whole story. The hang is at
**first-request** time, when Vite's dep optimizer / the preamble path first does real work.

## Leading hypothesis

**On the first `GET /`, `transformIndexHtml` enters Vite's first-request dep-optimize/crawl path;
under a flat (hoisted) node_modules on a constrained Linux runner that path stalls — most likely on
the `@prefresh/vite` rolldown-native code path — and because the response is held on that work, the
`GET /` never returns.**

Two mutually-compatible mechanics could be in play:

1. **`optimizeDeps.holdUntilCrawlEnd` (Vite default `true`).** Vite holds early requests until the
   static-import crawl + optimize completes (to avoid full-page reloads from late-discovered deps). If
   the crawl/optimize never completes, the held request never resolves → exactly "bound, alive, first
   GET hangs."
2. **rolldown-native init under the hoisted layout.** Under isolated, each package gets its own
   symlinked copy and rolldown's native `.node` may resolve/initialize down a path that sidesteps the
   documented Bun deadlock; under a single flattened hoisted copy the deadlock-prone path is taken.
   OS-specificity (macOS fine, Linux hangs) fits a native-binding/threading init bug.

### Evidence FOR
- The `vite.ts` comment documents a real rolldown-native **deadlock** in the Bun dev process — direct
  in-repo evidence, not speculation about the general mechanism.
- Symptom shape (bound + listen fired + child alive + first GET never returns) matches a request held
  on a stuck first-request optimize far better than a crash or a bind failure.
- Layout-and-OS specificity (isolated-Linux OK, hoisted-macOS OK, only hoisted-Linux hangs) fits a
  native-binary-resolution/threading difference between the two linker layouts on Linux.

### Evidence AGAINST / open uncertainty
- `@prefresh/vite` is imported at boot and the server binds fine, so the deadlock (if rolldown) must
  be at a **later** rolldown entrypoint reached only during first-request transform/optimize — inferred,
  not observed.
- Cannot reproduce on macOS, so the stall's exact location is **unconfirmed**. Plausible alternatives
  not yet excluded: esbuild's dep **scanner** (not rolldown) stalling under the flat layout; a Bun +
  undici proxy-fetch interaction on the internal Vite loopback hop; or the HMR-WS handshake. The
  `holdUntilCrawlEnd`-hold shape argues for the optimize path, but nothing has been instrumented on a
  real Linux runner yet.

## What a Linux repro needs to CONFIRM the mechanism

The new preflight gives a **fixable** hoisted-Linux target (published dev == the tree). To bisect on it:

1. Spawn `lesto dev` with `DEBUG=vite:deps,vite:optimize-deps,vite:resolve` and capture the child's
   stdout/stderr (the harness already drains + surfaces it) — see whether the optimize **crawl starts**
   and exactly where it stalls.
2. Toggle **`optimizeDeps.holdUntilCrawlEnd: false`** in the narrow config and re-run: if the first
   `GET /` now answers, the hang was the *hold*, and the real optimize can be fixed/backgrounded
   separately.
3. Toggle **`optimizeDeps.noDiscovery: true`** with a complete `include` list: if it answers, the
   crawl/scan was the trigger.
4. Inspect the rolldown native binary resolution under each layout on the runner:
   `find node_modules -path '*rolldown*' -name '*.node'` and `ls -la node_modules/@prefresh` under
   hoisted vs isolated — a divergent native path implicates mechanic (2).
5. If (2)/(3) don't answer but (4) diverges, the deadlock is in rolldown-native itself → the fix is
   about the binary, not Vite's request-hold.

## Proposed fix (candidate — NOT yet shipped; strict-gate deferred)

**No product change was made in this task.** The mechanism is unproven and cannot be reproduced on
macOS, so a speculative edit to `@lesto/island-dev` would be worse than none (it could mask the real
bug or regress the working macOS/isolated paths). The candidates, in order of confidence, for the
Linux-CI fixer to try against the preflight:

- **A (lowest-risk, first to try): `optimizeDeps.holdUntilCrawlEnd: false`** in
  `packages/island-dev/src/config.ts`'s `ViteIslandConfig.optimizeDeps`. The config already `include`s
  the full dialect runtime, so early requests can be served from the pre-bundled set without holding on
  the full crawl. **Caveat:** only fixes the *hold*; if the optimize *run* itself deadlocks this defers
  it and may add a reload. Must be verified green on the preflight, not assumed.
- **B: `optimizeDeps.noDiscovery: true` + a complete `include`.** Disables the scanner/discovery path
  entirely. **Caveat:** a real app importing a dep not in `include` would 504/reload — acceptable for
  the minimal scaffold, riskier for general dev; verify before shipping.
- **C (if (4) is the smoking gun): address rolldown-native directly** — pin/patch the `@prefresh/vite`
  version, or warm/preload the rolldown binary single-threaded at boot before `listen()` so a lazy-init
  race can't deadlock the first request. Most invasive; only with a confirmed native-binding repro.

Whichever lands, the acceptance is: **the preflight (`test:scaffold-hoisted-preflight`) goes GREEN on
`ubuntu-latest`**, then bump to 0.1.3 and un-skip scaffold-real-install leg (a)'s dev boot
(`DEV_BOOT_SKIPPED` auto-lifts off the version pin).

## Status / what is deferred

- **Shipped here (acceptance #1):** the mutable-tree hoisted dev-boot preflight + its workflow +
  helpers + package.json script. This is the missing pre-publish gate; it reds fast (bounded 120s) on
  the hang against a fixable tree.
- **Acceptance #2 (root-cause):** documented above — leading hypothesis + evidence + a concrete Linux
  bisect plan. Not confirmed (no macOS repro).
- **Acceptance #3 (product fix):** intentionally **not applied** (strict gate — unproven mechanism).
  Candidate fixes A/B/C are queued for the Linux-CI fixer.
- **Acceptance #4 (bump 0.1.3 + un-skip leg a):** release-gated and out of scope for this run (also
  collides with a live edit of `scaffold-real-install.spec.ts`). Deferred; gated behind a green
  preflight per #3.
