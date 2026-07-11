# Build-vs-buy portfolio review — Lesto vs mature TS tooling

**Date:** 2026-07-10
**Method:** eight independent adversarial code auditors, each pitted against the
mature comparator for its slice (Hono/Fastify, Drizzle/Kysely, Better Auth,
BullMQ/Graphile/svix/Nodemailer, ElectricSQL/Zero, Astro/Next/TanStack, Vercel
AI SDK/MCP SDK), plus one chief-architect cohesion pass over the whole. Several
auditors read the comparator's *source* (shallow clones), not just its
reputation. Every finding below is anchored to `file:line` and, where noted,
runtime-confirmed.
**Framing constraint from the owner:** judge the code for what it is — set
maturity, adoption, and licensing aside.
**Remediation epic:** `L-c5fd5621` — every Fx below is filed as a child task
(P0/P1/P2 by severity). Already-tracked items not re-filed: F7=`L-570cf908`,
F25=`L-dd366250`, F36=`L-6a58325b`, F37=`L-8bb70228`.
**P0 project:** `P0 Security Remediation` (`p0-security-remediation`) — the six
must-fix-before-production P0s (F1–F6) are grouped here for easy reference.
**Content spin-out:** the `content-*` freeze decision (F/§buckets) resolved to
a spin-out — epics `L-5c67260b` (extract into a standalone product) and
`L-96b55ec2` (build the killer integration seam). See §recommended-sequence.

> One-line answer: **you are partially wasting effort — specifically and
> measurably.** ~55–60% of the code re-derives commodity tooling that mature
> libraries do with more features *and* fewer bugs; ~25–30% is integration glue
> that only earns its place if the core is kept; ~12% is genuinely
> differentiated and **structurally impossible to buy**. The waste is real. So
> is the value. The failure mode is treating this as one decision instead of
> three buckets.

---

## Scale context

- **68 packages**, ~**135k** source LOC + ~**110k** test LOC, **1028** commits.
- All written since **2026-06-09** (~one month), largely by AI agent fleets
  under human direction.
- Production exposure: effectively **zero prod-hours**. The 100%-coverage gate
  is real discipline but measures the Node substrate — the OPFS live engine once
  shipped DOA in *every* browser under a fully green gate (ADR 0042 errata). Green
  ≠ exercised.

---

## The two findings every auditor reached independently

1. **The craft is real.** Grades ran **B to A−** across all eight slices. This
   is not AI slop. Representative: *"the best-written b-tier framework core I've
   read"* (web), model KDF implementations (auth), *"some of the most disciplined
   code in the repo"* (live). Judged as code — the owner's requested lens — it is
   good code.

2. **It is a framework, not 68 libraries in a trenchcoat.** One `SqlDatabase`
   type flows through 9 packages with no casts; one coded-error model in 41/68
   packages; one `defineX`/`createX`/`installXSchema` design language; one config
   and one deploy story. The cohesion is genuine — the Rails-8
   "Solid-everything" thesis actually executed.

## The tension that only appears when you stack the audits

- **Every slice auditor, judging its slice alone, said _buy_.** Adopt Hono.
  Adopt Drizzle. Adopt Better Auth for the long tail. Delete the S3 client and
  the hand-rolled SMTP. Adopt the Vercel AI SDK.
- **The whole-framework auditor said the opposite: _the integration is the
  point_.** Buy every slice à la carte and you re-acquire exactly the
  integration tax Lesto eliminated: version skew, five config dialects, no shared
  error model, an auth session the queue can't see, no one-command deploy.

Both are correct. **This is not a slice-by-slice decision — it is one portfolio
bet**, and it is only rational under one framing: *"we are building the
local-first + agent-native + one-trace platform that cannot exist on the
à-la-carte stack, and the commodity 60% is the admission price, not the
product."*

---

## Per-slice verdicts

