/**
 * The estate's AI concierge — the first `@lesto/ai` route consumer, and the
 * dogfood that puts an agent run on the SAME request trace as the HTTP request
 * that drove it (ADR 0031 Phase 2 / Inc 4).
 *
 * `POST /mls/api/assistant` is an authenticated route: a signed-in visitor asks a
 * natural-language question, and a bounded `runAgent` loop answers it, grounding
 * every reply in the live MLS through a `searchListings` tool. Wired with the
 * `Tracer`→`AgentTracer` adapter below, one such request puts `ai.generate` and
 * `ai.tool` spans on the SAME trace as its `http.request` span, in the OTLP
 * collector estate already exports to — the "agent and LLM calls appear on the
 * same trace as your request" claim, made real on a real app. (The illustrative
 * `http.request → ai.generate → ai.tool → db.query` chain is one FLAT trace, not
 * a nesting: each `ai.*` span parents directly on the request span, and the
 * `db.query` leg is the authed identity read this route makes, not a tool query.)
 *
 * The route is provider-agnostic by construction: the model is injected. The
 * committed default is a deterministic {@link localAssistantModel}, a REAL
 * `LanguageModel` with no network, so the demo — and the `lesto dev` loop, and
 * the edge deploy — answers with zero secrets; set `ANTHROPIC_API_KEY` and the
 * SAME route talks to a real Claude model instead (see {@link resolveAssistantModel}).
 * The span tree emits wherever a tracer is wired (the OTLP demo, and the node
 * tracing test); the `lesto dev` loop and the edge deploy run the route untraced.
 * This mirrors estate's demo-mode ethos: safe, self-contained defaults, real wiring.
 *
 * Layering (ADR 0031 Inc 4): the AI spans route through the app's ordinary
 * `Tracer` — the adapter here parents each on `currentRequestSpan` — NOT through
 * `traces.seams`, a closed `TraceSeams` set with no `ai.*` member. estate is the
 * seam that legitimately depends on BOTH `@lesto/ai` and `@lesto/observability`;
 * neither package depends on the other. The two packages RE-STATE the shared span
 * vocabulary rather than import across the layer; the estate test is where they
 * are asserted equal (it imports both and compares the constants).
 */

import { currentRequestSpan, lesto } from "@lesto/web";
import type { Context, Lesto } from "@lesto/web";

import { AiError, createAnthropic, runAgent } from "@lesto/ai";
import type {
  AgentTracer,
  GenerateOptions,
  GenerateResult,
  LanguageModel,
  Message,
  StreamDelta,
  ToolSet,
  ToolSpec,
  Transport,
} from "@lesto/ai";

import type { CurrentSpan, Tracer } from "@lesto/observability";

import { formatPrice, LISTINGS } from "./listings";

/** A signed-in visitor, resolved by the tier's own auth (identity on node, signed tokens on edge). */
export interface AssistantUser {
  readonly id: string;
  readonly name: string;
}

/**
 * Resolve the caller's user from the request, or `undefined` when signed out.
 *
 * Injected because the two tiers authenticate differently: the node app reads
 * the durable `Identity` (which runs a DB query — the `db.query` leg of the
 * dogfood trace), the edge twin verifies a stateless signed token. The route is
 * blind to which; it only asks "who is this?".
 */
export type AssistantAuth = (c: Context) => Promise<AssistantUser | undefined>;

/** The observability wiring the route accepts — both optional, so dev/edge work untraced. */
export interface AssistantWiring {
  /** The model the agent runs against. Absent → the committed local demo model. */
  readonly model?: LanguageModel;

  /**
   * The injected tracer that lands `ai.generate`/`ai.tool` spans on the request
   * trace (built by {@link agentTracerFrom}). Absent → span emission is a clean
   * no-op and the loop is byte-unchanged.
   */
  readonly tracer?: AgentTracer;
}

/** Everything {@link buildAssistantRoutes} needs: the auth seam plus the observability wiring. */
export interface AssistantDeps extends AssistantWiring {
  readonly authenticate: AssistantAuth;
}

/** The model id the local demo model reports (surfaced as the `ai.model` span attribute). */
const LOCAL_MODEL_ID = "lesto-local-demo";

/** The tool the concierge calls to ground its answers in the live MLS. */
const SEARCH_TOOL = "searchListings";

/** The concierge's standing instructions — read by a real model, ignored by the local one. */
const ASSISTANT_SYSTEM =
  "You are the Jade Mills Estates concierge. Ground every answer in the live MLS by calling the " +
  "searchListings tool before you reply; keep answers short and factual.";

