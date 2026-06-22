---
title: One trace, from the browser click to the database query
description: Lesto ships the thing most JS frameworks leave you to assemble — a single distributed trace that spans browser → API → DB — and it does it with no OpenTelemetry dependency.
date: "2026-06-22"
author: The Lesto team
---

# One trace, from the browser click to the database query

Open the trace for a slow page in a typical app. You'll find the `http.request` span, and maybe the `db.query` spans hanging off it — if you wired up server tracing. What you won't find is the browser half: the render that happened before the request, the web vitals the user actually felt, or the fact that *this* page load is what triggered *that* query. The browser lives in one tool (if at all), the server in another, and joining "the user waited 2 seconds" to "this query took 1.4s of it" is a manual, match-the-timestamps exercise across two systems that don't know each other exist.

Lesto ships that join in the box: **one distributed trace, from the browser click down to the database query, on a single trace id** — and with no OpenTelemetry dependency to pull in.

## How everyone else does it

The incumbents handle pieces of this, just not in one place.

**Next.js** ships OpenTelemetry — an `instrumentation.ts` hook, automatic spans for route handlers and `fetch`. Good, as far as the server goes. But the browser side is a separate concern (a RUM script, usually a third-party one) on a separate trace, and stitching the two onto the same trace id is an integration you own.

**Rails** doesn't ship distributed tracing at all; you reach for `opentelemetry-ruby` or a vendor agent, and the front end is again someone else's script.

**The common reality** is two or three tools: an APM for the server, a RUM product for the browser, each with its own trace concept. They rarely share an id, so "this slow request" and "this janky page load" are two facts you correlate by eye.

None of this is wrong — it's the consequence of the browser and the server being instrumented by different products. Lesto's bet is that a framework that owns both ends can just... not split them.

## What Lesto ships

The server mints one `http.request` root span per request and stamps its W3C `traceparent` into a `<meta name="lesto-traceparent">` on every dynamically rendered page. The browser RUM client (`startBrowserRum`, from the node-free `@lesto/observability/rum` subpath, bundled into the client entry automatically) reads that meta tag and **adopts the server's trace id** — so the browser doesn't start a new trace, it continues the one the server already opened. It emits spans for navigation timing, same-origin resource fetches, and web vitals (LCP, INP, raw per-shift layout-shift scores), then POSTs them to a built-in receiver at `POST /__lesto/browser-spans`, which routes them through the *same* OTLP exporter the server spans use.

The result: a page load's browser spans land **under** the server `http.request` span, on one trace id. And when the page fetches data, `@lesto/client` carries the `traceparent` on same-origin requests, so the API handler joins the very same trace. Every battery terminates in a seam that opens a child span on the in-flight request span — `@lesto/db`'s `onQuery` turns each executed query into a `db.query` child — so a single trace reads like this:

```
http.request   GET /dashboard                         218ms
├─ db.query    select * from projects where org = ?    12ms
├─ db.query    select * from tasks where project = ?    9ms
└─ web-vitals  LCP 1.2s · INP 40ms                     (same traceId)
```

UI → API → DB, unbroken, one id. It's proven end to end in `packages/integration/test/rum.integration.test.ts` against a real OTLP collector — not a diagram, a test.

## Turning it on is one environment variable

Tracing is off by default and costs nothing when off. The on-switch is a single env var pointing at any OTLP/HTTP collector:

```sh
LESTO_OTLP_URL=http://localhost:4318/v1/traces   # the on switch
LESTO_OTLP_SERVICE=my-app                          # service.name (optional)
```

The app wires it once, and the battery seams flow into it:

```ts
const traces = tracesFromEnv(process.env, { currentSpan });
const db = createDb(sql, { onQuery: traces?.seams.onQuery });
const stop = traces?.startInterval(5_000); // flush cadence; stop on drain
```

Because the exporter speaks OTLP/HTTP, the spans land in whatever you already run — Datadog, Honeycomb, Grafana Tempo, any OTLP endpoint.

## No OpenTelemetry dependency — on purpose

Here's the part worth dwelling on: the shape is OpenTelemetry-flavored, but `@lesto/observability` does **not** depend on the OpenTelemetry SDK. The tracer and spans are a small in-house core; the only thing borrowed verbatim is the W3C `traceparent` format, because that's the actual standard for joining a trace across a process boundary — you don't invent your own. That keeps the dependency surface tiny and the edge bundle clean (the browser RUM subpath pulls in no `node:*`), while still emitting to any OTLP collector. You get the interoperability of the standard without the weight of the SDK.

One honest boundary: the v1 cut is **traces only** — no metrics pipeline (no counters or latency histograms) and no logs pipeline yet. The package says so in its own source. Tracing is the hard, differentiated part; the rest is on the roadmap.

## Where this goes next

The interesting thing about a single child-span mechanism is what else fits it. An LLM call, a tool call, an agent's MCP action — each is the same shape as a `db.query`: a name, a few attributes, an outcome, a duration. Putting *those* on the same `http.request` trace — so an agent step and the query it triggered sit on one timeline — is a proposed next step ([ADR 0031](https://github.com/lesto-run/lesto)), not yet shipped. We'll write about it when it lands. For now, the shipped story is the one above: browser to database, one trace, no OpenTelemetry dependency.

See the [observability docs](/batteries/observability) for the full setup.
