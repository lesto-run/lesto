# ADR 0048 — The agent-native frontend: a verification layer over React (causality · refusal · assertion), not a renderer of our own

- **Status:** Proposed (2026-08-17; revised 2026-08-17 after the adversarial pass;
  **re-scoped 2026-08-18** after a strategic pass on Solid 2.0 — see *Reviews*).
  Drafted by the frontend owner (Claude); ratification of the ADR as a whole is
  still outstanding.
  **Phase 0 is BUILT** (2026-08-18, `plans/028`–`030`, each independently correct
  and shippable on its own terms, each reviewed adversarially before landing).
  **Phase 1 — the verification layer — is the committed build-now** and is
  restructured by this revision into three tiers (causality, refusal, assertion)
  over the evidence Phase 0 already produces. Phase 2 (the a11y contract on the
  registry niche) and Phase 3 (conformance-as-tests) are designed here and gated
  on Phase 1. **Building our own reactive kernel is removed entirely**, and no
  replacement runtime is pre-selected; see *Deferred*. Phase 1
  inherits ADR 0032's **PREVIEW** posture wherever it touches the dev control
  plane, and says so.
- **Date:** 2026-08-17 (re-scoped 2026-08-18)
- **Deciders:** frontend owner (Claude) + tech lead + owner (ratification pending)
- **Builds on / touches:** **ADR 0011** (optimized-by-default pipeline — Increment 2
  ratified the `.page`/`defineIsland` path as **canonical** and demoted the
  Registry/`UiNode` walk to the AI-/DB-content niche; this ADR **honors that ruling**
  — the first draft inverted it and was corrected in review). ADR 0008 (pluggable
  server renderer — an **element-level serializer seam** over `ReactElement`s, per
  `render.tsx`'s `ServerRenderer`; this ADR no longer claims a new dialect can enter
  it unchanged). ADR 0007 (dialect swaps are per-app opt-ins with traps stated — and
  the source of this ADR's dev/prod divergence warning). ADR 0027 (reactive data —
  `QueryClient`'s core is React-free (`data-client.ts`: `subscribe`/`getSnapshot`/
  `registerTopics` take no React); the explicit-invalidation spine survives any
  renderer — verified in review; Phase 1A instruments exactly this spine).
  ADR 0031 (agent-observable runtime — **emits** spans to OTLP; it ships **no
  queryable span store**, ARCHITECTURE.md §7 — which is why Phase 0.2 committed one).
  ADR 0032 (dev-loop control plane — **PREVIEW**; its read tools exist only under
  `lesto dev` (`tools.ts` builds them only when handed a `devState` reader), which
  bounds verify's attach vs. boot modes). ADR 0034/0035 (describe_app pattern; the
  **shipped** eval discovery is a root `lesto.evals.ts` module (`cli/src/bin.ts`),
  not ADR 0035's designed-but-unimplemented `app/evals/` glob — Phase 1 mirrors the
  shipped shape). ADR 0037 (Tailwind/shadcn — the React component story this ADR now
  explicitly protects; see the new component-layer non-goal). ADR 0040/0042 +
  `@lesto/live` (`LiveQuery` is a framework-agnostic `{subscribe, getSnapshot}`
  handle — a second shipped reactive vocabulary Phase 1A must observe alongside
  `QueryClient`). `@lesto/e2e` (the Playwright harness — `dev-harness.ts`'s
  `spawnDev`/`waitForServer`/`killAndWait` encode the port-squatter false-green,
  blocked-port, and teardown-race lessons; `agent-activation.spec.ts` proves the
  MCP-client attach to a live `lesto dev`). `@lesto/bench` (owns SSR performance
  comparison — `createSsrWorkload` + `compareRuns`). **Plans 028–030** (the built
  Phase 0: the island `Disposer`, the dev trace ring, honest INP/CLS).

## Context

Lesto's backend is agent-native by construction: one substrate, coded errors,
injected clocks, a governed MCP control plane, 100% coverage. The frontend has two
authored surfaces, and being honest about which is which is the foundation of this
ADR (the first draft got it wrong):

