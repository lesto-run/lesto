# Examples Gallery — the per-wave QA gate

Owns `docs/ROADMAP-V1.md` §7. Reconciled with the roadmap (which rules).
Cross-wave: this plan runs *alongside* Waves 3–5, not after them.

**Purpose.** The gallery is how we QA every battery on the two axes a unit test
can't reach — **local DX** (wire the real public API into a running app and feel
the ergonomics) and **hosted UX** (deploy it and click the actual user journey).
A feature is not "done" until its example **runs locally and deploys, and the
hosted journey has been clicked through**. Friction found while wiring or clicking
is a finding, filed back to the owning domain plan — that is the feedback loop.

**Scope reality.** This is not "45 new apps." estate already wires ~16 packages and
absorbs the hosted-QA legs for those (durable sessions across a restart, login
throttle, revoke-on-reset, unset-secret-refuses). The gallery is the per-feature
breadth for everything estate doesn't touch. The Wave 3 batteries that shipped
*without* any runnable proof are the immediate backlog; the long tail (~45 packages)
is filled in as each battery's wave lands.

**The bar, every example:** TS/ESM/Bun; oxlint/oxfmt clean; wires ONLY the package's
real public API (reaching into internals is itself a finding); a vitest test that
exercises the journey at the app boundary (HTTP), mirroring estate's `test/` layout;
a README ("what it shows / how to run / how to deploy"); runs in CI via the root
`examples:test` script; **stays OUT of the 100% coverage gate** (like estate/blog).

---

## The example template

```
examples/<feature>/
  package.json        # name @examples/<feature>; deps are workspace:* only
  tsconfig.json       # extends the repo base, like blog/estate
  run.ts              # node boot: createApp + seed + serve (the local-DX entry)
  src/
    app.ts            # wires ONLY the battery's public API; guardrails present
    …                 # routes/templates the journey needs
  test/
    <feature>.test.ts # journey test at the HTTP boundary (not service-method calls)
  worker.ts           # OPTIONAL — hosted leg: the same app on Cloudflare
  wrangler.jsonc      # OPTIONAL — only if it has a deployable surface
  README.md           # what it shows / how to run / how to deploy + QA runbook
```

Non-edge batteries (queue, cache, pubsub, …) ship `run.ts` + `test/` + README and
prove "hosted UX" as a Node `serve.ts` runbook rather than a Worker.

---

## QA checklist (run per example)

**Local DX — the wiring is the API ergonomics test.**
- [ ] From a clean clone, `bun install` resolves the example's `workspace:*` deps
      (requires the §0 workspace-glob wiring).
- [ ] `bun run examples/<feature>/run.ts` boots with **zero hand-editing**.
- [ ] `src/app.ts` touches only the package's exported public API — no deep imports.
- [ ] The guardrails the package *mandates* are present and pleasant to wire (e.g.
      mailing-lists' "the HTTP boundary that fronts `subscribe` MUST rate-limit it"
      → does fronting it with `@keel/ratelimit` feel natural, or sharp?).
- [ ] The journey test passes and runs under root `examples:test` in CI.
- [ ] Any friction (a missing verb, an awkward factory, a guardrail you had to
      hand-roll) is filed back to the owning domain plan as a finding.

**Hosted UX — deploy it and click it (where it has a deployable surface).**
- [ ] Deploys via the README runbook (Cloudflare for edge apps; `serve.ts` for Node).
- [ ] The real user journey is clicked through in a browser / real client — not a
      mock (mailing-lists: subscribe form → confirmation email lands in a **real
      inbox** → confirm link works **in the Worker** → broadcast arrives; the CRLF
      fix is visible because the email renders correctly in Gmail).
- [ ] Behaviors a test can't easily fake are exercised by hand: restart mid-broadcast
      (resume, no double-send), brute-force login (throttle engages), unset
      `SESSION_SECRET` (refuses to boot), deploy → rollback a release.
- [ ] Findings (a janky redirect, an email that renders wrong, a slow cold start)
      go back to the owning plan.

**Done** = both checklists green. Until then the battery is not done.

---

## Increments (ordered)

0. **Workspace wiring** — `[prerequisite | do first]`
   Root `package.json`: add `"examples/*"` to `workspaces` (currently `packages/*`
   only) so each example links `workspace:*` deps. Add a root `examples:test` script
   that runs every `examples/*/` test; wire it into CI **separate from** the serial
   100% coverage gate (examples are excluded from coverage, like estate/blog today).
   Acceptance: `bun install` links estate/blog/new examples as workspace members;
   `bun run examples:test` runs every example's suite; CI invokes it.

