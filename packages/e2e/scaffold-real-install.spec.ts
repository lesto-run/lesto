import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { run, spawnDev, waitForServer } from "./dev-harness";

/**
 * The REAL-install scaffold smoke — the gate the link-workspace e2e cannot be (`L-e00589b8`).
 *
 * `scaffold-loop.spec.ts` reconstructs the app's `node_modules` from the repo
 * (`link-workspace.ts` symlinks the WHOLE `@lesto` scope + the bun store), so it NEVER
 * exercises real npm-registry resolution or a real linker LAYOUT — the two things that
 * masked the `@lesto/observability/rum` bare-import break (fixed by `3fd4941`) and the
 * `@prefresh/*` one (`53cdbfc`): both resolve under a HOISTING install but hard-fail under
 * bun's ISOLATED linker (its default inside a workspace), pnpm strict, or Yarn PnP. This
 * spec runs a REAL `bun install` instead, in the two layouts a real user actually hits.
 *
 * It is deliberately split into two complementary describe blocks, because there is no single
 * install that is both "what a user gets today" AND "the current working tree":
 *
 *   (a) REAL REGISTRY, PUBLISHED 0.1.1, hoisted — scaffolds via the PUBLISHED `create-lesto@0.1.1`
 *       and `bun install --linker=hoisted`, resolving every `@lesto/*` from the npm registry.
 *       This validates the IMMUTABLE published 0.1.1 closure a `npm create lesto` user installs
 *       TODAY — NOT the working tree. (Honesty note: `create-lesto@0.1.1` predates the
 *       observability/island-dev/styles work, so its scaffold is the 10-package closure and its
 *       NON-HOISTING install is a KNOWN-broken snapshot — the very `@lesto/observability/rum`
 *       masking — until a `0.1.2` republish carries the fix. So the green non-hoisting proof
 *       lives in block (b), against the FIXED current tree.)
 *
 *   (b) CURRENT TREE, NON-HOISTING (isolated) — packs the current `@lesto/*` closure to tarballs
 *       (`bun pm pack`, which rewrites `workspace:*` → the real version exactly like a publish),
 *       scaffolds via the IN-REPO `create-lesto` (default published `^0.x` pins), repins its
 *       `@lesto/*` deps onto those tarballs + sets package.json `overrides` (which reach the
 *       TRANSITIVE `@lesto/*` graph — WITHOUT them bun silently pulls published 0.1.1 from the
 *       registry, masking the working tree), then `bun install --linker=isolated`. This is the
 *       leg that exercises the observability + prefresh decisions under a non-hoisting layout;
 *       third-party deps (react/preact/tailwindcss/@prefresh/…) still come from the REAL registry.
 *
 * Both legs then run the app's OWN installed `lesto` bin (`bun node_modules/.bin/lesto build`,
 * under Bun so `Bun.build` is defined) and boot `lesto dev`, and a real browser proves the
 * island hydrates (the `useState` button goes live). Block (b) additionally proves Fast Refresh
 * preserves an island's state across an edit — the scaffold-output twin of `island-fast-refresh`.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CREATE_LESTO_BIN = join(REPO_ROOT, "packages", "create-lesto", "src", "bin.ts");

// The in-tree create-lesto version drives leg (a): it pins the published scaffold below AND gates
// the leg's skip, so both advance together at the next republish.
const CREATE_LESTO_VERSION = (
  JSON.parse(
    readFileSync(join(REPO_ROOT, "packages", "create-lesto", "package.json"), "utf8"),
  ) as { version: string }
).version;

/**
 * Leg (a)'s scope is gated by the in-tree create-lesto version. Published 0.1.1's `lesto dev` boots and
 * announces its port but then REFUSES connections on 127.0.0.1:<port> on CI Linux while the process stays
 * ALIVE (no exit signal is ever captured) — a localhost/::1-vs-IPv4-literal bind/poll mismatch on the
 * IMMUTABLE published artifact, unfixable from this repo. So while the tree is still at 0.1.1 we skip ONLY
 * the dev-server-dependent work, not the whole leg: the describe stays REGISTERED and its `beforeAll` still
 * scaffolds → installs → BUILDS (the registry-install + Preact-bundle canary — the part that proves the
 * published 0.1.1 closure still installs and builds from the real registry stays LIVE), and only the
 * `lesto dev` boot + the browser-hydration test that needs it are skipped. An earlier `test.describe.skip`
 * of the WHOLE leg silenced that still-passing canary too — this finer split (L-2d87f1b5) keeps it green.
 *
 * The gate AUTO-EXPIRES at the 0.1.2 version bump (which also re-pins the scaffold below), so no human has
 * to remember; L-2d87f1b5 is the backstop. (Small window: between the bump commit and create-lesto@0.1.2
 * landing on npm, a dispatched run reds on the not-yet-published pin — acceptable for a same-day
 * bump+dispatch release.)
 *
 * ── GATE NOTE for the 0.1.2 publisher (L-7d411090) ──────────────────────────────────────────────────
 * At the 0.1.2 bump this gate flips false and the dev boot + hydration test go LIVE automatically. Before
 * relying on green, VERIFY ON CI that published-0.1.2 `lesto dev` actually binds 127.0.0.1: the 0.1.1
 * failure was a bind/poll mismatch baked into the immutable artifact, so if 0.1.2 ships the same bug the
 * newly-live hydration test reds (a real product failure, not test flake). ALSO: the NON-HOISTING install
 * of the PUBLISHED scaffold is still deliberately omitted here (see the header) — today it is a guaranteed
 * red because published 0.1.1 predates @lesto/observability; once 0.1.2 carries that fix, ADD an
 * isolated-linker install to leg (a) so the published closure is proven under a non-hoisting layout too.
 */