- **The canonical surface** (ADR 0011 Increment 2): hand-authored React `.page`
  components + `defineIsland` islands. This is what estate, blog, www, and site
  ship. It never enters the Registry walk; `validateTree` has no build-gate
  consumer on it.
- **The niche surface**: the validated `UiNode` tree against the vetted Registry —
  the AI-generation and DB-driven-content path (`registry.ts`: "the AI proposes;
  the registry disposes"), plus `@lesto/forms`. Real and load-bearing for
  `generate_ui` and content blocks — and deliberately demoted for page authoring.

Three observations drive the design, ordered by leverage:

1. **An agent's failure mode is fluent-and-wrong, so the framework's job is to
   refute it.** This ADR's own first draft is the evidence: four independent
   reviewers found that its load-bearing claims were false, and every one was
   false for the same reason — it trusted design documents instead of the source
   tree. What separated the true claims from the false ones was not a better
   model; it was checkable ground (a comment in the source, a closed type union, a
   file that did or did not exist). A framework for agent-written code should
   maximize that ground.

2. **Solid 2.0 already demonstrates the properties, by construction — and we
   cannot and should not copy the mechanism.** A fine-grained runtime knows what
   re-runs because it built the graph; it can answer "what observes this signal"
   as a fact, and it can refuse a bad write with a named diagnostic. Those are
   exactly the agent-native properties. But Solid competes at the component layer,
   where React's position is strongest (libraries, design systems, hiring, and the
   training mass every model is built on), and it is losing there despite being
   technically better for this purpose. Cursor's reported Solid→React migration is
   that outcome in one data point. **A framework that asks a user to leave the
   React ecosystem inherits Solid's adoption problem.** Lesto will not.

3. **What Solid gets by construction, React can give by observation — and
   observation is runtime-agnostic.** We cannot make React's dependency graph a
   fact at author time. We can make what actually happened a fact at run time,
   captured at seams Lesto already owns: the island boundary, the `QueryClient`
   topic spine, the `LiveQuery` handle, the `Disposer` (plan 028), and the dev
   trace ring (plan 029). That trade buys a weaker guarantee — it holds only for
   paths a run executes — on an ecosystem that actually exists. And because it
   instruments Lesto's seams rather than React's internals, every part of it
   survives a future dialect unchanged.

What this is **not**: not a reversal of ADR 0011 (pages stay React), not a React
fork, not a component library, not a testing framework for arbitrary websites, and
not an ARIA modeling framework.

## The core idea: construction versus observation

**Solid answers "why did this re-run" because it built the graph. Lesto answers
"why did this re-render, why did it fail, and what did the server do" because it
recorded what happened. Construction gives guarantees at author time; observation
gives facts at run time. We build the second one, at seams we own, and we keep
React.**

Three tiers, in dependency order, over evidence Phase 0 already produces:

| Tier | Question it answers as a fact | Status |
|---|---|---|
| **Evidence** (Phase 0) | What did the server do? What did the browser measure? | **BUILT** — plans 028–030 |
| **1A · Causality** | Why did this region re-render? What invalidated it? | Build now |
| **1B · Refusal** | Which mistakes cannot reach a commit at all? | Build now |
| **1C · Assertion** | Does the running app still satisfy its stated properties? | Build now |

Each tier is independently useful. Causality pays off in the dev loop with no
tests written. Refusal pays off on the first `lesto dev` boot. Assertion is the
CI gate. None of them requires a new renderer, and none of them is wasted if one
ever arrives.

### Phase 0 — the evidence substrate (BUILT, 2026-08-18)

Three independent fixes, each landed with estate current in the same change
(CONVENTIONS.md) and its own adversarial review:

