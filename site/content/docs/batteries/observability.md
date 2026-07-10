---
title: Observability
description: Built-in distributed tracing — spans per request, child spans, and OTLP export wired from two environment variables.
section: Batteries
order: 7
---

# Observability

`@lesto/observability` is in-house distributed tracing. Every request is a span;
the work it triggers — a query, a job, an outbound fetch — nests as child spans
under it; an exporter ships the finished spans to any OTLP backend. The shape is
OpenTelemetry-flavored, so a Lesto trace lands in the same collectors and vendors
the rest of your stack already speaks to.

> [!NOTE]
> v1 ships **traces** only — no metrics or logs pipeline yet. There are no
> counters and no histograms here; if you reach for one it does not exist, on
> purpose. The boundary is deliberate, not an oversight: spans plus the runtime's
> structured access log are the v1 operability story, joined by a shared
> `lesto.request_id`.

## Spans

A `Tracer` mints spans and hands the finished ones to an exporter. A root span
gets a fresh trace id; a child inherits its parent's trace id and points back at
the parent's span id. The fluent setters return `this`, so attributes and status
read as a chain, and `end()` exports exactly once.

```ts
import { Tracer, InMemoryExporter } from "@lesto/observability";

const tracer = new Tracer({ exporter: new InMemoryExporter() });

const root = tracer.startSpan("handle_request");
const child = tracer.startSpan("query_db", { parent: root });
child.setAttribute("rows", 12).setStatus("ok").end();
root.end();
```

`withSpan` brackets the work for you: it starts the span, awaits your function,
and ends the span in a `finally`. If your function throws, it marks the span
`"error"` and rethrows — the failure is recorded but never swallowed.

```ts
await tracer.withSpan("charge_card", async (span) => {
  span.setAttribute("amount_cents", 4200);
  return charge();
});
```

You rarely call `startSpan` by hand in an app. The batteries already raise
per-domain seams (`db.onQuery`, `queue.onJob`, `identity.onEvent`, …) that the
wiring turns into child spans of the in-flight request — so a query run while
serving a request shows up under that request's span with no code from you.

## Export over OTLP

`serve` and `dev` wire tracing from the environment. `LESTO_OTLP_URL` is the on
switch: set it to your collector's trace endpoint and tracing turns on; leave it
unset and the app mints **no spans at all** — no tracer, no exporter, zero
overhead. That is the safe default, so an app with no collector pays nothing.

```bash
LESTO_OTLP_URL=http://localhost:4318/v1/traces  # the on switch
LESTO_OTLP_SERVICE=my-app                        # service.name (default "lesto")
LESTO_OTLP_HEADERS=authorization=Bearer t        # optional, comma-separated key=value
```

With it set, `tracesFromEnv` builds an `OtlpHttpExporter` over the parsed headers
and service name, wires it to a `Tracer`, and hands back the live handle. Each
request mints one span; if the inbound request carried a W3C `traceparent`
header, the request span joins **that** trace instead of rooting a fresh one, so
a call crossing services stays a single trace. The exporter buffers finished
spans and ships them as OTLP/HTTP JSON to `/v1/traces` — the wire every OTel
collector accepts. On a long-lived node server, `serve` flushes on a steady
five-second interval (and once more on graceful drain), so the collector stays
close to live without a request per span:

```ts
const traces = tracesFromEnv(process.env, { currentSpan });
const stop = traces?.startInterval(5_000); // flush cadence; stop after the final drain flush
```

The buffer is bounded and never throws: a failed flush (a down collector, a
non-2xx) is reported and the batch dropped, because telemetry must never take the
app down.

## On the edge

A Cloudflare Worker has no steady process to run a flush interval on — the isolate
can freeze the moment you `return` the `Response`. So the edge adapter flushes a
different way: it schedules `ctx.waitUntil(flush())` **after** the response is
sent. That is the no-span-loss contract — the spans a request produced ship off
its critical path, after the `Response` returns, and the isolate is kept alive
until the flush settles rather than freezing with the batch still buffered.

```ts
// inside the Worker fetch handler, after the response is built
ctx.waitUntil(traces.flush());
```

`flush()` is idempotent and never throws, so scheduling it is always safe. The
env-var contract is identical to node — same `LESTO_OTLP_URL` / `LESTO_OTLP_SERVICE`
/ `LESTO_OTLP_HEADERS` — only the flush mechanism differs. See
[Deploy to Cloudflare](/deploy/cloudflare) for the Worker wiring and
[Deploy to Node](/deploy/node) for the long-lived server.

