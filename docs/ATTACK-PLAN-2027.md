# Lesto — Household by 2027 (the adoption attack plan)

> Companion to `docs/ATTACK-PLAN-2026.md`. That plan said *how the product wins*;
> this one says *how the world finds out*. Grounded in the true state of 2026-07-05:
> 36 packages live on npm (0.1.2), docs.lesto.run and lesto.run live, launch funnel
> armed but unfired, and one P0 first-touch defect standing between us and the
> detonation. Tone: ruthless and excited, on purpose. Honesty guardrail
> (`docs/brand/messaging.md` §5) is binding on every claim below.

---

## 0. What "household" means (so we can't lie to ourselves)

"Household" does not mean out-sharing Next.js by 2027 — that's a decade-scale
outcome and pretending otherwise corrupts every decision downstream. It means:

**By end of 2027, "agent-native framework" has a default answer, and it's Lesto** —
the way "type-safe router" means TanStack and "islands" means Astro. Concretely,
category-default means: when someone asks the question in public (HN, Reddit,
a survey, an LLM), Lesto is the first answer; when an incumbent ships an
agent-native feature, they get compared to us, not the reverse.

The metrics ladder (checkpointed quarterly, logged like `docs/readiness/`).
The two *primary* columns are leading indicators we can directly move — the
category-share definition above made samplable, and **agent activation**: the
fraction of agents that go zero → scaffold → running dev → first MCP operation
in one shot. Stars/downloads are trailing bands (red / on-track / exceptional)
re-based on solo-maintainer comparables, not company-backed outliers:

| Checkpoint | Category share (primary) | Agent activation (primary) | Stars (red/track/exceptional) | create-lesto wk dl | Community | Proof |
|---|---|---|---|---|---|---|
| Launch +30d (Aug 2026) | named in ≥¼ of sampled "agent-native framework" answers (search-grounded LLMs, HN/Reddit) | ≥60% one-shot success | 800 / 1,500 / 2,500 | 150 / 400 / 800 | 200 members, 5 ext PRs | HN front page; first outside prod app attempt |
| End 2026 | first answer in ≥½ of samples | ≥80% | 2,500 / 4,000 / 7,000 | 800 / 1,500 / 3,000 | 1,000 members, 10 contributors | 3 non-us production apps; published benchmarks; 1 conf talk accepted |
| 1.0 (mid-2027) | default answer; incumbents compared to us | ≥90% | 5,000 / 8,000 / 12,000 | 2,000 / 4,000 / 8,000 | active RFC process | 10 case studies; security audit; LTS policy |
| End 2027 | category-default per above | sustained ≥90% | 8,000 / 12,000 / 20,000 | 4,000 / 8,000 / 15,000 | 20+ regular contributors | State of JS 2027 presence; 3+ conf talks given |

Below the red band at a checkpoint → the *strategy* gets re-examined at that
checkpoint, not the effort doubled blindly.

---

## 1. Where we actually are (2026-07-05)

**Assets in place (most of the 2026 plan landed):**
- 36 packages live on npm via OIDC trusted publishing; `bunx create-lesto` works.
- docs.lesto.run live: 25 battery pages, migration guides, testing guide, blog
  with the two honest flagship posts, `llms.txt` + per-page `.md` twins (docs an
  agent can actually read — almost nobody has this).
- lesto.run live with the locked hero: **"Batteries-included. Agent-native."**
- The two genuinely novel, *shipped* differentiators: one trace from the browser
  to the database, and the governed MCP control plane. Plus the moat-in-progress:
  Tier-4 local-first sync (`lesto.live`) with its capstone shipped.
- Codespaces try-it, CoC, funding file, seeded quickstart, claims guardrail.

**The gap (why nobody knows any of this):**
- The launch funnel was gated on publish day (L-b80af2e4, now DONE) and never
  fired: launch post, Show HN, multi-channel push, awesome-lists, community
  channel, newsletter, visual brand, README hero — all still backlog.
- **P0 first-touch defect (L-513dd8a6):** *(REFUTED 2026-07-05 — this was a
  test-harness restricted-port bug, not a product defect; see the §6
  gate-CLEARED entry. The bullet is retained as written for the record.)*
  published 0.1.2 `lesto dev` on the
  default hoisted-Linux path is unreachable to a Node undici `fetch()` client.
  curl works; browsers untested; the dev-MCP loop unproven (L-e51c033d). The
  undici client *is our wedge audience* — every agent, every SSR tool, Claude
  Code itself. Launching "the framework agents can drive" while an agent's first
  `fetch()` against it hangs is category suicide, and HN will find it in hour one.
