import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { renderTree, validateTree } from "@keel/ui";
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