| Slice | Craft | Security/soundness | Buy-verdict (slice-local) |
|---|---|---|---|
| Web/HTTP core (web, router, kernel, runtime, cloudflare, csrf, cors) | B | — | Adopt Hono as substrate; keep security/file-route/observability layers on top |
| Data layer (db, pg, migrate) | B+ | LIMIT/OFFSET **SQL injection** | Adopt Drizzle for DSL + migrator; keep only the column-kind metadata the sync engine needs |
| Auth (auth, identity, authz, oauth-server, ratelimit) | A− | **C+** | Keep the KDF/session/CSRF core (edge-smarter than Better Auth); buy the long tail (social/passkeys/orgs); OAuth AS already correctly deferred |
| Infra batteries (queue, cache, mail, pubsub, storage, flags, webhooks, workflows) | B+ (queue) … C | — | Keep queue + webhooks; delete storage S3 client → aws4fetch, mail SMTP → Nodemailer; reframe workflows |
| Live/sync moat (live, live-protocol, live-server, realtime) | A− | **C+ protocol** | Keep the `live()` surface; seriously reconsider the engine (adopt Electric under the façade, or commit to durable shape logs + fenced seam + pushdown + HA) |
| Frontend/DX (ui, island-dev, client, styles, ui-kit, forms, assets, env) | B+ | — | Own the runtime + typed client; stop hand-building the dev bundler (make it a Vite plugin) |
| AI/agent-native (ai, mcp, content-mcp, ui-generate, observability) | A− | — | Adopt Vercel AI SDK for the model layer; **keep the MCP governance control plane** — the one thing a competitor couldn't clone in a week |
| Whole-framework cohesion | B+ | — | Rational venture, irrational shortcut |

---

## The bucket model (where the money goes)

| Bucket | ~LOC share | Verdict |
|---|---|---|
| **Commodity re-derivation** — web core, db DSL, auth primitives, mail SMTP, storage S3, `@lesto/ai` model layer, most of content-* | ~55–60% | The waste. Mature tools are strict supersets with fewer bugs. `content-*` alone is ~25% of the codebase — a second product hiding inside the first. |
| **Integration glue** — kernel/runtime, cli/scaffold/deploy, cache/ratelimit/cors/csrf, islands+data tier | ~25–30% | Earns its place **iff** the differentiated core is kept. Worthless if the core is dismantled. |
| **Genuinely differentiated** — `live()` on your own ORM, the MCP governance control plane, one-traceId observability | ~12% | The company. Cannot be bought. `live()` cannot be a method on Drizzle's builder; MCP governance needs a uniform ops layer; browser→server trace stitching needs to own the render pipeline. |

---

## Findings register

Severity: **P0** = security/data-loss/correctness that must not ship;
**P1** = spec violation or reliability defect; **P2** = capability gap / quality
debt. "Tracked" = already on the board (not re-filed).

### P0 — security & silent data loss

| # | Finding | Location |
|---|---|---|
| F1 | `LIMIT`/`OFFSET` string-interpolated, not parameterized or validated — runtime-confirmed injection; module header explicitly promises the opposite | `packages/db/src/queries.ts:198-212` |
| F2 | 2FA not enforced at login — full session minted on password alone; TOTP challenge upgrades no server-side state → 2FA-bypass-by-default for any "has a session" gate | `packages/identity/src/identity.ts:952-958,1171-1202` |
| F3 | D1 `transaction()` is a silent no-op passthrough → rate limiter's atomic read-modify-write degrades to a lost-update race and **fails open** on the flagship edge target, violating its own docstring; queue batch atomicity also evaporates | `packages/cloudflare/src/d1.ts:78`; `packages/ratelimit/src/sql-store.ts:88-135`; `packages/queue/src/queue.ts:433,665` |
| F4 | Binary request bodies corrupted framework-wide — every body forced to a UTF-8 string; `rawBody` is a *string* → binary-webhook HMAC verification impossible by construction; no multipart | `packages/runtime/src/server.ts:619`; `packages/cloudflare/src/fetch-handler.ts:370`; `packages/web/src/types.ts:36` |
| F5 | `streamText({ tools })` silently drops the tool call — no field for tool calls in `StreamDelta`/`StreamFinal`; both frame-interpreters fall through; undocumented. Breaks the streaming agent loop the framework markets | `packages/ai/src/types.ts:78-98`; `anthropic.ts:209-242`; `openai-compatible.ts:329-363` |
| F6 | `verifyToken` "never throws" is false — a same-string-length CSRF token with non-ASCII bytes makes `timingSafeEqual` throw `RangeError` → attacker turns 403 into 500 on demand | `packages/csrf/src/token.ts` |
| F7 | Default `HIGH_ENTROPY` redaction dropped in the dev MCP bridge — safe only while the allowlist is structure-only; opaque secrets flow the moment `tail_logs`/`get_recent_requests` join it | `packages/cli/src/ai-redact.ts:337-348` — **tracked (L-570cf908)** |

