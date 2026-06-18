/**
 * Bundle the island hydration client (`client.tsx`) to a single browser file.
 *
 *   bun build-client.ts --outfile out/client.js [--minify] [--production] [--preact]
 *
 * This is the one build step both `dev.ts` and `src/production.ts` shell out to,
 * so there is a single source of truth for how `/client.js` is produced. They
 * spawn it (via `execFileSync`) rather than import it, which keeps those files
 * plain node-typed and vitest-importable — the Bun-only `Bun.build` API lives
 * here alone, behind a process boundary.
 *
 * Why `Bun.build` and not the `bun build` CLI: aliasing `react` to
 * `preact/compat` for the CLIENT bundle needs a resolver plugin, and the CLI has
 * no `--alias`/`--tsconfig-override` flag (only `--external`/`--conditions`). The
 * `--preact` flag turns that alias ON; it is OFF by default, so the default path
 * bundles the same real React the tests and deploy expect. Note it is the same
 * MODULE GRAPH, not a byte-identical file: the `Bun.build` API and the old inline
 * `bun build` CLI seed the minifier's identifier mangler slightly differently
 * (e.g. one names a hoisted helper `wO`, the other `LO`), so the minified output
 * differs by a few hundred bytes of renamed locals. The behaviour is identical;
 * only the cosmetic mangled names move, so nothing downstream depends on it.
 *
 * The preact alias is sound ONLY for DEFERRED islands (`ssr: false`), which mount
 * fresh on the client with `createRoot` — no server markup to hydrate against.
 * An `ssr: true` island would hydrate React-emitted HTML with Preact's
 * `hydrateRoot`, and the two renderers' markup is not identical; making that safe
 * means switching the SERVER renderer (`react-dom/server`) to Preact too, which
 * this client-only alias deliberately does not do. estate's lone island
 * (`Account`) is deferred, so the flag is safe for it today.
 */

import { readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { BunPlugin } from "bun";

/**
 * The React specifiers we redirect when `--preact` is set. Most go straight to
 * Preact's compat layer; `react-dom` goes to a local shim that adds the React 19
 * resource hints (`preload`, `preinit`, …) Preact omits but `@volo/ui`'s barrel
 * imports — see `preact-react-dom-shim.ts` for why those are inert on the client.
 */
const PREACT_ALIAS: Readonly<Record<string, string>> = {
  react: "preact/compat",
  "react-dom": "./preact-react-dom-shim.ts",
  // `react-dom/client` exposes `createRoot`/`hydrateRoot`; Preact mirrors them
  // under `preact/compat/client`, the only specifier that is not just compat.
  "react-dom/client": "preact/compat/client",
  // `react-dom/server` is dragged in by `@volo/ui`'s barrel but never runs on the
  // client; the real module's top-level bootstrap throws once React is aliased
  // away, so we point it at an inert stub (see the server shim for why).
  "react-dom/server": "./preact-react-dom-server-shim.ts",
  // `jsx: react-jsx` (the estate tsconfig) emits automatic-runtime imports.
  "react/jsx-runtime": "preact/jsx-runtime",
  "react/jsx-dev-runtime": "preact/jsx-runtime",
};

/**
 * A Bun bundler plugin that rewrites each aliased React specifier to its Preact
 * compat counterpart. We resolve the target with `Bun.resolveSync` against the
 * project root so the bundler gets a concrete path, not a bare specifier it would
 * try to alias again and loop on.
 */
function preactAliasPlugin(projectRoot: string): BunPlugin {
  return {
    name: "react-to-preact-compat",
    setup(build) {
      for (const [from, to] of Object.entries(PREACT_ALIAS)) {
        // Anchor the filter to the whole specifier so `react-dom/client` is not
        // also matched by the broader `react-dom` rule (first match would win
        // and drop the `/client` entry that owns createRoot/hydrateRoot).
        const filter = new RegExp(`^${from.replace(/[/\\]/g, "\\$&")}$`);

        build.onResolve({ filter }, () => ({ path: Bun.resolveSync(to, projectRoot) }));
      }
    },
  };
}

interface Options {
  readonly outfile: string;
  readonly minify: boolean;
  readonly production: boolean;
  readonly preact: boolean;
}

/** Parse the flags this script accepts; `--outfile` is required. */
function parseArgs(argv: readonly string[]): Options {
  const outfileIndex = argv.indexOf("--outfile");

  if (outfileIndex === -1 || argv[outfileIndex + 1] === undefined) {
    throw new Error("build-client: --outfile <path> is required");
  }

  return {
    outfile: argv[outfileIndex + 1] as string,
    minify: argv.includes("--minify"),
    // `--production` pins NODE_ENV so React (or Preact) tree-shakes its
    // development-only warnings and invariants out of the client bundle.
    production: argv.includes("--production"),
    preact: argv.includes("--preact"),
  };
}

async function main(): Promise<void> {
  const projectRoot = import.meta.dir;
  const options = parseArgs(Bun.argv.slice(2));

  // `splitting` is what makes a lazy island def's `() => import("./account")`
  // (see src/registry.tsx) a separate chunk instead of main-bundle bytes: the
  // entry keeps only the runtime + eager islands, and a lazy island's code is
  // fetched by the browser on first mount via a relative `import()` the bundler
  // emits — no manifest, no chunk map, just ESM resolving against /client.js's
  // own URL. The chunks land beside the entry, where every asset path already
  // serves them (dispatchSites/dispatchSitesDev serve any `.js`; the Cloudflare
  // assets binding serves the whole directory).
  const result = await Bun.build({
    entrypoints: [`${projectRoot}/client.tsx`],
    target: "browser",
    splitting: true,
    minify: options.minify,
    define: options.production ? { "process.env.NODE_ENV": '"production"' } : {},
    plugins: options.preact ? [preactAliasPlugin(projectRoot)] : [],
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);

    throw new Error("build-client: bundling failed");
  }

  const outDir = dirname(options.outfile);

  const entry = result.outputs.find((artifact) => artifact.kind === "entry-point");

  if (entry === undefined) throw new Error("build-client: no entry output produced");

  // Chunk names are content-hashed, so a new build emits FRESH names and never
  // overwrites the previous build's chunks — they would linger forever and get
  // re-deployed (a dialect switch, or just editing an island, orphans the old
  // ones). Clear the prior build's `chunk-*.js` before writing this build's, so
  // the output holds exactly the current graph and nothing stale ships. The
  // prerendered HTML and the fixed-name entry are written elsewhere/overwritten,
  // so only the hashed chunks need sweeping. We clean only AFTER a successful
  // build, so a failed rebuild leaves the last good output intact.
  for (const name of await readdir(outDir)) {
    if (/^chunk-[A-Za-z0-9]+\.js$/.test(name)) {
      await rm(join(outDir, name));
    }
  }

  // Write the entry to the requested path and every split chunk beside it,
  // keeping each chunk's generated (hashed) filename — the entry references its
  // chunks by exactly those relative names.
  await Bun.write(options.outfile, entry);

  for (const artifact of result.outputs) {
    if (artifact.kind === "entry-point") continue;

    await Bun.write(join(outDir, basename(artifact.path)), artifact);
  }
}

await main();
