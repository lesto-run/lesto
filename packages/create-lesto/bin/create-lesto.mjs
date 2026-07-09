#!/usr/bin/env node
// The `npm create lesto` / `npx create-lesto` entry, runnable under plain node.
//
// Loads its entry through jiti (which registers the TS loader for the scaffolder's graph): in-repo
// the source `../src/bin.ts` (dev, no build); in a PUBLISHED install the source is stripped and the
// built `../dist/bin.js` runs. jiti is a runtime dependency so an outsider with only node installed
// gets a working scaffolder either way.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const entry = existsSync(fileURLToPath(new URL("../src/bin.ts", import.meta.url)))
  ? "../src/bin.ts"
  : "../dist/bin.js";

await createJiti(import.meta.url).import(entry);
