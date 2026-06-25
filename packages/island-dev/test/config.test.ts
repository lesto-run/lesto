/**
 * The pure Vite config builder. The load-bearing fields are asserted directly: the
 * ports, `base: "/@lesto-dev/"`, `appType: "custom"`, the public-env define passthrough,
 * the per-dialect runtime dedupe + optimizeDeps (the duplicate-runtime guard), and the
 * preact dialect's ANCHORED `react` → `preact/compat` alias map (so `react` is rewritten
 * without also catching `react-dom`).
 */

import { describe, expect, it } from "vitest";

import { viteIslandConfig } from "../src/config";

const base = { root: "/proj", vitePort: 24677, hmrPort: 24678 } as const;

describe("viteIslandConfig", () => {
  it("builds the react config with no resolve aliases", () => {
    const config = viteIslandConfig({ ...base, dialect: "react" });

    expect(config.root).toBe("/proj");
    expect(config.base).toBe("/@lesto-dev/");
    expect(config.appType).toBe("custom");
    expect(config.configFile).toBe(false);
    expect(config.server).toEqual({
      host: "127.0.0.1",
      port: 24677,
      strictPort: true,
      hmr: { port: 24678 },
    });
    expect(config.resolve.alias).toEqual([]);
    expect(config.define).toEqual({});

    // The react runtime is deduped to one copy and pre-bundled (no per-island re-optimize).
    expect(config.resolve.dedupe).toEqual(["react", "react-dom"]);
    expect(config.optimizeDeps.include).toEqual([
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
    ]);
  });

  it("anchors each preact alias so react-dom is not caught by react", () => {
    const config = viteIslandConfig({ ...base, dialect: "preact" });

    const reactAlias = config.resolve.alias.find((a) => a.replacement === "preact/compat");

    expect(reactAlias).toBeDefined();
    expect(reactAlias?.find.test("react")).toBe(true);
    expect(reactAlias?.find.test("react-dom")).toBe(false);

    // The slash-bearing specifiers are aliased too (escaped, anchored).
    const jsxAlias = config.resolve.alias.find((a) => a.find.test("react/jsx-runtime"));

    expect(jsxAlias?.replacement).toBe("preact/jsx-runtime");
    expect(jsxAlias?.find.test("react/jsx-runtimeX")).toBe(false);

    // The preact runtime is deduped to one copy; the aliased compat layer is pre-bundled.
    expect(config.resolve.dedupe).toEqual(["preact"]);
    expect(config.optimizeDeps.include).toContain("preact/compat");
  });

  it("inlines the verified public-env define as a copy", () => {
    const publicEnvDefine = { "process.env.PUBLIC_API": '"https://api.example.com"' };

    const config = viteIslandConfig({ ...base, dialect: "react", publicEnvDefine });

    expect(config.define).toEqual(publicEnvDefine);
    expect(config.define).not.toBe(publicEnvDefine);
  });
});
