import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { killAndWait, run, spawnDev, waitForServer } from "./dev-harness";
import {
  CREATE_LESTO_BIN,
  REPO_ROOT,
  assertPreactClient,
  expectIslandHydrated,
  lestoBin,
  packLestoClosure,
  pinAppToTarballs,
} from "./scaffold-real-helpers";

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
 *   (a) REAL REGISTRY, PUBLISHED (create-lesto@<current>, 0.1.2 today), hoisted — scaffolds via the
 *       PUBLISHED `create-lesto` and `bun install --linker=hoisted`, resolving every `@lesto/*` from the
 *       npm registry. This validates the IMMUTABLE published closure a `npm create lesto` user installs
 *       TODAY — NOT the working tree. 0.1.2 carries the observability/island-dev/styles work, so unlike
 *       0.1.1 (which predated it, making its NON-HOISTING install a KNOWN-broken `@lesto/observability/rum`
 *       snapshot) the published closure now resolves under a non-hoisting layout too — proven by a sibling
 *       `@published-isolated` leg (L-9dc62468) that installs + builds the published closure under
 *       `--linker=isolated` in its OWN describe, so an isolated-specific failure can't mask this hoisted
 *       leg's canary. This leg's `lesto dev` boot + hydration are version-skipped while the known-stall
 *       pin holds (see the gate below).
 *
 *   (b) CURRENT TREE, NON-HOISTING (isolated) — packs the current `@lesto/*` closure to tarballs
 *       (`bun pm pack`, which rewrites `workspace:*` → the real version exactly like a publish),
 *       scaffolds via the IN-REPO `create-lesto` (default published `^0.x` pins), repins its
 *       `@lesto/*` deps onto those tarballs + sets package.json `overrides` (which reach the
 *       TRANSITIVE `@lesto/*` graph — WITHOUT them bun silently pulls the published `@lesto/*`
 *       closure from the registry, masking the working tree), then `bun install --linker=isolated`. This is the
 *       leg that exercises the observability + prefresh decisions under a non-hoisting layout;
 *       third-party deps (react/preact/tailwindcss/@prefresh/…) still come from the REAL registry.
 *
 * Both legs then run the app's OWN installed `lesto` bin (`bun node_modules/.bin/lesto build`,
 * under Bun so `Bun.build` is defined) and boot `lesto dev`, and a real browser proves the
 * island hydrates (the `useState` button goes live). Block (b) additionally proves Fast Refresh
 * preserves an island's state across an edit — the scaffold-output twin of `island-fast-refresh`.
 */

// The in-tree create-lesto version drives leg (a): it pins the published scaffold below AND gates
// the leg's skip, so both advance together at the next republish.
const CREATE_LESTO_VERSION = (
  JSON.parse(
    readFileSync(join(REPO_ROOT, "packages", "create-lesto", "package.json"), "utf8"),
  ) as { version: string }
).version;

