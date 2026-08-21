import { describe, it, expect } from "vitest";
import { ste, STE_LIMITS, groupBlocks, substitutions, alternation, STE_WORD_MAP } from "./ste.js";
import { extract } from "./extract.js";
import { createLineIndex } from "./position.js";
import { RuleContext } from "./rule-context.js";
import { lintContent, applyFixes } from "./index.js";
import type { Diagnostic } from "./types.js";

/** Run the ste rule over real markdown, the way lintContent does. */
const run = (source: string): Diagnostic[] =>
  ste(extract(source), "test.md", createLineIndex(source));

/** Run the ste rule over one hand-built span, with no markdown parsing. */
const runSpan = (text: string, kind?: "paragraph" | "heading" | "listItem" | "blockquote") =>
  ste([{ text, offset: 0, ...(kind ? { kind } : {}) }], "test.md", createLineIndex(text));

const messages = (diags: Diagnostic[]) => diags.map((d) => d.message);
const only = (diags: Diagnostic[], needle: string) =>
  diags.filter((d) => d.message.includes(needle));

const words = (n: number, word = "alpha") => Array.from({ length: n }, () => word).join(" ");

describe("ste — sentence length", () => {
  it("allows a descriptive sentence at the limit", () => {
    const source = `The ${words(STE_LIMITS.descriptiveSentenceWords - 1)}.`;
    expect(only(runSpan(source), "Sentence has")).toHaveLength(0);
  });

  it("flags a descriptive sentence over 25 words", () => {
    const source = `The ${words(STE_LIMITS.descriptiveSentenceWords)}.`;
    const diags = only(runSpan(source), "Sentence has");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.rule).toBe("ste");
    expect(diags[0]!.message).toContain("26 words");
    expect(diags[0]!.message).toContain("25 in a description");
    expect(diags[0]!.length).toBe(source.length);
  });

  it("holds a list item to the tighter procedural limit", () => {
    const source = `The ${words(STE_LIMITS.proceduralSentenceWords)}.`;
    expect(only(runSpan(source, "listItem"), "Sentence has")).toHaveLength(1);
    expect(only(runSpan(source, "paragraph"), "Sentence has")).toHaveLength(0);
  });

  it("names the procedural limit in the message", () => {
    const source = `The ${words(STE_LIMITS.proceduralSentenceWords)}.`;
    expect(only(runSpan(source, "listItem"), "Sentence has")[0]!.message).toContain(
      "20 in a procedure",
    );
  });

  it("skips headings, which are not sentences", () => {
    const source = `The ${words(STE_LIMITS.descriptiveSentenceWords)}.`;
    expect(only(runSpan(source, "heading"), "Sentence has")).toHaveLength(0);
  });

  it("counts a hard-wrapped sentence as one sentence", () => {
    // 26 words, wrapped over three lines. Per-span counting would see 3 short
    // sentences and miss this entirely.
    const source = `The ${words(9)}\n${words(8)}\n${words(8)}.`;
    const diags = only(run(source), "Sentence has");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("26 words");
  });
});

describe("ste — paragraph length", () => {
  it("allows six sentences", () => {
    const source = Array.from({ length: 6 }, (_, i) => `Line ${i} runs.`).join(" ");
    expect(only(runSpan(source), "Paragraph has")).toHaveLength(0);
  });

  it("flags seven sentences", () => {
    const source = Array.from({ length: 7 }, (_, i) => `Line ${i} runs.`).join(" ");
    const diags = only(runSpan(source), "Paragraph has");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("7 sentences");
  });

  it("does not merge two paragraphs split by a blank line", () => {
    const four = Array.from({ length: 4 }, (_, i) => `Line ${i} runs.`).join(" ");
    expect(only(run(`${four}\n\n${four}`), "Paragraph has")).toHaveLength(0);
  });

  it("does merge a hard-wrapped paragraph", () => {
    const source = Array.from({ length: 7 }, (_, i) => `Line ${i} runs.`).join("\n");
    expect(only(run(source), "Paragraph has")).toHaveLength(1);
  });

  it("does not merge separate list items", () => {
    const source = Array.from({ length: 7 }, (_, i) => `- Item ${i} runs.`).join("\n");
    expect(only(run(source), "Paragraph has")).toHaveLength(0);
  });

  it("skips headings", () => {
    const source = Array.from({ length: 7 }, (_, i) => `Line ${i} runs.`).join(" ");
    expect(only(runSpan(source, "heading"), "Paragraph has")).toHaveLength(0);
  });
});