1. **The island dispose contract** (`plans/028`). `MountFn` returned `void` and both
   `reactMount` paths discarded their root handles (`hydrate.tsx`); soft
   navigation's swap was a bare `replaceChildren` (`softnav.ts`) that tore down
   nothing — so every soft nav orphaned React roots with live effects, and a
   `refetchInterval`/`onFocus`/`onReconnect` registration (`data-client.ts`) kept
   firing against detached DOM. `MountFn` now returns a `Disposer`; `hydrateIslands`
   retains it per container; soft nav disposes the replaced subtree first. This was
   a **live shipped defect**, and it is also the lifecycle hook tier 1A instruments.
2. **The bounded dev-only trace ring** (`plans/029`). There was no span store
   (ARCHITECTURE.md §7). The ring is keyed by `traceId`, retains server spans and
   browser-span receiver payloads together, and is readable over the dev control
   plane (same `devState` pattern, same PREVIEW label). Traces stopped being
   write-only. **This is the record every later tier writes into.**
3. **Honest web vitals** (`plans/030`). The RUM span labelled "INP" was the single
   `first-input` entry (the observer set lacked `event` timing), and no CLS
   summation existed — only per-shift scores ×1000. Now: true INP across the page
   lifetime, session-windowed CLS, both emitted at the page-hide flush, scaling
   documented, and the two doc drifts corrected (`browser-spans.ts`'s phantom CLS
   claim, public "INP" copy).

### Phase 1A — Causality: why did this region update? (committed build-now)

React does not expose a dependency graph. Lesto does not need it to: the updates
that matter for an agent-written app are the ones that cross a Lesto seam, and we
own every one of those seams.

1. **Boundary instrumentation (supported, no React internals).** In dev, each
   island mount/update/dispose records a **cause** into the trace ring: the island
   id and affordance, which declared props changed (shallow diff), which
   `QueryClient` key or topic invalidated it, which `LiveQuery` snapshot swapped,
   and the `traceId` in flight. This is the React answer to "what observes this" —
   not derived from a graph, but recorded from the invalidation spine ADR 0027
   already defines. It uses only Lesto's own APIs, so it carries no dependency on
   React internals and survives a dialect swap unchanged.
2. **A `why_did_this_update` dev tool.** Read-only, on the same control plane as
   `get_recent_requests`, keyed by island id or affordance, returning the recorded
   causes for the current session. The agent asks the running app instead of
   reasoning about the code — and gets the server spans on the same `traceId` from
   the ring, so "why did this re-render" and "what did the server do" are one
   query. **This is the differentiator no meta-framework ships**, and unlike the
   first draft's version of that claim, its producer now exists.
3. **Deeper per-component causality is optional, seamed, and best-effort.** React's
   own render-cause data lives behind `__REACT_DEVTOOLS_GLOBAL_HOOK__`, which is
   not a public API. If we surface it at all it goes behind an injected seam,
   dev-only, explicitly best-effort, and **nothing in 1A/1B/1C may depend on it** —
   tier 1A's contract is satisfied entirely by item 1. Stated so a future
   implementer does not quietly make an unstable hook load-bearing.
4. **One data-layer change taken from Solid 2.0, at no runtime cost.** Per-query
   pending state instead of a hand-written global loading flag: the `QueryClient`
   exposes `isPending(key)` and the island boundary treats "not ready" as a
   position, not a type an author null-checks. Suspense is the same idea; the point
   is that the framework decides it once so neither a human nor a model decides it
   wrong per component.

### Phase 1B — Refusal: make the bad way impossible, not discouraged (committed build-now)

React accepts almost anything and hopes. Lesto's whole engineering culture is the
opposite — coded errors, closed unions, deny-by-default — and that culture has
simply never been applied to the client runtime. A lint warning is advice a model
can ignore and a human disables; **a throw in dev is a wall, and a wall narrows the
action space.** That is the same reason the Registry narrows `generate_ui`, applied
one layer down.

Each of these is a coded `LestoError` thrown in development, silent in production,
with a documented escape where an escape is legitimate:

- **A write to state during render** inside an island.
- **A registration without teardown** — an effect that starts a timer, interval, or
  listener and returns no cleanup. Newly detectable because plan 028 gave the
  boundary a `Disposer`; this is the leak class that shipped for months.