### P1 — spec violations & reliability

| # | Finding | Location |
|---|---|---|
| F8 | Brute-force protection opt-in — `login`/`totp` rate limiters optional; default is no attempt cap at all | `packages/identity/src/identity.ts:384,402` |
| F9 | HEAD → 404 on every dynamic route (RFC 9110 §9.1 MUST); no 405/`Allow` | `packages/web/src/lesto.ts`, `RouteTable` |
| F10 | Strong ETag reused across content-codings — identical strong validator for br/gzip/identity (RFC 9110 §8.8.3); breaks `If-Range` through shared caches | `packages/runtime/src/server.ts:786-826,929-945` |
| F11 | `and()`/`or()` with zero args emit malformed `WHERE ` — common dynamic-filter pattern → broken SQL | `packages/db/src/conditions.ts:188-195` |
| F12 | Queue `reclaim()` never retires — no `attempts >= max` check → an OOM-killing job is re-claimed forever | `packages/queue/src/queue.ts:624-638` |
| F13 | Queue `complete()` + `releaseReadyDependents()` are two non-transactional statements → crash strands a DAG permanently (no sweep) | `packages/queue/src/queue.ts:1179-1181` |
| F14 | Queue fencing token is the `locked_until` timestamp → same-millisecond reclaim collision lets a stale worker's terminal write land; use a random claim token | `packages/queue/src/queue.ts:1166` |
| F15 | Hand-rolled SMTP lost-wakeup deadlock (buffer not checked before park) + no dialogue timeout → stalled server holds worker past visibility → **guaranteed duplicate send**; plus RFC 2047 / CTE / 998-char / 465 / Date gaps | `packages/mail/src/smtp.ts:166-199,226-272,83-94` |
| F16 | Storage `list()` silently truncates at 1000 keys — no `IsTruncated`/continuation | `packages/storage/src/s3.ts:103-119` |
| F17 | `PubSub.publish` awaits listeners sequentially and one throw aborts delivery to the rest — violates the invariant its own sibling `fanout()` enforces | `packages/pubsub/src/pubsub.ts:81-83` |
| F18 | `notFound()` returns HTTP 200 to crawlers/no-JS under streaming; 500 from a loader; no way for `load` to set status | `packages/web/src/file-routes.ts:549-556`; `render-page.tsx:459` |
| F19 | Authority confusion — `new URL(req.url, "http://localhost")` parses `//evil/admin` as authority and routes `/admin`; proxy-ACL-bypass smuggling shape | `packages/runtime/src/server.ts:527`; `packages/web/src/request.ts:113` |
| F20 | Default CORS breaks preflighted JSON — never reflects `Access-Control-Request-Headers`; no `Expose-Headers`, no origin regex/callback | `packages/cors/src/cors.ts:150-152` |

### P2 — capability gaps & quality debt

