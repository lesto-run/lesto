#!/usr/bin/env node
// `bun run ws:typecheck`: every `@lesto/*` package's `typecheck`, at most TYPECHECK_CONCURRENCY at
// a time. Why the cap exists is in `scripts/lib/workspace-typecheck.mjs`.
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TYPECHECK_CONCURRENCY,
  readWorkspacePackages,
  runLimited,
  selectTypecheckPackages,
  spawnTypecheck,
  summarizeFailures,
} from "./lib/workspace-typecheck.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const packages = selectTypecheckPackages(readWorkspacePackages(root));

console.log(`ws:typecheck: ${packages.length} packages, ${TYPECHECK_CONCURRENCY} at a time`);

const results = await runLimited(packages, TYPECHECK_CONCURRENCY, async ({ name, dir }) => {
  const result = await spawnTypecheck(join(root, dir));
  const status = result.code === 0 ? "ok" : "FAILED";

  console.log(`\n── ${name}: ${status}`);
  if (result.output.trim() !== "") console.log(result.output.trimEnd());

  return { name, ...result };
});

const failures = summarizeFailures(results);

if (failures !== null) {
  console.error(`\n${failures}`);
  process.exit(1);
}

console.log(`\nws:typecheck passed: ${packages.length} packages.`);
