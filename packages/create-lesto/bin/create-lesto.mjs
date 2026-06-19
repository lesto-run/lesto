#!/usr/bin/env node
// The `npm create lesto` / `npx create-lesto` entry, runnable under plain node.
//
// Lesto ships TypeScript (the real entry is ../src/bin.ts). `bun` runs it
// natively, but `npm create` / `npx` invoke this bin under node, which cannot
// load `.ts` without a loader. jiti registers that loader for the whole import
// graph, then we run the TS entry — so an outsider with only node installed gets
// a working scaffolder. Resolved relative to THIS file (not the user's cwd), so
// jiti is found in the installed package regardless of where the command runs.
import { createJiti } from "jiti";

await createJiti(import.meta.url).import("../src/bin.ts");
