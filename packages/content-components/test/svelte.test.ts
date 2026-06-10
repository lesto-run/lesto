import { describe, expect, it } from "vitest";

import { createHtmlContentProps } from "../svelte/HtmlContent";

describe("Svelte createHtmlContentProps", () => {
  it("returns just html when no class name is given", () => {
    expect(createHtmlContentProps("<p>hi</p>")).toEqual({ html: "<p>hi</p>" });
  });

  it("includes the class field when a class name is given", () => {
    expect(createHtmlContentProps("<p>hi</p>", "prose")).toEqual({
      html: "<p>hi</p>",
      class: "prose",
    });
  });

  it("treats an explicit undefined class name the same as omitting it", () => {
    // exactOptionalPropertyTypes: the helper must NOT emit `class: undefined`,
    // it must drop the key entirely so prop spreading stays clean.
    const props = createHtmlContentProps("<p>hi</p>", undefined);

    expect(props).toEqual({ html: "<p>hi</p>" });
    expect("class" in props).toBe(false);
  });

  it("preserves an empty-string class name (a deliberate, distinct value)", () => {
    // An empty string is not undefined, so it must be kept verbatim.
    expect(createHtmlContentProps("<p>hi</p>", "")).toEqual({
      html: "<p>hi</p>",
      class: "",
    });
  });
});
