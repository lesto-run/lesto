/**
 * Edge tracing, end to end through the Cloudflare adapter and a real OTLP
 * collector (blocker #11, the EDGE tier — edge-deploy #3).
 *
 * The node leg (`tracing.integration.test.ts`) proved a served request produces a
 * span in a local collector on the NODE tier. This is its twin on the EDGE: a
 * Worker-shaped `Request` driven through `@keel/cloudflare`'s `toFetchHandler`,
 * wired the SAME env-driven way (`tracesFromEnv` + the platform `fetch` as the
 * exporter's HTTP seam, exactly as `examples/estate/worker.ts` constructs it), and
 * the spans read back out of the same in-process collector the node leg uses — one
 * harness, both tiers, completing op#3's "both tiers" acceptance.
 *
 * The edge's flush contract is the load-bearing difference: a Worker has no steady
 * process to flush on an interval, so the adapter schedules the exporter's `flush`
 * through `ctx.waitUntil` — the spans drain AFTER the `Response` returns. We model
 * `ExecutionContext` with a fake that records each `waitUntil` promise, so we can
 * assert (1) NO span reached the collector at the moment the handler returned, and
 * (2) the span IS delivered once the scheduled `waitUntil` work settles — proving
 * no span is lost after `return`, the exact acceptance edge-deploy #3 names.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { toFetchHandler } from "@keel/cloudflare";
import type { EdgeDispatch, EdgeExecutionContext } from "@keel/cloudflare";

import { parseTraceparent, tracesFromEnv } from "@keel/observability";
import type { CurrentSpan, Traces } from "@keel/observability";

import { currentRequestSpan } from "@keel/web";
import type { AnyKeelResponse } from "@keel/web";

import { startOtlpCollector } from "./otlp-collector";
import type { OtlpCollector } from "./otlp-collector";

/**
 * A fake Cloudflare `ExecutionContext` that records every `waitUntil` promise
 * instead of letting the platform run it.
 *
 * The whole no-span-loss proof hinges on this: the adapter schedules its flush
 * through `waitUntil`, and a real platform keeps the isolate alive until that
 * promise settles. Recording the promises lets a test settle them ON DEMAND —
 * after asserting nothing was delivered synchronously — so the "drains after
 * return" guarantee is observed, not assumed.
 */
function recordingContext(): { ctx: EdgeExecutionContext; settle: () => Promise<void> } {
  const scheduled: Array<Promise<unknown>> = [];

  return {
    ctx: { waitUntil: (promise) => scheduled.push(promise) },
    settle: async () => {
      await Promise.all(scheduled);
    },
  };
}

let collector: OtlpCollector;
let traces: Traces;

beforeAll(async () => {
  collector = await startOtlpCollector();

  // The tracer, constructed the canonical edge way — the SAME `tracesFromEnv` call
  // `examples/estate/worker.ts` makes off the Worker `env` binding: `KEEL_OTLP_URL`
  // is the on switch (pointed at the live collector), the platform `fetch` is the
  // exporter's HTTP seam (no node:http on the edge path), and `currentSpan` reads
  // the request span the adapter publishes on the context so a seam parents on it.
  const built = tracesFromEnv(
    { KEEL_OTLP_URL: collector.url, KEEL_OTLP_SERVICE: "edge-integration" },
    {
      currentSpan: currentRequestSpan as CurrentSpan,
      fetchFn: fetch,
    },
  );

  if (built === undefined) throw new Error("tracesFromEnv returned undefined with a URL set");

  traces = built;
});

afterEach(() => {
  collector.reset();
});

afterAll(async () => {
  await collector.close();
});

/**
 * Poll the collector until it holds at least `count` spans (or time out).
 *
 * The `waitUntil` flush is in flight after `settle()` resolves the export POST,
 * but the collector records on its own socket callback — so a test settles the
 * scheduled work, then polls for the batch to land. Bounded so a real failure
 * surfaces as a timeout, not a hang.
 */