- Zero published benchmark numbers, zero community members, zero production
  users outside the repo.

**The environment (why now):** 2026–27 is the window in which "how do agents
operate software" gets standardized. MCP won the protocol; no framework owns the
framework layer. Cloudflare owns our toolchain and sells adjacent primitives but
not a coherent framework. The category is being born — categories get names
early, and then the names stick.

---

## 2. The theory of the win

1. **Own the niche before contesting the mainstream.** We do not out-market
   Vercel for "React framework." We become the *entire conversation* for
   agent-native — a category with genuine pull and no incumbent — and let the
   batteries-included substance convert visitors who came for the demo.
2. **Distribution where agents live, not just where devs read.** Devs
   increasingly *ask their agent* what framework to use. The channels that
   matter as much as HN: MCP server directories, Claude Code skills/plugins,
   Cursor rules, `llms.txt` crawlers, awesome-mcp lists, LLM training corpora
   (docs quality compounds here). We are structurally advantaged: our docs are
   already agent-readable and our framework is the one an agent can actually
   drive end-to-end.
3. **Proof over promises.** Every phase exits on something a skeptic can run:
   the wedge demo is a live site an agent mutates; benchmarks publish the
   harness; case studies name real apps. The claims guardrail is the brand.
4. **Cadence is the community product.** Weekly release notes, monthly "an agent
   built this" demo, quarterly checkpoint against §0 — visible heartbeat beats
   sporadic virality.

---

## 3. The campaign (five phases)

### Phase L0 — First-touch integrity (now → 2026-07-24, hard deadline)

> **Status 2026-07-05: gate CLEARED — see the §6 decision log.** The three
> proofs below are DONE (the "defect" was refuted as a harness port bug; no
> 0.1.3 was needed for it). This section is retained as the original gate
> definition; the *live* pre-launch work is the parallel list below it.

The launch is gated on exactly three proofs, and nothing else — scope discipline
here is what keeps the deadline honest:

- **Fix L-513dd8a6** (hoisted-Linux `lesto dev` undici-unreachability) and ship
  **0.1.3**, verified through the faithful harness (verdaccio-published HEAD,
  real registry closure — not the local-pack preflight that greened at every
  bisect SHA).
- **Prove the dev-MCP loop on the published closure** (L-e51c033d) — the wedge
  demo runs on `bunx create-lesto@latest`, not on a workspace link.
- **One real-browser smoke** on the published scaffold (Chrome, the leg-b flake
  fix already landed) so "browsers untested" stops being true.

Parallel (non-gating): visual brand minimum (wordmark/favicon/OG — L-fc92f5b8),
README hero + demo GIF (L-fd9bc030), finish the wedge screencast (L-62b22a91),
draft the launch post (L-80ff5e22), open the community channel *quietly*
(L-f99bdb0d) so it isn't empty on launch day.

- **Agent on-ramp minimum:** *(correction 2026-07-05: 0.1.2 already ships
  `AGENTS.md` + `CLAUDE.md` — the "ships none of this" premise was wrong; what
  was missing is the MCP control-plane guidance and the skill.)* SHIPPED same
  day: AGENTS.md gained a "Drive the app over MCP" section (banner, token
  header, read-only governance, `describe_app`-first, Claude Code + raw
  JSON-RPC recipes) and every scaffold now carries a first-party Claude Code
  skill (`.claude/skills/lesto/SKILL.md`). **Reaches users only with the next
  create-lesto release — cut it before L1 day.** Launch day *is* the
  agent-ecosystem distribution event; the Show HN reader's first move is
  "Claude, try this framework." The heavier items (registry listings,
  Cursor/Windsurf rules polish, plugin expansion) stay in L2.
- **Claims-source refresh (blocks L1 artifact drafting, not the launch gate):**
  `messaging.md` §5 is v0 (2026-06-21) and predates the shipped Tier-4 epic (its
  local-first row still describes the pre-replication `live()` v0), and
  ARCHITECTURE.md still marks realtime "◻ build". Refresh both to post-capstone
  reality, including explicit upgrade criteria on the local-first row (per-row
  authz, offline writes, open hardening list). Every launch artifact is
  claims-reviewed against the *refreshed* table.

