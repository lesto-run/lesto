import { beforeEach, describe, expect, it } from "vitest";

import { runEval } from "../src/eval";
import { CliError } from "../src/errors";
import type { DeclaredEval, EvalDeps, EvalResultLike, JudgeLike } from "../src/eval";

// A pure-function eval: scores from the case alone, ignoring the injected judge.
const passingEval: DeclaredEval = {
  name: "is-polite",
  input: "Q?",
  output: "Sure!",
  run: async () => ({ score: 1, passed: true }),
};

const failingEval: DeclaredEval = {
  name: "is-concise",
  input: "Q?",
  output: "rambling...",
  run: async () => ({ score: 0.2, passed: false, code: "TOO_LONG" }),
};

// A failing eval that carries NO code — the line still names the eval + score.
const failingEvalNoCode: DeclaredEval = {
  name: "is-grounded",
  input: "Q?",
  output: "made up",
  run: async () => ({ score: 0, passed: false }),
};

// A GUARDRAIL eval: refuses by THROWING `@lesto/ai`'s coded error, not by returning.
const guardrailEval: DeclaredEval = {
  name: "no-profanity",
  input: "Q?",
  output: "***",
  run: async () => {
    throw new CodedError("AI_GUARDRAIL_BLOCKED", "Output was blocked by a guardrail.");
  },
};

// An LLM-judge eval: scores by CALLING the injected judge (a fake → no network),
// proving the judge path is driven structurally without `@lesto/ai`.
const judgeEval: DeclaredEval = {
  name: "is-helpful",
  input: "Q?",
  output: "A.",
  run: (input, output, judge) => judge(input, output),
};

// A throwing eval whose error is NOT a guardrail refusal — a real bug, rethrown.
const buggyEval: DeclaredEval = {
  name: "broken",
  input: "Q?",
  output: "A.",
  run: async () => {
    throw new Error("boom");
  },
};

// A throwing eval whose error carries a `code` that is NOT a string — `thrownCode`
// reads no guardrail code off it, so it is rethrown (a non-string code is not a
// guardrail refusal), not swallowed as a fail.
const numericCodeError = { code: 500 };

const buggyNumericCodeEval: DeclaredEval = {
  name: "broken-numeric-code",
  input: "Q?",
  output: "A.",
  run: () => Promise.reject(numericCodeError),
};

// A minimal coded error, shaped like `@lesto/ai`'s `AiError` (a `.code` field) — so
// the test exercises the structural code branch without importing `@lesto/ai`.
class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// A non-Error thrown value carrying a guardrail code — proves the structural read
// works on a plain object, not just an `Error` instance.
const guardrailPlainObjectEval: DeclaredEval = {
  name: "no-pii",
  input: "Q?",
  output: "ssn",
  run: () => Promise.reject({ code: "AI_GUARDRAIL_BLOCKED" }),
};

// A pass-through judge fake: scores 0.9 / passed. Captures its calls so a test can
// assert the LLM-judge path actually reached the injected judge (no network).
function fakeJudge(verdict: EvalResultLike = { score: 0.9, passed: true }): {
  judge: JudgeLike;
  calls: { input: string; output: string }[];
} {
  const calls: { input: string; output: string }[] = [];

  return {
    judge: (input, output) => {
      calls.push({ input, output });

      return Promise.resolve(verdict);
    },
    calls,
  };
}

let lines: string[];

function depsWith(overrides: Partial<EvalDeps> = {}): EvalDeps {
  return {
    loadEvals: () => Promise.resolve([]),
    judge: () => Promise.resolve({ score: 1, passed: true }),
    out: (line) => lines.push(line),
    ...overrides,
  };
}

beforeEach(() => {
  lines = [];
});

