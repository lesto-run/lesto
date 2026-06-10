import { describe, expect, it } from "vitest";

import {
  analyzeKeywordDensity,
  analyzeSEO,
  generateSEORecommendations,
  getKeywordDensityColor,
  getKeywordDensityRating,
  getSEOScoreColor,
  getSEOScoreLabel,
  lintSEO,
} from "../src/analysis";

import type { SEORecommendation } from "../src/types";

// A fully-optimized post: every metric lands in its ideal band, so this acts as
// our "100/100" anchor that the partial-credit cases below can deviate from.
const TITLE_58 = "Building Durable Background Job Queues in Modern Node Apps"; // 58 chars
const META_155 =
  "Learn how to design durable background job queues in Node.js with retries, backoff, and observability so your workloads survive crashes and deploys safely."; // ~155 chars

const optimalPost = `---
title: "${TITLE_58}"
description: "${META_155}"
og_image: "/images/og.png"
canonical: "https://example.com/post"
---

# Main Heading

## First Section

This is a reasonably long paragraph that exists purely so the word count clears
the three-hundred-word threshold once we repeat it enough times. ${"word ".repeat(320)}

## Second Section

Here is an internal [docs link](/docs/intro) and an external
[reference](https://example.com/ref).

![a descriptive alt](/images/photo.png)
`;

// Find a recommendation by its human-facing message (we still branch on type,
// never on message, in production code — this is test-only introspection).
const byMessage = (recs: SEORecommendation[], message: string): SEORecommendation | undefined =>
  recs.find((r) => r.message === message);