describe("ste — tables", () => {
  const table = [
    "| Check | Meaning |",
    "| ----- | ------- |",
    `| ${words(STE_LIMITS.descriptiveSentenceWords)} | ${words(6)} |`,
  ].join("\n");

  it("does not measure a table row as a sentence", () => {
    expect(only(run(table), "Sentence has")).toHaveLength(0);
  });

  it("does not join separate table rows into one block", () => {
    expect(blocks(table)).toHaveLength(3);
  });

  it("marks a table row with its own kind", () => {
    expect(blocks(table).every((b) => b.kind === "tableRow")).toBe(true);
  });

  it("still reports word choice inside a table cell", () => {
    expect(only(run("| assist | help |"), "not approved")).toHaveLength(1);
  });

  it("does not let a table row absorb the paragraph after it", () => {
    const result = blocks("| a | b |\nPlain prose line.");
    expect(result).toHaveLength(2);
    expect(result[1]!.kind).toBe("paragraph");
  });
});

describe("ste — contractions", () => {
  it("flags a contraction and offers the expansion as a fix", () => {
    const source = "You don't need the flag.";
    const diags = only(runSpan(source), "contraction");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain('"do not"');
    expect(diags[0]!.fix).toEqual({ start: 4, end: 9, text: "do not" });
  });

  it("applies the fix cleanly", () => {
    const source = "You don't need the flag.";
    const fix = only(runSpan(source), "contraction")[0]!.fix!;
    expect(applyFixes(source, [fix])).toBe("You do not need the flag.");
  });

  it("accepts a typographic apostrophe", () => {
    expect(only(runSpan("You don’t need it."), "contraction")).toHaveLength(1);
  });

  it("preserves capitalization in the fix", () => {
    const diags = only(runSpan("Don't stop."), "contraction");
    expect(diags[0]!.fix!.text).toBe("Do not");
  });

  it("does not match a contraction inside a longer word", () => {
    // "he's" must not match inside "she's".
    const diags = only(runSpan("She's ready."), "contraction");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain('"She\'s" is a contraction');
    expect(diags[0]!.message).toContain('"She is"');
  });

  it("ignores a possessive", () => {
    expect(only(runSpan("The server's log file."), "contraction")).toHaveLength(0);
  });
});

describe("ste — -ing forms", () => {
  it("flags the progressive tense", () => {
    const diags = only(runSpan("The server is running."), "progressive tense");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("is running");
  });

  it("allows the simple tense", () => {
    expect(only(runSpan("The server runs."), "progressive tense")).toHaveLength(0);
  });

  it("does not flag an -ing word that is not a verb", () => {
    expect(only(runSpan("The value is string."), "progressive tense")).toHaveLength(0);
  });

  it("flags a participle clause after a comma", () => {
    const diags = only(runSpan("Set the flag, using the config file."), "participle clause");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain('"using"');
  });

  it("flags a participle clause after 'by'", () => {
    expect(only(runSpan("Fix it by setting the flag."), "participle clause")).toHaveLength(1);
  });

  it("points at the verb, not at the comma", () => {
    const source = "Set the flag, using the config file.";
    const diags = only(runSpan(source), "participle clause");
    expect(source.slice(diags[0]!.offset, diags[0]!.offset + diags[0]!.length!)).toBe("using");
  });

  it("does not flag an allowed -ing word after a comma", () => {
    expect(only(runSpan("Set the flag, during the build."), "participle clause")).toHaveLength(0);
  });
});

