/**
 * Estate's tracing dogfood (operability-dx item 3).
 *
 * Estate is the canonical OTLP reference: it wires the SAME seam hooks a
 * production Keel app uses — `db.onQuery`, `identity.onEvent`, `mail.onDelivered`,
 * and `keel().clientErrors(...)` — into the tracer. This proves that, when a
 * `Traces` is constructed and threaded through `buildAppConfig`, a request
 * through the real app produces child spans on the request span: a db query
 * traces, an auth event traces, a client-error beacon traces.
 *
 * The runtime publishes the request span on the context; the seams parent on it
 * via `currentRequestSpan`. Here we drive the app's `handle` INSIDE a
 * `runWithContext` carrying that span, exactly as the node server does — so the
 * parenting is exercised without a socket.
 */

import { describe, expect, it } from "vitest";

import { createApp } from "@keel/kernel";
import { runWithContext } from "@keel/web";
import { createTraces, InMemoryExporter, Tracer } from "@keel/observability";
import type { Span, SpanData } from "@keel/observability";

import { buildAppConfig } from "../src/app";
import { DEFAULT_DEMO } from "../src/identity";

/** A traces handle over an in-memory exporter, with the request span as parent. */
function tracingFixture(requestSpan: () => Span | undefined): {
  exporter: InMemoryExporter;
  traces: ReturnType<typeof createTraces>;
} {
  const exporter = new InMemoryExporter();

  const traces = createTraces({
    tracer: new Tracer({ exporter }),
    flush: async () => {},
    currentSpan: requestSpan,
  });

  return { exporter, traces };
}

describe("estate tracing dogfood", () => {
  it("a request produces a db.query span parented on the request span", async () => {
    // The request span the runtime would publish — here a real tracer span so the
    // child's parent ids are checkable.
    const rootExporter = new InMemoryExporter();
    const root = new Tracer({ exporter: rootExporter }).startSpan("http.request");

    const { exporter, traces } = tracingFixture(() => root);

    const app = await createApp(await buildAppConfig("a".repeat(32), traces.seams));

    // A request that runs a query (the session source reads the user). We run it
    // inside the request context carrying the span, as the server does.
    await runWithContext({ requestId: "r-1", span: root }, () =>
      app.handle("GET", "/__keel/data/session"),
    );

    const queries = exporter.spans.filter((s) => s.name === "db.query");

    expect(queries.length).toBeGreaterThan(0);

    // The query span is a CHILD of the request span — the join the dogfood proves.
    const query = queries[0] as SpanData;

    expect(query.traceId).toBe(root.data.traceId);
    expect(query.parentSpanId).toBe(root.data.spanId);
    expect(query.attributes).toHaveProperty("db.statement");
  });

  it("a successful sign-in emits an identity.login_succeeded span", async () => {
    const root = new Tracer({ exporter: new InMemoryExporter() }).startSpan("http.request");

    const { exporter, traces } = tracingFixture(() => root);

    const app = await createApp(await buildAppConfig("b".repeat(32), traces.seams));

    await runWithContext({ requestId: "r-2", span: root }, () =>
      app.handle("POST", "/mls/api/sign-in", {
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams({
          email: DEFAULT_DEMO.email,
          password: DEFAULT_DEMO.password,
        }).toString(),
      }),
    );

    const names = exporter.spans.map((s) => s.name);

    expect(names).toContain("identity.login_succeeded");
  });

  it("the client-error beacon becomes a client.island_error span", async () => {
    const { exporter, traces } = tracingFixture(() => undefined);

    const app = await createApp(await buildAppConfig("c".repeat(32), traces.seams));

    await app.handle("POST", "/__keel/client-errors", {
      // The beacon is a state-changing POST, so estate's `originCheck` needs the
      // same-origin Fetch-Metadata signal — the browser sends it automatically.
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: { failed: ["Account"], missing: [], failedCount: 1, missingCount: 0 },
    });

    const beacon = exporter.spans.find((s) => s.name === "client.island_error");

    expect(beacon).toBeDefined();
    expect(beacon?.status).toBe("error");
    expect(beacon?.attributes["client.failed"]).toBe("Account");
  });
});
