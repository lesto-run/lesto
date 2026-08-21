---
"@lesto/cli": minor
"@lesto/kernel": minor
"@lesto/mcp": minor
"@lesto/observability": minor
"@lesto/runtime": minor
"@lesto/web": patch
"create-lesto": minor
---

`lesto dev` keeps a bounded, in-process trace ring, and a fourth read-only dev MCP tool reads it: `get_trace` (PREVIEW) returns the spans one trace produced — by `traceId`, by the `requestId` `get_recent_requests` reports, or (with neither) the most recent trace.

There was no queryable span store anywhere: server spans went to OTLP and browser spans to a console sink, so an agent driving `lesto dev` could ask what was *served* but not what *happened inside it*. The ring holds both halves — server spans and the browser-span receiver's payloads — keyed by `traceId`, capped twice (traces retained, spans per trace), and it says `truncated` when a cap dropped something rather than reporting a partial trace as complete.

Like every dev tool, `get_trace` is built only when `lesto dev` injects its live state, so no other server — including the remote OAuth transport — can advertise or reach it.

`tracesFromEnv` gains an optional `spanSink`: a tee that never replaces the collector, and a second way to turn tracing on. Supplying it is what lets `lesto dev` hold a real trace with no `LESTO_OTLP_URL` set — spans are minted in-process and shipped nowhere. **`lesto dev` therefore now traces where it previously did not**: dev pages carry the `<meta name="lesto-traceparent">` the runtime stamps whenever a request span exists, and an app that wires its own seams gets them in dev. `lesto serve` passes no sink and is unchanged.

`AccessEntry` (and its `@lesto/kernel` mirror `AccessLogEntry`) gains an optional `traceId`, stamped by the runtime beside the request span. That is what `get_trace({ requestId })` resolves through — never a span attribute, which any caller of the unauthenticated browser-spans receiver could set — and it hands trace correlation to every app that supplies its own `logRequest` sink.

`McpDevStateReader` gains an OPTIONAL `retainedTrace` member, so an existing reader keeps compiling and the tool's existence tracks the real capability.