describe("ste — noun clusters", () => {
  it("allows three nouns in a row", () => {
    expect(only(runSpan("The user account token expires."), "cluster of")).toHaveLength(0);
  });

  it("flags four nouns in a row", () => {
    const diags = only(runSpan("The user account access token expires."), "cluster of");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("4 nouns");
    expect(diags[0]!.message).toContain("user account access token");
  });

  it("lets a preposition break the cluster", () => {
    expect(only(runSpan("The access token for the user account."), "cluster of")).toHaveLength(0);
  });

  it("lets punctuation break the cluster", () => {
    expect(only(runSpan("user, account, access, token"), "cluster of")).toHaveLength(0);
  });

  it("does not count a verb or adverb form as a noun", () => {
    expect(only(runSpan("The user account access failed badly."), "cluster of")).toHaveLength(0);
  });

  it("lets a finite verb end the cluster instead of extending it", () => {
    // "expires" reads as a verb here, so the cluster is 3 nouns, not 4.
    expect(only(runSpan("The user account token expires."), "cluster of")).toHaveLength(0);
  });

  it("requires a determiner or preposition before the cluster", () => {
    // Without an introducer the run has usually crossed a subject-verb-object
    // boundary rather than stacked modifiers, so the check stays quiet.
    expect(only(runSpan("User account access token expires."), "cluster of")).toHaveLength(0);
    expect(only(runSpan("The user account access token expires."), "cluster of")).toHaveLength(1);
  });

  it("accepts a preposition as the introducer", () => {
    expect(only(runSpan("Look in user account access token."), "cluster of")).toHaveLength(1);
  });

  it("does not treat a word across punctuation as the introducer", () => {
    expect(only(runSpan("Stop. User account access token expires."), "cluster of")).toHaveLength(0);
  });

  it("does not open a cluster on a single letter", () => {
    expect(only(runSpan("The n user account access token."), "cluster of")).toHaveLength(0);
  });

  it("ends the cluster on a possessive", () => {
    // Without the possessive break this is "user's account access token key",
    // a run of five introduced by "The".
    expect(
      only(runSpan("The user's account access token key expires."), "cluster of"),
    ).toHaveLength(0);
  });

  it("does not treat cannot as a noun", () => {
    expect(
      only(runSpan("The resource graph cannot express the shape."), "cluster of"),
    ).toHaveLength(0);
  });

  it("reports an offset that points at the cluster", () => {
    const source = "The user account access token expires.";
    const diags = only(runSpan(source), "cluster of");
    expect(source.slice(diags[0]!.offset, diags[0]!.offset + diags[0]!.length!)).toBe(
      "user account access token",
    );
  });
});

describe("ste — verb tense", () => {
  it("flags the present perfect", () => {
    expect(only(runSpan("The job has finished."), "simple tense")).toHaveLength(1);
  });

  it("flags an irregular past participle the -ed/-en test would miss", () => {
    expect(only(runSpan("The team has built the cache."), "simple tense")).toHaveLength(1);
    expect(only(runSpan("The job has begun."), "simple tense")).toHaveLength(0);
  });

  it("reports the future perfect exactly once", () => {
    // "will have finished" is one verb phrase. The perfect-tense pattern already
    // covers it, so a separate "will have" pattern would double-report.
    expect(only(runSpan("The job will have finished."), "simple tense")).toHaveLength(1);
  });

  it("flags shall, ought and would", () => {
    expect(only(runSpan("You shall set it."), "not an approved")).toHaveLength(1);
    expect(only(runSpan("You ought to set it."), "not an approved")).toHaveLength(1);
    expect(only(runSpan("It would fail."), "not an approved")).toHaveLength(1);
  });

  it("allows must", () => {
    expect(only(runSpan("You must set it."), "not an approved")).toHaveLength(0);
  });

  it("allows the simple past", () => {
    expect(only(runSpan("The job finished."), "simple tense")).toHaveLength(0);
  });
});

