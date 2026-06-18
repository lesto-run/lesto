/**
 * An in-process OTLP/HTTP trace collector — the reusable harness for the
 * tracing integration legs.
 *
 * The acceptance for blocker #11 is "a served request produces a span in a local
 * OTLP collector." Rather than stand up a real OpenTelemetry collector (a heavy,
 * flaky external dependency in CI), this is a tiny `node:http` server that speaks
 * exactly the slice of the OTLP/HTTP JSON protocol Volo's `OtlpHttpExporter`
 * emits: it accepts `POST /v1/traces`, parses the `resourceSpans` envelope back
 * into flat span records, and records them for assertions.
 *
 * It is built REUSABLY on purpose: the node tier wires `serve({ tracer })` to it
 * here; Phase 3 (edge-deploy #3) stands the SAME collector in front of the
 * Cloudflare adapter and asserts the edge `waitUntil(flush())` lands a span in
 * it. The contract it verifies is the wire format both tiers share, so one
 * harness proves both.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

/**
 * One span, flattened back out of the OTLP envelope into the fields a test reads.
 * Mirrors `@volo/observability`'s `SpanData` plus the resource's `service.name`,
 * so an assertion can match by name, parent, status, and attribute without
 * re-walking the protocol's nested arrays.
 */
export interface CollectedSpan {
  readonly serviceName: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly statusCode: number;
  readonly attributes: Record<string, unknown>;
}

/** A running collector: its `/v1/traces` URL, the spans it has received, and a stop. */
export interface OtlpCollector {
  /** The endpoint to set as `VOLO_OTLP_URL`, e.g. `http://127.0.0.1:54321/v1/traces`. */
  readonly url: string;

  /** Every span received so far, in arrival order. */
  readonly spans: CollectedSpan[];

  /** Find the first span with this name, or `undefined`. */
  byName(name: string): CollectedSpan | undefined;

  /** Every span with this name, in arrival order. */
  allByName(name: string): CollectedSpan[];

  /** Reset the recorded spans between cases without restarting the server. */
  reset(): void;

  /** Stop the server. */
  close(): Promise<void>;
}

/** The OTLP attribute shape: a key paired with a tagged value union. */
interface OtlpAttribute {
  readonly key: string;
  readonly value: {
    readonly stringValue?: string;
    readonly boolValue?: boolean;
    readonly intValue?: string;
    readonly doubleValue?: number;
  };
}

/** Read one OTLP tagged value back to a JS value (the inverse of the exporter's mapping). */
function readValue(value: OtlpAttribute["value"]): unknown {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;

  return undefined;
}

/** Flatten an OTLP attribute list into a plain record. */
function readAttributes(attributes: readonly OtlpAttribute[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const attribute of attributes ?? []) {
    out[attribute.key] = readValue(attribute.value);
  }

  return out;
}

/** The OTLP/HTTP JSON trace-export envelope, as `OtlpHttpExporter` emits it. */
interface OtlpTraceRequest {
  readonly resourceSpans?: ReadonlyArray<{
    readonly resource?: { readonly attributes?: readonly OtlpAttribute[] };
    readonly scopeSpans?: ReadonlyArray<{
      readonly spans?: ReadonlyArray<{
        readonly traceId: string;
        readonly spanId: string;
        readonly parentSpanId?: string;
        readonly name: string;
        readonly status?: { readonly code?: number };
        readonly attributes?: readonly OtlpAttribute[];
      }>;
    }>;
  }>;
}

/** The `service.name` resource attribute, or `"unknown"` when absent. */
function serviceNameOf(attributes: readonly OtlpAttribute[] | undefined): string {
  const found = (attributes ?? []).find((attribute) => attribute.key === "service.name");

  return found?.value.stringValue ?? "unknown";
}

/** Decode one OTLP request body into the flat spans the harness records. */
function decodeSpans(body: OtlpTraceRequest): CollectedSpan[] {
  const spans: CollectedSpan[] = [];

  for (const resourceSpan of body.resourceSpans ?? []) {
    const serviceName = serviceNameOf(resourceSpan.resource?.attributes);

    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        spans.push({
          serviceName,
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          name: span.name,
          statusCode: span.status?.code ?? 0,
          attributes: readAttributes(span.attributes),
        });
      }
    }
  }

  return spans;
}

/** Read the whole request body off the socket as a UTF-8 string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Start the in-process collector on an ephemeral port.
 *
 * Resolves once listening, carrying the `/v1/traces` URL to hand to the tracer as
 * `VOLO_OTLP_URL`. Every `POST /v1/traces` is decoded and appended to `spans`;
 * any other request is a 404 (the collector speaks only the trace endpoint).
 */
export async function startOtlpCollector(): Promise<OtlpCollector> {
  const spans: CollectedSpan[] = [];

  // Read the OTLP body, decode + record its spans, and answer 200. A malformed
  // body is the exporter's bug to surface, not the collector's to crash on — we
  // record nothing and still answer 200, as a real collector would.
  const record = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readBody(req);

    try {
      spans.push(...decodeSpans(JSON.parse(raw) as OtlpTraceRequest));
    } catch {
      // ignore a malformed body — still answer 200 below
    }

    // OTLP/HTTP wants a 200 with an (here empty) ExportTraceServiceResponse.
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && (req.url ?? "").endsWith("/v1/traces")) {
      void record(req, res);

      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/v1/traces`,
    spans,
    byName: (name) => spans.find((span) => span.name === name),
    allByName: (name) => spans.filter((span) => span.name === name),
    reset: () => {
      spans.length = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
