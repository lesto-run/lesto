import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
 * The MUTABLE-TREE HOISTED dev-boot preflight (L-513dd8a6) — the pre-publish CANARY for the
 * L-27285131 hang class. Run BEFORE a publish (dispatch / nightly) it would have caught the hang;
 * it is NOT yet wired into `release.yml` as a blocking gate (a follow-up — and one that must land
 * only AFTER the fix, since a blocking gate on the still-hung tree would deadlock the 0.1.3 release
 * that ships the fix).
 *
 * ⚠️ NOT YET CONFIRMED ON THIS PATH: the 300s hang was observed against the IMMUTABLE PUBLISHED
 * closure (`bunx create-lesto@0.1.2`), NOT the current-tree tarball path this spec installs. It
 * SHOULD reproduce (published dev code == the tree) but has NOT yet been observed RED on
 * `ubuntu-latest` — dispatch it once against the unfixed tree to confirm it reds before trusting it.
 * If it greens, the current tree has drifted from published-0.1.2's dev and it is reproducing nothing.
 *
 * `scaffold-real-install.spec.ts` has two legs, and NEITHER boots `lesto dev` under the hoisted
 * linker against a FIXABLE tree:
 *   - leg (a) boots the PUBLISHED closure hoisted — but that closure is IMMUTABLE, so when its dev
 *     hangs (published 0.1.2 never answers the first `GET /` under hoisted-on-Linux — a true hang
 *     confirmed at 300s) there is no repo-side fix; the leg can only SKIP its dev boot until a
 *     republish. That is precisely why the hang was only discoverable POST-publish.
 *   - leg (b) boots the CURRENT tree — but under the ISOLATED linker, which does NOT reproduce the
 *     hang (the same dev code answers fine isolated on the same Linux runner).
 *
 * The uncovered quadrant — CURRENT tree × HOISTED linker — is the one a real `bun create lesto &&
 * cd app && bun install && lesto dev` user actually gets, because HOISTED is bun's standalone-scaffold
 * DEFAULT. This spec fills it: pack the current `@lesto/*` closure to tarballs, scaffold via the
 * in-repo `create-lesto`, pin onto the tarballs, then `bun install --linker=hoisted`, build, boot
 * `lesto dev`, and assert the FIRST `GET /` answers. Since the published dev code == the tree, this
 * SHOULD reproduce the L-27285131 hang on a FIXABLE target (see the ⚠️ above — unconfirmed on Linux)
 * — so a fix can be red/greened here on Linux CI instead of only against the immutable published
 * leg (a), and this becomes the standing pre-publish canary against a regression of the same class.
 *
 * On macOS (where the hang does NOT reproduce — hoisted dev answers in ~24ms) and once the Linux hang
 * is fixed, this passes fast. On the still-hung path the first-GET wait is BOUNDED (120s, well under
 * the 600s hook budget) so it fails FAST with a named message rather than hanging the whole job.
 */

// A fresh fixed port, clear of the fixture webServer's 4180 and the other specs' 4188/4189/4190/4191.
const PORT = 4192;

// Retain a full Playwright trace + screenshot whenever a browser test FAILS, so a hoisted hang (or a
// hydration failure) off a real install is debuggable from the uploaded CI artifact. The dev server's
// own boot output is captured separately by `spawnDev` and named in the first-GET timeout message below.
test.use({ trace: "retain-on-failure", screenshot: "only-on-failure" });

