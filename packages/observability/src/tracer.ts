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

/**
 * An inbound trace adopted from a W3C `traceparent` — the cross-process join.
 *
 * Unlike {@link StartSpanOptions.parent} (a live `Span` we hold), this carries
 * ONLY the ids another system sent: the `traceId` to continue and the `parentId`
 * (the caller's 16-hex span) to point back at. The runtime parses an inbound
 * `traceparent` into this shape so the request's root span joins the upstream
 * trace instead of starting a fresh one.
 */
export interface InboundTrace {
  readonly traceId: string;

  readonly parentId: string;
}

/** Where a new span sits in the tree, and what it starts knowing. */
export interface StartSpanOptions {
  /** Given a parent, the new span joins its trace as a child; absent, it roots a fresh trace. */
  readonly parent?: Span;

  /**
   * Given an inbound trace (parsed from a W3C `traceparent`), the new span
   * continues THAT trace: it adopts the inbound `traceId` and points back at the
   * inbound `parentId`. Used for the cross-process join — a request's root span
   * joining the caller's trace. Ignored when {@link parent} is also set (a live
   * parent wins, since it carries a real span we own).
   */
  readonly inbound?: InboundTrace;

  readonly attributes?: Record<string, unknown>;
}

/**
 * A live span. The fluent setters return `this`, so attributes and status read
 * as a chain; `end()` stamps the end time from the clock and hands the data to
 * the exporter — exactly once per span.
 */
class LiveSpan implements Span {
  readonly data: SpanData;

  /** A span ends exactly once; a second `end()` is a no-op, never a re-export. */
  private ended = false;

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
    // Idempotent: the first call stamps the end time and exports; any later call
    // returns silently so a span is never double-counted (e.g. an explicit
    // `end()` inside a `withSpan` body plus the `finally`'s `end()`).
    if (this.ended) return;

    this.ended = true;

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
    const inbound = options.inbound;

    // The trace this span belongs to, and the span it points back at, in order of
    // precedence: a live parent we own (its trace, its span) > an inbound trace
    // adopted from a `traceparent` (its trace id, the caller's span) > a fresh
    // root (a new trace, no parent).
    const traceId =
      parent !== undefined
        ? parent.data.traceId
        : inbound !== undefined
          ? inbound.traceId
          : this.idGenerator();

    const parentSpanId =
      parent !== undefined
        ? parent.data.spanId
        : inbound !== undefined
          ? inbound.parentId
          : undefined;

    const data: SpanData = {
      traceId,
      spanId: this.idGenerator(),
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
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
