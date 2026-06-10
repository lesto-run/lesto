import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDirContext {
  tempDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated temporary directory for filesystem-touching tests.
 * The returned cleanup() removes it recursively.
 *
 * Pass `baseDir` to root the temp dir somewhere other than the OS temp dir —
 * tests that load a docks.config.ts (which `import`s "zod") need the project to
 * live inside the monorepo so Node module resolution can find dependencies.
 */
export async function createTempDir(
  prefix = "content-mcp-test-",
  baseDir = tmpdir(),
): Promise<TempDirContext> {
  const tempDir = await mkdtemp(join(baseDir, prefix));

  return {
    tempDir,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