describe("analyzeSEO", () => {
  it("reports near-perfect metrics and a high score for a fully optimized post", () => {
    const m = analyzeSEO(optimalPost);

    expect(m.title.value).toBe(TITLE_58);
    expect(m.title.length).toBe(58);
    expect(m.title.isOptimal).toBe(true);

    expect(m.metaDescription.isOptimal).toBe(true);

    expect(m.headings.h1Count).toBe(1);
    expect(m.headings.h2Count).toBe(2);
    expect(m.headings.hasH1).toBe(true);
    expect(m.headings.structure).toEqual(["H1", "H2", "H2"]);

    expect(m.images.total).toBe(1);
    expect(m.images.withAlt).toBe(1);
    expect(m.images.missingAlt).toBe(0);
    expect(m.images.coverage).toBe(1);

    expect(m.links.internal).toBe(1);
    expect(m.links.external).toBe(1);
    expect(m.links.total).toBe(2);

    expect(m.content.hasEnoughContent).toBe(true);
    expect(m.frontmatter.hasOgImage).toBe(true);
    expect(m.frontmatter.ogImageField).toBe("og_image");
    expect(m.frontmatter.hasCanonicalUrl).toBe(true);
    expect(m.frontmatter.canonicalUrl).toBe("https://example.com/post");

    expect(m.score).toBe(100);
  });

  it("returns an empty profile for empty content with only the baseline credits", () => {
    const m = analyzeSEO("");

    expect(m.title.value).toBe("");
    expect(m.title.length).toBe(0);
    expect(m.title.isOptimal).toBe(false);
    expect(m.metaDescription.value).toBe("");
    expect(m.headings.h1Count).toBe(0);
    expect(m.headings.hasH1).toBe(false);
    expect(m.headings.structure).toEqual([]);
    expect(m.images.total).toBe(0);
    // No images present means full coverage by definition (nothing missing alt).
    expect(m.images.coverage).toBe(1);
    expect(m.links.total).toBe(0);
    expect(m.content.wordCount).toBe(0);
    expect(m.content.hasEnoughContent).toBe(false);
    expect(m.frontmatter.hasOgImage).toBe(false);
    expect(m.frontmatter.hasCanonicalUrl).toBe(false);
    // Title/meta/headings/og/content all score 0; the no-images baseline (5)
    // and the no-links baseline (3) are the only credits that survive.
    expect(m.score).toBe(8);
  });

  it("derives the meta description from excerpt when description is absent", () => {
    const m = analyzeSEO(`---
title: "Hi"
excerpt: "From excerpt field"
---
Body`);
    expect(m.metaDescription.value).toBe("From excerpt field");
  });

  it("derives the meta description from summary when description and excerpt are absent", () => {
    const m = analyzeSEO(`---
summary: "From summary field"
---
Body`);
    expect(m.metaDescription.value).toBe("From summary field");
  });

  it("counts headings across all six levels with the correct structure ordering", () => {
    const m = analyzeSEO(`# A
## B
### C
#### D
##### E
###### F
## G`);
    expect(m.headings.h1Count).toBe(1);
    expect(m.headings.h2Count).toBe(2);
    expect(m.headings.h3Count).toBe(1);
    expect(m.headings.structure).toEqual(["H1", "H2", "H3", "H4", "H5", "H6", "H2"]);
  });

  it("flags images missing alt text and computes fractional coverage", () => {
    const m = analyzeSEO(`![good](/a.png)
![](/b.png)
![ ](/c.png)`);
    // The whitespace-only alt counts as missing (alt.trim() is empty).
    expect(m.images.total).toBe(3);
    expect(m.images.withAlt).toBe(1);
    expect(m.images.missingAlt).toBe(2);
    expect(m.images.coverage).toBeCloseTo(1 / 3, 5);
  });

  it("classifies links as internal vs external by protocol prefix", () => {
    const m = analyzeSEO(`[rel](/local)
[abs](https://x.com)
[insecure](http://y.com)`);
    expect(m.links.internal).toBe(1);
    expect(m.links.external).toBe(2);
    expect(m.links.total).toBe(3);
  });

  it("does not count image syntax as a link", () => {
    const m = analyzeSEO(`![alt](/img.png) and [real link](/page)`);
    expect(m.links.total).toBe(1);
    expect(m.images.total).toBe(1);
  });

  it("ignores malformed frontmatter values that are not quoted strings", () => {
    // Lines without a colon, or with the colon at position 0, are skipped.
    const m = analyzeSEO(`---
: bad
nocolon
title: Plain Title
---
Body`);
    expect(m.title.value).toBe("Plain Title");
  });

  it("strips single quotes from frontmatter values", () => {
    const m = analyzeSEO(`---
title: 'Single Quoted'
---
Body`);
    expect(m.title.value).toBe("Single Quoted");
  });

  it("prefers earlier OG image fields in priority order", () => {
    // ogImage comes before image in the priority list, so it wins.
    const m = analyzeSEO(`---
image: "/late.png"
ogImage: "/early.png"
---
Body`);
    expect(m.frontmatter.ogImageField).toBe("ogImage");
    expect(m.frontmatter.ogImageValue).toBe("/early.png");
  });

  it("treats whitespace-only frontmatter values as absent for OG image", () => {
    const m = analyzeSEO(`---
og_image: "   "
---
Body`);
    expect(m.frontmatter.hasOgImage).toBe(false);
  });

  it("excludes code blocks and inline code from the word count", () => {
    const withCode = analyzeSEO(
      "real words here\n\n```\nignored code block words\n```\n\n`inline ignored`",
    );
    const withoutCode = analyzeSEO("real words here");
    expect(withCode.content.wordCount).toBe(withoutCode.content.wordCount);
  });
});