/**
 * Leg (a) boots + hydrates the PUBLISHED scaffold — EXCEPT when the published version is the known-stall
 * pin below. Published 0.1.2's `lesto dev` under bun's HOISTED linker on CI Linux announces its port (the
 * listen callback fires; the child stays ALIVE — the exit-listener never trips) but does NOT answer the
 * first `GET /`, even under a 300s waitForServer budget (one dispatch, run 28714591201). That STRONGLY
 * indicates a hang over a slow cold start — but it is n=1, and that same run's leg-b hydration also failed
 * (the runner may have been degraded), so a true deadlock vs a >300s dep-optimize stall under CPU
 * contention is NOT conclusively separated. Either way `beforeAll`'s dev boot hangs past the deadline, so
 * we skip ONLY the dev-boot + the browser-hydration test it feeds. The describe stays REGISTERED and
 * `beforeAll` still scaffolds → installs → BUILDS, so the registry-install + Preact-bundle CANARY (proof
 * the published closure still installs and builds from the real registry) stays LIVE. An earlier
 * `test.describe.skip` of the WHOLE leg silenced that canary too; this finer split keeps it green.
 *
 * ⚠️ COVERAGE HOLE while skipped: leg (a) is the ONLY spec that boots `lesto dev` off a hoisted, real-
 * registry install — bun's standalone-scaffold DEFAULT, i.e. the real-user path. With it skipped, CI has
 * NO hoisted dev-boot coverage; the sole remaining dev-boot+hydrate signal is leg (b), which is isolated
 * (non-default) AND flaky (L-d86ae3a1). So a green nightly does NOT prove the hoisted default-path dev
 * works. L-513dd8a6 re-closes this on a FIXABLE target (a mutable-tree HOISTED preflight) + ships the fix.
 *
 * ⚠️ MECHANISM CORRECTED (2026-07-04, L-3daa1173) — the "dep-optimize / @prefresh rolldown stall" guess
 * below the fold is REFUTED. The real signature: `beforeAll`'s `waitForServer` fails because it uses Node's
 * undici `fetch()`, and undici `fetch()` fails outright (instant, persistent) against the published-0.1.2
 * hoisted dev — while curl and `node:http` (fresh socket, `Connection: close`) both get `GET / → 200` fast
 * (~55ms, so it is NOT a dep-optimize deadlock). It is undici-`fetch`-client-specific and REAL-PUBLISHED-
 * CLOSURE-specific: a LOCAL pack of the byte-identical 0.1.2 source answers undici fine (source-invisible +
 * local-pack-blind). So the skip is correct (leg-a's fetch harness genuinely reds on 0.1.2), and HEAD's
 * published-closure behavior is UNPROVEN. ⚠️ USER IMPACT NOT SETTLED: no real browser was tested against
 * the published dev (this leg's `page.goto` never ran — `beforeAll` threw), and undici `fetch()` is Node/
 * Bun's DEFAULT client (agents, SSR self-fetch, and Lesto's OWN dev-MCP plane use it) — do NOT read this as
 * "users fine"; browser + agent-native impact is OPEN (L-513dd8a6). The "isolated boots fine / hoisted-on-Linux only" framing still holds directionally
 * but the CAUSE is undici-fetch-vs-real-closure, not a Vite stall; do NOT reinstate the bind/poll wording
 * (reconcile L-2d87f1b5). Full evidence + the verdaccio "is HEAD fixed" follow-up: L-3daa1173 / L-513dd8a6.
 *
 * The gate is a SINGLE known-bad version pin, so it AUTO-LIFTS at the next bump — NOT a `<=` threshold
 * (which greens forever and defeats the auto-re-test that caught this at the 0.1.2 bump). Two follow-on
 * reds are EXPECTED, not flake: between a 0.1.3 bump and create-lesto@0.1.3 landing on npm the whole leg-a
 * `beforeAll` reds on `bunx create-lesto@0.1.3` (404); and if 0.1.3 un-skips onto a still-unfixed dev the
 * hydration test reds. The un-skip conditions + the isolated-install add-on live on L-513dd8a6 / L-9dc62468.
 */
// Force-lift hook (L-3daa1173 characterization): the `hoisted-hang-probe` workflow sets
// `LESTO_FORCE_PUBLISHED_DEV_BOOT=1` to boot the published dev under THIS exact `waitForServer` (undici
// `fetch`) harness. That run SETTLED it: undici `fetch()` reds the published-0.1.2 hoisted dev 3/3 while
// curl greens 3/3 on the SAME server — a curl probe is a FALSE ORACLE, only the fetch harness sees the
// real defect. UNSET on every normal path (the nightly, scaffold-real-install.yml, CI), so the
// version-pinned skip is unchanged there; the hook exists only for the characterization sweep.
const DEV_BOOT_SKIPPED =
  CREATE_LESTO_VERSION === "0.1.2" && process.env.LESTO_FORCE_PUBLISHED_DEV_BOOT !== "1";

// Distinct ports per leg (and clear of the fixture webServer's 4180 + the other specs' 4188/4189).
const PORT_PUBLISHED = 4190;
const PORT_TREE = 4191;

