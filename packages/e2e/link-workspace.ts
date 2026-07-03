import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, symlink, unlink } from "node:fs/promises";
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

  // The externals (react/preact/…) plus bun's `.bun` store (the `@lesto/*` links realpath into
  // it). Skip the OTHER dotfile entries — `.bin` above all: linking the repo's read-only `.bin`
  // in makes `npx`/`npm` unable to install a tool's bin shim into THIS app's node_modules, which
  // is why the deploy-dry `npx wrangler` step died with `wrangler: not found`. Nothing the
  // reconstructed app runs uses its `node_modules/.bin` (consumers invoke `lesto`'s bin.ts by
  // absolute path), so dropping it is free.
  for (const entry of await readdir(join(repoRoot, "node_modules"))) {
    if (entry.startsWith(".") && entry !== ".bun") continue;
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
  const declared = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies });
  const unresolved = [];
  for (const [dep, range] of declared) {
    if (dep.startsWith("@lesto/")) continue;
    if (existsSync(join(nodeModules, dep))) continue; // the root sweep already covered it
    // store dirs are `<name>@<version>` (a scoped `/` encoded as `+`); `@` guards the prefix.
    const prefix = `${dep.replace("/", "+")}@`;
    const matches = storeEntries.filter((entry) => entry.startsWith(prefix));
    if (matches.length === 0) {
      unresolved.push(dep);
      continue;
    }
    const hit = pickStoreEntry(dep, range, prefix, matches);
    // A scoped dep must NOT be linked through the pass-1 scope symlink (`@types`, `@vitest`, …)
    // — that resolves into the REAL repo `node_modules` — so materialize a real scope dir first.
    if (dep.includes("/")) await ensureRealScopeDir(join(nodeModules, dirname(dep)));
    await linkIfAbsent(join(store, hit, "node_modules", dep), join(nodeModules, dep));
  }

  // A declared dep the sweep didn't cover AND that isn't in the bun store gets linked nowhere —
  // the app then fails its build/boot resolving it with no pointer back to here (the exact
  // silent whack-a-mole this helper exists to end). Surface it loudly; the usual cause is a
  // dep no workspace package declares, so the store never fetched it.
  if (unresolved.length > 0) {
    console.warn(
      `link-workspace: ${unresolved.length} declared dep(s) not found in the workspace ` +
        `install, left UNLINKED: ${unresolved.join(", ")}. If the app needs them at ` +
        `build/runtime, declare each on a workspace package so bun installs it into the store.`,
    );
  }
}

/**
 * Choose ONE `.bun` store entry for `dep` among `matches` (all `<name>@<version>[+peerhash]`
 * dirs whose name is `dep`).
 *
 * `readdir` yields the store in hash order, NOT semver order, so the old
 * `matches.find(...)` picked whichever version the filesystem listed first — a coin flip.
 * With `zod@3` and `zod@4` both in the store it returned `zod@3` even for an app declaring
 * `zod: ^4` (a wrong-MAJOR link that only stayed hidden because the root install happened to
 * cover zod first). So: keep the entries whose major satisfies the app's declared range and
 * take the highest, and REFUSE (throw) when the range pins a major that none of them satisfy.
 * A lone match is held to the SAME check — a store with only `zod@3` for an app declaring `^4`
 * fails loud here rather than silently linking the wrong major. A loud, deterministic failure
 * beats a silent wrong pick.
 */
export function pickStoreEntry(
  dep: string,
  range: string | undefined,
  prefix: string,
  matches: readonly string[],
): string {
  // `<name>@<version>+<peerhash>` → the semver `<version>` (build metadata is not precedence).
  const versionOf = (entry: string): string => entry.slice(prefix.length).split("+")[0] ?? "";
  const wanted = majorPredicate(range);

  // A lone match has nothing to disambiguate, but it is held to the SAME range check the
  // multi-match path enforces: an app pinning `foo: ^5` against a store holding only `foo@4`
  // FAILS LOUD here rather than silently linking major 4 (a single entry is not a licence to
  // skip the check — that was the F1-shape residual). A range that pins no major (`*`,
  // `workspace:*`, …) has nothing to be wrong about, so the lone entry links as-is.
  if (matches.length === 1) {
    const lone = matches[0] as string;
    if (wanted.constrained && !wanted.test(majorOf(versionOf(lone)))) {
      throw new Error(
        `link-workspace: cannot pick a version for "${dep}" — the bun store has only ` +
          `${lone.slice(prefix.length)} and the app's declared range "${range ?? "(none)"}" ` +
          `does not accept its major. Pin "${dep}" to a version the store provides, or declare ` +
          `the wanted major on a workspace package so bun fetches it.`,
      );
    }
    return lone;
  }

  const satisfying = wanted.constrained
    ? matches.filter((entry) => wanted.test(majorOf(versionOf(entry))))
    : [];

  if (satisfying.length === 0) {
    const versions = matches.map((entry) => entry.slice(prefix.length)).join(", ");
    throw new Error(
      `link-workspace: cannot pick a version for "${dep}" — the bun store has ${matches.length} ` +
        `(${versions}) and the app's declared range "${range ?? "(none)"}" ` +
        `${wanted.constrained ? "satisfies none of them" : "does not pin a major"}. ` +
        `Pin "${dep}" to a single major in the app's package.json so the link is deterministic.`,
    );
  }

  // Highest satisfying version wins; a version tie breaks on the entry name so the pick stays
  // deterministic. CAVEAT: peer-hash variants of the SAME version (e.g. two `react-dom@19.2.7+…`)
  // can nest DIFFERENT peer majors (one → react 19, one → react 18) — a lexical tiebreak is
  // deterministic but NOT peer-aware, so it could pick a variant wired to the wrong peer. Not
  // reachable today (every such dep is covered by the pass-1 root sweep before this runs); the
  // peer-aware fix is tracked as a follow-up (see the link-workspace hardening task).
  return satisfying.toSorted(
    (a, b) => compareVersionDesc(versionOf(a), versionOf(b)) || (a < b ? -1 : a > b ? 1 : 0),
  )[0] as string;
}

