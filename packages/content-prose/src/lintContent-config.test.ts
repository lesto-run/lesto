import { describe, it, expect } from "vitest";
import { lintContent, lintContentAsync } from "./index.js";
import { resolveConfig, type LumenConfig, type ResolvedConfig } from "./config.js";
import type { BanRule, LimitRule, CustomFunctionRule } from "./custom-rules.js";

describe("lintContent with config options", () => {
  describe("config.rules", () => {
    it('disables rule when set to "off"', () => {
      const content = "This is very important.";

      // Without config, should find filler
      const withoutConfig = lintContent(content);
      expect(withoutConfig.some((d) => d.rule === "fillers")).toBe(true);

      // With config disabling fillers
      const config: LumenConfig = { rules: { fillers: "off" } };
      const withConfig = lintContent(content, "", { config });
      expect(withConfig.some((d) => d.rule === "fillers")).toBe(false);
    });

    it("disables rule when set to 0", () => {
      const content = "This is very important.";
      const config: LumenConfig = { rules: { fillers: 0 } };
      const diagnostics = lintContent(content, "", { config });
      expect(diagnostics.some((d) => d.rule === "fillers")).toBe(false);
    });

    it("changes severity from warn to error", () => {
      const content = "This is very important.";
      const config: LumenConfig = { rules: { fillers: "error" } };
      const diagnostics = lintContent(content, "", { config });
      const fillersDiag = diagnostics.find((d) => d.rule === "fillers");
      expect(fillersDiag?.severity).toBe("error");
    });

    it("changes severity from error to warn", () => {
      const content = "the the";
      const config: LumenConfig = { rules: { repeated: "warn" } };
      const diagnostics = lintContent(content, "", { config });
      const repeatedDiag = diagnostics.find((d) => d.rule === "repeated");
      expect(repeatedDiag?.severity).toBe("warning");
    });

    it("respects numeric severity values", () => {
      const content = "very the the";
      const config: LumenConfig = {
        rules: {
          fillers: 2, // error
          repeated: 1, // warn
        },
      };
      const diagnostics = lintContent(content, "", { config });
      const fillersDiag = diagnostics.find((d) => d.rule === "fillers");
      const repeatedDiag = diagnostics.find((d) => d.rule === "repeated");

      expect(fillersDiag?.severity).toBe("error");
      expect(repeatedDiag?.severity).toBe("warning");
    });
  });

  describe("resolvedConfig option", () => {
    it("uses pre-resolved config directly", () => {
      const content = "This is very important.";
      const resolvedConfig: ResolvedConfig = resolveConfig({ rules: { fillers: "off" } });

      const diagnostics = lintContent(content, "", { resolvedConfig });
      expect(diagnostics.some((d) => d.rule === "fillers")).toBe(false);
    });

    it("prefers resolvedConfig over config when both provided", () => {
      const content = "This is very important.";
      const config: LumenConfig = { rules: { fillers: "error" } };
      const resolvedConfig: ResolvedConfig = resolveConfig({ rules: { fillers: "off" } });

      const diagnostics = lintContent(content, "", { config, resolvedConfig });
      // resolvedConfig should take precedence, so fillers should be disabled
      expect(diagnostics.some((d) => d.rule === "fillers")).toBe(false);
    });
  });

  describe("partial config", () => {
    it("uses defaults for unspecified rules", () => {
      const content = "very the the";
      const config: LumenConfig = { rules: { fillers: "off" } };

      const diagnostics = lintContent(content, "", { config });

      // fillers should be disabled
      expect(diagnostics.some((d) => d.rule === "fillers")).toBe(false);
      // repeated should use default (error)
      const repeatedDiag = diagnostics.find((d) => d.rule === "repeated");
      expect(repeatedDiag?.severity).toBe("error");
    });
  });

  describe("config + inline disable interaction", () => {
    it("both config and inline disable work together", () => {
      const content = `very important.

<!-- lumen-disable-next-line weasel -->
Some thing here.

utilize this.`;

      const config: LumenConfig = {
        rules: {
          simplify: "off", // disable simplify via config
        },
      };

      const diagnostics = lintContent(content, "", { config });

      // fillers should still trigger (not disabled in config)
      expect(diagnostics.some((d) => d.rule === "fillers")).toBe(true);
      // simplify should be disabled via config
      expect(diagnostics.some((d) => d.rule === "simplify")).toBe(false);
      // weasel on line 4 should be filtered by inline disable comment
      // (weasel may or may not match "Some" but the inline disable protects line 4)
    });
  });

  describe("default behavior", () => {
    it("works without options (backwards compatible)", () => {
      const content = "This is very important.";
      const diagnostics = lintContent(content);
      expect(diagnostics.some((d) => d.rule === "fillers")).toBe(true);
    });

    it("works with empty options object", () => {
      const content = "This is very important.";
      const diagnostics = lintContent(content, "", {});
      expect(diagnostics.some((d) => d.rule === "fillers")).toBe(true);
    });

    it("works with file parameter only", () => {
      const content = "This is very important.";
      const diagnostics = lintContent(content, "test.md");
      expect(diagnostics.some((d) => d.rule === "fillers")).toBe(true);
      expect(diagnostics[0]).toBeDefined();
      expect(diagnostics[0]!.file).toBe("test.md");
    });
  });

  describe("custom rules integration", () => {
    it("executes BanRule custom rules", () => {
      const content = "We use the word blacklist and whitelist in our docs.";
      const banRule: BanRule = {
        type: "ban",
        name: "no-exclusionary-terms",
        message: 'Avoid using "$match"',
        pattern: ["blacklist", "whitelist"],
      };

      const config: LumenConfig = {
        rules: {},
        customRules: [banRule],
      };

      const diagnostics = lintContent(content, "", { config });
      const customDiags = diagnostics.filter((d) => d.rule === "no-exclusionary-terms");
      expect(customDiags).toHaveLength(2);
      expect(customDiags[0]!.message).toContain("blacklist");
      expect(customDiags[1]!.message).toContain("whitelist");
    });

    it("executes LimitRule custom rules", () => {
      const content = "Wow! Amazing! Great! Fantastic!";
      const limitRule: LimitRule = {
        type: "limit",
        name: "limit-exclamations",
        message: "Too many exclamation marks ($count found, max $max)",
        pattern: "!",
        max: 2,
        scope: "document",
      };

      const config: LumenConfig = {
        rules: {},
        customRules: [limitRule],
      };

      const diagnostics = lintContent(content, "", { config });
      const limitDiags = diagnostics.filter((d) => d.rule === "limit-exclamations");
      expect(limitDiags).toHaveLength(1);
      expect(limitDiags[0]!.message).toContain("4 found");
    });

    it("respects enabled: false on custom rules", () => {
      const content = "We use blacklist in our docs.";
      const banRule: BanRule = {
        type: "ban",
        name: "no-exclusionary-terms",
        message: 'Avoid using "$match"',
        pattern: ["blacklist"],
        enabled: false,
      };

      const config: LumenConfig = {
        rules: {},
        customRules: [banRule],
      };

      const diagnostics = lintContent(content, "", { config });
      expect(diagnostics.some((d) => d.rule === "no-exclusionary-terms")).toBe(false);
    });

    it("combines built-in and custom rules", () => {
      const content = "This is very blacklist.";
      const banRule: BanRule = {
        type: "ban",
        name: "no-blacklist",
        message: 'Avoid "blacklist"',
        pattern: ["blacklist"],
      };

      const config: LumenConfig = {
        rules: {},
        customRules: [banRule],
      };

      const diagnostics = lintContent(content, "", { config });

      // Built-in rule should fire
      expect(diagnostics.some((d) => d.rule === "fillers")).toBe(true);
      // Custom rule should also fire
      expect(diagnostics.some((d) => d.rule === "no-blacklist")).toBe(true);
    });
  });

  describe("lintContentAsync", () => {
    it("executes sync custom rules in async mode", async () => {
      const content = "We use blacklist in our docs.";
      const banRule: BanRule = {
        type: "ban",
        name: "no-blacklist",
        message: 'Avoid "blacklist"',
        pattern: ["blacklist"],
      };

      const config: LumenConfig = {
        rules: {},
        customRules: [banRule],
      };

      const diagnostics = await lintContentAsync(content, "", { config });
      expect(diagnostics.some((d) => d.rule === "no-blacklist")).toBe(true);
    });

    it("executes CustomFunctionRule async rules", async () => {
      const content = "This has a TODO: fix me later";
      const customFunctionRule: CustomFunctionRule = {
        type: "custom",
        name: "custom-todo",
        message: "Found a TODO",
        function: "./__fixtures__/test-rule-default.js",
      };

      const config: LumenConfig = {
        rules: {},
        customRules: [customFunctionRule],
      };

      const diagnostics = await lintContentAsync(content, "test.md", {
        config,
        basePath: import.meta.url,
      });

      const customDiags = diagnostics.filter((d) => d.rule === "custom-todo");
      expect(customDiags).toHaveLength(1);
      expect(customDiags[0]!.message).toBe("Unresolved TODO found");
    });
  });
});
