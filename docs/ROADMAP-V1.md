# Lesto — The v1 Roadmap

> **Lesto v1 ships when the pitch is true by default: secure on every deployed path, one substrate that genuinely runs on Postgres, a ~10 KB island bundle, batteries that actually send email and emit traces, and a scaffold that boots — everything else waits.**

This document rules. The eight `docs/plans/<slug>.md` plans are its execution detail; the ADRs
(`docs/adr/0001–0013`) remain the design rationale of record; `docs/ARCHITECTURE.md` is the
product vision and must be truth-corrected as part of launch (see Wave 5). Where a review and
this roadmap disagree, this roadmap wins — every disagreement is resolved explicitly in §6.

Synthesized 2026-06-11 from the eight domain reviews in `docs/reviews/` (code-grounded,
file:line evidence), the ADR line through 0013 (durable stores — implemented, verified), and
`docs/ATTACK-PLAN-2026.md`.

---

## 1. What Lesto v1 IS — and explicitly IS NOT

### v1 IS

| In scope | One-line justification |
|---|---|
| The `lesto()` + `.page` + `defineIsland` app model (Node primary, Cloudflare Workers flagship edge) | The ADR 0004–0012 line; built, tested, and dogfooded by blog + estate. |
| **SQLite dev → Postgres prod, same APIs** — for db, migrate, queue, cache, sessions, rate limit | This is the core pitch (ARCHITECTURE.md §1). Shipping v1 without PG parity falsifies the README; the fix is scoped (the `@lesto/ratelimit` Dialect pattern already proves it). |
| Auth battery: `@lesto/identity` + durable SQL sessions/rate-limit stores (ADR 0013, done), hardened password format | Built and 100%-covered; v1 work is posture (defaults, format versioning), not construction. |
| Islands UI pipeline with **Preact-by-default scaffold** (~10 KB gzip) via `ui.dialect` | The headline perf claim (ADR 0007/0011); currently unreachable through the CLI — Wave 2 makes it true. |
| Transactional email: `@lesto/mail` with **one real SMTP transport + one fetch-based provider transport** | Identity verify/reset emails dead-end at an interface today; "batteries-included" requires at least one battery that sends. |
| `create-lesto` → `lesto dev` → `lesto build` → deploy loop, e2e-tested in CI | The first five minutes of every user; currently broken three ways. |
| OTLP tracing **wired** (env-driven, flush lifecycle on both tiers) | The tracer exists and is tested; v1 work is wiring, not code. |
| **`lesto mcp`** — the agent control plane, stdio, read-only by default, audit-sinked | Bet IV of the attack plan; the moat. ~2 days of wiring per the review; it ships. |
| `lesto openapi` (route-skeleton 3.1 export) | An afternoon over an existing generator; makes the API surface reachable. |
| Content engine **as the MCP/CLI seam**: `content-store`, `content:build`, `@lesto/mcp` content tools | `@lesto/mcp` and the CLI depend on it; the natively-built seam is 100%-covered and works. |
| feeds / seo / i18n (with `Intl.PluralRules` fix) | Small, pure, built; launch-shaped after P1 correctness fixes. |
| Webhooks (outbound, hardened SSRF guard, signed timestamps) | Built; needs the Wave 0 security fixes only. |

### v1 is NOT