/** The leading numeric component of a `<major>.<minor>.<patch>` version, or 0 if absent. */
function majorOf(version: string): number {
  return Number.parseInt(version.split(".")[0] ?? "", 10) || 0;
}

/** Order two versions high→low by numeric [major, minor, patch] (build metadata already stripped). */
export function compareVersionDesc(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Turn a package.json range into a MAJOR-level predicate — enough to disambiguate store entries
 * without a full semver dependency. `^19`/`~19.1`/`19`/`19.x`/`19.2.0` → major 19; `>=18`/`>18`
 * → major ≥ 18; a `||` union accepts any of its alternatives' majors. A range with no pinnable
 * major (`*`, `latest`, `workspace:*`, `file:`/`link:`/`npm:`/git/url, or unparseable) is
 * reported `constrained: false`, which forces the ambiguous-multi-match case to fail loud rather
 * than guess.
 */
export function majorPredicate(range: string | undefined): {
  test: (major: number) => boolean;
  constrained: boolean;
} {
  const unconstrained = { test: () => true, constrained: false };
  if (range === undefined) return unconstrained;

  const alternatives = range
    .split("||")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (alternatives.length === 0) return unconstrained;

  const predicates: ((major: number) => boolean)[] = [];
  for (const alternative of alternatives) {
    // A compound/hyphen range (`>=18 <20`, `1.2.3 - 2.0.0`) has internal whitespace we would
    // otherwise mis-read (the `>=` arm drops the ceiling; the exact arm sees only the low end).
    // Refuse to guess a major from it — route to the loud, unconstrained path instead.
    if (/\s/.test(alternative)) return unconstrained;
    if (
      alternative === "*" ||
      alternative === "x" ||
      alternative === "latest" ||
      /^(?:workspace:|file:|link:|npm:|git|https?:)/.test(alternative)
    ) {
      return unconstrained; // one wildcard alternative means we cannot pin a major
    }
    const lowerBound = alternative.match(/^>=?\s*v?(\d+)/);
    if (alternative.startsWith(">") && lowerBound) {
      const floor = Number(lowerBound[1]);
      predicates.push((major) => major >= floor);
      continue;
    }
    const exact = alternative.match(/^[\^~]?\s*v?(\d+)/);
    if (exact) {
      const major = Number(exact[1]);
      predicates.push((candidate) => candidate === major);
      continue;
    }
    return unconstrained; // an alternative we cannot read — do not guess
  }

  return { test: (major) => predicates.some((predicate) => predicate(major)), constrained: true };
}

/**
 * Ensure `scopePath` (e.g. `<app>/node_modules/@types`) is a REAL directory we can write a
 * scoped link into — never a symlink that resolves THROUGH to the repo's own scope dir.
 *
 * Pass 1 links each root `node_modules` entry, whole scope dirs (`@types`, `@vitest`, …)
 * included, as a SINGLE symlink to the repo's real scope. If the app then declares a scoped
 * dep in one of those scopes that the root scope lacks, a bare
 * `symlink(store/@x/y, node_modules/@x/y)` resolves `node_modules/@x` through that symlink and
 * creates `y` INSIDE the repo checkout — mutating the real repo `node_modules`. So when the
 * scope is a symlink, replace it with a real dir that re-links what it pointed at, so every
 * later write stays inside this app. (Absent scope → just create it; already real → nothing to do.)
 */
export async function ensureRealScopeDir(scopePath: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(scopePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(scopePath, { recursive: true });
      return;
    }
    throw error;
  }

  if (!stats.isSymbolicLink()) return; // already a real dir (root scope, or a prior materialize)

  // Materialize: capture what the scope symlink pointed at, drop the link, and rebuild it as a
  // real dir whose entries link to the SAME realpaths — so nothing the root scope provided is lost.
  const target = await realpath(scopePath);
  const existing = await readdir(target);
  await unlink(scopePath);
  await mkdir(scopePath, { recursive: true });
  for (const entry of existing) {
    await linkIfAbsent(join(target, entry), join(scopePath, entry));
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