- **A mutation that declares no invalidation topics** (`data-client.ts`) — silent
  staleness, ADR 0027's failure mode.
- **An interactive element with no accessible name**, checked against the rendered
  DOM at the island boundary — the enforcement point Phase 2 structurally cannot
  reach for `.page` JSX.
- **A duplicate DOM `id` across island instances**, and **a duplicate role+name in
  one scope** — both concrete estate failures the review found, and both fatal to
  tier 1C's targeting.
- **Ambient `Date.now()`/`Math.random()` in a render path** — a determinism warning
  first, per the staging rule below.

**Staging is mandatory.** Every rule ships warn-first behind a flag, in-repo
surfaces migrate, then the flip to throw lands in a named minor with a release
note. Rollback is reverting the flip. Dev-only by construction: the production
build must be byte-identical with the checks compiled out, or we reproduce ADR
0007's dev/prod divergence trap in the framework itself.

### Phase 1C — Assertion: `lesto verify` (committed build-now, two gated sub-items)

1. **Invariants: `lesto.invariants.ts` at the project root** — default-exporting the
   app's declared invariants, mirroring the **shipped** `lesto.evals.ts` /
   `lesto.sites.ts` shape (the first draft mirrored ADR 0035's designed-but-never-
   implemented glob; corrected). An invariant is a named, typed property: a
   **precondition** (seeded state via §3.4's seeding/transactional isolation, under
   the injected `Clock`), a **navigation intent**, and **assertions** phrased
   against affordances and the rendered accessibility tree and/or an authorized API
   read. An app with no invariants is not gated (the `lesto eval` opt-in floor,
   reused verbatim). Unlike `lesto eval`, this ships dogfooded: estate's
   `lesto.invariants.ts` lands in the same change.
2. **Affordance identity — the targeting substrate.** A stable, minted-once
   affordance id declared at the island/component (`affordance: "save-note.submit"`,
   emitted as `data-lesto-affordance`), plus a small helper for `.page` JSX. Never
   derived from position or copy (`useId` and tree paths are position-derived and
   were reviewed as unusable). Invariants **target** an affordance (optionally
   scoped within a landmark containing a named heading) and **assert** its role,
   accessible name, and state — so a copy rename or a button-to-menuitem refactor
   surfaces as an assertion diff, not a vanished target. The same id keys tier 1A's
   causality records, so one name addresses an affordance across all three tiers.
3. **The driver composes `@lesto/e2e` — it does not rebuild it.** Boot/teardown is
   `dev-harness.ts`'s `spawnDev`/`waitForServer`/`killAndWait`; the MCP attach is
   the proven `agent-activation.spec.ts` flow. Three modes, stated honestly:
   **attach** to a running `lesto dev` (full diagnostics, PREVIEW by inheritance
   from ADR 0032), **boot** via the harness (the same), and a **URL mode** against a
   deployed preview (HTTP readiness and browser-side evidence only, and its report
   says so). Decision logic (intent → affordance query → verdict) is pure and
   100%-covered; the Playwright/CDP edge is the injected, integration-tested impure
   seam. That edge has full DOM authority over the dev app: dev/CI only, never
   mounted by the kernel, ADR 0032's origin posture applies.
4. **Failure reports carry the whole record** — *unblocked by plan 029*. A failed
   invariant returns the assertion diff, the tier-1A causes for the affordance, and
   the server spans on the same `traceId` from the ring. Three tiers, one query.
5. **Budgets and vitals** — *budgets are opt-in wiring; vitals unblocked by plan 030*.
   Thread `budgetBytes` from config through the CLI's `buildClient`/`buildStyles`
   calls (today nothing passes it — "already exist" was true of the errors, false of
   any wiring). The scaffold ships **commented, suggested numbers**: present, one
   uncomment away, not default-on — the repo's shipped gate precedent (`lesto eval`)
   is opt-in-and-never-auto-fail, and a red build on day one of a new app is the
   wrong first experience. CI templates enable them. Vitals thresholds read the
   run's own RUM spans at `sampleRate: 1`.