| Out of scope (deliberate) | One-line call |
|---|---|
| **Docks CMS as a polished public battery** | The 13 folded-in `content-*` packages ship tagged **experimental/preview**, coverage-gate-exempt; only the store/MCP seam is supported surface. Consolidation to ~7 packages is post-1.0. |
| **Workflows "crash-safe resume"** | What exists is resumable step memoization — rename the claim pre-launch (cheap, honest); the run journal + queue-backed resume driver is post-1.0. |
| **Cross-process pub/sub (LISTEN/NOTIFY)** | Rescope `@lesto/pubsub` as in-process events in the docs pre-launch; build the PG transport post-1.0. |
| **`@lesto/orm`** | Zero consumers, sync seam incompatible with ADR 0006 — **deleted** in Wave 1. |
| **`@lesto/rbac` as a separate package** | One authorization story: fold wildcard/inheritance into `@lesto/authz`'s `definePolicy` or mark rbac legacy (Wave 5). |
| **`@lesto/hooks` + `@lesto/config` orphans** | Zero importers. Cut from the v1 public surface and excise the ARCHITECTURE.md "hooks/plugins/themes built in" claim; the plugin system is a designed post-1.0 bet, not a dangling export. |
| **Multi-instance cron scheduler** | v1 documents single-scheduler-instance as a hard deployment constraint; persisted atomically-claimed firings are post-1.0. |
| **The full assets substrate (Bet II)** — `<Image>`, build-time variants, CDN rewriting, auto-upload | Post-1.0. v1 ships the minimum credible piece: an S3/R2 storage backend (Wave 3) so the storage battery exists off one disk. |
| **Bet I (`@lesto/platform` view transitions/speculation rules) and Bet III (Vite/Rolldown consolidation)** | Strategic, not launch-gating. Post-1.0. |
| **Studio visual UI, Lesto Cloud, OAuth providers, Redis drivers, RSC** | Post-1.0, per ARCHITECTURE.md's own phasing. |
| **CSP-by-default / nonce plumbing** | The seam design exists (serializer is CSP-ready); enforcement waits until a served path needs it. Post-1.0. |

---

## 2. Consolidated launch blockers (deduplicated, ranked)

Every P0 across the eight reviews, merged where domains corroborated the same bug.
**12 blockers.** All must be closed, with regression tests, before launch.

| # | Blocker | Domain(s) | The fix (one line) | Wave |
|---|---|---|---|---|
| 1 | Estate edge has decorative auth: committed fallback secret `"estate-demo-edge-secret"`, passwordless `?as=` sign-in, no originCheck/rate limit (`examples/estate/src/edge.ts:201,238`) | auth-security + edge-deploy | Fail boot without `SESSION_SECRET`; gate demo sign-in behind an explicit flag; mount `secureStack` on the edge app | 0 |
| 2 | Shared mutable `NOT_FOUND`/`BAD_REQUEST` singletons leak headers/cookies across requests and users (`packages/web/src/lesto.ts:90`) | core-runtime | Per-request `notFound()`/`badRequest()` factories + `Object.freeze` tripwire | 0 |
| 3 | Webhook SSRF guard bypassed by a 302 redirect to metadata endpoints (`packages/webhooks/src/webhooks.ts:296`) | operability-dx | `redirect: "manual"`, 3xx = delivery failure; sign `timestamp.body` for replay defense in the same pass | 0 |
| 4 | `trustProxy: true` trusts the client-forgeable left-most XFF entry → rate-limit-key spoofing (`packages/runtime/src/trust-proxy.ts:98`) | core-runtime + auth-security | `true` = one trusted hop (right-most); predicate peels right-to-left | 0 |
| 5 | `sanitizeHtml()` silently returns unsanitized HTML on Workers; `jsdom` is a devDependency so npm consumers crash (`packages/content-shared/src/sanitize.ts:16`) | content-cms | `jsdom` → dependencies (or injected); throw a coded error when no DOM exists | 0 |
| 6 | No Postgres dialect layer: db/migrate/queue/cache DDL is SQLite-only (`AUTOINCREMENT`, int4 epoch-ms) — migrations can't install on PG at all | data-persistence | `Dialect` parameter through `createTableSql` + every schema installer; run them all in the `db-parity-postgres` CI job | 1 |
| 7 | Queue double-delivers under concurrent PG workers — no `FOR UPDATE SKIP LOCKED` (`packages/queue/src/queue.ts:237`) | data-persistence | Dialect-aware claim SQL + fenced `complete`/`fail`; 12-concurrent-workers proof in CI | 1 |
| 8 | Default client bundle ships `react-dom/server` (118 KB vs 60 KB gzip) and the CLI hardcodes `dialect:"react"`, making the ~10 KB Preact path unreachable | ui-client | Split the `@lesto/ui` barrel (`/server` subpath); land the `ui.dialect` config key as the matched pair | 2 |
| 9 | Scaffold→run loop broken three ways: unpublished `@lesto/*@latest` deps, no `@lesto/cli` dep, guaranteed `lesto.sites.ts` crash | operability-dx | Fix deps + tolerate missing sites file + pin story; CI e2e that installs and boots the output | 2 |
| 10 | No `MailTransport` implementation exists — identity verify/reset emails cannot send | web-primitives | Ship SMTP (Node) + fetch-based provider (Workers) transports, integration-tested against an SMTP sink | 3 |
| 11 | Zero spans on real requests: `@lesto/observability` has no non-test consumer, no flush lifecycle on either tier | operability-dx (corroborated by data-persistence, edge-deploy) | Env-driven tracer in `lesto serve`/`dev`, interval+drain flush, `waitUntil` on CF | 4 |
| 12 | The MCP control plane is unlaunchable (no `lesto mcp`) and ungoverned (no authz, no audit) | operability-dx | `lesto mcp` command + `mode: read-only \| operator` gating + mandatory audit sink | 4 |

