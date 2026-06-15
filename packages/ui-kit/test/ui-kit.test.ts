import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { validateTree } from "@keel/ui";
import { renderTree } from "@keel/ui/server";
import type { UiNode } from "@keel/ui";

import {
  Badge,
  Button,
  Card,
  createKit,
  Divider,
  Grid,
  Heading,
  Page,
  Section,
  Stack,
  Text,
  tokens,
} from "../src/index";

/** Render a tree through the engine and return the HTML it produced. */
function html(tree: UiNode): string {
  const { element, errors } = renderTree(createKit(), tree);

  // Every test tree is well-formed: the renderer should report nothing.
  expect(errors).toEqual([]);

  return renderToStaticMarkup(element);
}

describe("createKit", () => {
  it("returns a fresh Registry holding every kit component", () => {
    const registry = createKit();

    const names = registry.all().map((def) => def.name);

    expect(names).toEqual([
      "Page",
      "Section",
      "Stack",
      "Grid",
      "Card",
      "Heading",
      "Text",
      "Button",
      "Badge",
      "Divider",
    ]);
  });

  it("hands out independent registries per call", () => {
    const a = createKit();
    const b = createKit();

    expect(a).not.toBe(b);
    expect(a.all()).toHaveLength(b.all().length);
  });
});

describe("design tokens", () => {
  it("exposes a frozen token object", () => {
    expect(Object.isFrozen(tokens)).toBe(true);
    expect(Object.isFrozen(tokens.color)).toBe(true);
    expect(tokens.color.primary).toBe("#2563eb");
  });
});

describe("layout containers", () => {
  it("renders a Page wrapping its children", () => {
    const markup = html({
      type: "Page",
      children: [{ type: "Section", children: ["hi"] }],
    });

    expect(markup).toContain("<div");
    expect(markup).toContain("<section");
    expect(markup).toContain("hi");
  });

  it("renders a Card surface", () => {
    const markup = html({ type: "Card", children: ["body"] });

    expect(markup).toContain("body");
    expect(markup).toContain(tokens.color.surface);
  });

  it("renders a Grid with the requested column count", () => {
    const markup = html({
      type: "Grid",
      props: { columns: 3 },
      children: ["a", "b", "c"],
    });

    expect(markup).toContain("repeat(3, 1fr)");
  });

  it("falls back to the default column count when columns is absent", () => {
    const markup = html({ type: "Grid", children: ["only"] });

    expect(markup).toContain("repeat(2, 1fr)");
  });

  it("renders a Grid with an attacker-shaped string columns falling back to the default, never interpolating the payload", () => {
    // The prop validator leaves an un-coercible string untouched, so a CSS-
    // bearing value can reach render. It must NOT be interpolated into the
    // grid-template string; the column count collapses to the default.
    const payload = "2, 1fr); background: url(http://evil/x); --x: repeat(99";

    const markup = html({
      type: "Grid",
      props: { columns: payload },
      children: ["a"],
    });

    expect(markup).toContain("repeat(2, 1fr)");
    expect(markup).not.toContain("evil");
    expect(markup).not.toContain("url(");
  });

  it("renders a Grid with a non-finite columns falling back to the default", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const markup = html({ type: "Grid", props: { columns: bad }, children: ["a"] });

      expect(markup).toContain("repeat(2, 1fr)");
      expect(markup).not.toContain("NaN");
      expect(markup).not.toContain("Infinity");
    }
  });

  it("renders a Grid with a valid numeric columns through unchanged", () => {
    const markup = html({ type: "Grid", props: { columns: 5 }, children: ["a"] });

    expect(markup).toContain("repeat(5, 1fr)");
  });
});

describe("Stack direction", () => {
  it("flows vertically by default", () => {
    const markup = html({ type: "Stack", children: ["x"] });

    expect(markup).toContain("flex-direction:column");
  });

  it("flows horizontally when asked", () => {
    const markup = html({
      type: "Stack",
      props: { direction: "horizontal", gap: 4 },
      children: ["x"],
    });

    expect(markup).toContain("flex-direction:row");
    expect(markup).toContain(`gap:${tokens.space[4]}px`);
  });

  it("falls back to zero gap for an out-of-range gap index", () => {
    const markup = html({
      type: "Stack",
      props: { gap: 99 },
      children: ["x"],
    });

    expect(markup).toContain("gap:0px");
  });

  it("falls back to the default gap when gap is an un-coercible string, never interpolating it", () => {
    const markup = html({
      type: "Stack",
      props: { gap: "8px; background: url(http://evil/x)" },
      children: ["x"],
    });

    // Default gap index is 2 → tokens.space[2].
    expect(markup).toContain(`gap:${tokens.space[2]}px`);
    expect(markup).not.toContain("evil");
  });
});

describe("Heading levels", () => {
  for (const level of ["1", "2", "3", "4"] as const) {
    it(`renders an h${level} at level ${level}`, () => {
      const markup = html({
        type: "Heading",
        props: { text: `Title ${level}`, level },
      });

      expect(markup).toContain(`<h${level}`);
      expect(markup).toContain(`Title ${level}`);
      expect(markup).toContain(`font-size:${tokens.font.headingSize[Number(level)]}`);
    });
  }

  it("defaults to level 2 when level is absent", () => {
    const markup = html({ type: "Heading", props: { text: "Default" } });

    expect(markup).toContain("<h2");
  });
});

