import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const binPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "bin.ts");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Spawn the real bin under Bun (its shebang runtime) in `cwd`, capturing output.
function runBin(args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [binPath, ...args], { cwd });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "create-lesto-e2e-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("bin (e2e)", () => {
  it("scaffolds an app directory and exits 0", async () => {
    const result = await runBin(["tmp-app-name"], workspace);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Scaffolded tmp-app-name");

    const appDir = join(workspace, "tmp-app-name");

    await expect(access(join(appDir, "lesto.app.ts"))).resolves.toBeUndefined();
    await expect(access(join(appDir, "package.json"))).resolves.toBeUndefined();
  }, 30_000);

  it("exits non-zero with the stable code when the target exists", async () => {
    await runBin(["dupe"], workspace);

    const second = await runBin(["dupe"], workspace);

    expect(second.code).toBe(1);
    expect(second.stderr).toContain("CREATE_LESTO_TARGET_EXISTS");
  }, 30_000);
});