---

## 3. The waves

Six waves, ordered by dependency and risk. Each wave's "done" is testable. A wave may start
before the previous fully closes only where no dependency exists (noted).

### Wave 0 — Security stop-the-bleed (days, non-negotiable, starts now)
Blockers #1–5 plus the small batched security P1s that belong in the same pass.
Draws from: **edge-deploy** (1–2), **core-runtime** (1–2), **operability-dx** (2), **auth-security** (2), **content-cms** (1), **ui-client** (4).
- Edge: fail-closed secret, fenced `?as=`, `secureStack` mounted on `buildEdgeApp`, cross-origin-POST-refused e2e.
- Runtime: response-singleton factories; `trustProxy` right-most semantics with spoof test.
- Webhooks: `redirect:"manual"` + signed timestamps + resolved-IP pinning.
- Content: `sanitizeHtml` fail-loud + packaging fix, Workers-runtime test.
- Batched small P1s: secret-strength guard (<32 bytes throws) in SignedSessions/csrf/identity; scheme-guard `Button.href`/`Form.action`.

**Done:** blockers 1–5 closed with regression tests; CI green; nothing in the repo silently falls back to a committed secret or unsanitized HTML.

### Wave 1 — Postgres truth (~1–2 wks)
Blockers #6–7. The "production = one Postgres" pitch becomes literally true.
Draws from: **data-persistence** (1–4), **content-cms** (2).
- Dialect layer in `@lesto/db`; threaded through migrate/queue/cache/workflows installers; `LIMIT -1` fix; `db.raw(sql, params)` escape hatch + grown condition vocabulary.
- PG-safe queue claim + fenced terminal transitions + poison-payload routing.
- Migration advisory lock + `migrations:"skip"` boot mode (the rolling-deploy story `serve()` already promises).
- Delete `@lesto/orm`; fold `TableBuilder` into schema-as-value DDL.
- `content-store`: transactional persist + slug pinning (the launch seam stays airtight on both drivers).

**Done:** a Lesto app boots, migrates, queues, and caches on a real Postgres; every schema installer runs in `db-parity-postgres` CI; the concurrent-claim test admits each job exactly once.

