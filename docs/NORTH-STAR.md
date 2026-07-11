# North star — the agent-operated app platform on Cloudflare

> **Ratified by the owner 2026-07-10** as the explicit ultimate goal across the
> three repos. This doc names the end-state; it changes no ratified decision and
> re-sequences nothing before the L1 launch. Companions: `ATTACK-PLAN-2026.md`
> (how the product wins), `ATTACK-PLAN-2027.md` (how the world finds out — now
> explicitly phase one of this), `~/src/FOUNDATION.md` (the operator + the
> engine↔brain protocol), `~/every-io/studio` (the engine). The honesty
> guardrail (`docs/brand/messaging.md` §5) is binding on every claim here.

---

## 1. The one sentence

**Conversation in, deployed production app out: the agent-operated app platform
on Cloudflare.** Vercel's version of this play is v0 + Next + eve on their
cloud. Ours is the operator + Studio + Lesto on Cloudflare's — and Cloudflare
has no first-party answer at either the framework or the builder layer.

## 2. The stack (what each repo is in this story)

| Layer | Repo | Role | Revenue shape |
|---|---|---|---|
| **The roof (operator's thin client)** | `~/src` | The conversation surface — type what you want, the operator drives the fleet. Per FOUNDATION.md §3 the operator *brain* is a server-side Studio pack; `~/src` is its thin native client | Seats |
| **Studio** | `~/every-io/studio` | The durable fleet engine — board, workflows, worktrees, approvals; "Inngest/Temporal for coding agents" | Engine + hosted "software factory" tier |
| **Lesto** | `~/crack` | The substrate the fleet builds *into* — agent-native batteries, governed MCP control plane, one trace browser→DB, `lesto.live` | Open-source wedge; the category |
| **Cloudflare** | — | Where it deploys — Workers/D1/R2/DO; the primitives without a coherent framework | The flagship target, not a dependency |

*Revenue shapes are per FOUNDATION.md §1 (authoritative — a fast-churning draft; this table does not restate its detail, to avoid drift).*

This is a naming of what already exists in the docs, not a pivot:
FOUNDATION.md §1 already states the commercial model (studio = engine + hosted
revenue, operator = seats) and lists the `@lesto` Cloudflare edge inside the
software-factory story; ATTACK-PLAN-2027 §1 already identifies "Cloudflare owns
our toolchain and sells adjacent primitives but not a coherent framework."

## 3. Why this wins (structural, not prompt engineering)

The Lovable-class builders (Lovable, v0, Bolt) generate
code but die at infrastructure integration — auth, DB, email, jobs, deploys are
synthesized from scratch into unstructured projects, per project, by prompt.
That is a **substrate problem, not a prompting problem**. Our answer:

- An agent writing into **Lesto** gets batteries with typed, governed,
  MCP-exposed surfaces — the framework is *designed to be operated by an agent*
  (the control plane, agent-readable docs, the one-shot activation metric).
- **Studio** supplies what that class lacks: a durable, reviewable, resumable
  orchestration engine instead of one model in a sandbox.
- **The operator** makes the fleet invisible: one input box, the thing being
  built beside it.
- Each layer is commoditizable alone. **The loop is the moat**: intent → durable
  fleet → governed framework → deployed on CF → observed (one trace) → iterated.
  Nobody else owns all four layers; Vercel is assembling the same loop from the
  other side (eve, open-sourced 2026-06-17), which is validation and the clock.

## 4. What this is NOT

- **Not buyer-bait.** A Cloudflare acquisition is a plausible *outcome* of being
  the framework + agent layer over their primitives; it is not the *plan*. We
  build the company; we embed in their ecosystem; their M&A appetite is not a
  roadmap input.
- **Not a launch re-plan.** The household-2027 sequence is unchanged; L1
  detonation fires as scheduled. This doc adds zero pre-launch scope.
- **Not consumer-first.** The wedge audience is developers-and-their-agents,
  then prosumers-with-agents. A Lovable-class *consumer* surface (hosted
  multi-tenant, web-based, untrusted-user code execution, billing/abuse) is the
  2027 revenue product, gated below — not a near-term build.
- **Not shipped** *(status as of 2026-07-10 — every fact below has a live source
  of truth elsewhere; do not trust this snapshot cold)*: Lesto is published and
  launch-ready; Studio runs local-first/BYO-model with the hosted tier explicitly
  deferred (GATE-0 = completed Studio board task `L-f8af4b22`); the roof's
  operator loop was **live-verified 2026-07-10 via the stopgap `OperatorKit`**
  (FOUNDATION.md §8), but the *server-side operator pack* — the decided placement
  (FOUNDATION.md §3), Phases A–C — is **unbuilt**. The platform sentence in §1 is
  a *goal*, not a claim — it appears in no external artifact until the demo in §5
  move 2 is real.

## 5. Sequencing (three moves, strictly ordered)

1. **Fire the Lesto launch** (ATTACK-PLAN-2027 L0→L1, unchanged). The
   agent-native category win is the distribution engine for everything above it.
2. **Make the monthly "an agent built this" ritual BE the combined demo**
   (`L-85abeda8`). The L2 demo *slot* already exists (priority #1, never shed);
   the *combined content* — a Studio fleet builds a real Lesto app and deploys it
   live to Cloudflare, streamed unedited — is the **one new integration
   deliverable**, not zero scope. Studio and Lesto don't talk today; the
   prerequisites (Studio dev-loop against a real git host, a deploy-to-CF workflow
   step, greenfield fleet operation, secrets-safe streaming) are enumerated on
   the task. Fallback so the never-shed ritual is never actually missed: run the
   single-agent L2 demo; the combined form graduates in only when runnable from
   shipped parts. Success is mechanical: dispatch → deployed URL with no human
   commits after the initial intent. Nobody else can run this.
3. **Hosted multi-tenant Studio = the platform's commercial surface (2027).**
   Reverses Studio's GATE-0 posture (local-first now, SaaS later). The
   falsifiable, dated tripwires are **owned on the Studio board** (`L-3fb731fb`),
   not defined here — this doc only points to them. Non-normative straw-man
   (refined there, not authoritative): Lesto Launch+30d checkpoint at on-track or
   above, the move-2 combined demo proven runnable from shipped parts for ≥2
   consecutive months, and the *server-side operator pack* (FOUNDATION Phases
   A–C, not the stopgap `OperatorKit`) driving a fleet end-to-end.

## 6. Re-examine conditions (so we can't lie to ourselves)

Inherited discipline from ATTACK-PLAN-2027 §0: below the red band at a
checkpoint → the strategy gets re-examined, not the effort doubled. Additional,
specific to this doc:

- If the combined demo (move 2) cannot be run monthly from shipped parts, the
  north star gets re-scoped at that quarter's checkpoint, in the ATTACK-PLAN-2027
  §6 log. "Cannot be run from shipped parts" is measured mechanically per the
  task: dispatch → deployed URL with **human commits after the initial intent >
  0** for two consecutive months. (The bar is on the *fleet* surface now; the
  stronger "the operator builds it" bar attaches to the server-side operator pack
  when it exists — move 3, not this condition.)
- If Cloudflare ships a first-party framework, the "neutral alternative one layer
  up" defense (ATTACK-PLAN-2027 §5, which already carries that trigger) governs.
  A framework *and* a builder additionally re-prices *this doc's* CF-flagship
  framing — that added clause is the north-star-specific trigger the §5 one does
  not cover.
- Capacity remains risk #1. The north star adds exactly one near-term
  deliverable (the combined demo, which was already committed in L2); anything
  more before L2 exits is scope creep and should be refused by default.

## 7. Tracking

Board epic **`L-b7ac4ea3`** `[north-star]` on the crack board, with children:
the combined demo (`L-85abeda8`, the one near-term deliverable), the
chief-architect ratification of this doc (`L-674a6391` — the wrap-up CA pass was
cut off, so it's owed), and CF-ecosystem embedding (`L-5b4ef476`). The
hosted-tier tripwire task lives on the **Studio** board (`L-3fb731fb`), which
owns the GATE-0 reversal conditions move 3 points to. Decision also recorded in
ATTACK-PLAN-2027 §6 (2026-07-10 north-star entry) and FOUNDATION.md's version
log.
