# @lesto/observability

> Lesto's in-house distributed-tracing core — OpenTelemetry-shaped, with no OpenTelemetry dependency.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/observability
```

```ts
import { Tracer, InMemoryExporter } from "@lesto/observability";

const tracer = new Tracer({ exporter: new InMemoryExporter() });

const root = tracer.startSpan("handle_request");
const child = tracer.startSpan("query_db", { parent: root });
child.setAttribute("rows", 12).setStatus("ok").end();
root.end();

await tracer.withSpan("charge_card", async (span) => {
  span.setAttribute("amount_cents", 4200);
  return charge();
});
```

OpenTelemetry-shaped, with no OpenTelemetry dependency. Swap `InMemoryExporter` for
`OtlpHttpExporter` and `flush()` ships spans to a real collector over OTLP/HTTP. v1
is traces only — no metrics or logs pipeline (deliberate scope, not a gap).

[Docs](https://docs.lesto.run/batteries/observability) · [Agent-readable docs](https://docs.lesto.run/llms.txt)
