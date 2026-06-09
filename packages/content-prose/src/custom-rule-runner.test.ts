import { describe, it, expect, beforeEach } from "vitest";
import {
  runLimitRule,
  runConsistentRule,
  runFirstUseRule,
  runCasingRule,
  runBanRule,
  runReplaceRule,
  runMatchRule,
  runCustomFunctionRule,
  clearCustomFunctionCache,
} from "./custom-rule-runner.js";
import { extract } from "./extract.js";
import { createLineIndex } from "./position.js";
import type {
  LimitRule,
  ConsistentRule,
  FirstUseRule,
  CasingRule,
  BanRule,
  ReplaceRule,
  MatchRule,
  CustomFunctionRule,
} from "./custom-rules.js";

describe("runLimitRule", () => {
  describe("document scope", () => {
    it("flags when count exceeds max", () => {
      const content = "Hello! World! This is great! So exciting!";
      const spans = extract(content);
      const lineIndex = createLineIndex(content);

      const rule: LimitRule = {
        type: "limit",
        name: "limit-exclamations",
        message: "Too many exclamation marks ($count found, max $max)",
        pattern: "!",
        max: 2,
        scope: "document",
      };

      const diagnostics = runLimitRule(rule, spans, "test.md", lineIndex);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.rule).toBe("limit-exclamations");
      expect(diagnostics[0]!.message).toBe("Too many exclamation marks (4 found, max 2)");
    });

    it("does not flag when count is within max", () => {
      const content = "Hello! World!";
      const spans = extract(content);
      const lineIndex = createLineIndex(content);

      const rule: LimitRule = {
        type: "limit",
        name: "limit-exclamations",
        message: "Too many exclamation marks",
        pattern: "!",
        max: 2,
        scope: "document",
      };

      const diagnostics = runLimitRule(rule, spans, "test.md", lineIndex);

      expect(diagnostics).toHaveLength(0);
    });

    it("flags when count is below min", () => {
      const content = "This is a paragraph without any links.";
      const spans = extract(content);
      const lineIndex = createLineIndex(content);

      const rule: LimitRule = {
        type: "limit",
        name: "require-links",
        message: "Document needs at least $min links (found $count)",
        pattern: "\\[.+?\\]\\(.+?\\)",
        regex: true,
        min: 1,
        scope: "document",
      };

      const diagnostics = runLimitRule(rule, spans, "test.md", lineIndex);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.message).toBe("Document needs at least 1 links (found 0)");
    });

    it("reports correct offset for multi-line content", () => {
      // This test ensures offsets are correct when exceeding match is on a later line
      const content = `First line with one!

Second line.

Third line with two! And three!`;
      const spans = extract(content);
      const lineIndex = createLineIndex(content);

      const rule: LimitRule = {
        type: "limit",
        name: "limit-exclamations",
        message: "Too many exclamation marks ($count found, max $max)",
        pattern: "!",
        max: 1,
        scope: "document",
      };

      const diagnostics = runLimitRule(rule, spans, "test.md", lineIndex);

      expect(diagnostics).toHaveLength(1);
      // The 3rd ! (index 2, exceeding max of 1) is the first ! on the third line
      // Verify the offset points to that actual "!" character
      expect(content[diagnostics[0]!.offset]).toBe("!");
    });
  });

  describe("paragraph scope", () => {
    it("flags each paragraph exceeding max independently", () => {
      const content = `First paragraph! With exclamations! So many!

Second paragraph. No exclamations here.

Third paragraph! Also excited!`;
      const spans = extract(content);
      const lineIndex = createLineIndex(content);

      const rule: LimitRule = {
        type: "limit",
        name: "limit-exclamations",
        message: "Too many exclamation marks in paragraph ($count found, max $max)",
        pattern: "!",
        max: 1,
        scope: "paragraph",
      };

      const diagnostics = runLimitRule(rule, spans, "test.md", lineIndex);

      // First paragraph has 3 !, exceeds max 1
      // Third paragraph has 2 !, exceeds max 1
      expect(diagnostics).toHaveLength(2);
    });
  });

  describe("sentence scope", () => {
    it("flags each sentence exceeding max independently", () => {
      const content = "This is amazing! So great! I love it. Another calm sentence.";
      const spans = extract(content);
      const lineIndex = createLineIndex(content);

      const rule: LimitRule = {
        type: "limit",
        name: "limit-exclamations-sentence",
        message: "Sentence has too many exclamation marks ($count found)",
        pattern: "!",
        max: 0,
        scope: "sentence",
      };

      const diagnostics = runLimitRule(rule, spans, "test.md", lineIndex);

      // Two sentences with exclamation marks
      expect(diagnostics).toHaveLength(2);
    });
  });

  describe("regex patterns", () => {
    it("supports regex patterns for counting", () => {
      const content = "The API provides REST and GraphQL endpoints.";
      const spans = extract(content);
      const lineIndex = createLineIndex(content);

      const rule: LimitRule = {
        type: "limit",
        name: "limit-acronyms",
        message: "Too many acronyms ($count found, max $max)",
        pattern: "\\b[A-Z]{2,}\\b",
        regex: true,
        max: 1,
        scope: "document",
      };

      const diagnostics = runLimitRule(rule, spans, "test.md", lineIndex);

      // API, REST, GraphQL (3 matches, but GraphQL is mixed case so 2 matches)
      expect(diagnostics).toHaveLength(1);
    });
  });

  describe("message interpolation", () => {
    it("interpolates $count, $max, $min, and $match", () => {
      const content = "!!!!";
      const spans = extract(content);
      const lineIndex = createLineIndex(content);

      const rule: LimitRule = {
        type: "limit",
        name: "test-rule",
        message: 'Found $count occurrences of "$match" (max: $max)',
        pattern: "!",
        max: 2,
        scope: "document",
      };

      const diagnostics = runLimitRule(rule, spans, "test.md", lineIndex);

      expect(diagnostics[0]!.message).toBe('Found 4 occurrences of "!" (max: 2)');
    });
  });
});

