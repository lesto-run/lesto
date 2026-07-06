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
 * The MUTABLE-TREE HOISTED dev-boot preflight (L-513dd8a6) — the pre-publish CANARY that boots the
 * CURRENT tree under bun's standalone-scaffold DEFAULT linker (hoisted) and proves `lesto dev` answers
 * an undici `fetch()` + a browser hydrates. This is the quadrant neither `scaffold-real-install` leg
 * covers: leg (a) is the PUBLISHED closure hoisted (immutable — no repo-side fix if it regresses), and
 * leg (b) is the current tree ISOLATED. A real `bun create lesto && cd app && bun install && lesto dev`
 * user gets current-tree-equivalent code × hoisted, so this fills it against a FIXABLE tree.
 *
 * ✅ CONTEXT (2026-07-05, L-513dd8a6): the "L-27285131 hoisted-Linux first-request HANG" that motivated
 * this preflight turned out to be a TEST-HARNESS PORT BUG, not a product defect — `scaffold-real` leg (a)
 * booted on port **4190**, which an undici `fetch()` refuses with "bad port" (the WHATWG fetch restricted-
 * ports list) before ever connecting. There is no dep-optimize / @prefresh / rolldown stall; the published
 * dev answers undici fine on a reachable port. So this preflight is a genuine, non-blind gate: it uses the
 * SAME undici `fetch()` a real user's tooling does, on a FETCHABLE port (4192), and reds on a REAL dev-boot
 * regression (a genuinely-broken dev, a bad bundle, a bind failure) — NOT on the port artifact. (It greened
 * throughout the investigation for the ordinary reason: the tree's dev works AND 4192 is reachable — see
 * the `scaffold-e2e-masks-real-resolution` note, now corrected. `assertFetchablePort` in dev-harness.ts
 * guarantees no spec can silently reintroduce a blocked port.)
 *
 * The first-GET wait is BOUNDED (120s, well under the 600s hook budget) so a real regression reds FAST
 * with a named message rather than hanging the whole job.
 */

// A fetchable fixed port (NOT on the fetch restricted-ports list — `assertFetchablePort` enforces),
// clear of the fixture webServer's 4180 and the other specs' 4188/4189/4191/4193.
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

    // Boot `lesto dev` on the fetchable port and gate on the FIRST `GET /`. BOUND the wait to 120s so a
    // real regression (a dev that never binds, a broken bundle) reds FAST instead of eating the whole 600s
    // hook. Re-throw with a named message so the artifact makes the failure legible as a genuine hoisted-
    // tree dev-boot break — not the old port artifact (`assertFetchablePort` already rejects a blocked port
    // at spawn, so a "never answered" here means the SERVER is at fault, not the port).
    const devProc = await spawnDev(lestoBin(appDir), appDir, PORT);
    dev = devProc.child;

    try {
      await waitForServer(`http://127.0.0.1:${PORT}/`, 120_000, devProc);
    } catch (cause) {
      throw new Error(
        "hoisted-tree `lesto dev` first GET failed — the current tree does not boot a reachable dev " +
          "server under bun's hoisted (flat node_modules) linker, the real `bun create lesto` default. " +
          "This is a genuine dev-boot regression (the port is already proven fetchable); triage the " +
          "captured dev output above.",
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
