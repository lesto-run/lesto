import { describe, it, expect } from "vitest";
import { RuleContext, escapeRegex, preserveCase } from "./rule-context.js";
import { createLineIndex } from "./position.js";

const ctx = (severity?: "error" | "warning") =>
  new RuleContext("test.md", createLineIndex("one\ntwo"), severity);

describe("escapeRegex", () => {
  it("escapes regex metacharacters", () => {
    expect(new RegExp(escapeRegex("a.b(c)")).test("a.b(c)")).toBe(true);
    expect(new RegExp(escapeRegex("a.b(c)")).test("axbxcx")).toBe(false);
  });
});

describe("preserveCase", () => {
  it("keeps lowercase unchanged", () => {
    expect(preserveCase("assist", "help")).toBe("help");
  });

  it("capitalizes when the original is capitalized", () => {
    expect(preserveCase("Assist", "help")).toBe("Help");
  });

  it("upcases when the original is all caps", () => {
    expect(preserveCase("ASSIST", "help")).toBe("HELP");
  });

  it("returns the replacement unchanged for an empty original", () => {
    expect(preserveCase("", "help")).toBe("help");
  });

  it("returns an empty replacement unchanged", () => {
    expect(preserveCase("Assist", "")).toBe("");
  });
});

describe("RuleContext.diag", () => {
  it("resolves the offset to a line and column", () => {
    const d = ctx().diag("demo", 4, "message", "two");
    expect({ line: d.line, column: d.column }).toEqual({ line: 2, column: 1 });
  });

  it("builds a slug id from the matched text", () => {
    expect(ctx().diag("demo", 0, "message", "One Two!").id).toBe("demo-0-one_two");
  });

  it("defaults to the warning severity", () => {
    expect(ctx().diag("demo", 0, "message", "one").severity).toBe("warning");
  });

  it("uses the configured severity", () => {
    expect(ctx("error").diag("demo", 0, "message", "one").severity).toBe("error");
  });
});

describe("RuleContext.scan", () => {
  it("yields each match with its offset", () => {
    const matches = [...ctx().scan("one two one", /one/g, 100)];
    expect(matches.map((m) => m.offset)).toEqual([100, 108]);
  });

  it("exposes capture groups", () => {
    expect([...ctx().scan("one=1", /(\w+)=(\d)/g)][0]!.groups).toEqual(["one", "1"]);
  });

  it("advances past a zero-length match instead of looping forever", () => {
    // A pattern that can match empty would spin the generator without the guard.
    expect([...ctx().scan("ab", /x?/g)]).toEqual([]);
  });

  it("resets lastIndex so a shared pattern is safe to reuse", () => {
    const pattern = /one/g;
    expect([...ctx().scan("one", pattern)]).toHaveLength(1);
    expect([...ctx().scan("one", pattern)]).toHaveLength(1);
  });
});

describe("RuleContext.withHelp", () => {
  it("merges help for a known rule", () => {
    const help = ctx().withHelp("fillers", "very");
    expect(help.help).toContain("filler word");
    expect(help.suggestion).toBeTruthy();
    expect(help.prompt).toBeTruthy();
  });

  it("returns only the extra fields for an unknown rule", () => {
    expect(ctx().withHelp("no-such-rule", "very", { length: 4 })).toEqual({ length: 4 });
  });
});
