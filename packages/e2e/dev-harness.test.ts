import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertPortAvailable, spawnDev, waitForServer } from "./dev-harness";

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
// so the child never BINDS the port and either exits at once or sleeps. The port is NOT cosmetic though:
// spawnDev now network-probes it before spawning (assertPortAvailable), so 4932/4933 are load-bearing
// preconditions — the fixtures below assume nothing is already listening there.
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
    const proc = await spawnDev(join(dir, "die.mjs"), dir, 4932);
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
    const proc = await spawnDev(join(dir, "sleep.mjs"), dir, 4933);

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

/**
 * A one-shot HTTP listener standing in for a `lesto dev` LEAKED by a prior crashed run — already
 * answering the fixed port when a new run starts. Bound to port 0 so the OS hands back a
 * guaranteed-free port; the caller closes it in a `finally`.
 */
async function startSquatter(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((_req, res) => res.end("stale squatter"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A raw-TCP listener that ACCEPTS the connection but never sends a byte — a wedged/cold dev server
 * that has bound the port but isn't answering HTTP yet. On loopback a free port refuses instantly, so
 * only an occupied-but-stalled port makes the probe's 2s timer fire; this stands that case up. Held
 * sockets are destroyed on close so `server.close` can actually resolve.
 */
async function startSilentAcceptor(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * The pre-spawn port probe (L-b5186728) — the REAL closure of the live-squatter false-green that
 * `hasExited` (above) structurally cannot close. hasExited only fires AFTER our own child dies of
 * EADDRINUSE, which is AFTER waitForServer's first probe already answered green against the squatter.
 * These tests stand up a real listener as the squatter (nothing here binds a `lesto dev` port), so
 * they need no server and run beside the fail-fast suite in the dedicated CI unit step.
 */
describe("pre-spawn live-squatter guard (assertPortAvailable → spawnDev)", () => {
  it("resolves for a free port — the guard is a real probe, not an unconditional throw", async () => {
    // Bind port 0 to learn a real port, then release it: nothing listens now, so the probe must see
    // ECONNREFUSED and resolve. Without this positive case the throw tests below could pass vacuously
    // — a guard that ALWAYS threw would satisfy a `.rejects` assertion just as well.
    const { port, close } = await startSquatter();
    await close();

    await expect(assertPortAvailable(port)).resolves.toBeUndefined();
  });

  it("throws when a server is already answering the port", async () => {
    const { port, close } = await startSquatter();

    try {
      await expect(assertPortAvailable(port)).rejects.toThrow(/already answering/);
    } finally {
      await close();
    }
  });

  it("fails CLOSED when a port accepts the connection but never answers (a wedged squatter, not a free port)", async () => {
    // The fail-open arm a red-team review caught: on loopback a free port refuses INSTANTLY, so the 2s
    // timer can only fire on an occupied-but-stalled port. Treating that timeout as "free" (the prior
    // behavior) would spawn into EADDRINUSE and hand the slow-squatter race back to waitForServer. The
    // probe must instead throw. Remove the `signal.aborted` branch and this reverts to resolving → RED.
    const { port, close } = await startSilentAcceptor();

    try {
      await expect(assertPortAvailable(port)).rejects.toThrow(/sent no response within 2s/);
    } finally {
      await close();
    }
  });

  it("spawnDev refuses to boot (throws BEFORE spawning) when a squatter already holds the fixed port", async () => {
    // The end-to-end wired closure: the canonical false-green is a prior run's dev still LISTENING when
    // a new run starts. spawnDev must throw from its pre-spawn probe and NEVER reach `spawn`, so
    // waitForServer never adopts the squatter's STALE code as green. The bin/dir args are deliberately
    // bogus — they're never reached; remove the probe and spawnDev would instead try to spawn them and
    // RESOLVE to a live DevProcess, flipping this assertion RED.
    const { port, close } = await startSquatter();

    try {
      await expect(spawnDev("unused-bin.mjs", "/nonexistent", port)).rejects.toThrow(
        /already answering/,
      );
    } finally {
      await close();
    }
  });
});
