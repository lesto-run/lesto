/**
 * Tracing, end to end over a real socket and a real OTLP collector (blocker #11).
 *
 * This is the Wave-4 acceptance leg: a served request must produce a span in a
 * local OTLP collector, and a db query run during that request must appear as a
 * CHILD span of the request span. Every other tracing test mocks the exporter or
 * the socket; this one boots `@keel/runtime`'s `serve` with the env-driven tracer
 * (`tracesFromEnv`, exactly as `keel serve` / estate construct it), hits it with
 * the platform's real `fetch`, and reads the spans back out of an in-process
 * collector that speaks the OTLP/HTTP JSON wire format.
 *
 * The collector harness (`./otlp-collector`) is built REUSABLY: Phase 3
 * (edge-deploy #3) stands the same collector in front of the Cloudflare adapter
 * and asserts the edge `waitUntil(flush())` lands a span in it — proving "both
 * tiers" against one harness. THIS leg proves the NODE tier; the edge leg is
 * deferred to edge-deploy #3 (noted in the report).
 */

import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "@keel/kernel";
import type { KeelAppConfig, KernelDatabase } from "@keel/kernel";
import { serve } from "@keel/runtime";
import type { Server } from "@keel/runtime";
import { currentRequestSpan, keel, runWithContext } from "@keel/web";
import { parseTraceparent, tracesFromEnv } from "@keel/observability";
import type { CurrentSpan, Traces } from "@keel/observability";

import { createDb } from "@keel/db";
import type { Db } from "@keel/db";

import { startOtlpCollector } from "./otlp-collector";
import type { OtlpCollector } from "./otlp-collector";

// ---- A better-sqlite3 handle adapted to the async @keel/db SQL surface. ----

function adapt(raw: Database.Database): KernelDatabase {
  const adapted: KernelDatabase = {
    exec: async (sql) => {
      raw.exec(sql);
    },
    prepare: (sql) => {
      const statement = raw.prepare(sql);

      return {
        run: async (params = []) => statement.run(...(params as never[])),
        get: async (params = []) => statement.get(...(params as never[])),
        all: async (params = []) => statement.all(...(params as never[])),
      };
    },
    transaction: async (fn) => {
      raw.exec("BEGIN");

      try {
        const out = await fn(adapted);
        raw.exec("COMMIT");

        return out;
      } catch (error) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* preserve the original error */
        }

        throw error;
      }
    },
  };

  return adapted;
}

let collector: OtlpCollector;
let database: Database.Database;
let server: Server;
let base: string;
let traces: Traces;

beforeAll(async () => {
  collector = await startOtlpCollector();

  database = new Database(":memory:");
  database.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)");
  database.exec("INSERT INTO posts (title) VALUES ('hello'), ('world')");

  const handle = adapt(database);

  // The tracer, constructed the canonical env-driven way — the SAME call the CLI
  // and estate make. `KEEL_OTLP_URL` is the on switch; we point it at the live
  // collector. `currentSpan` reads the request span the runtime publishes on the
  // context (`@keel/web`'s `currentRequestSpan`), so a query parents on it.
  const built = tracesFromEnv(
    { KEEL_OTLP_URL: collector.url, KEEL_OTLP_SERVICE: "integration" },
    {
      currentSpan: currentRequestSpan as CurrentSpan,
    },
  );

  if (built === undefined) throw new Error("tracesFromEnv returned undefined with a URL set");

  traces = built;

  // The db is instrumented with the tracer's onQuery seam: every executed query
  // becomes a `db.query` span, a child of the in-flight request span. We read the
  // request span off the context the runtime publishes — the production wiring.
  const db: Db = createDb(handle, { onQuery: traces.seams.onQuery });

  const app = keel()
    // A route that runs a real query, so its `db.query` span must be a child of
    // the request span.
    .get("/posts", async (c) => {
      const rows = await db.raw<{ id: number; title: string }>("SELECT id, title FROM posts");

      return c.json({ posts: rows });
    })
    // A route that runs no query — its request span stands alone.
    .get("/ping", (c) => c.json({ ok: true }));

  const config: KeelAppConfig = { db: handle, app };

  // Wire the request tracer + the traceparent parser, exactly as the CLI does:
  // every request mints a span (published on the context), and an inbound
  // `traceparent` joins one trace.
  server = await serve(await createApp(config), {
    port: 0,
    tracer: traces.requestTracer,
    parseTraceparent,
    logError: () => {},
  });

  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  collector.reset();
});

