# ADR 0036 — Product analytics on the one substrate (`@lesto/analytics`: events → the DB → funnels, agent-queryable)

- **Status:** Proposed — pending owner ratification. The committed **build-now** is a single
  shippable seam: **Phase 1** = a `@lesto/analytics` package with a `capture(event, props)`
  API, an `analytics_events` table installed through the kernel `schemas` seam, durable
  ingestion on `@lesto/queue`, a browser receiver mirroring the RUM span receiver, and the
  query helpers (`funnel`, `retention`, `breakdown`) — shippable at the full bar (strict TS, 100% coverage,
  coded errors). **Phase 2** (the MCP `query_funnel` / `query_events` control-plane tools) and
  **Phase 3** (the `@lesto/flags` ⋈ analytics experiments leg) are designed here but built
  behind Phase 1.
- **Deciders:** owner (ratification pending).
- **Date:** 2026-06-22.

## Context

Lesto's identity is *batteries-included on one substrate — the SQL database* (ARCHITECTURE
§1). It ships feature flags (`@lesto/flags`), in-house distributed **tracing**
(`@lesto/observability`), and in-process pub/sub (`@lesto/pubsub`). It does **not** ship
**product analytics** — the "user did X → persist it → ask funnel / retention / conversion
questions" capability. A tree-wide search confirms it: no `@lesto/analytics`, no
`@lesto/events`, no `capture`/`track` event API anywhere.

That is a gap by Lesto's own principles. Product analytics is a canonical "hard part" the JS
ecosystem outsources to a third-party pixel (PostHog, Segment, Amplitude) — exactly the "glue
a zoo of external services" outcome the batteries-included bet exists to reject. Worse, it
sends your product's behavioral data to someone else's database, where it can never be joined
to your own tables.

**This is NOT covered by tracing, and must not be conflated with it.** `@lesto/observability`
and ADR 0031 (agent-observable-runtime) answer *"is the system/agent fast and healthy — what
happened inside this request"* with **spans** (an OTLP pipeline, short retention, latency-
shaped queries). Product analytics answers *"what are users doing, and where do they drop
off"* with **events** (durable, long retention, funnel/retention/cohort-shaped queries).
Different data model, different lifetime, different queries — they are separate batteries, the
same way PostHog ships session-tracing and product-analytics as distinct products. ADR 0031 is
the wave's keystone for *runtime* observability; **this ADR is its complement: product
legibility.** Where 0031 makes the runtime observable, 0036 makes product behavior measurable.

**A forward-port seam already exists.** The docs site was instrumented (the
`L-16e24a6d` work) deliberately behind a driver seam — `site/app/analytics/client.ts` defines
an `Analytics` interface (`page` / `track` / `identify`) and an `AnalyticsDriver`, with PostHog
as an *interim, removable* driver and a declarative `data-analytics="event"` convention for
click tracking. That interface was shaped to be exactly the browser surface this battery
exposes, so the docs site's adoption is a one-line driver swap (`site/app/analytics/README.md`).
PostHog is the stopgap for measuring launch; **the goal of this ADR is the battery that
replaces it** — at which point the docs site dogfoods Lesto's own analytics ("this site's
analytics run on Lesto").

The infrastructure to build this is largely already present:

- **A browser→server ingestion pattern**, proven: the RUM client POSTs to a built-in receiver
  at `BROWSER_SPANS_ROUTE = "/__lesto/browser-spans"` (`packages/web/src/browser-spans.ts:40`),
  routed through a `seams.onBrowserSpan` hook. An events receiver mirrors this exactly.
- **Durable async ingestion**: `@lesto/queue` (`new Queue({ db })`, `define`/`enqueue`/`work`,
  `installSchema`) — at-least-once with visibility-timeout reclaim, on the DB, no Redis.
- **A schema-install seam**: the kernel runs battery installers after migrations —
  `schemas?: ReadonlyArray<(db) => Promise<void>>` (`packages/kernel/src/kernel.ts:192`), the
  same path `@lesto/queue`'s `installSchema` rides.
- **An agent control plane**: `@lesto/mcp`'s `buildTools` / `dispatch` (`packages/mcp/src/tools.ts`)
  is where a `query_funnel` tool slots in beside `query_content` / `generate_ui`.
- **A flags battery to compose with**: `@lesto/flags` (`defineFlags`) — flags + analytics =
  A/B experiments (flag exposure event → conversion event → result).

## Decision

Build **`@lesto/analytics`** — first-party product analytics on the one substrate, exposed
equally to code, the CLI, and agents (the MCP surface).

### 1. Capture — one API, server and browser

A small, durable capture surface. Server-side:

```ts
const analytics = new Analytics({ db, queue });   // queue optional; sync insert without it
await analytics.capture("signup_completed", { plan: "pro" }, { actor: userId });
```

Browser-side, the exact `Analytics` interface the docs-site seam already targets
(`site/app/analytics/client.ts`) — `page()` / `track(event, props)` / `identify(distinctId)` —
served by a node-free `@lesto/analytics/browser` subpath (the same split
`@lesto/observability/rum` uses). The browser client POSTs batched events to a built-in
receiver `POST /__lesto/events`, mirroring `BROWSER_SPANS_ROUTE`; the receiver enqueues them.

Identity is stitched the way RUM stitches the trace id: an anonymous `distinct_id` from a
first-party cookie/localStorage, promoted via `identify` when a user authenticates.

### 2. Store — one table on the substrate

```
analytics_events(
  id, name, distinct_id, actor_id?, props (json), ts,  -- the event
  session_id?, source                                   -- 'server' | 'browser'
)
```

