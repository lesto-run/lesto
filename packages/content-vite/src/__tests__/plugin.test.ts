import { describe, it, expect, vi } from "vitest";
import { docks } from "../plugin";

describe("docks plugin", () => {
  it("returns a vite plugin with correct name", () => {
    const plugin = docks();
    expect(plugin.name).toBe("docks");
  });

  it("has required lifecycle hooks", () => {
    const plugin = docks();
    expect(typeof plugin.config).toBe("function");
    expect(typeof plugin.configResolved).toBe("function");
    expect(typeof plugin.buildStart).toBe("function");
    expect(typeof plugin.configureServer).toBe("function");
    expect(typeof plugin.closeBundle).toBe("function");
  });

  it("accepts debug option", () => {
    const consoleSpy = vi.spyOn(console, "log");
    const plugin = docks({ debug: true });
    expect(plugin).toBeDefined();
    consoleSpy.mockRestore();
  });

  it("accepts outDir option", () => {
    const plugin = docks({
      outDir: "/custom/output",
    });
    expect(plugin).toBeDefined();
  });

  it("accepts all options combined", () => {
    const plugin = docks({
      debug: true,
      outDir: "/custom/output",
    });
    expect(plugin).toBeDefined();
    expect(plugin.name).toBe("docks");
  });
});
