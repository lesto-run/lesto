import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// Resolve paths relative to this test file, so the spawn works from any cwd.
const here = dirname(fileURLToPath(import.meta.url));

const binPath = join(here, "..", "src", "bin.ts");
const fixtureDir = join(here, "fixture");

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the real bin under Bun against the fixture project.
 *
 * No shell: arguments are passed as an array, so nothing is interpolated into a
 * command string. The fixture root carries a `keel.app.ts`, which the bin loads
 * by dynamic import — exactly as a real project root would.
 */
function spawnBin(args: readonly string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [binPath, ...args], { cwd: fixtureDir });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("bin e2e", () => {
  it("loads the project's keel.app.ts and prints its routes, exiting 0", async () => {
    const result = await spawnBin(["routes"]);

    expect(result.code, result.stderr).toBe(0);

    // The fixture's `keel()` app declares these routes; `routes` prints the
    // code-first `method\tpattern` shape (no controller#action target).
    expect(result.stdout).toContain("GET\t/posts");
    expect(result.stdout).toContain("POST\t/posts");
    expect(result.stdout).toContain("GET\t/posts/:id");
  }, 30_000);
});