describe("ste — word choice", () => {
  it("flags a long verb and offers the short one", () => {
    const source = "The flag assists the parser.";
    const diags = only(runSpan(source), "not approved");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain('"helps"');
    expect(applyFixes(source, [diags[0]!.fix!])).toBe("The flag helps the parser.");
  });

  it("flags a wordy phrase", () => {
    const diags = only(runSpan("Run the migration prior to the deploy."), "not approved");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain('"before"');
  });

  it("prefers the longest matching phrase", () => {
    const diags = only(runSpan("Stop it in the event that it fails."), "not approved");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain('"in the event that"');
  });

  it("preserves capitalization", () => {
    const diags = only(runSpan("Assist the parser."), "not approved");
    expect(diags[0]!.fix!.text).toBe("Help");
  });

  it("omits the fix when the match crosses a line break", () => {
    const diags = only(run("Run the migration prior\nto the deploy."), "not approved");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.fix).toBeUndefined();
  });

  it("does not attach a fix to a phrase", () => {
    // A phrase replacement can change the form the next word must take, and can
    // match across a snake_case identifier that extract() blanked to spaces.
    const diags = only(runSpan("Run it for the purpose of testing the parser."), "not approved");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.fix).toBeUndefined();
  });

  it("does not rewrite a snake_case identifier", () => {
    const source = "The use_cache_prior_to_flush hook runs.";
    for (const d of only(run(source), "not approved")) expect(d.fix).toBeUndefined();
  });

  it("omits an entry whose replacement has an irregular past participle", () => {
    // "performed" -> "did" would rewrite "was performed" to "was did".
    expect(STE_WORD_MAP.performed).toBeUndefined();
    expect(STE_WORD_MAP.obtained).toBeUndefined();
    expect(STE_WORD_MAP.demonstrated).toBeUndefined();
  });

  it("keeps every -ed fix grammatical after a form of 'be' or 'have'", () => {
    // An -ed key can be a simple past OR a past participle, and the fix cannot
    // tell them apart. It is only safe when the replacement's past participle
    // equals its simple past: every regular -ed form, plus these irregulars.
    const participleSafe = new Set(["found", "bought", "kept", "paid", "sold", "told"]);
    for (const [word, replacement] of Object.entries(STE_WORD_MAP)) {
      if (word.includes(" ") || !word.endsWith("ed")) continue;
      expect(replacement.endsWith("ed") || participleSafe.has(replacement)).toBe(true);
    }
  });
});

