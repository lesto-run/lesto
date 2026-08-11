#!/usr/bin/env node
// The `lesto` executable, runnable under plain node.
//
// This loads the CLI's own entry through jiti — in-repo the source `../src/bin.ts` (dev, no
// build); in a PUBLISHED install the source is stripped and the built `../dist/bin.js` runs.
// jiti stays a runtime dependency for that reason — it is NOT only a dev shim.
//
// It does NOT, however, make jiti the loader for the USER's project. jiti tries a NATIVE import
// of this entry first and only transpiles when that THROWS, and an entry node imported natively
// keeps node's own `import()` for everything it loads later. In-repo the native attempt always
// throws (workspace `@lesto/*` resolve to `src/*.ts`), so jiti does take over and the difference
// is invisible; in a published install every `@lesto/*` is built `dist/*.js`, native succeeds,
// and it does not. So `src/bin.ts` holds its OWN jiti instance for project files rather than
// relying on this one — see `src/project-module.ts` for the mechanism and the bug it fixes.
//
// NOTE: `lesto dev`'s island bundling still calls Bun's bundler (`bunBuildClientDeps`); that command
// needs bun. Every other command — `serve`, `generate`, `mcp`, `openapi`, `deploy`, `routes` — runs
// under node here.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const entry = existsSync(fileURLToPath(new URL("../src/bin.ts", import.meta.url)))
  ? "../src/bin.ts"
  : "../dist/bin.js";

// jsx config matches the framework tsconfig (`jsx: react-jsx`, default react import source) so jiti
// transpiles the `.tsx` in the CLI's and the user app's @lesto/ui/@lesto/web import graph;
// `react/jsx-runtime` is an installed dependency.
await createJiti(import.meta.url, {
  jsx: { runtime: "automatic", importSource: "react" },
}).import(entry);
