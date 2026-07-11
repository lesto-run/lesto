import { describe, expect, it } from "vitest";

import { createAnthropic, DEFAULT_MODEL_ID } from "../src/anthropic";
import { AiError } from "../src/errors";
import { createLlmJudge, DEFAULT_JUDGE_MODEL_ID, guard } from "../src/evals";
import { createOpenAICompatible } from "../src/openai-compatible";

import { constantTransport, jsonResponse, openaiTextMessage, textMessage } from "./fake-transport";

import type { Eval } from "../src/evals";

const passingEval: Eval = async () => ({ score: 1, passed: true });

const blockingEval: Eval = async () => ({ score: 0.1, passed: false, code: "PROFANITY" });

const blockingEvalNoCode: Eval = async () => ({ score: 0, passed: false });

describe("createLlmJudge", () => {
  it("passes when the judge's score meets the threshold", async () => {
    const { transport, requests } = constantTransport(jsonResponse(textMessage("0.9")));
    const model = createAnthropic({ apiKey: "sk-test", transport });

    const judge = createLlmJudge({ model, rubric: "Score helpfulness 0..1.", threshold: 0.7 });
    const result = await judge("Q?", "A.");

    expect(result.passed).toBe(true);
    expect(result.score).toBeCloseTo(0.9);
    expect(result.code).toBeUndefined();

    // Inherits the INJECTED model's own default id (Anthropic's here), not a
    // hardcoded judge id, and applies the rubric as system.
    const sent = (await requests[0]?.json()) as Record<string, unknown>;
    expect(sent["model"]).toBe(DEFAULT_MODEL_ID);
    expect(sent["system"]).toBe("Score helpfulness 0..1.");
  });

  it("runs on an OpenAI-compatible model's OWN id, never a Claude id (F24)", async () => {
    // A judge over Ollama/LM Studio must request THAT server's model, not a Claude
    // id — stamping `DEFAULT_JUDGE_MODEL_ID` here asked an OpenAI endpoint for a
    // Claude model (AI_HTTP_ERROR). The judge inherits the model's `defaultModelId`.
    const { transport, requests } = constantTransport(jsonResponse(openaiTextMessage("0.8")));
    const model = createOpenAICompatible({
      baseURL: "http://localhost:11434/v1",
      apiKey: "sk-test",
      defaultModelId: "llama3.2",
      transport,
    });

    const result = await createLlmJudge({ model, rubric: "r", threshold: 0.5 })("Q", "A");

    expect(result.passed).toBe(true);
    const sent = (await requests[0]?.json()) as Record<string, unknown>;
    expect(sent["model"]).toBe("llama3.2");
    expect(sent["model"]).not.toBe(DEFAULT_JUDGE_MODEL_ID);
  });

  it("fails with a code when the score is below the threshold", async () => {
    const { transport } = constantTransport(jsonResponse(textMessage("The score is 0.2 overall.")));
    const model = createAnthropic({ apiKey: "sk-test", transport });

    const judge = createLlmJudge({ model, rubric: "r", threshold: 0.5, failCode: "TOO_WEAK" });
    const result = await judge("Q", "A");

    expect(result.passed).toBe(false);
    expect(result.score).toBeCloseTo(0.2);
    expect(result.code).toBe("TOO_WEAK");
  });

  it("clamps an out-of-range verdict into [0, 1]", async () => {
    const { transport } = constantTransport(jsonResponse(textMessage("1.7")));
    const model = createAnthropic({ apiKey: "sk-test", transport });

    const result = await createLlmJudge({ model, rubric: "r" })("Q", "A");

    expect(result.score).toBe(1);
  });

  it("treats a number-less verdict as a failed score of 0", async () => {
    const { transport } = constantTransport(jsonResponse(textMessage("no idea")));
    const model = createAnthropic({ apiKey: "sk-test", transport });

    const result = await createLlmJudge({ model, rubric: "r" })("Q", "A");

    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("honors an overridden judge model id", async () => {
    const { transport, requests } = constantTransport(jsonResponse(textMessage("1")));
    const model = createAnthropic({ apiKey: "sk-test", transport });

    await createLlmJudge({ model, rubric: "r", modelId: "claude-haiku-4-5-20251001" })("Q", "A");

    const sent = (await requests[0]?.json()) as Record<string, unknown>;
    expect(sent["model"]).toBe("claude-haiku-4-5-20251001");
  });
});

describe("guard", () => {
  it("returns the output unchanged when the guard passes", async () => {
    expect(await guard("safe output", "input", passingEval)).toBe("safe output");
  });

  it("refuses with AI_GUARDRAIL_BLOCKED carrying the eval's score and code", async () => {
    const error = await guard("bad", "input", blockingEval).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_GUARDRAIL_BLOCKED");
    expect((error as AiError).details["score"]).toBeCloseTo(0.1);
    expect((error as AiError).details["evalCode"]).toBe("PROFANITY");
  });

  it("omits evalCode in details when the failing eval reports none", async () => {
    const error = await guard("bad", "input", blockingEvalNoCode).catch((e: unknown) => e);

    expect((error as AiError).details["evalCode"]).toBeUndefined();
    expect((error as AiError).details).not.toHaveProperty("evalCode");
  });
});
