/**
 * The evals / guardrails hook (ADR 0021, Increment 4).
 *
 * An `Eval` is a pure function `(input, output) => Promise<EvalResult>`. That is
 * the whole abstraction — an LLM-judge eval is just an `Eval` that itself calls
 * `generateText` (the judge model defaults to a current Claude), so the pattern
 * composes with the model layer with zero new machinery. A guardrail is an eval
 * run before return that can REFUSE: a failed guard throws a coded error the
 * boundary maps to an HTTP response.
 *
 * This ships the HOOK — a typed seam + the LLM-judge composition + a guarded
 * runner — not an evals harness, dataset runner, or dashboard (ADR 0021: name
 * the seam, defer the convenience layer).
 */

import { AiError } from "./errors";
import { generateText } from "./generate";

import type { LanguageModel, Message } from "./types";

/** The outcome of scoring one output. */
export interface EvalResult {
  /** A score in [0, 1]; higher is better. */
  readonly score: number;
  /** Whether the output passed this eval's bar. */
  readonly passed: boolean;
  /** A stable code naming WHY it failed, surfaced in a guardrail's error details. */
  readonly code?: string;
}

/** A scorer: given the model's input and output, return a pass/fail score. Pure. */
export type Eval = (input: string, output: string) => Promise<EvalResult>;

export interface JudgeOptions {
  /** The model that renders the verdict — defaults to a current Claude (Sonnet 4.6). */
  readonly model: LanguageModel;
  /** The rubric the judge applies, stated as a system prompt. */
  readonly rubric: string;
  /** The pass bar in [0, 1]. An output scoring at or above this passes. Defaults to 0.5. */
  readonly threshold?: number;
  /** The code reported when the judge fails the output. Defaults to `AI_EVAL_FAILED`. */
  readonly failCode?: string;
  /** Override the judge model id. Defaults to `claude-sonnet-4-6`. */
  readonly modelId?: string;
}

/** The judge model id used when a judge does not override it (a current Claude). */
export const DEFAULT_JUDGE_MODEL_ID = "claude-sonnet-4-6";

const DEFAULT_THRESHOLD = 0.5;

/**
 * Build an LLM-judge {@link Eval}: ask a model to score an output 0–1 against a
 * rubric. It is an ordinary `Eval` that calls `generateText`, so it is driven in
 * tests by the same fake transport the model layer uses — no network.
 *
 *   const judge = createLlmJudge({ model, rubric: "Score helpfulness 0..1." });
 *   const result = await judge(question, answer);
 *
 * The judge is asked for a bare number; an unparseable verdict scores 0 (failed)
 * rather than throwing — a judge that misbehaves should fail the output safely,
 * not crash the request.
 */
export function createLlmJudge(options: JudgeOptions): Eval {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const failCode = options.failCode ?? "AI_EVAL_FAILED";

  return async (input, output) => {
    const messages: Message[] = [
      {
        role: "user",
        content: `Input:\n${input}\n\nOutput:\n${output}\n\nReturn only a number from 0 to 1.`,
      },
    ];

    const { text } = await generateText({
      model: options.model,
      system: options.rubric,
      modelId: options.modelId ?? DEFAULT_JUDGE_MODEL_ID,
      messages,
    });

    const score = parseScore(text);
    const passed = score >= threshold;

    return passed ? { score, passed } : { score, passed, code: failCode };
  };
}

/**
 * Run `output` through a guardrail {@link Eval} and return it unchanged if it
 * passes — otherwise refuse with a coded `AI_GUARDRAIL_BLOCKED` carrying the
 * eval's own code and score in `details`, so the boundary can map a blocked
 * output to a deliberate HTTP response instead of leaking it.
 *
 *   const safe = await guard(answer, question, profanityCheck);
 */
export async function guard(output: string, input: string, check: Eval): Promise<string> {
  const result = await check(input, output);

  if (!result.passed) {
    throw new AiError("AI_GUARDRAIL_BLOCKED", "Output was blocked by a guardrail.", {
      score: result.score,
      ...(result.code === undefined ? {} : { evalCode: result.code }),
    });
  }

  return output;
}

/**
 * Parse the judge's verdict into a clamped score.
 *
 * The judge is prompted for a bare number, but models add prose; we take the
 * first number we find and clamp to [0, 1]. No number at all is a failed verdict
 * (score 0), not an exception.
 */
function parseScore(text: string): number {
  const match = text.match(/-?\d+(?:\.\d+)?/);

  if (match === null) {
    return 0;
  }

  const value = Number.parseFloat(match[0]);

  if (Number.isNaN(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}