describe("runConsistentRule", () => {
  it("flags inconsistent usage of variants", () => {
    const content = "Send me an email. I prefer e-mail over other communication.";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: ConsistentRule = {
      type: "consistent",
      name: "consistent-email",
      message: "Use '$preferred' consistently (found '$match')",
      either: [["email", "e-mail"]],
    };

    const diagnostics = runConsistentRule(rule, spans, "test.md", lineIndex);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toBe("Use 'email' consistently (found 'e-mail')");
    expect(diagnostics[0]!.fix?.text).toBe("email");
  });

  it("does not flag consistent usage", () => {
    const content = "I love email. Email is great. Send me an email.";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: ConsistentRule = {
      type: "consistent",
      name: "consistent-email",
      message: "Use '$preferred' consistently",
      either: [["email", "e-mail"]],
    };

    const diagnostics = runConsistentRule(rule, spans, "test.md", lineIndex);

    expect(diagnostics).toHaveLength(0);
  });

  it("handles multiple variant groups", () => {
    const content = "The color is gray. I love grey and colour.";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: ConsistentRule = {
      type: "consistent",
      name: "consistent-spelling",
      message: "Use '$preferred' consistently (found '$match')",
      either: [
        ["color", "colour"],
        ["gray", "grey"],
      ],
    };

    const diagnostics = runConsistentRule(rule, spans, "test.md", lineIndex);

    // grey and colour should be flagged
    expect(diagnostics).toHaveLength(2);
  });

  it("respects case insensitivity", () => {
    const content = "Email is great. I prefer E-MAIL.";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: ConsistentRule = {
      type: "consistent",
      name: "consistent-email",
      message: "Use '$preferred' consistently",
      either: [["email", "e-mail"]],
      ignoreCase: true,
    };

    const diagnostics = runConsistentRule(rule, spans, "test.md", lineIndex);

    expect(diagnostics).toHaveLength(1);
  });
});

