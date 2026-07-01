/**
 * The tool / agent loop (ADR 0021, Increment 2).
 *
 * The model emits a tool call, we run the tool, feed the result back, and loop
 * until the model stops or a step budget is hit. Deciding (which tool, when to
 * stop) is separated from calling (the transport), so the whole loop is driven
 * in tests by a scripted fake transport returning canned `tool_use` turns — the
 * "separate deciding from timing" discipline (CONVENTIONS).
 *
 * Bounded by construction: an agent that loops forever is a bug that surfaces
 * loudly as `AI_MAX_STEPS_EXCEEDED`, never a hang.
 */

import { AiError } from "./errors";
import { generateText } from "./generate";
import { AI_ERROR_CODE_ATTR, AI_TOOL_NAME_ATTR, AI_TOOL_SPAN } from "./spans";

import type {
  AgentTracer,
  ContentBlock,
  LanguageModel,
  Message,
  ToolCall,
  ToolSet,
  Usage,
} from "./types";

export interface RunAgentOptions {
  readonly model: LanguageModel;
  /** The conversation so far. The loop appends assistant + tool turns onto a copy. */
  readonly messages: readonly Message[];
  /** Tools the agent may call. An unknown name the model asks for is refused, coded. */
  readonly tools: ToolSet;
  readonly system?: string;
  readonly modelId?: string;
  readonly maxTokens?: number;
  /** The step ceiling. Each model turn is one step. Must be ≥ 1. Defaults to 8. */
  readonly maxSteps?: number;
  /**
   * An optional injected tracer (ADR 0031 Phase 2, PREVIEW). Present → each model turn opens
   * an `ai.generate` span (via `generateText`) and each tool run opens an `ai.tool` span;
   * absent → no telemetry, unchanged behaviour. Injected, never global — the app parents these
   * on the in-flight request span so an agent run rides the same trace as the request.
   */
  readonly tracer?: AgentTracer;
}

/** One step the agent took: the tool calls it made and the results they produced. */
export interface AgentStep {
  readonly toolCalls: readonly ToolCall[];
  readonly toolResults: readonly string[];
}

/** A finished agent run. */
export interface AgentResult {
  /** The model's final text once it stopped asking for tools. */
  readonly text: string;
  /** Every step taken, in order — the audit trail of what the agent did. */
  readonly steps: readonly AgentStep[];
  /** Total token usage summed across every model turn. */
  readonly usage: Usage;
}

const DEFAULT_MAX_STEPS = 8;

