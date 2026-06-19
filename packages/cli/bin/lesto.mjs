#!/usr/bin/env node
// The `lesto` executable, runnable under plain node.
//
// Lesto ships TypeScript (the real entry is ../src/bin.ts). `bun` runs it
// natively, but when an outsider installs `@lesto/cli` and runs `lesto` under
// node, `.ts` cannot load without a loader. jiti registers that loader for the
// whole import graph, then we run the TS entry. Resolved relative to THIS file
// (not the user's cwd), so jiti resolves from the installed package wherever the
// command is invoked.
//
// NOTE: `lesto dev`'s island bundling still calls Bun's bundler
// (`bunBuildClientDeps`); that command needs bun. Every other command — `serve`,
// `generate`, `mcp`, `openapi`, `deploy`, `routes` — runs under node here.
import { createJiti } from "jiti";

// jsx config matches the framework's tsconfig (`jsx: react-jsx`, default react
// import source) so jiti transpiles the `.tsx` in the CLI's @lesto/ui/@lesto/web
// import graph; `react/jsx-runtime` is an installed dependency under node.
await createJiti(import.meta.url, {
  jsx: { runtime: "automatic", importSource: "react" },
}).import("../src/bin.ts");