**Committed vs gated:** 1A, 1B, and 1C items 1–4 are the committed layer. Item 5's
budget wiring is opt-in. Any capability a given mode cannot supply must be labeled
absent in the report, so a partial run never silently claims a full one.

### Phase 2 — the a11y contract on the niche the tree governs (gated on Phase 1)

Scope stated plainly: this contract binds the **registry vocabulary** — the
AI-generation path (`generate_ui`, PREVIEW), DB-driven content blocks, and
`@lesto/forms`. It does not and cannot bind hand-authored `.page` JSX; that surface
is covered by tier 1B's rendered-DOM refusal and tier 1C's assertions. (The first
draft claimed "an unlabeled button becomes a build failure" framework-wide; review
showed `validateTree` has no build-gate consumer and the canonical surface never
enters the walk. The honest claim: **the generation space excludes inaccessible
components, and the rendered app is checked by verify.**)

1. **The declaration.** Interactive `ComponentDef`s/`ClientComponentDef`s declare
   role and accessible-name source. Conditional-element components (ui-kit's
   `Button` renders `<a>` or `<button>` by `safeHref` verdict — the first component
   any audit meets) declare a closed role **set** plus one pure discriminant
   (`roles: ["link","button"], roleFrom: (props) => …`). A rejected `safeHref`
   surfaces as a coded validation warning instead of a silent role change.
2. **Enforcement where it is decidable.** (a) **Render-level conformance** (the
   binding check): each registered component is rendered with fixture props and the
   computed role/accessible name is asserted against its declaration — catching the
   declaration-vs-`render()` divergence a tree rule structurally cannot. Lives in
   the Phase 3 suite. (b) **Tree-level checks** stay narrow: a declared name-source
   prop must be present and non-empty. (c) **`treeJsonSchema`** carries the same
   constraint, narrowing the model-facing generation space.
3. **Staged rollout — the type is published lockstep.** New fields ship **optional**
   with warnings behind a flag; in-repo literals migrate (review counted ~10 ui-kit
   + 3 forms `ComponentDef` literals, 4 + 3 estate defs/islands, plus `defineIsland`
   literals in www/site/create-lesto/cli/assets); then the flip to required lands in
   a named minor with a release note. Rollback is reverting the flip. Stored DB
   trees are validated **at write**, grandfathered **at read**.

### Phase 3 — conformance as tests, not a package (gated on Phase 2 for the a11y tier)

1. **Home:** fixtures + comparators beside `validate.ts` in `@lesto/ui`, and a
   dialect leg in `@lesto/e2e` modeled on `island-bundler-parity.spec.ts`. No new
   package — the boundary added nothing and the real cost lives elsewhere:
2. **The priced cost is the aliased runner.** ADR 0008 states that driving the
   engine under Preact requires build-time `react`→`preact/compat` aliasing of the
   whole module graph — "a larger setup" a vitest file cannot do honestly. That
   runner **is** Phase 3's deliverable.
3. **Two oracle tiers, because semantic DOM cannot catch the marker trap.** A
   comment-erasing comparison passes the exact adjacent-text hydration bug ADR 0008
   exists for. So: **per-pair round trip** (render with dialect D, hydrate with D's
   client, assert zero recoverable errors and no DOM mutation) as the real oracle;
   **cross-dialect semantic equality** on the parsed DOM; and a **per-dialect marker
   contract**.
4. **The declared-normalization comparator** — framework-owned nodes (the soft-nav
   announcer) excluded, comparison on parsed DOM after `allReady`, canonicalized
   attribute order. DOM equality up to declared normalization is the honest law;
   byte-for-byte was reviewed as over-strong even for a clean-room renderer.

## Non-goals

- **Lesto never competes at the component layer.** We do not ship a component
  library, a reactive kernel, or a rendering runtime of our own. React is the
  default dialect and the shadcn story (ADR 0037) is protected. Asking a user to
  leave the React ecosystem would import the exact adoption problem that is beating
  a technically better renderer.
- **Not a reversal of ADR 0011.** Pages are React `.page` components; the tree is
  the generation/content/forms niche.