Defined as a `@lesto/db` value; installed via `installSchema(db)` registered through the
kernel `schemas` seam, so a `createApp({ db, schemas: [analyticsSchema] })` app has the table
before the first `capture`. SQLite local → Postgres at scale, same API. Because events are
rows in *your* database, they are **queryable with SQL and joinable to your own tables** — the
one thing no SaaS analytics can do ("which *paying* customers completed this funnel" is a
join, not an export).

### 3. Ingest — durable, on the queue

`capture` enqueues an insert job on `@lesto/queue` (atomic with the surrounding transaction
when one is open; at-least-once on its own otherwise), so a burst of events never blocks a
request and a crash never drops them. Without a queue handle, `capture` falls back to a direct
insert (zero-config local). A worker drains the events into `analytics_events`.

### 4. Query — the three classics

Plain functions returning plain data (renderable, or handed to an agent):

```ts
analytics.funnel(["visited_pricing", "signup_started", "signup_completed"], { since });
analytics.retention("signup_completed", { period: "week", weeks: 8 });
analytics.breakdown("signup_completed", { by: "plan", since });
```

These compile to SQL over `analytics_events` (a window/`GROUP BY` for funnel ordering, a
cohort grid for retention). v1 targets correctness and the SQLite/Postgres parity seam, not
billion-row scale (see scope).

### 5. The agent-native tier (Phase 2) — `query_funnel` on the control plane

An MCP tool `query_funnel` (and `query_events`) on `@lesto/mcp` so an agent can answer *"what's
my signup funnel this week?"* straight from the DB. This is the differentiator no incumbent
has: analytics you can interrogate in natural language because the operations layer, the data,
and the agent surface are one coherent thing (ARCHITECTURE §1.5).

### 6. Experiments (Phase 3) — `@lesto/flags` ⋈ `@lesto/analytics`

Flags already gate exposure; analytics already captures conversion. The experiments leg is a
thin composition: record a flag-exposure event on evaluation, define a metric event, and the
funnel/breakdown machinery computes the result per variant. Designed here; **not** v1.

## Scope — said out loud (the `@lesto/observability` discipline)

v1 is **capture + funnel/retention/breakdown queries + the browser receiver**, and nothing
else. Explicitly **deferred post-1.0**, to be added behind the same API without rewrites:

- **Session replay** and any DOM capture (privacy surface; large).
- **Cohort/segment builder UI** and a dashboard (the admin surface can render funnels later).
- **Real-time / streaming** event subscriptions (the substrate is batch-first; pub/sub is a
  separate battery).
- **Sampling, rollups, and retention/aggregation at extreme scale** — v1 stores raw events;
  a rollup/retention scheduler (mirroring `@lesto/queue`'s `RetentionScheduler`) comes later.

Like observability shipping "TRACES ONLY" for v1, this ships "CAPTURE + CORE QUERIES ONLY",
honestly tagged.

## Alternatives considered

- **Keep using PostHog/Segment (a third-party pixel).** Rejected as the *destination*: it
  violates batteries-included and one-substrate, and the behavioral data can't be joined to
  app tables. Accepted as the *interim* (the docs-site seam) until this battery ships — which
  is precisely why that seam was built driver-swappable.
- **Ride ADR 0031's trace/OTLP pipeline for events.** Rejected: spans ≠ events. Forcing
  product events through a span exporter inherits short retention, an OTLP-shaped data model,
  and latency-oriented queries — wrong for funnels/retention/cohorts. They share the
  *browser→server ingestion pattern* (worth reusing) but not the store or the query layer.
- **Build on `@lesto/pubsub`.** Rejected: pub/sub is in-process and ephemeral — no
  persistence, no query. It is plumbing, not analytics.
- **Defer entirely; analytics is "not framework scope."** Rejected: flags, tracing, queue, and
  mail are all "not framework scope" under that logic — yet they are batteries because the
  whole bet is that they should be. Analytics is the same call, and the agent-queryable angle
  makes it a differentiator, not a commodity.

## Error contract

A `LestoError` subclass `AnalyticsError` with stable codes (callers branch on `code`, never a
message), per the engineering bar: `ANALYTICS_INVALID_EVENT_NAME`,
`ANALYTICS_QUEUE_UNAVAILABLE`, `ANALYTICS_FUNNEL_EMPTY_STEPS`, `ANALYTICS_SCHEMA_NOT_INSTALLED`.

## Consequences

- **Positive.** Closes a real batteries-included gap; a genuine differentiator (self-hosted,
  GDPR-friendly by default, SQL-joinable, agent-queryable); the docs site stops paying for
  PostHog and dogfoods Lesto; composes cleanly into experiments; reuses proven infra (the RUM
  receiver pattern, the queue, the kernel schemas seam, the MCP dispatch).
- **Negative / cost.** A new package to hold to the 100% bar; funnel/retention SQL must pass
  the SQLite⋈Postgres dialect parity seam (the cross-tier query tax every data battery pays);
  a privacy/consent posture to document (default `respect_dnt`, no PII in `props` by
  convention, raw events mean a retention story is owed in v2).
- **Neutral.** PostHog stays the interim for measuring *this* launch; the swap is a follow-up,
  not a blocker.

## Acceptance (this ADR)

- [ ] `@lesto/analytics` package: `Analytics` (server) + `@lesto/analytics/browser`, the
      `analytics_events` schema + `installSchema`, queue-backed ingest, the `/__lesto/events`
      receiver, and `funnel`/`retention`/`breakdown` — all at the full bar (strict TS, 100%
      coverage, `AnalyticsError` codes), with the SQLite + Postgres parity legs.
- [ ] The docs-site driver swap: `site/app/analytics/init.ts` uses the new browser client;
      `posthog-driver.ts` + `config.ts` + the headless island deleted.
- [ ] Phase 2/3 (MCP `query_funnel`; flags⋈analytics experiments) tracked as follow-on tasks,
      not required to land Phase 1.
