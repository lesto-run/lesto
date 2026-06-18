/**
 * Errors carry codes, not just prose.
 *
 * Every failure in Lesto surfaces a stable, machine-readable `code`. Logs,
 * tests, API responses, and the MCP surface branch on the code — never on a
 * message string, which is free to change for humans without breaking machines.
 */

import { LestoError } from "@lesto/errors";

export { LestoError };

export type BenchErrorCode =
  /** A run was asked for zero (or fewer) iterations — there is nothing to measure. */
  | "BENCH_EMPTY_RUN"
  /** A statistic was asked of an empty sample set — a percentile of nothing is undefined. */
  | "BENCH_NO_SAMPLES"
  /** A percentile outside the closed interval [0, 100] was requested. */
  | "BENCH_PERCENTILE_OUT_OF_RANGE"
  /** Concurrency was non-positive — a load loop needs at least one worker. */
  | "BENCH_INVALID_CONCURRENCY";

/** Anything the benchmark harness can refuse to do. */
export class BenchError extends LestoError<BenchErrorCode> {
  constructor(code: BenchErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "BenchError";
  }
}
