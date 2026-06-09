# 🧵 Loom

**An AI-native React rendering engine.** The AI emits a validated *UI tree*; Loom weaves it into React. Built on React 19 + Vite 6.

Pairs with [Tracks](../) (the Rails-like backend) — Loom is the frontend rendering layer.

## The idea

Instead of asking a model to write React *code* (which you then have to compile and sandbox), Loom has the model emit a **serializable component tree** against a **vetted component registry**:

```json
{
  "type": "Page",
  "children": [
    { "type": "Hero", "props": { "title": "Ship faster", "ctaLabel": "Start" } },
    { "type": "PricingTable", "props": { "plan": "pro" } }
  ]
}
```

Loom renders that to real React. Three consequences fall out of this one decision:

1. **Safe by construction.** Only registered components can ever render — no arbitrary code execution. Untrusted text is HTML-escaped; malformed nodes degrade to a diagnostic (dev) or nothing (prod) instead of crashing the page.
2. **The registry *is* the AI's vocabulary.** Each component declares a prop schema once; that single declaration powers runtime validation, the human-readable manifest, **and** a recursive JSON Schema handed to the model as a forced tool input — so the model physically cannot emit an invalid component.
3. **No model in the request path.** Generation happens at **build/author time** and produces a static JSON artifact. Serving a page reads that artifact and runs the renderer — native React speed, fully cacheable.

## Why this stack (not Vinxi)

The 2024-era answer was Vinxi. It's not anymore: **TanStack Start ripped Vinxi out** for a plain Vite plugin, and Next/Astro never used it. Vite 6's **Environment API** (+ `@vitejs/plugin-rsc`) now does natively what Vinxi abstracted — so Loom builds directly on Vite 6, one fewer layer, more performant. RSC streaming is the natural next upgrade.

## Quick start

```bash
npm install

# Generate a UI tree from a prompt (offline mock generator — no API key needed)
node bin/loom.js generate "a SaaS landing page with pricing" -o pages/home.json

# Serve it (SSR + hydration + HMR)
node bin/loom.js dev          # → http://localhost:5173/p/home
```

With `ANTHROPIC_API_KEY` set, generation uses Claude (`claude-opus-4-8`) with the registry's JSON Schema as a forced tool — the model designs the page; the registry constrains it.

## CLI

```
loom generate "<prompt>" [-o pages/x.json] [--mock]   Generate a UI tree artifact
loom dev [--port N]                                   SSR dev server (HMR + hydration)
loom render <name> [-o file.html]                     Static SSR → standalone HTML (no JS)
loom build                                            Render every page → dist/*.html
loom manifest [--json|--schema]                       The contract the AI designs against
loom components                                       List the component vocabulary
```

## How it fits together

```
prompt ─▶ generator ─▶ raw tree ─▶ validateTree (repair) ─▶ pages/x.json   ← build time (AI here)
                                                                  │
                                                                  ▼
                       request ─▶ load artifact ─▶ renderTree ─▶ React ─▶ HTML+hydrate   ← request time (no AI)
```

| Piece | Role | File |
|---|---|---|
| **Registry** | the closed set of components the AI may use | `src/registry.js` |
| **Component library** | 14 vetted, styled React primitives | `src/components/index.jsx` |
| **Schema** | prop validation + JSON-Schema compilation | `src/schema.js` |
| **Manifest** | recursive tree schema + catalog the AI reads | `src/manifest.js` |
| **Renderer** | UI tree → React, with per-node error boundaries | `src/render.jsx` |
| **Validator** | React-free build-time validate + repair | `src/validate.js` |
| **Generators** | offline `mock` + `anthropic` (forced-tool) | `src/generators/` |
| **SSR server** | Vite middleware, SSR + hydration per route | `server.js` |

## Adding a component

Define it once — schema and AI-vocabulary follow automatically:

```jsx
defineComponent('Testimonial', {
  description: 'A customer quote with attribution.',
  props: {
    quote:  { type: 'string', required: true },
    author: { type: 'string', required: true },
    role:   { type: 'string' },
  },
  children: false,
  render: (p) => (
    <figure>
      <blockquote>{p.quote}</blockquote>
      <figcaption>{p.author}{p.role ? `, ${p.role}` : ''}</figcaption>
    </figure>
  ),
});
```

The model can now use `Testimonial` immediately — it appears in the manifest, the JSON Schema, and validation.

## Test

```bash
npx vitest run     # 13 tests: registry, schema, renderer, XSS safety, validation, generation
```

## License

MIT.
