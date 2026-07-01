/**
 * Test doubles for the injected `AgentTracer` seam (ADR 0031 Phase 2, PREVIEW).
 *
 * `recordingTracer` captures every span `@lesto/ai` opens — its name, attribute bag, and
 * final status — so a test asserts the exact `ai.generate` / `ai.tool` spans emitted with NO
 * `@lesto/observability` dependency (the layering line — `@lesto/ai` stays dependency-free).
 *
 * The second double, `observabilityShapedTracer`, exists to guard the ATTRIBUTE-DROP TRAP: a
 * real `@lesto/observability` `Tracer.startSpan(name, options)` reads attributes only from
 * `options.attributes`, so handing it `@lesto/ai`'s flat bag as the 2nd arg would silently drop
 * every one. `agentTracerAdapter` is the documented recipe (ADR 0031 Inc 4) an app writes to
 * bridge the two; a test drives a generation through it and asserts the bag survives — without
 * importing observability, by replicating its `startSpan` signature faithfully here.
 */

import type { AgentSpan, AgentTracer } from "../src/types";

/** A span `recordingTracer` captured: its name, start-time attributes, and lifecycle. */
export interface RecordedSpan {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
  status: "unset" | "ok" | "error";
  ended: boolean;
}

/** An `AgentTracer` that records every span opened, for direct assertion in a test. */
export function recordingTracer(): { tracer: AgentTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];

  const tracer: AgentTracer = {
    startSpan(name, attributes) {
      const span: RecordedSpan = { name, attributes, status: "unset", ended: false };
      spans.push(span);

      const handle: AgentSpan = {
        setStatus(status) {
          span.status = status;
        },
        end() {
          span.ended = true;
        },
      };

      return handle;
    },
  };

  return { tracer, spans };
}

/** The `StartSpanOptions` shape a real `@lesto/observability` `Tracer` reads (attributes nested). */
interface StartSpanOptionsLike {
  readonly attributes?: Record<string, unknown>;
}

/** The observability `Span` shape the adapter drives — attributes captured at start. */
interface ObservabilitySpanLike {
  setStatus(status: "unset" | "ok" | "error"): void;
  end(): void;
}

/** A minimal stand-in for `@lesto/observability`'s `Tracer`, signature-faithful (see file doc). */
interface TracerLike {
  startSpan(name: string, options?: StartSpanOptionsLike): ObservabilitySpanLike;
}

/**
 * A `Tracer`-shaped fake that, exactly like the real one, reads attributes ONLY from
 * `options.attributes` — so a flat bag passed as the 2nd arg lands as `undefined` (the trap).
 */
export function observabilityShapedTracer(): {
  tracer: TracerLike;
  spans: { name: string; attributes: Record<string, unknown> | undefined; status: string }[];
} {
  const spans: { name: string; attributes: Record<string, unknown> | undefined; status: string }[] =
    [];

  const tracer: TracerLike = {
    startSpan(name, options) {
      const record = { name, attributes: options?.attributes, status: "unset" };
      spans.push(record);

      return {
        setStatus(status) {
          record.status = status;
        },
        end() {
          /* nothing to record for the drop-trap assertion */
        },
      };
    },
  };

  return { tracer, spans };
}

/**
 * The documented `Tracer`→`AgentTracer` adapter recipe (ADR 0031 Inc 4): it MUST nest the flat
 * bag under `attributes`, never pass it as the raw 2nd arg. This is the one line an app writes;
 * the test that drives `generateText` through it guards it against the attribute-drop regression.
 */
export function agentTracerAdapter(tracer: TracerLike): AgentTracer {
  return {
    startSpan(name, attributes) {
      const span = tracer.startSpan(name, { attributes });

      return {
        setStatus: (status) => span.setStatus(status),
        end: () => span.end(),
      };
    },
  };
}