## In the browser

RUM closes the loop into the UI. `startBrowserRum` observes the page's own
performance — navigation phases, resource fetches, Core Web Vitals — and turns
each into a span. The join is a `<meta name="lesto-traceparent">` the SSR layer
injects: the browser reads the server request span's ids from it and emits its
spans **under that same trace id**, so a page load and the server work that
rendered it share one timeline. Without the meta (a static page, tracing off), it
roots its own trace instead of crashing.

```ts
import { startBrowserRum, wrapFetch } from "@lesto/observability";

const dispose = startBrowserRum(); // samples 10% of sessions by default
window.addEventListener("pagehide", dispose); // flush the last batch on the way out
```

`wrapFetch` carries the propagation outward. Wrap your `fetch` and every
**same-origin** request it makes stamps an outbound `traceparent` built from the
page's trace id plus a fresh child span id — so the server handler joins the very
trace the page is already part of. Cross-origin requests pass through untouched;
the trace id never leaks to a third party.

```ts
const fetch = wrapFetch({ traceId, origin: location.origin, randomSpanId, fetchImpl: globalThis.fetch });
```

RUM is bounded by design: sessions are sampled (10% by default), and a browser
span carries only timing numbers, same-origin paths, and vital values — never a
query string, a cross-origin URL, or a header.

## Agent and LLM spans (preview)

The trace reaches the agent tier too. When a request calls the preview
[`@lesto/ai`](/batteries/ai) — `generateText` for one model call, `runAgent` for
a bounded tool loop — each model call becomes an `ai.generate` span and each tool
run an `ai.tool` span, carrying the model id, the token usage, and the stop
reason as **attributes**. So one HTTP request that calls an LLM produces
`http.request → ai.generate → ai.tool` on a single trace, one trace id — agent
and LLM calls appear on the same trace as the request that drove them, not on a
separate dashboard.

The wiring is an injected seam, not magic: `@lesto/ai` takes **no** dependency on
`@lesto/observability`. It accepts an `AgentTracer` (`startSpan(name, attributes)`),
and the app adapts its `Tracer` to it — parenting each span on the in-flight
request span, so the agent run rides the request's trace instead of rooting its
own:

```ts
// the app adapts its Tracer to @lesto/ai's AgentTracer, parenting on the request span
const agentTracer = {
  startSpan: (name, attributes) => {
    const span = tracer.startSpan(name, { parent: currentRequestSpan(), attributes });
    return { setStatus: (s) => span.setStatus(s), end: () => span.end() };
  },
};

await runAgent({ model, tools, messages, tracer: agentTracer }); // → ai.generate + ai.tool spans
```

The `examples/estate` concierge route (`POST /mls/api/assistant`) is the dogfood:
run its node server with `LESTO_OTLP_URL` set and the join shows up in your
collector, asserted end-to-end in `examples/estate/test/ai-trace.dogfood.test.ts`.

> [!NOTE]
> **Preview, and traces only — still.** The `ai.*` spans ride the preview
> `@lesto/ai` package. The token counts on them are span **attributes**, not a
> metrics or cost pipeline — there is no counter, no spend dashboard, and no
> queryable span store; the spans ship to your OTLP collector like every other
> span.

The **MCP control plane** is a separate story. A governed tool dispatch
(`@lesto/mcp`) offers an `onSpan` seam, and the `mcp.tool` span an app emits from
it is **standalone** — MCP tool calls run outside your app's request handling
(over stdio or the streamable-HTTP transport), so there is no request span to
parent on. Lesto does not claim MCP actions appear on your request trace today.

## Notes and gotchas

- **Traces only.** This package is distributed tracing and nothing else in v1 —
  no metrics, no logs pipeline. Correlate a span with an access-log line by the
  shared `lesto.request_id` (also echoed on the `X-Request-Id` response header)
  rather than reaching for a counter.
- **`service.name` defaults to `"lesto"`.** Set `LESTO_OTLP_SERVICE` so your
  traces land under your app's name in the collector instead of the framework
  default.
- **Propagation is W3C `traceparent`, verbatim.** Lesto never invents a header or
  format — the W3C wire is what every collector and sibling service already
  speaks.
- **Tracing off costs nothing.** With `LESTO_OTLP_URL` unset, no tracer is built,
  the per-domain seams are never wired into the batteries, and the served path is
  byte-for-byte the untraced one.
