/**
 * A ratchet on the published docs' Simplified Technical English debt.
 *
 * The `ste` rule is off by default in `@lesto/content-prose` because ASD-STE100
 * is a house style. The docs site opts in, but 818 findings already exist, so a
 * zero-tolerance gate is not reachable today. This freezes the per-check counts
 * instead: a new contraction or a new noun cluster fails the build, and paying
 * the debt down is a one-line edit to BASELINE.
 *
 * Ratchet DOWN whenever a count drops. Never raise a number to make CI pass —
 * that is the one edit this test exists to prevent.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { lintContent } from "@lesto/content-prose";
import { describe, expect, it } from "vitest";

/** Highest allowed count per check. Lower is always fine; higher fails. */
const BASELINE: Record<string, number> = {
  "sentence-length": 463,
  contraction: 123,
  "word-choice": 86,
  participle: 67,
  "noun-cluster": 37,
  "verb-tense": 31,
  progressive: 9,
  "paragraph-length": 2,
};

const CONTENT_DIR = fileURLToPath(new URL("../content", import.meta.url));

/** Bucket a diagnostic by which STE check raised it. The rule name is just "ste". */
function checkOf(message: string): string {
  if (message.includes("Sentence has")) return "sentence-length";
  if (message.includes("Paragraph has")) return "paragraph-length";
  if (message.includes("is a contraction")) return "contraction";
  if (message.includes("progressive tense")) return "progressive";
  if (message.includes("participle clause")) return "participle";
  if (message.includes("is a cluster of")) return "noun-cluster";
  if (message.includes("is not approved")) return "word-choice";
  return "verb-tense";
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

function countByCheck(): { counts: Record<string, number>; files: number } {
  const files = markdownFiles(CONTENT_DIR);
  const counts: Record<string, number> = {};
  for (const file of files) {
    const diagnostics = lintContent(readFileSync(file, "utf8"), file, {
      config: { rules: { ste: "warn" } },
    });
    for (const diagnostic of diagnostics) {
      if (diagnostic.rule !== "ste") continue;
      const check = checkOf(diagnostic.message);
      counts[check] = (counts[check] ?? 0) + 1;
    }
  }
  return { counts, files: files.length };
}

describe("Simplified Technical English ratchet", () => {
  it("reads every published Markdown doc", () => {
    // Guards the ratchet itself: an empty or shrunken corpus would zero every
    // count and pass, hiding the debt instead of holding it.
    expect(countByCheck().files).toBeGreaterThanOrEqual(40);
  });

  it("does not grow the STE debt in any check", () => {
    const { counts } = countByCheck();
    for (const [check, limit] of Object.entries(BASELINE)) {
      expect({ check, count: counts[check] ?? 0 }).toEqual({
        check,
        count: Math.min(counts[check] ?? 0, limit),
      });
    }
  });

  it("has no check missing from the baseline", () => {
    // A new STE check would otherwise land ungated.
    const { counts } = countByCheck();
    expect(Object.keys(counts).toSorted()).toEqual(Object.keys(BASELINE).toSorted());
  });
});
