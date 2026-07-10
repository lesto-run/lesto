#!/usr/bin/env node
// Plain-consumer install-and-IMPORT proof — the gate `pack-and-boot.mjs` deliberately
// does NOT provide.
//
// `pack-and-boot.mjs` boots the `lesto` CLI through its jiti shims, so it proves the
// packaged source RUNS UNDER JITI. It says nothing about the far more common case: an
// outsider who runs `npm i @lesto/<pkg>` and `import`s it into THEIR OWN app — under
// plain node, webpack, vite, or `wrangler deploy` — with no jiti in sight. Shipping
// `exports → ./src/*.ts` breaks exactly that consumer: node refuses to strip types under
// `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and bundlers that exclude
// `node_modules` never transpile it either. This gate encodes the invariant that closes
// that gap: **a published package exposes BUILT artifacts (JS + .d.ts), never TS source.**
//
// Two phases, cheap-deterministic first:
//   A. STRUCTURAL — pack every public package and assert every `exports`/`main`/`module`/
//      `types` target resolves to a built file (`.js`/`.mjs`/`.cjs`, and `.d.ts` for types),
//      NOT `.ts`/`.tsx`, and that the target actually exists inside the tarball. No install,
//      no runtime — environment-agnostic, so a workerd-only package can't confound it.
//   B. RUNTIME — `npm install` a node-safe subset from the tarballs and `import()` each under
//      plain node, asserting it loads. Proves the built output actually executes for a
//      consumer (catches the type-stripping error directly). Runs only if A is clean.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packAllBuiltToVendor } from "./lib/build-public.mjs";
import { readPublicPackageDirs, readTarballMeta } from "./lib/pack-public.mjs";

const REPO = process.cwd();
const PACKAGES = join(REPO, "packages");

// A runtime (executed) export target must be built JS; a `types` target must be a `.d.ts`. The
// `development` condition is exempt (opt-in `node --conditions=development` source path — never on
// the default graph); Phase A skips it explicitly below.
const JS_TARGET = /\.[mc]?js$/;
const DTS_TARGET = /\.d\.[mc]?ts$/;

// Packages with no workerd/browser/react entanglement — safe to `import` bare under node (their
// transitive @lesto deps resolve via the `overrides` map below). Kept deliberately small; Phase A
// already covers the FULL surface structurally. Each name is asserted to be in the packed set, so
// a rename/removal fails loudly here instead of as an opaque MODULE_NOT_FOUND.
const NODE_SAFE = [
  "@lesto/errors",
  "@lesto/auth",
  "@lesto/env",
  "@lesto/db",
  "@lesto/migrate",
  "@lesto/observability",
];

/**
 * Every path an outside resolver could land on, flattened from `exports` (string form, nested
 * subpaths like `"."`/`"./server"`, and condition objects — recursed so `{ ".": { import: { types,
 * default } } }` fully expands) plus the legacy top-level fields, each tagged with the condition
 * that reaches it so we know whether it must be built JS or a `.d.ts`.
 */
function resolvableTargets(meta) {
  const leaves = [];
  const walk = (node, subpath, cond) => {
    if (typeof node === "string") {
      leaves.push({ subpath, condition: cond, target: node });
    } else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith(".")) walk(value, key, cond);
        else walk(value, subpath, key);
      }
    }
  };
  if (meta.exports !== undefined) walk(meta.exports, ".", "default");
  // Legacy top-level fields still consulted by older tools / `moduleResolution: node`.
  if (typeof meta.main === "string") leaves.push({ subpath: "main", condition: "default", target: meta.main });
  if (typeof meta.module === "string") leaves.push({ subpath: "module", condition: "import", target: meta.module });
  if (typeof meta.types === "string") leaves.push({ subpath: "types", condition: "types", target: meta.types });
  return leaves;
}

const work = mkdtempSync(join(tmpdir(), "lesto-import-"));
const vendor = join(work, "vendor");
mkdirSync(vendor);

const publicDirs = readPublicPackageDirs(PACKAGES);
console.log(`[pack-and-import] building + packing ${publicDirs.length} public packages (published shape)…`);
const tarballs = packAllBuiltToVendor(PACKAGES, publicDirs, vendor);
const metas = readTarballMeta(vendor, tarballs);