test.describe("current-tree HOISTED dev-boot preflight — the L-513dd8a6 gate @tree-hoisted", () => {
  // One serial group: scaffold + install + build once, share a single `lesto dev` across the tests.
  test.describe.configure({ mode: "serial" });

  let workspace: string;
  let appDir: string;
  let dev: ChildProcess | undefined;

  test.beforeAll(async () => {
    // Packing + a real hoisted `bun install` + build is well past Playwright's default 30s hook budget.
    test.setTimeout(600_000);

    workspace = await mkdtemp(join(tmpdir(), "lesto-hoisted-preflight-"));
    const vendor = join(workspace, "vendor");
    await mkdir(vendor, { recursive: true });
    appDir = join(workspace, "hoisted-app");

    // Pack the CURRENT tree's `@lesto/*` closure — the publish stand-in for the working tree, so this
    // gate exercises the code that WILL be published, not a stale registry snapshot.
    const overrides = packLestoClosure(REPO_ROOT, vendor);

    // Scaffold via the IN-REPO create-lesto (the working-tree scaffold: `ui.dialect: "preact"`, so
    // `lesto dev` loads `@prefresh/vite` — the rolldown-native path the hang is suspected to sit on).
    await run("bun", [CREATE_LESTO_BIN, "hoisted-app", "--yes", "--no-install", "--no-git"], workspace);

    // Repin the whole `@lesto/*` graph onto the tarballs, then install under the HOISTED (flat
    // node_modules) linker — the DEFAULT a real `bun create lesto` user gets, and the layout under
    // which published-0.1.2 dev hangs the first request on CI Linux.
    await pinAppToTarballs(appDir, overrides);
    await run("bun", ["install", "--linker=hoisted"], appDir);

    // Build the Preact island client via the app's OWN installed cli, under Bun.
    await run("bun", [lestoBin(appDir), "build"], appDir);

    // Boot `lesto dev` and gate on the FIRST `GET /`. On the hung path the child stays ALIVE and bound
    // (the listen callback fires; `hasExited` never trips), so `waitForServer` polls to its deadline —
    // BOUND it to 120s so this reds FAST instead of eating the whole 600s hook. Re-throw with a named
    // message so the artifact makes the failure legible as the L-513dd8a6 hang on a FIXABLE tree.
    const devProc = await spawnDev(lestoBin(appDir), appDir, PORT);
    dev = devProc.child;

    try {
      await waitForServer(`http://127.0.0.1:${PORT}/`, 120_000, {
        output: devProc.output,
        hasExited: devProc.hasExited,
      });
    } catch (cause) {
      throw new Error(
        "hoisted-tree `lesto dev` first GET timed out — the L-513dd8a6 hang, now on a FIXABLE tree " +
          "(current-tree + hoisted linker on Linux). This is the pre-publish gate for L-27285131; " +
          "root-cause + fix it in `@lesto/island-dev` (suspected first-request Vite/@prefresh/rolldown " +
          "dep-optimize stall under flat node_modules), then this greens.",
        { cause },
      );
    }
  });

  test.afterAll(async () => {
    // AWAIT the child's exit (SIGKILL-escalate after grace) rather than fire-and-forget SIGTERM: this
    // spec pins a FIXED port (4192) that `spawnDev`'s pre-spawn `assertPortAvailable` re-probes, so on
    // a CI retry a still-dying prior child would hold the port and RED the probe — burning the one
    // retry. `killAndWait` releases the port before this resolves (L-2a28bde6); null/exited-safe.
    await killAndWait(dev);

    await rm(workspace, { recursive: true, force: true });
  });

  test("the hoisted build is the Preact bundle, never react-dom/server", async () => {
    // A cheap corroborating check that the hoisted install produced the same Preact client the other
    // legs assert — so a green here also proves the hoisted layout builds the right bundle.
    await assertPreactClient(appDir);
  });

  test("the hoisted-tree dev server answers and the deferred island hydrates", async ({ page }) => {
    // The `beforeAll` first-GET wait is the real gate (it reds fast on the hang). This is the lean
    // end-to-end proof that once the server answers, the Preact client mounts over the server fallback.
    await page.goto(`http://127.0.0.1:${PORT}/`);

    const counter = page.locator('[data-testid="counter"]');

    await expect(counter).toHaveText("count: 0");

    // Gate the click on hydration (L-d86ae3a1) via the shared helper — a NON-clicking wait for the
    // island's live `title` attribute (which its SSR fallback button lacks), so the single click below
    // can't race the @prefresh/Vite handler attach and be lost. Full rationale in `expectIslandHydrated`.
    await expectIslandHydrated(counter);

    // A click increments only AFTER hydration — the visible proof the island went live under the
    // hoisted layout, off a real install.
    await counter.click();

    await expect(counter).toHaveText("count: 1");
  });
});