### Wave 2 — The bundle and the loop (~1–2 wks, parallelizable with Wave 1)
Blockers #8–9. A stranger can scaffold, run, and get the optimized-by-default pipeline.
Draws from: **ui-client** (1–3), **operability-dx** (1), **content-cms** (3, 5).
- `@lesto/ui` barrel split + `ui.dialect` key + streaming `ServerRenderer` seam + Preact scaffold default + bundle-size assertion tests (≤15 KB gzip preact, ≤65 KB react).
- Write-then-sweep chunk builds (no 404ing islands mid-`lesto dev`).
- Scaffold fixes + install-and-boot CI e2e; the publish/pin decision (tarball/`file:` pins until a `0.x` publish at launch).
- Content renderer parity (rehype-sanitize on the unified path; Svelte helper sanitizes or dies); delete `content-mcp` + stale REVIEW.md files.

**Done:** `bunx create-lesto app && bun install && lesto dev` serves a page with a hydrated island on a Preact bundle, asserted in CI.

### Wave 3 — Batteries become true (~2 wks)
Blocker #10 plus the battery-posture P1s.
Draws from: **web-primitives** (1–4), **auth-security** (3–6), **data-persistence** (5–6), **edge-deploy** (4–5).
- Mail: SMTP + fetch-provider transports; CRLF hardening; `text`/`headers` on the Email shape; `List-Unsubscribe`.
- Mailing lists: confirmation send, token rotation, unique upsert, resumable broadcasts.
- Identity posture: versioned scrypt format (N=2^17, rehash-on-login, async scrypt), hashed session tokens at rest, revoke-sessions-on-reset by default, per-account login throttle.
- Kernel wires durable stores by default when a `db` is present; loud production warning on memory fallback.
- Storage S3/R2 backend (fetch + SigV4) + `url()`; deploy ship seam retyped to bytes; one remote `ReleaseStore` (R2/Workers Assets).
- Admin pagination/projection + `onMutation` audit hook.

**Done:** register → verify-email → login → reset works end-to-end with a real email through a real transport in an integration test; a fleet-deployed app shares sessions and rate limits through Postgres with zero config.

