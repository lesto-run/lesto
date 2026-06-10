import { describe, expect, it } from "vitest";

import { createLineIndex, LintContext } from "../src/index";

const ctxFor = (source: string) => new LintContext("doc.md", createLineIndex(source));

describe("LintContext.diag", () => {
  it("builds a diagnostic with a stable rule-offset-length id and resolved position", () => {
    const source = "ab\ncd";
    const ctx = ctxFor(source);
    // Offset 3 is the 'c' on line 2.
    const d = ctx.diag("altText", 3, 2, "boom", "error");

    expect(d).toMatchObject({
      id: "altText-3-2",
      rule: "altText",
      message: "boom",
      file: "doc.md",
      offset: 3,
      length: 2,
      line: 2,
      column: 1,
      severity: "error",
    });
  });

  it("omits help and fix when not supplied", () => {
    const d = ctxFor("x").diag("altText", 0, 1, "m", "warning");
    expect("help" in d).toBe(false);
    expect("fix" in d).toBe(false);
  });

  it("includes help and fix when supplied", () => {
    const fix = { start: 0, end: 1, text: "y" };
    const d = ctxFor("x").diag("altText", 0, 1, "m", "warning", "do this", fix);
    expect(d.help).toBe("do this");
    expect(d.fix).toEqual(fix);
  });
});

describe("LintContext.scan", () => {
  it("yields each match with its offset and length", () => {
    const ctx = ctxFor("a1b22c");
    const hits = [...ctx.scan("a1b22c", /\d+/g)];
    expect(hits.map((h) => [h.match[0], h.offset, h.length])).toEqual([
      ["1", 1, 1],
      ["22", 3, 2],
    ]);
  });

  it("resets lastIndex so the same pattern can be scanned twice", () => {
    const pattern = /\d/g;
    pattern.lastIndex = 99; // simulate a previous, exhausted scan
    const ctx = ctxFor("a1");
    const first = [...ctx.scan("a1", pattern)];
    const second = [...ctx.scan("a1", pattern)];
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it("advances past zero-width matches instead of looping forever", () => {
    // /(?=b)/g matches empty string at each 'b'; without the lastIndex++ guard
    // this scan would never terminate. We assert it terminates AND skips them.
    const ctx = ctxFor("aba");
    const hits = [...ctx.scan("aba", /(?=b)/g)];
    expect(hits).toEqual([]);
  });
});
