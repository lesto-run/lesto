/**
 * GitHub-style callouts (admonitions) as a rehype plugin.
 *
 * Turns a blockquote whose first line is an alert marker —
 *
 * ```md
 * > [!NOTE]
 * > Useful information the reader should know.
 * ```
 *
 * — into accessible, styled callout markup:
 *
 * ```html
 * <div class="lesto-callout lesto-callout-note" role="note">
 *   <p class="lesto-callout-title"><span class="lesto-callout-icon" aria-hidden="true">ℹ</span>Note</p>
 *   <p>Useful information the reader should know.</p>
 * </div>
 * ```
 *
 * Five types are recognized — `note`, `tip`, `important`, `warning`, `caution`
 * (case-insensitive), matching GitHub. A blockquote that does not open with a
 * recognized `[!TYPE]` marker on its own line is left exactly as it was, so the
 * plugin is safe to run by default: ordinary blockquotes are never touched.
 *
 * It operates on the HTML AST (hast), so it works in both renderer paths — the
 * fast md4w hybrid and the unified pipeline. In the hybrid renderer it runs
 * after sanitization, and its output is fixed markup wrapping already-sanitized
 * children, so it introduces no new sanitization surface.
 */

import { visit, SKIP } from "unist-util-visit";
import type { Root, Element, ElementContent, Properties, Text } from "hast";

export interface CalloutType {
  /** The visible label rendered in the callout title (e.g. "Note"). */
  label: string;
  /** A monochrome glyph shown before the label; CSS colors it per type. */
  glyph: string;
}

/**
 * The recognized callout types and their presentation. Keyed by the lowercase
 * marker name (`note`, `tip`, …). Exported so consumers can read the set or
 * derive their own UI (e.g. a legend) from the same source of truth.
 */
export const CALLOUT_TYPES: Record<string, CalloutType> = {
  note: { label: "Note", glyph: "ℹ" },
  tip: { label: "Tip", glyph: "✦" },
  important: { label: "Important", glyph: "◆" },
  warning: { label: "Warning", glyph: "▲" },
  caution: { label: "Caution", glyph: "⊘" },
};

// The marker must be the only content on the blockquote's first line — a bare
// `[!TYPE]` followed by horizontal whitespace and then a newline or end of text.
// Trailing text on the same line means it is NOT a callout (GitHub's rule), so
// we leave such blockquotes alone.
const MARKER = /^\s*\[!(\w+)\][ \t]*(?:\r?\n|$)/;

function text(value: string): Text {
  return { type: "text", value };
}

function element(tagName: string, properties: Properties, children: ElementContent[]): Element {
  return { type: "element", tagName, properties, children };
}

/** A paragraph carrying only whitespace (or nothing) — left behind once the
 *  marker line is stripped from a single-line `> [!NOTE]`. */
function isBlankParagraph(node: Element): boolean {
  return node.children.every((child) => child.type === "text" && child.value.trim() === "");
}

/**
 * Rehype plugin: render `> [!TYPE]` blockquotes as callouts.
 */
export function rehypeCallouts() {
  return (tree: Root): void => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "blockquote") return undefined;

      const firstParagraph = node.children.find(
        (child): child is Element => child.type === "element" && child.tagName === "p",
      );
      if (!firstParagraph) return undefined;

      const firstChild = firstParagraph.children[0];
      if (!firstChild || firstChild.type !== "text") return undefined;

      const match = MARKER.exec(firstChild.value);
      if (!match) return undefined;

      const type = match[1]!.toLowerCase();
      const meta = CALLOUT_TYPES[type];
      // An unrecognized marker (e.g. `[!FOO]`) is not a callout — leave it be.
      if (!meta) return undefined;

      // Drop the marker line from the first paragraph's leading text.
      firstChild.value = firstChild.value.slice(match[0].length);

      // A bare `> [!NOTE]` leaves an empty paragraph; remove it so the callout
      // has no stray blank line before its body.
      if (isBlankParagraph(firstParagraph)) {
        node.children = node.children.filter((child) => child !== firstParagraph);
      }

      const title = element("p", { className: ["lesto-callout-title"] }, [
        element("span", { className: ["lesto-callout-icon"], ariaHidden: "true" }, [
          text(meta.glyph),
        ]),
        text(meta.label),
      ]);

      // Reshape the blockquote into the callout container in place.
      node.tagName = "div";
      node.properties = { className: ["lesto-callout", `lesto-callout-${type}`], role: "note" };
      node.children = [title, ...node.children];

      // Don't descend into the callout we just built (avoids re-matching a
      // nested blockquote as part of this pass).
      return SKIP;
    });
  };
}
