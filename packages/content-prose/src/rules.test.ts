import { describe, it, expect } from "vitest";
import { fillers, condescending, repeated, simplify, rules } from "./rules.js";
import { createLineIndex } from "./position.js";

const makeSpan = (text: string, offset = 0) => [{ text, offset }];
const idx = (source: string) => createLineIndex(source);

describe("fillers", () => {
  it("detects filler words", () => {
    const source = "This is very important";
    const diags = fillers(makeSpan(source), "test.md", idx(source));
    expect(diags).toHaveLength(1);
    expect(diags[0]!.rule).toBe("fillers");
    expect(diags[0]!.column).toBe(9);
  });

  it("provides fix that removes word and trailing space", () => {
    const source = "very good";
    const diags = fillers(makeSpan(source), "test.md", idx(source));
    expect(diags[0]!.fix).toEqual({ start: 0, end: 5, text: "" });
  });

  it("provides fix that removes leading space when at end", () => {
    const source = "good very";
    const diags = fillers(makeSpan(source), "test.md", idx(source));
    expect(diags[0]!.fix).toEqual({ start: 4, end: 9, text: "" });
  });

  // Edge cases
  it("detects all filler words", () => {
    const allFillers = "very really basically actually literally just";
    const diags = fillers(makeSpan(allFillers), "test.md", idx(allFillers));
    expect(diags).toHaveLength(6);
  });

  it("is case insensitive", () => {
    const source = "VERY Important";
    const diags = fillers(makeSpan(source), "test.md", idx(source));
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("VERY");
  });

  it("respects word boundaries - does not match partial words", () => {
    const source = "delivery service";
    const diags = fillers(makeSpan(source), "test.md", idx(source));
    expect(diags).toHaveLength(0);
  });

  it("handles multiple matches in same span", () => {
    const text = "very very important";
    const diags = fillers(makeSpan(text), "test.md", idx(text));
    expect(diags).toHaveLength(2);
  });

  it("handles empty spans", () => {
    const diags = fillers([], "test.md", idx(""));
    expect(diags).toHaveLength(0);
  });

  it("handles span with offset", () => {
    const source = "# Title\n\nThis is very important";
    const diags = fillers([{ text: "This is very important", offset: 10 }], "test.md", idx(source));
    expect(diags).toHaveLength(1);
    expect(diags[0]!.offset).toBe(18); // 10 + 8 (index of "very")
  });
});

describe("condescending", () => {
  it("detects condescending words", () => {
    const source = "Simply do this";
    const diags = condescending(makeSpan(source), "test.md", idx(source));
    expect(diags).toHaveLength(1);
    expect(diags[0]!.rule).toBe("condescending");
  });

  it("detects all condescending words", () => {
    const all = "simply obviously clearly easily of course";
    const diags = condescending(makeSpan(all), "test.md", idx(all));
    expect(diags).toHaveLength(5);
  });

  it("is case insensitive", () => {
    const source = "OBVIOUSLY wrong";
    const diags = condescending(makeSpan(source), "test.md", idx(source));
    expect(diags).toHaveLength(1);
  });

  it('handles "of course" as phrase', () => {
    const source = "Of course it works";
    const diags = condescending(makeSpan(source), "test.md", idx(source));
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("Of course");
  });
});

describe("repeated", () => {
  it("detects repeated words", () => {
    const source = "the the problem";
    const diags = repeated(makeSpan(source), "test.md", idx(source));
    expect(diags).toHaveLength(1);
    expect(diags[0]!.fix?.text).toBe("the");
  });

  it("is case insensitive", () => {
    const source = "The the problem";
    const diags = repeated(makeSpan(source), "test.md", idx(source));
    expect(diags).toHaveLength(1);
  });

  it("handles multiple repeated pairs", () => {
    const text = "the the cat sat sat down";
    const diags = repeated(makeSpan(text), "test.md", idx(text));
    expect(diags).toHaveLength(2);
  });

  it("does not match intentional repetition across sentences", () => {
    // Only matches adjacent words separated by whitespace
    const source = "End. The beginning";
    const diags = repeated(makeSpan(source), "test.md", idx(source));
    expect(diags).toHaveLength(0);
  });

  it("handles words separated by multiple spaces", () => {
    const source = "the   the problem";
    const diags = repeated(makeSpan(source), "test.md", idx(source));
    expect(diags).toHaveLength(1);
  });
});

describe("simplify", () => {
  it("suggests simpler words", () => {
    const source = "utilize this";
    const diags = simplify(makeSpan(source), "test.md", idx(source));
    expect(diags).toHaveLength(1);
    expect(diags[0]!.fix?.text).toBe("use");
  });

  it("handles all verb forms of utilize", () => {
    const forms = ["utilize", "utilizes", "utilized", "utilizing"];
    const expected = ["use", "uses", "used", "using"];

    forms.forEach((form, i) => {
      const diags = simplify(makeSpan(form), "test.md", idx(form));
      expect(diags).toHaveLength(1);
      expect(diags[0]!.fix?.text).toBe(expected[i]);
    });
  });

  it("handles all verb forms of leverage", () => {
    const forms = ["leverage", "leverages", "leveraged", "leveraging"];
    const expected = ["use", "uses", "used", "using"];

    forms.forEach((form, i) => {
      const diags = simplify(makeSpan(form), "test.md", idx(form));
      expect(diags).toHaveLength(1);
      expect(diags[0]!.fix?.text).toBe(expected[i]);
    });
  });

  it("is case insensitive and preserves case", () => {
    const source = "UTILIZE this";
    const diags = simplify(makeSpan(source), "test.md", idx(source));
    expect(diags).toHaveLength(1);
    expect(diags[0]!.fix?.text).toBe("USE");
  });

  it("preserves title case", () => {
    const source = "Utilize this";
    const diags = simplify(makeSpan(source), "test.md", idx(source));
    expect(diags).toHaveLength(1);
    expect(diags[0]!.fix?.text).toBe("Use");
  });

  it("respects word boundaries", () => {
    const source = "reutilize";
    const diags = simplify(makeSpan(source), "test.md", idx(source));
    expect(diags).toHaveLength(0);
  });
});

describe("rules array", () => {
  it("exports all 12 rules", () => {
    expect(rules).toHaveLength(12);
  });

  it("each rule is a function", () => {
    rules.forEach((rule) => {
      expect(typeof rule).toBe("function");
    });
  });
});

describe("multiple spans", () => {
  it("processes all spans correctly", () => {
    const spans = [
      { text: "First very important", offset: 0 },
      { text: "Second very important", offset: 30 },
    ];
    const source = "First very important\n\n\n\n\n\n\n\nSecond very important";
    const diags = fillers(spans, "test.md", idx(source));
    expect(diags).toHaveLength(2);
    expect(diags[0]!.offset).toBe(6);
    expect(diags[1]!.offset).toBe(37);
  });
});