describe("calculateScore partial-credit bands", () => {
  // Each helper is exercised through analyzeSEO's score; we isolate one metric
  // at a time so the band boundaries are pinned individually.

  it("gives 70% title credit for a non-optimal title of <= 70 chars", () => {
    const shortTitle = analyzeSEO(`---\ntitle: "Short"\n---\n`).score;
    const noTitle = analyzeSEO("").score;
    expect(shortTitle).toBeGreaterThan(noTitle);
  });

  it("gives reduced title credit for an over-70-char title", () => {
    const longTitle = "x".repeat(80);
    const a = analyzeSEO(`---\ntitle: "${longTitle}"\n---\n`);
    expect(a.title.length).toBe(80);
    // title 20 * 0.3 = 6, plus the no-images (5) and no-links (3) baselines = 14.
    expect(a.score).toBe(14);
  });

  it("gives the 70% meta band for a 100-char description", () => {
    const desc = "y".repeat(100);
    const a = analyzeSEO(`---\ndescription: "${desc}"\n---\n`);
    // meta 15 * 0.7 = 10.5, plus baselines 5 + 3 = 18.5 -> rounds to 19.
    expect(a.score).toBe(19);
  });

  it("gives the 30% meta band for an over-200-char description", () => {
    const desc = "y".repeat(220);
    const a = analyzeSEO(`---\ndescription: "${desc}"\n---\n`);
    // meta 15 * 0.3 = 4.5, plus baselines 5 + 3 = 12.5 -> rounds to 13.
    expect(a.metaDescription.length).toBe(220);
    expect(a.score).toBe(13);
  });

  it("gives 50% content credit at exactly 150 words and 20% just below", () => {
    const at150 = analyzeSEO(`${"word ".repeat(150)}`);
    const at149 = analyzeSEO(`${"word ".repeat(149)}`);
    expect(at150.content.wordCount).toBe(150);
    expect(at149.content.wordCount).toBe(149);
    // 150 words -> content 20 * 0.5 = 10; 149 -> 20 * 0.2 = 4.
    expect(at150.score).toBeGreaterThan(at149.score);
  });

  it("gives partial heading credit for a single H1 with no H2s", () => {
    const a = analyzeSEO("# Only an H1");
    // headings: hasH1 10 + singleH1 4 = 14 (no H2 credit). Plus content 4 (a few
    // words -> 0.2 band), no-images 5, and no-links 3 baselines = 26.
    expect(a.headings.h2Count).toBe(0);
    expect(a.score).toBe(26);
  });

  it("withholds the single-H1 bonus when there are multiple H1s", () => {
    const a = analyzeSEO("# One\n# Two");
    expect(a.headings.h1Count).toBe(2);
    // headings: hasH1 10 only (no single-H1 bonus, no H2). Plus content 4,
    // no-images 5, no-links 3 = 22.
    expect(a.score).toBe(22);
  });

  it("gives links the lonely-baseline 30% when there are no links at all", () => {
    const none = analyzeSEO("plain text no links");
    const internalOnly = analyzeSEO("[a](/x)");
    // none: links 10 * 0.3 = 3; internalOnly: 10 * 0.6 = 6.
    expect(internalOnly.score).toBeGreaterThan(none.score);
  });

  it("gives full link credit when both internal and external links exist", () => {
    const both = analyzeSEO("[a](/x) [b](https://y.com)");
    const internalOnly = analyzeSEO("[a](/x)");
    expect(both.score).toBeGreaterThan(internalOnly.score);
  });

  it("gives half content-image credit when there are no images", () => {
    // No images path: contentImages 10 * 0.5 = 5.
    const a = analyzeSEO("no images here");
    const withImage = analyzeSEO("![alt](/x.png)");
    expect(withImage.score).toBeGreaterThan(a.score);
  });
});