describe("runFirstUseRule", () => {
  it("flags undefined acronyms on first use", () => {
    const content = "The API provides data access. REST is supported.";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: FirstUseRule = {
      type: "firstUse",
      name: "define-acronyms",
      message: "Define '$match' on first use",
      pattern: "\\b[A-Z]{2,}\\b",
      regex: true,
      requiresExpansion: true,
    };

    const diagnostics = runFirstUseRule(rule, spans, "test.md", lineIndex);

    // Both API and REST are undefined
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]!.message).toBe("Define 'API' on first use");
    expect(diagnostics[1]!.message).toBe("Define 'REST' on first use");
  });

  it("allows properly defined acronyms", () => {
    const content =
      "The API (Application Programming Interface) provides data. Use the API wisely.";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: FirstUseRule = {
      type: "firstUse",
      name: "define-acronyms",
      message: "Define '$match' on first use",
      pattern: "\\b[A-Z]{2,}\\b",
      regex: true,
      requiresExpansion: true,
    };

    const diagnostics = runFirstUseRule(rule, spans, "test.md", lineIndex);

    // API is defined, so no diagnostic
    expect(diagnostics).toHaveLength(0);
  });

  it("respects exceptions", () => {
    const content = "Use HTML and CSS. API is also supported.";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: FirstUseRule = {
      type: "firstUse",
      name: "define-acronyms",
      message: "Define '$match' on first use",
      pattern: "\\b[A-Z]{2,}\\b",
      regex: true,
      requiresExpansion: true,
      exceptions: ["HTML", "CSS"],
    };

    const diagnostics = runFirstUseRule(rule, spans, "test.md", lineIndex);

    // Only API should be flagged
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toBe("Define 'API' on first use");
  });

  it("reports correct offset for multi-line content", () => {
    // This test ensures offsets are correct when acronyms appear after multiple spans
    const content = `First paragraph with no acronyms.

Second paragraph.

- Using Plasmo for a React-DX`;
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: FirstUseRule = {
      type: "firstUse",
      name: "define-acronyms",
      message: "Define '$match' on first use",
      pattern: "\\b[A-Z]{2,}\\b",
      regex: true,
      requiresExpansion: true,
      exceptions: ["React"], // React is common, only DX needs definition
    };

    const diagnostics = runFirstUseRule(rule, spans, "test.md", lineIndex);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toBe("Define 'DX' on first use");
    // Verify the offset points to "DX" not some other part of the document
    expect(content.slice(diagnostics[0]!.offset, diagnostics[0]!.offset + 2)).toBe("DX");
  });
});

describe("runCasingRule", () => {
  it("flags incorrect sentence case", () => {
    const content = "This Is Title Case";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: CasingRule = {
      type: "casing",
      name: "sentence-case",
      message: "Should use sentence case: '$match'",
      case: "sentence",
    };

    const diagnostics = runCasingRule(rule, spans, "test.md", lineIndex);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.fix?.text).toBe("This is title case");
  });

  it("allows correct sentence case", () => {
    const content = "This is sentence case";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: CasingRule = {
      type: "casing",
      name: "sentence-case",
      message: "Should use sentence case",
      case: "sentence",
    };

    const diagnostics = runCasingRule(rule, spans, "test.md", lineIndex);

    expect(diagnostics).toHaveLength(0);
  });

  it("flags incorrect title case", () => {
    const content = "this is lowercase";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: CasingRule = {
      type: "casing",
      name: "title-case",
      message: "Should use title case",
      case: "title",
    };

    const diagnostics = runCasingRule(rule, spans, "test.md", lineIndex);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.fix?.text).toBe("This Is Lowercase");
  });

  it("respects exceptions in casing", () => {
    const content = "Welcome to macOS";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: CasingRule = {
      type: "casing",
      name: "sentence-case",
      message: "Should use sentence case",
      case: "sentence",
      exceptions: ["macOS"],
    };

    const diagnostics = runCasingRule(rule, spans, "test.md", lineIndex);

    // macOS is excepted, so this should pass
    expect(diagnostics).toHaveLength(0);
  });
});

describe("runBanRule", () => {
  it("flags banned words", () => {
    const content = "The blacklist contains blocked items.";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: BanRule = {
      type: "ban",
      name: "no-blacklist",
      message: "Avoid using '$match'",
      pattern: "blacklist",
    };

    const diagnostics = runBanRule(rule, spans, "test.md", lineIndex);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toBe("Avoid using 'blacklist'");
  });

  it("supports multiple patterns", () => {
    const content = "The blacklist and whitelist are outdated terms.";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: BanRule = {
      type: "ban",
      name: "no-exclusionary",
      message: "Avoid using '$match'",
      pattern: ["blacklist", "whitelist"],
    };

    const diagnostics = runBanRule(rule, spans, "test.md", lineIndex);

    expect(diagnostics).toHaveLength(2);
  });

  it("provides remove fix when configured", () => {
    const content = "This is simply amazing.";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: BanRule = {
      type: "ban",
      name: "no-simply",
      message: "Remove '$match'",
      pattern: "simply",
      fix: { type: "remove", cleanWhitespace: true },
    };

    const diagnostics = runBanRule(rule, spans, "test.md", lineIndex);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.fix).toBeDefined();
    expect(diagnostics[0]!.fix?.text).toBe("");
  });

  it("provides replace fix when configured", () => {
    const content = "Use the blacklist.";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: BanRule = {
      type: "ban",
      name: "no-blacklist",
      message: "Use 'blocklist' instead of '$match'",
      pattern: "blacklist",
      fix: { type: "replace", with: "blocklist" },
    };

    const diagnostics = runBanRule(rule, spans, "test.md", lineIndex);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.fix?.text).toBe("blocklist");
  });
});