/**
 * Search the demo's listings for the homes named or located by `query`.
 *
 * Lenient by design: it asks which listings the query *mentions* (so a whole
 * sentence like "homes in Malibu" still finds the Malibu listing), and falls
 * back to the full set when nothing matches — a demo tool never dead-ends. In a
 * real app this is where the ORM / content store query lives; here the data is
 * the in-memory {@link LISTINGS} constant (the example is about the trace, not
 * the data layer).
 */
const searchListings: ToolSpec = {
  description:
    "Search the Jade Mills MLS for homes by neighborhood or name; returns each match with its price and size.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to search for — a neighborhood or a home's name.",
      },
    },
    required: ["query"],
  },
  execute: async (input) => {
    const query = String(input["query"] ?? "").toLowerCase();

    const matches = LISTINGS.filter(
      (listing) =>
        query.includes(listing.neighborhood.toLowerCase()) ||
        query.includes(listing.title.toLowerCase()),
    );

    const shown = matches.length > 0 ? matches : LISTINGS;

    return shown
      .map(
        (listing) =>
          `${listing.title} in ${listing.neighborhood} (${formatPrice(listing.price)}, ${listing.beds}bd/${listing.baths}ba)`,
      )
      .join("; ");
  },
};

/** The concierge's tool set, keyed by the name the model calls. */
const ASSISTANT_TOOLS: ToolSet = { [SEARCH_TOOL]: searchListings };

/** The first user turn's text, or `""` — what the local model routes into the search query. */
function firstUserText(messages: readonly Message[]): string {
  const first = messages.find((message) => message.role === "user");

  return first !== undefined && typeof first.content === "string" ? first.content : "";
}

/** The most recent `tool_result` block's content, or `undefined` if the tool has not run yet. */
function lastToolResult(messages: readonly Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content;

    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === "tool_result") return block.content;
    }
  }

  return undefined;
}

/**
 * The committed, deterministic demo model — a real `LanguageModel` with no
 * network, so the AI route (and its span tree) works with zero secrets.
 *
 * It scripts exactly the two-turn shape a grounded agent takes: turn one asks to
 * run `searchListings` with the visitor's question as the query; once the loop
 * feeds the result back (a `tool_result` block appears), turn two answers from
 * it and stops. That is one `ai.tool` span between two `ai.generate` spans — the
 * exact sub-tree a real model would produce, minted without a provider. State
 * rides through the request/response body (never a closure), so it is reentrant
 * across concurrent requests.
 */
export function localAssistantModel(): LanguageModel {
  const decide = (options: GenerateOptions): GenerateResult => {
    const priorResult = lastToolResult(options.messages);

    // The tool has run — answer from its output and stop.
    if (priorResult !== undefined) {
      return {
        text: `Here's what I found in the Jade Mills MLS: ${priorResult}`,
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 32, outputTokens: 40 },
      };
    }

    // First turn — ask to search, routing the visitor's question in as the query.
    return {
      text: "",
      toolCalls: [
        {
          id: "call_search_1",
          name: SEARCH_TOOL,
          input: { query: firstUserText(options.messages) },
        },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 48, outputTokens: 16 },
    };
  };

  const encode = (options: GenerateOptions): Request =>
    new Request("https://local.invalid/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(decide(options)),
    });

  return {
    defaultModelId: LOCAL_MODEL_ID,
    buildRequest: encode,
    buildStreamRequest: encode,
    transport: async (request) =>
      new Response(await request.text(), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    parseResponse: async (response) => JSON.parse(await response.text()) as GenerateResult,
    // The concierge never streams (it uses `runAgent`/`generateText`); a stream
    // request is an honest, coded refusal rather than a silent empty stream.
    parseStream(): AsyncIterable<StreamDelta> {
      throw new AiError("AI_INVALID_OPTION", "the local demo model does not support streaming.");
    },
  };
}

/** What {@link resolveAssistantModel} reads to choose a model. */
export interface ResolveModelOptions {
  /** An Anthropic API key. Present and non-empty → a real Claude model; else the local demo model. */
  readonly apiKey?: string;

  /** An injected HTTP transport for the real model (tests drive it off canned responses). */
  readonly transport?: Transport;
}

