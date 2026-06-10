import { describe, expect, it } from "vitest";

import { lint, lintA11y, lintStructural } from "../src/index";

const FILE = "doc.md";

// A document that trips at least one rule in every category, so we can prove
// which families of diagnostics each entry point emits or suppresses.
const A11Y_CONTENT = "# One\n\n# Two\n\n![](cat.png)\n\n[click here](https://x.com)";
const STRUCTURAL_CONTENT = "[text]()\n\n## Heading.";

describe("lintA11y", () => {
  it("emits both alt-text and heading diagnostics by default", () => {
    const diags = lintA11y(A11Y_CONTENT, FILE);
    const rules = new Set(diags.map((d) => d.rule));
    expect(rules).toContain("altText");
    expect(rules).toContain("headingHierarchy");
    expect(rules).toContain("linkText");
  });

  it("honors per-checker skip flags", () => {
    const diags = lintA11y(A11Y_CONTENT, FILE, { skipAltText: true, skipLinks: true });
    const rules = new Set(diags.map((d) => d.rule));
    expect(rules.has("altText")).toBe(false);
    expect(rules.has("linkText")).toBe(false);
    // Headings are still checked.
    expect(rules.has("headingHierarchy")).toBe(true);
  });

  it("keeps the heading checker running while any of its rules is enabled", () => {
    // The checker bundles headingHierarchy + headingDuplicate. The per-checker
    // gate is "run if at least one of my rules is on", so muting only the
    // duplicate rule (hierarchy still on) keeps the whole checker active and
    // its diagnostics flow through.
    const content = "# A\n\n# A\n\n## Dup\n\n## Dup";
    const diags = lintA11y(content, FILE, {
      severities: { headingDuplicate: "off" },
    });
    const rules = new Set(diags.map((d) => d.rule));
    expect(rules.has("headingHierarchy")).toBe(true);
  });

  it("skips the heading checker entirely when both heading rules are off", () => {
    const content = "# A\n\n# A";
    const diags = lintA11y(content, FILE, {
      severities: { headingHierarchy: "off", headingDuplicate: "off" },
    });
    expect(diags).toEqual([]);
  });

  it("downgrades an error to a warning via a severity override", () => {
    const diags = lintA11y("![](cat.png)", FILE, { severities: { altText: "warn" } });
    expect(diags[0]).toMatchObject({ rule: "altText", severity: "warning" });
  });

  it("upgrades a warning to an error via a severity override", () => {
    const diags = lintA11y("[click here](https://x.com)", FILE, {
      severities: { linkText: "error" },
    });
    expect(diags[0]).toMatchObject({ rule: "linkText", severity: "error" });
  });

  it("leaves severity untouched when no override is given", () => {
    const diags = lintA11y("![](cat.png)", FILE, { severities: {} });
    expect(diags[0]?.severity).toBe("error");
  });
});

describe("lintStructural", () => {
  it("emits structural diagnostics by default", () => {
    const rules = new Set(lintStructural(STRUCTURAL_CONTENT, FILE).map((d) => d.rule));
    expect(rules).toContain("noEmptyUrl");
    expect(rules).toContain("noHeadingPunctuation");
  });

  it("disables an individual structural rule via severity off", () => {
    const rules = new Set(
      lintStructural(STRUCTURAL_CONTENT, FILE, {
        severities: { noEmptyUrl: "off" },
      }).map((d) => d.rule),
    );
    expect(rules.has("noEmptyUrl")).toBe(false);
    expect(rules.has("noHeadingPunctuation")).toBe(true);
  });

  it("applies a severity override to a structural rule", () => {
    const diags = lintStructural("## Heading.", FILE, {
      severities: { noHeadingPunctuation: "error" },
    });
    expect(diags[0]).toMatchObject({ rule: "noHeadingPunctuation", severity: "error" });
  });
});

describe("lint", () => {
  const COMBINED = `${A11Y_CONTENT}\n\n${STRUCTURAL_CONTENT}`;

  it("runs both a11y and structural families by default", () => {
    const rules = new Set(lint(COMBINED, FILE).map((d) => d.rule));
    expect(rules).toContain("altText"); // a11y
    expect(rules).toContain("noEmptyUrl"); // structural
  });

  it("skips the a11y family when skipA11y is set", () => {
    const rules = new Set(lint(COMBINED, FILE, { skipA11y: true }).map((d) => d.rule));
    expect(rules.has("altText")).toBe(false);
    expect(rules.has("noEmptyUrl")).toBe(true);
  });

  it("skips the structural family when skipStructural is set", () => {
    const rules = new Set(lint(COMBINED, FILE, { skipStructural: true }).map((d) => d.rule));
    expect(rules.has("noEmptyUrl")).toBe(false);
    expect(rules.has("altText")).toBe(true);
  });

  it("returns nothing when both families are skipped", () => {
    expect(lint(COMBINED, FILE, { skipA11y: true, skipStructural: true })).toEqual([]);
  });
});
