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
      → does fronting it with `@lesto/ratelimit` feel natural, or sharp?).
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
   every later example copies. Wires `createMailingLists` (`@lesto/mailing-lists`)
   behind real `subscribe` / `confirm` / `unsubscribe` routes, **rate-limited per the
   package's own mandate**, with `@lesto/mail` (SMTP transport) beneath. Closes the
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
   `@lesto/web`/runtime follow-up. (2) FIXED — `createApp` gained a `schemas` install
   seam (`aed3893`). (3) FIXED — `SqlDatabase` unified across db/kernel/queue, casts
   gone (`aed3893`). Example workarounds dropped in `0d8fdc3`. All gated packages
   stayed 100%; `ws:typecheck` + `examples:test` green.

2. **`examples/admin`** — `[Wave 3 backlog]`
   A clickable admin panel (`@lesto/admin`, data #6) over a seeded table: paginated +
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
   `before` snapshot → diff auditing must re-read the row. (c) `@lesto/admin` is
   programmatic-only → every host re-hand-rolls the same 6-route HTTP shell + code→
   status table; a shippable opt-in `lesto()` admin sub-router would remove it. (d) no
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

   **Status (2026-07-06): four private-battery examples — LOCAL-DX DONE, hosted-UX
   (`serve.ts`) PENDING** — `examples/{cache,workflows,webhooks,forms}`, each wiring
   ONLY its battery's public API behind real HTTP routes, with a `run.ts` local-DX
   entry and an HTTP-boundary journey test (24 tests total, all green; `ws:typecheck`
   + oxlint + oxfmt clean; excluded from the coverage gate like estate/blog). These
   meet the **local-DX** half of the bar in full; **none ships the mandated hosted-UX
   `serve.ts` leg yet** (cache/workflows/forms are trivially serve-able — a scope cut;
   webhooks' hosted receiver is genuinely blocked on the `rawBody` dragon below). By
   the bar's `Done = both checklists green`, these are **not yet "done"** — the hosted
   leg is the remaining work. What each proves and the findings it fed back:
   - **`examples/cache`** (6 tests) — read-through hit/miss, single-flight coalescing
     of a concurrent herd, invalidation, TTL expiry (frozen clock), SQL-store
     persistence across a "restart", and `sweep` retention. *Finding:* hit/miss is not
     observable from `remember`'s return — a cache-level metrics hook would let a host
     track hit-rate without instrumenting the origin. → `@lesto/cache`.
   - **`examples/workflows`** (5 tests) — step memoization: execute-once, replay on
     re-post (no double-charge), and resume after a mid-run failure with the charge
     replayed not repeated; `sleep` injected; `onStep` trace over HTTP. *Findings:*
     (a) `WorkflowFn` gets no `ctx.runId`, so run identity is threaded through `input`;
     (b) no public read of the step journal (only the `onStep` sink). → `@lesto/workflows`.
   - **`examples/webhooks`** (7 tests) — signed, queue-retried, SSRF-guarded outbound
     delivery (secret held as a `secretId` reference) dispatched in-process to an
     inbound `verify()` receiver; rejects forged/replayed/unsigned inbound. *Finding
     (significant):* `@lesto/runtime`'s `toLestoRequest` JSON-decodes the body and
     discards the raw bytes, and `LestoRequest` exposes no `rawBody` — so HMAC
     verification of a JSON webhook is impossible on the deployed edge (re-stringify is
     fragile). The in-process leg works because `handle` passes the body verbatim; the
     **hosted-receiver leg is deferred** on a `rawBody` seam. → `core-runtime`/`@lesto/web`.
   - **`examples/forms`** (6 tests, no DB) — one `FormSpec` renders an HTML form
     (`@lesto/ui/server`) and validates the submission; re-renders per-field errors,
     records a valid signup, parses a real urlencoded body, and drops an unsafe
     `javascript:` action. *Finding:* `Field` takes no error/`value` props, so the
     invalid-submission round-trip (show the message next to the field, preserve input)
     is hand-rolled — a `renderForm(spec, { errors, values })` would fix it. → `@lesto/forms`.

   These are the QA proof that the four batteries hold at the app boundary; they are
   **built + covered but their packages remain `private:true`/unpublished** — the
   examples do not change that (see the launch claims-guardrail).

---

**Status (2026-06-16):** §7 reframed to this per-wave QA gate. **Increments 0, 1, 2
DONE** — workspace wiring (`87410bb`); `examples/mailing-lists` (`f3ac6af`) + its 3
findings fixed in the framework (`768ba0d`, `aed3893`) and its workarounds dropped
(`0d8fdc3`); `examples/admin` (`2527fe7`). The loop is working: each example both
proves a battery and feeds findings back. Next executable step is increment 3
(`examples/release-rollback`), then the increment 4 estate hosted-QA pass — plus
triaging the four `@lesto/admin` findings above into their owning plans.

**Update (2026-07-06):** increment 5 advanced — `examples/{cache,workflows,webhooks,
forms}` local-DX shipped (24 HTTP-boundary tests, all green; typecheck/oxlint/oxfmt
clean), each with DX findings routed to its owning package (see increment 5 above).
The most consequential is the missing `rawBody` seam surfaced by `examples/webhooks`,
which gates any hosted webhook receiver. Remaining long-tail batteries: `storage`,
`pubsub`, `rbac`, `openapi`, `pg`, `content-*`, `observability`, `i18n`, `seo`,
`feeds`, `cors`, `csrf`, `config`, `mcp` (plus `queue` — partially covered by
`examples/queue-dashboard`).

**Red-team + chief-architect review (2026-07-06, Opus):** one CRITICAL defect found
and FIXED — the `examples/webhooks` SSRF test was *vacuous* (both `outcome:"failed"`
and empty inbox held whether the guard blocked OR the dispatched fetch 404'd on a
non-existent path, so it would have shipped a removed/bypassed SSRF guard green — the
[[vacuous-negative-assertion-trap]] pattern). Fixed by recording every URL the
deliverer actually tries to connect to (`Booted.fetchAttempts`), pointing the blocked
URL at the *real* `/incoming` route, and asserting `fetchAttempts === []` (no
connection attempted). **Verified RED** with the guard bypassed before trusting the
green. The forms XSS test gained a positive control (a form *was* rendered). All other
positive/negative assertions were checked and confirmed non-vacuous (cache single-flight
is deterministic; workflows resume is proven by call-counts; the `rawBody` finding is
accurate). Two doc corrections: the "DONE" label was downgraded to "local-DX done,
hosted-`serve.ts` pending" (the bar requires both legs), and the `rawBody` blast radius
was scoped (inbound body-signature receivers only — NOT the auth stack or MCP transport).

**Next steps (sequenced, highest-leverage first):**
1. **Commit the work** — the four dirs are currently UNTRACKED and this plan edit is
   unstaged, so CI `examples:test` has not actually run them; the "24 green" is
   local-only. Stage per explicit path (the Studio daemon commits to main
   concurrently — never `git add -A`, see [[shared-worktree-commit-trap]]).
2. **Land the `rawBody` seam** in `@lesto/runtime` + `@lesto/web` (P0) — a real
   framework gap that blocks the entire inbound-webhook class (the canonical
   batteries-included use case). Then add `examples/webhooks/serve.ts` and click the
   hosted receiver leg. See [[rawbody-blocks-hosted-webhook-receiver]].
3. **Add `serve.ts`** to cache / workflows / forms (mirror `mailing-lists/serve.ts`)
   to close the mandated hosted-UX leg: cache on file-backed SQLite (restart
   persistence is clickable), workflows with a curl execute→replay→resume runbook,
   forms so a browser posts the real urlencoded body.
4. **File findings as work items**: forms `renderForm(spec, {errors, values})` (P1,
   highest user-facing DX), webhooks inbound `verifyRequest` helper (P1, ship WITH the
   rawBody fix), workflows `ctx.runId` (P2); batch the P3s (cache metrics hook,
   `Engine.stepsOf`, coded `validateSubmission`).

**Update (2026-07-06, cont.) — all four next-steps DONE.** Executed via a plan →
Opus red-team → Sonnet-implementers loop (plan: `docs/plans/gallery-serve-and-rawbody.md`):
1. ✅ Examples committed (`3a15756`).
2. ✅ **rawBody seam landed** (`5db59b6`) — `@lesto/web` `LestoRequest.rawBody`/`HandleOptions.rawBody`,
   populated by `@lesto/runtime` (node `toLestoRequest`/`server.ts`) + `@lesto/cloudflare`
   (edge `fetch-handler.ts`), typed on the kernel `App.handle`; additive, 100% coverage.
   **The [[rawbody-blocks-hosted-webhook-receiver]] dragon is RESOLVED.** `examples/webhooks`
   now verifies over `c.req.rawBody`, and `examples/webhooks/test/hosted.test.ts` proves the
   real edge→kernel→handle chain via `toFetchHandler` — **mutation-verified RED** when the
   seam is bypassed (not a false-green).
3. ✅ **serve.ts hosted legs** added to all four examples (`833c1e4`), each `createApp`-wrapped
   (forms is db-less → `secure:false, durable:false`). WRITTEN + typechecked + lint/format
   clean; **NOT run here** (sandbox blocks server starts) — the browser/curl click-through is
   the one remaining manual verify per example README.
4. ✅ **P1/P2 findings implemented + dogfooded:** forms `renderForm(spec,{errors,values})`
   (`0fbbb99`), webhooks `verifyRequest` (`704612d`), workflows `ctx.runId`/`workflow` (`1fc9db0`).
Full gate: `ws:typecheck` clean; serial coverage-gate **100%** across the 7 touched packages;
26 example tests green. (`ws:lint`/`ws:format:check` show a PRE-EXISTING `@lesto/cli`
`env-client.test.ts` `import()`-type failure — committed in `4f4fe05`, unrelated to this work.)

**P3 backlog (filed, not built):**
- `@lesto/cache` — a hit/miss metrics hook so a host can track hit-rate without instrumenting
  the origin (or `read`-before-`remember`, which loses single-flight).
- `@lesto/workflows` — a read-only `Engine.stepsOf(runId)` for run-level progress
  introspection; matters once a durable resume driver exists (deferred post-1.0).
- `@lesto/forms` — a coded `validateSubmission` variant (machine-branchable codes / multiple
  errors per field) for API clients.

**Hidden dragons / gotchas for the next agent:**
- **rawBody decode trap — RESOLVED 2026-07-06** (`5db59b6`). `toLestoRequest`→`parseBody`
  still `JSON.parse`s an `application/json` body, BUT `LestoRequest.rawBody`/`HandleOptions.rawBody`
  now carry the exact bytes (node + edge + in-process), so a hosted receiver verifies over
  `c.req.rawBody`. Historical note for context: `c.req.body` is still the DECODED value —
  never verify a signature over it (re-`JSON.stringify` drift breaks the HMAC); always use
  `rawBody`. See [[rawbody-blocks-hosted-webhook-receiver]].
- **In-process signature verification alone was a false-green for deployment** — now covered
  by `examples/webhooks/test/hosted.test.ts` (real edge→kernel path via `toFetchHandler`).
  Keep that test; it is the only guard against a rawBody-forwarding regression in-sandbox.
- **`maxAttempts:1` in `examples/webhooks`** disables retries — do NOT cite this example
  as proof of the queue's retry/backoff loop (that rests on `@lesto/queue`'s own tests).
- **workflows `sleep` is not memoized** — on resume the body re-runs every pass before
  the failed step, so a long pre-step sleep re-waits fully on each retry. Nothing
  re-invokes after a crash; resume is caller-driven (durable scheduler deferred post-1.0).
  There is also no public read of run-level progress (only `(runId,key)` step rows + the
  in-memory `onStep` trace).
- **`jsx: react-jsx` + DOM libs in tsconfig** — all four set it, but ONLY forms renders
  JSX. cache/workflows/webhooks need `jsx` set purely because importing `@lesto/web`
  transitively resolves `.tsx` modules; a bare `types:["node"]` tsconfig fails to
  typecheck. Copy the template's tsconfig; don't "clean up" the jsx line.
- **injected clock / sleep / resolver are load-bearing** — anyone "simplifying" cache
  TTL/sweep or workflow sleep back to the system clock reintroduces test flakiness.
- **private/unpublished + masked resolution** — these examples resolve on `bun install`
  ONLY because the whole `@lesto` scope is linked in-tree; that does NOT prove a
  standalone `npm i @lesto/cache` works (the four packages are `private:true`, not on
  npm — see [[batteries-built-not-published]], [[scaffold-e2e-masks-real-resolution]]).
  Examples do not change that; launch copy must not imply these are installable.
- **coverage-gate exclusion is implicit** — `scripts/coverage-gate.ts` globs `packages/*`;
  examples are excluded only by living under `examples/`. Examples ship no `test:cov`
  script. If the gate ever broadens its glob, these could be pulled into the 100% bar.