- **Not a testing framework for arbitrary websites.** Verify verifies Lesto apps
  through Lesto's contracts. (Whether the verification layer is later extractable
  as a standalone product is a **distribution decision recorded as open**, not a
  design constraint here.)
- **Not an ARIA modeling framework.** Role set + one discriminant + name source is
  the ceiling of the declaration shape.
- **Not schema-inferred invariants.** Declared explicitly, per the ADR 0027 lesson.
- **No dependency on React internals in any committed tier.** Phase 1A item 3 is
  optional and best-effort by construction.
- **No unqualified comparative claims.** Any "no meta-framework ships this"
  phrasing goes through the messaging claims guardrail. No performance claims for
  any dialect without `@lesto/bench` numbers on shared fixtures.

## Deferred — recorded, not scheduled; each gated on a named consumer

- **A fine-grained dialect — not built, and not pre-chosen.** Building
  `@lesto/signals` is **removed from this ADR**. A reactive kernel is a solved
  primitive; hand-rolling one is a maintenance bill for no gain. **Gate:** one real
  application on the registry-tree path whose measured React client cost or
  hydration behavior is the blocker. **If it fires, it gets its own ADR with its own
  evidence** — this one does not pre-select a runtime, and nothing here should be
  read as a recommendation for any particular one. The remaining cost is recorded so
  it is never under-priced again: a tree→markup dialect seam *above* ADR 0008's
  element serializer; dialect-parameterized component definitions (`render` returns
  `ReactElement` today); a client authoring model for events, local state, effects,
  and focus; a signal-state serialization channel alongside ADR 0012's inline props;
  and a decided relationship to `QueryClient` and `LiveQuery`. Adopting an existing
  runtime would remove the kernel half of that bill, not the rest. Naming: the
  tracked `loom/` prototype is "an AI-native **React** rendering engine" — a
  different thing that shares the name; any future dialect ADR must resolve the
  collision.
- **The UI contract in `describe_app`** — gated on an agent workflow that
  demonstrably fails for want of the UI vocabulary.
- **Model-based state-space walking** — gated on invariants + driver being real and
  an app declaring a state chart worth walking.
- **Visual regression on conformance fixtures** — gated on the suite existing.
- **Verify against deployed previews with full diagnostics** — URL mode ships
  reduced; full parity is gated on a production-safe control-plane story ADR 0032
  explicitly does not provide.

## Open decision (owner's call, does not block Phase 1)

**Does the verification layer run on any app, or only on Lesto apps?** Standalone
maximizes distribution — it is the only part of Lesto a stranger would try on a
Friday, and it would pull users toward the framework. Lesto-only maximizes
coherence and keeps the value inside the product. Tiers 1A and 1B are seam-bound and
therefore Lesto-only by nature; tier 1C is not. Recording the question because the
answer changes packaging, not design.

## Reviews

