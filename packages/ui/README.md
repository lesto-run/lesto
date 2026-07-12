# @lesto/ui

> Lesto's AI-native UI rendering engine core — validate a JSON UI tree and render it to React against a vetted component registry.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/ui
```

```tsx
import { Registry, treeJsonSchema, validateTree } from "@lesto/ui";

// A vetted component registry — the model can only emit what you allow.
const registry = new Registry().define({
  name: "Box",
  props: {},
  children: true,
  render: (_props, kids) => <div>{kids}</div>,
});

const schema = treeJsonSchema(registry); // constrain the model's JSON output

const tree = { type: "Box", children: ["hello"] }; // the AI emits plain JSON
const { valid, errors } = validateTree(registry, tree); // pure, React-free
```

This barrel is isomorphic (React-free); the server renderer lives behind
`@lesto/ui/server` and the browser hydration runtime behind `@lesto/ui/client`.

[Docs](https://docs.lesto.run/batteries/components) · [Agent-readable docs](https://docs.lesto.run/llms.txt)