describe("runEval", () => {
  it("exits zero and prints nothing when the app declares no evals (PREVIEW opt-in)", async () => {
    const code = await runEval([], depsWith({ loadEvals: () => Promise.resolve([]) }));

    expect(code).toBe(0);
    expect(lines).toEqual([]);
  });

  it("runs declared evals serially and reports a pass line + tally when all pass", async () => {
    const code = await runEval([], depsWith({ loadEvals: () => Promise.resolve([passingEval]) }));

    expect(code).toBe(0);
    expect(lines).toEqual(["eval is-polite: pass (score 1)", "eval: 1 passed"]);
  });

  it("throws a coded CLI_EVAL_FAILED (non-zero exit) when an eval fails", async () => {
    await expect(
      runEval([], depsWith({ loadEvals: () => Promise.resolve([passingEval, failingEval]) })),
    ).rejects.toMatchObject({ code: "CLI_EVAL_FAILED", details: { failed: 1, total: 2 } });

    expect(lines).toEqual([
      "eval is-polite: pass (score 1)",
      "eval is-concise: fail (score 0.2) [TOO_LONG]",
      "eval: 1 of 2 failed",
    ]);
  });

  it("surfaces the failure as a CliError instance the boundary can branch on", async () => {
    const error = await runEval(
      [],
      depsWith({ loadEvals: () => Promise.resolve([failingEval]) }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CliError);
  });

  it("reports a failing eval that carries no code without a bracketed reason", async () => {
    await expect(
      runEval([], depsWith({ loadEvals: () => Promise.resolve([failingEvalNoCode]) })),
    ).rejects.toMatchObject({ code: "CLI_EVAL_FAILED" });

    expect(lines).toEqual(["eval is-grounded: fail (score 0)", "eval: 1 of 1 failed"]);
  });

  it("treats a thrown AI_GUARDRAIL_BLOCKED as a fail, branching on the code not a message", async () => {
    await expect(
      runEval([], depsWith({ loadEvals: () => Promise.resolve([guardrailEval]) })),
    ).rejects.toMatchObject({ code: "CLI_EVAL_FAILED" });

    expect(lines).toEqual([
      "eval no-profanity: fail (score 0) [AI_GUARDRAIL_BLOCKED]",
      "eval: 1 of 1 failed",
    ]);
  });

  it("reads the guardrail code structurally off a non-Error thrown value", async () => {
    await expect(
      runEval([], depsWith({ loadEvals: () => Promise.resolve([guardrailPlainObjectEval]) })),
    ).rejects.toMatchObject({ code: "CLI_EVAL_FAILED" });

    expect(lines).toEqual([
      "eval no-pii: fail (score 0) [AI_GUARDRAIL_BLOCKED]",
      "eval: 1 of 1 failed",
    ]);
  });

  it("drives the LLM-judge path through the injected judge with no network", async () => {
    const { judge, calls } = fakeJudge();

    const code = await runEval(
      [],
      depsWith({ loadEvals: () => Promise.resolve([judgeEval]), judge }),
    );

    expect(code).toBe(0);
    expect(calls).toEqual([{ input: "Q?", output: "A." }]);
    expect(lines).toEqual(["eval is-helpful: pass (score 0.9)", "eval: 1 passed"]);
  });

  it("fails the gate when the injected judge scores below the bar", async () => {
    const { judge } = fakeJudge({ score: 0.1, passed: false, code: "AI_EVAL_FAILED" });

    await expect(
      runEval([], depsWith({ loadEvals: () => Promise.resolve([judgeEval]), judge })),
    ).rejects.toMatchObject({ code: "CLI_EVAL_FAILED" });

    expect(lines).toEqual([
      "eval is-helpful: fail (score 0.1) [AI_EVAL_FAILED]",
      "eval: 1 of 1 failed",
    ]);
  });

  it("rethrows a non-guardrail error from an eval rather than swallowing it as a fail", async () => {
    await expect(
      runEval([], depsWith({ loadEvals: () => Promise.resolve([buggyEval]) })),
    ).rejects.toThrow("boom");

    // The eval crashed before any verdict line; no fail tally is printed.
    expect(lines).toEqual([]);
  });

  it("rethrows an error whose code is not a string (not a guardrail refusal)", async () => {
    await expect(
      runEval([], depsWith({ loadEvals: () => Promise.resolve([buggyNumericCodeEval]) })),
    ).rejects.toBe(numericCodeError);

    expect(lines).toEqual([]);
  });
});
