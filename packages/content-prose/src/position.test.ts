import { describe, it, expect } from "vitest";
import { offsetToPosition, createLineIndex, offsetToPositionFast } from "./position.js";

describe("offsetToPosition", () => {
  it("handles start of file", () => {
    expect(offsetToPosition("hello", 0)).toEqual({ line: 1, column: 1 });
  });

  it("handles LF", () => {
    expect(offsetToPosition("hello\nworld", 6)).toEqual({ line: 2, column: 1 });
  });

  it("handles CRLF", () => {
    expect(offsetToPosition("hello\r\nworld", 7)).toEqual({ line: 2, column: 1 });
  });

  it("handles middle of line", () => {
    expect(offsetToPosition("hello world", 6)).toEqual({ line: 1, column: 7 });
  });

  // Edge cases
  it("handles empty string", () => {
    expect(offsetToPosition("", 0)).toEqual({ line: 1, column: 1 });
  });

  it("handles multiple newlines", () => {
    expect(offsetToPosition("a\n\n\nb", 4)).toEqual({ line: 4, column: 1 });
  });

  it("handles mixed CRLF and LF", () => {
    const source = "line1\r\nline2\nline3";
    expect(offsetToPosition(source, 7)).toEqual({ line: 2, column: 1 });
    expect(offsetToPosition(source, 13)).toEqual({ line: 3, column: 1 });
  });

  it("handles end of file", () => {
    expect(offsetToPosition("hello", 5)).toEqual({ line: 1, column: 6 });
  });

  it("handles offset at newline character", () => {
    expect(offsetToPosition("hello\nworld", 5)).toEqual({ line: 1, column: 6 });
  });

  it("handles long lines", () => {
    const longLine = "a".repeat(1000);
    expect(offsetToPosition(longLine, 500)).toEqual({ line: 1, column: 501 });
  });

  it("handles unicode characters", () => {
    expect(offsetToPosition("héllo wörld", 6)).toEqual({ line: 1, column: 7 });
  });
});

describe("createLineIndex", () => {
  it("creates index for single line", () => {
    const idx = createLineIndex("hello");
    expect(idx.lineStarts).toEqual([0]);
  });

  it("creates index for multiple lines with LF", () => {
    const idx = createLineIndex("line1\nline2\nline3");
    expect(idx.lineStarts).toEqual([0, 6, 12]);
  });

  it("creates index for CRLF", () => {
    const idx = createLineIndex("line1\r\nline2");
    expect(idx.lineStarts).toEqual([0, 7]);
  });

  it("creates index for standalone CR", () => {
    const idx = createLineIndex("line1\rline2");
    expect(idx.lineStarts).toEqual([0, 6]);
  });

  it("handles empty string", () => {
    const idx = createLineIndex("");
    expect(idx.lineStarts).toEqual([0]);
  });

  it("handles consecutive newlines", () => {
    const idx = createLineIndex("a\n\n\nb");
    expect(idx.lineStarts).toEqual([0, 2, 3, 4]);
  });
});

describe("offsetToPositionFast", () => {
  it("handles start of file", () => {
    const idx = createLineIndex("hello");
    expect(offsetToPositionFast(idx, 0)).toEqual({ line: 1, column: 1 });
  });

  it("handles LF", () => {
    const idx = createLineIndex("hello\nworld");
    expect(offsetToPositionFast(idx, 6)).toEqual({ line: 2, column: 1 });
  });

  it("handles CRLF", () => {
    const idx = createLineIndex("hello\r\nworld");
    expect(offsetToPositionFast(idx, 7)).toEqual({ line: 2, column: 1 });
  });

  it("handles middle of line", () => {
    const idx = createLineIndex("hello world");
    expect(offsetToPositionFast(idx, 6)).toEqual({ line: 1, column: 7 });
  });

  it("handles empty string", () => {
    const idx = createLineIndex("");
    expect(offsetToPositionFast(idx, 0)).toEqual({ line: 1, column: 1 });
  });

  it("handles multiple newlines", () => {
    const idx = createLineIndex("a\n\n\nb");
    expect(offsetToPositionFast(idx, 4)).toEqual({ line: 4, column: 1 });
  });

  it("produces same results as legacy function", () => {
    const sources = ["hello", "hello\nworld", "hello\r\nworld", "a\n\n\nb", "line1\nline2\nline3"];

    for (const source of sources) {
      const idx = createLineIndex(source);
      for (let i = 0; i < source.length; i++) {
        const fast = offsetToPositionFast(idx, i);
        const legacy = offsetToPosition(source, i);
        expect(fast).toEqual(legacy);
      }
    }
  });
});
