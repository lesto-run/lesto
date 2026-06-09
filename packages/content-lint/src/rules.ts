/**
 * Lint Rules
 *
 * Accessibility (a11y) and structural rules for markdown linting.
 */

import type {
  Diagnostic,
  LineIndex,
  A11yRuleName,
  LintRuleName,
  A11yOptions,
  LintOptions,
} from "./types.js";
import { createLineIndex } from "./position.js";
import { LintContext } from "./context.js";

// ============================================================================
// A11y Rules
// ============================================================================

const A11Y_PATTERNS = {
  emptyAltMd: /!\[\s*\]\([^)]+\)/g,
  htmlImg: /<img\s+[^>]*\/?>/gi,
  htmlImgEmptyAlt: /<img\s+[^>]*alt\s*=\s*["']\s*["'][^>]*\/?>/gi,
  heading: /^(#{1,6})\s+(.+?)(?:\s+#+)?$/gm,
  link: /\[([^\]]+)\]\([^)]+\)/g,
  codeBlock: /^```\s*$/gm,
  iframe: /<iframe\s+[^>]*>/gi,
  video: /<video\s+[^>]*>/gi,
} as const;

const VAGUE_LINK_TEXTS = new Set([
  "click here",
  "here",
  "read more",
  "learn more",
  "more",
  "link",
  "this link",
  "this page",
  "this",
]);

/** Check for images without alt text */
export function checkAltText(content: string, file: string, lineIndex: LineIndex): Diagnostic[] {
  const ctx = new LintContext(file, lineIndex);
  return [
    ...[...ctx.scan(content, A11Y_PATTERNS.emptyAltMd)].map(({ offset, length }) =>
      ctx.diag(
        "altText",
        offset,
        length,
        "Image missing alt text",
        "error",
        "Add descriptive alt text that explains the image content. Be specific and concise (1-2 sentences). Avoid starting with 'Image of'."
      )
    ),
    ...[...ctx.scan(content, A11Y_PATTERNS.htmlImg)]
      .filter(({ match }) => !/alt\s*=/i.test(match[0]))
      .map(({ offset, length }) =>
        ctx.diag(
          "altText",
          offset,
          length,
          "HTML image missing alt attribute",
          "error",
          'Add an alt attribute: <img src="..." alt="Description of image" />'
        )
      ),
    ...[...ctx.scan(content, A11Y_PATTERNS.htmlImgEmptyAlt)].map(({ offset, length }) =>
      ctx.diag(
        "altText",
        offset,
        length,
        "HTML image has empty alt text",
        "error",
        "Add descriptive alt text that explains the image content."
      )
    ),
  ];
}

interface ParsedHeading {
  level: number;
  text: string;
  offset: number;
  length: number;
}

const extractHeadings = (content: string): ParsedHeading[] =>
  [...content.matchAll(A11Y_PATTERNS.heading)]
    .filter((m) => m[1] && m[2])
    .map((m) => ({
      level: m[1]!.length,
      text: m[2]!.trim(),
      offset: m.index!,
      length: m[0].length,
    }));

/** Check heading hierarchy */
export function checkHeadings(content: string, file: string, lineIndex: LineIndex): Diagnostic[] {
  const ctx = new LintContext(file, lineIndex);
  const headings = extractHeadings(content);

  const multipleH1s = headings
    .filter((h) => h.level === 1)
    .slice(1)
    .map((h) =>
      ctx.diag(
        "headingHierarchy",
        h.offset,
        h.length,
        "Multiple H1 headings found; each page should have only one H1",
        "error",
        "Use H2 or lower for additional sections. The page title (H1) should be defined in frontmatter or as the first heading."
      )
    );

  const skippedLevels = headings.slice(1).flatMap((curr, i) => {
    const prev = headings[i]!;
    return curr.level > prev.level + 1
      ? [
          ctx.diag(
            "headingHierarchy",
            curr.offset,
            curr.length,
            `Heading level skipped from H${prev.level} to H${curr.level}`,
            "error",
            `Use H${prev.level + 1} instead of H${curr.level}. Headings should follow sequential order without skipping levels.`
          ),
        ]
      : [];
  });

  const duplicates = Object.entries(
    headings.reduce<Record<number, ParsedHeading[]>>(
      (acc, h) => ((acc[h.level] ??= []).push(h), acc),
      {}
    )
  ).flatMap(([level, hs]) => {
    const seen = new Set<string>();
    return hs.flatMap((h) => {
      const key = h.text.toLowerCase();
      if (seen.has(key)) {
        return [
          ctx.diag(
            "headingDuplicate",
            h.offset,
            h.length,
            `Duplicate H${level} heading: "${h.text}"`,
            "warning",
            "Same-level headings should have unique names to help with navigation. Consider making this heading more specific."
          ),
        ];
      }
      seen.add(key);
      return [];
    });
  });

  return [...multipleH1s, ...skippedLevels, ...duplicates];
}

/** Check for vague link text */
export function checkLinks(content: string, file: string, lineIndex: LineIndex): Diagnostic[] {
  const ctx = new LintContext(file, lineIndex);
  return [...ctx.scan(content, A11Y_PATTERNS.link)]
    .filter(({ match }) => VAGUE_LINK_TEXTS.has(match[1]?.trim().toLowerCase() ?? ""))
    .map(({ match, offset, length }) =>
      ctx.diag(
        "linkText",
        offset,
        length,
        `Vague link text: "${match[1]}"`,
        "warning",
        'Link text should describe the destination. Instead of "click here", use descriptive text like "view the documentation" or "read the getting started guide".'
      )
    );
}

/** Check for code blocks without language */
export function checkCodeBlocks(
  content: string,
  file: string,
  lineIndex: LineIndex
): Diagnostic[] {
  const ctx = new LintContext(file, lineIndex);
  return [...ctx.scan(content, A11Y_PATTERNS.codeBlock)]
    .filter(({ offset }) => (content.slice(0, offset).match(/^```/gm) ?? []).length % 2 === 0)
    .map(({ offset, length }) =>
      ctx.diag(
        "codeBlockLanguage",
        offset,
        length,
        "Code block missing language specification",
        "warning",
        "Specify a language for syntax highlighting: ```javascript, ```python, etc. This helps screen readers announce the code context."
      )
    );
}

