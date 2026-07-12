# @lesto/assets

> Lesto's client-asset pipeline — synthesize the island hydration entry from an app/islands convention and bundle it (Vite/Rolldown for `lesto build`, sharing one bundler with the dev island server; Bun.build as the dev fallback; splitting + the opt-in preact dialect), so an app ships an optimized /client.js with no bespoke build script.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/assets
```

```ts
import { buildClient, viteBuildClientDeps } from "@lesto/assets";

// The framework synthesizes the island entry from your app/islands/ convention
// and bundles it — no hand-authored client.tsx, no bespoke build script.
const deps = viteBuildClientDeps(projectRoot);

await buildClient(
  { islandsDir, outDir, mode: "production", dialect: "preact" },
  deps,
); // emits an optimized /client.js
```

[Docs](https://docs.lesto.run) · [Agent-readable docs](https://docs.lesto.run/llms.txt)