*Exit: `bunx create-lesto@0.1.3 my-app && cd my-app && lesto dev` works for
curl, undici, a browser, and an MCP client, on hoisted Linux, from the real
registry. If the fix lands early, the launch moves up — the deadline is a
backstop, not a target.*

### Phase L1 — Detonation (one week, target 2026-07-27 → 08-01)

One coordinated event, as the epic always intended — not a slow leak:

- **Show HN** with the launch post: lead with the 90-second wedge video (from
  Claude: add a content type, generate validated UI, see the one trace — all
  real, all shipped). Title tells the truth plainly; comments get the honest
  "what's preview vs shipped" table. HN rewards the guardrail voice.
- Same-day: multi-channel push (L-714eb185), awesome-lists + MCP directories
  (L-ff859d2c), Discussions/Discord opens publicly, newsletter capture live on
  both sites (L-c2babfb4 — dogfooding @lesto/mailing-lists *is* a story),
  good-first-issue board seeded (L-d51a3369).
- Founder presence in every thread for 72 hours. Answer the skeptics with code.

*Exit: §0 launch-checkpoint metrics seeded; every inbound channel (repo,
Discord, newsletter, docs search queries via PostHog) is being measured
(L-e9eed324 dashboard live).*

### Phase L2 — Category capture (Aug → Nov 2026)

Make "agent-native" mean Lesto, with a flywheel not a moment:

- **Content cadence:** the 12-tutorial backlog (L-d9e934d0) at ~1/week, each a
  shipped battery + real example; the "build X *from your agent*" series
  (L-91628be4) is the differentiated half. 6-week calendar (L-4df00de3) runs it.
- **Agent-ecosystem distribution:** the L0 on-ramp shipped the in-scaffold
  skill + AGENTS.md; what remains here is the genuinely-deferred tier — a
  Claude Code **plugin/marketplace entry** (discovery *before* you scaffold),
  Cursor/Windsurf rules files in the scaffold, registry listings for the MCP
  control plane. An agent that can *succeed* with Lesto in one shot is our
  highest-leverage distribution artifact.
- **Benchmarks with published numbers** (L-97e1bca5 + the harness tasks):
  cold-start, bundle size, realistic SSR throughput vs Next/SvelteKit/Astro/RR7
  — reproducible harness, honest error bars, publish the losses too. Credibility
  is the differentiator; the numbers just have to be real.
- **Monthly live demo:** "an agent built this" — streamed, unedited, archived.
  This is the category-defining ritual; nobody else can run it.
- Keep shipping product (ADR 0043/0044 app-defined MCP tools, TW8 `lesto add`,
  dev-loop MCP hardening) — the demos need fresh material, and agent-native
  claims must keep outrunning fast-followers.

