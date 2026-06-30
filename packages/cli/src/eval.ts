/**
 * `lesto eval` (PREVIEW) — run an app's declared evals as a gate.
 *
 * The MCP control plane lets agents OPERATE a Lesto app; `@lesto/ai`'s evals hook
 * (ADR 0021) lets a developer SCORE a model's output against a rubric. This command
 * is the thin gate over that hook: it gathers an app's declared evals, runs them one
 * at a time, prints a pass/fail line for each, and exits non-zero the moment one
 * fails — the same discover→run-serially→non-zero-exit shape as the coverage gate.
 *
 * PREVIEW / opt-in, two ways. (1) `@lesto/ai` is a PREVIEW package below the
 * coverage gate, so this gate over it is preview too — the bin says so on the way
 * out. (2) An app that declares NO evals is NOT gated: zero exit, no output, no
 * auto-fail — adding `lesto eval` to a CI step can never break a build that has yet
 * to write its first eval.
 *
 * Like `run`, the brain is a pure, fully-injected core. The model transport / judge
 * is a STRUCTURAL dep handed to each declared eval, so the LLM-judge path is driven
 * in tests by a fake — no network — and this covered core imports NO `@lesto/ai`
 * types at all. The actual `@lesto/ai` resolution is a LAZY `await import("@lesto/ai")`
 * that lives ONLY in the bin's `loadEvals` wiring, so `@lesto/ai` never enters
 * `@lesto/cli`'s eager graph (the `@lesto/styles` / `@lesto/content-core` precedent).
 */

import { CliError } from "./errors";

/**
 * The outcome of scoring one output — the STRUCTURAL mirror of `@lesto/ai`'s
 * `EvalResult`. The covered core reads only these three fields (and branches on the
 * stable `code`, never on a message), so it depends on the SHAPE, not the type — and
 * `@lesto/ai` stays out of this package's eager import graph.
 */
export interface EvalResultLike {
  /** A score in [0, 1]; higher is better. */
  readonly score: number;
  /** Whether the output passed this eval's bar. */
  readonly passed: boolean;
  /** A stable code naming WHY it failed — branched on, never the message. */
  readonly code?: string;
}

/**
 * A scorer handed the case's input/output and the injected judge — the structural
 * `@lesto/ai` `Eval` plus the judge seam. A pure-function eval ignores the judge; an
 * LLM-judge eval calls it (in tests, a fake → no network). It may RETURN a failing
 * {@link EvalResultLike} OR THROW a guardrail's coded error (e.g. `AI_GUARDRAIL_BLOCKED`),
 * both of which the runner treats as a failure.
 */
export type DeclaredEvalRun = (
  input: string,
  output: string,
  judge: JudgeLike,
) => Promise<EvalResultLike>;

/**
 * The injected judge — a structural `@lesto/ai` `Eval`: score an output against a
 * rubric. Backed in the bin by a real `createLlmJudge` over the model transport; in
 * tests by a fake returning a fixed verdict, so the LLM-judge path needs no network.
 */
export type JudgeLike = (input: string, output: string) => Promise<EvalResultLike>;

/** One eval a project declares: a named case (input → expected-ish output) and its scorer. */
export interface DeclaredEval {
  /** The eval's name, for the gate's per-eval report line. */
  readonly name: string;
  /** The case input fed to the scorer. */
  readonly input: string;
  /** The model output under test. */
  readonly output: string;
  /** The scorer — see {@link DeclaredEvalRun}. */
  readonly run: DeclaredEvalRun;
}

/** The error code a guardrail eval throws when it refuses an output (`@lesto/ai`'s `AiError`). */
const GUARDRAIL_BLOCKED_CODE = "AI_GUARDRAIL_BLOCKED";

/** The seams `lesto eval` depends on — all injected, never imported live. */
export interface EvalDeps {
  /**
   * Gather the project's declared evals. The bin LAZY-imports `@lesto/ai` and reads
   * the app's declarations here, so `@lesto/ai` never enters the eager graph; tests
   * fake it with fixtures.
   */
  loadEvals: () => Promise<readonly DeclaredEval[]>;

  /**
   * The injected judge handed to every declared eval (the model transport's
   * `createLlmJudge`, faked in tests) — so an LLM-judge eval scores with no network.
   */
  judge: JudgeLike;

  /** Where a line of output goes (the bin passes `console.log`). */
  out: (line: string) => void;
}

/**
 * Read the stable `code` carried by a thrown guardrail error, or `undefined`.
 *
 * A guardrail eval refuses by THROWING `@lesto/ai`'s coded `AiError` rather than
 * returning a failing result. We branch on its `code` field structurally — never on
 * the message — exactly as the rest of Lesto reads coded errors across package
 * boundaries without importing the other side's error class.
 */
function thrownCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;

    if (typeof code === "string") return code;
  }

  return undefined;
}

/**
 * Run one declared eval to a pass/fail verdict.
 *
 * Two failure shapes are unified: a scorer that RETURNS `{ passed: false }`, and a
 * GUARDRAIL that THROWS its coded refusal. A thrown `AI_GUARDRAIL_BLOCKED` is the
 * deliberate guardrail signal — caught and reported as a fail, carrying the code so
 * the gate's line names WHY. Any OTHER thrown error is a real bug in the eval and is
 * rethrown, never swallowed as "the output failed".
 */
async function scoreOne(declared: DeclaredEval, judge: JudgeLike): Promise<EvalResultLike> {
  try {
    return await declared.run(declared.input, declared.output, judge);
  } catch (error) {
    if (thrownCode(error) === GUARDRAIL_BLOCKED_CODE) {
      return { score: 0, passed: false, code: GUARDRAIL_BLOCKED_CODE };
    }

    // Not a guardrail refusal — a genuine fault in the eval itself. Surface it.
    throw error;
  }
}

/**
 * Run the app's declared evals as a gate (PREVIEW).
 *
 * Gathers the declarations via the injected loader and, when there are any, runs
 * them SERIALLY — printing a `pass`/`fail` line per eval (a failing line names the
 * code) and a final tally. Returns `0` iff every eval passed; the first failure
 * makes the exit non-zero, so a CI step fails loudly.
 *
 * The opt-in floor: NO declared evals → no output, exit `0`. An app that has not
 * written an eval is never auto-failed by wiring this command into CI.
 */
export async function runEval(_args: readonly string[], deps: EvalDeps): Promise<number> {
  const evals = await deps.loadEvals();

  // PREVIEW / opt-in: an app that declares no evals is not gated. Silent zero exit,
  // never an auto-fail — adding `lesto eval` to CI can't break a yet-evalless build.
  if (evals.length === 0) return 0;

  let failures = 0;

  // Serial, deliberately — like the coverage gate: an LLM-judge eval makes a network
  // call, and a flood of concurrent judge requests would only invite provider rate
  // limits without making a gate any more correct.
  for (const declared of evals) {
    const result = await scoreOne(declared, deps.judge);

    if (result.passed) {
      deps.out(`eval ${declared.name}: pass (score ${result.score})`);
    } else {
      failures += 1;

      // The code is the machine-readable WHY; absent (a plain failing result), the
      // line still names the eval and its score.
      const reason = result.code === undefined ? "" : ` [${result.code}]`;

      deps.out(`eval ${declared.name}: fail (score ${result.score})${reason}`);
    }
  }

  if (failures > 0) {
    deps.out(`eval: ${failures} of ${evals.length} failed`);

    throw new CliError("CLI_EVAL_FAILED", `${failures} eval(s) failed.`, {
      failed: failures,
      total: evals.length,
    });
  }

  deps.out(`eval: ${evals.length} passed`);

  return 0;
}