/**
 * Drive a bounded tool-use loop to completion.
 *
 *   const { text } = await runAgent({ model, messages, tools, maxSteps: 6 });
 *
 * Each iteration calls the model; if it asked for tools, we dispatch each by name
 * (an unregistered name is `AI_TOOL_NOT_FOUND`), append the model's turn and the
 * tool results to the conversation, and loop. We stop when the model returns text
 * without a tool request. Exceeding `maxSteps` throws `AI_MAX_STEPS_EXCEEDED`.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;

  if (maxSteps < 1) {
    throw new AiError("AI_INVALID_OPTION", `maxSteps must be at least 1; got ${maxSteps}.`, {
      maxSteps,
    });
  }

  // The loop owns a growing copy of the conversation; the caller's array is never
  // mutated. Each turn appends the assistant's request and the tool answers, so
  // the model sees the full exchange on the next call.
  const conversation: Message[] = [...options.messages];
  const steps: AgentStep[] = [];

  let inputTokens = 0;
  let outputTokens = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    const result = await generateText({
      model: options.model,
      messages: conversation,
      ...(options.system === undefined ? {} : { system: options.system }),
      ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      tools: options.tools,
      // Thread the tracer through so each model turn emits its own `ai.generate` span on the
      // same trace as the `ai.tool` spans below — one agent run, one connected sub-tree.
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    });

    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;

    // No tool request → the model is done. Return its text and the trail.
    if (result.stopReason !== "tool_use" || result.toolCalls.length === 0) {
      return {
        text: result.text,
        steps,
        usage: { inputTokens, outputTokens },
      };
    }

    const toolResults = await runTools(result.toolCalls, options.tools, options.tracer);

    steps.push({ toolCalls: result.toolCalls, toolResults });

    // Replay the assistant's tool request as content blocks, then answer each with a
    // `tool_result` carrying the matching id — the exact shape the Messages API needs
    // to continue a tool exchange. A plain-text echo here would be rejected by the API.
    conversation.push({ role: "assistant", content: assistantTurn(result.text, result.toolCalls) });
    conversation.push({ role: "user", content: toolResultTurn(result.toolCalls, toolResults) });
  }

  throw new AiError("AI_MAX_STEPS_EXCEEDED", `Agent did not finish within ${maxSteps} steps.`, {
    maxSteps,
  });
}

/**
 * Run every tool the model asked for this turn, in order.
 *
 * An unknown tool name is a coded `AI_TOOL_NOT_FOUND` refusal, never a silent
 * skip — a model hallucinating a tool must surface, not pass through quietly.
 *
 * When a tracer is injected (ADR 0031 Phase 2, PREVIEW) each call opens one `ai.tool` span,
 * named by the tool the model invoked: `ok` around a successful execution (the span wraps the
 * `execute` call, so it carries the tool's real duration), `error` when the executor throws or
 * when the tool is unregistered (that span also records the `AI_TOOL_NOT_FOUND` code). Absent a
 * tracer, no span is opened and the loop is byte-unchanged.
 */
async function runTools(
  calls: readonly ToolCall[],
  tools: ToolSet,
  tracer?: AgentTracer,
): Promise<string[]> {
  const results: string[] = [];

  for (const call of calls) {
    // Own-property lookup only: a model that hallucinates a tool named `__proto__` or
    // `constructor` would otherwise resolve a prototype member instead of refusing.
    const tool = Object.hasOwn(tools, call.name) ? tools[call.name] : undefined;

    if (tool === undefined) {
      const error = new AiError(
        "AI_TOOL_NOT_FOUND",
        `Model asked for unregistered tool "${call.name}".`,
        { name: call.name },
      );

      // Record the hallucinated call as an errored `ai.tool` span carrying the coded refusal —
      // opened here (not before the lookup) so the code can ride in the start-time attribute bag.
      const span = tracer?.startSpan(AI_TOOL_SPAN, {
        [AI_TOOL_NAME_ATTR]: call.name,
        [AI_ERROR_CODE_ATTR]: error.code,
      });
      span?.setStatus("error");
      span?.end();

      throw error;
    }

    const span = tracer?.startSpan(AI_TOOL_SPAN, { [AI_TOOL_NAME_ATTR]: call.name });

    try {
      const result = await tool.execute(call.input);
      span?.setStatus("ok");
      span?.end();
      results.push(result);
    } catch (error) {
      // The executor's own failure (an arbitrary throw, not necessarily coded) — mark the span
      // error and propagate; the loop does not swallow a tool's exception.
      span?.setStatus("error");
      span?.end();

      throw error;
    }
  }

  return results;
}

/**
 * Replay the assistant's turn as content blocks: its text (if any) followed by a
 * `tool_use` block per call. There is always ≥1 tool_use block here (the no-tool
 * case returned earlier), so the turn is never the empty content the API rejects.
 */
function assistantTurn(text: string, calls: readonly ToolCall[]): ContentBlock[] {
  const blocks: ContentBlock[] = text === "" ? [] : [{ type: "text", text }];

  for (const call of calls) {
    blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
  }

  return blocks;
}

/** Answer each tool call with a `tool_result` block keyed by the id the API pairs on. */
function toolResultTurn(calls: readonly ToolCall[], results: readonly string[]): ContentBlock[] {
  return calls.map((call, index) => ({
    type: "tool_result",
    toolUseId: call.id,
    content: results[index] ?? "",
  }));
}
