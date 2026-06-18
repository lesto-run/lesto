/**
 * Browser→server RUM tracing, end to end over a real socket and a real OTLP
 * collector — the acceptance for ARCHITECTURE.md §7's headline claim that
 * "browser spans stitch to the server trace."
 *
 * Every other tracing leg proves the SERVER tier (a request span, a db.query child
 * span). This one proves the BROWSER→server join: a page load's browser spans
 * (navigation, resource, web-vital) — each carrying the trace id the page adopted
 * from the SSR-injected `lesto-traceparent` meta — must land in the SAME local
 * collector as the server `http.request` span, parented on it, under ONE traceId.
 *
 * It boots `@lesto/runtime`'s `serve` with the env-driven tracer (exactly as
 * `lesto serve` / estate construct it), renders a real page (so the server stamps
 * the request span's traceparent into the head), reads that meta back out of the
 * streamed HTML the way a browser would, then POSTs the browser's spans to the
 * built-in `/__lesto/browser-spans` receiver — wired to `traces.seams.onBrowserSpan`,
 * the production wiring estate uses. Finally it reads the spans back out of the
 * in-process collector and asserts the join.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { serve } from "@lesto/runtime";
import type { Server } from "@lesto/runtime";
import { createElement } from "react";

import { BROWSER_SPANS_ROUTE, currentRequestSpan, lesto, runWithContext } from "@lesto/web";
import { formatTraceparent, parseTraceparent, tracesFromEnv } from "@lesto/observability";
import type { BrowserSpan, CurrentSpan, Traces } from "@lesto/observability";

import { startOtlpCollector } from "./otlp-collector";
import type { OtlpCollector } from "./otlp-collector";

let collector: OtlpCollector;
let server: Server;
let base: string;
let traces: Traces;

beforeAll(async () => {
  collector = await startOtlpCollector();

  // The tracer, constructed the canonical env-driven way — the SAME call the CLI
  // and estate make. `currentSpan` reads the request span the runtime publishes on
  // the context, so the page handler can stamp its traceparent into the head.
  const built = tracesFromEnv(
    { LESTO_OTLP_URL: collector.url, LESTO_OTLP_SERVICE: "integration-rum" },
    { currentSpan: currentRequestSpan as CurrentSpan },
  );

  if (built === undefined) throw new Error("tracesFromEnv returned undefined with a URL set");

  traces = built;

  // A real page (so the server stamps the request span's traceparent meta), and
  // the built-in browser-spans receiver wired to the tracer's seam — the exact
  // production wiring estate's `app.ts` uses. The browser's spans land in the same
  // exporter as the server spans, joined by trace id.
  const app = lesto()
    .page("/page", { component: () => createElement("main", null, "rum") })
    .browserSpans((span) => traces.seams.onBrowserSpan(span));

  server = await serve(
    { handle: (method, path, options) => app.handle(method, path, options), migrationsApplied: [] },
    {
      port: 0,
      tracer: traces.requestTracer,
      parseTraceparent,
      logError: () => {},
    },
  );

  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  collector.reset();
});

afterAll(async () => {
  await server.close();
  await collector.close();
});

/** Flush and wait for the collector to receive at least `count` spans. */
async function flushUntil(count: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await traces.flush();

    if (collector.spans.length >= count) return;

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Drain a streamed response body to a single HTML string. */
async function drain(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  let out = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    out += decoder.decode(value, { stream: true });
  }

  return out + decoder.decode();
}

/** Read the `lesto-traceparent` meta content out of an HTML document, as a browser would. */
function readTraceparentFromHtml(html: string): string | undefined {
  const match = html.match(/<meta name="lesto-traceparent" content="([^"]+)"\s*\/?>/);

  return match?.[1];
}

describe("browser spans stitch to the server trace (ARCHITECTURE.md §7)", () => {
  it("joins a page load's browser spans UNDER the server http.request span, one traceId", async () => {
    // 1) Load the page over a real socket. The server mints the request span and
    //    stamps its traceparent into the head — exactly what the browser reads.
    const response = await fetch(`${base}/page`);

    expect(response.status).toBe(200);

    const html = await drain(response.body as unknown as ReadableStream<Uint8Array>);

    // The SSR-injected meta the browser RUM runtime adopts.
    const injected = readTraceparentFromHtml(html);
    expect(injected).toBeDefined();

    const parsed = parseTraceparent(injected);
    expect(parsed).toBeDefined();

    const serverTraceId = parsed!.traceId;
    const serverSpanId = parsed!.parentId;

    // 2) The browser builds spans under that trace and POSTs them to the built-in
    //    receiver — the navigation span and a resource span (the UI→API hop).
    const browserNavSpanId = "0a0a0a0a0a0a0a0a";
    const browserResourceSpanId = "0b0b0b0b0b0b0b0b";

    const browserSpans: BrowserSpan[] = [
      {
        traceId: serverTraceId,
        spanId: browserNavSpanId,
        parentSpanId: serverSpanId,
        name: "browser.navigation",
        startedAt: 1000,
        endedAt: 1120,
        attributes: { "browser.load_ms": 120 },
        status: 1,
      },
      {
        traceId: serverTraceId,
        spanId: browserResourceSpanId,
        parentSpanId: serverSpanId,
        name: "browser.resource",
        startedAt: 1010,
        endedAt: 1042,
        attributes: { "browser.resource_path": "/client.js", "browser.duration_ms": 32 },
        status: 1,
      },
    ];

    const post = await fetch(`${base}${BROWSER_SPANS_ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, traceId: serverTraceId, spans: browserSpans }),
    });

    expect(post.status).toBe(204);

    // 3) Read the spans back out of the collector: the server request span plus the
    //    two browser spans, all under one traceId.
    await flushUntil(3);

    const request = collector.byName("http.request");
    const navigation = collector.byName("browser.navigation");
    const resource = collector.byName("browser.resource");

    expect(request).toBeDefined();
    expect(navigation).toBeDefined();
    expect(resource).toBeDefined();

    // THE ACCEPTANCE: the browser spans share the SERVER trace id and parent on the
    // server request span — UI → API, one unbroken trace in the collector.
    expect(navigation?.traceId).toBe(request?.traceId);
    expect(resource?.traceId).toBe(request?.traceId);

    expect(navigation?.parentSpanId).toBe(request?.spanId);
    expect(resource?.parentSpanId).toBe(request?.spanId);

    // The browser kept its own span ids and PII-free attributes through the wire.
    expect(navigation?.spanId).toBe(browserNavSpanId);
    expect(navigation?.attributes["browser.load_ms"]).toBe(120);
    expect(resource?.attributes["browser.resource_path"]).toBe("/client.js");

    // The whole graph is one service, one trace.
    expect(navigation?.serviceName).toBe("integration-rum");
  });

  it("adopts the SSR traceparent meta the page emitted (the browser→server seam)", async () => {
    // Drive the page render INSIDE a context whose span we mint ourselves, then
    // prove the head meta carries that exact span's traceparent — the seam the
    // browser RUM runtime reads. This pins the SSR-injection half directly.
    const requestSpan = traces.requestTracer.startSpan("http.request");

    const expected = formatTraceparent(requestSpan.data.traceId, requestSpan.data.spanId);

    const app = lesto().page("/p", { component: () => createElement("main", null, "x") });

    const html = await runWithContext({ requestId: "r", span: requestSpan }, async () => {
      const res = await app.handle("GET", "/p");

      return drain(res.body as unknown as ReadableStream<Uint8Array>);
    });

    requestSpan.end();

    expect(readTraceparentFromHtml(html)).toBe(expected);
  });
});