describe("generateSEORecommendations", () => {
  it("emits success recommendations across the board for an optimal post", () => {
    const recs = generateSEORecommendations(analyzeSEO(optimalPost));
    expect(byMessage(recs, "Title length is optimal")?.type).toBe("success");
    expect(byMessage(recs, "Meta description length is optimal")?.type).toBe("success");
    expect(byMessage(recs, "H1 heading is properly used")?.type).toBe("success");
    expect(byMessage(recs, "All images have alt text")?.type).toBe("success");
    expect(byMessage(recs, "Content length is good")?.type).toBe("success");
    expect(byMessage(recs, "Open Graph image configured")?.type).toBe("success");
  });

  it("assigns unique sequential ids", () => {
    const recs = generateSEORecommendations(analyzeSEO(optimalPost));
    const ids = recs.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("seo-rec-1");
  });

  it("errors on a missing title and a missing meta description", () => {
    const recs = generateSEORecommendations(analyzeSEO(""));
    expect(byMessage(recs, "Missing title")?.type).toBe("error");
    expect(byMessage(recs, "Missing meta description")?.type).toBe("error");
  });

  it("warns on a too-short title and a too-long title", () => {
    const short = generateSEORecommendations(analyzeSEO(`---\ntitle: "Tiny"\n---\n`));
    expect(byMessage(short, "Title is too short")?.type).toBe("warning");

    const long = generateSEORecommendations(analyzeSEO(`---\ntitle: "${"x".repeat(80)}"\n---\n`));
    expect(byMessage(long, "Title is too long")?.type).toBe("warning");
  });

  it("warns on a too-short and a too-long meta description", () => {
    const short = generateSEORecommendations(analyzeSEO(`---\ndescription: "small"\n---\n`));
    expect(byMessage(short, "Meta description is too short")?.type).toBe("warning");

    const long = generateSEORecommendations(
      analyzeSEO(`---\ndescription: "${"y".repeat(200)}"\n---\n`),
    );
    expect(byMessage(long, "Meta description is too long")?.type).toBe("warning");
  });

  it("warns about a missing H1 and suggests subheadings for long content", () => {
    const recs = generateSEORecommendations(analyzeSEO(`${"word ".repeat(200)}`));
    expect(byMessage(recs, "Missing H1 heading")?.type).toBe("warning");
    expect(byMessage(recs, "Consider adding subheadings")?.type).toBe("info");
  });

  it("warns about multiple H1 headings", () => {
    const recs = generateSEORecommendations(analyzeSEO("# One\n# Two"));
    expect(byMessage(recs, "Multiple H1 headings")?.type).toBe("warning");
  });

  it("warns when images are missing alt text", () => {
    const recs = generateSEORecommendations(analyzeSEO("![](/x.png)"));
    const rec = recs.find((r) => r.message.includes("missing alt text"));
    expect(rec?.type).toBe("warning");
  });

  it("produces no image recommendation when there are no images", () => {
    const recs = generateSEORecommendations(analyzeSEO("# Title\n\ntext"));
    expect(recs.find((r) => r.message.includes("alt text"))).toBeUndefined();
  });

  it("warns when content is too short", () => {
    const recs = generateSEORecommendations(analyzeSEO("just a few words"));
    expect(byMessage(recs, "Content may be too short")?.type).toBe("warning");
  });

  it("suggests internal links for medium content and external links for long content", () => {
    const recs = generateSEORecommendations(analyzeSEO(`# T\n\n${"word ".repeat(400)}`));
    expect(byMessage(recs, "Consider adding internal links")?.type).toBe("info");
    expect(byMessage(recs, "Consider adding external links")?.type).toBe("info");
  });

  it("does not suggest external links until content exceeds 300 words", () => {
    const recs = generateSEORecommendations(analyzeSEO(`# T\n\n${"word ".repeat(200)}`));
    expect(byMessage(recs, "Consider adding external links")).toBeUndefined();
  });

  it("warns about a missing Open Graph image", () => {
    const recs = generateSEORecommendations(analyzeSEO("# Title\n\ntext"));
    expect(byMessage(recs, "Missing Open Graph image")?.type).toBe("warning");
  });
});

describe("lintSEO", () => {
  it("bundles metrics and recommendations from a single pass", () => {
    const result = lintSEO(optimalPost);
    expect(result.metrics.score).toBe(100);
    expect(result.recommendations.length).toBeGreaterThan(0);
    // The recommendations match what generateSEORecommendations would produce.
    expect(result.recommendations).toEqual(generateSEORecommendations(result.metrics));
  });
});

describe("score color and label helpers", () => {
  it("maps score bands to color classes", () => {
    expect(getSEOScoreColor(95)).toBe("text-green-500");
    expect(getSEOScoreColor(80)).toBe("text-green-500");
    expect(getSEOScoreColor(70)).toBe("text-yellow-500");
    expect(getSEOScoreColor(60)).toBe("text-yellow-500");
    expect(getSEOScoreColor(50)).toBe("text-orange-500");
    expect(getSEOScoreColor(40)).toBe("text-orange-500");
    expect(getSEOScoreColor(10)).toBe("text-red-500");
  });

  it("maps score bands to labels", () => {
    expect(getSEOScoreLabel(95)).toBe("Excellent");
    expect(getSEOScoreLabel(60)).toBe("Good");
    expect(getSEOScoreLabel(40)).toBe("Needs Work");
    expect(getSEOScoreLabel(10)).toBe("Poor");
  });
});