/** Check for iframes/embeds without title */
export function checkEmbeds(content: string, file: string, lineIndex: LineIndex): Diagnostic[] {
  const ctx = new LintContext(file, lineIndex);
  return [
    ...[...ctx.scan(content, A11Y_PATTERNS.iframe)]
      .filter(({ match }) => !/title\s*=/i.test(match[0]))
      .map(({ offset, length }) =>
        ctx.diag(
          "embedTitle",
          offset,
          length,
          "iframe missing title attribute",
          "error",
          'Add a descriptive title: <iframe src="..." title="Tutorial: Setting up authentication" />'
        )
      ),
    ...[...ctx.scan(content, A11Y_PATTERNS.video)]
      .filter(({ match }) => !/title\s*=/i.test(match[0]))
      .map(({ offset, length }) =>
        ctx.diag(
          "embedTitle",
          offset,
          length,
          "video element missing title attribute",
          "warning",
          "Add a descriptive title to help screen reader users understand the video content."
        )
      ),
  ];
}

// ============================================================================
// Structural Rules
// ============================================================================

const STRUCTURAL_PATTERNS = {
  // Empty URLs: [text]() or ![alt]()
  emptyLink: /\[[^\]]*\]\(\s*\)/g,
  emptyImage: /!\[[^\]]*\]\(\s*\)/g,
  // Bold text that looks like a heading (at start of line, standalone)
  emphasisAsHeading: /^(\*\*[^*\n]+\*\*|\*\*\*[^*\n]+\*\*\*)[\s]*$/gm,
  // Reference definitions: [ref]: url
  refDefinition: /^\[([^\]]+)\]:\s+\S+/gm,
  // Reference usages: [text][ref] or [ref][]
  refUsageFull: /\[([^\]]+)\]\[([^\]]*)\]/g,
  // Shortcut reference: [ref] (not followed by ( or :)
  refUsageShortcut: /\[([^\]]+)\](?!\(|:|\[)/g,
  // Heading with trailing punctuation
  headingWithPunctuation: /^(#{1,6})\s+(.+[.!?:])[\s]*$/gm,
  // Shell code block
  shellCodeBlock: /```(?:sh|bash|shell|zsh|console)?\n([\s\S]*?)```/gm,
} as const;

/** Check for empty URLs in links and images */
export function checkNoEmptyUrl(
  content: string,
  file: string,
  lineIndex: LineIndex
): Diagnostic[] {
  const ctx = new LintContext(file, lineIndex);
  const diagnostics: Diagnostic[] = [];

  for (const { offset, length } of ctx.scan(content, STRUCTURAL_PATTERNS.emptyLink)) {
    diagnostics.push(
      ctx.diag(
        "noEmptyUrl",
        offset,
        length,
        "Link has empty URL",
        "error",
        "Add a valid URL to the link: [text](https://example.com)"
      )
    );
  }

  for (const { offset, length } of ctx.scan(content, STRUCTURAL_PATTERNS.emptyImage)) {
    diagnostics.push(
      ctx.diag(
        "noEmptyUrl",
        offset,
        length,
        "Image has empty URL",
        "error",
        "Add a valid URL to the image: ![alt](image.png)"
      )
    );
  }

  return diagnostics;
}

/** Check for undefined reference links */
export function checkNoUndefinedReferences(
  content: string,
  file: string,
  lineIndex: LineIndex
): Diagnostic[] {
  const ctx = new LintContext(file, lineIndex);

  // Pass 1: Collect all defined references
  const definedRefs = new Set<string>();
  for (const { match } of ctx.scan(content, STRUCTURAL_PATTERNS.refDefinition)) {
    const refName = match[1];
    if (refName !== undefined) {
      definedRefs.add(refName.toLowerCase());
    }
  }

  const diagnostics: Diagnostic[] = [];

  // Pass 2: Check full reference usages [text][ref]
  for (const { match, offset, length } of ctx.scan(content, STRUCTURAL_PATTERNS.refUsageFull)) {
    const refName = (match[2] || match[1] || "").toLowerCase();
    if (!definedRefs.has(refName)) {
      diagnostics.push(
        ctx.diag(
          "noUndefinedReferences",
          offset,
          length,
          `Undefined reference: [${refName}]`,
          "error",
          `Add a reference definition: [${refName}]: https://example.com`
        )
      );
    }
  }

  // Pass 3: Check shortcut references [ref]
  // Checkbox syntax patterns to skip: [x], [X], [ ] (used in task lists)
  const checkboxPatterns = new Set(["x", " ", ""]);
  for (const { match, offset, length } of ctx.scan(content, STRUCTURAL_PATTERNS.refUsageShortcut)) {
    const rawRef = match[1] ?? "";
    const refName = rawRef.toLowerCase();

    // Skip checkbox syntax (task lists): - [x], - [ ], - [X]
    if (checkboxPatterns.has(rawRef) || checkboxPatterns.has(refName)) {
      continue;
    }

    // Skip if it looks like a definition line or is a known definition
    if (!definedRefs.has(refName)) {
      // Check if this is actually a definition (has : after)
      const afterMatch = content.slice(offset + length, offset + length + 2);
      if (afterMatch.startsWith(":")) continue;

      diagnostics.push(
        ctx.diag(
          "noUndefinedReferences",
          offset,
          length,
          `Undefined reference: [${refName}]`,
          "error",
          `Add a reference definition: [${refName}]: https://example.com`
        )
      );
    }
  }

  return diagnostics;
}

/** Check for emphasis used as heading */
export function checkNoEmphasisAsHeading(
  content: string,
  file: string,
  lineIndex: LineIndex
): Diagnostic[] {
  const ctx = new LintContext(file, lineIndex);
  const diagnostics: Diagnostic[] = [];

  for (const { match, offset, length } of ctx.scan(content, STRUCTURAL_PATTERNS.emphasisAsHeading)) {
    const text = match[0].replace(/\*+/g, "").trim();

    // Skip if it's inside a list item (preceded by list marker on same line)
    const lineStart = content.lastIndexOf("\n", offset - 1) + 1;
    const linePrefix = content.slice(lineStart, offset);
    if (/^\s*[-*+]\s+/.test(linePrefix) || /^\s*\d+\.\s+/.test(linePrefix)) {
      continue;
    }

    // Skip short emphasis text (likely labels like **Note:** or **Warning:**)
    if (text.length < 10 || text.endsWith(":")) {
      continue;
    }

    // Check if followed by content (heading-like behavior)
    const afterMatch = content.slice(offset + length);
    const nextNonEmptyLine = afterMatch.split("\n").slice(1).find((line) => line.trim().length > 0);
    // If followed by blank line then content, it's likely being used as a heading
    const isHeadingLike = nextNonEmptyLine && !nextNonEmptyLine.startsWith("#");

    if (!isHeadingLike) {
      continue;
    }

    diagnostics.push(
      ctx.diag(
        "noEmphasisAsHeading",
        offset,
        length,
        "Don't use emphasis (bold) as a heading",
        "warning",
        `Use proper heading syntax: ## ${text}`,
        { start: offset, end: offset + length, text: `## ${text}` }
      )
    );
  }

  return diagnostics;
}

// FAQ-style question word patterns (allow ? for these headings)
const QUESTION_WORDS = /^(what|why|how|when|where|who|which|can|should|is|are|do|does|will|would|have|has)\b/i;

/** Check for headings ending in punctuation */
export function checkNoHeadingPunctuation(
  content: string,
  file: string,
  lineIndex: LineIndex
): Diagnostic[] {
  const ctx = new LintContext(file, lineIndex);
  const diagnostics: Diagnostic[] = [];

  for (const { match, offset, length } of ctx.scan(content, STRUCTURAL_PATTERNS.headingWithPunctuation)) {
    const headingText = match[2] ?? "";
    const lastChar = headingText.slice(-1);

    // Skip if it's a question (ends with ? and starts with question word)
    if (lastChar === "?" && QUESTION_WORDS.test(headingText.trim())) {
      continue;
    }

    diagnostics.push(
      ctx.diag(
        "noHeadingPunctuation",
        offset,
        length,
        `Heading should not end with "${lastChar}"`,
        "warning",
        "Remove trailing punctuation from headings for cleaner formatting.",
        {
          start: offset,
          end: offset + length,
          text: match[0].slice(0, -1).trimEnd(),
        }
      )
    );
  }

  return diagnostics;
}

/** Check for shell commands with $ prefix */
export function checkNoShellDollars(
  content: string,
  file: string,
  lineIndex: LineIndex
): Diagnostic[] {
  const ctx = new LintContext(file, lineIndex);
  const diagnostics: Diagnostic[] = [];

  for (const { match, offset } of ctx.scan(content, STRUCTURAL_PATTERNS.shellCodeBlock)) {
    const blockContent = match[1];
    if (!blockContent) continue;

    const blockStart = offset + match[0].indexOf(blockContent);
    const lines = blockContent.split("\n");
    let lineOffset = blockStart;

    for (const line of lines) {
      const dollarMatch = line.match(/^(\s*)\$\s+/);
      if (dollarMatch) {
        const indent = dollarMatch[1] ?? "";
        const dollarOffset = lineOffset + indent.length;
        const dollarLength = dollarMatch[0].length - indent.length;
        diagnostics.push(
          ctx.diag(
            "noShellDollars",
            dollarOffset,
            dollarLength,
            "Don't include $ prompt in shell commands",
            "warning",
            "Remove the $ prefix so users can copy-paste commands directly.",
            {
              start: dollarOffset,
              end: dollarOffset + dollarLength,
              text: "",
            }
          )
        );
      }
      lineOffset += line.length + 1; // +1 for newline
    }
  }

  return diagnostics;
}

// ============================================================================
// Main Lint Functions
// ============================================================================

// Severity helpers
const isEnabledA11y = (sev: A11yOptions["severities"], rule: A11yRuleName) =>
  sev?.[rule] !== "off";
const isEnabledLint = (sev: LintOptions["severities"], rule: LintRuleName) =>
  sev?.[rule] !== "off";

const applySeverity = (sev: LintOptions["severities"], d: Diagnostic): Diagnostic => {
  const override = sev?.[d.rule as LintRuleName];
  return override && override !== "off"
    ? { ...d, severity: override === "warn" ? "warning" : "error" }
    : d;
};

/** Run all a11y checks on content (backwards compatible) */
export function lintA11y(content: string, file: string, options?: A11yOptions): Diagnostic[] {
  const lineIndex = createLineIndex(content);
  const sev = options?.severities;

  const checks: [boolean, () => Diagnostic[], A11yRuleName[]][] = [
    [
      !options?.skipAltText && isEnabledA11y(sev, "altText"),
      () => checkAltText(content, file, lineIndex),
      ["altText"],
    ],
    [
      !options?.skipHeadings &&
        (isEnabledA11y(sev, "headingHierarchy") || isEnabledA11y(sev, "headingDuplicate")),
      () => checkHeadings(content, file, lineIndex),
      ["headingHierarchy", "headingDuplicate"],
    ],
    [
      !options?.skipLinks && isEnabledA11y(sev, "linkText"),
      () => checkLinks(content, file, lineIndex),
      ["linkText"],
    ],
    [
      !options?.skipCodeBlocks && isEnabledA11y(sev, "codeBlockLanguage"),
      () => checkCodeBlocks(content, file, lineIndex),
      ["codeBlockLanguage"],
    ],
    [
      !options?.skipEmbeds && isEnabledA11y(sev, "embedTitle"),
      () => checkEmbeds(content, file, lineIndex),
      ["embedTitle"],
    ],
  ];

  return checks
    .filter(([enabled]) => enabled)
    .flatMap(([, check, rules]) => check().filter((_d) => rules.some((r) => isEnabledA11y(sev, r))))
    .map((d) => applySeverity(sev as LintOptions["severities"], d));
}

/** Run all structural checks on content */
export function lintStructural(content: string, file: string, options?: LintOptions): Diagnostic[] {
  const lineIndex = createLineIndex(content);
  const sev = options?.severities;

  const checks: [boolean, () => Diagnostic[]][] = [
    [isEnabledLint(sev, "noEmptyUrl"), () => checkNoEmptyUrl(content, file, lineIndex)],
    [isEnabledLint(sev, "noUndefinedReferences"), () => checkNoUndefinedReferences(content, file, lineIndex)],
    [isEnabledLint(sev, "noEmphasisAsHeading"), () => checkNoEmphasisAsHeading(content, file, lineIndex)],
    [isEnabledLint(sev, "noHeadingPunctuation"), () => checkNoHeadingPunctuation(content, file, lineIndex)],
    [isEnabledLint(sev, "noShellDollars"), () => checkNoShellDollars(content, file, lineIndex)],
  ];

  return checks
    .filter(([enabled]) => enabled)
    .flatMap(([, check]) => check())
    .map((d) => applySeverity(sev, d));
}

/** Run all lint checks (a11y + structural) */
export function lint(content: string, file: string, options?: LintOptions): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  if (!options?.skipA11y) {
    diagnostics.push(...lintA11y(content, file, options as A11yOptions));
  }

  if (!options?.skipStructural) {
    diagnostics.push(...lintStructural(content, file, options));
  }

  return diagnostics;
}
