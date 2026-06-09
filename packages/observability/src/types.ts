/**
 * The vocabulary of a trace.
 *
 * The shape mirrors OpenTelemetry so an OTel exporter can be a thin future
 * adapter — but we take no dependency on OTel here. Time and identity are
 * injected (a `Clock`, an id-generator) so every span is deterministic in tests.
 */

/** Wall-clock time, made injectable. Returns epoch milliseconds. */
export type Clock = () => number;

/** A span's lifecycle verdict: unset until decided, then ok or error. */
export type SpanStatus = "unset" | "ok" | "error";

/** The flat, exportable record behind a live span. */
export interface SpanData {
  readonly traceId: string;
  readonly spanId: string;

  /** Absent on a root span; the parent's spanId on a child. */
  parentSpanId?: string;

  readonly name: string;

  readonly startedAt: number;
  endedAt?: number;

  attributes: Record<string, unknown>;
  status: SpanStatus;
}

/** A live span: a fluent handle over its `data`, ended exactly once. */
export interface Span {
  setAttribute(key: string, value: unknown): this;
  setStatus(status: SpanStatus): this;
  end(): void;

  readonly data: SpanData;
}

/** A sink for finished spans. The InMemoryExporter is the canonical test double. */
export interface SpanExporter {
  export(span: SpanData): void;
}