const DEV_BOOT_SKIPPED = CREATE_LESTO_VERSION === "0.1.1";

// Distinct ports per leg (and clear of the fixture webServer's 4180 + the other specs' 4188/4189).
const PORT_PUBLISHED = 4190;
const PORT_TREE = 4191;

// Each block is its OWN serial group (the `configure` lives INSIDE each describe, not here at
// file scope): a block scaffolds once and shares a single `lesto dev` across its tests, so its
// tests must run in order in one worker. Crucially they are NOT one file-wide serial chain —
// leg (a) is a frozen published-0.1.1 snapshot whose failures are registry weather / bit-rot with
// no repo-side fix, and a file-wide chain would let an (a) failure SKIP all of leg (b), the leg
// that actually guards the current tree (`3fd4941`/`53cdbfc`). `--workers=1` (in the `test:scaffold-real`
// script) keeps the two independent groups from running their heavy installs in parallel.

// Retain a full Playwright trace + a screenshot whenever a browser test FAILS, so a hydration
// failure off a real install is debuggable from the uploaded CI artifact (the dev server's own
// boot output is captured separately by `spawnDev`). Scoped to this spec; other e2e jobs unchanged.
test.use({ trace: "retain-on-failure", screenshot: "only-on-failure" });

/** The app's own installed `lesto` bin (a node shim; run under `bun` so `Bun.build` is defined). */
function lestoBin(appDir: string): string {
  return join(appDir, "node_modules", ".bin", "lesto");
}