/**
 * Choose the concierge's model from the environment: a real Anthropic model when
 * an API key is set, the committed {@link localAssistantModel} otherwise.
 *
 * The absent-key default is what makes the dogfood self-contained — the demo, the
 * dev loop, and the public edge deploy all answer (and trace) with no secret. Set
 * `ANTHROPIC_API_KEY` and the identical route talks to a real model.
 */
export function resolveAssistantModel(options: ResolveModelOptions = {}): LanguageModel {
  if (options.apiKey !== undefined && options.apiKey !== "") {
    return createAnthropic({
      apiKey: options.apiKey,
      ...(options.transport === undefined ? {} : { transport: options.transport }),
    });
  }

  return localAssistantModel();
}

/**
 * Adapt an observability {@link Tracer} to the `@lesto/ai` {@link AgentTracer}
 * seam, parenting every AI span on the in-flight request span (ADR 0031 Inc 4).
 *
 * This is the load-bearing adapter the plan calls for. `AgentTracer.startSpan`
 * takes a FLAT attribute bag, but `Tracer.startSpan(name, options)` reads its
 * attributes from `options.attributes` — so the bag is placed there (a raw pass
 * would silently drop every attribute), and the parent is read from
 * `currentRequestSpan` so the span joins the request's trace instead of rooting
 * its own. `currentRequestSpan` returns the transport-free `RequestContextSpan`,
 * a structural subset of `Span`; the cast is the same one `serve.ts` makes when
 * it wires the tracer's `currentSpan`.
 */
export function agentTracerFrom(tracer: Tracer): AgentTracer {
  const requestSpan = currentRequestSpan as CurrentSpan;

  return {
    startSpan(name, attributes) {
      const parent = requestSpan();

      const span = tracer.startSpan(name, {
        ...(parent === undefined ? {} : { parent }),
        attributes,
      });

      return {
        setAttributes: (attrs) => {
          for (const [key, value] of Object.entries(attrs)) span.setAttribute(key, value);
        },
        setStatus: (status) => {
          span.setStatus(status);
        },
        end: () => {
          span.end();
        },
      };
    },
  };
}

/** Pull the `prompt` out of a JSON (`{ prompt }`) or urlencoded (`prompt=…`) request body. */
function readPrompt(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const value = (body as Record<string, unknown>)["prompt"];

    return typeof value === "string" ? value.trim() : "";
  }

  if (typeof body === "string") {
    return new URLSearchParams(body).get("prompt")?.trim() ?? "";
  }

  return "";
}

/**
 * The concierge sub-app: `POST /mls/api/assistant`, composed onto both the node
 * and edge estate apps via `.route(...)`.
 *
 * Gated — a signed-out caller is a 401, never an anonymous LLM call. A signed-in
 * caller's question drives a bounded `runAgent` loop over the injected model and
 * the `searchListings` tool; with the tracer wired, the loop's `ai.generate` and
 * `ai.tool` spans land on the request trace. The response is the grounded answer,
 * the tools each step invoked, and the summed token usage.
 */
export function buildAssistantRoutes(deps: AssistantDeps): Lesto {
  const model = deps.model ?? localAssistantModel();

  return lesto().post("/mls/api/assistant", async (c: Context) => {
    const user = await deps.authenticate(c);

    if (user === undefined) return c.json({ error: "sign in required" }, 401);

    const prompt = readPrompt(c.req.body);

    if (prompt === "") return c.json({ error: "a prompt is required" }, 400);

    try {
      const result = await runAgent({
        model,
        tools: ASSISTANT_TOOLS,
        // Name the visitor so a real model answers by name; the local demo model
        // ignores the system prompt, so this leaves its deterministic output intact.
        messages: [{ role: "user", content: prompt }],
        system: `${ASSISTANT_SYSTEM} You are speaking with ${user.name}.`,
        maxSteps: 4,
        ...(deps.tracer === undefined ? {} : { tracer: deps.tracer }),
      });

      return c.json({
        answer: result.text,
        steps: result.steps.map((step) => step.toolCalls.map((call) => call.name)),
        usage: result.usage,
      });
    } catch (error) {
      // A recoverable model/agent failure (the coded `AiError` — an upstream 429/529,
      // a bad key, an over-budget loop) degrades to a shaped 503, not a bare 500. The
      // errored `ai.generate` span already recorded it on the trace; anything else
      // (a bug) propagates. This path matters on the real-model deploy, not the demo.
      if (error instanceof AiError) {
        return c.json({ error: "the assistant is unavailable, please try again" }, 503);
      }

      throw error;
    }
  });
}