| # | Finding | Location |
|---|---|---|
| F21 | Multi-value loss — repeated query keys last-wins, repeated headers first-wins, no `queries()` escape hatch | `packages/web/src/request.ts:58,65-73`; `fetch-handler.ts:276-284` |
| F22 | Cache default `MemoryStore` is an unbounded `Map` — no LRU/max-entries/sweep | `packages/cache/src/memory-store.ts:14-32` |
| F23 | `ui-generate` imports `@anthropic-ai/sdk` directly, hardcoded to `claude-opus-4-8` — violates the very ADR 0021 that `@lesto/ai` exists to enforce; `generate_ui` is Anthropic-only | `packages/ui-generate/src/anthropic.ts:11` |
| F24 | `createLlmJudge` stamps a Claude model-id onto any injected model → a judge over `createOpenAICompatible` (Ollama/LM Studio) requests a Claude id from an OpenAI endpoint → runtime `AI_HTTP_ERROR` | `packages/ai/src/evals.ts:79` |
| F25 | OpenAI reasoning models 400 on `max_tokens` (need `max_completion_tokens`) — CI-green, breaks at runtime | `packages/ai/src/openai-compatible.ts:114-121` — **tracked (L-dd366250)** |
| F26 | Preact dialect abandons streaming SSR (`renderToString`) — the two headline wins (10 KB bundle, streaming) are mutually exclusive | `packages/web/src/render-page.tsx:438-447` |
| F27 | Island dev server is a loopback-Vite + per-module fetch proxy, not a Vite plugin — the architecture that forced the cold-start-504 class and now depends on undocumented Vite internals | `packages/island-dev/src/vite.ts`; `entry.ts:44-77` |
| F28 | Prod build downgrades **every** Rollup `MISSING_EXPORT` to a warning (to contain a framework `React.use`-off-namespace hack) → a user's genuine typo ships as `undefined` | `packages/assets/src/vite-build.ts:97-105` |
| F29 | Client error beacon injected by `Function.prototype.toString()`-serializing cross-referencing functions by name → any minify/rename breaks the shipped entry silently | `packages/assets/src/synthesize.ts:124-135` |
| F30 | `workflows` markets "durable execution" but ships step memoization only — `ctx.sleep` is a real non-durable timer, no versioning, "exactly-once" comment is false. Honestly labeled in the docstring; dishonestly named as a battery | `packages/workflows/src/engine.ts:70-80,215,124-135` |
| F31 | `content-mcp` is dead Studio-era rot (hardcoded `localhost:4400`, `zod-to-json-schema`, zero in-repo consumers) sitting under the "MCP" banner | `packages/content-mcp` |
| F32 | Sequential tool execution + no `is_error` continuation in the agent loop — multi-tool turns run one-at-a-time; a thrown tool aborts the whole run instead of feeding the error back | `packages/ai/src/agent.ts:154,185-192` |

### Live/sync moat — engine hardening (mostly already tracked)

| # | Finding | Location / status |
|---|---|---|
| F33 | Unfenced snapshot↔tail seam — a commit between the snapshot read and `shapes.set` can be lost/double-applied; fix = capture `pg_current_wal_lsn()` + `START_REPLICATION` from it | `packages/live-server/src/engine.ts:696-706` |
| F34 | Server restart → full re-snapshot storm (engine state in-memory) — a deploy makes every client re-read its whole backing table; needs durable per-shape logs | `packages/live-server/src/engine.ts:337,684`; `resume.ts:261` |
| F35 | Snapshot reads the entire table and filters in JS — no WHERE pushdown; O(table) per subscribe/tick | `packages/live-server/src/engine.ts:392` |
| F36 | Parameter-vs-template shape authz has no paved road — sharpest cross-tenant leak vector left to app-author discipline | **tracked (L-6a58325b, GA-3a)** |
| F37 | Boot-time single-writer guard (fail-closed `pg_try_advisory_lock`) | **tracked (L-8bb70228, GA-3b)** |
| F38 | Frozen-tab leader stalls the origin — a frozen leader keeps its Web Lock, stops draining SSE, no follower promoted (liveness, not safety) | `packages/live-server/src/cross-tab.ts:33-43` |

---

## What is genuinely better than the comparators (the keep list)

Stingy on purpose — only real, code-verified wins:

- **`originCheck` CSRF design** (`packages/csrf/src/origin.ts`) — `Sec-Fetch-Site`-first,
  deliberately Content-Type-blind, fail-closed on no-signal. Exactly the bypass
  class of Hono's CVE-2024-43787 and the SvelteKit/Astro CSRF CVEs. Neither
  comparator ships anything this considered in core.
- **Secure-by-default as a system** — security headers on every response
  including error paths and both tiers; default-on rate limiting wired to a
  durable store at the kernel; SSE admission tier; sub-node socket timeouts.
- **Edge-KDF realism** — refuses scrypt on the edge (OOMs the isolate), selects
  PBKDF2 over `crypto.subtle` with a coded refuse-before-derive. Lesto has
  thought harder about the Workers constraint than Better Auth has.