/** Assert `out/client.js` is the Preact island bundle — never drags React's server renderer. */
async function assertPreactClient(appDir: string): Promise<void> {
  const source = await readFile(join(appDir, "out", "client.js"), "utf8");

  expect(source).not.toContain("renderToReadableStream");
  expect(source).not.toContain("renderToStaticMarkup");
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (a) Real registry install of the PUBLISHED 0.1.1 closure, hoisted layout.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test.describe(`real-registry install — published ${CREATE_LESTO_VERSION}, hoisted layout @published-hoisted`, () => {
  test.describe.configure({ mode: "serial" });

  let workspace: string;
  let appDir: string;
  let dev: ChildProcess | undefined;

  test.beforeAll(async () => {
    // Packing/installing from the network is well past Playwright's default 30s hook budget.
    test.setTimeout(600_000);

    workspace = await mkdtemp(join(tmpdir(), "lesto-real-published-"));
    appDir = join(workspace, "pub-app");

    // Scaffold via the PUBLISHED create-lesto — the exact bin a `npm create lesto` user runs. Pinned
    // to the in-tree version (0.1.1 today) so the smoke tests an immutable published snapshot and the
    // pin advances in lockstep with the version gate above at the next republish.
    await run(
      "bunx",
      [`create-lesto@${CREATE_LESTO_VERSION}`, "pub-app", "--yes", "--no-install", "--no-git"],
      workspace,
    );

    // The headline CANARY — runs at EVERY version, INCLUDING 0.1.1: a REAL `bun install` resolving every
    // `@lesto/*` from the npm registry (the resolution `link-workspace` never performs), in the DEFAULT
    // hoisted layout, then a build of the Preact island client through the app's OWN installed cli (under
    // Bun). This install+build is the part that proves the published closure still installs and builds; it
    // stays LIVE at 0.1.1 while only the dev boot below is skipped (see the version-gate comment above).
    await run("bun", ["install", "--linker=hoisted"], appDir);
    await run("bun", [lestoBin(appDir), "build"], appDir);

    // Boot `lesto dev` ONLY when NOT at 0.1.1 (published 0.1.1 declares no island-dev peer → the Bun dev
    // path). Published 0.1.1's dev stays alive but refuses 127.0.0.1 on CI (the documented bind/poll
    // mismatch), so booting it here would hang this hook for the full 60s deadline for nothing. The
    // hydration test below is `test.skip`-ped on the SAME gate, so the two move together at the 0.1.2 bump.
    if (!DEV_BOOT_SKIPPED) {
      const devProc = spawnDev(lestoBin(appDir), appDir, PORT_PUBLISHED);
      dev = devProc.child;

      await waitForServer(`http://127.0.0.1:${PORT_PUBLISHED}/`, 60_000, {
        output: devProc.output,
        hasExited: devProc.hasExited,
      });
    }
  });

  test.afterAll(async () => {
    dev?.kill("SIGTERM");

    await rm(workspace, { recursive: true, force: true });
  });

  test("the registry-installed build is the Preact bundle, never react-dom/server", async () => {
    // Live at EVERY version — needs only the build output, so it guards the published closure's
    // install+build even while the dev-dependent hydration test is version-skipped.
    await assertPreactClient(appDir);
  });

  test("the deferred island hydrates in a real browser — the button goes live", async ({ page }) => {
    // Skipped at 0.1.1: published 0.1.1's `lesto dev` never binds 127.0.0.1 on CI (bind/poll mismatch on
    // the immutable artifact — the `beforeAll` above skips its boot to match), so there is no reachable
    // server to hydrate against. Auto-expires at the 0.1.2 bump in lockstep with the dev-boot guard.
    test.skip(
      DEV_BOOT_SKIPPED,
      `published ${CREATE_LESTO_VERSION} dev never binds 127.0.0.1 on CI (bind/poll mismatch)`,
    );

    await page.goto(`http://127.0.0.1:${PORT_PUBLISHED}/`);

    const counter = page.locator('[data-testid="counter"]');

    await expect(counter).toHaveText("count: 0");

    // A click increments only AFTER hydration — the visible proof the Preact client mounted
    // the live component over the server fallback, off a real registry install.
    await counter.click();

    await expect(counter).toHaveText("count: 1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (b) Current-tree reconstruction, NON-HOISTING (isolated) linker.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Pack every PUBLIC `@lesto/*` package (+ create-lesto) to `vendor` and return a
 * `{ name → "file:<tarball>" }` map — the registry stand-in (mirrors `scripts/pack-and-boot.mjs`).
 * `bun pm pack` rewrites each `workspace:*` to the exact version, exactly like a publish.
 */
function packLestoClosure(repoRoot: string, vendor: string): Record<string, string> {
  const packagesDir = join(repoRoot, "packages");

  for (const dir of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    if (JSON.parse(readFileSync(manifestPath, "utf8")).private === true) continue;

    // Quiet stdout; let bun's stderr through so a pack failure names its cause.
    execFileSync("bun", ["pm", "pack", "--destination", vendor], {
      cwd: join(packagesDir, dir),
      stdio: ["ignore", "ignore", "inherit"],
    });
  }

  const overrides: Record<string, string> = {};

  for (const tarball of readdirSync(vendor).filter((file) => file.endsWith(".tgz"))) {
    // Read the packaged name from the tarball's own manifest (robust to filename mangling).
    const meta = JSON.parse(
      execFileSync("tar", ["-xzOf", join(vendor, tarball), "package/package.json"], {
        encoding: "utf8",
      }),
    ) as { name: string };

    overrides[meta.name] = `file:${join(vendor, tarball)}`;
  }

  return overrides;
}

/**
 * Repin the app's DIRECT `@lesto/*` deps onto the tarballs AND set package.json `overrides` to the
 * full tarball map — the overrides reach the TRANSITIVE `@lesto/*` graph the tarballs declare.
 * Without them bun would resolve those transitive refs from the registry (published 0.1.1),
 * masking the current tree — the exact silent substitution this leg exists to prevent.
 */
async function pinAppToTarballs(appDir: string, overrides: Record<string, string>): Promise<void> {
  const manifestPath = join(appDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };

  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = manifest[field];
    if (deps === undefined) continue;

    for (const dep of Object.keys(deps)) {
      if (dep in overrides) deps[dep] = overrides[dep] as string;
    }
  }

  manifest.overrides = overrides;

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test.describe("current-tree reconstruction — non-hoisting (isolated) linker @tree-isolated", () => {
  test.describe.configure({ mode: "serial" });

  let workspace: string;
  let appDir: string;
  let islandFile: string;
  let dev: ChildProcess | undefined;

  test.beforeAll(async () => {
    test.setTimeout(600_000);

    workspace = await mkdtemp(join(tmpdir(), "lesto-real-tree-"));
    const vendor = join(workspace, "vendor");
    await mkdir(vendor, { recursive: true });
    appDir = join(workspace, "tree-app");
    islandFile = join(appDir, "app", "islands", "counter.tsx");

    // Pack the CURRENT tree's `@lesto/*` closure — the publish stand-in for the working tree.
    const overrides = packLestoClosure(REPO_ROOT, vendor);

    // Scaffold via the IN-REPO create-lesto (default published `^0.x` pins) — the working-tree
    // scaffold, which declares @lesto/observability + @lesto/island-dev + @prefresh/* (the fixes).
    await run("bun", [CREATE_LESTO_BIN, "tree-app", "--yes", "--no-install", "--no-git"], workspace);

    // Repin the whole `@lesto/*` graph onto the tarballs, then install under the ISOLATED linker.
    await pinAppToTarballs(appDir, overrides);
    await run("bun", ["install", "--linker=isolated"], appDir);

    // Build the Preact island client via the app's OWN installed cli, under Bun. THIS is the
    // proof that the bare `@lesto/observability/rum` (+ `@prefresh/*`) resolve under a
    // non-hoisting layout because the scaffold DECLARES them (`3fd4941` / `53cdbfc`).
    await run("bun", [lestoBin(appDir), "build"], appDir);

    // Boot `lesto dev` (the current-tree scaffold declares @lesto/island-dev → the Vite path).
    const devProc = spawnDev(lestoBin(appDir), appDir, PORT_TREE);
    dev = devProc.child;

    await waitForServer(`http://127.0.0.1:${PORT_TREE}/`, 60_000, {
      output: devProc.output,
      hasExited: devProc.hasExited,
    });
  });

  test.afterAll(async () => {
    dev?.kill("SIGTERM");

    await rm(workspace, { recursive: true, force: true });
  });

  test("the isolated install pins every @lesto/* at a packed tarball, not the registry", async () => {
    // The `overrides` guarantee: bun resolved the `@lesto/*` graph from the tarballs, never the
    // registry. If a future bun ignored overrides (or a dep were left unpinned) it would silently
    // pull published 0.1.1 — so assert against bun 1.3.5's lockfile RESOLUTION-KEY grammar: a
    // registry resolution keys as `"<name>@<version>"` (e.g. `"@lesto/errors@0.1.1"`), a tarball as
    // `"<name>@<abs-path>.tgz"`. (An earlier `.not.toMatch(/registry\.npmjs\.org/)` was vacuous —
    // bun.lock records NO registry URLs — and a bare `.toContain(".tgz")` is satisfied by the app's
    // own `file:` dep RANGES regardless of what resolved. The quoted-key `@`-boundary below is what
    // actually distinguishes resolved-from-tarball from resolved-from-registry.)
    const lock = await readFile(join(appDir, "bun.lock"), "utf8");

    // ≥1 `@lesto/*` actually RESOLVED to a tarball (a registry-only leak would leave none).
    expect(lock).toMatch(/"@lesto\/[^"]*@[^"]*\.tgz"/);
    // …and NONE resolved to a registry `@<version>` key (the silent-substitution failure mode).
    expect(lock).not.toMatch(/"@lesto\/[^"]*@\d/);
  });

  test("the isolated build is the Preact bundle, never react-dom/server", async () => {
    await assertPreactClient(appDir);
  });

  test("the deferred island hydrates in a real browser under the isolated layout", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${PORT_TREE}/`);

    const counter = page.locator('[data-testid="counter"]');

    await expect(counter).toHaveText("count: 0");

    await counter.click();

    await expect(counter).toHaveText("count: 1");
  });

  test("editing the island preserves useState (Fast Refresh) on scaffold output", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${PORT_TREE}/`);

    const counter = page.locator('[data-testid="counter"]');

    // Drive the count to a non-initial value so a full reload (reset to 0) would be visible.
    await counter.click();
    await counter.click();
    await counter.click();
    await expect(counter).toHaveText("count: 3");

    // Edit the live component's label. `count: {n}` is unique to the mounted Counter (the
    // fallback renders `count: {start}`), so this changes only what the hydrated island paints.
    const original = await readFile(islandFile, "utf8");
    const edited = original.replace("count: {n}", "tally: {n}");
    expect(edited).not.toBe(original);
    await writeFile(islandFile, edited);

    // Fast Refresh applies the new label AND keeps the count at 3 — proof `@prefresh/*` hot-reload
    // is wired under the isolated layout. A full reload would re-render "tally: 0" from initial.
    await expect(counter).toHaveText("tally: 3", { timeout: 15_000 });

    // Restore the source (defensive — the temp workspace is also removed in afterAll).
    await writeFile(islandFile, original);
  });
});
