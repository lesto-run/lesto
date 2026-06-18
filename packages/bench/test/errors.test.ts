import { describe, expect, it } from "vitest";

import { BenchError, LestoError } from "../src/index";

describe("BenchError", () => {
  it("is a LestoError carrying a stable code and frozen details", () => {
    const error = new BenchError("BENCH_EMPTY_RUN", "nothing to run", { iterations: 0 });

    expect(error).toBeInstanceOf(LestoError);
    expect(error.code).toBe("BENCH_EMPTY_RUN");
    expect(error.name).toBe("BenchError");
    expect(error.details).toEqual({ iterations: 0 });
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it("defaults details to an empty object when omitted", () => {
    const error = new BenchError("BENCH_NO_SAMPLES", "no samples");

    expect(error.details).toEqual({});
  });
});
