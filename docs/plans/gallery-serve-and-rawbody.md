# Plan — close the gallery-review gaps: rawBody seam, hosted `serve.ts` legs, P1/P2 findings

Executes the four next-steps from the 2026-07-06 red-team + chief-architect review of
`examples/{cache,workflows,webhooks,forms}` (see `docs/plans/examples-gallery.md`
increment 5). Step 1 (commit the examples) is **DONE** (`3a15756`). This plan covers
steps 2–4 plus the hosted `serve.ts` legs.

Design decisions below were made by a chief-architect pass grounded in source; every
API is **additive/optional — no breaking change** to any shared package.

### Red-team revisions applied (2026-07-06, Opus review of this plan)
The plan was adversarially reviewed and these corrections are folded in below:
1. **rawBody is runtime-sound but its test strategy was a false-green.** Verified: the
   kernel forwards `options` by reference (`kernel.ts:306-326` — the throwaway request feeds
   only `runPipeline`; `next` re-passes the same `options`), and `Context` holds the request
   immutably (`handler-context.ts:47,61-63`), so `rawBody` reaches `c.req.rawBody`. BUT every
   planned unit test uses a fake `App`/`EdgeDispatch` stub — so a **runnable end-to-end test**
   is REQUIRED (Wave 2, via `toFetchHandler` — it exists, `cloudflare/src/fetch-handler.ts:703`).
2. **Kernel `App.handle` options type MUST gain `rawBody?`** (`kernel.ts:234` — an inline
   `{query?;headers?;body?}`, not `HandleOptions`). Type-only, no branch, zero coverage cost;
   without it the seam is type-lossy and a `server.test.ts` stub reading `options.rawBody` is TS2339.
3. **`verifyRequest` body parse must be crash-safe** (try/catch + object guard) and forward
   RESOLVED `now`/`toleranceMs`.
4. **forms:** the `Field` component is in `@lesto/forms` (NOT `@lesto/ui`) — no `@lesto/ui`
   change. The error `<span>` must emit `data-error` as its LAST attribute or the example's
   `errorsIn` regex breaks. `renderFormMarkup` options stay optional; the "values preserved"
   assertion must target a specific input (not a vacuous `value="…"`); the forms PACKAGE test
   must render through `@lesto/ui/server`, never assert the `UiNode` tree (props are validated
   only at render — a tree assertion is vacuous).
5. **serve.ts:** all four examples' `buildApp` return a bare `Lesto`, but `serve`/
   `serveWithGracefulShutdown` need a kernel `App` — each serve.ts MUST wrap with
   `createApp({ db, app: booted.app, … })`; forms (no DB) must `openSqlite` + `secure:false,
   durable:false`.

## Global constraints (every task)
- **100% vitest coverage** on every touched `@lesto/*` package (lines/branches/functions/
  statements). Run the SERIAL `scripts/coverage-gate.ts` per touched package — never
  parallel `--filter` + coverage (oversubscribes CPU, flakes; see `ci-coverage-gate`).
- **`exactOptionalPropertyTypes: true`** — assign every optional property with the
  spread-conditional idiom `...(x === undefined ? {} : { key: x })`, never `key: maybeUndef`.
- **Edge purity** — `@lesto/cloudflare` must stay node-free (no `@lesto/runtime` import).
- **Sandbox** blocks starting servers → `serve.ts` files are written + typechecked +
  oxlint/oxfmt-clean, but NOT run here; correctness is proven via `app.handle` /
  `renderToStaticMarkup` / the fetch handler, never a live server. Each `serve.ts` gets a
  manual run-verify note in its README.
- **Commits** per explicit path (never `git add -A` — the Studio daemon commits to main
  concurrently and there is pre-existing untracked cruft; see `shared-worktree-commit-trap`),
  in logical chunks, on `main`.
- **Dogfood** — after a finding lands, its owning example consumes the new API.

---

## Step 2 + 4 — framework changes (four independent package agents)

### A. rawBody seam — P0 (`@lesto/web` + `@lesto/runtime` + `@lesto/cloudflare`)
Expose the exact undecoded request bytes so a hosted HMAC receiver can verify a signature
(today `toLestoRequest`→`parseBody` JSON-decodes and discards the raw string).

