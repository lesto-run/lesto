/**
 * The observability loop: one served request, TWO records, joined by an id
 * (operability-dx #6).
 *
 * A request leaves two traces of itself — a span in the collector, and a line in
 * the access log — and the whole point is that they are joinable. This pins that
 * loop end to end over a real socket: boot `@keel/runtime`'s `serve` with BOTH
 * the env-driven OTLP tracer (`tracesFromEnv`, exactly as `keel serve`
 * constructs it) and the `logRequest` access-log seam, send ONE request, and
 * assert it produced:
 *
 *   1. an `http.request` SPAN in a local OTLP collector, and
 *   2. an access-log ENTRY,
 *
 * and — the loop — that the span's `keel.request_id` attribute equals the access
 * entry's `requestId`. That shared id is the join: the trace tells you the shape,
 * the access log tells you the outcome, and the id lines them up. v1 ships traces
 * + structured access logs and no metrics pipeline; this is the test that proves
 * those two halves are actually correlated, not just both present.
 *
 * The collector is the same reusable `./otlp-collector` harness the tracing legs
 * use; this file is additive and does not touch them.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "@keel/kernel";
import type { KeelAppConfig, KernelDatabase } from "@keel/kernel";
import { serve } from "@keel/runtime";
import type { AccessEntry, Server } from "@keel/runtime";
import { currentRequestSpan, keel } from "@keel/web";
import { parseTraceparent, tracesFromEnv } from "@keel/observability";
import type { CurrentSpan, Traces } from "@keel/observability";

import { startOtlpCollector } from "./otlp-collector";
import type { OtlpCollector } from "./otlp-collector";

// A trivial in-memory database handle: the app needs one to boot, but this test
// runs no queries — it is about the request/span/access-log loop, not the db.
const stubDb: KernelDatabase = {
  exec: async () => {},
  prepare: () => ({
    run: async () => ({ changes: 0 }),
    get: async () => undefined,
    all: async () => [],
  }),
  transaction: async (fn) => fn(stubDb),
};

let collector: OtlpCollector;
let server: Server;
let base: string;
let traces: Traces;

// Every access-log entry the runtime emits lands here; the test reads it back to
// assert the entry exists and carries the request id the span also carries.
const accessLog: AccessEntry[] = [];

beforeAll(async () => {
  collector = await startOtlpCollector();

  // The canonical env-driven tracer — the SAME construction `keel serve` makes.
  // `KEEL_OTLP_URL` is the on switch, pointed at the live collector.
  const built = tracesFromEnv(
    { KEEL_OTLP_URL: collector.url, KEEL_OTLP_SERVICE: "observability-loop" },
    { currentSpan: currentRequestSpan as CurrentSpan },
  );

  if (built === undefined) throw new Error("tracesFromEnv returned undefined with a URL set");

  traces = built;

  const app = keel().get("/ping", (c) => c.json({ ok: true }));

  const config: KeelAppConfig = { db: stubDb, app };

  // Wire BOTH seams onto the one server: the request tracer (every request mints a
  // span, published on the context) AND the access-log sink (every request appends
  // one entry). This is the production pairing — `keel serve` wires the tracer; the
  // runtime's access log is always on.
  server = await serve(await createApp(config), {
    port: 0,
    tracer: traces.requestTracer,
    parseTraceparent,
    logRequest: (entry) => accessLog.push(entry),
    logError: () => {},
  });

  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  await collector.close();
});

/**
 * Flush and wait for the collector to receive at least `count` spans. The
 * exporter buffers; we flush explicitly rather than wait on the 5s interval, and
 * poll bounded so a real failure surfaces as a timeout, not a hang.
 */
async function flushUntil(count: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await traces.flush();

    if (collector.spans.length >= count) return;

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the observability loop: one request yields a span AND an access entry, joined by id", () => {
  it("produces both records and they share the same request id", async () => {
    const response = await fetch(`${base}/ping`);

    expect(response.status).toBe(200);

    // The runtime echoes the request id on the response header; the same id must
    // appear on BOTH the span and the access entry below.
    const headerRequestId = response.headers.get("x-request-id");

    expect(headerRequestId).toBeTruthy();

    await flushUntil(1);

    // 1. THE SPAN — minted for this request, in the collector.
    const span = collector.byName("http.request");

    expect(span).toBeDefined();
    expect(span?.serviceName).toBe("observability-loop");
    expect(span?.attributes["http.method"]).toBe("GET");
    expect(span?.attributes["http.path"]).toBe("/ping");
    expect(span?.attributes["http.status_code"]).toBe(200);

    // 2. THE ACCESS ENTRY — emitted for the same request.
    expect(accessLog).toHaveLength(1);

    const entry = accessLog[0];

    expect(entry?.method).toBe("GET");
    expect(entry?.path).toBe("/ping");
    expect(entry?.status).toBe(200);
    expect(typeof entry?.ms).toBe("number");

    // THE LOOP: the span's `keel.request_id` attribute, the access entry's
    // `requestId`, and the `X-Request-Id` header are one and the same value — the
    // join that correlates the trace with the access log.
    expect(span?.attributes["keel.request_id"]).toBe(entry?.requestId);
    expect(entry?.requestId).toBe(headerRequestId);
  });
});