describe("analyzeKeywordDensity", () => {
  it("returns an empty result when there are no words", () => {
    const r = analyzeKeywordDensity("", ["react"]);
    expect(r.totalWords).toBe(0);
    expect(r.keywords).toEqual([]);
    expect(r.recommendations).toEqual([]);
  });

  it("counts matches case-insensitively by default", () => {
    const content = "React is great. I love react and REACT.";
    const r = analyzeKeywordDensity(content, ["react"]);
    expect(r.keywords[0]?.count).toBe(3);
  });

  it("respects case-sensitive matching when caseInsensitive is false", () => {
    const content = "React is great. I love react and REACT.";
    const r = analyzeKeywordDensity(content, ["react"], { caseInsensitive: false });
    expect(r.keywords[0]?.count).toBe(1);
  });

  it("warns when a keyword is not found", () => {
    const r = analyzeKeywordDensity("some unrelated text here", ["vue"]);
    expect(r.keywords[0]?.count).toBe(0);
    expect(r.recommendations[0]?.type).toBe("warning");
    expect(r.recommendations[0]?.message).toContain("not found");
  });

  it("reports a success recommendation for a keyword in the optimal density band", () => {
    // ~2% density: 2 occurrences in ~100 words.
    const content = `react ${"word ".repeat(98)} react`;
    const r = analyzeKeywordDensity(content, ["react"]);
    expect(r.keywords[0]?.density).toBeGreaterThanOrEqual(0.5);
    expect(r.keywords[0]?.density).toBeLessThanOrEqual(3);
    expect(r.recommendations[0]?.type).toBe("success");
  });

  it("emits an info recommendation for low density", () => {
    // 1 occurrence in 1000 words = 0.1%.
    const content = `react ${"word ".repeat(999)}`;
    const r = analyzeKeywordDensity(content, ["react"]);
    expect(r.keywords[0]?.density).toBeLessThan(0.5);
    expect(r.recommendations[0]?.type).toBe("info");
    expect(r.recommendations[0]?.message).toContain("Low density");
  });

  it("warns about keyword stuffing for high density", () => {
    // 5 occurrences in ~10 words is well over 3%.
    const content = "react react react react react extra words filler";
    const r = analyzeKeywordDensity(content, ["react"]);
    expect(r.keywords[0]?.density).toBeGreaterThan(3);
    expect(r.recommendations[0]?.type).toBe("warning");
    expect(r.recommendations[0]?.message).toContain("High density");
  });

  it("accounts for multi-word keyword length when computing density", () => {
    const content = `machine learning ${"word ".repeat(98)}`;
    const r = analyzeKeywordDensity(content, ["machine learning"]);
    // One match of a 2-word keyword over 100 words = 2%.
    expect(r.keywords[0]?.count).toBe(1);
    expect(r.keywords[0]?.density).toBeCloseTo(2, 1);
  });

  it("escapes regex-special characters in keywords", () => {
    // The "." must be escaped: an unescaped pattern would also match "nodexjs".
    const content = "I use node.js daily and node.js again, but not nodexjs.";
    const r = analyzeKeywordDensity(content, ["node.js"]);
    expect(r.keywords[0]?.count).toBe(2);
  });

  it("limits the number of location samples via maxLocations", () => {
    const content = "react react react react react";
    const r = analyzeKeywordDensity(content, ["react"], { maxLocations: 2 });
    expect(r.keywords[0]?.locations.length).toBe(2);
  });

  it("adds leading and trailing ellipses only when context is truncated", () => {
    // A match in the middle of a long string truncates on both sides.
    const long = `${"a ".repeat(60)}target ${"b ".repeat(60)}`;
    const r = analyzeKeywordDensity(long, ["target"], { contextLength: 10 });
    const ctx = r.keywords[0]?.locations[0]?.context ?? "";
    expect(ctx.startsWith("...")).toBe(true);
    expect(ctx.endsWith("...")).toBe(true);
  });

  it("omits ellipses when the match sits at both edges of the content", () => {
    const r = analyzeKeywordDensity("target", ["target"], { contextLength: 50 });
    const ctx = r.keywords[0]?.locations[0]?.context ?? "";
    expect(ctx).toBe("target");
  });

  it("records the character position of each match", () => {
    const r = analyzeKeywordDensity("aa target", ["target"]);
    expect(r.keywords[0]?.locations[0]?.position).toBe(3);
  });
});

describe("keyword density rating and color", () => {
  it("rates densities into low / optimal / high bands", () => {
    expect(getKeywordDensityRating(0.4)).toBe("low");
    expect(getKeywordDensityRating(0.5)).toBe("optimal");
    expect(getKeywordDensityRating(2)).toBe("optimal");
    expect(getKeywordDensityRating(3)).toBe("optimal");
    expect(getKeywordDensityRating(3.1)).toBe("high");
  });

  it("maps density ratings to color classes", () => {
    expect(getKeywordDensityColor(2)).toBe("text-green-500");
    expect(getKeywordDensityColor(0.1)).toBe("text-yellow-500");
    expect(getKeywordDensityColor(5)).toBe("text-red-500");
  });
});