describe("runReplaceRule", () => {
  it("finds and suggests replacements", () => {
    const content = "We will utilize this technology.";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: ReplaceRule = {
      type: "replace",
      name: "simplify",
      message: "Use '$replacement' instead of '$match'",
      swap: {
        utilize: "use",
        leverage: "use",
      },
    };

    const diagnostics = runReplaceRule(rule, spans, "test.md", lineIndex);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toBe("Use 'use' instead of 'utilize'");
    expect(diagnostics[0]!.fix?.text).toBe("use");
  });

  it("preserves case in replacements", () => {
    const content = "UTILIZE this. Utilize that.";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: ReplaceRule = {
      type: "replace",
      name: "simplify",
      message: "Use '$replacement' instead of '$match'",
      swap: {
        utilize: "use",
      },
      preserveCase: true,
    };

    const diagnostics = runReplaceRule(rule, spans, "test.md", lineIndex);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]!.fix?.text).toBe("USE");
    expect(diagnostics[1]!.fix?.text).toBe("Use");
  });
});

describe("runMatchRule", () => {
  it("flags pattern matches", () => {
    const content = "TODO: Fix this bug. FIXME: Another issue.";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: MatchRule = {
      type: "match",
      name: "no-todos",
      message: "Found '$match' comment",
      pattern: "TODO|FIXME",
      regex: true,
    };

    const diagnostics = runMatchRule(rule, spans, "test.md", lineIndex);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]!.message).toBe("Found 'TODO' comment");
    expect(diagnostics[1]!.message).toBe("Found 'FIXME' comment");
  });

  it("supports negation (flag when NOT found)", () => {
    const content = "This document has no author.";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: MatchRule = {
      type: "match",
      name: "require-author",
      message: "Document is missing author attribution",
      pattern: "Author:",
      negate: true,
    };

    const diagnostics = runMatchRule(rule, spans, "test.md", lineIndex);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toBe("Document is missing author attribution");
  });

  it("provides transform fix when configured", () => {
    const content = "The API is great.";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: MatchRule = {
      type: "match",
      name: "lowercase-api",
      message: "Use lowercase",
      pattern: "API",
      fix: { type: "transform", transform: "lowercase" },
    };

    const diagnostics = runMatchRule(rule, spans, "test.md", lineIndex);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.fix?.text).toBe("api");
  });
});