- **The MCP governance control plane** — governed, OAuth-gated, per-tool-policy-floored
  app actions as MCP tools. *The one thing a competitor couldn't clone in a week.*
- **Typed end-to-end client with zero codegen** (`packages/client`) — `ContractOf<typeof serverApi>`
  projects server handler shapes into client types; a tRPC-class win without the
  tRPC runtime or a build step.
- **`live()` as an ORM-native builder** — one query language, one AST, two
  runtimes. The substrate-nativeness Electric structurally can't match.
- **One-traceId observability** — browser→server trace stitching + `ai.*` spans.
- **The queue's zero-infra portability (on node)** — same code, sqlite for dev /
  pg with `SKIP LOCKED` for prod. No incumbent offers this (BullMQ=Redis,
  Graphile=pg-only). *(The D1 leg is not delivered — see F3.)*

---

## The strategic question: is there an argument for "buy 0 packages"?

The owner's challenge: *fix all the security vulns, close the gaps with vendors,
ship the 12% and more, and buy nothing.* There is a real argument. Both sides,
honestly:

### The bull case for owning everything

1. **The cost curve that built this is the cost curve that maintains it.** The
   classic "don't hand-roll auth/SMTP/S3" wisdom is priced for *human* teams,
   where every commodity package is salary-months you didn't spend. This
   codebase was built by agent fleets in a month. If closing a spec gap in the
   SMTP client is an afternoon of agent time, the build-vs-buy math inverts:
   owning is cheap and buying imports a dependency you don't control.
2. **The integration tax is the product.** Every à-la-carte adoption reintroduces
   version skew, a foreign error model, a config dialect, and a seam the shared
   substrate can't reach. The chief-architect audit is unambiguous that the
   cohesion is real and that it is the differentiator. Buying dissolves it.
3. **"LLMs don't know `@lesto`" is self-correcting on the owned path.** The
   agent-native surface (AGENTS.md, the dev MCP, `describe_app`, llms.txt) is
   precisely the mechanism that teaches an agent an unfamiliar framework in-repo.
   You can't ship that on someone else's packages.
4. **Vendors are young too.** Better Auth is v1.x with its own advisory history;
   Drizzle churns three coexisting provider-spec versions; the AI SDK's provider
   interface has broken across majors. Betting your *differentiation* on a
   third-party lib contradicts "batteries-included."
5. **Zero dependencies is itself a feature** for edge-portability and supply-chain
   surface — and ADR 0021's injected-transport seam is verified sound (the OpenAI
   provider landed as a genuinely additive file).

### The bear case (why "buy 0" is a trap as literally stated)

1. **The security bugs are the tell.** F1 (SQL injection), F2 (2FA bypass), F3
   (fail-open rate limiter) are not "young code" bugs — they are *re-introducing
   the exact class the mature tool already fixed*. Owning the code means owning
   this failure mode **forever**, on a security-critical surface, with a bus
   factor of one. Drizzle's parameterized LIMIT is not a feature you'd "catch up
   to" — it's a whole culture of adversarial testing you'd be re-growing from
   scratch.
2. **Velocity built breadth, not scar tissue.** A month of agent-built code with
   zero prod-hours is *wide*, not *hardened*. The OPFS-DOA-under-green-CI incident
   is the proof-class: agent fleets + 100% coverage produce confident, untested
   surface. Vendors' value is not their code — it's the millions of prod-hours of
   bugs already found and fixed. You cannot agent-fleet your way to that; it only
   comes from users you don't have yet.
3. **Owning everything means the security tail is a standing tax, not a
   one-time cost.** Auth, webhooks, OAuth, SMTP, S3 signing, CORS/CSRF — each is a
   permanent CVE-watch and spec-drift liability, competing for attention against
   the 12% that is the actual company. Every hour on the SMTP RFC-2047 gap is an
   hour not on `live()`.
4. **Some "gaps" are not close-able at your scale.** The live engine needs
   durable shape logs, a fenced seam, WHERE pushdown, and an HA consumer to
   survive one production deploy (F33–F35). That is a multi-quarter distributed-
   systems investment — the single place where "buy the substrate (Electric) and
   keep the surface" is the *faster* path to shipping the moat, not the slower one.

