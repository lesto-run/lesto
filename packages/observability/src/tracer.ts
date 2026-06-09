import { randomHexId } from "./ids";
import { systemClock } from "./time";

import type { Clock, Span, SpanData, SpanExporter, SpanStatus } from "./types";

/** What a Tracer needs from the outside world. Everything that varies is injected. */
export interface TracerOptions {
  readonly exporter: SpanExporter;

  /** Defaults to the system wall clock (epoch ms). */
  readonly clock?: Clock;

  /** Defaults to a random hex id. */
  readonly idGenerator?: () => string;
}

/** Where a new span sits in the tree, and what it starts knowing. */
export interface StartSpanOptions {
  /** Given a parent, the new span joins its trace as a child; absent, it roots a fresh trace. */
  readonly parent?: Span;

  readonly attributes?: Record<string, unknown>;
}

/**
 * A live span. The fluent setters return `this`, so attributes and status read
 * as a chain; `end()` stamps the end time from the clock and hands the data to
 * the exporter — exactly once per span.
 */
class LiveSpan implements Span {
  readonly data: SpanData;

  constructor(
    data: SpanData,
    private readonly clock: Clock,
    private readonly exporter: SpanExporter,
  ) {
    this.data = data;
  }

  setAttribute(key: string, value: unknown): this {
    this.data.attributes[key] = value;

    return this;
  }

  setStatus(status: SpanStatus): this {
    this.data.status = status;

    return this;
  }

  end(): void {
    this.data.endedAt = this.clock();

    this.exporter.export(this.data);
  }
}

/**
 * The Tracer mints spans and wires them to the exporter.
 *
 * A root span gets a fresh traceId and no parent; a child inherits its parent's
 * traceId and points back at the parent spanId. Every span — root or child —
 * gets its own fresh spanId.
 */
export class Tracer {
  private readonly exporter: SpanExporter;

  private readonly clock: Clock;

  private readonly idGenerator: () => string;

  constructor(options: TracerOptions) {
    this.exporter = options.exporter;
    this.clock = options.clock ?? systemClock;
    this.idGenerator = options.idGenerator ?? randomHexId;
  }

  startSpan(name: string, options: StartSpanOptions = {}): Span {
    const parent = options.parent;

    // A child shares its parent's trace; a root opens a new one.
    const traceId = parent === undefined ? this.idGenerator() : parent.data.traceId;

    const data: SpanData = {
      traceId,
      spanId: this.idGenerator(),
      ...(parent === undefined ? {} : { parentSpanId: parent.data.spanId }),
      name,
      startedAt: this.clock(),
      attributes: { ...options.attributes },
      status: "unset",
    };

    return new LiveSpan(data, this.clock, this.exporter);
  }

  /**
   * Run `fn` inside a span: start it, await the result, end the span, return the
   * value. If `fn` throws, mark the span "error", end it, and rethrow — the
   * caller's failure is recorded but never swallowed.
   */
  async withSpan<T>(
    name: string,
    fn: (span: Span) => T | Promise<T>,
    options: StartSpanOptions = {},
  ): Promise<T> {
    const span = this.startSpan(name, options);

    try {
      return await fn(span);
    } catch (error) {
      span.setStatus("error");

      throw error;
    } finally {
      span.end();
    }
  }
}
