#!/usr/bin/env node
// Fail fast with a clear message when the active node is older than the version
// the suite needs, instead of letting `ws:test` detonate ~600 tests on a cryptic
// better-sqlite3 NODE_MODULE_VERSION ABI mismatch. `engines.node` already declares
// ">=22"; this enforces it at the point tests run (nothing else does, so a fresh
// contributor on the PATH-default node hits the worst onboarding cliff).
//
// Runs under the PATH node — the same node that loads better-sqlite3's native
// binding when vitest runs — so it checks exactly the runtime that would break.

const REQUIRED_MAJOR = 22;

const major = Number.parseInt(process.versions.node.split(".")[0], 10);

if (major < REQUIRED_MAJOR) {
  process.stderr.write(
    `\nLesto needs Node >= ${REQUIRED_MAJOR} — you are on ${process.version}.\n\n` +
      `The test suite loads a native better-sqlite3 binding whose ABI must match the\n` +
      `running node; an older node detonates the suite with NODE_MODULE_VERSION errors.\n\n` +
      `Fix: \`nvm use\` (an .nvmrc pins ${REQUIRED_MAJOR}), then — if you switched node\n` +
      `AFTER installing — re-run \`bun install\` so the native binding rebuilds for the\n` +
      `active ABI.\n`,
  );

  process.exit(1);
}
