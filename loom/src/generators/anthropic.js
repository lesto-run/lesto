// The real, model-backed generator. Uses the live registry's JSON Schema as a
// forced tool input_schema so Claude emits a structurally-valid UI tree. The
// SDK is imported dynamically so `@anthropic-ai/sdk` is only required when you
// actually generate with a model — the mock path needs no credentials.
//
// Model: claude-opus-4-8 (per Anthropic's current guidance). The recursive tree
// schema can't be *strictly* enforced by the API, so forcing the tool gets us
// well-formed output and validateTree() is the backstop that guarantees it.

import { treeJsonSchema, componentCatalog } from '../manifest.js';

const SYSTEM = `You are Loom, a UI generation engine. You compose user interfaces
by emitting a tree of pre-approved React components — never code. You design
clean, modern, well-structured pages: a Page at the root, usually a Navbar, a
Hero, one or more Sections with Grids of Features or PricingTiers, and a Footer.

Rules:
- Use ONLY the components provided in the tool schema. Never invent component types.
- Honor each component's required props and prop types exactly.
- Write real, specific copy — never lorem ipsum or placeholder text.
- Prefer composition: Sections containing Grids containing Features/Cards.
- Keep the tree's root a single Page component.`;

export async function anthropicGenerate(prompt, opts = {}) {
  const Anthropic = await loadSdk();
  const client = new Anthropic(); // resolves ANTHROPIC_API_KEY from env

  const tool = {
    name: 'render_ui',
    description:
      'Render a user interface by providing its component tree. The tree root must be a Page.',
    input_schema: treeJsonSchema(),
  };

  const message = await client.messages.create({
    model: opts.model || 'claude-opus-4-8',
    max_tokens: 16000,
    system: SYSTEM,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'render_ui' },
    messages: [
      {
        role: 'user',
        content:
          `Component reference (for your understanding; the tool schema is authoritative):\n` +
          `${JSON.stringify(componentCatalog(), null, 2)}\n\n` +
          `Design and render this UI: ${prompt}`,
      },
    ],
  });

  const toolUse = message.content.find((b) => b.type === 'tool_use');
  if (!toolUse) throw new Error('Model did not return a UI tree (no tool_use block).');
  return toolUse.input;
}

async function loadSdk() {
  try {
    const mod = await import('@anthropic-ai/sdk');
    return mod.default;
  } catch {
    throw new Error(
      "The model-backed generator needs '@anthropic-ai/sdk'. Install it with `npm i @anthropic-ai/sdk`, " +
        'or generate with the offline mock (`loom generate "..." --mock`).'
    );
  }
}