### The synthesis — a defensible middle that is closer to "buy 0" than my first pass

The honest reconciliation, weighting the agent-velocity argument the owner is
right to raise:

- **Own everything that is on the differentiated or integration path, and fix
  the P0s** — the security bugs *must* be fixed regardless of build-vs-buy, and
  once fixed, the auth/web/db cores are edge-smarter than the vendors and worth
  keeping. On the agent-velocity cost curve, closing the *feature* gaps
  (HEAD support, multipart, richer prop serialization, the queue's stalled-job
  retirement) is cheap and keeps cohesion. **This is a large fraction of "buy 0"
  and it is defensible.**
- **The three places to still buy, for reasons velocity does not solve:**
  1. **The live/sync engine internals** — buy Electric *under* the `live()`
     façade (keep the moat surface, rent the years of replication hardening), or
     accept a multi-quarter engine build. Owning the surface ≠ owning the WAL
     shipping.
  2. **The `@lesto/ai` model layer** — the SDK dependency here buys wire-format
     parity with a fast-moving vendor API (prompt caching, new content blocks,
     tool-call streaming) that you will otherwise hand-track forever for no
     differentiation. Keep the `LanguageModel` seam; consider the AI SDK behind
     it.
  3. **`content-*`** — not "buy," but "don't own at this weight." It is 25% of
     the codebase for a non-core bet; freeze or excise regardless.
- **Everything else — web core, db DSL, auth, queue, cache, webhooks, mail
  transport, storage, the island runtime — is ownable on the velocity thesis
  once the P0s are fixed**, provided the owner accepts the standing security-tail
  tax with clear eyes and keeps the bus factor honest.

So: **yes, there is a real argument for buying (almost) 0 packages — and it is
stronger than the reflexive "always buy auth" wisdom, precisely because of the
agent-velocity cost curve.** But it is not "buy 0 and ship." It is: **fix every
P0 first (non-negotiable), buy the replication engine and the AI wire layer
where owning buys you nothing but a maintenance tail, freeze `content-*`, and
then own the rest.** The literal "buy 0" only becomes irrational at two specific
seams (sync-engine hardening, AI wire-parity) where the thing you'd be owning is
someone else's multi-year moat, not your own.

---

## Recommended sequence

1. **Fix the P0s** (F1–F6, project `P0 Security Remediation`) — mandatory before
   any "production-ready" claim. F7/F8 close the pentest-obvious auth defaults.
2. **Fix the P1 reliability set** (F9–F20) — spec conformance + queue/mail/pubsub
   correctness; these are cheap on the velocity curve and keep cohesion.
3. **Decide the two real buy-seams** (`L-0993ff3e`) — live engine
   (Electric-under-façade vs build) and AI wire layer (SDK-behind-seam vs
   hand-track). These are the only two decisions where "own it" carries a
   multi-year hidden cost.
4. **Spin `content-*` out into its own product, then build the seam** — the
   `content-*` freeze decision resolved to a spin-out, not a freeze-in-place:
   - **`L-5c67260b`** — extract the 14 content-* packages (~25% of the codebase)
     into a standalone product with its own repo, release train, and semver,
     dependency direction strictly product→core. Delete dead rot in flight
     (F31/`content-mcp`); reframe `workflows` (F30).
   - **`L-96b55ec2`** (blocked by the spin-out) — build the **killer integration
     seam** so a Lesto app consumes the content product as if it were
     first-party: one config, one `SqlDatabase` handle, one error model, one
     authz seam, one trace, typed-end-to-end, agent-native by default — verified
     in `examples/estate`, one-command CF deploy. This is the move that turns the
     spin-out from a cost (another dependency paying integration tax) into a
     differentiator; treat it as 12%-tier work.
5. **Pour reclaimed effort into the 12%** — `live()` hardening (F33–F38), the MCP
   control plane, and production exposure (the scarce resource is scar tissue,
   not more packages).

**Bottom line:** rational venture, irrational *reflexive* shortcut — but the
owner's instinct to own is more defensible than a slice-by-slice "buy" read
admits, *if and only if* the P0 security bugs are fixed first and the two
genuine buy-seams are chosen deliberately rather than by default.
