import { describe, expect, it } from "vitest";

import { createLineIndex, offsetToPositionFast } from "../src/index";

// The line index is the spine of every diagnostic's line/column. If a boundary
// is off by one here, every reported position downstream is wrong, so we pin
// the exact offsets at newline boundaries rather than just "a plausible line".

describe("createLineIndex", () => {
  it("treats empty input as a single line starting at offset 0", () => {
    expect(createLineIndex("").lineStarts).toEqual([0]);
  });

  it("records the offset just past each LF newline", () => {
    // "a\nbb\nc" -> lines start at 0, after "a\n" (2), after "bb\n" (5).
    expect(createLineIndex("a\nbb\nc").lineStarts).toEqual([0, 2, 5]);
  });

  it("collapses CRLF into a single newline boundary", () => {
    // "a\r\nb": the \r\n pair is one newline; next line starts after both chars.
    expect(createLineIndex("a\r\nb").lineStarts).toEqual([0, 3]);
  });

  it("treats a bare CR (old-Mac) as its own newline", () => {
    // "a\rb": \r with no following \n still starts a new line after it.
    expect(createLineIndex("a\rb").lineStarts).toEqual([0, 2]);
  });

  it("handles a trailing CR at end of input without reading past the end", () => {
    // source[i+1] is undefined here; the \r branch must not mistake it for \n.
    expect(createLineIndex("a\r").lineStarts).toEqual([0, 2]);
  });

  it("records consecutive blank lines", () => {
    expect(createLineIndex("\n\n").lineStarts).toEqual([0, 1, 2]);
  });
});

describe("offsetToPositionFast", () => {
  it("maps offsets to 1-indexed line/column on a single line", () => {
    const index = createLineIndex("hello");
    expect(offsetToPositionFast(index, 0)).toEqual({ line: 1, column: 1 });
    expect(offsetToPositionFast(index, 4)).toEqual({ line: 1, column: 5 });
  });

  it("maps offsets across multiple lines", () => {
    const source = "ab\ncd\nef";
    const index = createLineIndex(source);
    // 'c' is the first char of line 2.
    expect(offsetToPositionFast(index, source.indexOf("c"))).toEqual({ line: 2, column: 1 });
    // 'f' is the second char of line 3.
    expect(offsetToPositionFast(index, source.indexOf("f"))).toEqual({ line: 3, column: 2 });
  });

  it("places an offset exactly at a line start in column 1 of the new line", () => {
    const source = "ab\ncd";
    const index = createLineIndex(source);
    // Offset 3 is the line start recorded for line 2.
    expect(offsetToPositionFast(index, 3)).toEqual({ line: 2, column: 1 });
  });

  it("clamps a negative offset to the very first position", () => {
    const index = createLineIndex("anything");
    expect(offsetToPositionFast(index, -5)).toEqual({ line: 1, column: 1 });
  });

  it("degrades gracefully when handed an empty line index", () => {
    // createLineIndex never produces this, but the public function guards it,
    // so the guard must be exercised with a hand-built empty index.
    expect(offsetToPositionFast({ lineStarts: [] }, 0)).toEqual({ line: 1, column: 1 });
    expect(offsetToPositionFast({ lineStarts: [] }, 7)).toEqual({ line: 1, column: 8 });
  });
});