// Each block is its OWN serial group (the `configure` lives INSIDE each describe, not here at
// file scope): a block scaffolds once and shares a single `lesto dev` across its tests, so its
// tests must run in order in one worker. Crucially they are NOT one file-wide serial chain —
// leg (a) is a frozen published snapshot (pinned to CREATE_LESTO_VERSION) whose failures are registry weather / bit-rot with
// no repo-side fix, and a file-wide chain would let an (a) failure SKIP all of leg (b), the leg
// that actually guards the current tree (`3fd4941`/`53cdbfc`). `--workers=1` (in the `test:scaffold-real`
// script) keeps the two independent groups from running their heavy installs in parallel.

// Retain a full Playwright trace + a screenshot whenever a browser test FAILS, so a hydration
// failure off a real install is debuggable from the uploaded CI artifact (the dev server's own
// boot output is captured separately by `spawnDev`). Scoped to this spec; other e2e jobs unchanged.
test.use({ trace: "retain-on-failure", screenshot: "only-on-failure" });

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (a) Real registry install of the PUBLISHED closure (0.1.2 today), hoisted layout.
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
    // to the in-tree version (0.1.2 today) so the smoke tests an immutable published snapshot and the
    // pin advances in lockstep with the version gate above at the next republish.
    await run(
      "bunx",
      [`create-lesto@${CREATE_LESTO_VERSION}`, "pub-app", "--yes", "--no-install", "--no-git"],
      workspace,
    );

    // The headline CANARY — runs at EVERY version, including the dev-boot-skipped one: a REAL `bun install`
    // resolving every `@lesto/*` from the npm registry (the resolution `link-workspace` never performs), in
    // the DEFAULT hoisted layout, then a build of the Preact island client through the app's OWN installed
    // cli (under Bun). This install+build is the part that proves the published closure still installs and
    // builds; it stays LIVE even while only the dev boot below is skipped (see the version-gate comment above).
    await run("bun", ["install", "--linker=hoisted"], appDir);
    await run("bun", [lestoBin(appDir), "build"], appDir);

    // Boot `lesto dev` only when the published version is NOT the known-stall pin (see the gate above).
    // Published 0.1.2's dev stays alive but HANGS the first request under the hoisted layout on CI Linux
    // (confirmed a true hang at 300s), so booting it here would hang this hook for the full deadline. The
    // hydration test below is `test.skip`-ped on the SAME gate, so the two move together and un-skip in
    // lockstep at the 0.1.3 fix (L-513dd8a6).
    if (!DEV_BOOT_SKIPPED) {
      const devProc = await spawnDev(lestoBin(appDir), appDir, PORT_PUBLISHED);
      dev = devProc.child;

      await waitForServer(`http://127.0.0.1:${PORT_PUBLISHED}/`, 60_000, {
        output: devProc.output,
        hasExited: devProc.hasExited,
      });
    }
  });

  test.afterAll(async () => {
    await killAndWait(dev);

    await rm(workspace, { recursive: true, force: true });
  });

  test("the registry-installed build is the Preact bundle, never react-dom/server", async () => {
    // Live at EVERY version — needs only the build output, so it guards the published closure's
    // install+build even while the dev-dependent hydration test is version-skipped.
    await assertPreactClient(appDir);
  });

  test("the deferred island hydrates in a real browser — the button goes live", async ({ page }) => {
    // Skipped while the published version is the known-stall pin: published 0.1.2's `lesto dev` HANGS the
    // first request under the hoisted layout on CI Linux (confirmed at 300s; the `beforeAll` above skips
    // its boot to match), so there is no reachable server to hydrate against. Un-skips at the 0.1.3 fix.
    test.skip(
      DEV_BOOT_SKIPPED,
      `published ${CREATE_LESTO_VERSION} dev hangs the first request under hoisted-on-Linux (L-513dd8a6)`,
    );

    await page.goto(`http://127.0.0.1:${PORT_PUBLISHED}/`);

    const counter = page.locator('[data-testid="counter"]');

    await expect(counter).toHaveText("count: 0");

    // A click increments only AFTER hydration — the visible proof the Preact client mounted the live
    // component over the server fallback, off a real registry install. Gate the click on hydration
    // (L-d86ae3a1) so that when this un-skips at the 0.1.3 fix (L-513dd8a6) it does NOT re-inherit the
    // click-races-hydration flake the isolated leg (b) hit.
    await expectIslandHydrated(counter);
    await counter.click();

    await expect(counter).toHaveText("count: 1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (a′) Real registry install of the PUBLISHED closure (0.1.2 today), NON-HOISTING (isolated) layout.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The non-hoisting proof for the PUBLISHED closure (L-9dc62468), in its OWN serial group so an
 * isolated-specific resolution failure — or a transient network blip on this second real-registry
 * install — reds HERE and never masks leg (a)'s always-live hoisted install+build canary (the
 * file's leg-split signal-isolation rule). Published 0.1.2 carries the `@lesto/observability` fix,
 * so unlike 0.1.1 the published `@lesto/*` graph resolves AND builds the Preact bundle under
 * `--linker=isolated` too — not just the hoisted default. DECOUPLED from the stalling dev boot: it
 * installs + builds only, NEVER `spawnDev` (that hoisted-Linux hang is L-513dd8a6's alone).
 */
test.describe(`real-registry install — published ${CREATE_LESTO_VERSION}, isolated layout @published-isolated`, () => {
  test.describe.configure({ mode: "serial" });

  let workspace: string;
  let appDir: string;

  test.beforeAll(async () => {
    // A real-registry `bunx create-lesto` + isolated install + build is well past the 30s hook budget.
    test.setTimeout(600_000);

    workspace = await mkdtemp(join(tmpdir(), "lesto-real-published-iso-"));
    appDir = join(workspace, "pub-app-iso");

    // Scaffold the SAME published closure as leg (a), install it under the ISOLATED (non-hoisting)
    // linker, and build via its OWN installed cli — the proof the published graph resolves non-hoisted.
    await run(
      "bunx",
      [`create-lesto@${CREATE_LESTO_VERSION}`, "pub-app-iso", "--yes", "--no-install", "--no-git"],
      workspace,
    );
    await run("bun", ["install", "--linker=isolated"], appDir);
    await run("bun", [lestoBin(appDir), "build"], appDir);
  });

  test.afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("the published closure installs+builds the Preact bundle under the isolated linker", async () => {
    // The real teeth are in `beforeAll`: a broken non-hoisting `@lesto/observability/rum` import (the
    // exact 0.1.1 break) would red the isolated install/build there. This corroborates the built client
    // is the Preact bundle, never react-dom/server.
    await assertPreactClient(appDir);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// (b) Current-tree reconstruction, NON-HOISTING (isolated) linker.
// ─────────────────────────────────────────────────────────────────────────────────────────────

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
    const devProc = await spawnDev(lestoBin(appDir), appDir, PORT_TREE);
    dev = devProc.child;

    await waitForServer(`http://127.0.0.1:${PORT_TREE}/`, 60_000, {
      output: devProc.output,
      hasExited: devProc.hasExited,
    });
  });

  test.afterAll(async () => {
    await killAndWait(dev);

    await rm(workspace, { recursive: true, force: true });
  });

  test("the isolated install pins every @lesto/* at a packed tarball, not the registry", async () => {
    // The `overrides` guarantee: bun resolved the `@lesto/*` graph from the tarballs, never the
    // registry. If a future bun ignored overrides (or a dep were left unpinned) it would silently
    // pull the published closure — so assert against bun 1.3.5's lockfile RESOLUTION-KEY grammar: a
    // registry resolution keys as `"<name>@<version>"` (e.g. `"@lesto/errors@0.1.2"`), a tarball as
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

    // Gate the click on hydration (L-d86ae3a1): the fallback and the live component both paint
    // "count: 0", so without this the click can land on the inert fallback before @prefresh/Vite
    // attaches the handler — a lost click that RED-flags "count: 1" forever.
    await expectIslandHydrated(counter);
    await counter.click();

    await expect(counter).toHaveText("count: 1");
  });

  test("editing the island preserves useState (Fast Refresh) on scaffold output", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${PORT_TREE}/`);

    const counter = page.locator('[data-testid="counter"]');

    // Gate the FIRST click on hydration (L-d86ae3a1); once the island is interactive the remaining
    // clicks are safe. Without this the first click can race the handler attach and be lost.
    await expectIslandHydrated(counter);

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