afterAll(async () => {
  await server.close();
  database.close();
  await collector.close();
});

/**
 * Flush and wait for the collector to receive at least `count` spans.
 *
 * The exporter buffers; a test flushes explicitly (rather than wait on the 5s
 * interval) and polls until the collector has the batch. Bounded so a genuine
 * failure surfaces as a timeout, not a hang.
 */
async function flushUntil(count: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await traces.flush();

    if (collector.spans.length >= count) return;

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("a served request produces a span in a local OTLP collector", () => {
  it("records an http.request span carrying method, path, and status", async () => {
    const response = await fetch(`${base}/ping`);

    expect(response.status).toBe(200);

    await flushUntil(1);

    const request = collector.byName("http.request");

    expect(request).toBeDefined();
    expect(request?.serviceName).toBe("integration");
    expect(request?.attributes["http.method"]).toBe("GET");
    expect(request?.attributes["http.path"]).toBe("/ping");
    expect(request?.attributes["http.status_code"]).toBe(200);
    expect(request?.statusCode).toBe(1); // OTLP "ok"
  });

  it("records a db.query as a CHILD span of the request span", async () => {
    const response = await fetch(`${base}/posts`);

    expect(response.status).toBe(200);
    expect((await response.json()).posts).toHaveLength(2);

    // Two spans: the request, and the query it ran.
    await flushUntil(2);

    const request = collector.byName("http.request");
    const query = collector.byName("db.query");

    expect(request).toBeDefined();
    expect(query).toBeDefined();

    // THE ACCEPTANCE: the query is a child of the request — same trace, parented
    // on the request span (the spanId truncates to 16 hex on the OTLP wire, which
    // the request span's own spanId does too, so they match).
    expect(query?.traceId).toBe(request?.traceId);
    expect(query?.parentSpanId).toBe(request?.spanId);
    expect(query?.attributes["db.statement"]).toContain("SELECT id, title FROM posts");
  });

  it("joins an inbound W3C traceparent: the request span continues the caller's trace", async () => {
    // A caller's trace, in the W3C spec's example shape.
    const trace = "4bf92f3577b34da6a3ce929d0e0e4736";
    const caller = "00f067aa0ba902b7";

    const response = await fetch(`${base}/ping`, {
      headers: { traceparent: `00-${trace}-${caller}-01` },
    });

    expect(response.status).toBe(200);

    await flushUntil(1);

    const request = collector.byName("http.request");

    // The request span belongs to the CALLER's trace (joined, not fresh), and
    // points back at the caller's span — one trace across the hop.
    expect(request?.traceId).toBe(trace);
    expect(request?.parentSpanId).toBe(caller);
  });
});

describe("the request span is published on the context for inline seams", () => {
  it("a seam fired inside the request context parents on the request span", async () => {
    // Mint a request span through the request tracer and publish it on a context,
    // exactly as the runtime does — then fire a seam inside that context and prove
    // its span is a child. This pins the context-publishing contract directly,
    // without depending on a particular route's query.
    const requestSpan = traces.requestTracer.startSpan("http.request");

    runWithContext({ requestId: "ctx-1", span: requestSpan }, () => {
      traces.seams.onEvent({ type: "login_succeeded", userId: "u1", at: 1 });
    });

    requestSpan.end();

    await flushUntil(2);

    const event = collector.byName("identity.login_succeeded");

    expect(event).toBeDefined();
    expect(event?.traceId).toBe(requestSpan.data.traceId);
    expect(event?.parentSpanId).toBe(requestSpan.data.spanId.slice(0, 16));
  });
});
