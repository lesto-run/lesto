import { describe, it, expect } from "vitest";
import { format } from "./format.js";
import type { LintResult, Diagnostic } from "./types.js";

const makeDiagnostic = (overrides: Partial<Diagnostic> = {}): Diagnostic => ({
  id: "test-0",
  rule: "test",
  message: "Test message",
  file: "test.md",
  offset: 0,
  line: 1,
  column: 1,
  severity: "error",
  ...overrides,
});

const makeResult = (diagnostics: Diagnostic[] = []): LintResult => ({
  diagnostics,
  errorCount: diagnostics.filter((d) => d.severity === "error").length,
  warningCount: diagnostics.filter((d) => d.severity === "warning").length,
  fixCount: diagnostics.filter((d) => d.fix).length,
});

describe("format", () => {
  describe("stylish (default)", () => {
    it("shows success message for no issues", () => {
      const result = makeResult([]);
      const output = format(result, "stylish");
      expect(output).toContain("No issues");
    });

    it("shows single issue correctly", () => {
      const result = makeResult([makeDiagnostic()]);
      const output = format(result, "stylish");
      expect(output).toContain("test.md");
      expect(output).toContain("1:1");
      expect(output).toContain("Test message");
      expect(output).toContain("[test]");
      expect(output).toContain("1 error");
    });

    it("pluralizes issues correctly", () => {
      const result = makeResult([makeDiagnostic(), makeDiagnostic()]);
      const output = format(result, "stylish");
      expect(output).toContain("2 errors");
    });

    it("groups diagnostics by file", () => {
      const result = makeResult([
        makeDiagnostic({ file: "a.md", line: 1 }),
        makeDiagnostic({ file: "b.md", line: 1 }),
        makeDiagnostic({ file: "a.md", line: 2 }),
      ]);
      const output = format(result, "stylish");
      const aIndex = output.indexOf("a.md");
      const bIndex = output.indexOf("b.md");
      expect(aIndex).toBeLessThan(bIndex);
    });

    it("shows line and column", () => {
      const result = makeResult([makeDiagnostic({ line: 10, column: 25 })]);
      const output = format(result, "stylish");
      expect(output).toContain("10:25");
    });
  });

  describe("github", () => {
    it("returns empty string for no issues", () => {
      const result = makeResult([]);
      const output = format(result, "github");
      expect(output).toBe("");
    });

    it("formats single issue correctly", () => {
      const result = makeResult([
        makeDiagnostic({
          file: "src/test.md",
          line: 5,
          column: 10,
          message: "Error message",
        }),
      ]);
      const output = format(result, "github");
      expect(output).toBe("::error file=src/test.md,line=5,col=10::Error message");
    });

    it("formats multiple issues on separate lines", () => {
      const result = makeResult([
        makeDiagnostic({ file: "a.md", line: 1, message: "First" }),
        makeDiagnostic({ file: "b.md", line: 2, message: "Second" }),
      ]);
      const output = format(result, "github");
      const lines = output.split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("::error file=a.md");
      expect(lines[1]).toContain("::error file=b.md");
    });

    it("handles special characters in message", () => {
      const result = makeResult([
        makeDiagnostic({
          message: '"word" is problematic',
        }),
      ]);
      const output = format(result, "github");
      expect(output).toContain('"word" is problematic');
    });
  });

  describe("format type selection", () => {
    it("defaults to stylish for unknown format", () => {
      const result = makeResult([makeDiagnostic()]);
      const output = format(result, "unknown");
      expect(output).toContain("test.md"); // stylish format includes filename
      expect(output).not.toContain("::error"); // github format
    });
  });
});
