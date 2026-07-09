#!/usr/bin/env node
// The `lesto` executable, runnable under plain node.
//
// The CLI runs the USER's TypeScript project (their `lesto.app.ts`, `env.ts`, routes, and their
// @lesto/* imports), so it ALWAYS loads its entry through jiti — jiti registers the TS+TSX loader
// for that whole runtime graph. What differs is only WHICH entry: in-repo the source `../src/bin.ts`
// (dev, no build); in a PUBLISHED install the source is stripped and the built `../dist/bin.js` runs
// (jiti passes the already-compiled CLI through and still handles the user's TS). jiti stays a
// runtime dependency for exactly this reason — it is NOT only a dev shim.
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
