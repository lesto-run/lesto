import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { nn } from "./test-utils";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveConfig, resolveConfigFile } from "../config";
import type { EngineConfig } from "../types";
import { z } from "zod";

/**
 * Coerce an arbitrary (possibly invalid) object into {@link EngineConfig} for tests that
 * exercise `resolveConfig`'s runtime validation. Mirrors deserializing untrusted config.
 */
function asEngineConfig(value: object): EngineConfig {
  return value as EngineConfig;
}

/** No-op validation-warning callback used to assert callback identity is preserved. */
const noopValidationWarning = (): void => {};

describe("config", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "docks-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("resolveConfigFile", () => {
    it("finds docks.config.ts", async () => {
      await writeFile(path.join(tempDir, "docks.config.ts"), "export default {}");

      const result = await resolveConfigFile(tempDir);

      expect(result?.ext).toBe(".ts");
      expect(result?.path).toContain("docks.config.ts");
    });

    it("returns undefined when no config found", async () => {
      const result = await resolveConfigFile(tempDir);

      expect(result).toBeUndefined();
    });

    it("prefers .ts over .js", async () => {
      await writeFile(path.join(tempDir, "docks.config.ts"), "export default {}");
      await writeFile(path.join(tempDir, "docks.config.js"), "module.exports = {}");

      const result = await resolveConfigFile(tempDir);

      expect(result?.ext).toBe(".ts");
    });
  });

  describe("resolveConfig", () => {
    it("throws when no config file and no programmatic config", async () => {
      await expect(resolveConfig(tempDir)).rejects.toThrow("No docks.config.{ts,js,mjs} found");
    });

    it("uses programmatic config when provided", async () => {
      const config = {
        collections: [
          {
            name: "posts",
            directory: "content/posts",
            schema: z.object({ title: z.string() }),
          },
        ],
      };

      const result = await resolveConfig(tempDir, asEngineConfig(config));

      expect(result.configPath).toBeNull();
      expect(result.collections).toHaveLength(1);
      expect(nn(result.collections[0]).name).toBe("posts");
    });

    it("validates collections is an array", async () => {
      const config = { collections: "not-an-array" };

      await expect(resolveConfig(tempDir, asEngineConfig(config))).rejects.toThrow(
        "collections must be an array",
      );
    });

    it("validates collection has name", async () => {
      const config = {
        collections: [{ directory: "content", schema: {} }],
      };

      await expect(resolveConfig(tempDir, asEngineConfig(config))).rejects.toThrow(
        "collections[0].name must be a non-empty string",
      );
    });

    it("validates collection has directory", async () => {
      const config = {
        collections: [{ name: "posts", schema: {} }],
      };

      await expect(resolveConfig(tempDir, asEngineConfig(config))).rejects.toThrow(
        "collections[0].directory must be a non-empty string",
      );
    });

    it("validates collection has schema", async () => {
      const config = {
        collections: [{ name: "posts", directory: "content" }],
      };

      await expect(resolveConfig(tempDir, asEngineConfig(config))).rejects.toThrow(
        "collections[0].schema is required",
      );
    });

    it("defaults mode to development", async () => {
      const config = {
        collections: [{ name: "posts", directory: "content", schema: z.object({}) }],
      };

      const result = await resolveConfig(tempDir, asEngineConfig(config));

      expect(result.mode).toBe("development");
    });

    it("preserves callbacks", async () => {
      const config = {
        collections: [{ name: "posts", directory: "content", schema: z.object({}) }],
        onValidationWarning: noopValidationWarning,
      };

      const result = await resolveConfig(tempDir, asEngineConfig(config));

      expect(result.onValidationWarning).toBe(noopValidationWarning);
    });
  });
});