async function waitForSpans(count: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (collector.spans.length >= count) return;

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A dispatcher that answers a fixed JSON body — the app behind the edge adapter. */
const okDispatch: EdgeDispatch = () =>
  Promise.resolve<AnyKeelResponse>({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });

/** The traced edge handler, wired exactly as the estate Worker wires it. */
function tracedHandler(
  dispatch: EdgeDispatch,
): (request: Request, ctx?: EdgeExecutionContext) => Promise<Response> {
  return toFetchHandler(dispatch, {
    tracer: traces.requestTracer,
    parseTraceparent,
    flush: () => traces.flush(),
    logRequest: () => undefined,
    logError: () => undefined,
  });
}

describe("a Worker request produces a span in a local OTLP collector", () => {
  it("records an http.request span carrying method, path, and status", async () => {
    const { ctx, settle } = recordingContext();

    const response = await tracedHandler(okDispatch)(
      new Request("https://estate.example/mls/api/session", { method: "GET" }),
      ctx,
    );

    expect(response.status).toBe(200);

    // Drain the waitUntil-scheduled flush, then read the span back.
    await settle();
    await waitForSpans(1);

    const request = collector.byName("http.request");

    expect(request).toBeDefined();
    expect(request?.serviceName).toBe("edge-integration");
    expect(request?.attributes["http.method"]).toBe("GET");
    expect(request?.attributes["http.path"]).toBe("/mls/api/session");
    expect(request?.attributes["http.status_code"]).toBe(200);
    expect(request?.statusCode).toBe(1); // OTLP "ok"
  });

  it("loses NO span after the handler returns — the waitUntil flush delivers it", async () => {
    const { ctx, settle } = recordingContext();

    // At the moment the handler returns, the response is on the wire but the flush
    // is only SCHEDULED on waitUntil — nothing has reached the collector yet.
    await tracedHandler(okDispatch)(new Request("https://estate.example/mls"), ctx);

    expect(collector.spans).toHaveLength(0);

    // Now the platform runs the scheduled waitUntil work: the span is delivered.
    // This is the contract — the span survives the response return precisely
    // because waitUntil kept the isolate alive to ship it.
    await settle();
    await waitForSpans(1);

    expect(collector.byName("http.request")).toBeDefined();
  });

  it("never flushes synchronously when no ctx is passed (a node-shaped caller)", async () => {
    // Driven with one argument — no ExecutionContext, so no waitUntil flush. The
    // span is buffered, not lost: an explicit flush (the node tier's interval/drain)
    // would still ship it. Here we prove the edge does not flush behind the caller.
    await tracedHandler(okDispatch)(new Request("https://estate.example/mls"));

    expect(collector.spans).toHaveLength(0);

    // The buffered span is real — an explicit flush ships it (the node-tier path).
    await traces.flush();
    await waitForSpans(1);

    expect(collector.byName("http.request")).toBeDefined();
  });
});

describe("the edge request span is the parent of in-request seam spans", () => {
  it("a db.query seam fired during the request is a CHILD of the request span", async () => {
    const { ctx, settle } = recordingContext();

    // The dispatcher fires a seam INSIDE the request — exactly as a @keel/db query
    // run during a handler would — reading the request span off the context the
    // adapter published. Its span must parent on the request span.
    const dispatch: EdgeDispatch = () => {
      traces.seams.onQuery({ sql: "SELECT id FROM listings", durationMs: 3 });

      return Promise.resolve<AnyKeelResponse>({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
      });
    };

    await tracedHandler(dispatch)(new Request("https://estate.example/mls/listings"), ctx);

    await settle();
    await waitForSpans(2);

    const request = collector.byName("http.request");
    const query = collector.byName("db.query");

    expect(request).toBeDefined();
    expect(query).toBeDefined();

    // THE ACCEPTANCE: the query is a child of the request — same trace, parented on
    // the request span (each spanId truncates to 16 hex on the OTLP wire, so the
    // parent link matches). This is the node tier's exact contract, now on the edge.
    expect(query?.traceId).toBe(request?.traceId);
    expect(query?.parentSpanId).toBe(request?.spanId);
    expect(query?.attributes["db.statement"]).toContain("SELECT id FROM listings");
  });
});

describe("the edge request span joins an inbound W3C traceparent", () => {
  it("continues the caller's trace across the hop", async () => {
    const { ctx, settle } = recordingContext();

    // A caller's trace, in the W3C spec's example shape.
    const trace = "4bf92f3577b34da6a3ce929d0e0e4736";
    const caller = "00f067aa0ba902b7";

    await tracedHandler(okDispatch)(
      new Request("https://estate.example/mls", {
        headers: { traceparent: `00-${trace}-${caller}-01` },
      }),
      ctx,
    );

    await settle();
    await waitForSpans(1);

    const request = collector.byName("http.request");

    // The request span belongs to the CALLER's trace (joined, not fresh) and points
    // back at the caller's span — one trace across the edge hop, the same W3C
    // propagation the node tier does, parsed by the SAME `parseTraceparent`.
    expect(request?.traceId).toBe(trace);
    expect(request?.parentSpanId).toBe(caller);
  });
});