**Priority when the week binds** (capacity is §5 risk #1 — shed from the bottom):
1. monthly live "an agent built this" demo (the category ritual — never shed);
2. agent-ecosystem distribution follow-through; 3. benchmarks — one metric
published honestly beats four started; 4. product work feeding the demos
(dev-MCP hardening, 0043/0044); 5. tutorial cadence — degrade 1/week → biweekly
before touching 1–4; the 12-item backlog is a pool, not a promise.

*Exit: end-2026 checkpoint (§0); "agent-native framework" searches and LLM
answers surface Lesto; ≥3 outside production apps in the wild.*

### Phase L3 — Production proof → 1.0 (Dec 2026 → mid-2027)

Nobody makes a framework a habit without trusting it in prod:

- **Design-partner program:** recruit 5–10 teams (from the community funnel)
  building real apps; white-glove them; their apps become named case studies.
  Target the wedge-shaped buyer: teams building agent-operated products.
- **`lesto.live` as the flagship story:** local-first sync on one substrate is
  the moat (ADR 0042); ship the remaining hardening and make the capstone a
  public, poundable demo. "Local-first sync in one framework" becomes a public
  claim only when the messaging.md live()/local-first row is upgraded per its
  stated criteria; until then the story ships as "in active development" plus
  the poundable capstone demo.
- **1.0 = criteria, not vibes:** API-stability contract + deprecation policy,
  external security audit (launch-security findings closed), upgrade guides,
  LTS statement, the readiness score (docs/readiness/) at its bar. Target
  mid-2027, and 1.0 gets its own (smaller) detonation: the second Show HN.

*Exit: 1.0 shipped with 10 named case studies and an audit; §0 1.0-checkpoint.*

### Phase L4 — Scale the surface area (2027 H2)

- **Conference circuit:** ViteConf / JSNation / React Summit CFPs submitted in
  Q1 2027 (deadlines land early — file the pitch-kit task now); the talk is the
  wedge demo live on stage.
- **Ecosystem:** stable plugin/battery API + a community-batteries registry;
  the RFC process public; contributor ladder beyond good-first-issue.
- **Education loop:** creator kit (assets, claims-safe fact sheet, ready-made
  demo repos) pitched to the big YouTube/course channels; hackathon sponsorships
  where agent-building happens.
- State of JS 2027 presence; the end-2027 checkpoint (§0) is the campaign's
  final exam.

---

## 4. Cadence & instrumentation (cross-cutting)

- **Weekly:** release + changelog (changesets task L-b5817d25); triage rotation.
- **Monthly:** live agent demo; newsletter issue; metrics review vs dashboard.
- **Quarterly:** §0 checkpoint logged in `docs/readiness/`-style JSON; strategy
  re-examined on a >50% miss.
- **Dashboard (L-e9eed324):** stars, npm downloads, docs traffic + search terms
  (PostHog seam already wired), Discord growth, contributor counts, and — the
  category metric — share of "agent-native framework" answers naming Lesto
  across LLMs/search, sampled monthly.

---

## 5. Risks, honestly

- **Capacity is the #1 risk.** This plan plus the product backlog exceeds one
  person unless the agent-fleet development model keeps compounding. Mitigation:
  the phases are strictly sequenced (never run two detonations at once), the
  content flywheel is fleet-friendly (draft→verify pattern already proven), and
  community contribution is deliberately cultivated from L1, not deferred.
- **Cloudflare ships the thesis.** They own Vite/Rolldown and sell agents +
  edge + D1. Mitigation unchanged from the 2026 plan: differentiate one layer up
  (coherent batteries + governance + one-DB), stay portable, treat CF as the
  flagship target. If they ship a framework, we are the neutral alternative.
- **Category commoditization.** Next.js can bolt on an MCP server in a quarter.
  Our defense is depth they can't retrofit quickly: *governed* operations
  (audit, policy floors, operator mode), agent-observable traces, agent-readable
  docs, and the one-substrate coherence that makes `generate_ui`→migrate→deploy
  a single loop. Keep the depth compounding (ADRs 0031–0035, 0043/0044).
- **The honesty guardrail under growth pressure.** Every overclaim caught costs
  more than ten features (we already caught a fleet trying to publish an
  unshipped headline). The guardrail file stays binding; every launch artifact
  gets a claims review against it.
- **Launch-window anxiety.** Waiting for 0.1.3 risks momentum; launching broken
  risks the category. The gate is scoped to exactly three proofs (§Phase L0)
  with a hard deadline so it can't silently expand into perfectionism.

---

## 6. Decision log

All three decisions were put to a chief-architect ratification pass on
2026-07-05 (per the decision-gated-delegation rule); verdicts: (a) AMENDED as
below, (b) RATIFIED with a wording correction, (c) RATIFIED with the criteria
list frozen. No P0 objection to the plan.

- **2026-07-05 — Launch gate (amended):** detonation (L1) is gated on the three
  Phase-L0 proofs (0.1.3 undici fix, dev-MCP-on-published proof, one browser
  smoke); launch moves *up* if they land early. **2026-07-24 is an escalation
  trigger, not a launch-anyway date:** if any proof is red on 07-24, the fork is
  decided that day in this log — (i) launch with a documented known-issue only
  if the defect has been downgraded (browsers + dev-MCP proven unaffected), or
  (ii) slip to a named new date with a public devlog post. Silent slip and
  broken launch are both forbidden outcomes. Proof #1 is not a one-shot: the
  verdaccio published-closure check runs *before* 0.1.3 is cut (L-513dd8a6 as
  re-scoped) and ships as the standing blocking pre-publish gate (L-e6a86c59 —
  `needs:` the verdaccio job, not the blind preflight), because §4's weekly
  release cadence without it is a regression machine for exactly this defect
  class.
- **2026-07-05 — Category bet:** agent-native is the category bet, the demo
  lead, and the distribution strategy; batteries-included remains the first half
  of the locked hero (messaging.md §2) and the conversion/retention story.
- **2026-07-05 — Launch gate CLEARED (same day):** proof #1 was refuted as
  unnecessary — the "published 0.1.2 undici-unreachable dev" was a test-harness
  port bug (leg-a probed port 4190, on the WHATWG fetch restricted-ports list;
  undici/browsers refuse it pre-connect), not a product defect. **There is no
  defect; no 0.1.3 is required; the verdaccio harness is not needed for this.**
  Root-cause + fix `b08c770` (independently verified: mechanism reproduced,
  guard exercised at 13 ms vs the 5 s deadline). Proofs #2 and #3 then executed
  green: dev-MCP loop proven on the real registry closure via a real
  `@modelcontextprotocol/sdk` StreamableHTTPClientTransport under Node undici —
  handshake + 13 tools + `describe_app` round-trip + 403 on a bad token
  (L-e51c033d); real-Chromium hydration + dev-boot of the published scaffold
  green on ubuntu-latest (run `28768162073`, 6 passed / 1 flaky-retried-green /
  0 failed; leg-a hydration inherits the known click-race, filed). Evidence:
  `docs/readiness/hoisted-dev-hang-L-513dd8a6.md` addendum. Per the ratified
  "launch moves up if early" clause, **L1 detonation is now unblocked ~3 weeks
  ahead of the 07-24 trigger** — remaining pre-launch work is the non-gating
  L0-parallel list (brand, README hero, wedge screencast, launch post, quiet
  community channel, agent on-ramp, claims refresh). The standing pre-publish
  gate (L-e6a86c59) remains open and is now scoped to the REAL lesson: keep the
  preflight + real-install smoke blocking in release.yml, ports guarded by
  `assertFetchablePort` *(this supersedes the verdaccio-`needs:` framing in the
  amended launch-gate entry above)*.
- **2026-07-05 — 1.0 policy:** criteria-boxed (stability contract + deprecation
  policy, external audit, upgrade guides, LTS statement, readiness bar),
  targeted mid-2027, re-scoped at quarterly checkpoints rather than slipped
  silently. The criteria list is **frozen now**; adding or removing a criterion
  requires its own decision-log entry. The external audit is unfunded — price it
  by end of L2 so it can't ambush the mid-2027 target.
- **2026-07-10 — post-launch sequencing (`lesto.live` GA + priority order):** a
  two-lens review (opus red-team + opus chief-arch) then a fable chief-architect
  ruling settled four decisions the GA epic (`L-3c9f8069`) had left implicit.
  Ratified by the owner 2026-07-10. **(a) Post-launch priority: funnel
  follow-through → published benchmarks → `lesto.live` GA (a background hardening
  track, not a preemptor) → in-house OAuth AS (stays deferred per the same-day
  MA-track ruling).** `lesto.live` is the **L3** flagship (Dec 2026→mid-2027, §Phase
  L3), *not* L2 — it moves neither §0 primary metric directly (category-share is
  the monthly agent-demo + distribution; agent-activation is on-ramp + dev-MCP), so
  it feeds L3 rather than leading. **Two tripwires that legitimately reorder it:**
  DCR connect-failures in agent-activation telemetry pull the narrow DCR slice (not
  the whole AS) to #2; a credible framework-level local-first fast-follower pulls GA
  to #2 (moat depth is the §5-risk-3 defense and only defends if it's GA-first).
  **(b) The 3 Tier-4 packages publish as a labeled preview BATCHED into the first
  weekly release train after GA-3a** (the parameter-authz helper, the ADR's own
  "publish blocker") — no dedicated train (every train is a 49-package train
  anyway), no defer-to-GA (L3 design partners need something installable). **(c) An
  app-shell-precache service worker is IN GA scope** (ADR 0042 non-goal sharpened;
  distinct from the rejected SW sync engine) and adds criterion (d) to the
  messaging.md:82 claim-flip gate, so the unqualified "offline" headline is
  reachable rather than a permanent asterisk. **(d) The single-writer sync tier is
  positioned as database-side infrastructure** ("one process beside your Postgres;
  your app stays edge-native"; messaging.md §5/§8) to pre-empt the "not actually
  edge-native?" gotcha. No ratified ADR decision was reversed; all outcomes are
  bounded amendments (ADR 0042, messaging.md §5/§8, this entry) + board edges.