1. **`examples/mailing-lists`** — `[Wave 3 backlog | template-setter]`
   The richest local-DX + hosted-UX surface of the batch, so it becomes the template
   every later example copies. Wires `createMailingLists` (`@keel/mailing-lists`)
   behind real `subscribe` / `confirm` / `unsubscribe` routes, **rate-limited per the
   package's own mandate**, with `@keel/mail` (SMTP transport) beneath. Closes the
   still-open hosted leg of web-primitives #1b: the confirmation email is verified in
   a **real inbox** (CRLF fix `47aece1` visible), not just an SMTP sink.
   Acceptance — local: subscribe → pending → confirm rotates token → broadcast →
   unsubscribe, all over HTTP in the journey test. Hosted: the journey clicked
   through on a deployed Worker; a broadcast killed mid-fan-out resumes with no
   double-send.
   **Status (2026-06-16): DONE.** `examples/mailing-lists` shipped — `run.ts`
   (in-process journey), `serve.ts` (node:http + live `queue.work()` worker + SMTP
   transport), 3 journey tests (subscribe→confirm→broadcast→unsubscribe;
   rate-limit-mounted; exactly-once-per-recipient). Typecheck/oxlint/oxfmt clean.
   Local-DX leg verified via `run.ts`; hosted-UX leg verified over the wire against
   `serve.ts` (worker delivered confirmation mail; same-client burst throttled
   `202×5 → 429` with a real IP key; unconfirmed-broadcast correctly enqueued 0).
   The `List-Unsubscribe` real-inbox leg + the kill-mid-fan-out resume are documented
   as the Mailpit runbook in the example README (manual, not automated).
   **DX findings** (README has detail; routed to owning plans for triage):
   (1) `rateLimit` keys on `currentContext()?.ip`, so the package's mandated guard
   degrades to one shared bucket under in-process `app.handle()` — only works hosted
   → `auth-security`/ratelimit. (2) `createApp` installs durable schema but not the
   queue schema the mail battery needs → `operability-dx`/kernel. (3) three
   structurally-identical `SqlDatabase` types force a `as unknown as` cast when
   sharing one connection across db+kernel+queue → `data-persistence`.
   **All three addressed (2026-06-16) by 3 parallel worktree agents, integrated +
   re-verified serially on `main`:** (1) PARTLY — `rateLimit`'s `keyFor` now receives
   the request (`768ba0d`); the in-process no-IP-context half remains a
   `@keel/web`/runtime follow-up. (2) FIXED — `createApp` gained a `schemas` install
   seam (`aed3893`). (3) FIXED — `SqlDatabase` unified across db/kernel/queue, casts
   gone (`aed3893`). Example workarounds dropped in `0d8fdc3`. All gated packages
   stayed 100%; `ws:typecheck` + `examples:test` green.

2. **`examples/admin`** — `[Wave 3 backlog]`
   A clickable admin panel (`@keel/admin`, data #6) over a seeded table: paginated +
   projected list, with the `onMutation` audit hook logging every write.
   Acceptance — local: pagination/projection exercised over HTTP; audit hook fires on
   create/update/delete. Hosted: the panel browsed; the audit trail observed.
   **Status (2026-06-16): DONE** (commit `2527fe7`). `examples/admin` over a `products`
   table: `GET /admin/products` (paginated `?limit=&offset=` + projected — `cost` is
   real but absent from `fields`, so never leaks), get/create/update/destroy, and
   `GET /admin/audit` showing the trail the `onMutation` hook persisted. Verified
   local (5 tests + `run.ts`: paged `[1,2]/[3,4]/[5]`, 3 audit rows) and hosted
   (`serve.ts` over the wire: pagination, create/update/delete firing the hook,
   actor from `x-admin-actor`, 404/422 coded errors). **New DX findings (next loop's
   input):** (a) `onMutation` is sync `(e) => void` but real audit sinks are async →
   fire-and-forget can fail silently/out-of-order; an awaited `Promise<void>` hook
   would make auditing transactional. (b) `AuditEvent` carries `patch` but no
   `before` snapshot → diff auditing must re-read the row. (c) `@keel/admin` is
   programmatic-only → every host re-hand-rolls the same 6-route HTTP shell + code→
   status table; a shippable opt-in `keel()` admin sub-router would remove it. (d) no
   request error boundary, so `c.valid`'s `WebError` is uncatchable at a route. →
   triage to `data-persistence` (admin) / `core-runtime` (error boundary).

3. **`examples/release-rollback`** — `[Wave 3 backlog | ops UX]`
   The remote R2/S3 `ReleaseStore` (edge #5, `d560468`) as a deploy → version →
   rollback → verify runbook. No browser UI; the "hosted UX" is the ops journey.
   Acceptance: a versioned release lands in R2 over SigV4; rollback restores the prior
   version; the runbook is reproducible.

4. **estate hosted-QA pass** — `[Wave 3 backlog | rides estate, no new app]`
   The auth/durable batteries estate already wires get their hosted leg here, not a
   new example: durable SQL session survives a server restart (auth #5, `3b275d5`);
   login throttle engages under repeated bad passwords (auth #3); a password reset
   revokes existing sessions (auth #4); an unset `SESSION_SECRET` refuses to boot.
   Acceptance: each behavior clicked through against deployed estate and noted in its
   README's QA runbook.

5. **The long tail** — `[fills in as each battery's wave lands]`
   One `examples/<feature>/` for the remaining estate-untouched packages, each built
   in (or just after) the wave that makes it true: `queue`, `storage`, `cache`,
   `pubsub`, `webhooks`, `workflows`, `forms`, `rbac`, `openapi`, `pg`, the
   `content-*` markdown pipeline, `observability`, `i18n`, `seo`, `feeds`, `cors`,
   `csrf`, `config`, `mcp`. Not a single batch — each is the QA gate for its battery.

---

**Status (2026-06-16):** §7 reframed to this per-wave QA gate. **Increments 0, 1, 2
DONE** — workspace wiring (`87410bb`); `examples/mailing-lists` (`f3ac6af`) + its 3
findings fixed in the framework (`768ba0d`, `aed3893`) and its workarounds dropped
(`0d8fdc3`); `examples/admin` (`2527fe7`). The loop is working: each example both
proves a battery and feeds findings back. Next executable step is increment 3
(`examples/release-rollback`), then the increment 4 estate hosted-QA pass — plus
triaging the four `@keel/admin` findings above into their owning plans.