describe("runCustomFunctionRule", () => {
  beforeEach(() => {
    // Clear cache between tests to ensure fresh imports
    clearCustomFunctionCache();
  });

  it("loads and runs a custom rule with default export", async () => {
    const content = "This is a TODO: fix this later";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: CustomFunctionRule = {
      type: "custom",
      name: "test-todo",
      message: "Found a TODO",
      function: "./__fixtures__/test-rule-default.js",
    };

    const diagnostics = await runCustomFunctionRule(
      rule,
      spans,
      "test.md",
      lineIndex,
      import.meta.url,
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toBe("Unresolved TODO found");
    expect(diagnostics[0]!.rule).toBe("custom-todo");
  });

  it("loads and runs a custom rule with named export", async () => {
    const content = "This is a FIXME: needs attention";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: CustomFunctionRule = {
      type: "custom",
      name: "test-fixme",
      message: "Found a FIXME",
      function: "./__fixtures__/test-rule-named.js",
    };

    const diagnostics = await runCustomFunctionRule(
      rule,
      spans,
      "test.md",
      lineIndex,
      import.meta.url,
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toBe("Unresolved FIXME found");
    expect(diagnostics[0]!.severity).toBe("error");
  });

  it("returns empty array when rule is disabled", async () => {
    const content = "This is a TODO: fix this later";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: CustomFunctionRule = {
      type: "custom",
      name: "test-todo",
      message: "Found a TODO",
      function: "./__fixtures__/test-rule-default.js",
      enabled: false,
    };

    const diagnostics = await runCustomFunctionRule(
      rule,
      spans,
      "test.md",
      lineIndex,
      import.meta.url,
    );

    expect(diagnostics).toHaveLength(0);
  });

  it("applies rule metadata to diagnostics", async () => {
    const content = "This is a TODO: fix this later";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: CustomFunctionRule = {
      type: "custom",
      name: "test-todo",
      message: "Found a TODO",
      function: "./__fixtures__/test-rule-default.js",
      severity: "error",
      help: "Resolve all TODOs before committing",
      suggestion: "Complete or remove the TODO item",
    };

    const diagnostics = await runCustomFunctionRule(
      rule,
      spans,
      "test.md",
      lineIndex,
      import.meta.url,
    );

    expect(diagnostics).toHaveLength(1);
    // Note: the custom rule already sets severity, help/suggestion are added from rule config
    expect(diagnostics[0]!.help).toBe("Resolve all TODOs before committing");
    expect(diagnostics[0]!.suggestion).toBe("Complete or remove the TODO item");
  });

  it("throws error when module not found", async () => {
    const content = "Some content";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: CustomFunctionRule = {
      type: "custom",
      name: "test-missing",
      message: "Should fail",
      function: "./nonexistent-rule.js",
    };

    await expect(
      runCustomFunctionRule(rule, spans, "test.md", lineIndex, import.meta.url),
    ).rejects.toThrow(/Failed to load custom rule/);
  });

  it("throws error when module has no valid export", async () => {
    const content = "Some content";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: CustomFunctionRule = {
      type: "custom",
      name: "test-invalid",
      message: "Should fail",
      function: "./__fixtures__/test-rule-invalid.js",
    };

    await expect(
      runCustomFunctionRule(rule, spans, "test.md", lineIndex, import.meta.url),
    ).rejects.toThrow(/must export a default function or a function named 'rule'/);
  });

  it("throws error when rule function throws", async () => {
    const content = "Some content";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: CustomFunctionRule = {
      type: "custom",
      name: "test-throwing",
      message: "Should fail",
      function: "./__fixtures__/test-rule-throwing.js",
    };

    await expect(
      runCustomFunctionRule(rule, spans, "test.md", lineIndex, import.meta.url),
    ).rejects.toThrow(/Custom rule 'test-throwing' failed/);
  });

  it("throws error when rule returns non-array", async () => {
    const content = "Some content";
    const spans = extract(content);
    const lineIndex = createLineIndex(content);

    const rule: CustomFunctionRule = {
      type: "custom",
      name: "test-bad-return",
      message: "Should fail",
      function: "./__fixtures__/test-rule-bad-return.js",
    };

    await expect(
      runCustomFunctionRule(rule, spans, "test.md", lineIndex, import.meta.url),
    ).rejects.toThrow(/must return an array of diagnostics/);
  });

  it("caches loaded functions for performance", async () => {
    const content1 = "First TODO: item";
    const content2 = "Second TODO: item";
    const spans1 = extract(content1);
    const spans2 = extract(content2);
    const lineIndex1 = createLineIndex(content1);
    const lineIndex2 = createLineIndex(content2);

    const rule: CustomFunctionRule = {
      type: "custom",
      name: "test-todo",
      message: "Found a TODO",
      function: "./__fixtures__/test-rule-default.js",
    };

    // Run twice with same rule
    const diagnostics1 = await runCustomFunctionRule(
      rule,
      spans1,
      "test1.md",
      lineIndex1,
      import.meta.url,
    );
    const diagnostics2 = await runCustomFunctionRule(
      rule,
      spans2,
      "test2.md",
      lineIndex2,
      import.meta.url,
    );

    expect(diagnostics1).toHaveLength(1);
    expect(diagnostics2).toHaveLength(1);
    expect(diagnostics1[0]!.file).toBe("test1.md");
    expect(diagnostics2[0]!.file).toBe("test2.md");
  });
});
