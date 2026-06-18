import { describe, it, expect } from "vitest";
import { STOP_WORDS, extractKeywords } from "../text.js";

describe("STOP_WORDS", () => {
  it("contains the hand-curated high-frequency tokens", () => {
    expect(STOP_WORDS.has("the")).toBe(true);
    expect(STOP_WORDS.has("and")).toBe(true);
    expect(STOP_WORDS.has("your")).toBe(true);
    expect(STOP_WORDS.has("every")).toBe(true);
  });

  it("does not contain content-bearing words", () => {
    expect(STOP_WORDS.has("lesto")).toBe(false);
    expect(STOP_WORDS.has("search")).toBe(false);
  });

  it("is the hand-curated stop-word set", () => {
    // Byte-identical to the lists previously duplicated in content-search and
    // content-embeddings.
    expect(STOP_WORDS.size).toBe(64);
  });
});

describe("extractKeywords", () => {
  it("lowercases, drops stop words and short words", () => {
    // "the" and "is" are stop words; "a" is below the length threshold too.
    expect(extractKeywords("The Lesto Framework is Fast")).toEqual(["lesto", "framework", "fast"]);
  });

  it("strips punctuation to whitespace", () => {
    expect(extractKeywords("hello, world! foo-bar")).toEqual(["hello", "world", "foo", "bar"]);
  });

  it("filters words shorter than three characters", () => {
    expect(extractKeywords("ab cd efg hijk")).toEqual(["efg", "hijk"]);
  });

  it("deduplicates while preserving first-seen order", () => {
    expect(extractKeywords("alpha beta alpha gamma beta")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("caps the result at maxKeywords (default 50)", () => {
    const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    expect(extractKeywords(words)).toHaveLength(50);
  });

  it("honors a custom maxKeywords", () => {
    expect(extractKeywords("alpha beta gamma delta", 2)).toEqual(["alpha", "beta"]);
  });

  it("returns an empty array when no keywords survive", () => {
    expect(extractKeywords("the is a of")).toEqual([]);
  });
});
