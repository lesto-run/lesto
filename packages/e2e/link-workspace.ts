import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Populate `appDir/node_modules` the way a real `bun install` presents it to a workspace
 * member — for a scaffolded/copied app that lives OUTSIDE the repo (an `os.tmpdir()` dir,
 * so node's module walk never reaches the repo install on its own).
 *
 * These e2e apps used to link with a single `symlink(REPO_ROOT/node_modules, …)`, which
 * worked while bun HOISTED the `@lesto/*` workspace packages into the repo-root
 * `node_modules`. bun 1.3.5's isolated layout no longer does: the root holds only the
 * externals (react/preact/…), and each `@lesto/*` package lives under its own member's
 * `node_modules`. A bare symlink to the root therefore resolves ZERO `@lesto/*`, and the
 * app dies with `Cannot find module '@lesto/db'` before the dev server ever boots.
 *
 * So we build a real `node_modules`: every top-level entry of the repo install linked in
 * (the externals plus bun's `.bun` store — each `@lesto/*` package's OWN transitive deps
 * resolve by realpath through there), PLUS the `@lesto` scope reconstructed from
 * `packages/*` by each package's real name (skipping the non-`@lesto/*` members —
 * `create-lesto`, `lesto-e2e`).
 */
export async function linkWorkspaceInto(appDir: string, repoRoot: string): Promise<void> {
  const nodeModules = join(appDir, "node_modules");
  await mkdir(join(nodeModules, "@lesto"), { recursive: true });

  // The externals (and the `.bun` store the `@lesto/*` links realpath into).
  for (const entry of await readdir(join(repoRoot, "node_modules"))) {
    await linkIfAbsent(join(repoRoot, "node_modules", entry), join(nodeModules, entry));
  }

  // The `@lesto` scope bun no longer hoists — one link per workspace package, by its
  // real name (so `packages/db` → `@lesto/db`, and `create-lesto`/`lesto-e2e` are left out).
  for (const dir of await readdir(join(repoRoot, "packages"), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const manifest = join(repoRoot, "packages", dir.name, "package.json");
    const { name } = JSON.parse(await readFile(manifest, "utf8")) as { name: string };
    if (name.startsWith("@lesto/")) {
      await linkIfAbsent(join(repoRoot, "packages", dir.name), join(nodeModules, name));
    }
  }

  // The scaffolded app ALSO declares third-party peers (tailwindcss, tw-animate-css, clsx,
  // lucide-react, …) that bun's isolated layout nests under the DECLARING package rather
  // than the repo root — so the sweep above misses them and `lesto build` dies resolving
  // e.g. `tailwindcss`. Link each app-declared dep the sweep didn't already cover straight
  // from bun's content-addressed `.bun` store, by name (its own transitive deps resolve by
  // realpath through the store).
  const store = join(repoRoot, "node_modules", ".bun");
  const storeEntries = existsSync(store) ? await readdir(store) : [];
  const manifest = await readManifest(join(appDir, "package.json"));
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  for (const dep of declared) {
    if (dep.startsWith("@lesto/")) continue;
    if (existsSync(join(nodeModules, dep))) continue; // the root sweep already covered it
    // store dirs are `<name>@<version>` (a scoped `/` encoded as `+`); `@` guards the prefix.
    const prefix = `${dep.replace("/", "+")}@`;
    const hit = storeEntries.find((entry) => entry.startsWith(prefix));
    if (hit === undefined) continue;
    if (dep.includes("/")) await mkdir(join(nodeModules, dirname(dep)), { recursive: true });
    await linkIfAbsent(join(store, hit, "node_modules", dep), join(nodeModules, dep));
  }
}

/** The app's package.json dep sets, or empty if it has none yet (defensive). */
async function readManifest(
  path: string,
): Promise<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, never>;
  } catch {
    return {};
  }
}

/**
 * `symlink`, but a pre-existing target is a no-op rather than an `EEXIST` throw — so a
 * re-run against an already-populated `node_modules` (the CLI path below can be invoked
 * more than once) is safe. Fresh temp dirs never hit the catch.
 */
async function linkIfAbsent(target: string, path: string): Promise<void> {
  try {
    await symlink(target, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

// CLI: `bun packages/e2e/link-workspace.ts <appDir>` reconstructs `<appDir>/node_modules`
// against this repo (used by the ci.yml deploy-dry job for its `cf-dry-app`). Node-safe
// main detection — `import.meta.main` is bun-only and this file typechecks under
// `types: ["node"]`, so compare the module URL to the invoked script's URL instead.
const entryScript = process.argv[1];
if (entryScript !== undefined && import.meta.url === pathToFileURL(entryScript).href) {
  const appDirArg = process.argv[2];
  if (appDirArg === undefined) {
    console.error("usage: bun packages/e2e/link-workspace.ts <appDir>");
    process.exit(1);
  }

  // repoRoot from this script's own location: packages/e2e → two levels up.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const appDir = resolve(appDirArg);

  await linkWorkspaceInto(appDir, repoRoot);
  console.log(`linked workspace into ${join(appDir, "node_modules")}`);
}
