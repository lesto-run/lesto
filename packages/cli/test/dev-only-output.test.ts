/**
 * The structural dev-only sentinel (ADR 0032 Inc 5).
 *
 * The dev MCP control plane is a PREVIEW surface — it must never reach a production build.
 * The bin enforces this by construction (it builds the dev-state ring + the `startDevMcp`
 * seam ONLY on `command === "dev"`); `assertDevOnly` is the defense in depth behind that
 * guard, and these tests are the proof that "never in production" is an invariant, not just
 * a code-path argument: a non-`dev` command carrying a dev surface is refused at `run()`
 * entry, before any command dispatch, so the loopback MCP server is never mounted.
 *
 * (The Phase-2 `/__lesto/open` editor-jump route is not built yet, so the current invariant
 * under test is the MCP-transport mount; the same sentinel will gate that route when it lands.)
 */

import { describe, expect, it, vi } from "vitest";

import { assertDevOnly, run } from "../src/run";
import type { CliDeps } from "../src/run";
import { createDevState } from "../src/dev-state";

const devSeam = {
  startDevMcp: () => Promise.resolve({ close: () => Promise.resolve() }),
};

describe("assertDevOnly", () => {
  it("allows the dev command to carry the dev surface", () => {
    expect(() => assertDevOnly("dev", { ...devSeam, devState: createDevState() })).not.toThrow();
  });

  it("allows a non-dev command (or none) that carries NO dev surface — the production default", () => {
    for (const command of ["serve", "build", "deploy", undefined]) {
      expect(() => assertDevOnly(command, {})).not.toThrow();
    }
  });

  it("refuses any non-dev command (incl. none) that carries the startDevMcp seam", () => {
    for (const command of ["serve", undefined]) {
      let caught: unknown;

      try {
        assertDevOnly(command, devSeam);
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({ code: "CLI_DEV_SURFACE_IN_PRODUCTION" });
    }
  });

  it("refuses a non-dev command that carries ANY single dev surface (ring, live reload, island dev, or AI overlay)", () => {
    // Each dev-only surface alone trips the sentinel — not just the MCP seam.
    const surfaces = [
      { devState: createDevState() },
      { liveReload: { script: "", notify() {}, close() {} } },
      { islandDev: () => undefined },
      { aiOverlay: { script: "" } },
    ];

    for (const surface of surfaces) {
      expect(() => assertDevOnly("build", surface)).toThrow(/must run only under `lesto dev`/);
    }
  });
});

describe("the dev MCP surface never reaches a production command", () => {
  it("run() refuses serve/build/deploy when a dev surface is wired, never standing it up", async () => {
    for (const command of ["serve", "build", "deploy"]) {
      const startDevMcp = vi.fn(() => Promise.resolve({ close: () => Promise.resolve() }));

      // The sentinel throws at `run()` entry, BEFORE any command dispatch — so a partial
      // deps (whose other seams are never reached) is a faithful minimal stand-in.
      const deps = { startDevMcp, devState: createDevState() } as unknown as CliDeps;

      await expect(run([command], deps)).rejects.toMatchObject({
        code: "CLI_DEV_SURFACE_IN_PRODUCTION",
      });

      // It threw at the gate — the dev MCP server was never mounted.
      expect(startDevMcp).not.toHaveBeenCalled();
    }
  });
});
