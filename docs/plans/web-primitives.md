# Comms, SEO & Web Primitives — v1 plan

Derived from `docs/reviews/web-primitives.md`, reconciled with `docs/ROADMAP-V1.md` (which rules).
Packages: `@keel/mail`, `@keel/mailing-lists`, `@keel/feeds`, `@keel/seo`, `@keel/i18n`.
This plan **owns launch blocker #10** (no MailTransport) — identity's verify/reset flows and
mailing-lists' entire purpose dead-end at an interface until item 1 lands.

**The bar, every increment:** TS/ESM/Bun; oxlint/oxfmt clean; 100% vitest coverage on touched
packages; `bun run ws:typecheck` + the serial coverage gate green; coded errors; truthful doc
comments; one conventional commit on `main`.

## Increments (ordered)

1. **Ship real transports** — `[Wave 3 | P0 | blocker #10]`
   New: `@keel/mail-smtp` (Node — minimal SMTP client, STARTTLS, auth) and a fetch-based provider transport (Resend/SES-API-shaped) that runs on Workers. Closure-factory style, injected config, coded errors (`MAIL_TRANSPORT_*`).
   Acceptance: integration test delivering through a local SMTP sink (e.g. a test container in CI); the fetch transport pinned against recorded provider fixtures and proven Workers-compatible (no node builtins); identity's verify/reset journey sends a real email end-to-end in `packages/integration`.
   **Status (2026-06-16):** transports shipped **inside `@keel/mail`** (`smtp.ts` + `provider.ts`, not a separate `@keel/mail-smtp` package — the plan's name drifted), unit-tested with mocked sockets/fetch at 100% (commit `23b0e19`; SMTP multipart blank-line fix `2db7e9d`). The **integration leg** (real SMTP-sink test + identity verify/reset journey in `packages/integration`) is still open → tracked as **#1b (`L-dc382664`)**.

2. **Harden the Mailer contract** — `[Wave 3 | P1 | same wave, before any transport ships traffic]`
   Files: `packages/mail/src/mailer.ts` — reject `\r`/`\n` in `to`/`subject`/`from` (and all future header values) with coded `MAIL_INVALID_ADDRESS`/`MAIL_INVALID_HEADER` at both define-build and `deliver`; add `text?` and `headers?: Record<string, string>` to `Email`/`RenderedEmail`; pass a stable job-derived `messageId` so idempotent providers can dedupe; document at-least-once semantics on `MailTransport`; treat `MAIL_UNKNOWN_MAILER` as parked-not-retried (deploy-skew safety).
   Acceptance: CRLF injection fixtures refused at both seams; multipart text+html renders; headers validated.
   **Status (2026-06-16): DONE — delivered by #1.** The CRLF guards (at `deliver` + transport edge), `text`/`headers`, `messageId`, at-least-once docs, and parked unknown-mailer all shipped in commits `23b0e19`/`2db7e9d`/`be4fd77`, 100% covered. (`List-Unsubscribe` from this task's title is item 4's scope, not item 2's.) Task `L-bd5b3e5e` closed as done-by-#1.

3. **Finish double-opt-in** — `[Wave 3 | P1]`
   Files: `packages/mailing-lists/src/mailing-lists.ts`, `models.ts` — `subscribe` accepts a configured `confirmationMailer` (`{ name, confirmUrl(token) }`) and enqueues the confirmation email; rotate the token on `confirm` (or split `confirmToken`/`unsubscribeToken`); email shape validation; upsert on a new `UNIQUE (list_id, email)` index; `UNIQUE` index on `token` and composite `(list_id, status)` in the migration (fixes the full-scan P2s in the same DDL change); document that the HTTP boundary must rate-limit subscribe.
   Acceptance: subscribe → confirmation email enqueued → confirm rotates the token → broadcast reaches exactly-once-per-address; duplicate subscribe is an upsert, not a duplicate row.

4. **Resumable broadcasts + deliverability** — `[Wave 3 | P1]`
   Files: `packages/mailing-lists` — a `broadcasts` table + per-recipient delivery rows so a crashed broadcast resumes instead of double-sending; chunked enqueue inside a transaction; `List-Unsubscribe`/`List-Unsubscribe-Post` headers set automatically (rides item 2's `headers` support — Gmail/Yahoo bulk-sender requirement); `broadcast` returns `{ broadcastId, enqueued }`.
   Acceptance: kill-and-rerun a broadcast mid-fan-out → no recipient receives twice; headers present on every broadcast email; 100k-recipient enqueue is batched, not 100k serial round trips.

5. **Delivery observability** — `[Wave 4 | P1]` (seams owned here; OTLP wiring → operability-dx item 3)
   Files: `packages/mail/src/mailer.ts` — `onDelivered`/`onFailed` hooks carrying mailer name, job id, attempt (never recipient body); one span per broadcast; i18n `onMissing(locale, key)` counter.
   Acceptance: "did the password reset go out?" is answerable from the hooks in the integration test.

6. **Correct i18n pluralization** — `[Wave 5 | P1]`
   Files: `packages/i18n/src/i18n.ts:73` — replace `count === 1` with `Intl.PluralRules` (zero-dep, Node + Workers) keyed by locale, category-suffixed keys (`zero/one/two/few/many/other`) with `other` fallback; document "output is plain text; escape at the render layer" in `interpolate.ts`'s header.
   Acceptance: fr (0 singular), ru/pl (few/many), ar (six categories) fixtures correct; English behavior unchanged for existing catalogs.

7. **Spec-tighten feeds & seo** — `[Wave 5 | P2]` (one PR)
   Require RSS channel `<description>` and Atom `id`/`updated` in the types (or synthesize defaults); accept `Date` inputs and format RFC 822 / RFC 3339; strip/reject `\r\n` and `#` in robots.txt paths and the sitemap URL.
   Acceptance: the "valid RSS 2.0 / Atom 1.0" docstrings become true; a `\n`-bearing Disallow path is refused.

## Shipped beyond the plan

- **react-email rendering support** — `[Wave 3 | done 2026-06-16 | commits a31cd54, daee9c9]`. The
  email story was "react-email templates" in positioning only; the framework now backs it for real —
  deliberately **without** a new package or a React dep in `@keel/mail` core:
  - **Render hook → plain text.** `EmailRenderer` may return `{ html, text }`; a react-email renderer
    supplies the plain-text alternative (`render(el, { plainText: true })`) and the mailer fills
    `RenderedEmail.text` → SMTP `multipart/alternative`. An explicit `email.text` wins.
  - **Typed `mailer.template(name, build)`.** Returns a `MailTemplate` whose `.send` params are bound
    to the builder, so a wrong shape is a compile error. The open `send(name, params)` stays
    string-keyed on purpose — the parked unknown-mailer path (item 2) dispatches to names not defined
    on this deploy, so it cannot be type-checked.
  - **Shared base layout + dogfood.** Reusable `EmailLayout`/`EmailHeading`/`EmailText`/`EmailAction`
    and the verify/reset templates live in `examples/estate` (real multipart html+text); the
    bring-your-own-render hook is documented in `@keel/mail`'s module doc.
  - **Design call:** react-email components need a React/react-email dep, so they stay in the example
    (the copy-paste reference), keeping `@keel/mail` dependency-light. A `@keel/mail-react` adapter is
    the home for *importable* base components if multiple apps ever need them — deferred, not built.

## Owned elsewhere (do not duplicate)

- Identity's use of the mailer (verify/reset wiring, estate dogfood) → **auth-security** items 2–4 reference item 1 here.
- Queue retry/backoff semantics the mailer rides → **data-persistence** item 2 (PG-safe claim) — broadcasts inherit exactly-once-per-claim from that fix.
- `@keel/seo` ↔ `content-seo` JSON-LD reconciliation → **content-cms** deferred item 1.

## Deferred post-1.0 (deliberate)

- Inbound email, dev mail-catcher UI, bounce/complaint webhooks, additional provider transports — the v1 bar is "one Node transport + one Workers transport that really deliver."
- Mailing-list segmentation/templates (the Ghost-style growth surface) — after the battery is trustworthy.
