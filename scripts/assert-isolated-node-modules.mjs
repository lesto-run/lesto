#!/usr/bin/env node
// Drift guard — assert the repo-root node_modules stays ISOLATED (no hoisted `@lesto`),
// AND that the workspace's package manifests stay HONEST (framework/runtime peer ranges
// advertise only what is tested; react and react-dom never split majors).
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
// The isolated flip also turned a latent class of MANIFEST DISHONESTY — peer ranges that
// advertise more majors than are tested (e.g. `pg: ">=8"` when only pg 8 exists and is CI-tested,
// or a `react`/`react-dom` pair that could resolve to split majors and throw at client render) —
// into one-job-at-a-time CI failures. Checks 4 and 5 below enforce the whole class up front:
// every external framework/runtime peer must be a BOUNDED range that does not reach past its
// tested major, and react must share a major with react-dom wherever both are declared.
//
// Contract: runnable as `bun scripts/assert-isolated-node-modules.mjs` (the CI-wired invocation).
// Paths resolve relative to this file, not the CWD, so the invocation dir doesn't matter. The
// check logic is exported as pure functions so it can be unit-tested; the CLI at the bottom is a
// thin driver that reads the tree and calls them.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── Pure manifest-honesty helpers (exported for tests) ───────────────────────────────────────

/**
 * A peer range that is a workspace/local protocol (`workspace:*`, `file:`, `link:`, `catalog:`,
 * `npm:`) is not an external semver range and is out of scope for the honesty check.
 */
export function isLocalProtocolRange(range) {
  return /^(workspace|file|link|portal|catalog|npm):/.test(String(range).trim());
}

/**
 * A peer is "external framework/runtime" — the kind manifest honesty governs — when it is neither
 * an `@lesto/*` workspace sibling nor declared via a local protocol. That leaves the real third
 * party deps: react, react-dom, vue, svelte, pg, zod, vite, tailwindcss, … — the ones a published
 * package genuinely resolves from a consumer's install and must therefore advertise honestly.
 */
export function isExternalPeer(name, range) {
  return !name.startsWith("@lesto/") && !isLocalProtocolRange(range);
}

/** The highest major named anywhere in a simple (`^`/`~`/exact/x-range, `||`-unioned) range. */
export function simpleMaxMajor(range) {
  const disjuncts = String(range)
    .trim()
    .split("||")
    .map((d) => d.trim());
  let max = null;
  for (const d of disjuncts) {
    for (const token of d.split(/\s+/).filter(Boolean)) {
      if (/^[<>]=?/.test(token)) return null; // a comparator range is not "simple" — bail out
      if (token === "*" || token === "x" || token === "X") return null;
      const m = /(\d+)/.exec(token.replace(/^[\^~=v]/, ""));
      if (!m) continue;
      const major = Number(m[1]);
      if (max === null || major > max) max = major;
    }
  }
  return max;
}

/** The first (lowest-position) major in a range string, or null — used only for FAIL suggestions. */
export function firstMajor(range) {
  const m = /(\d+)/.exec(String(range));
  return m ? Number(m[1]) : null;
}

/**
 * Is `range` BOUNDED above — i.e. does it name a finite ceiling major? Caret/tilde/exact/x-range
 * (and `||`-unions of them, and `>=X <Y` comparator pairs) are bounded. Open-ended ranges — `>=X`,
 * `>X`, `*`, `x`, bare "", or any disjunct that is lower-bound-only — are NOT: they advertise every
 * future (untested, possibly nonexistent) major. A union is bounded only if EVERY disjunct is.
 */
export function isBounded(range) {
  const disjuncts = String(range)
    .trim()
    .split("||")
    .map((d) => d.trim());
  return disjuncts.every((d) => {
    if (d === "" || d === "*" || d === "x" || d === "X") return false;
    let hasUpper = false;
    let hasOpenLower = false;
    for (const token of d.split(/\s+/).filter(Boolean)) {
      if (token === "*" || token === "x" || token === "X") return false;
      if (token.startsWith(">=") || token.startsWith(">")) hasOpenLower = true;
      else if (token.startsWith("<"))
        hasUpper = true; // `<` or `<=`
      else if (token.startsWith("^") || token.startsWith("~")) hasUpper = true;
      else if (/^[=v]?\d/.test(token)) hasUpper = true; // bare exact / x-range with a numeric major
    }
    // An open lower bound (`>=`/`>`) is honest only when a companion `<`/`<=` caps it.
    if (hasOpenLower && !hasUpper) return false;
    return hasUpper;
  });
}

/**
 * Derive the tested major for `dep`: the package's OWN devDependency pin wins, else a fallback
 * "CI-pinned" map (the versions CI actually installs — the repo root's deps/devDeps, plus any
 * explicitly `bun add`-ed peer). Returns null when neither is known.
 */
export function testedMajor(manifest, dep, fallbackPins = {}) {
  const own = manifest.devDependencies?.[dep];
  if (own && !isLocalProtocolRange(own)) {
    const m = simpleMaxMajor(own) ?? firstMajor(own);
    if (m !== null) return m;
  }
  const pin = fallbackPins[dep];
  if (pin) {
    const m = simpleMaxMajor(pin) ?? firstMajor(pin);
    if (m !== null) return m;
  }
  return null;
}

/**
 * Manifest honesty: every external framework/runtime peer must be a bounded range that does not
 * reach past its tested major. Returns an array of human-readable problem strings (empty = ok).
 */