- **Independent adversarial pass (2026-08-17) — 4 lanes (correctness &
  completeness · chief architect/simplicity · sequencing/rollback ·
  frontend-domain) + 3 validation lanes, all read-only, fleet-orchestrated;
  ~35 candidates reconciled, every P0/P1 either multi-lane-derived + lead-verified
  or validated by a fresh isolated validator.** All applied:
  - *(P0, premise)* The draft asserted the tree+registry was the canonical authored
    surface. ADR 0011 Increment 2 ratified the opposite; `render.tsx`'s own scope
    note and `examples/blog` confirm. → Re-scoped.
  - *(P0, cost model)* "A new dialect enters ADR 0008's seam as a third matched
    pair" was false: the seam serializes `ReactElement`s, the dialect union is
    closed, `render-page` forks only on `preact`, islands are React
    `ComponentType`s, and the registry vocabulary has zero interactive components.
    → Dialect deferred with its true scope recorded.
  - *(P0, phantom substrate)* "Verify reads its own trace" assumed a queryable span
    store that ADR 0031/0032 do not ship. → Committed as Phase 0.2; now BUILT.
  - *(P1, validated)* RUM's "INP" was first-input-only and CLS was never summed. →
    Phase 0.3; now BUILT.
  - *(P1, validated)* The dispose gap was a live shipped leak. → Phase 0.1; now
    BUILT, and now also tier 1B's detection hook.
  - *(P1)* Reuse corrections: compose `@lesto/e2e`'s harness; mirror the **shipped**
    `lesto.evals.ts` shape, not ADR 0035's unimplemented glob; `@lesto/bench` owns
    perf comparison; `@lesto/live` + `QueryClient` are two shipped reactive
    vocabularies (now both instrumented by tier 1A).
  - *(P1)* Targeting: role+name alone is insufficient (estate's unnamed `article`
    cards; duplicate island interior ids) and accessible names are copy. →
    Affordance identity; role/name became assertions, not addresses.
  - *(P1)* Phase discipline: PREVIEW inheritance labeled; committed-vs-gated stated;
    budgets opt-in per the `lesto eval` precedent; the a11y type change staged
    against the lockstep-published union.
  - *(P2)* Conformance re-shaped: no new package; the aliased runner priced; the
    round-trip hydration oracle added; determinism restated as DOM-equality up to
    declared normalization.
  - *(Refuted, recorded)* Mount-script JSON key order is declaration-ordered, not
    loader-ordered; verify's standalone value was challenged and **survived**;
    ADR 0027's rebind-compatibility claim survived.
- **Strategic pass on Solid 2.0 (2026-08-18) — this revision.** Prompted by the
  question of whether Solid 2.0 is simply the answer to what this ADR proposes.
  Conclusions, applied above:
  - **Solid answers a different layer**, and it is losing at the layer it competes
    on for reasons unrelated to its quality. Lesto competes where React has no
    incumbent (the hard parts) and must not move to the component layer. → New
    non-goal.
  - **Building a reactive kernel is now a mistake, not merely a deferral** — it is
    a solved primitive, and hand-rolling one buys nothing. → `@lesto/signals`
    removed; if the gate ever fires it gets its own ADR, and this one pre-selects
    no runtime.
  - **The properties are reachable on React by observation rather than
    construction**, at seams Lesto owns, and observation is runtime-agnostic. →
    Phase 1 restructured into causality / refusal / assertion.
  - **The honest cost of that trade is recorded**: observation proves only what a
    run executed, so coverage becomes the guarantee; React internals are not a
    public API, so nothing committed may depend on them; and instrumented dev
    builds must not diverge from production (ADR 0007's trap).
  - **One tension named, against this session's own earlier reasoning:** Solid is
    better for an agent that *reasons* about code, React is better for an agent that
    *writes* it, because the training mass is there. Our primary use case is agents
    writing app code. That fact favors React and had been under-weighted.
- Pre-existing defects surfaced by the pass, tracked outside this ADR: the
  `browser-spans.ts` CLS doc claim and public "INP" copy (both fixed by plan 030),
  and ADR 0037's stale status header (its Phase-2 scaffold half has landed).

## Consequences

- Lesto gets a differentiator that is **additive to React instead of substitutive**:
  an app that answers why a region updated, refuses the mistakes React tolerates,
  and asserts its own invariants against the running system — with server spans
  attached to every failure. Nobody has to leave anything to adopt it.
- The three tiers share one addressing scheme (the affordance id) and one record
  (the trace ring), so a single question — "why did this fail?" — is answered
  across browser, framework, and database in one query.
- The reactive-kernel ambition is **retired rather than parked**. If the demand ever
  arrives we adopt a maintained runtime instead of writing one, and the remaining
  seam cost is written down so it is priced honestly.
- Everything committed here is seam-bound, not React-internal, so a future dialect
  inherits the whole verification layer unchanged. Deferring the renderer costs us
  nothing in this direction.
- Cost, stated: observation guarantees only exercised paths; the refusal tier adds
  a staged breaking change per rule and a hard dev/prod parity obligation; the
  browser edge has full DOM authority over the dev app (dev/CI only); and the
  affordance discipline adds one declared id per interactive region.