**API (additive optional):**
- `packages/web/src/types.ts`: `HandleOptions.rawBody?: string` and `LestoRequest.rawBody?: string`.

**Populate on every transport:**
- `packages/runtime/src/request.ts` `toLestoRequest` (~:117): `...(input.body.length === 0 ? {} : { rawBody: input.body })` (matches `parseBody`'s empty→undefined). For non-JSON, rawBody === body; for JSON, raw string alongside the decoded object.
- `packages/runtime/src/server.ts` buffered dispatch (~:1739): forward `...(request.rawBody === undefined ? {} : { rawBody: request.rawBody })`. Streaming path (`body:""`) untouched.
- `packages/runtime/src/sites.ts` `RequestOptions` (~:36): add `readonly rawBody?: string;` (forwarded verbatim by `dispatchSites`).
- `packages/web/src/lesto.ts` `handle` request build (~:636): `...(options?.rawBody === undefined ? {} : { rawBody: options.rawBody })` — the in-process seam.
- `packages/cloudflare/src/fetch-handler.ts`: `EdgeRequestOptions` (+`rawBody?`), `Decoded` (+`rawBody?`), `decodeBody` sets `rawBody: text` on the JSON branch and the plain-text branch (empty arm → NO rawBody; 413/400 arms unchanged), `dispatchHardened` spreads it into `dispatch(...)`.

**Kernel — TYPE ONLY (revised):** add `rawBody?: string` to the inline `App.handle` options
type at `packages/kernel/src/kernel.ts:234`. This adds NO runtime branch (the kernel already
forwards `options` by reference to `config.app.handle`, `kernel.ts:306-326`) and NO coverage
cost, but makes the seam typed end-to-end (otherwise `server.test.ts` reading `options.rawBody`
is TS2339, and the seam silently drops on a future kernel refactor).

**Backward-compat:** purely additive optional fields; `body: unknown` unchanged; `EdgeRequestOptions` still assignable to `HandleOptions`. ~50 dependents keep compiling (confirmed nothing does exhaustive `Object.keys` over these).

**Coverage (all in-sandbox, no server):**
- `request.ts` (`@lesto/runtime`): JSON non-empty → `rawBody===raw` AND `body===parsed`; non-JSON non-empty → `rawBody===body`; empty → `rawBody` absent.
- `lesto.ts handle` (`@lesto/web`): `rawBody` option set → `c.req.rawBody` present; absent → undefined.
- `fetch-handler` decodeBody/dispatchHardened (`@lesto/cloudflare`): JSON / non-JSON / empty (NO rawBody) / 413 / 400.
- `server.ts`: POST forwards rawBody, GET (stream, `body:""`) → absent.
- **REQUIRED end-to-end test (Wave 2, the anti-false-green):** in `examples/webhooks/test`, build `createApp({ db, app })` (secure ON), wrap with `toFetchHandler`, POST a real signed `Request` with `content-type: application/json`, and assert the receiver route observed `c.req.rawBody === <the JSON string>` WHILE `c.req.body` was the parsed object, and `verifyRequest` passed. This is the only test that proves edge-decode → real kernel → `c.req.rawBody`; the in-process dogfood is VACUOUS for the seam (in-process `handle` never decodes, so `rawBody===body` there).

### B. `verifyRequest` helper — P1 (`@lesto/webhooks`)
Symmetric inbound helper (send side is turnkey; receive side is hand-rolled today).
**Wire reality:** the deliverer sends NO secret/endpoint id header, so "resolve secret by id" is infeasible — the helper takes the `secret` directly (receiver knows it out-of-band).

**API (`packages/webhooks/src/webhooks.ts`, exported via index):**
```ts
verifyRequest(
  input: { body: string; headers: Record<string, string | undefined> },
  options: { secret: string; toleranceMs?: number; now?: number },
): { verified: boolean; event?: string; reason?: VerifyFailureReason }
```
`VerifyFailureReason = "missing_signature" | "missing_timestamp" | "malformed_timestamp" | "stale_timestamp" | "signature_mismatch"`. Reads `SIGNATURE_HEADER`/`TIMESTAMP_HEADER`, does the explicit staleness check (needed to distinguish `stale_timestamp` from `signature_mismatch`, since `verify` folds stale into a bare `false`), then **delegates to the existing `verify`** (do NOT hand-roll HMAC/constant-time compare), forwarding the **RESOLVED** `now`/`toleranceMs` (its own `??` defaults, never a bare `undefined` — `exactOptionalPropertyTypes`).

**Body-parse must be crash-safe (revised):** on a verified body, `JSON.parse` inside `try/catch` (a signed non-JSON body → catch → `verified:true`, `event` undefined — do NOT throw), and guard `typeof parsed === "object" && parsed !== null && typeof parsed.event === "string"` before reading `.event` (a signed `"null"` or array must not throw). Return `event` from the SIGNED `{event,data}` payload (never the unsigned `x-lesto-event` header).

**Coverage:** each of the 5 reasons + verified-with-event + verified-non-JSON-body (event undefined, no throw) + verified-`null`-body (no throw) + toleranceMs/now default-vs-provided.

### C. `renderForm(spec, { errors, values })` — P1 (`@lesto/forms` only — the `Field` component lives in `packages/forms/src/components.tsx`, NOT `@lesto/ui`; no `@lesto/ui` change)
Thread per-field errors + prior values into the rendered form (today `Field` has no
error/value props, so a failed re-render can't show messages beside fields or keep input).

**API:** `renderForm(spec: FormSpec, options?: { errors?: Record<string,string>; values?: Record<string,unknown> }): UiNode`. `fieldNode` attaches (spread-conditional): `error` when a string; for checkbox `checked: Boolean(value)`, for all other types `value: String(value)` — when a prior value exists.

**`Field` component (`packages/forms/src/components.tsx`):**
- **MUST add to `Field.props` schema:** `error: { type: "string" }`, `value: { type: "string" }`, `checked: { type: "boolean", default: false }` — else `validateProps` DROPS unknown props (`@lesto/ui props.ts`) and the feature is a silent no-op (and a node-level test passes vacuously — assert at RENDERED-HTML level).
- Use React **`default*`** family (avoids controlled-input console warnings under `renderToStaticMarkup`): text/email/number → `defaultValue`; textarea → `defaultValue`; checkbox → `defaultChecked`; select → `defaultValue` on `<select>` (never `selected` on `<option>`).
- Render a non-empty error as the last child inside the `<label>`, with **`data-error` as the LAST attribute** so the example's `errorsIn` regex (`/data-error="[^"]*">([^<]*)</`) still matches: `createElement("span", { role: "alert", "data-error": name }, message)` → `<span role="alert" data-error="<name>">msg</span>` (text child ⇒ auto-escaped). Attribute order in `createElement` is load-bearing.

**Backward-compat:** `renderForm(spec)` (1-arg) produces byte-identical trees; new schema props optional. `renderFormMarkup`'s new options param MUST stay optional (the forms example's XSS test calls it 1-arg).

**Coverage — assert at RENDERED-HTML level via `@lesto/ui/server` `renderPage`/`renderToStaticMarkup`, NEVER by asserting the `UiNode` tree** (props are validated/stripped only at render → a tree assertion is vacuous): no-options (byte-identical) / errors-only / values-only / both; checkbox→checked vs others→value routing; per field type: value present→attr, textarea content, `<option … selected>`; error present→`<span … data-error>` escaped, absent→none; asBoolean/asString on absent props. The "values preserved" assertion must target a SPECIFIC field (e.g. the email input's `value="…"`), not a bare `value="…"` — the GET test already matches `value="pro"` on an `<option>`, so a bare check is vacuous.

### D. `ctx.runId` / `ctx.workflow` — P2 (`@lesto/workflows`)
`WorkflowContext` gains `readonly runId: string` and `readonly workflow: string` (`types.ts`);
`engine.ts` `#context(workflow, runId)` already has both in scope — add to the returned literal.
**Backward-compat:** the engine is the SOLE producer of `WorkflowContext` (verified — no test/example constructs one), so required fields are safe. **Coverage:** one workflow-body assertion `ctx.runId===runId && ctx.workflow===name`.

---

## Step 3 — hosted `serve.ts` legs (examples, independent)

Mirror `examples/mailing-lists/serve.ts` (node:http via `@lesto/runtime`'s
`serveWithGracefulShutdown`), one per example, each with a README run-verify runbook.
Written + typechecked + oxlint/oxfmt clean; NOT run here (sandbox blocks servers).

**REQUIRED wrap (revised):** each example's `buildApp` returns a bare `Lesto`, but
`serveWithGracefulShutdown`/`serve` need a kernel `App`. So each `serve.ts` must
`createApp({ db: handle, app: booted.app, … })` and serve THAT. cache/workflows/webhooks
already install their battery schema on the handle inside `buildApp` (createApp's durable
install is idempotent). **forms has no DB** but `createApp` requires one → forms `serve.ts`
must `openSqlite` a throwaway handle and pass `secure: false, durable: false`.
**Footnote:** on the node path an `application/json` request with INVALID JSON 400s in
`parseBody` before any handler runs, so a hosted receiver can only verify raw bytes of a
JSON-valid body — fine for real webhooks (which send valid JSON); note it in the webhooks README.
- **cache** — on FILE-backed SQLite so restart-persistence is clickable; env `PORT`.
- **workflows** — a curl execute→replay→resume runbook; injected short real sleep.
- **forms** — a browser posts the real urlencoded form and sees the re-render (dogfoods C).
- **webhooks** — real `node:http` inbound receiver reading `c.req.rawBody` + `verifyRequest`
  (depends on A+B); real outbound target for the loop. This is the leg the rawBody gap blocked.

Each example's `package.json` gains a `"serve"` script and `tsconfig` includes `serve.ts`.

---

## Step 4 (cont.) — dogfood the findings in the examples
- **webhooks example** (after A+B): `dispatchFetch` sets `rawBody: init.body`; `/incoming` reads `c.req.rawBody` + `verifyRequest(...)`; `postIncoming` test helper sets `rawBody`.
- **forms example** (in C): `renderFormMarkup(spec, { errors, values })`; POST passes submitted `values`; drop the hand-rolled `<ul data-errors>` summary; failed re-render preserves input + shows errors beside fields.
- **workflows example** (in D): read `ctx.runId` instead of threading `input.orderId`.

## Step 4 (cont.) — file P3s as tracked backlog
Add to `docs/plans/examples-gallery.md` (or each owning package's notes): cache hit/miss
metrics hook (`@lesto/cache`), read-only `Engine.stepsOf(runId)` (`@lesto/workflows`, matters
once a durable resume driver exists — deferred post-1.0), coded `validateSubmission` variant
(`@lesto/forms`). These are P3 — filed, not built.

---

## Implementation waves (Sonnet agents)
- **Wave 1 (parallel, worktree-isolated):** Agent A (rawBody, 3 pkgs), Agent B (verifyRequest,
  webhooks), Agent C (forms render + Field + forms example dogfood + forms `serve.ts`),
  Agent D (workflows ctx.runId + workflows example dogfood + workflows `serve.ts`).
  Also Agent E (cache `serve.ts` only — trivial, independent).
- **Wave 2 (after A+B integrate):** webhooks example dogfood (`/incoming`→rawBody+verifyRequest,
  `dispatchFetch`/`postIncoming` rawBody) + webhooks `serve.ts`.
- **Integration:** apply each agent's output serially on `main`, run per-package
  typecheck + serial coverage-gate + oxlint/oxfmt, then `examples:test`. Fix to the bar.
  Commit per explicit path in logical chunks (rawBody seam; each finding+dogfood; serve.ts batch).

## Risk list (from the architect pass — implementers MUST heed)
1. **UI prop-schema drop** — new `Field` props not added to `Field.props` ⇒ silently dropped ⇒ vacuous test. Assert at rendered-HTML level.
2. **exactOptionalPropertyTypes** — spread-conditional for every optional assign.
3. **Edge purity** — `fetch-handler.ts` stays node-free; empty-body arm carries NO `rawBody`.
4. **React controlled-input/select warnings** — use `default*`, not `value`/`checked`/`selected`; a warning can pollute/fail tests.
5. **WorkflowContext required fields** — safe only because the engine is the sole producer (re-verify before merge).
6. **~50 `@lesto/web` dependents** — additive-optional only; confirm nothing does exhaustive `Object.keys` over `HandleOptions`/`LestoRequest`.
7. **Example oracle coupling** — forms `errorsIn` regex needs `data-error="<field>"` with the message as immediate text; webhooks `dispatchFetch`+`postIncoming` must both pass `rawBody` or the dogfooded receiver 400s.