export function assertPeerHonesty(manifest, fallbackPins = {}) {
  const problems = [];
  const peers = manifest.peerDependencies ?? {};
  const label = manifest.name ?? "(unnamed package)";
  for (const [name, range] of Object.entries(peers)) {
    if (!isExternalPeer(name, range)) continue;
    if (!isBounded(range)) {
      const major = testedMajor(manifest, name, fallbackPins) ?? firstMajor(range);
      const suggestion = major !== null ? ` — narrow to "^${major}" (the tested major)` : "";
      problems.push(
        `Dishonest peer range: ${label} declares peer "${name}": "${range}", which is\n` +
          "  UNBOUNDED/open-ended — it advertises every future (untested, possibly nonexistent)\n" +
          "  major. ADR 0045: a framework/runtime peer must be a BOUNDED range intersecting only\n" +
          `  its tested major(s)${suggestion}.`,
      );
      continue;
    }
    // Bounded: if we can independently derive the tested major and the range is a simple
    // caret/tilde/exact shape, assert it does not reach a HIGHER (untested) major.
    const tested = testedMajor(manifest, name, fallbackPins);
    const reach = simpleMaxMajor(range);
    if (tested !== null && reach !== null && reach > tested) {
      problems.push(
        `Dishonest peer range: ${label} declares peer "${name}": "${range}", which reaches\n` +
          `  major ${reach}, but only major ${tested} is tested (its devDependency / CI pin).\n` +
          `  Narrow the peer so it intersects only the tested major(s) — e.g. "^${tested}".`,
      );
    }
  }
  return problems;
}

/** The major numbers a range advertises, ascending — e.g. `^18 || ^19` → [18, 19]. */
function advertisedMajors(range) {
  const set = new Set();
  for (const d of String(range).trim().split("||")) {
    for (const token of d.trim().split(/\s+/).filter(Boolean)) {
      const m = /(\d+)/.exec(token.replace(/^[\^~=v<>]=?/, ""));
      if (m) set.add(Number(m[1]));
    }
  }
  return [...set].toSorted((a, b) => a - b);
}

/**
 * react/react-dom lockstep: wherever a single dependency section declares BOTH, their advertised
 * major sets must be identical — a split pair (react@18 with react-dom@19) throws at client render
 * ("Objects are not valid as a React child"). Returns an array of problem strings (empty = ok).
 */
export function assertReactLockstep(manifest) {
  const problems = [];
  const label = manifest.name ?? "(unnamed package)";
  for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = manifest[section];
    if (!deps || !deps.react || !deps["react-dom"]) continue;
    if (isLocalProtocolRange(deps.react) || isLocalProtocolRange(deps["react-dom"])) continue;
    const a = advertisedMajors(deps.react);
    const b = advertisedMajors(deps["react-dom"]);
    if (a.join(",") !== b.join(",")) {
      problems.push(
        `react/react-dom major mismatch: ${label} ${section} pins react "${deps.react}" (major(s) ` +
          `${a.join("/")}) against react-dom "${deps["react-dom"]}" (major(s) ${b.join("/")}).\n` +
          "  A split pair throws at client render. Keep the two in lockstep on one major.",
      );
    }
  }
  return problems;
}

/** Run the manifest-honesty + lockstep checks across every git-tracked package.json. */
export function assertManifestHonesty({ repoRoot, fallbackPins }) {
  const problems = [];
  let manifests;
  try {
    manifests = execFileSync("git", ["ls-files", "-z", "package.json", "*/package.json"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    problems.push("Could not enumerate tracked package.json manifests via git — inspect by hand.");
    return problems;
  }
  for (const rel of manifests) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(`${repoRoot}/${rel}`, "utf8"));
    } catch {
      problems.push(`Could not parse ${rel} — inspect it by hand.`);
      continue;
    }
    problems.push(...assertPeerHonesty(manifest, fallbackPins));
    problems.push(...assertReactLockstep(manifest));
  }
  return problems;
}

// ── CLI driver (the CI-wired entrypoint) ─────────────────────────────────────────────────────

function main() {
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
            "  local `bun install`; a fresh checkout lacks it, so `bun install --frozen-lockfile`\n" +
            '  fails with an opaque "lockfile had changes".\n' +
            `  Fix: delete the stray dir (or negate it in root package.json "workspaces"), then\n` +
            "  re-run `bun install` to drop the phantom entry from bun.lock.",
        );
      }
    }
  }

  // 4 + 5. Manifest honesty: bounded framework/runtime peers + react/react-dom lockstep. The
  //    "CI-pinned version" fallback for the tested-major derivation is the repo root's own
  //    deps/devDeps — the versions `bun install` actually lands — so a peer with no local devDep
  //    (e.g. an optional `pg`) is still measured against what CI resolves.
  let fallbackPins = {};
  try {
    const root = JSON.parse(readFileSync(`${repoRoot}/package.json`, "utf8"));
    fallbackPins = { ...root.dependencies, ...root.devDependencies };
  } catch {
    // no root manifest readable — honesty checks fall back to own-devDep only
  }
  problems.push(...assertManifestHonesty({ repoRoot, fallbackPins }));

  if (problems.length > 0) {
    process.stderr.write(
      "\nassert-isolated-node-modules: FAILED\n\n" +
        problems.map((p) => "• " + p).join("\n\n") +
        "\n",
    );
    process.exit(1);
  }

  console.log(
    "assert-isolated-node-modules: ok — root node_modules is isolated (no hoisted @lesto), the " +
      "linker pin is present, and every framework/runtime peer range is bounded + honest " +
      "(react/react-dom in major lockstep).",
  );
}

// Run only when executed directly (`bun scripts/assert-isolated-node-modules.mjs`), not on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