// ── Phase A: STRUCTURAL ────────────────────────────────────────────────────────────────────
console.log("[pack-and-import] Phase A — asserting every export target is built JS/.d.ts…");
const violations = [];
const overrides = {};
for (const { path, meta } of metas) {
  overrides[meta.name] = `file:${path}`;

  // The set of files actually inside the tarball (npm serves ONLY these), minus the `package/` prefix.
  const files = new Set(
    execFileSync("tar", ["-tzf", path], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((f) => f.replace(/^package\//, "")),
  );

  for (const { subpath, condition: cond, target } of resolvableTargets(meta)) {
    if (cond === "development") continue; // opt-in source path — not on the default resolution
    const rel = target.replace(/^\.\//, "");
    const wantsDts = cond === "types";
    const okExt = wantsDts ? DTS_TARGET.test(target) : JS_TARGET.test(target);
    if (!okExt) {
      violations.push(
        `${meta.name} "${subpath}" [${cond}] → ${target} ` +
          `(expected ${wantsDts ? "a .d.ts" : "built .js/.mjs/.cjs"}, not TS source)`,
      );
      continue;
    }
    if (!files.has(rel)) {
      violations.push(`${meta.name} "${subpath}" [${cond}] → ${target} is not in the tarball`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    `\n[pack-and-import] FAIL — ${violations.length} export target(s) are unbuilt/absent.\n` +
      "A published package must expose compiled JS + .d.ts; a plain-node/webpack/wrangler\n" +
      "consumer cannot import raw TS from node_modules. Add a build step (dist/).\n\n" +
      violations.map((v) => `  • ${v}`).join("\n"),
  );
  process.exit(1);
}
console.log("[pack-and-import] Phase A OK — all export targets are built artifacts.");

// ── Phase B: RUNTIME import under plain node ────────────────────────────────────────────────
console.log(`[pack-and-import] Phase B — importing ${NODE_SAFE.join(", ")} under plain node…`);
const missingSafe = NODE_SAFE.filter((name) => !(name in overrides));
if (missingSafe.length > 0) {
  throw new Error(
    `NODE_SAFE names not in the packed set (renamed or removed? update the list): ${missingSafe.join(", ")}`,
  );
}

const app = join(work, "consumer");
mkdirSync(app);
const deps = Object.fromEntries(NODE_SAFE.map((name) => [name, overrides[name]]));
writeFileSync(
  join(app, "package.json"),
  `${JSON.stringify({ name: "import-proof", private: true, type: "module", dependencies: deps, overrides }, null, 2)}\n`,
);
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error"], { cwd: app, stdio: "inherit" });

for (const name of NODE_SAFE) {
  execFileSync("node", ["--input-type=module", "-e", `await import(${JSON.stringify(name)})`], {
    cwd: app,
    stdio: "inherit",
  });
  console.log(`  ✓ import "${name}"`);
}

// ── Phase C: RUNTIME import of the React FLAGSHIP path (no optional peers) ────────────────────
// The mainstream consumer Phase B's NODE_SAFE subset deliberately SKIPPED: `npm i @lesto/web react
// react-dom` and `import "@lesto/web"` under plain node — WITHOUT the OPTIONAL `preact-render-to-string`
// peer. That omission is exactly why the eager Preact re-export crash (L-863b3f6f) shipped unseen:
// `web` statically pulled `@lesto/ui/server` → `./server-preact` → `preact-render-to-string`, so a
// React-only app crashed on bare import for a Preact renderer it never asked for. This phase is the
// standing guard: react/react-dom come from the registry (as a real consumer installs them); the
// Preact peer is asserted ABSENT so the proof can never silently pass by resolving a hoisted or
// auto-installed peer — the false-oracle family of [[scaffold-e2e-masks-real-resolution]], now on the
// peer-dependency axis.
// `@lesto/ui-kit` is intentionally omitted: it is `private: true` (never published), so it is not
// part of the consumer-facing contract this gate protects and is not in the packed set.
const REACT_FLAGSHIP = ["@lesto/web", "@lesto/ui", "@lesto/router", "@lesto/forms", "@lesto/cloudflare"];
// Also exercise the server subpath directly: it legitimately needs `react-dom` (a real dep, present)
// but MUST NOT need the Preact peer once the adapter is lazy.
const REACT_IMPORTS = [...REACT_FLAGSHIP, "@lesto/ui/server"];

console.log(
  `[pack-and-import] Phase C — importing the React flagship (${REACT_FLAGSHIP.join(", ")}) under plain node, no preact peer…`,
);
const missingFlagship = REACT_FLAGSHIP.filter((name) => !(name in overrides));
if (missingFlagship.length > 0) {
  throw new Error(
    `REACT_FLAGSHIP names not in the packed set (renamed or removed? update the list): ${missingFlagship.join(", ")}`,
  );
}

const reactApp = join(work, "react-consumer");
mkdirSync(reactApp);
const reactDeps = {
  react: "^19",
  "react-dom": "^19",
  ...Object.fromEntries(REACT_FLAGSHIP.map((name) => [name, overrides[name]])),
};
writeFileSync(
  join(reactApp, "package.json"),
  `${JSON.stringify({ name: "import-proof-react", private: true, type: "module", dependencies: reactDeps, overrides }, null, 2)}\n`,
);
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error"], { cwd: reactApp, stdio: "inherit" });

// Anti-vacuous guard: if the OPTIONAL Preact peer resolved anyway (npm auto-installing an optional
// peer, a hoist, a stray dep edge), the imports below would prove nothing. Fail LOUD, not green.
if (existsSync(join(reactApp, "node_modules", "preact-render-to-string"))) {
  throw new Error(
    "React-consumer fixture resolved `preact-render-to-string` (an OPTIONAL peer it MUST NOT have) — " +
      "the import proof below would be vacuous. The React flagship path must never require the Preact peer.",
  );
}

for (const name of REACT_IMPORTS) {
  execFileSync("node", ["--input-type=module", "-e", `await import(${JSON.stringify(name)})`], {
    cwd: reactApp,
    stdio: "inherit",
  });
  console.log(`  ✓ import "${name}" (react, no preact peer)`);
}

console.log(
  `\n[pack-and-import] OK — ${publicDirs.length} packages ship built artifacts; node-safe + React-flagship import paths load under plain node.`,
);