describe("ste — diagnostic shape", () => {
  it("uses the ste rule name and carries help for every diagnostic", () => {
    const diags = runSpan(
      "You don't need it, using the flag prior to the user account access token.",
    );
    expect(diags.length).toBeGreaterThan(3);
    for (const diagnostic of diags) {
      expect(diagnostic.rule).toBe("ste");
      expect(diagnostic.help).toBeTruthy();
      expect(diagnostic.suggestion).toBeTruthy();
      expect(diagnostic.prompt).toBeTruthy();
    }
  });

  it("gives every diagnostic a unique id", () => {
    // A paragraph starts with its first sentence, so the paragraph diagnostic
    // and the sentence-length diagnostic on one block share an offset.
    const long = `The ${words(STE_LIMITS.descriptiveSentenceWords)}.`;
    const source = `${long} ${Array.from({ length: 7 }, (_, i) => `Line ${i} runs.`).join(" ")}`;
    const ids = runSpan(source).map((d) => d.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never reports a length that runs past the end of the source line", () => {
    const source = `- The ${words(9)}\n  ${words(8)}\n  ${words(8)}.`;
    const lines = source.split("\n");
    for (const d of run(source)) {
      const lineText = lines[d.line - 1]!;
      expect(d.column - 1 + (d.length ?? 0)).toBeLessThanOrEqual(lineText.length);
    }
  });

  it("returns diagnostics sorted by offset", () => {
    const diags = runSpan(
      "You don't need it, using the flag prior to the user account access token.",
    );
    const offsets = diags.map((d) => d.offset);
    expect(offsets).toEqual(offsets.toSorted((a, b) => a - b));
  });

  it("returns nothing for compliant prose", () => {
    expect(runSpan("Set the flag. The server starts.")).toEqual([]);
  });

  it("returns nothing for no spans", () => {
    expect(ste([], "test.md", createLineIndex(""))).toEqual([]);
  });
});

describe("ste — config wiring", () => {
  it("is off by default", () => {
    const diags = lintContent("You don't need it.", "test.md");
    expect(messages(diags).filter((m) => m.includes("contraction"))).toHaveLength(0);
  });

  it("runs when turned on", () => {
    const diags = lintContent("You don't need it.", "test.md", {
      config: { rules: { ste: "warn" } },
    });
    expect(diags.some((d) => d.rule === "ste")).toBe(true);
  });

  it("honours the configured severity", () => {
    const diags = lintContent("You don't need it.", "test.md", {
      config: { rules: { ste: "error" } },
    });
    expect(diags.filter((d) => d.rule === "ste").every((d) => d.severity === "error")).toBe(true);
  });

  it("can be suppressed with a disable comment", () => {
    const source = "<!-- prose-disable-next-line ste -->\nYou don't need it.";
    const diags = lintContent(source, "test.md", { config: { rules: { ste: "warn" } } });
    expect(diags.filter((d) => d.rule === "ste")).toHaveLength(0);
  });
});

const blocks = (source: string) => groupBlocks(extract(source), createLineIndex(source));

describe("groupBlocks", () => {
  it("joins wrapped lines into one block", () => {
    const result = blocks("one two\nthree four");
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe("one two three four");
  });

  it("splits on a blank line", () => {
    expect(blocks("one two\n\nthree four")).toHaveLength(2);
  });

  it("keeps a heading in its own block", () => {
    const result = blocks("# Title\nSome body text");
    expect(result).toHaveLength(2);
    expect(result[0]!.kind).toBe("heading");
    expect(result[1]!.kind).toBe("paragraph");
  });

  it("keeps each list item in its own block", () => {
    const result = blocks("- one\n- two\n- three");
    expect(result).toHaveLength(3);
    expect(result.every((b) => b.kind === "listItem")).toBe(true);
  });

  it("absorbs a wrapped list item continuation line", () => {
    const result = blocks("- one two\n  three four\n- five");
    expect(result).toHaveLength(2);
    expect(result[0]!.text).toBe("one two three four");
  });

  it("groups a multi-line blockquote into one block", () => {
    const result = blocks("> one two\n> three four");
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("blockquote");
  });

  it("keeps several spans from the same line in one block", () => {
    // Two spaces split one line into two spans; they must not become two blocks.
    const result = blocks("- one two  three four");
    expect(result).toHaveLength(1);
  });

  it("treats a span with no kind as a paragraph", () => {
    const result = groupBlocks([{ text: "one two", offset: 0 }], createLineIndex("one two"));
    expect(result[0]!.kind).toBe("paragraph");
  });

  it("maps a block index back to the right source offset", () => {
    const source = "Run the migration\nprior to the deploy.";
    const diags = only(ste(extract(source), "test.md", createLineIndex(source)), "not approved");
    expect(source.slice(diags[0]!.offset, diags[0]!.offset + 5)).toBe("prior");
  });
});

describe("substitutions", () => {
  const ctx = new RuleContext("test.md", createLineIndex("x"));

  it("pairs a match with its replacement", () => {
    const result = substitutions(ctx, "please assist me", /\bassist\b/g, { assist: "help" });
    expect(result).toEqual([{ matched: "assist", index: 7, replacement: "help" }]);
  });

  it("drops a match the map has no entry for", () => {
    expect(substitutions(ctx, "please assist me", /\bplease\b/g, { assist: "help" })).toEqual([]);
  });

  it("applies the normalizer before the lookup", () => {
    const result = substitutions(ctx, "don’t", /don['’]t/g, { "don't": "do not" }, (value) =>
      value.replace(/’/g, "'"),
    );
    expect(result[0]!.replacement).toBe("do not");
  });
});

describe("alternation", () => {
  it("puts a longer key before a key it contains", () => {
    // Alternation is leftmost-first, so "in" would otherwise shadow "in the event".
    expect(alternation(["in", "in the event"])).toBe("in the event|in");
  });

  it("matches the longest key when one is a prefix of another", () => {
    const pattern = new RegExp(`\\b(${alternation(["in", "in the event"])})\\b`, "g");
    expect("stop in the event of a failure".match(pattern)).toEqual(["in the event"]);
  });

  it("applies a custom escape", () => {
    expect(alternation(["a.b"], (k) => k.toUpperCase())).toBe("A.B");
  });
});
