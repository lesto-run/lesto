import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { spawnDev, waitForServer } from "./dev-harness";

// The fail-fast guard added in 9842aec (spawnDev exposes `hasExited`, wired into `waitForServer` at
// every fixed-port dev spec) fires ONLY when a `lesto dev` child dies at boot — the happy path every
// nightly exercises leaves it a no-op. So a green nightly structurally CANNOT prove the guard works;
// its first real proof would arrive exactly at the boot failure it exists to diagnose. This suite is
// that proof, and it needs no server — a fast-dying child + probes to a closed port (ECONNREFUSED,
// caught) — so it runs where the network-gated Playwright specs can't. `lesto-e2e` is coverage-exempt
// and skipped by the workspace filter, so it runs in the dedicated CI unit step (ci.yml) beside
// link-workspace.test.ts, via `bunx vitest run packages/e2e/dev-harness.test.ts`.
//
// spawnDev runs `bun <bin> dev --port <port>`; here <bin> is a throwaway script that ignores its argv,
// so the child never binds the port (its value is cosmetic) and either exits at once or sleeps.
describe("dev-harness fail-fast guard (spawnDev.hasExited → waitForServer)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lesto-devharness-"));
    // Exits the instant bun runs it — models a `lesto dev` that dies at boot.
    await writeFile(join(dir, "die.mjs"), "process.exit(1);\n");
    // Stays alive well past the test — models a healthy dev server (that never binds a port here).
    await writeFile(join(dir, "sleep.mjs"), "setTimeout(() => process.exit(0), 30_000);\n");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("short-circuits on an already-exited child instead of polling to the deadline", async () => {
    const start = Date.now();

    // Closed port + a generous 10s deadline: were the guard absent, this would poll 4931 for the full
    // 10s and throw the DEADLINE message ("never answered"). The guard must throw the EXIT message on
    // iteration 1, near-instantly. Asserting the exit message AND the sub-second bound is what makes
    // this fail if the guard is ever removed or made vacuous — a `never answered` throw fails the
    // message match, and a 10s poll fails the timing bound.
    await expect(
      waitForServer("http://127.0.0.1:4931/", 10_000, { hasExited: () => true }),
    ).rejects.toThrow(/exited before answering/);

    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("flips false → true across a real child's death and feeds waitForServer's fail-fast end-to-end", async () => {
    const proc = spawnDev(join(dir, "die.mjs"), dir, 4932);
    const start = Date.now();

    // Exercises the REAL wired closure: spawnDev's own `hasExited` (flipped by its `exit` listener)
    // driving waitForServer. Nothing ever listens on 4932; without the wiring this polls the dead port
    // for 10s and throws "never answered". With it, the exit event flips the flag and waitForServer
    // rejects in well under a second with the exit message.
    await expect(
      waitForServer("http://127.0.0.1:4932/", 10_000, {
        output: proc.output,
        hasExited: proc.hasExited,
      }),
    ).rejects.toThrow(/exited before answering/);

    expect(Date.now() - start).toBeLessThan(5_000);
    expect(proc.hasExited()).toBe(true);
  });

  it("reports NOT-exited while the child is alive — the flag is live state, not a stuck constant", async () => {
    const proc = spawnDev(join(dir, "sleep.mjs"), dir, 4933);

    try {
      // Give bun time to launch; a live child MUST report false. A vacuous `() => true` double — the
      // exact trap this repo has been bitten by — would fail here, bracketing the flip test above so
      // the two together prove real false→true transition, not a constant.
      await new Promise((resolve) => setTimeout(resolve, 700));

      expect(proc.hasExited()).toBe(false);
    } finally {
      proc.child.kill("SIGKILL");
    }
  });
});