describe("Text tone", () => {
  it("uses the full-strength color by default", () => {
    const markup = html({ type: "Text", props: { text: "plain" } });

    expect(markup).toContain(`color:${tokens.color.text}`);
  });

  it("uses the muted color when muted", () => {
    const markup = html({
      type: "Text",
      props: { text: "quiet", tone: "muted" },
    });

    expect(markup).toContain(`color:${tokens.color.muted}`);
  });
});

describe("Button variants", () => {
  it("renders a primary button without an href", () => {
    const markup = html({ type: "Button", props: { label: "Go" } });

    expect(markup).toContain("<button");
    expect(markup).toContain("Go");
    expect(markup).toContain(`background:${tokens.color.primary}`);
  });

  it("renders a secondary button", () => {
    const markup = html({
      type: "Button",
      props: { label: "Maybe", variant: "secondary" },
    });

    expect(markup).toContain(`background:${tokens.color.secondary}`);
  });

  it("renders a ghost button", () => {
    const markup = html({
      type: "Button",
      props: { label: "Quiet", variant: "ghost" },
    });

    expect(markup).toContain("background:transparent");
  });

  it("renders an anchor when given an href", () => {
    const markup = html({
      type: "Button",
      props: { label: "Visit", href: "https://keel.dev" },
    });

    expect(markup).toContain("<a");
    expect(markup).toContain('href="https://keel.dev"');
    expect(markup).toContain("Visit");
  });
});

describe("Button href scheme guard (XSS in the AI tree)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows safe schemes and relative URLs as anchors", () => {
    for (const href of [
      "https://keel.dev",
      "http://example.com",
      "mailto:hi@keel.dev",
      "/relative/path",
      "#anchor",
      "?q=1",
      "page.html",
    ]) {
      const markup = html({ type: "Button", props: { label: "Go", href } });
      expect(markup).toContain("<a");
      expect(markup).toContain(`href="${href}"`);
    }
  });

  it("refuses unsafe schemes: renders a plain <button> and reports the refusal", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)", // case-insensitive scheme
      "\tjavascript:alert(1)", // leading control char (browsers strip it)
      "  javascript:alert(1)", // leading whitespace
      "java\tscript:alert(1)", // EMBEDDED tab — browsers strip it mid-URL
      "java\nscript:alert(1)", // EMBEDDED newline
      "java\rscript:alert(1)", // EMBEDDED carriage return
      "/\t/evil.example.com", // embedded-control protocol-relative bypass
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "//evil.example.com", // protocol-relative off-origin
    ]) {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { element, errors } = renderTree(createKit(), {
        type: "Button",
        props: { label: "Go", href },
      });
      const markup = renderToStaticMarkup(element);

      expect(markup).toContain("<button");
      expect(markup).not.toContain("<a");
      expect(markup).not.toContain("href=");
      // Reported through the render-error channel under the stable code.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("UI_KIT_UNSAFE_HREF"));
      // The tree itself still rendered (degraded gracefully, not a crash).
      expect(errors).toEqual([]);

      warn.mockRestore();
    }
  });
});

describe("leaf components", () => {
  it("renders a Badge", () => {
    const markup = html({ type: "Badge", props: { text: "New" } });

    expect(markup).toContain("<span");
    expect(markup).toContain("New");
  });

  it("renders a Divider", () => {
    const markup = html({ type: "Divider" });

    expect(markup).toContain("<hr");
  });
});

describe("ComponentDef children policies", () => {
  it("marks containers as accepting children and leaves as not", () => {
    expect(Page.children).toBe(true);
    expect(Section.children).toBe(true);
    expect(Stack.children).toBe(true);
    expect(Grid.children).toBe(true);
    expect(Card.children).toBe(true);

    expect(Heading.children).toBe(false);
    expect(Text.children).toBe(false);
    expect(Button.children).toBe(false);
    expect(Badge.children).toBe(false);
    expect(Divider.children).toBe(false);
  });
});

describe("validateTree on a representative kit tree", () => {
  it("accepts a well-formed composition", () => {
    const tree: UiNode = {
      type: "Page",
      children: [
        {
          type: "Section",
          children: [
            { type: "Heading", props: { text: "Welcome", level: "1" } },
            {
              type: "Stack",
              props: { direction: "vertical", gap: 3 },
              children: [
                { type: "Text", props: { text: "Body copy", tone: "muted" } },
                {
                  type: "Grid",
                  props: { columns: 2 },
                  children: [
                    { type: "Card", children: [{ type: "Badge", props: { text: "A" } }] },
                    { type: "Card", children: [{ type: "Badge", props: { text: "B" } }] },
                  ],
                },
                { type: "Divider" },
                { type: "Button", props: { label: "Start", href: "/start" } },
              ],
            },
          ],
        },
      ],
    };

    const { valid, errors } = validateTree(createKit(), tree);

    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });
});
