/**
 * `buildStyles` is pure orchestration over the {@link StyleCompiler} seam — so a
 * fake compiler drives every branch (happy path, the report, the budget verdict,
 * and the failure mapping) without Tailwind or a disk. The fakes return a written
 * path + gzip size + deps, or throw, exactly as TW2's real compiler will.
 */

import { describe, expect, it, vi } from "vitest";

import { buildStyles } from "../src/build-styles";
import type { CompiledStyles, StyleCompiler } from "../src/build-styles";
import { StylesError } from "../src/errors";

/** A fake compiler that "writes" a stylesheet — override fields per test. */
function okCompiler(over: Partial<CompiledStyles> = {}): StyleCompiler {
  return {
    compile: async () => ({
      path: "out/styles.css",
      gzipBytes: 1024,
      dependencies: ["app/page.tsx"],
      ...over,
    }),
  };
}

/** A fake compiler that fails. */
function throwingCompiler(error: unknown): StyleCompiler {
  return {
    compile: async () => {
      throw error;
    },
  };
}

const base = { entry: "app/styles.css", outDir: "out", mode: "production" } as const;

describe("buildStyles", () => {
  it("returns the compiled path, gzip size, and dependencies", async () => {
    const result = await buildStyles(base, okCompiler());

    expect(result).toEqual({
      path: "out/styles.css",
      gzipBytes: 1024,
      dependencies: ["app/page.tsx"],
    });
  });

  it("passes the entry, outDir, default outName, and mode to the compiler", async () => {
    const compile = vi.fn(async () => ({
      path: "out/styles.css",
      gzipBytes: 10,
      dependencies: [],
    }));

    await buildStyles({ entry: "e.css", outDir: "out", mode: "development" }, { compile });

    expect(compile).toHaveBeenCalledWith({
      entry: "e.css",
      outDir: "out",
      outName: "styles.css",
      mode: "development",
    });
  });

  it("honors a custom outName", async () => {
    const compile = vi.fn(async () => ({ path: "out/app.css", gzipBytes: 10, dependencies: [] }));

    await buildStyles({ ...base, outName: "app.css" }, { compile });

    expect(compile).toHaveBeenCalledWith(expect.objectContaining({ outName: "app.css" }));
  });

  it("narrates exactly one report line with the gzip size and no budget note", async () => {
    const lines: string[] = [];

    await buildStyles(
      { ...base, report: (line) => lines.push(line) },
      okCompiler({ gzipBytes: 2048 }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("styles.css");
    expect(lines[0]).toContain("2.0 KB gzip");
    expect(lines[0]).not.toContain("OVER");
  });

  it("defaults the report to a no-op when none is given", async () => {
    await expect(buildStyles(base, okCompiler())).resolves.toBeDefined();
  });

  it("passes a result that is under budget", async () => {
    const result = await buildStyles(
      { ...base, budgetBytes: 4096 },
      okCompiler({ gzipBytes: 1024 }),
    );

    expect(result.gzipBytes).toBe(1024);
  });

  it("fails STYLES_BUDGET_EXCEEDED when over budget, and narrates the overshoot", async () => {
    const lines: string[] = [];

    const error = await buildStyles(
      { ...base, budgetBytes: 1000, report: (line) => lines.push(line) },
      okCompiler({ gzipBytes: 5000 }),
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(StylesError);
    expect((error as StylesError).code).toBe("STYLES_BUDGET_EXCEEDED");
    expect((error as StylesError).details).toMatchObject({ gzipBytes: 5000, budgetBytes: 1000 });
    expect(lines[0]).toContain("OVER budget");
  });

  it("propagates a coded StylesError from the compiler (e.g. a missing entry)", async () => {
    const entryError = new StylesError("STYLES_ENTRY_NOT_FOUND", "no such entry");

    const error = await buildStyles(
      { ...base, entry: "missing.css" },
      throwingCompiler(entryError),
    ).catch((thrown: unknown) => thrown);

    expect(error).toBe(entryError);
    expect((error as StylesError).code).toBe("STYLES_ENTRY_NOT_FOUND");
  });

  it("wraps a non-StylesError compiler throw as STYLES_COMPILE_FAILED", async () => {
    const error = await buildStyles(base, throwingCompiler(new Error("tailwind boom"))).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(StylesError);
    expect((error as StylesError).code).toBe("STYLES_COMPILE_FAILED");
    expect((error as StylesError).message).toContain("tailwind boom");
  });

  it("stringifies a non-Error compiler throw in the wrapped message", async () => {
    const error = await buildStyles(base, throwingCompiler("plain string failure")).catch(
      (thrown: unknown) => thrown,
    );

    expect((error as StylesError).code).toBe("STYLES_COMPILE_FAILED");
    expect((error as StylesError).message).toContain("plain string failure");
  });
});
