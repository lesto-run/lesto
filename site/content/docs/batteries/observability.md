---
title: Observability
description: Built-in distributed tracing — spans per request, child spans, and OTLP export wired from two environment variables.
section: Batteries
order: 7
---

# Observability

`@lesto/observability` is in-house distributed tracing. Every request is a span;
your work nests child spans under it; an exporter ships them to any OTLP backend.

> v1 ships **traces** only — no metrics or logs pipeline yet. That boundary is
> deliberate.

## Spans

```ts
import { Tracer, InMemoryExporter } from "@lesto/observability";

const tracer = new Tracer({ exporter: new InMemoryExporter() });

const root = tracer.startSpan("handle_request");
const child = tracer.startSpan("query_db", { parent: root });
child.setAttribute("rows", 12).setStatus("ok").end();
root.end();

// Or bracket automatically:
await tracer.withSpan("charge_card", async (span) => {
  span.setAttribute("amount_cents", 4200);
  return charge();
});
```

## Export over OTLP

`serve` and `dev` wire tracing from the environment — `LESTO_OTLP_URL` is the on
switch:

```bash
LESTO_OTLP_URL=http://localhost:4318/v1/traces
LESTO_OTLP_SERVICE=my-app                       # service.name (default "lesto")
LESTO_OTLP_HEADERS=authorization=Bearer t       # optional
```

With it set, each request span joins an inbound `traceparent`, and the exporter
flushes on an interval (and, on the edge, via `waitUntil` after the response).
Unset, tracing mints no spans — zero overhead.

## In the browser

`startBrowserRum` and `wrapFetch` emit browser spans that stitch into the same
trace, so a page load and its server work share one timeline.
