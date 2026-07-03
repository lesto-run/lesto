#!/usr/bin/env node
// Drift guard — assert the repo-root node_modules stays ISOLATED (no hoisted `@lesto`).
//
// bun 1.3.5 installs `configVersion: 1` lockfiles (this repo's, since `8c2209c`) with an
// ISOLATED node_modules layout: the repo root holds only the ~16 shared externals, and every
// `@lesto/*` workspace package resolves from the member that DECLARES it — there is NO hoisted
// `@lesto` scope at the root. ADR 0045 ratified that layout and PINNED it
// (`[install] linker = "isolated"` in bunfig.toml). This script is that ADR's teeth: if a
// lockfile regen or a bun bump ever silently re-hoists `@lesto` into the root, or if the pin is
// removed, CI fails HERE — loudly, with the cause named — instead of a downstream site tripping
// over a phantom dependency it never declared.
//
// Contract: runnable as `bun scripts/assert-isolated-node-modules.mjs` (the CI-wired invocation).
// Paths resolve relative to this file, not the CWD, so the invocation dir doesn't matter.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const hoistedScope = fileURLToPath(new URL("../node_modules/@lesto", import.meta.url));
const bunfig = fileURLToPath(new URL("../bunfig.toml", import.meta.url));
const lockfile = fileURLToPath(new URL("../bun.lock", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const problems = [];

// 1. The layout itself: a hoisted `@lesto` scope at the repo root means hoisting crept back —
//    the exact phantom-dependency regression the isolated layout exists to prevent.
if (existsSync(hoistedScope)) {
  problems.push(
    "Hoisting drift: `node_modules/@lesto` exists at the repo root.\n" +
      "  The isolated layout resolves every `@lesto/*` package from the member that DECLARES\n" +
      "  it — a hoisted `@lesto` scope at the root re-admits the phantom dependencies ADR 0045\n" +
      "  pins against. Most likely cause: a lockfile regen (or a bun bump) WITHOUT the\n" +
      '  `[install] linker = "isolated"` pin in bunfig.toml.\n' +
      "  Fix: confirm the pin is present, then re-run `bun install` to rebuild the layout.",
  );
}

// 2. The pin itself: if it was removed, the layout is a bun DEFAULT again — an implicit
//    consequence of the lockfile's `configVersion`, not a decision — and a future regen could
//    flip it with nothing to catch the flip.
const pinPresent =
  existsSync(bunfig) && /^\s*linker\s*=\s*"isolated"/m.test(readFileSync(bunfig, "utf8"));
if (!pinPresent) {
  problems.push(
    'Pin missing: bunfig.toml no longer contains `[install] linker = "isolated"`.\n' +
      "  Without the pin the isolated layout is an implicit consequence of the lockfile's\n" +
      "  `configVersion` — a future regen could silently flip it. Restore the pin (ADR 0045).",
  );
}

// 3. Phantom workspace: every workspace entry in the COMMITTED lockfile must map to a
//    git-tracked package.json. An untracked directory matching a workspace glob (packages/*,
//    examples/*) gets baked into bun.lock by any local `bun install`; a fresh CI checkout —
//    which lacks that dir — then fails `bun install --frozen-lockfile` with an opaque
//    "lockfile had changes" that names no cause. This asserts the invariant that class
//    violates, naming the offending path. (It cost this repo several red CI runs before the
//    `!examples/hmr-check` negation closed the specific case — this catches the whole class.)
if (existsSync(lockfile)) {
  const raw = readFileSync(lockfile, "utf8").replace(/,(\s*[}\]])/g, "$1");
  let workspaces;
  try {
    workspaces = JSON.parse(raw).workspaces ?? {};
  } catch {
    workspaces = {};
    problems.push("Could not parse bun.lock to verify workspace entries — inspect it by hand.");
  }
  for (const ws of Object.keys(workspaces)) {
    if (ws === "") continue; // the root package itself, not a member path
    const manifest = `${ws}/package.json`;
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", manifest], {
        cwd: repoRoot,
        stdio: "ignore",
      });
    } catch {
      problems.push(
        `Phantom workspace: bun.lock lists "${ws}", but ${manifest} is not git-tracked.\n` +
          "  An untracked directory matching a workspace glob was baked into the lockfile by a\n" +
          '  local `bun install`; a fresh checkout lacks it, so `bun install --frozen-lockfile`\n' +
          '  fails with an opaque "lockfile had changes".\n' +
          `  Fix: delete the stray dir (or negate it in root package.json "workspaces"), then\n` +
          "  re-run `bun install` to drop the phantom entry from bun.lock.",
      );
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(
    "\nassert-isolated-node-modules: FAILED\n\n" +
      problems.map((p) => "• " + p).join("\n\n") +
      "\n",
  );
  process.exit(1);
}

console.log(
  "assert-isolated-node-modules: ok — root node_modules is isolated (no hoisted @lesto) and the linker pin is present.",
);
