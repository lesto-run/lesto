/**
 * Generate a validated @keel/ui tree from a prompt.
 *
 * The registry is the vetted vocabulary. We turn it into a JSON Schema and hand
 * the model that schema as a *forced* tool — `render_ui` — so the model can only
 * emit shapes the registry admits. The actual model call is injected (`Complete`)
 * so this core is pure and 100% testable; the real Anthropic adapter lives apart.
 *
 * The flow: build the tool, compose a system prompt, call the model, then
 * validate whatever came back against the registry. A model is not trusted — its
 * output is always re-validated before it reaches a caller.
 */

import { treeJsonSchema, validateTree } from "@keel/ui";
import type { Registry } from "@keel/ui";

import { GenerateError } from "./errors";

/**
 * The injected model call. Given a system prompt, a user prompt, and a forced
 * tool, it returns the tool's input — the UI tree as plain JSON.
 */
export type Complete = (request: {
  system: string;
  prompt: string;
  tool: { name: string; description: string; inputSchema: object };
}) => Promise<unknown>;

/** The verdict of a generation: the tree, whether it validated, and why not. */
export interface GenerateResult {
  tree: unknown;
  valid: boolean;
  errors: Array<{ path: string; type: string; detail?: string }>;
}

/** The forced tool's name — the model emits a UI tree by "calling" this. */
const TOOL_NAME = "render_ui";

/** The forced tool's description — short, model-facing. */
const TOOL_DESCRIPTION =
  "Render a UI by emitting a tree composed only of the registered components.";

/**
 * Compose the system prompt. It frames the one rule that matters: compose ONLY
 * registered components — the schema enforces it, but saying it plainly steers
 * the model toward valid output the first time.
 */
function systemPrompt(): string {
  return [
    "You generate user interfaces as a tree of components.",
    "Compose ONLY the registered components described by the render_ui tool's schema.",
    "Do not invent component types, props, or children that the schema does not allow.",
    "Call the render_ui tool exactly once with the complete UI tree.",
  ].join("\n");
}

/**
 * Generate a UI tree for `prompt`, constrained to and validated against
 * `registry`. Throws `GENERATE_NO_OUTPUT` when the model returns nothing.
 */
export async function generateUi(options: {
  registry: Registry;
  prompt: string;
  complete: Complete;
}): Promise<GenerateResult> {
  const { registry, prompt, complete } = options;

  const inputSchema = treeJsonSchema(registry);

  const tool = {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    inputSchema,
  };

  const tree = await complete({ system: systemPrompt(), prompt, tool });

  // A model that returns nothing is a hard failure, not an empty tree — the
  // caller asked for UI and got silence.
  if (tree === null || tree === undefined) {
    throw new GenerateError("GENERATE_NO_OUTPUT", "model returned no tool output", {
      tool: TOOL_NAME,
    });
  }

  const { valid, errors } = validateTree(registry, tree);

  return { tree, valid, errors };
}