### Wave 4 — Operability and the agent plane (~1–2 wks)
Blockers #11–12.
Draws from: **operability-dx** (3–6), **core-runtime** (3–4), **auth-security** (7), **data-persistence** (7), **edge-deploy** (3), **ui-client** (5), **web-primitives** (5).
- Tracing wired: `LESTO_OTLP_URL` in `lesto serve`/`dev`, flush on interval + drain; `toFetchHandler(request, ctx)` + `waitUntil` flush; estate as the OTLP-on-Workers reference; `traceparent` in/out; first child spans (db query, queue job, webhook delivery, mail delivery).
- Event seams: identity `onEvent`, secure-stack `onDenied`, queue/workflow hooks, `runWorker` forwards `onError`, mail `onDelivered`/`onFailed`, client error beacon.
- Runtime observability batch: `X-Request-Id` echo, structured JSON access logs (both tiers), stream-truncation reporting, request line before body read, bounded readiness probe, timeout cancellation (abort the handler's signal).
- `lesto mcp` (mode-gated, audit-sinked) + `lesto openapi` (with internal-route filter).

**Done:** a served request produces a span in a local OTLP collector (integration-tested); the five-minute Claude Desktop demo runs against `lesto mcp` in read-only mode.

### Wave 5 — API freeze and truth-up (~1–2 wks; the 1.0 gate, not the launch gate)
The breaking changes that get strictly more expensive after external consumers exist, plus doc honesty.
Draws from: **core-runtime** (5–9), **auth-security** (8–9), **ui-client** (6–7), **data-persistence** (8–9), **web-primitives** (6–7), **edge-deploy** (6).
- Delete the legacy dispatch stack (ADR 0004 Phase 7.6): `Application`/`Controller`/legacy `Router`; collapse `createApp`.
- `Set-Cookie` multimap header contract; decode route params at match time.
- authz/rbac consolidation; hooks/config orphan removal; island-path convergence (estate → `defineIsland`, demote the Registry manifest path).
- Compression on the node path; i18n `Intl.PluralRules`; feeds/seo spec tightening; `wranglerConfig` round-trip honesty.
- Docs truth-up: ARCHITECTURE.md claims match code; ADR 0011 status block refreshed; workflows/pubsub claims rescoped; the fictional `test/durability-demo.js` citation removed.

**Done:** one dispatch stack, one authorization story, one island path; no public API we know we must break post-1.0; no doc claims code can't back.

---

## 4. Launch checklist (the gate)

Launch = end of Wave 4 with Wave 0–4 exit criteria all green. 1.0 = end of Wave 5.

- [ ] All 12 consolidated blockers closed, each with a regression test naming the original finding.
- [ ] `bun run ws:typecheck` + the serial coverage gate (`bun scripts/coverage-gate.ts`) green; CI green including `db-parity-postgres` running every schema installer and the concurrent-claim proof.
- [ ] Scaffold loop e2e in CI: scaffold → `bun install` → `lesto dev` → curl a route → island hydrates.
- [ ] Estate deploys to a real Cloudflare account via the documented runbook with `SESSION_SECRET` set; an unset secret refuses to serve; a cross-origin POST is refused at the edge.
- [ ] A real email delivered through a real transport in an integration test (local SMTP sink).
- [ ] A served request produces a span in a local OTLP collector, on both tiers.
- [ ] Bundle-size assertions hold: scaffold default (Preact) ≤ 15 KB gzip; react dialect ≤ 65 KB.
- [ ] `lesto mcp` demo runs end-to-end in read-only mode; write tools refuse without operator mode; every dispatch lands in the audit sink.
- [ ] No committed secret, no silent memory-store fallback in production mode, no sanitizer no-op — verified by grep + tests, not by review.
- [ ] README/ARCHITECTURE claims audited against this roadmap's scope table (§1).

---

## 5. Docs hierarchy

1. **This roadmap** — scope, sequence, and the launch gate. It wins conflicts.
2. **`docs/plans/<slug>.md`** (eight domain plans + the completed `durable-stores.md` / `island-data-hardening.md` + the cross-wave `examples-gallery.md`) — commit-by-commit execution detail. Cross-cutting work is owned by exactly one plan and referenced by the others.
3. **`docs/adr/`** — design rationale of record. ADRs are amended when a wave changes a decision; they do not re-sequence work.
4. **`docs/ARCHITECTURE.md` / `ATTACK-PLAN-2026.md`** — vision and strategy. Aspirational by design; Wave 5 trues them up against shipped reality.

---

## 6. Conflicts resolved (CTO calls)

- **Postgres in v1 vs "launch as SQLite-single-node."** data-persistence offered the honest-SQLite fallback. **Call: PG parity is v1** (Wave 1). The pitch is the substrate; the fix is scoped and the pattern (`@lesto/ratelimit`'s Dialect) is already proven in-tree.
- **`trustProxy` severity.** Both reviews rated it P1; it is cross-corroborated and silently defeats the rate-limit battery. **Promoted to launch blocker** (Wave 0) — the fix is a one-line semantic change plus tests.
- **MCP gates launch?** operability-dx says the agent plane is unlaunchable; content-cms says its domain doesn't gate. **Call: `lesto mcp` ships in v1** (Wave 4) because Bet IV is the moat and the cost is days; the Docks estate beyond the store/MCP seam ships as preview and does not gate.
- **Workflows.** The run journal is real work; the dishonest claim is free to fix. **Call:** rename to "resumable step memoization" pre-launch; journal + resume driver post-1.0.
- **Set-Cookie multimap + param decoding timing.** core-runtime wanted them "before any external consumer exists." There are no external consumers until launch; **Wave 5 is the deadline** and satisfies the constraint.
- **`@lesto/deploy` vs `wrangler deploy`.** The blessed v1 Cloudflare path stays `wrangler deploy`; one remote `ReleaseStore` ships in Wave 3 so versioned release/rollback is real for self-hosted Node and R2. The full Bet II uploader is post-1.0.
- **Hooks/config orphans.** The review allowed wire-or-delete. **Call: delete from the v1 surface** — a plugin system designed under launch pressure would be the wrong one. The WordPress-lesson extensibility bet returns post-1.0 as its own ADR.
- **Compression.** core-runtime P1. Kept pre-1.0 (Wave 5) but not pre-launch: every serious deploy fronts a compressing CDN/proxy; document that until it lands.
- **CSP/nonce.** Multiple domains touch it; none can use it until the island inline scripts carry nonces. **Deferred post-1.0 as one coherent increment**, not piecemeal.

---

## 7. The examples gallery — a per-wave QA gate (and, later, the adoption surface)

**Reframed 2026-06-16 (CTO call).** The gallery is not a post-1.0 nicety — it is
how we QA every battery we ship, on the two axes a unit test cannot reach: **local
DX** (wire the package's real public API into a running app and feel the ergonomics)
and **hosted UX** (deploy it and click the actual user journey). A feature is not
"done" until its example **runs locally and deploys**. The gallery therefore runs
*alongside* Waves 3–5, closing the feedback loop on each battery as it lands — it
does **not** wait on the Wave 5 API freeze. Its later role as the public adoption
surface (the way SST/Next make a large `examples/` legible) is a free by-product,
not the driver.

Why the prior "defer to post-1.0" logic dissolves: the fear was rewriting ~45 apps
against a moving API. But when the example IS the QA, you maintain a handful that
evolve *with* the API — the churn is the signal (a wiring that got harder is a
finding), not waste. And the cost of *not* having it is exactly the gap Wave 3 hit:
~929 lines of `@lesto/mailing-lists` shipped with its entire user-facing journey
(subscribe → confirm → broadcast) proven only as service-method calls in a unit
test — never wired into a route, never deployed, never clicked.

The motivation is still concrete: estate exercises ~16 of the ~61 packages; the
other ~45 are tested in isolation with no runnable, deployable proof. Each gallery
example IS the live evidence behind a §1 scope-table claim — the durable antidote
to "ARCHITECTURE.md is aspirational."

- One `examples/<feature>/` per battery: a small app/script exercising ONLY that
  package's real public API, with a test, a README ("what it shows / how to run /
  how to deploy"), and — where it has a deployable surface — a hosted-QA runbook.
  Targets the packages estate doesn't touch — `queue`, `storage`, `cache`, `mail`,
  `pubsub`, `webhooks`, `workflows`, `forms`, `rbac`, `openapi`, `pg`, the
  `content-*` markdown pipeline, `observability`, `i18n`, `seo`, `feeds`, `cors`,
  `csrf`, `ratelimit`, `config`, `mcp`, …
- Wiring prerequisite: add `examples/*` to the workspace globs (currently
  `packages/*` only) so each example links its `workspace:*` deps, plus a root
  `examples:test` script that runs every example's test (examples stay OUT of the
  100% coverage gate, like estate/blog).
- estate stays the INTEGRATED flagship (many batteries on one app) AND absorbs the
  hosted-QA legs for the batteries it already wires — durable sessions surviving a
  restart, login throttle, revoke-on-reset, unset-secret-refuses-to-boot. The
  gallery is the per-feature breadth for everything estate doesn't touch.
  Complementary, not redundant.
- **Execution:** `docs/plans/examples-gallery.md` owns the example template, the
  local-DX + hosted-UX QA checklist, the "done" bar, and the build backlog —
  starting with the Wave 3 batteries already shipped without a runnable proof
  (`mailing-lists`, `admin`, `release-rollback`).

**Done (per battery):** a runnable, tested example that wires only the public API,
runs in CI (out of the coverage gate), deploys via a documented runbook, and whose
hosted journey has been clicked through; the docs link each battery to its example.
